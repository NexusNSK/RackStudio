/**
 * RackStudio - Custom Device Template Builder
 * Allows users to upload a real front panel photo and visually place/configure ports
 * with grid snapping, coaxial row alignment, and interactive dragging.
 */

import { store } from './state.js?v=5';

export class TemplateBuilder {
  constructor(modalElement) {
    this.modal = modalElement;
    this.currentTemplate = this.getEmptyTemplate();
    this.selectedPortIndex = null;
    this.uploadedImageDataUrl = null;

    // Dragging state
    this.isDragging = false;
    this.draggedIndex = null;
    this.hasMovedDuringDrag = false;

    this.initEvents();
  }

  getEmptyTemplate() {
    return {
      name: 'Новый коммутатор',
      vendor: 'Custom',
      category: 'switch',
      uHeight: 1,
      powerW: 50,
      style: {
        theme: 'silver',
        customImage: null
      },
      ports: []
    };
  }

  getSnapSettings() {
    const snapRow = this.modal.querySelector('#builder-snap-row')?.value || '2rows';
    const snapX = parseFloat(this.modal.querySelector('#builder-snap-x')?.value ?? '1.0');
    const showGrid = this.modal.querySelector('#builder-toggle-grid')?.checked !== false;

    return { snapRow, snapX, showGrid };
  }

