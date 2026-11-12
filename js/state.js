/**
 * RackStudio - State Management
 */

import { DEFAULT_INITIAL_STATE, DEFAULT_DEVICE_TEMPLATES } from './default-data.js';
import {
  findDeviceLocation,
  isInterRackCableInState,
  calculateCableLengthEstimate,
  INTER_RACK_DEFAULT_LENGTH_M
} from './cable-length.js';

const STORAGE_KEY = 'rack_studio_data_v2';
const LEGACY_DEFAULT_TEMPLATE_IDS = [
  'tpl-switch-24p',
  'tpl-patch-24p',
  'tpl-server-2u',
  'tpl-gateway-1u',
  'tpl-pdu-1u'
];

class StateStore {
  constructor() {
    this.listeners = new Set();
    this._idSeq = 0;
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

  ensureBuiltinTemplates(targetState) {
    if (!targetState || !Array.isArray(targetState.racks)) return targetState;
    if (!Array.isArray(targetState.templates)) {
      targetState.templates = [];
    }
    if (!targetState.topologyPositions || typeof targetState.topologyPositions !== 'object' || Array.isArray(targetState.topologyPositions)) {
      targetState.topologyPositions = {};
    }

    if (!Array.isArray(targetState.knownDefaultTemplateIds)) {
      targetState.knownDefaultTemplateIds = Array.from(
        new Set([
          ...LEGACY_DEFAULT_TEMPLATE_IDS,
          ...targetState.templates.map(t => t.id)
        ])
      );
    }

    const existingIds = new Set(targetState.templates.map(t => t.id));
    const knownIds = new Set(targetState.knownDefaultTemplateIds);

    DEFAULT_DEVICE_TEMPLATES.forEach(dt => {
      if (!existingIds.has(dt.id) && !knownIds.has(dt.id)) {
        targetState.templates.push(JSON.parse(JSON.stringify(dt)));
      } else if (dt.id === 'tpl-eltex-mes2324p') {
        const existingTpl = targetState.templates.find(t => t.id === dt.id);
        const p1 = existingTpl?.ports?.find(p => p.id === 'p-1');
        const xg1 = existingTpl?.ports?.find(p => p.id === 'xg-1');
        if (p1?.x === 36.72 && p1?.y === 43.55 && xg1?.x === 81.94 && xg1?.y === 77.42) {
          existingTpl.ports = JSON.parse(JSON.stringify(dt.ports));
        }
      }
      if (!knownIds.has(dt.id)) {
        targetState.knownDefaultTemplateIds.push(dt.id);
        knownIds.add(dt.id);
      }
    });

    return targetState;
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
          return this.ensureBuiltinTemplates(parsed);
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
          return this.ensureBuiltinTemplates(newState);
        } catch (err) {
          console.warn('Failed to migrate templates from v1', err);
        }
      }
    } catch (e) {
      console.warn('Failed to load state from localStorage, using defaults', e);
    }
    return this.ensureBuiltinTemplates(JSON.parse(JSON.stringify(DEFAULT_INITIAL_STATE)));
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
          this.state = this.ensureBuiltinTemplates(remoteState);
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
    return this.state.cables.filter(c => deviceIds.has(c.from.deviceId) || deviceIds.has(c.to.deviceId));
  }

  findDeviceLocation(deviceId) {
    return findDeviceLocation(this.state, deviceId);
  }

  isInterRackCable(cable) {
    return isInterRackCableInState(this.state, cable);
  }

  getCableLengthEstimate(cable) {
    return calculateCableLengthEstimate(this.state, cable, this.getCableRoutingMode());
  }

  getGroupsForCable(cable) {
    const fromRack = this.findDeviceLocation(cable?.from?.deviceId)?.rack;
    const toRack = this.findDeviceLocation(cable?.to?.deviceId)?.rack;
    const activeRack = this.getActiveRack();
    const rackIds = [];
    if (activeRack?.id) rackIds.push(activeRack.id);
    if (fromRack?.id && !rackIds.includes(fromRack.id)) rackIds.push(fromRack.id);
    if (toRack?.id && !rackIds.includes(toRack.id)) rackIds.push(toRack.id);

    const seen = new Set();
    const result = [];
    rackIds.forEach(rid => {
      const rackObj = this.state.racks.find(r => r.id === rid);
      this.getGroups(rid).forEach(g => {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          result.push({
            ...g,
            rackName: rackObj?.name || ''
          });
        }
      });
    });
    return result;
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
    // Keep active cableDraft when switching racks so inter-rack patching works seamlessly
    this.selectedEntity = null;
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
      this.pruneTopologyPositions(devIds, rackId);
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
  findDeviceSlotConflict(rack, targetU, uHeight = 1, excludeDeviceId = null) {
    if (!rack) return { outOfBounds: true, conflictDevice: null };
    for (let u = targetU; u < targetU + uHeight; u++) {
      if (u < 1 || u > rack.uHeight) {
        return { outOfBounds: true, conflictDevice: null };
      }
      const collision = rack.installedDevices.find(d => {
        if (excludeDeviceId && d.id === excludeDeviceId) return false;
        const dTemplate = this.getTemplate(d.templateId);
        const dHeight = dTemplate?.uHeight || 1;
        return u >= d.uPosition && u < d.uPosition + dHeight;
      });
      if (collision) {
        return { outOfBounds: false, conflictDevice: collision, conflictU: u };
      }
    }
    return null;
  }

  canMoveDevice(deviceId, newU) {
    const rack = this.getActiveRack();
    if (!rack) return false;
    const dev = rack.installedDevices.find(d => d.id === deviceId);
    if (!dev) return false;
    const uHeight = this.getTemplate(dev.templateId)?.uHeight || 1;
    return !this.findDeviceSlotConflict(rack, newU, uHeight, deviceId);
  }

  installDevice(templateId, targetU, customName = null) {
    const rack = this.getActiveRack();
    if (!rack) return null;
    const template = this.getTemplate(templateId);
    if (!template) return null;

    const uHeight = template.uHeight || 1;
    const conflict = this.findDeviceSlotConflict(rack, targetU, uHeight);
    if (conflict) {
      if (conflict.outOfBounds) {
        alert(`Устройство ${uHeight}U выходит за пределы стойки (${rack.uHeight}U)`);
      } else {
        alert(`Юнит U${conflict.conflictU} уже занят устройством "${conflict.conflictDevice.customName}"`);
      }
      return null;
    }

    const deviceId = `dev-${Date.now()}-${++this._idSeq}`;
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
    const loc = this.findDeviceLocation(deviceId);
    const rack = loc?.rack || this.getActiveRack();
    const dev = loc?.device || rack?.installedDevices.find(d => d.id === deviceId);
    if (!rack || !dev) return false;
    const template = loc?.template || this.getTemplate(dev.templateId);
    const uHeight = template?.uHeight || 1;

    if (this.findDeviceSlotConflict(rack, newU, uHeight, deviceId)) {
      return false;
    }

    dev.uPosition = newU;
    this.recalculateAutoCableLengthsForDevice(deviceId);
    this.notify('device_moved', { deviceId, newU });
    return true;
  }

  findNearestFreeSlot(deviceId, direction) {
    if (!direction) return null;
    const loc = this.findDeviceLocation(deviceId);
    if (!loc) return null;
    const { rack, device, template } = loc;
    const uHeight = template?.uHeight || 1;
    const maxU = (rack.uHeight || 24) - uHeight + 1;
    const step = direction > 0 ? 1 : -1;

    for (let candidateU = device.uPosition + step; candidateU >= 1 && candidateU <= maxU; candidateU += step) {
      if (!this.findDeviceSlotConflict(rack, candidateU, uHeight, deviceId)) {
        return candidateU;
      }
    }
    return null;
  }

  nudgeDevice(deviceId, direction) {
    const targetU = this.findNearestFreeSlot(deviceId, direction);
    if (targetU === null) return false;
    return this.moveDevice(deviceId, targetU);
  }

  recalculateAutoCableLengthsForDevice(deviceId) {
    const routingMode = this.getCableRoutingMode();
    this.state.cables.forEach(c => {
      if (c.lengthAuto !== true) return;
      if (c.from.deviceId !== deviceId && c.to.deviceId !== deviceId) return;
      const estimate = calculateCableLengthEstimate(this.state, c, routingMode);
      if (!estimate.isInterRack) {
        c.lengthM = estimate.lengthM;
      }
    });
  }

  recalculateAutoCableLengths() {
    const routingMode = this.getCableRoutingMode();
    let changed = false;
    this.state.cables.forEach(c => {
      if (c.lengthAuto !== true) return;
      const estimate = calculateCableLengthEstimate(this.state, c, routingMode);
      if (!estimate.isInterRack && c.lengthM !== estimate.lengthM) {
        c.lengthM = estimate.lengthM;
        changed = true;
      }
    });
    return changed;
  }

  removeDevice(deviceId) {
    const loc = this.findDeviceLocation(deviceId);
    const rack = loc?.rack || this.getActiveRack();
    if (!rack) return;
    rack.installedDevices = rack.installedDevices.filter(d => d.id !== deviceId);
    this.state.cables = this.state.cables.filter(c => c.from.deviceId !== deviceId && c.to.deviceId !== deviceId);
    this.pruneTopologyPositions(new Set([deviceId]));
    if (this.selectedEntity?.id === deviceId) {
      this.clearSelection();
    }
    this.notify('device_removed', { deviceId });
  }

  updateDevice(deviceId, updates) {
    const loc = this.findDeviceLocation(deviceId);
    const dev = loc?.device || this.getActiveRack()?.installedDevices.find(d => d.id === deviceId);
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

    const interRack = isInterRackCableInState(this.state, cableData);
    const fromLoc = this.findDeviceLocation(cableData.from.deviceId);
    const toLoc = this.findDeviceLocation(cableData.to.deviceId);
    const fromPort = fromLoc?.template?.ports?.find(p => p.id === cableData.from.portId);
    const toPort = toLoc?.template?.ports?.find(p => p.id === cableData.to.portId);

    let inferredType = 'Cat6 UTP';
    if (fromPort?.type === 'sfp' && toPort?.type === 'sfp') {
      inferredType = interRack ? 'Fiber OM4' : '10G SFP+ DAC';
    } else if (fromPort?.type === 'sfp' || toPort?.type === 'sfp') {
      inferredType = interRack ? 'Fiber OM4' : 'Cat6A STP';
    }

    const hasExplicitLength = cableData.lengthM !== undefined && cableData.lengthM !== null && Number.isFinite(Number(cableData.lengthM));
    let lengthM;
    let lengthAuto;

    if (!hasExplicitLength && !interRack) {
      const estimate = calculateCableLengthEstimate(this.state, cableData, this.getCableRoutingMode());
      lengthM = estimate.lengthM;
      lengthAuto = true;
    } else if (!hasExplicitLength && interRack) {
      lengthM = INTER_RACK_DEFAULT_LENGTH_M;
      lengthAuto = false;
    } else {
      lengthM = Number(cableData.lengthM);
      lengthAuto = cableData.lengthAuto === true && !interRack;
    }

    const newCable = {
      id: `c-${Date.now()}-${++this._idSeq}`,
      groupId,
      from: cableData.from,
      to: cableData.to,
      color: cableData.color || defaultColor,
      type: cableData.type || inferredType,
      lengthM,
      lengthAuto,
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

  setCableLengthAuto(cableId, enabled) {
    const cable = this.state.cables.find(c => c.id === cableId);
    if (!cable) return null;
    if (enabled && !this.isInterRackCable(cable)) {
      const estimate = calculateCableLengthEstimate(this.state, cable, this.getCableRoutingMode());
      cable.lengthAuto = true;
      cable.lengthM = estimate.lengthM;
    } else {
      cable.lengthAuto = false;
    }
    this.notify('cable_updated', { cable });
    return cable;
  }

  // Workplace Groups
  addGroup(name, color = '#00d2ff', vlan = 10, description = '', rackId = null) {
    const targetRackId = rackId || this.state.activeRackId;
    const newGroup = {
      id: `grp-${Date.now()}-${++this._idSeq}`,
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

  getTopologyPositions(scopeKey) {
    if (!scopeKey || !this.state.topologyPositions || typeof this.state.topologyPositions !== 'object') {
      return {};
    }
    const bucket = this.state.topologyPositions[scopeKey];
    return bucket && typeof bucket === 'object' ? bucket : {};
  }

  setTopologyNodePosition(scopeKey, deviceId, x, y) {
    if (!scopeKey || !deviceId) return;
    const nx = Math.round(Number(x));
    const ny = Math.round(Number(y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    if (!this.state.topologyPositions || typeof this.state.topologyPositions !== 'object') {
      this.state.topologyPositions = {};
    }
    if (!this.state.topologyPositions[scopeKey] || typeof this.state.topologyPositions[scopeKey] !== 'object') {
      this.state.topologyPositions[scopeKey] = {};
    }
    this.state.topologyPositions[scopeKey][deviceId] = {
      x: Math.max(16, nx),
      y: Math.max(16, ny)
    };
    this.notify('topology_layout_updated', { scopeKey, deviceId });
  }

  resetTopologyPositions(scopeKey) {
    if (!scopeKey || !this.state.topologyPositions || typeof this.state.topologyPositions !== 'object') return;
    if (!this.state.topologyPositions[scopeKey]) return;
    delete this.state.topologyPositions[scopeKey];
    this.notify('topology_layout_updated', { scopeKey, reset: true });
  }

  pruneTopologyPositions(deviceIds, removedRackKey = null) {
    const map = this.state.topologyPositions;
    if (!map || typeof map !== 'object') return;
    if (removedRackKey && map[removedRackKey]) {
      delete map[removedRackKey];
    }
    Object.keys(map).forEach(scopeKey => {
      const bucket = map[scopeKey];
      if (!bucket || typeof bucket !== 'object') return;
      deviceIds.forEach(devId => {
        delete bucket[devId];
      });
      if (Object.keys(bucket).length === 0) {
        delete map[scopeKey];
      }
    });
  }

  setCableRoutingMode(mode) {
    this.state.cableRoutingMode = mode === 'arcs' ? 'arcs' : 'channels';
    this.recalculateAutoCableLengths();
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
    const loc = this.findDeviceLocation(deviceId);
    this.cableDraft = {
      deviceId,
      portId,
      sourceRackId: loc?.rack?.id || this.state.activeRackId,
      clientX,
      clientY
    };
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
      this.state = this.ensureBuiltinTemplates(parsed);
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
      this.state = this.ensureBuiltinTemplates(JSON.parse(JSON.stringify(DEFAULT_INITIAL_STATE)));
      this.saveState();
      this.clearSelection();
      this.notify('state_reset', this.state);
    }
  }
}

export const store = new StateStore();
