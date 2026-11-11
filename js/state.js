/**
 * RackStudio - State Management
 */

import { DEFAULT_INITIAL_STATE, DEFAULT_DEVICE_TEMPLATES } from './default-data.js';

const STORAGE_KEY = 'rack_studio_data_v2';

class StateStore {
  constructor() {
    this.listeners = new Set();
    this.state = this.loadState();
    this.cableDraft = null;
    this.selectedEntity = null;

    // Централизованная синхронизация с сервером
    this.apiBase = '/rackstudio-api';
    this.isServerAvailable = false;
    this.syncStatus = 'local';
    this.syncMessage = 'Локальный режим';
    this.lastServerModified = 0;
    this.saveDebounceTimer = null;
    this.pollTimer = null;
    this.isApplyingRemote = false;

    this.initServerSync();
  }

  loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && Array.isArray(parsed.racks)) {
          const defaultRackId = parsed.activeRackId || parsed.racks[0]?.id;
          (parsed.groups || []).forEach(g => {
            if (!g.rackId) g.rackId = defaultRackId;
          });
          return parsed;
        }
      }

      // If user had custom templates in previous version, preserve them:
      const oldRaw = localStorage.getItem('rack_studio_data_v1');
      if (oldRaw) {
        try {
          const oldParsed = JSON.parse(oldRaw);
          const customTemplates = (oldParsed.templates || []).filter(
            t => !DEFAULT_DEVICE_TEMPLATES.some(dt => dt.id === t.id)
          );
          const newState = JSON.parse(JSON.stringify(DEFAULT_INITIAL_STATE));
          if (customTemplates.length > 0) {
            newState.templates.push(...customTemplates);
          }
          return newState;
        } catch (err) {
          console.warn('Failed to migrate templates from v1', err);
        }
      }
    } catch (e) {
      console.warn('Failed to load state from localStorage, using defaults', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_INITIAL_STATE));
  }

  saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('Failed to save state to localStorage', e);
    }

    if (this.isApplyingRemote) return;

    // Отправляем изменения на сервер с дебаунсом (400мс)
    if (this.isServerAvailable) {
      this.setSyncStatus('saving', 'Сохранение...');
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = setTimeout(() => {
        this.pushStateToServer();
      }, 400);
    }
  }

  // --- Методы работы с сервером ---

  initServerSync() {
    // 1. Первая попытка загрузки актуального состояния с сервера
    this.fetchServerState().then(connected => {
      if (connected) {
        this.startPolling();
      }
    });

    // 2. Дополнительная проверка при возвращении пользователя на вкладку
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isServerAvailable) {
        this.checkRemoteUpdates();
      }
    });
  }

  async fetchServerState() {
    try {
      const resp = await fetch(`${this.apiBase}/state`, { cache: 'no-store' });
      if (resp.status === 204) {
        // На сервере ещё нет сохранённого проекта — отправляем локальный
        this.isServerAvailable = true;
        this.setSyncStatus('saving', 'Инициализация сервера...');
        await this.pushStateToServer();
        return true;
      }
      if (resp.ok) {
        const remoteState = await resp.json();
        if (remoteState && Array.isArray(remoteState.racks)) {
          this.isApplyingRemote = true;
          this.state = remoteState;
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
          } catch (e) {}
          this.isApplyingRemote = false;
          this.isServerAvailable = true;
          this.lastServerModified = Date.now();
          this.setSyncStatus('synced', 'Синхронизировано');
          this.notifyOnly('remote_state_updated', this.state);
          return true;
        }
      } else {
        this.isServerAvailable = false;
        this.setSyncStatus('local', 'Локальный режим');
        return false;
      }
    } catch (e) {
      // Сервер недоступен (например, автономный запуск без BrigApp)
      this.isServerAvailable = false;
      this.setSyncStatus('local', 'Локальный режим');
      return false;
    }
    return false;
  }

  async pushStateToServer() {
    try {
      const resp = await fetch(`${this.apiBase}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.state)
      });
      if (resp.ok) {
        const meta = await resp.json().catch(() => ({}));
        this.lastServerModified = meta.lastModified || Date.now();
        this.isServerAvailable = true;
        this.setSyncStatus('synced', 'Синхронизировано');
      } else {
        console.warn('Сервер вернул ошибку сохранения:', resp.status);
        this.setSyncStatus('error', 'Ошибка сохранения');
      }
    } catch (err) {
      console.warn('Сетевая ошибка при отправке на сервер:', err);
      this.setSyncStatus('error', 'Ошибка сети');
    }
  }

  async checkRemoteUpdates() {
    if (!this.isServerAvailable || this.cableDraft || this.isApplyingRemote) return;
    try {
      const resp = await fetch(`${this.apiBase}/state/version`, { cache: 'no-store' });
      if (resp.ok) {
        const meta = await resp.json();
        if (meta.lastModified && meta.lastModified > this.lastServerModified) {
          console.log('[RackStudio] Обнаружено новое состояние на сервере, загрузка...');
          await this.fetchServerState();
        }
      }
    } catch (e) {
      // Игнорируем фоновые ошибки сети
    }
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.checkRemoteUpdates();
    }, 6000);
  }

  setSyncStatus(status, message) {
    this.syncStatus = status;
    this.syncMessage = message;
    this.notifyOnly('sync_status_changed', { status, message });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, payload) {
    this.saveState();
    this.notifyOnly(event, payload);
  }

  notifyOnly(event, payload) {
    this.listeners.forEach(fn => {
      try {
        fn(event, payload, this.state);
      } catch (err) {
        console.error('Error in state listener:', err);
      }
    });
  }

  // --- Getters ---

  getActiveRack() {
    const rack = this.state.racks.find(r => r.id === this.state.activeRackId);
    return rack || this.state.racks[0] || null;
  }

  getRacks() {
    return this.state.racks;
  }

  getTemplates() {
    return this.state.templates;
  }

  getTemplate(id) {
    return this.state.templates.find(t => t.id === id) || null;
  }

  getGroups(rackId = null) {
    const targetRackId = rackId || this.state.activeRackId;
    return (this.state.groups || []).filter(g => g.rackId === targetRackId || (!g.rackId && targetRackId === this.state.racks[0]?.id));
  }

  getAllGroups() {
    return this.state.groups || [];
  }

  getGroup(id) {
    return this.state.groups.find(g => g.id === id) || null;
  }

  getActiveGroupFilter() {
    return this.state.activeGroupFilter;
  }

  getCablesForActiveRack() {
    const activeRack = this.getActiveRack();
    if (!activeRack) return [];
    const deviceIds = new Set(activeRack.installedDevices.map(d => d.id));
    return this.state.cables.filter(c => deviceIds.has(c.from.deviceId) && deviceIds.has(c.to.deviceId));
  }

  getAllCables() {
    return this.state.cables;
  }

  getCableByPort(deviceId, portId) {
    return this.state.cables.find(c => 
      (c.from.deviceId === deviceId && c.from.portId === portId) ||
      (c.to.deviceId === deviceId && c.to.portId === portId)
    );
  }

  // --- Mutators ---

  setActiveRack(rackId) {
    if (this.state.activeRackId === rackId) return;
    this.state.activeRackId = rackId;
    this.state.activeGroupFilter = 'ALL';
    this.clearSelection();
    this.notify('rack_changed', { rackId });
  }

  addRack(name = 'Новая стойка', uHeight = 24, model = null) {
    const newId = `rack-${Date.now()}`;
    const newRack = {
      id: newId,
      name,
      uHeight,
      model: model || `19" ${uHeight}U Enclosure`,
      installedDevices: []
    };
    this.state.racks.push(newRack);
    this.state.activeRackId = newId;
    this.state.activeGroupFilter = 'ALL';
    this.notify('rack_added', { rack: newRack });
    return newRack;
  }

  updateRack(rackId, updates) {
    const rack = this.state.racks.find(r => r.id === rackId);
    if (!rack) return;
    Object.assign(rack, updates);
    this.notify('rack_updated', { rack });
  }

  deleteRack(rackId) {
    if (this.state.racks.length <= 1) {
      alert('Нельзя удалить единственную стойку');
      return;
    }
    const rack = this.state.racks.find(r => r.id === rackId);
    if (rack) {
      const devIds = new Set(rack.installedDevices.map(d => d.id));
      this.state.cables = this.state.cables.filter(c => !devIds.has(c.from.deviceId) && !devIds.has(c.to.deviceId));
    }
    // Clean up groups belonging to this rack
    this.state.groups = (this.state.groups || []).filter(g => g.rackId !== rackId);
    this.state.racks = this.state.racks.filter(r => r.id !== rackId);
    if (this.state.activeRackId === rackId) {
      this.state.activeRackId = this.state.racks[0].id;
      this.state.activeGroupFilter = 'ALL';
    }
    this.notify('rack_deleted', { rackId });
  }

  // Devices
  installDevice(templateId, targetU, customName = null) {
    const rack = this.getActiveRack();
    if (!rack) return null;
    const template = this.getTemplate(templateId);
    if (!template) return null;

    const uHeight = template.uHeight || 1;
    for (let u = targetU; u < targetU + uHeight; u++) {
      if (u > rack.uHeight) {
        alert(`Устройство ${uHeight}U выходит за пределы стойки (${rack.uHeight}U)`);
        return null;
      }
      const occupied = rack.installedDevices.find(d => {
        const dTemplate = this.getTemplate(d.templateId);
        const dHeight = dTemplate?.uHeight || 1;
        return u >= d.uPosition && u < d.uPosition + dHeight;
      });
      if (occupied) {
        alert(`Юнит U${u} уже занят устройством "${occupied.customName}"`);
        return null;
      }
    }

    const deviceId = `dev-${Date.now()}`;
    const newDevice = {
      id: deviceId,
      templateId,
      customName: customName || template.name,
      uPosition: targetU,
      ipAddress: '',
      notes: '',
      cliConfig: template.category === 'switch' ? `! Switch Configuration for ${customName || template.name}\nhostname ${customName || 'Switch'}\n` : ''
    };

    rack.installedDevices.push(newDevice);
    this.notify('device_installed', { device: newDevice, rackId: rack.id });
    return newDevice;
  }

  moveDevice(deviceId, newU) {
    const rack = this.getActiveRack();
    if (!rack) return false;
    const dev = rack.installedDevices.find(d => d.id === deviceId);
    if (!dev) return false;
    const template = this.getTemplate(dev.templateId);
    const uHeight = template?.uHeight || 1;

    for (let u = newU; u < newU + uHeight; u++) {
      if (u > rack.uHeight || u < 1) return false;
      const collision = rack.installedDevices.find(d => {
        if (d.id === deviceId) return false;
        const dTemplate = this.getTemplate(d.templateId);
        const dHeight = dTemplate?.uHeight || 1;
        return u >= d.uPosition && u < d.uPosition + dHeight;
      });
      if (collision) return false;
    }

    dev.uPosition = newU;
    this.notify('device_moved', { deviceId, newU });
    return true;
  }

  removeDevice(deviceId) {
    const rack = this.getActiveRack();
    if (!rack) return;
    rack.installedDevices = rack.installedDevices.filter(d => d.id !== deviceId);
    this.state.cables = this.state.cables.filter(c => c.from.deviceId !== deviceId && c.to.deviceId !== deviceId);
    if (this.selectedEntity?.id === deviceId) {
      this.clearSelection();
    }
    this.notify('device_removed', { deviceId });
  }

  updateDevice(deviceId, updates) {
    const rack = this.getActiveRack();
    if (!rack) return;
    const dev = rack.installedDevices.find(d => d.id === deviceId);
    if (!dev) return;
    Object.assign(dev, updates);
    this.notify('device_updated', { device: dev });
  }

  // Cables
  addCable(cableData) {
    const existingFrom = this.getCableByPort(cableData.from.deviceId, cableData.from.portId);
    if (existingFrom) {
      this.removeCable(existingFrom.id);
    }
    const existingTo = this.getCableByPort(cableData.to.deviceId, cableData.to.portId);
    if (existingTo) {
      this.removeCable(existingTo.id);
    }

    const groupId = cableData.groupId || (this.state.activeGroupFilter !== 'ALL' ? this.state.activeGroupFilter : '');
    const group = groupId ? this.getGroup(groupId) : null;
    const defaultColor = group?.color || '#3b82f6';

    const newCable = {
      id: `c-${Date.now()}`,
      groupId,
      from: cableData.from,
      to: cableData.to,
      color: cableData.color || defaultColor,
      type: cableData.type || 'Cat6 UTP',
      lengthM: cableData.lengthM || 0.5,
      label: cableData.label || ''
    };

    this.state.cables.push(newCable);
    this.notify('cable_added', { cable: newCable });
    return newCable;
  }

  removeCable(cableId) {
    this.state.cables = this.state.cables.filter(c => c.id !== cableId);
    if (this.selectedEntity?.id === cableId) {
      this.clearSelection();
    }
    this.notify('cable_removed', { cableId });
  }

  updateCable(cableId, updates) {
    const cable = this.state.cables.find(c => c.id === cableId);
    if (!cable) return;
    Object.assign(cable, updates);
    this.notify('cable_updated', { cable });
  }

  // Workplace Groups
  addGroup(name, color = '#00d2ff', vlan = 10, description = '', rackId = null) {
    const targetRackId = rackId || this.state.activeRackId;
    const newGroup = {
      id: `grp-${Date.now()}`,
      rackId: targetRackId,
      name,
      color,
      vlan,
      description
    };
    if (!this.state.groups) this.state.groups = [];
    this.state.groups.push(newGroup);
    this.notify('group_added', { group: newGroup });
    return newGroup;
  }

  updateGroup(groupId, updates) {
    const grp = this.state.groups.find(g => g.id === groupId);
    if (!grp) return;
    Object.assign(grp, updates);
    if (updates.color) {
      this.state.cables.forEach(c => {
        if (c.groupId === groupId) c.color = updates.color;
      });
    }
    this.notify('group_updated', { group: grp });
  }

  deleteGroup(groupId) {
    this.state.groups = this.state.groups.filter(g => g.id !== groupId);
    this.state.cables.forEach(c => {
      if (c.groupId === groupId) c.groupId = '';
    });
    if (this.state.activeGroupFilter === groupId) {
      this.state.activeGroupFilter = 'ALL';
    }
    this.notify('group_deleted', { groupId });
  }

  setActiveGroupFilter(filterId) {
    this.state.activeGroupFilter = filterId;
    this.notify('group_filter_changed', { filterId });
  }

  setDimInactiveCables(val) {
    this.state.dimInactiveCables = !!val;
    this.notify('filter_settings_changed', { dimInactiveCables: this.state.dimInactiveCables });
  }

  getCableRoutingMode() {
    return this.state.cableRoutingMode || 'channels';
  }

  setCableRoutingMode(mode) {
    this.state.cableRoutingMode = mode === 'arcs' ? 'arcs' : 'channels';
    this.notify('filter_settings_changed', { cableRoutingMode: this.state.cableRoutingMode });
  }

  // Templates (Custom Device Builder)
  addTemplate(tplData) {
    const newTemplate = {
      ...tplData,
      id: tplData.id || `tpl-${Date.now()}`
    };
    this.state.templates.push(newTemplate);
    this.notify('template_added', { template: newTemplate });
    return newTemplate;
  }

  updateTemplate(tplId, updates) {
    const tpl = this.state.templates.find(t => t.id === tplId);
    if (!tpl) return;
    Object.assign(tpl, updates);
    this.notify('template_updated', { template: tpl });
  }

  deleteTemplate(tplId) {
    this.state.templates = this.state.templates.filter(t => t.id !== tplId);
    this.notify('template_deleted', { templateId: tplId });
  }

  // Selection & UI helpers
  setSelection(entity) {
    this.selectedEntity = entity;
    this.notify('selection_changed', { entity });
  }

  clearSelection() {
    this.selectedEntity = null;
    this.notify('selection_changed', { entity: null });
  }

  startCableDraft(deviceId, portId, clientX, clientY) {
    this.cableDraft = { deviceId, portId, clientX, clientY };
    this.notify('cable_draft_started', this.cableDraft);
  }

  updateCableDraft(clientX, clientY) {
    if (!this.cableDraft) return;
    this.cableDraft.clientX = clientX;
    this.cableDraft.clientY = clientY;
    this.notify('cable_draft_moved', this.cableDraft);
  }

  finishCableDraft(targetDeviceId, targetPortId) {
    if (!this.cableDraft) return null;
    if (this.cableDraft.deviceId === targetDeviceId && this.cableDraft.portId === targetPortId) {
      this.cancelCableDraft();
      return null;
    }
    const created = this.addCable({
      from: { deviceId: this.cableDraft.deviceId, portId: this.cableDraft.portId },
      to: { deviceId: targetDeviceId, portId: targetPortId }
    });
    this.cableDraft = null;
    this.notify('cable_draft_finished', { cable: created });
    return created;
  }

  cancelCableDraft() {
    this.cableDraft = null;
    this.notify('cable_draft_cancelled', null);
  }

  // Export / Import / Reset
  exportToJson() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.state, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute('href', dataStr);
    dlAnchorElem.setAttribute('download', `rack_studio_backup_${new Date().toISOString().slice(0, 10)}.json`);
    dlAnchorElem.click();
  }

  importFromJson(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed || !Array.isArray(parsed.racks)) {
        throw new Error('Некорректный формат файла проекта');
      }
      this.state = parsed;
      this.saveState();
      this.clearSelection();
      this.notify('state_imported', this.state);
      return true;
    } catch (e) {
      alert('Ошибка при импорте JSON: ' + e.message);
      return false;
    }
  }

  resetToDefault() {
    if (confirm('Сбросить весь проект к демонстрационным начальным данным? Все несохраненные изменения будут перезаписаны.')) {
      this.state = JSON.parse(JSON.stringify(DEFAULT_INITIAL_STATE));
      this.saveState();
      this.clearSelection();
      this.notify('state_reset', this.state);
    }
  }
}

export const store = new StateStore();
