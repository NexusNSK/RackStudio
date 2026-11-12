/**
 * RackStudio - Main Application Controller
 */

import { store } from './state.js';
import { CableRenderer } from './cable-renderer.js';
import { RackRenderer } from './rack-renderer.js';
import { CliEditor } from './cli-editor.js';
import { TemplateBuilder } from './template-builder.js';
import { TopologyRenderer } from './topology-renderer.js';
import { PrintPassport } from './print-passport.js';
import { getPortDisplayName } from './cable-length.js';

// Early exposure of global modal and action shortcuts for inline HTML triggers
const RACK_ZOOM_MIN = 0.15;
const RACK_ZOOM_MAX = 2.0;
const RACK_ZOOM_STEP = 0.1;
const RACK_ZOOM_STORAGE_KEY = 'rack_studio_zoom_v1';
const RACK_THEME_STORAGE_KEY = 'rack_studio_theme_v1';

window.openAddRackModal = () => (window.app ? window.app.openAddRackModal() : null);
window.openEditRackModal = (id) => (window.app ? window.app.openEditRackModal(id) : null);
window.closeRackModal = () => (window.app ? window.app.closeRackModal() : null);
window.deleteRackConfirm = (id) => (window.app ? window.app.deleteRackConfirm(id) : null);
window.openAddGroupModal = () => (window.app ? window.app.openAddGroupModal() : null);
window.closeAddGroupModal = () => (window.app ? window.app.closeAddGroupModal() : null);
window.deleteGroupConfirm = (id, e) => (window.app ? window.app.deleteGroupConfirm(id, e) : null);
window.openDevicePalette = (u) => (window.app ? window.app.openDevicePalette(u) : null);
window.openDevicePaletteForUnit = (u) => (window.app ? window.app.openDevicePalette(u) : null);
window.closeDevicePalette = () => (window.app ? window.app.closeDevicePalette() : null);
window.deleteTemplateFromPalette = (id, e) => (window.app ? window.app.deleteTemplateFromPalette(id, e) : null);
window.editTemplateFromPalette = (id, e) => (window.app ? window.app.editTemplateFromPalette(id, e) : null);
window.openTemplateBuilder = () => (window.app ? window.app.templateBuilder.open() : null);
window.setCableRoutingMode = (mode) => (window.app ? window.app.setCableRoutingMode(mode) : null);
window.zoomRackIn = () => (window.app ? window.app.stepRackZoom(1) : null);
window.zoomRackOut = () => (window.app ? window.app.stepRackZoom(-1) : null);
window.resetRackZoom = () => (window.app ? window.app.setRackZoom(1) : null);
window.fitRackZoom = () => (window.app ? window.app.fitRackToViewport() : null);
window.setWorkspaceView = (view) => (window.app ? window.app.setWorkspaceView(view) : null);
window.openPrintModal = () => (window.app ? window.app.printPassport?.open() : null);
window.closePrintModal = () => (window.app ? window.app.printPassport?.close() : null);

class App {
  constructor() {
    this.svgContainer = document.getElementById('cables-svg');
    this.rackContainer = document.getElementById('rack-container');
    this.rackViewport = document.getElementById('rack-viewport');
    this.rackViewportCanvas = document.getElementById('rack-viewport-canvas');
    this.rackZoomSizer = document.getElementById('rack-zoom-sizer');
    this.rackZoomStage = document.getElementById('rack-zoom-stage');
    this.topologyViewport = document.getElementById('topology-viewport');
    this.rackZoom = this.loadZoomPreference();
    this.theme = this.loadThemePreference();
    this.workspaceView = 'rack';

    this.cableRenderer = new CableRenderer(this.svgContainer, this.rackContainer);
    this.rackRenderer = new RackRenderer(this.rackContainer, this.cableRenderer);
    this.cliEditor = new CliEditor(document.getElementById('cli-modal'));
    this.templateBuilder = new TemplateBuilder(document.getElementById('builder-modal'));
    this.topologyRenderer = new TopologyRenderer(this.topologyViewport);
    this.printPassport = new PrintPassport({
      modalElement: document.getElementById('print-modal'),
      reportRoot: document.getElementById('print-report-root'),
      topologyRenderer: this.topologyRenderer,
      onEnsureRackRendered: null
    });
    // Provide clean hidden snapshot helper so printing from Topology view still captures rack & cables
    this.printPassport.captureRackSnapshotMarkup = () => {
      return this.withRackRenderedForSnapshot(() => PrintPassport.prototype.captureRackSnapshotMarkup.call(this.printPassport));
    };

    this.editingRackId = null;

    this.initGlobalWindowExposures();
    this.initEventListeners();
    this.initKeyboardShortcuts();
    this.applyTheme(this.theme, { rerender: false });
    this.subscribeState();

    this.renderAll();
    this.applyRackZoom({ preserveScroll: false });
    this.updateRoutingModeUI();
    this.updateWorkspaceViewUI();
    this.updateThemeUI();
    this.updateSyncBadge({ status: store.syncStatus, message: store.syncMessage });
  }

  initGlobalWindowExposures() {
    window.store = store;
    window.app = this;
    window.openDeviceCli = (deviceId) => this.cliEditor.open(deviceId);
    window.openDevicePalette = (u) => this.openDevicePalette(u);
    window.openDevicePaletteForUnit = (u) => this.openDevicePalette(u);
    window.closeDevicePalette = () => this.closeDevicePalette();
    window.deleteTemplateFromPalette = (id, e) => this.deleteTemplateFromPalette(id, e);
    window.editTemplateFromPalette = (id, e) => this.editTemplateFromPalette(id, e);
    window.openTemplateBuilder = () => this.templateBuilder.open();
    window.openAddRackModal = () => this.openAddRackModal();
    window.openEditRackModal = (id) => this.openEditRackModal(id);
    window.closeRackModal = () => this.closeRackModal();
    window.deleteRackConfirm = (id) => this.deleteRackConfirm(id);
    window.openAddGroupModal = () => this.openAddGroupModal();
    window.closeAddGroupModal = () => this.closeAddGroupModal();
    window.deleteGroupConfirm = (id, e) => this.deleteGroupConfirm(id, e);
    window.zoomRackIn = () => this.stepRackZoom(1);
    window.zoomRackOut = () => this.stepRackZoom(-1);
    window.resetRackZoom = () => this.setRackZoom(1);
    window.fitRackZoom = () => this.fitRackToViewport();
    window.setWorkspaceView = (view) => this.setWorkspaceView(view);
    window.openPrintModal = () => this.printPassport?.open();
    window.closePrintModal = () => this.printPassport?.close();
    window.setAppTheme = (theme) => this.setTheme(theme);
    window.toggleAppTheme = () => this.toggleTheme();
  }

  deleteRackConfirm(rackId) {
    const rack = store.getRacks().find(r => r.id === rackId) || store.getActiveRack();
    if (!rack) return;
    if (store.getRacks().length <= 1) {
      alert(`Нельзя удалить единственную стойку "${rack.name}". В проекте должна оставаться минимум одна серверная стойка.`);
      return;
    }
    const devsCount = rack.installedDevices.length;
    const confirmMsg = devsCount > 0
      ? `Удалить серверную стойку "${rack.name}" (${rack.uHeight}U) и все смонтированные в ней устройства (${devsCount} шт.) и кабели?`
      : `Удалить серверную стойку "${rack.name}" (${rack.uHeight}U)?`;

    if (confirm(confirmMsg)) {
      store.deleteRack(rack.id);
      this.closeRackModal();
    }
  }