  applySnapping(rawXPercent, rawYPercent) {
    const { snapRow, snapX } = this.getSnapSettings();

    // Clamp inside usable panel area
    let x = Math.max(3, Math.min(97, rawXPercent));
    let y = Math.max(10, Math.min(90, rawYPercent));

    // Snap X to step
    if (snapX > 0) {
      x = Math.round(x / snapX) * snapX;
    }

    // Snap Y to row mode
    if (snapRow === '2rows') {
      y = rawYPercent < 50 ? 33 : 67;
    } else if (snapRow === '1row') {
      y = 50;
    } else if (snapX > 0) {
      y = Math.round(y / snapX) * snapX;
    }

    return {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2))
    };
  }

  initEvents() {
    this.modal.querySelector('#close-builder-modal')?.addEventListener('click', () => {
      this.close();
    });

    // Form inputs
    this.modal.querySelector('#builder-name')?.addEventListener('input', (e) => {
      this.currentTemplate.name = e.target.value;
    });

    this.modal.querySelector('#builder-vendor')?.addEventListener('input', (e) => {
      this.currentTemplate.vendor = e.target.value;
    });

    this.modal.querySelector('#builder-category')?.addEventListener('change', (e) => {
      this.currentTemplate.category = e.target.value;
    });

    this.modal.querySelector('#builder-u-height')?.addEventListener('change', (e) => {
      this.currentTemplate.uHeight = parseInt(e.target.value, 10) || 1;
      this.updateCanvasAspect();
      this.renderCanvas();
    });

    this.modal.querySelector('#builder-power')?.addEventListener('input', (e) => {
      this.currentTemplate.powerW = parseInt(e.target.value, 10) || 0;
    });

    this.modal.querySelector('#builder-theme-select')?.addEventListener('change', (e) => {
      this.currentTemplate.style.theme = e.target.value;
      if (!this.uploadedImageDataUrl) {
        this.renderCanvas();
      }
    });

    // Image upload handler
    const fileInput = this.modal.querySelector('#builder-image-input');
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        this.uploadedImageDataUrl = evt.target?.result;
        this.currentTemplate.style.customImage = this.uploadedImageDataUrl;
        this.renderCanvas();
      };
      reader.readAsDataURL(file);
    });

    this.modal.querySelector('#builder-clear-image-btn')?.addEventListener('click', () => {
      this.uploadedImageDataUrl = null;
      this.currentTemplate.style.customImage = null;
      if (fileInput) fileInput.value = '';
      this.renderCanvas();
    });

    // Grid and alignment setting changes
    this.modal.querySelector('#builder-snap-row')?.addEventListener('change', () => {
      this.renderCanvas();
    });

    this.modal.querySelector('#builder-snap-x')?.addEventListener('change', () => {
      this.renderCanvas();
    });

    this.modal.querySelector('#builder-toggle-grid')?.addEventListener('change', () => {
      this.renderCanvas();
    });

    // Alignment buttons
    this.modal.querySelector('#btn-align-2rows')?.addEventListener('click', () => {
      this.alignTwoRowsCoaxial();
    });

    this.modal.querySelector('#btn-align-1row')?.addEventListener('click', () => {
      this.alignOneRowCenter();
    });

    this.modal.querySelector('#btn-distribute-ports')?.addEventListener('click', () => {
      this.distributeEvenly();
    });

    // Canvas click & drag
    const canvas = this.modal.querySelector('#builder-canvas');
    
    canvas?.addEventListener('mousedown', (e) => {
      const portEl = e.target.closest('.builder-port-marker');
      if (portEl) {
        const idx = parseInt(portEl.dataset.index, 10);
        this.isDragging = true;
        this.draggedIndex = idx;
        this.hasMovedDuringDrag = false;
        this.selectPort(idx);
        e.stopPropagation();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging || this.draggedIndex === null || !canvas) return;

      this.hasMovedDuringDrag = true;
      const rect = canvas.getBoundingClientRect();
      const rawX = ((e.clientX - rect.left) / rect.width) * 100;
      const rawY = ((e.clientY - rect.top) / rect.height) * 100;

      const snapped = this.applySnapping(rawX, rawY);
      const port = this.currentTemplate.ports[this.draggedIndex];
      if (port) {
        port.x = snapped.x;
        port.y = snapped.y;

        // Fast update marker on DOM
        const marker = canvas.querySelector(`.builder-port-marker[data-index="${this.draggedIndex}"]`);
        if (marker) {
          marker.style.left = `${port.x}%`;
          marker.style.top = `${port.y}%`;
        }

        // Live update property panel
        const valX = this.modal.querySelector('#val-port-x');
        const rangeX = this.modal.querySelector('#prop-port-x');
        if (valX) valX.textContent = `${port.x}%`;
        if (rangeX) rangeX.value = port.x;

        const valY = this.modal.querySelector('#val-port-y');
        const rangeY = this.modal.querySelector('#prop-port-y');
        if (valY) valY.textContent = `${port.y}%`;
        if (rangeY) rangeY.value = port.y;
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.draggedIndex = null;
        if (this.hasMovedDuringDrag) {
          this.renderCanvas();
          this.renderPortProperties();
        }
      }
    });

    // Canvas click to add port
    canvas?.addEventListener('click', (e) => {
      if (this.hasMovedDuringDrag) {
        this.hasMovedDuringDrag = false;
        return;
      }

      if (e.target.closest('.builder-port-marker')) {
        return; // Selection handled in mousedown
      }

      const rect = canvas.getBoundingClientRect();
      const rawX = ((e.clientX - rect.left) / rect.width) * 100;
      const rawY = ((e.clientY - rect.top) / rect.height) * 100;

      const snapped = this.applySnapping(rawX, rawY);
      const defaultTypeEl = this.modal.querySelector('#builder-default-port-type');
      const defaultType = defaultTypeEl?.value || 'rj45';
      const portNum = this.currentTemplate.ports.length + 1;

      this.currentTemplate.ports.push({
        id: `p-${Date.now().toString().slice(-4)}-${portNum}`,
        number: portNum,
        name: `Port ${portNum}`,
        type: defaultType,
        speed: defaultType === 'sfp' ? '10G' : '1G',
        x: snapped.x,
        y: snapped.y
      });

      this.selectPort(this.currentTemplate.ports.length - 1);
      this.renderCanvas();
    });

    // Batch port generators
    this.modal.querySelector('#btn-gen-24rj45')?.addEventListener('click', () => {
      this.generate24Ports();
    });

    this.modal.querySelector('#btn-gen-16rj45')?.addEventListener('click', () => {
      this.generate16Ports();
    });

    this.modal.querySelector('#btn-gen-8rj45')?.addEventListener('click', () => {
      this.generate8Ports();
    });

    this.modal.querySelector('#btn-gen-4sfp')?.addEventListener('click', () => {
      this.generateSfpPorts(4);
    });

    this.modal.querySelector('#btn-clear-ports')?.addEventListener('click', () => {
      if (confirm('Удалить все расставленные порты?')) {
        this.currentTemplate.ports = [];
        this.selectedPortIndex = null;
        this.renderCanvas();
        this.renderPortProperties();
      }
    });

    // Save template button
    this.modal.querySelector('#btn-save-template')?.addEventListener('click', () => {
      this.saveTemplate();
    });
  }

  open() {
    this.currentTemplate = this.getEmptyTemplate();
    this.selectedPortIndex = null;
    this.uploadedImageDataUrl = null;

    const nameEl = this.modal.querySelector('#builder-name');
    if (nameEl) nameEl.value = this.currentTemplate.name;

    const vendorEl = this.modal.querySelector('#builder-vendor');
    if (vendorEl) vendorEl.value = this.currentTemplate.vendor;

    const categoryEl = this.modal.querySelector('#builder-category');
    if (categoryEl) categoryEl.value = this.currentTemplate.category;

    const uHeightEl = this.modal.querySelector('#builder-u-height');
    if (uHeightEl) uHeightEl.value = this.currentTemplate.uHeight;

    const powerEl = this.modal.querySelector('#builder-power');
    if (powerEl) powerEl.value = this.currentTemplate.powerW;

    this.updateCanvasAspect();
    this.renderCanvas();
    this.renderPortProperties();

    this.modal.classList.remove('hidden');
    this.modal.classList.add('flex');
  }

  close() {
    this.modal.classList.add('hidden');
    this.modal.classList.remove('flex');
  }

  updateCanvasAspect() {
    const canvas = this.modal.querySelector('#builder-canvas');
    if (!canvas) return;
    const u = this.currentTemplate.uHeight || 1;
    canvas.style.height = `${u * 70}px`;
  }

  renderCanvas() {
    const canvas = this.modal.querySelector('#builder-canvas');
    if (!canvas) return;

    const { showGrid, snapRow } = this.getSnapSettings();

    // Canvas background
    if (this.uploadedImageDataUrl) {
      canvas.style.backgroundImage = `url('${this.uploadedImageDataUrl}')`;
      canvas.style.backgroundSize = '100% 100%';
      canvas.style.backgroundRepeat = 'no-repeat';
      canvas.className = 'relative w-full border-2 border-dashed border-cyan-500/50 rounded overflow-hidden select-none cursor-crosshair shadow-2xl';
    } else {
      canvas.style.backgroundImage = 'none';
      if (this.currentTemplate.style.theme === 'silver') {
        canvas.className = 'relative w-full bg-gradient-to-b from-[#e6ebf2] via-[#cfd6e0] to-[#b8c2d1] border border-slate-600 rounded overflow-hidden select-none cursor-crosshair shadow-2xl';
      } else if (this.currentTemplate.style.theme === 'dark-mesh') {
        canvas.className = 'relative w-full bg-[#15171c] border border-slate-700 rounded overflow-hidden select-none cursor-crosshair shadow-2xl';
      } else {
        canvas.className = 'relative w-full bg-gradient-to-b from-[#22252c] to-[#16181f] border border-slate-700 rounded overflow-hidden select-none cursor-crosshair shadow-2xl';
      }
    }

    let html = `
      <!-- Left Rack Ear -->
      <div class="absolute left-0 top-0 bottom-0 w-4 bg-[#262930] border-r border-slate-800 flex flex-col justify-around items-center py-1 pointer-events-none z-10">
        <span class="w-2 h-2 rounded-full bg-black border border-slate-500"></span>
      </div>
      <!-- Right Rack Ear -->
      <div class="absolute right-0 top-0 bottom-0 w-4 bg-[#262930] border-l border-slate-800 flex flex-col justify-around items-center py-1 pointer-events-none z-10">
        <span class="w-2 h-2 rounded-full bg-black border border-slate-500"></span>
      </div>
    `;

    // Visual Guides & Grid Overlay
    if (showGrid) {
      html += `
        <!-- Alignment Guide Lines -->
        <div class="absolute inset-x-4 top-[33%] border-t border-dashed border-cyan-500/40 pointer-events-none z-10 flex items-center justify-between px-2">
          <span class="text-[8px] font-mono text-cyan-400 bg-black/60 px-1 rounded -translate-y-1/2">Верхний ряд (33%)</span>
        </div>
        <div class="absolute inset-x-4 top-[50%] border-t border-dashed border-emerald-500/40 pointer-events-none z-10 flex items-center justify-between px-2">
          <span class="text-[8px] font-mono text-emerald-400 bg-black/60 px-1 rounded -translate-y-1/2">Ось центра (50%)</span>
        </div>
        <div class="absolute inset-x-4 top-[67%] border-t border-dashed border-cyan-500/40 pointer-events-none z-10 flex items-center justify-between px-2">
          <span class="text-[8px] font-mono text-cyan-400 bg-black/60 px-1 rounded -translate-y-1/2">Нижний ряд (67%)</span>
        </div>
      `;
    }

    // Render placed ports
    this.currentTemplate.ports.forEach((p, idx) => {
      const isSelected = this.selectedPortIndex === idx;
      let badgeColor = 'bg-slate-900 border-slate-500 text-slate-300';
      if (p.type === 'sfp') badgeColor = 'bg-amber-950 border-amber-600 text-amber-300';
      if (p.type === 'console') badgeColor = 'bg-sky-950 border-sky-600 text-sky-300';
      if (p.type === 'power') badgeColor = 'bg-red-950 border-red-600 text-red-300';

      html += `
        <div class="builder-port-marker absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center cursor-grab active:cursor-grabbing transition-transform ${isSelected ? 'scale-125 z-30' : 'hover:scale-110 z-20'}"
             style="left: ${p.x}%; top: ${p.y}%;"
             data-index="${idx}"
             title="Перетащите для перемещения (Port #${p.number})">
          <div class="w-4 h-4 rounded border ${badgeColor} flex items-center justify-center text-[7px] font-mono shadow-md ${isSelected ? 'ring-2 ring-cyan-400' : ''}">
            ${p.type === 'sfp' ? 'S' : p.type === 'power' ? '⚡' : p.number}
          </div>
          <span class="text-[7px] font-mono bg-black/85 px-1 rounded text-cyan-200 mt-0.5 leading-none select-none">${p.name}</span>
        </div>
      `;
    });

    canvas.innerHTML = html;
  }

  selectPort(index) {
    this.selectedPortIndex = index;
    this.renderCanvas();
    this.renderPortProperties();
  }

  renderPortProperties() {
    const container = this.modal.querySelector('#builder-port-props');
    if (!container) return;

    if (this.selectedPortIndex === null || !this.currentTemplate.ports[this.selectedPortIndex]) {
      container.innerHTML = `
        <div class="text-xs text-slate-500 italic p-4 text-center border border-dashed border-slate-800 rounded">
          Кликните по панели, чтобы поставить порт, или перетащите существующий порт мышкой.
        </div>
      `;
      return;
    }

    const port = this.currentTemplate.ports[this.selectedPortIndex];

    container.innerHTML = `
      <div class="bg-slate-800/80 border border-slate-700/80 p-3 rounded-lg text-xs space-y-3">
        <div class="flex items-center justify-between border-b border-slate-700 pb-2">
          <div class="flex items-center gap-2">
            <span class="font-bold text-cyan-300">Настройка порта #${port.number}</span>
            <span class="text-[10px] text-slate-400 font-mono">(X: ${port.x}%, Y: ${port.y}%)</span>
          </div>
          <button class="text-red-400 hover:text-red-300 text-xs px-2 py-0.5 bg-red-950/60 rounded border border-red-900" id="btn-delete-active-port">Удалить порт</button>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-400 text-[10px] mb-1">Имя порта</label>
            <input type="text" id="prop-port-name" value="${port.name}" class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs">
          </div>
          <div>
            <label class="block text-slate-400 text-[10px] mb-1">Номер</label>
            <input type="number" id="prop-port-num" value="${port.number}" class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs">
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-400 text-[10px] mb-1">Тип разъёма</label>
            <select id="prop-port-type" class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs">
              <option value="rj45" ${port.type === 'rj45' ? 'selected' : ''}>RJ45 (Ethernet)</option>
              <option value="sfp" ${port.type === 'sfp' ? 'selected' : ''}>SFP / SFP+ (10G)</option>
              <option value="console" ${port.type === 'console' ? 'selected' : ''}>Console (Управление)</option>
              <option value="power" ${port.type === 'power' ? 'selected' : ''}>Питание (C13/C14)</option>
            </select>
          </div>
          <div>
            <label class="block text-slate-400 text-[10px] mb-1">Скорость / Характеристика</label>
            <input type="text" id="prop-port-speed" value="${port.speed || '1G'}" class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs">
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 pt-2 border-t border-slate-700/60 text-xs">
          <div>
            <div class="flex justify-between items-center mb-1">
              <label class="text-slate-400 text-[10px]">Координата X (%)</label>
              <span class="text-[10px] font-mono text-cyan-300" id="val-port-x">${port.x}%</span>
            </div>
            <input type="range" id="prop-port-x" min="3" max="97" step="0.5" value="${port.x}" class="w-full accent-cyan-400 cursor-pointer">
          </div>
          <div>
            <div class="flex justify-between items-center mb-1">
              <label class="text-slate-400 text-[10px]">Координата Y (%)</label>
              <span class="text-[10px] font-mono text-cyan-300" id="val-port-y">${port.y}%</span>
            </div>
            <input type="range" id="prop-port-y" min="10" max="90" step="1" value="${port.y}" class="w-full accent-cyan-400 cursor-pointer">
          </div>
        </div>
      </div>
    `;

    container.querySelector('#prop-port-name')?.addEventListener('input', (e) => {
      port.name = e.target.value;
      this.renderCanvas();
    });

    container.querySelector('#prop-port-num')?.addEventListener('input', (e) => {
      port.number = parseInt(e.target.value, 10) || 1;
      this.renderCanvas();
    });

    container.querySelector('#prop-port-type')?.addEventListener('change', (e) => {
      port.type = e.target.value;
      this.renderCanvas();
    });

    container.querySelector('#prop-port-speed')?.addEventListener('input', (e) => {
      port.speed = e.target.value;
    });

    container.querySelector('#prop-port-x')?.addEventListener('input', (e) => {
      port.x = parseFloat(e.target.value);
      const valEl = container.querySelector('#val-port-x');
      if (valEl) valEl.textContent = `${port.x}%`;
      this.renderCanvas();
    });

    container.querySelector('#prop-port-y')?.addEventListener('input', (e) => {
      port.y = parseFloat(e.target.value);
      const valEl = container.querySelector('#val-port-y');
      if (valEl) valEl.textContent = `${port.y}%`;
      this.renderCanvas();
    });

    container.querySelector('#btn-delete-active-port')?.addEventListener('click', () => {
      this.currentTemplate.ports.splice(this.selectedPortIndex, 1);
      this.selectedPortIndex = null;
      this.renderCanvas();
      this.renderPortProperties();
    });
  }

  // --- Automatic Alignment & Coaxial Functions ---

  alignTwoRowsCoaxial() {
    if (this.currentTemplate.ports.length === 0) return;

    // Sort all ports by X position
    const sorted = [...this.currentTemplate.ports].sort((a, b) => a.x - b.x);

    // Pair into columns of 2: top (33%) and bottom (67%)
    for (let i = 0; i < sorted.length; i += 2) {
      const topPort = sorted[i];
      const bottomPort = sorted[i + 1];

      topPort.y = 33;

      if (bottomPort) {
        bottomPort.y = 67;
        // Strictly vertical coaxial alignment: bottom port gets the EXACT same X!
        bottomPort.x = topPort.x;
      }
    }

    this.renderCanvas();
    this.renderPortProperties();
  }

  alignOneRowCenter() {
    this.currentTemplate.ports.forEach(p => {
      p.y = 50;
    });
    this.renderCanvas();
    this.renderPortProperties();
  }

  distributeEvenly() {
    const ports = this.currentTemplate.ports;
    if (ports.length < 2) return;

    const snapRow = this.modal.querySelector('#builder-snap-row')?.value || '2rows';

    if (snapRow === '2rows') {
      // Group into pairs (columns) sorted by X
      const sorted = [...ports].sort((a, b) => a.x - b.x);
      const columns = [];
      for (let i = 0; i < sorted.length; i += 2) {
        columns.push([sorted[i], sorted[i + 1]].filter(Boolean));
      }
      if (columns.length < 2) return;

      const startX = columns[0][0].x;
      const endX = columns[columns.length - 1][0].x;
      const step = (endX - startX) / (columns.length - 1);

      columns.forEach((col, colIdx) => {
        const colX = Number((startX + colIdx * step).toFixed(2));
        col.forEach(p => {
          p.x = colX;
        });
      });
    } else {
      // 1 row distribution
      const sorted = [...ports].sort((a, b) => a.x - b.x);
      const startX = sorted[0].x;
      const endX = sorted[sorted.length - 1].x;
      const step = (endX - startX) / (sorted.length - 1);

      sorted.forEach((p, idx) => {
        p.x = Number((startX + idx * step).toFixed(2));
      });
    }

    this.renderCanvas();
    this.renderPortProperties();
  }

  // --- Preset Generators ---

  generate24Ports() {
    const startX = 24;
    const colSpacing = 2.4;
    const ports = [];

    for (let i = 0; i < 24; i++) {
      const col = Math.floor(i / 2);
      const row = i % 2; // 0 = top, 1 = bottom
      ports.push({
        id: `p-${i + 1}`,
        number: i + 1,
        name: `Port ${i + 1}`,
        type: 'rj45',
        speed: '1G/PoE',
        x: Number((startX + col * colSpacing).toFixed(2)),
        y: row === 0 ? 33 : 67
      });
    }

    this.currentTemplate.ports = ports;
    this.selectedPortIndex = 0;
    this.renderCanvas();
    this.renderPortProperties();
  }

  generate16Ports() {
    const startX = 28;
    const colSpacing = 3.2;
    const ports = [];

    for (let i = 0; i < 16; i++) {
      const col = Math.floor(i / 2);
      const row = i % 2;
      ports.push({
        id: `p-${i + 1}`,
        number: i + 1,
        name: `Port ${i + 1}`,
        type: 'rj45',
        speed: '1G/PoE',
        x: Number((startX + col * colSpacing).toFixed(2)),
        y: row === 0 ? 33 : 67
      });
    }

    this.currentTemplate.ports = ports;
    this.selectedPortIndex = 0;
    this.renderCanvas();
    this.renderPortProperties();
  }

  generate8Ports() {
    const startX = 30;
    const colSpacing = 4.8;
    const ports = [];

    for (let i = 0; i < 8; i++) {
      ports.push({
        id: `p-${i + 1}`,
        number: i + 1,
        name: `Port ${i + 1}`,
        type: 'rj45',
        speed: '1G',
        x: Number((startX + i * colSpacing).toFixed(2)),
        y: 50
      });
    }

    this.currentTemplate.ports = ports;
    this.selectedPortIndex = 0;
    this.renderCanvas();
    this.renderPortProperties();
  }

  generateSfpPorts(count = 4) {
    const existing = this.currentTemplate.ports;
    const startNum = existing.length + 1;
    const startX = 84;

    for (let i = 0; i < count; i++) {
      existing.push({
        id: `sfp-${i + 1}`,
        number: startNum + i,
        name: `SFP+ ${i + 1}`,
        type: 'sfp',
        speed: '10G',
        x: Number((startX + i * 3.4).toFixed(2)),
        y: 50
      });
    }

    this.renderCanvas();
    this.renderPortProperties();
  }

  saveTemplate() {
    if (!this.currentTemplate.name.trim()) {
      alert('Укажите название шаблона устройства');
      return;
    }

    const tpl = store.addTemplate(this.currentTemplate);
    alert(`Шаблон "${tpl.name}" успешно сохранен в библиотеку! Теперь его можно установить в любую стойку через "+ Устройство".`);
    this.close();
  }
}