  deleteGroupConfirm(groupId, e) {
    if (e) e.stopPropagation();
    const grp = store.getGroup(groupId);
    if (!grp) return;
    const cablesInGroup = store.state.cables.filter(c => c.groupId === groupId).length;
    const confirmMsg = cablesInGroup > 0
      ? `Удалить группу соединений "${grp.name}"? ${cablesInGroup} кабелей будут отвязаны от группы.`
      : `Удалить группу соединений "${grp.name}"?`;

    if (confirm(confirmMsg)) {
      store.deleteGroup(groupId);
      this.renderGroupModalList();
    }
  }

  deleteTemplateFromPalette(tplId, e) {
    if (e) e.stopPropagation();
    const tpl = store.getTemplate(tplId);
    if (!tpl) return;
    if (confirm(`Удалить устройство "${tpl.name}" (${tpl.vendor}) из пула оборудования?`)) {
      store.deleteTemplate(tplId);
      this.openDevicePalette(this.targetPaletteU);
    }
  }

  editTemplateFromPalette(tplId, e) {
    if (e) e.stopPropagation();
    this.closeDevicePalette();
    this.templateBuilder.open(tplId);
  }

  initEventListeners() {
    const rackSelect = document.getElementById('rack-select');
    rackSelect?.addEventListener('change', (e) => {
      if (e.target.value === '__add_new__') {
        this.openAddRackModal();
      } else {
        store.setActiveRack(e.target.value);
      }
    });

    document.getElementById('btn-add-rack')?.addEventListener('click', () => {
      this.openAddRackModal();
    });

    document.getElementById('btn-sidebar-add-rack')?.addEventListener('click', () => {
      this.openAddRackModal();
    });

    document.getElementById('btn-edit-rack')?.addEventListener('click', () => {
      this.openEditRackModal(store.state.activeRackId);
    });

    // Rack modal controls
    document.getElementById('close-rack-modal')?.addEventListener('click', () => {
      this.closeRackModal();
    });

    document.getElementById('btn-cancel-rack-modal')?.addEventListener('click', () => {
      this.closeRackModal();
    });

    document.getElementById('rack-u-input')?.addEventListener('change', (e) => {
      const customWrap = document.getElementById('rack-custom-u-wrap');
      if (customWrap) {
        if (e.target.value === 'custom') {
          customWrap.classList.remove('hidden');
        } else {
          customWrap.classList.add('hidden');
        }
      }
    });

    document.getElementById('btn-delete-rack-modal')?.addEventListener('click', () => {
      if (this.editingRackId) {
        const rack = store.getRacks().find(r => r.id === this.editingRackId);
        if (confirm(`Удалить стойку "${rack?.name || 'Стойка'}" и все ее подключения?`)) {
          store.deleteRack(this.editingRackId);
          this.closeRackModal();
        }
      }
    });

    const rackForm = document.getElementById('rack-form');
    rackForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('rack-name-input')?.value.trim();
      const uSelect = document.getElementById('rack-u-input')?.value;
      const customU = parseInt(document.getElementById('rack-custom-u-input')?.value, 10);
      const model = document.getElementById('rack-model-input')?.value;

      let uHeight = uSelect === 'custom' ? (customU || 24) : parseInt(uSelect, 10) || 24;

      if (!name) {
        alert('Укажите название стойки');
        return;
      }

      if (this.editingRackId) {
        store.updateRack(this.editingRackId, {
          name,
          uHeight,
          model
        });
      } else {
        store.addRack(name, uHeight, model);
      }

      this.closeRackModal();
    });

    document.getElementById('toggle-dim-cables')?.addEventListener('change', (e) => {
      store.setDimInactiveCables(e.target.checked);
    });

    document.getElementById('btn-add-group')?.addEventListener('click', () => {
      this.openAddGroupModal();
    });

    document.getElementById('btn-catalog')?.addEventListener('click', () => {
      this.openDevicePalette();
    });

    document.getElementById('btn-template-builder')?.addEventListener('click', () => {
      this.templateBuilder.open();
    });

    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      store.exportToJson();
    });

    document.getElementById('btn-import-json')?.addEventListener('click', () => {
      document.getElementById('import-file-input')?.click();
    });

    document.getElementById('import-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        store.importFromJson(evt.target?.result);
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('close-palette-modal')?.addEventListener('click', () => {
      this.closeDevicePalette();
    });

    document.getElementById('close-details-drawer')?.addEventListener('click', () => {
      store.clearSelection();
    });

    document.getElementById('close-group-modal')?.addEventListener('click', () => {
      this.closeAddGroupModal();
    });

    this.rackViewport?.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const anchor = { x: e.clientX, y: e.clientY };
      if (Math.abs(e.deltaY) >= 40) {
        this.stepRackZoom(e.deltaY < 0 ? 1 : -1, anchor);
      } else if (e.deltaY !== 0) {
        const factor = Math.exp(-e.deltaY * 0.005);
        this.setRackZoom(this.rackZoom * factor, anchor);
      }
    }, { passive: false });

    if (this.rackZoomStage && typeof ResizeObserver === 'function') {
      this.rackStageObserver = new ResizeObserver(() => {
        this.syncRackZoomSizer();
      });
      this.rackStageObserver.observe(this.rackZoomStage);
    }

    // Topology view controls
    document.getElementById('topo-scope-active')?.addEventListener('click', () => {
      this.topologyRenderer.setScope('active');
      this.updateTopologyToolbarUI();
    });
    document.getElementById('topo-scope-all')?.addEventListener('click', () => {
      this.topologyRenderer.setScope('all');
      this.updateTopologyToolbarUI();
    });
    document.getElementById('topo-toggle-bundle')?.addEventListener('change', (e) => {
      this.topologyRenderer.setAggregateBundles(e.target.checked);
    });
    document.getElementById('topo-toggle-unlinked')?.addEventListener('change', (e) => {
      this.topologyRenderer.setShowStandalone(e.target.checked);
    });
    document.getElementById('topo-zoom-out')?.addEventListener('click', () => this.topologyRenderer.stepZoom(-1));
    document.getElementById('topo-zoom-reset')?.addEventListener('click', () => this.topologyRenderer.setZoom(1));
    document.getElementById('topo-zoom-in')?.addEventListener('click', () => this.topologyRenderer.stepZoom(1));
    document.getElementById('btn-topo-reset-layout')?.addEventListener('click', () => {
      this.topologyRenderer.resetLayout();
    });
    document.getElementById('topology-scroll-area')?.addEventListener('click', (e) => {
      if (this.topologyRenderer?.isSuppressingClick?.()) return;
      if (e.target === e.currentTarget || e.target.id === 'topology-svg-stage' || e.target.id === 'topology-svg') {
        store.clearSelection();
      }
    });
  }

  isModalOpen(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    return !el.classList.contains('hidden') || el.style.display === 'flex';
  }

  getTopOpenModalId() {
    const order = ['print-modal', 'cli-modal', 'builder-modal', 'palette-modal', 'group-modal', 'rack-modal'];
    return order.find(id => this.isModalOpen(id)) || null;
  }

  closeModalById(id) {
    if (id === 'print-modal') this.printPassport?.close();
    else if (id === 'cli-modal') this.cliEditor?.close();
    else if (id === 'builder-modal') this.templateBuilder?.close();
    else if (id === 'palette-modal') this.closeDevicePalette();
    else if (id === 'group-modal') this.closeAddGroupModal();
    else if (id === 'rack-modal') this.closeRackModal();
  }

  initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const target = e.target;
      const isEditable = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );

      if (e.key === 'Escape') {
        if (this.rackRenderer?.dragState) return;
        if (store.cableDraft) {
          store.cancelCableDraft();
          return;
        }
        const openModalId = this.getTopOpenModalId();
        if (openModalId) {
          this.closeModalById(openModalId);
          return;
        }
        if (store.selectedEntity) {
          store.clearSelection();
        }
        return;
      }

      if (isEditable || this.getTopOpenModalId() || this.rackRenderer?.dragState) {
        return;
      }

      const sel = store.selectedEntity;
      if (!sel) return;

      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.workspaceView !== 'rack' || store.cableDraft || sel.type !== 'device') return;
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const moved = store.nudgeDevice(sel.id, dir);
        if (moved) {
          const devEl = this.rackContainer?.querySelector(`.installed-device[data-device-id="${sel.id}"]`);
          devEl?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.cableDraft) return;
        if (sel.type === 'cable') {
          e.preventDefault();
          store.removeCable(sel.id);
        } else if (sel.type === 'device') {
          e.preventDefault();
          const loc = store.findDeviceLocation(sel.id);
          const name = loc?.device?.customName || 'устройство';
          if (confirm(`Удалить устройство "${name}" и все его соединения?`)) {
            store.removeDevice(sel.id);
          }
        }
      }
    });
  }

  setWorkspaceView(view) {
    const next = view === 'topology' ? 'topology' : 'rack';
    this.workspaceView = next;
    this.updateWorkspaceViewUI();

    if (next === 'topology') {
      this.cableRenderer?.hideTooltip();
      this.topologyRenderer.render();
      this.updateTopologyToolbarUI();
    } else {
      this.rackRenderer.render();
      this.syncRackZoomSizer();
      this.cableRenderer.render();
    }
  }

  updateWorkspaceViewUI() {
    const btnRack = document.getElementById('btn-view-rack');
    const btnTopo = document.getElementById('btn-view-topology');
    const routingCtrls = document.getElementById('rack-routing-controls');
    const zoomDiv = document.getElementById('rack-zoom-divider');
    const zoomCtrls = document.getElementById('rack-zoom-controls');

    const isTopo = this.workspaceView === 'topology';

    if (this.rackViewport) {
      this.rackViewport.classList.toggle('hidden', isTopo);
    }
    if (this.topologyViewport) {
      this.topologyViewport.classList.toggle('hidden', !isTopo);
      this.topologyViewport.classList.toggle('flex', isTopo);
    }

    if (btnRack && btnTopo) {
      btnRack.className = `px-2.5 py-0.5 rounded-md text-[11px] font-medium transition ${!isTopo ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
      btnTopo.className = `px-2.5 py-0.5 rounded-md text-[11px] font-medium transition ${isTopo ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
    }

    routingCtrls?.classList.toggle('hidden', isTopo);
    zoomDiv?.classList.toggle('hidden', isTopo);
    zoomCtrls?.classList.toggle('hidden', isTopo);
  }

  updateTopologyToolbarUI() {
    const btnActive = document.getElementById('topo-scope-active');
    const btnAll = document.getElementById('topo-scope-all');
    const isAll = this.topologyRenderer.scope === 'all';
    if (btnActive && btnAll) {
      btnActive.className = `px-2.5 py-1 rounded-md text-[11px] font-medium transition ${!isAll ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
      btnAll.className = `px-2.5 py-1 rounded-md text-[11px] font-medium transition ${isAll ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
    }
  }

  withRackRenderedForSnapshot(callback) {
    if (this.workspaceView !== 'topology' || !this.rackViewport) {
      this.rackRenderer.render();
      this.cableRenderer.render();
      return callback();
    }
    const prevVis = this.rackViewport.style.visibility;
    const prevPos = this.rackViewport.style.position;
    this.rackViewport.style.visibility = 'hidden';
    this.rackViewport.style.position = 'fixed';
    this.rackViewport.classList.remove('hidden');
    this.rackRenderer.render();
    this.cableRenderer.render();
    try {
      return callback();
    } finally {
      this.rackViewport.classList.add('hidden');
      this.rackViewport.style.visibility = prevVis;
      this.rackViewport.style.position = prevPos;
    }
  }

  renderCableDraftBanner() {
    const banner = document.getElementById('cable-draft-banner');
    if (!banner) return;

    const draft = store.cableDraft;
    if (!draft) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      return;
    }

    const srcLoc = store.findDeviceLocation(draft.deviceId);
    const srcPort = getPortDisplayName(srcLoc?.template, draft.portId) || draft.portId;
    const srcRack = srcLoc?.rack || store.getActiveRack();
    const otherRacks = store.getRacks().filter(r => r.id !== store.state.activeRackId);

    banner.innerHTML = `
      <span class="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shrink-0"></span>
      <span class="text-slate-200">
        Подключение от <b class="text-cyan-300">[${srcRack?.name || 'Стойка'}] ${srcLoc?.device?.customName || draft.deviceId} : ${srcPort}</b> — выберите целевой порт
      </span>
      ${otherRacks.length > 0 ? `
        <div class="flex items-center gap-1 border-l border-slate-700 pl-2">
          <span class="text-slate-400 text-[11px]">В другую стойку:</span>
          ${otherRacks.map(r => `
            <button type="button" class="px-2 py-0.5 rounded bg-indigo-950 hover:bg-indigo-900 text-indigo-200 border border-indigo-700/80 text-[11px] font-medium transition"
                    onclick="window.store.setActiveRack('${r.id}')">
              ⇄ ${r.name}
            </button>
          `).join('')}
        </div>
      ` : ''}
      <button type="button" class="ml-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] transition"
              onclick="window.store.cancelCableDraft()">
        Отмена (Esc)
      </button>
    `;
    banner.classList.remove('hidden');
  }

  subscribeState() {
    store.subscribe((event, payload) => {
      if (event === 'cable_draft_started' || event === 'cable_draft_cancelled' || event === 'cable_draft_finished') {
        this.renderCableDraftBanner();
        this.rackRenderer.updateDraftPortHighlight();
        this.cableRenderer.renderDraft();
        return;
      }

      if (event === 'rack_changed' || event === 'rack_added' || event === 'rack_deleted' || event === 'rack_updated' || event === 'state_imported' || event === 'state_reset' || event === 'remote_state_updated') {
        this.updateRackSelector();
        this.renderWorkplaceFilterBadges();
        this.rackRenderer.render();
        this.syncRackZoomSizer();
        this.cableRenderer.render();
        this.renderCableDraftBanner();
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
      } else if (event === 'sync_status_changed') {
        this.updateSyncBadge(payload);
      } else if (event === 'group_filter_changed' || event === 'filter_settings_changed') {
        this.updateRoutingModeUI();
        this.renderWorkplaceFilterBadges();
        this.rackRenderer.render();
        this.cableRenderer.render();
        if (event === 'filter_settings_changed' && store.selectedEntity?.type === 'cable') {
          this.renderDetailsDrawer();
        }
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
      } else if (event === 'selection_changed') {
        this.renderDetailsDrawer();
        this.cableRenderer.render();
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
      } else if (event === 'topology_layout_updated') {
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
      } else if (event.startsWith('cable_') || event.startsWith('device_')) {
        this.renderWorkplaceFilterBadges();
        this.rackRenderer.render();
        this.cableRenderer.render();
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
        // Do not re-render drawer on update to prevent stealing input focus
        if (event !== 'device_updated' && event !== 'cable_updated') {
          this.renderDetailsDrawer();
        }
      } else if (event.startsWith('group_')) {
        this.renderWorkplaceFilterBadges();
        this.renderGroupModalList();
        this.cableRenderer.render();
        if (this.workspaceView === 'topology') this.topologyRenderer.render();
      } else if (event.startsWith('template_')) {
        if (event === 'template_updated') {
          this.rackRenderer.render();
          this.cableRenderer.render();
          this.renderDetailsDrawer();
          if (this.workspaceView === 'topology') this.topologyRenderer.render();
        }
        const pModal = document.getElementById('palette-modal');
        if (pModal && (!pModal.classList.contains('hidden') || pModal.style.display === 'flex')) {
          this.openDevicePalette(this.targetPaletteU);
        }
      }
    });
  }

  renderAll() {
    this.updateRackSelector();
    this.renderWorkplaceFilterBadges();
    this.rackRenderer.render();
    this.syncRackZoomSizer();
    this.updateZoomUI();
    this.renderDetailsDrawer();
  }

  /** Restores saved UI color theme preference for this browser without touching project state. */
  loadThemePreference() {
    try {
      const saved = localStorage.getItem(RACK_THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') {
        return saved;
      }
    } catch {
      // Ignore storage access restrictions
    }
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  saveThemePreference(theme) {
    try {
      localStorage.setItem(RACK_THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage access restrictions
    }
  }

  isLightTheme() {
    return this.theme === 'light';
  }

  applyTheme(theme, { rerender = true } = {}) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    this.theme = normalized;
    document.documentElement.dataset.theme = normalized;
    document.documentElement.classList.toggle('dark', normalized === 'dark');
    document.documentElement.style.colorScheme = normalized;
    this.updateThemeUI();

    if (rerender) {
      this.rackRenderer?.render();
      this.cableRenderer?.render();
      this.topologyRenderer?.render();
      this.renderWorkplaceFilterBadges();
      this.renderDetailsDrawer();
      this.updateWorkspaceViewUI();
      this.updateRoutingModeUI();
      this.updateTopologyToolbarUI();
      this.updateZoomUI();
      if (this.isModalOpen('print-modal')) {
        this.printPassport?.refreshReport();
      }
    }
  }

  setTheme(theme) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    if (normalized === this.theme && document.documentElement.dataset.theme === normalized) {
      this.updateThemeUI();
      return;
    }
    this.saveThemePreference(normalized);
    this.applyTheme(normalized, { rerender: true });
  }

  toggleTheme() {
    this.setTheme(this.theme === 'light' ? 'dark' : 'light');
  }

  updateThemeUI() {
    const btn = document.getElementById('btn-toggle-theme');
    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    const label = document.getElementById('theme-toggle-label');
    const isLight = this.isLightTheme();

    if (sun) sun.classList.toggle('hidden', !isLight);
    if (moon) moon.classList.toggle('hidden', isLight);
    if (label) label.textContent = isLight ? 'Светлая' : 'Тёмная';
    if (btn) {
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      btn.setAttribute(
        'title',
        isLight ? 'Светлая тема активна (нажмите для тёмной)' : 'Тёмная тема активна (нажмите для светлой)'
      );
    }
  }

  /** Restores saved viewport zoom factor for this browser without touching project state. */
  loadZoomPreference() {
    try {
      const saved = parseFloat(localStorage.getItem(RACK_ZOOM_STORAGE_KEY));
      if (Number.isFinite(saved)) {
        return this.clampZoom(saved);
      }
    } catch {
      // Ignore storage access restrictions
    }
    return 1;
  }

  saveZoomPreference(zoom) {
    try {
      localStorage.setItem(RACK_ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // Ignore storage access restrictions
    }
  }

  clampZoom(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.min(RACK_ZOOM_MAX, Math.max(RACK_ZOOM_MIN, Math.round(num * 100) / 100));
  }

  /** Keeps scroll sizer dimensions and side cable-channel gutters synchronized with zoom and rack height. */
  syncRackZoomSizer() {
    if (!this.rackZoomStage || !this.rackZoomSizer) return;
    const z = this.rackZoom || 1;
    const baseW = this.rackZoomStage.offsetWidth || 760;
    const baseH = this.rackZoomStage.offsetHeight || this.rackContainer?.offsetHeight || 0;
    this.rackZoomSizer.style.width = `${Math.round(baseW * z)}px`;
    this.rackZoomSizer.style.height = `${Math.round(baseH * z)}px`;
    if (this.rackViewportCanvas) {
      const padX = Math.round(56 * Math.max(1, z));
      this.rackViewportCanvas.style.paddingLeft = `${padX}px`;
      this.rackViewportCanvas.style.paddingRight = `${padX}px`;
    }
  }

  updateZoomUI() {
    const btnOut = document.getElementById('btn-zoom-out');
    const btnReset = document.getElementById('btn-zoom-reset');
    const btnIn = document.getElementById('btn-zoom-in');
    const pct = Math.round((this.rackZoom || 1) * 100);

    if (btnReset) {
      btnReset.textContent = `${pct}%`;
      btnReset.classList.toggle('text-cyan-300', pct !== 100);
      btnReset.classList.toggle('text-slate-200', pct === 100);
    }
    if (btnOut) btnOut.disabled = this.rackZoom <= RACK_ZOOM_MIN;
    if (btnIn) btnIn.disabled = this.rackZoom >= RACK_ZOOM_MAX;
  }

  /** Applies current zoom scale and keeps anchorClient (or viewport center) stationary in view. */
  applyRackZoom({ prevZoom = this.rackZoom, anchorClient = null, preserveScroll = true } = {}) {
    if (!this.rackZoomStage) {
      this.updateZoomUI();
      return;
    }

    let anchorX = 0;
    let anchorY = 0;
    let localX = 0;
    let localY = 0;
    const canAnchor = preserveScroll && this.rackViewport && prevZoom > 0;

    if (canAnchor) {
      const vpRect = this.rackViewport.getBoundingClientRect();
      anchorX = anchorClient?.x ?? (vpRect.left + this.rackViewport.clientWidth / 2);
      anchorY = anchorClient?.y ?? (vpRect.top + this.rackViewport.clientHeight / 2);
      const stageBefore = this.rackZoomStage.getBoundingClientRect();
      localX = (anchorX - stageBefore.left) / prevZoom;
      localY = (anchorY - stageBefore.top) / prevZoom;
    }

    const z = this.rackZoom || 1;
    this.rackZoomStage.style.transform = z === 1 ? '' : `scale(${z})`;
    this.syncRackZoomSizer();
    this.updateZoomUI();

    if (canAnchor) {
      const stageAfter = this.rackZoomStage.getBoundingClientRect();
      this.rackViewport.scrollLeft += (stageAfter.left + localX * z) - anchorX;
      this.rackViewport.scrollTop += (stageAfter.top + localY * z) - anchorY;
    }
  }

  setRackZoom(nextZoom, anchorClient = null) {
    const prevZoom = this.rackZoom;
    const clamped = this.clampZoom(nextZoom);
    const expectedTransform = clamped === 1 ? '' : `scale(${clamped})`;
    if (clamped === prevZoom && this.rackZoomStage?.style.transform === expectedTransform) {
      return clamped;
    }
    this.rackZoom = clamped;
    this.saveZoomPreference(clamped);
    this.applyRackZoom({ prevZoom, anchorClient, preserveScroll: true });
    this.cableRenderer?.hideTooltip();
    return clamped;
  }

  stepRackZoom(direction, anchorClient = null) {
    const pct = Math.round((this.rackZoom || 1) * 100);
    const stepPct = Math.round(RACK_ZOOM_STEP * 100);
    const nextPct = direction > 0
      ? (Math.floor(pct / stepPct) + 1) * stepPct
      : (Math.ceil(pct / stepPct) - 1) * stepPct;
    return this.setRackZoom(nextPct / 100, anchorClient);
  }

  /** Fits the entire active rack inside #rack-viewport without clipping width or height. */
  fitRackToViewport() {
    if (!this.rackViewport || !this.rackContainer) return 1;
    const rackW = this.rackContainer.offsetWidth || 760;
    const rackH = Math.max(this.rackContainer.offsetHeight || 0, this.rackZoomStage?.offsetHeight || 0);
    if (!rackW || !rackH) return 1;

    const availW = Math.max(200, this.rackViewport.clientWidth - 112);
    const availH = Math.max(200, this.rackViewport.clientHeight - 48);
    const fitZoom = this.clampZoom(Math.floor(Math.min(availH / rackH, availW / rackW) * 100) / 100);
    const prevZoom = this.rackZoom;
    this.rackZoom = fitZoom;
    this.saveZoomPreference(fitZoom);
    this.applyRackZoom({ prevZoom, preserveScroll: false });
    this.rackViewport.scrollTop = 0;
    this.rackViewport.scrollLeft = 0;
    this.cableRenderer?.hideTooltip();
    return fitZoom;
  }

  setCableRoutingMode(mode) {
    store.setCableRoutingMode(mode);
    this.updateRoutingModeUI();
  }

  updateRoutingModeUI() {
    const mode = store.getCableRoutingMode();
    const btnCh = document.getElementById('btn-route-channels');
    const btnArc = document.getElementById('btn-route-arcs');
    if (!btnCh || !btnArc) return;

    if (mode === 'channels') {
      btnCh.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-medium transition bg-cyan-600 text-white shadow-sm';
      btnArc.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-medium transition text-slate-400 hover:text-slate-200';
    } else {
      btnArc.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-medium transition bg-cyan-600 text-white shadow-sm';
      btnCh.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-medium transition text-slate-400 hover:text-slate-200';
    }
  }

  updateSyncBadge(payload) {
    const badge = document.getElementById('cloud-sync-status');
    const dot = document.getElementById('sync-dot');
    const text = document.getElementById('sync-text');
    if (!badge || !dot || !text) return;

    const { status, message } = payload || {};
    text.textContent = message || '';

    dot.className = 'w-2 h-2 rounded-full transition-colors';
    if (status === 'synced') {
      dot.classList.add('bg-emerald-400');
      badge.setAttribute('title', 'Единое состояние синхронизировано с сервером');
    } else if (status === 'saving') {
      dot.classList.add('bg-amber-400', 'animate-pulse');
      badge.setAttribute('title', 'Сохранение изменений на сервер...');
    } else if (status === 'error') {
      dot.classList.add('bg-rose-500');
      badge.setAttribute('title', 'Ошибка связи с сервером');
    } else {
      dot.classList.add('bg-slate-500');
      badge.setAttribute('title', 'Автономный режим (сохраняется в браузере)');
    }
  }

  updateRackSelector() {
    const rackSelect = document.getElementById('rack-select');
    const racksList = document.getElementById('sidebar-racks-list');
    const racks = store.getRacks();
    const activeRack = store.getActiveRack();

    if (rackSelect) {
      let html = racks.map(r => `
        <option value="${r.id}" ${r.id === activeRack?.id ? 'selected' : ''}>
          ${r.name} (${r.uHeight}U)
        </option>
      `).join('');
      html += '<option value="__add_new__">+ Создать новую стойку...</option>';
      rackSelect.innerHTML = html;
    }

    if (racksList) {
      racksList.innerHTML = racks.map(r => {
        const isActive = r.id === activeRack?.id;
        return `
          <div class="group relative flex items-center justify-between p-2 rounded-lg text-xs font-medium border transition ${isActive ? 'bg-cyan-950/50 text-cyan-200 border-cyan-700/80 shadow-sm' : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border-slate-800'}">
            <button class="flex-1 text-left cursor-pointer truncate pr-1"
                    onclick="store.setActiveRack('${r.id}')">
              <div class="font-bold truncate text-slate-200 flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full ${isActive ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-slate-700'} shrink-0"></span>
                <span class="truncate">${r.name}</span>
              </div>
              <div class="text-[10px] text-slate-500 font-mono mt-0.5">${r.uHeight}U • ${r.installedDevices.length} устр.</div>
            </button>
            <div class="flex items-center gap-1 shrink-0">
              <button class="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition"
                      title="Настройки стойки"
                      onclick="window.openEditRackModal('${r.id}'); event.stopPropagation();">
                ⚙
              </button>
              ${racks.length > 1 ? `
              <button class="p-1 text-slate-500 hover:text-red-400 rounded hover:bg-red-950/60 transition"
                      title="Удалить стойку"
                      onclick="window.deleteRackConfirm('${r.id}'); event.stopPropagation();">
                🗑
              </button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  openAddRackModal() {
    this.editingRackId = null;
    const modal = document.getElementById('rack-modal');
    if (!modal) return;

    const titleEl = document.getElementById('rack-modal-title');
    if (titleEl) titleEl.textContent = 'Новая серверная стойка';

    const nameInput = document.getElementById('rack-name-input');
    if (nameInput) nameInput.value = `Стойка №${store.getRacks().length + 1}`;

    const uInput = document.getElementById('rack-u-input');
    if (uInput) uInput.value = '24';

    const customWrap = document.getElementById('rack-custom-u-wrap');
    if (customWrap) customWrap.classList.add('hidden');

    const delBtn = document.getElementById('btn-delete-rack-modal');
    if (delBtn) delBtn.classList.add('hidden');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
  }

  openEditRackModal(rackId) {
    const rack = store.getRacks().find(r => r.id === rackId) || store.getActiveRack();
    if (!rack) return;

    this.editingRackId = rack.id;
    const modal = document.getElementById('rack-modal');
    if (!modal) return;

    const titleEl = document.getElementById('rack-modal-title');
    if (titleEl) titleEl.textContent = `Настройки: ${rack.name}`;

    const nameInput = document.getElementById('rack-name-input');
    if (nameInput) nameInput.value = rack.name;

    const uInput = document.getElementById('rack-u-input');
    const customWrap = document.getElementById('rack-custom-u-wrap');
    const customUInput = document.getElementById('rack-custom-u-input');

    if (['12', '18', '24', '42', '48'].includes(String(rack.uHeight))) {
      if (uInput) uInput.value = String(rack.uHeight);
      if (customWrap) customWrap.classList.add('hidden');
    } else {
      if (uInput) uInput.value = 'custom';
      if (customWrap) customWrap.classList.remove('hidden');
      if (customUInput) customUInput.value = rack.uHeight;
    }

    const modelInput = document.getElementById('rack-model-input');
    if (modelInput && rack.model) modelInput.value = rack.model;

    const delBtn = document.getElementById('btn-delete-rack-modal');
    if (delBtn) {
      if (store.getRacks().length > 1) {
        delBtn.classList.remove('hidden');
      } else {
        delBtn.classList.add('hidden');
      }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
  }

  closeRackModal() {
    const modal = document.getElementById('rack-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.style.display = 'none';
    }
    this.editingRackId = null;
    this.updateRackSelector();
  }

  renderWorkplaceFilterBadges() {
    const container = document.getElementById('workplace-filter-bar');
    if (!container) return;

    const groups = store.getGroups();
    const activeFilter = store.getActiveGroupFilter();
    const allCables = store.getCablesForActiveRack();

    let html = `
      <button class="filter-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${activeFilter === 'ALL' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm' : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-slate-700/60'}"
              data-group-id="ALL">
        <span>🌐 Все соединения</span>
        <span class="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-900/80 text-slate-400 font-mono">${allCables.length}</span>
      </button>
    `;

    groups.forEach(g => {
      const isSelected = activeFilter === g.id;
      const count = allCables.filter(c => c.groupId === g.id).length;

      html += `
        <div class="group/pill flex items-center rounded-lg overflow-hidden border ${isSelected ? '' : 'border-slate-700/60'}"
             style="${isSelected ? `border: 1px solid ${g.color}; box-shadow: 0 0 10px ${g.color}33;` : ''}">
          <button class="filter-pill flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition ${isSelected ? 'text-white' : 'bg-slate-800/80 text-slate-300 hover:text-white'}"
                  style="${isSelected ? `background: ${g.color}25;` : ''}"
                  data-group-id="${g.id}">
            <span class="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm" style="background:${g.color}"></span>
            <span class="truncate max-w-[140px]">${g.name}</span>
            <span class="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-900/80 font-mono" style="color:${g.color}">${count}</span>
          </button>
          <button class="px-1.5 py-1.5 text-slate-500 hover:text-red-400 bg-slate-850 hover:bg-red-950/80 transition text-xs border-l border-slate-700/50"
                  title="Удалить группу '${g.name}'"
                  onclick="window.deleteGroupConfirm('${g.id}', event)">
            ✕
          </button>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const gid = btn.dataset.groupId;
        store.setActiveGroupFilter(gid);
      });
    });
  }

  openDevicePalette(targetU = null) {
    this.targetPaletteU = targetU;
    const modal = document.getElementById('palette-modal');
    const listContainer = document.getElementById('palette-devices-list');
    if (!modal || !listContainer) return;

    const templates = [...store.getTemplates()].sort((a, b) => {
      const aEltex = String(a.vendor || '').toLowerCase().includes('eltex') ? 0 : 1;
      const bEltex = String(b.vendor || '').toLowerCase().includes('eltex') ? 0 : 1;
      return aEltex - bEltex;
    });
    const rack = store.getActiveRack();

    listContainer.innerHTML = templates.map(tpl => {
      const isEltex = String(tpl.vendor || '').toLowerCase().includes('eltex');
      return `
      <div class="bg-slate-800/90 border ${isEltex ? 'border-sky-600/60' : 'border-slate-700'} hover:border-cyan-500/60 rounded-xl p-3 flex flex-col justify-between transition-all group">
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-cyan-300 border border-cyan-900/50">${tpl.uHeight}U • ${tpl.category.toUpperCase()}</span>
              ${isEltex ? '<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-700/70">★ Eltex</span>' : ''}
            </div>
            <span class="text-[11px] text-slate-400">${tpl.powerW ? `${tpl.powerW} Вт` : 'Пассивный'}</span>
          </div>
          <h4 class="font-bold text-sm text-slate-100 group-hover:text-cyan-300 transition">${tpl.name}</h4>
          <p class="text-xs text-slate-400 mt-1">${tpl.vendor} • Портов: <b>${tpl.ports.length}</b></p>
        </div>

        <div class="mt-4 pt-3 border-t border-slate-700/60 flex items-center justify-between">
          <span class="text-[10px] text-slate-500">
            ${tpl.style?.customImage ? '★ Фото-панель' : 'Стандартный рендер'}
          </span>
          <div class="flex items-center gap-2">
            <button class="px-2.5 py-1.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/60 border border-slate-700 hover:border-cyan-800 rounded-lg text-xs transition flex items-center justify-center"
                    title="Редактировать шаблон устройства"
                    onclick="window.editTemplateFromPalette('${tpl.id}', event)">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <button class="px-2.5 py-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/60 border border-slate-700 hover:border-red-800 rounded-lg text-xs transition"
                    title="Удалить устройство из пула оборудования"
                    onclick="window.deleteTemplateFromPalette('${tpl.id}', event)">
              🗑
            </button>
            <button class="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold rounded-lg shadow-md transition"
                    onclick="window.installTemplateFromPalette('${tpl.id}')">
              Установить в стойку
            </button>
          </div>
        </div>
      </div>
    `;
    }).join('');

    window.installTemplateFromPalette = (tplId) => {
      let targetUnit = this.targetPaletteU;
      if (!targetUnit) {
        targetUnit = rack?.uHeight || 24;
      }
      const dev = store.installDevice(tplId, targetUnit);
      if (dev) {
        this.closeDevicePalette();
      }
    };

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
  }

  closeDevicePalette() {
    const modal = document.getElementById('palette-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.style.display = 'none';
    }
    this.targetPaletteU = null;
  }

  renderGroupModalList() {
    const list = document.getElementById('group-existing-list');
    if (!list) return;
    const activeRack = store.getActiveRack();
    const groups = store.getGroups();
    const allCables = store.getCablesForActiveRack();

    const titleEl = document.querySelector('#group-existing-list-wrap > div');
    if (titleEl) {
      titleEl.textContent = `Группы стойки "${activeRack?.name || 'Стойка'}" (${groups.length})`;
    }

    if (groups.length === 0) {
      list.innerHTML = `<div class="text-[11px] text-slate-500 italic p-1">У стойки "${activeRack?.name || 'Стойка'}" пока нет групп соединений. Создайте первую группу выше.</div>`;
      return;
    }

    list.innerHTML = groups.map(g => {
      const cablesCount = allCables.filter(c => c.groupId === g.id).length;
      return `
        <div class="flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-xs">
          <div class="flex items-center gap-2 truncate">
            <span class="w-3 h-3 rounded-full shrink-0 shadow-sm" style="background:${g.color}"></span>
            <div class="truncate">
              <span class="font-bold text-white">${g.name}</span>
              <span class="text-[10px] text-slate-400 font-mono ml-1.5">VLAN ${g.vlan || 10} • ${cablesCount} кабелей</span>
            </div>
          </div>
          <button type="button" class="px-2 py-1 text-slate-400 hover:text-red-400 hover:bg-red-950/60 rounded text-xs transition border border-transparent hover:border-red-900"
                  title="Удалить группу"
                  onclick="window.deleteGroupConfirm('${g.id}', event)">
            🗑 Удалить
          </button>
        </div>
      `;
    }).join('');
  }

  openAddGroupModal() {
    const modal = document.getElementById('group-modal');
    if (!modal) return;

    const activeRack = store.getActiveRack();
    const modalTitle = document.getElementById('group-modal-title');
    if (modalTitle) {
      modalTitle.textContent = `Новая группа соединений (${activeRack?.name || 'Стойка'})`;
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';

    this.renderGroupModalList();

    const form = document.getElementById('group-form');
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = document.getElementById('grp-name-input').value.trim();
      const color = document.getElementById('grp-color-input').value;
      const vlan = parseInt(document.getElementById('grp-vlan-input').value, 10) || 10;
      const desc = document.getElementById('grp-desc-input').value.trim();

      if (name) {
        store.addGroup(name, color, vlan, desc);
        document.getElementById('grp-name-input').value = '';
        this.renderGroupModalList();
        this.renderWorkplaceFilterBadges();
      }
    };
  }

  closeAddGroupModal() {
    const modal = document.getElementById('group-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.style.display = 'none';
    }
  }

  renderDetailsDrawer() {
    const drawer = document.getElementById('details-drawer');
    const content = document.getElementById('details-content');
    if (!drawer || !content) return;

    const sel = store.selectedEntity;
    if (!sel) {
      drawer.classList.add('translate-x-full');
      return;
    }

    drawer.classList.remove('translate-x-full');

    if (sel.type === 'device') {
      const loc = store.findDeviceLocation(sel.id);
      const rack = loc?.rack || store.getActiveRack();
      const dev = loc?.device || rack?.installedDevices.find(d => d.id === sel.id);
      if (!dev || !rack) return;
      const tpl = loc?.template || store.getTemplate(dev.templateId);
      const isInOtherRack = rack.id !== store.getActiveRack()?.id;
      const canMoveUp = store.findNearestFreeSlot(dev.id, 1) !== null;
      const canMoveDown = store.findNearestFreeSlot(dev.id, -1) !== null;

      const devCables = store.state.cables.filter(c => c.from.deviceId === dev.id || c.to.deviceId === dev.id);

      content.innerHTML = `
        <div class="space-y-4">
          <div class="border-b border-slate-800 pb-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">U${dev.uPosition} • ${tpl?.uHeight || 1}U</span>
                ${isInOtherRack ? `<span class="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700">${rack.name}</span>` : ''}
              </div>
              <div class="flex items-center gap-1" title="Переместить устройство (клавиши ↑ / ↓)">
                <button id="drawer-btn-move-up" type="button" ${canMoveUp ? '' : 'disabled'}
                        class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-mono disabled:opacity-35 disabled:pointer-events-none transition"
                        onclick="window.store.nudgeDevice('${dev.id}', 1)">↑</button>
                <button id="drawer-btn-move-down" type="button" ${canMoveDown ? '' : 'disabled'}
                        class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-mono disabled:opacity-35 disabled:pointer-events-none transition"
                        onclick="window.store.nudgeDevice('${dev.id}', -1)">↓</button>
              </div>
            </div>
            <h3 class="text-base font-bold text-slate-100 mt-1.5">${dev.customName}</h3>
            <p class="text-xs text-slate-400">${tpl?.vendor || 'Vendor'} • ${tpl?.category || 'Device'}</p>
          </div>

          <div class="flex gap-2 flex-wrap">
            ${isInOtherRack ? `
              <button class="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition"
                      onclick="window.store.setActiveRack('${rack.id}')">
                Открыть стойку ➔
              </button>
            ` : ''}
            ${tpl?.category === 'switch' || String(tpl?.vendor || '').toLowerCase().includes('eltex') || dev.cliConfig ? `
              <button class="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5"
                      onclick="window.openDeviceCli('${dev.id}')">
                <span>💻 Открыть CLI конфиг</span>
              </button>
            ` : ''}
            <button class="px-3 py-2 bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 rounded-lg text-xs transition"
                    title="Удалить из стойки (Delete)" onclick="store.removeDevice('${dev.id}')">
              Удалить
            </button>
          </div>

          <div class="space-y-3 bg-slate-800/60 p-3 rounded-lg border border-slate-700/80 text-xs">
            <div>
              <label class="block text-slate-400 text-[11px] mb-1">Имя устройства</label>
              <input type="text" id="drawer-dev-name" value="${dev.customName}" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs">
            </div>
            <div>
              <label class="block text-slate-400 text-[11px] mb-1">IP-адрес управления</label>
              <input type="text" id="drawer-dev-ip" value="${dev.ipAddress || ''}" placeholder="192.168.1.xxx" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs font-mono">
            </div>
            <div>
              <label class="block text-slate-400 text-[11px] mb-1">Заметки / Описание</label>
              <textarea id="drawer-dev-notes" rows="2" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs">${dev.notes || ''}</textarea>
            </div>
          </div>

          <div>
            <h4 class="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Подключения (${devCables.length})</span>
            </h4>
            <div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              ${devCables.map(c => {
                const grp = store.getGroup(c.groupId);
                const isFrom = c.from.deviceId === dev.id;
                const myPortId = isFrom ? c.from.portId : c.to.portId;
                const remoteEnd = isFrom ? c.to : c.from;
                const remoteLoc = store.findDeviceLocation(remoteEnd.deviceId);
                const interRack = store.isInterRackCable(c);
                const myPortName = getPortDisplayName(tpl, myPortId) || myPortId;
                const remotePortName = getPortDisplayName(remoteLoc?.template, remoteEnd.portId) || remoteEnd.portId;

                return `
                  <div class="bg-slate-900/90 border ${interRack ? 'border-indigo-700/70' : 'border-slate-800'} p-2 rounded text-xs flex items-center justify-between gap-2">
                    <button type="button" class="text-left flex-1 min-w-0 hover:brightness-125 transition"
                            onclick="window.store.setSelection({ type: 'cable', id: '${c.id}' })">
                      <div class="font-mono text-cyan-300 text-[11px] truncate">
                        ${myPortName} ➔ ${interRack && remoteLoc ? `[${remoteLoc.rack.name}] ` : ''}${remoteLoc?.device?.customName || 'Dev'}:${remotePortName}
                      </div>
                      <div class="flex items-center gap-2 mt-0.5">
                        ${grp ? `<span class="inline-block text-[10px]" style="color:${grp.color}">● ${grp.name}</span>` : '<span class="text-[10px] text-slate-500">Без группы</span>'}
                        <span class="text-[10px] font-mono text-slate-500">${c.lengthM}м</span>
                      </div>
                    </button>
                    <button class="text-red-400 hover:text-red-300 text-xs px-1.5 py-0.5 bg-red-950/60 rounded shrink-0"
                            onclick="store.removeCable('${c.id}')">✕</button>
                  </div>
                `;
              }).join('')}
              ${devCables.length === 0 ? '<div class="text-xs text-slate-500 italic">Нет подключенных кабелей</div>' : ''}
            </div>
          </div>
        </div>
      `;

      content.querySelector('#drawer-dev-name')?.addEventListener('input', (e) => {
        store.updateDevice(dev.id, { customName: e.target.value });
      });
      content.querySelector('#drawer-dev-ip')?.addEventListener('input', (e) => {
        store.updateDevice(dev.id, { ipAddress: e.target.value });
      });
      content.querySelector('#drawer-dev-notes')?.addEventListener('input', (e) => {
        store.updateDevice(dev.id, { notes: e.target.value });
      });

    } else if (sel.type === 'cable') {
      const cable = store.state.cables.find(c => c.id === sel.id);
      if (!cable) return;

      const activeRack = store.getActiveRack();
      const fromLoc = store.findDeviceLocation(cable.from.deviceId);
      const toLoc = store.findDeviceLocation(cable.to.deviceId);
      const interRack = store.isInterRackCable(cable);
      const fromPortName = getPortDisplayName(fromLoc?.template, cable.from.portId) || cable.from.portId;
      const toPortName = getPortDisplayName(toLoc?.template, cable.to.portId) || cable.to.portId;
      const remoteLoc = fromLoc?.rack?.id === activeRack?.id ? toLoc : fromLoc;
      const groups = store.getGroupsForCable(cable);
      const estimate = store.getCableLengthEstimate(cable);
      const isLengthAuto = cable.lengthAuto === true && !interRack;

      content.innerHTML = `
        <div class="space-y-4">
          <div class="border-b border-slate-800 pb-3">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-400 border border-blue-800">Патч-корд</span>
              ${interRack ? '<span class="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700">Межстоечный</span>' : ''}
            </div>
            <h3 class="text-base font-bold text-slate-100 mt-1">Параметры соединения</h3>
            <p class="text-xs font-mono text-cyan-300 mt-1 leading-relaxed">
              ${interRack && fromLoc ? `<span class="text-indigo-300">[${fromLoc.rack.name}]</span> ` : ''}${fromLoc?.device?.customName || 'Dev'}:${fromPortName}
              <br>⇄
              ${interRack && toLoc ? `<span class="text-indigo-300">[${toLoc.rack.name}]</span> ` : ''}${toLoc?.device?.customName || 'Dev'}:${toPortName}
            </p>
            ${interRack && remoteLoc?.rack ? `
              <button type="button" class="mt-2 px-2.5 py-1 bg-indigo-950 hover:bg-indigo-900 text-indigo-200 border border-indigo-700/80 rounded-lg text-[11px] font-medium transition"
                      onclick="window.store.setActiveRack('${remoteLoc.rack.id}'); window.store.setSelection({ type: 'cable', id: '${cable.id}' });">
                Перейти к ${remoteLoc.rack.name} ➔
              </button>
            ` : ''}
          </div>

          <div class="space-y-3 bg-slate-800/60 p-3 rounded-lg border border-slate-700/80 text-xs">
            <div>
              <label class="block text-slate-400 text-[11px] mb-1 font-semibold text-cyan-300">★ Группа рабочего места / Сервис</label>
              <select id="drawer-cable-group" class="w-full bg-slate-900 border border-cyan-700/80 rounded px-2.5 py-1.5 text-slate-100 text-xs focus:ring-2 focus:ring-cyan-400">
                <option value="">(Без группы / Инфраструктура)</option>
                ${groups.map(g => `
                  <option value="${g.id}" ${g.id === cable.groupId ? 'selected' : ''}>
                    ${g.name} (VLAN ${g.vlan})${interRack && g.rackName ? ` [${g.rackName}]` : ''}
                  </option>
                `).join('')}
              </select>
            </div>

            <div>
              <label class="block text-slate-400 text-[11px] mb-1">Метка / Назначение</label>
              <input type="text" id="drawer-cable-label" value="${cable.label || ''}" placeholder="Например: Uplink 10G Eltex" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs">
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-slate-400 text-[11px] mb-1">Цвет кабеля</label>
                <input type="color" id="drawer-cable-color" value="${cable.color || '#3b82f6'}" class="w-full h-8 bg-slate-900 border border-slate-700 rounded cursor-pointer p-0.5">
              </div>
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="text-slate-400 text-[11px]">Длина (м)</label>
                  ${!interRack ? `
                    <label class="flex items-center gap-1 text-[10px] text-cyan-300 cursor-pointer" title="Автоматический геометрический подбор длины">
                      <input type="checkbox" id="drawer-cable-length-auto" ${isLengthAuto ? 'checked' : ''} class="rounded border-slate-700 bg-slate-900 text-cyan-500">
                      <span>Авто</span>
                    </label>
                  ` : ''}
                </div>
                <input type="number" step="0.25" min="0.25" id="drawer-cable-len" value="${cable.lengthM || 0.5}" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs">
              </div>
            </div>

            <div id="drawer-cable-len-hint" class="text-[10px] font-mono text-slate-400 bg-slate-900/70 px-2 py-1 rounded border border-slate-800">
              ${interRack
                ? 'Межстоечная трасса — задаётся вручную'
                : `Расчёт (${store.getCableRoutingMode() === 'channels' ? 'Каналы' : 'Дуги'}): ~${estimate.rawMeters} м → стандарт ${estimate.lengthM} м`}
            </div>

            <div>
              <label class="block text-slate-400 text-[11px] mb-1">Тип кабеля</label>
              <select id="drawer-cable-type" class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 text-xs">
                <option value="Cat6 UTP" ${cable.type === 'Cat6 UTP' ? 'selected' : ''}>Медь Cat6 UTP</option>
                <option value="Cat6A STP" ${cable.type === 'Cat6A STP' ? 'selected' : ''}>Медь Cat6A STP Shielded</option>
                <option value="10G SFP+ DAC" ${cable.type === '10G SFP+ DAC' ? 'selected' : ''}>Прямое подключение 10G DAC</option>
                <option value="Fiber OM4" ${cable.type === 'Fiber OM4' ? 'selected' : ''}>Оптика Multi-mode OM4 (Aqua)</option>
                <option value="Fiber OS2" ${cable.type === 'Fiber OS2' ? 'selected' : ''}>Оптика Single-mode OS2 (Yellow)</option>
              </select>
            </div>
          </div>

          <button class="w-full py-2 bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-800 rounded-lg text-xs font-semibold transition"
                  onclick="store.removeCable('${cable.id}')">
            🗑 Удалить кабель
          </button>
        </div>
      `;

      content.querySelector('#drawer-cable-group')?.addEventListener('change', (e) => {
        const gid = e.target.value;
        const grp = store.getGroup(gid);
        const newColor = grp ? grp.color : cable.color;
        const colorInput = content.querySelector('#drawer-cable-color');
        if (colorInput) colorInput.value = newColor;
        store.updateCable(cable.id, {
          groupId: gid,
          color: newColor
        });
      });

      content.querySelector('#drawer-cable-label')?.addEventListener('input', (e) => {
        store.updateCable(cable.id, { label: e.target.value });
      });

      content.querySelector('#drawer-cable-color')?.addEventListener('input', (e) => {
        store.updateCable(cable.id, { color: e.target.value });
      });

      content.querySelector('#drawer-cable-length-auto')?.addEventListener('change', (e) => {
        const updated = store.setCableLengthAuto(cable.id, e.target.checked);
        const lenInput = content.querySelector('#drawer-cable-len');
        if (lenInput && updated) {
          lenInput.value = updated.lengthM;
        }
      });

      content.querySelector('#drawer-cable-len')?.addEventListener('input', (e) => {
        const autoChk = content.querySelector('#drawer-cable-length-auto');
        if (autoChk) autoChk.checked = false;
        store.updateCable(cable.id, {
          lengthM: parseFloat(e.target.value) || 0.5,
          lengthAuto: false
        });
      });

      content.querySelector('#drawer-cable-type')?.addEventListener('change', (e) => {
        store.updateCable(cable.id, { type: e.target.value });
      });
    } else if (sel.type === 'cable_bundle') {
      const bundleCables = (sel.cableIds || [])
        .map(cid => store.state.cables.find(c => c.id === cid))
        .filter(Boolean);
      const grp = sel.groupId ? store.getGroup(sel.groupId) : null;

      content.innerHTML = `
        <div class="space-y-4">
          <div class="border-b border-slate-800 pb-3">
            <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">Пучок кабелей • ×${bundleCables.length}</span>
            <h3 class="text-base font-bold text-slate-100 mt-1">${sel.fromName} ⇄ ${sel.toName}</h3>
            ${grp ? `<p class="text-xs mt-1" style="color:${grp.color}">● ${grp.name} (VLAN ${grp.vlan})</p>` : '<p class="text-xs text-slate-400 mt-1">Инфраструктурные / без группы</p>'}
          </div>

          <div class="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
            ${bundleCables.map(c => {
              const fromLoc = store.findDeviceLocation(c.from.deviceId);
              const toLoc = store.findDeviceLocation(c.to.deviceId);
              const p1 = getPortDisplayName(fromLoc?.template, c.from.portId) || c.from.portId;
              const p2 = getPortDisplayName(toLoc?.template, c.to.portId) || c.to.portId;
              return `
                <div class="bg-slate-900/90 border border-slate-800 p-2 rounded text-xs flex items-center justify-between gap-2">
                  <button type="button" class="text-left flex-1 min-w-0 hover:brightness-125 transition"
                          onclick="window.store.setSelection({ type: 'cable', id: '${c.id}' })">
                    <div class="font-mono text-cyan-300 text-[11px] truncate">
                      ${fromLoc?.device?.customName}:${p1} ➔ ${toLoc?.device?.customName}:${p2}
                    </div>
                    <div class="text-[10px] text-slate-400 font-mono mt-0.5">${c.type} • ${c.lengthM}м${c.label ? ` • ${c.label}` : ''}</div>
                  </button>
                  <button class="text-red-400 hover:text-red-300 text-xs px-1.5 py-0.5 bg-red-950/60 rounded shrink-0"
                          onclick="store.removeCable('${c.id}')">✕</button>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }
  }
}

function startApp() {
  if (!window.app) {
    window.app = new App();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
