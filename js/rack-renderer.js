/**
 * RackStudio - Interactive 19" Rack & Device Renderer
 */

import { store } from './state.js';

export class RackRenderer {
  constructor(rackContainer, cableRenderer) {
    this.container = rackContainer;
    this.cableRenderer = cableRenderer;

    this.initGlobalEvents();
  }

  initGlobalEvents() {
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container || e.target.classList.contains('rack-rail') || e.target.classList.contains('slot-empty')) {
        if (store.cableDraft) {
          store.cancelCableDraft();
        } else {
          store.clearSelection();
        }
      }
    });
  }

  render() {
    const rack = store.getActiveRack();
    if (!rack) {
      this.container.innerHTML = '<div class="text-center p-8 text-slate-500">Стойка не выбрана</div>';
      return;
    }

    const uHeight = rack.uHeight || 24;
    const activeFilter = store.getActiveGroupFilter();

    let html = `
      <div class="rack-cabinet shadow-2xl rounded-xl border border-slate-700/80 bg-gradient-to-b from-slate-900 via-[#15171c] to-[#0f1115] p-3 select-none">
        <!-- Rack Frame Header -->
        <div class="flex items-center justify-between px-3 py-2 border-b border-slate-800 text-xs text-slate-400 mb-2">
          <div class="flex items-center gap-2">
            <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
            <span class="font-bold text-slate-200 tracking-wide">${rack.name}</span>
            <span class="text-[11px] px-2 py-0.5 bg-slate-800 rounded text-slate-400 font-mono">${uHeight}U 19"</span>
          </div>
          <div class="flex items-center gap-3 text-[11px]">
            <span>Занято: <b class="text-cyan-400">${rack.installedDevices.length} устр.</b></span>
            <span>Мощность: <b class="text-amber-400">${this.calculateTotalPower(rack)} Вт</b></span>
            <div class="h-3.5 w-px bg-slate-800 mx-0.5"></div>
            <button class="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] border border-slate-700/80 transition flex items-center gap-1"
                    title="Настройки стойки"
                    onclick="window.openEditRackModal('${rack.id}')">
              <span>⚙</span>
              <span>Настройки</span>
            </button>
            ${store.getRacks().length > 1 ? `
            <button class="px-2 py-0.5 bg-red-950/60 hover:bg-red-900 text-red-300 rounded text-[11px] border border-red-800/80 transition flex items-center gap-1"
                    title="Удалить стойку"
                    onclick="window.deleteRackConfirm('${rack.id}')">
              <span>🗑</span>
              <span>Удалить стойку</span>
            </button>` : ''}
          </div>
        </div>

        <!-- The 19" Enclosure Column -->
        <div class="rack-frame relative flex bg-[#121418] border-x-4 border-slate-700/60 rounded overflow-hidden">
          
          <!-- Left Mounting Rail -->
          <div class="rack-rail rack-rail-left w-9 bg-gradient-to-r from-[#20242c] to-[#16181f] border-r border-slate-700/80 flex flex-col justify-between py-1 shrink-0 select-none">
            ${this.renderRailMarkers(uHeight, 'left')}
          </div>

          <!-- Main Units Slots Area -->
          <div class="rack-slots-column relative flex-1 flex flex-col justify-start bg-[#0d0f13]" id="rack-units-stack">
    `;

    for (let u = uHeight; u >= 1; u--) {
      const occupyingDevice = rack.installedDevices.find(d => {
        const tpl = store.getTemplate(d.templateId);
        const h = tpl?.uHeight || 1;
        return u >= d.uPosition && u < d.uPosition + h;
      });

      if (occupyingDevice) {
        const tpl = store.getTemplate(occupyingDevice.templateId);
        const h = tpl?.uHeight || 1;
        const topU = occupyingDevice.uPosition + h - 1;

        if (u === topU) {
          html += this.renderDeviceUnit(occupyingDevice, tpl, h, activeFilter);
        }
      } else {
        html += `
          <div class="slot-empty h-[54px] border-b border-dashed border-slate-800/80 flex items-center justify-between px-4 transition-colors hover:bg-slate-800/30 group"
               data-u="${u}">
            <span class="text-[10px] font-mono text-slate-600 group-hover:text-slate-400">U${u} [Пустой слот]</span>
            <button class="opacity-0 group-hover:opacity-100 text-[10px] text-cyan-400 bg-cyan-950/60 hover:bg-cyan-900 border border-cyan-800/60 px-2 py-0.5 rounded transition"
                    onclick="window.openDevicePaletteForUnit(${u})">
              + Установить
            </button>
          </div>
        `;
      }
    }

    html += `
          </div>

          <!-- Right Mounting Rail -->
          <div class="rack-rail rack-rail-right w-9 bg-gradient-to-l from-[#20242c] to-[#16181f] border-l border-slate-700/80 flex flex-col justify-between py-1 shrink-0 select-none">
            ${this.renderRailMarkers(uHeight, 'right')}
          </div>

        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this.attachInteractiveHandlers();

    requestAnimationFrame(() => {
      this.cableRenderer?.render();
    });
  }

  renderRailMarkers(uHeight, side) {
    let markers = '';
    for (let u = uHeight; u >= 1; u--) {
      markers += `
        <div class="h-[54px] flex items-center justify-between px-1.5 border-b border-slate-800/60 text-[10px] font-mono text-slate-500">
          ${side === 'left' ? `<span class="u-num text-slate-400 font-bold">${u}</span>` : ''}
          <div class="flex flex-col gap-1.5 items-center opacity-60">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-900 border border-slate-600 inline-block"></span>
            <span class="w-1.5 h-1.5 rounded-full bg-slate-900 border border-slate-600 inline-block"></span>
            <span class="w-1.5 h-1.5 rounded-full bg-slate-900 border border-slate-600 inline-block"></span>
          </div>
          ${side === 'right' ? `<span class="u-num text-slate-400 font-bold">${u}</span>` : ''}
        </div>
      `;
    }
    return markers;
  }

  renderDeviceUnit(device, template, uHeight, activeFilter) {
    const heightPx = uHeight * 54;
    const isSelected = store.selectedEntity?.id === device.id;

    let faceStyle = '';
    let themeClass = 'bg-[#1a1d24] text-slate-200';
    if (template?.style?.customImage) {
      faceStyle = `background-image: url('${template.style.customImage}'); background-size: 100% 100%; background-repeat: no-repeat;`;
      themeClass = 'custom-image-panel';
    } else if (template?.style?.theme === 'silver') {
      themeClass = 'bg-gradient-to-b from-[#e6ebf2] via-[#cfd6e0] to-[#b8c2d1] text-slate-900 shadow-inner';
    } else if (template?.style?.theme === 'dark-mesh') {
      themeClass = 'bg-[#15171c] border-y border-slate-700/60 text-slate-100';
    } else {
      themeClass = 'bg-gradient-to-b from-[#22252c] to-[#181a20] text-slate-100';
    }

    const portsHtml = (template?.ports || []).map(port => {
      return this.renderPortElement(device, port, activeFilter, template);
    }).join('');

    let decorationsHtml = '';
    if (!template?.style?.customImage && template?.decorations) {
      decorationsHtml = this.renderDecorations(template.decorations, template.style?.theme);
    }

    return `
      <div class="installed-device relative select-none cursor-pointer transition-all ${isSelected ? 'ring-2 ring-cyan-400 z-20' : 'hover:brightness-105 z-10'}"
           style="height: ${heightPx}px; ${faceStyle}"
           data-device-id="${device.id}"
           data-u="${device.uPosition}">
        
        <div class="w-full h-full relative flex items-center justify-between px-2 overflow-hidden ${themeClass} border-b border-slate-950/80">
          
          <div class="rack-ear left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-[#2c313a] to-[#1e2229] border-r border-slate-900/50 flex flex-col justify-around items-center py-1 absolute z-30">
            <span class="w-2 h-2 rounded-full bg-slate-950 border border-slate-500 shadow-inner"></span>
            ${uHeight > 1 ? '<span class="w-2 h-2 rounded-full bg-slate-950 border border-slate-500 shadow-inner"></span>' : ''}
          </div>

          ${decorationsHtml}

          <div class="absolute left-6 top-1 pointer-events-none flex items-center gap-1.5 opacity-80 z-20">
            <span class="text-[9px] font-mono px-1 py-0.2 rounded bg-slate-900/80 text-cyan-300 border border-cyan-800/40">U${device.uPosition}${uHeight > 1 ? `-${device.uPosition + uHeight - 1}` : ''}</span>
            <span class="text-[10px] font-semibold tracking-tight ${template?.style?.theme === 'silver' ? 'text-slate-800' : 'text-slate-300'} drop-shadow-sm truncate max-w-[140px]">${device.customName}</span>
          </div>

          <div class="ports-container absolute inset-0 z-20 pointer-events-auto">
            ${portsHtml}
          </div>

          <div class="rack-ear right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-[#2c313a] to-[#1e2229] border-l border-slate-900/50 flex flex-col justify-around items-center py-1 absolute z-30">
            <span class="w-2 h-2 rounded-full bg-slate-950 border border-slate-500 shadow-inner"></span>
            ${uHeight > 1 ? '<span class="w-2 h-2 rounded-full bg-slate-950 border border-slate-500 shadow-inner"></span>' : ''}
          </div>
        </div>
      </div>
    `;
  }

  isUpperRowPort(port, allPorts, deviceHeightPx = 54) {
    if (!Array.isArray(allPorts) || allPorts.length < 2) return false;
    return allPorts.some((other) => {
      if (!other || other === port || other.id === port.id) return false;
      const dx = Math.abs((other.x ?? 0) - (port.x ?? 0));
      if (dx > 4.5) return false;
      const dyPx = (((other.y ?? 0) - (port.y ?? 0)) / 100) * deviceHeightPx;
      return dyPx >= 10 && dyPx <= 44;
    });
  }

  renderPortElement(device, port, activeFilter, template = null) {
    const cable = store.getCableByPort(device.id, port.id);
    const isConnected = !!cable;
    const cableGroup = cable ? store.getGroup(cable.groupId) : null;
    
    let isMatch = true;
    if (activeFilter !== 'ALL') {
      isMatch = cable && cable.groupId === activeFilter;
    }

    let portColorClass = 'border-slate-600 bg-slate-900 text-slate-300';
    let glowStyle = '';

    if (isConnected && cableGroup) {
      if (isMatch) {
        glowStyle = `box-shadow: 0 0 8px ${cableGroup.color}, inset 0 0 4px ${cableGroup.color}; border-color: ${cableGroup.color};`;
      } else {
        glowStyle = 'opacity: 0.35; filter: grayscale(80%);';
      }
    } else if (isConnected && !cableGroup) {
      glowStyle = 'box-shadow: 0 0 6px #fff; border-color: #fff;';
    }

    let portIcon = '';
    let portSize = 'w-4 h-4 text-[8px]';

    if (port.type === 'sfp') {
      portSize = 'w-5 h-5 text-[8px]';
      portIcon = '<span class="text-[7px] text-amber-300/80">SFP</span>';
    } else if (port.type === 'console') {
      portIcon = '<span class="text-[7px] text-sky-400">C</span>';
    } else if (port.type === 'power') {
      portSize = 'w-5 h-4.5';
      portIcon = '<span class="text-[7px] text-red-400">⚡</span>';
    }

    const isSilver = !template?.style?.customImage && template?.style?.theme === 'silver';
    const isLabelAbove = this.isUpperRowPort(port, template?.ports || [], (template?.uHeight || 1) * 54);

    return `
      <div class="port-slot absolute flex items-center justify-center -translate-x-1/2 -translate-y-1/2 cursor-crosshair group transition-all hover:z-30"
           style="left: ${port.x}%; top: ${port.y}%;"
           data-device-id="${device.id}"
           data-port-id="${port.id}"
           data-port-name="${port.name}"
           data-port-type="${port.type}"
           data-label-pos="${isLabelAbove ? 'top' : 'bottom'}">
        
        <div class="port-jack ${portSize} rounded-[3px] border flex items-center justify-center relative ${portColorClass} transition-all duration-200 group-hover:scale-125 group-hover:border-cyan-400 group-hover:z-30"
             style="${glowStyle}">
          ${portIcon}

          ${isConnected ? `
            <span class="absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full ${isMatch ? 'bg-emerald-400 shadow-[0_0_4px_#34d399]' : 'bg-slate-500'}"></span>
          ` : ''}
        </div>

        <span class="port-num pointer-events-none absolute left-1/2 -translate-x-1/2 ${isLabelAbove ? 'bottom-full mb-[1px]' : 'top-full mt-[1px]'} text-[7px] font-mono ${isSilver ? 'text-slate-700 group-hover:text-cyan-700' : 'text-slate-400 group-hover:text-cyan-300'} leading-none whitespace-nowrap select-none z-10">${port.number || ''}</span>
      </div>
    `;
  }

  renderDecorations(decorations, theme) {
    let out = '';
    if (decorations.hasLcdScreen) {
      out += `
        <div class="lcd-screen absolute left-6 top-4 bottom-4 w-28 bg-[#0a0f1a] border border-cyan-800/60 rounded px-2 py-1 flex flex-col justify-center font-mono text-[9px] text-cyan-400 shadow-inner z-10">
          <div class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
            <span class="truncate font-semibold">${decorations.lcdText || 'SYSTEM OK'}</span>
          </div>
          ${decorations.lcdSub ? `<div class="text-[8px] text-slate-400 truncate">${decorations.lcdSub}</div>` : ''}
        </div>
      `;
    }

    if (decorations.hasPowerMeter) {
      out += `
        <div class="power-meter absolute left-6 top-3 bottom-3 w-36 bg-[#000] border border-red-900/60 rounded px-2 flex items-center justify-center font-mono text-[10px] text-emerald-400 tracking-wider shadow-inner z-10">
          ${decorations.meterText || '230V  4.2A'}
        </div>
      `;
    }

    if (decorations.hasDriveBays) {
      out += `
        <div class="drive-bays absolute left-6 top-2 bottom-2 w-52 grid grid-cols-4 gap-1 p-1 bg-slate-950/60 rounded border border-slate-800 z-10">
          ${Array.from({ length: 8 }, (_, i) => `
            <div class="bg-slate-900 border border-slate-700/80 rounded-sm flex items-center justify-between px-1 text-[7px] font-mono text-slate-500">
              <span>S${i}</span>
              <span class="w-1 h-1 rounded-full bg-emerald-500/80"></span>
            </div>
          `).join('')}
        </div>
      `;
    }

    if (decorations.hasLabelStrips) {
      out += `
        <div class="label-strip absolute inset-x-8 top-1 h-2 bg-slate-200/90 rounded-sm flex justify-around items-center px-2 text-[7px] font-mono text-slate-800 font-bold opacity-80 z-10">
          <span>PORTS 1 - 6</span>
          <span>PORTS 7 - 12</span>
          <span>PORTS 13 - 18</span>
          <span>PORTS 19 - 24</span>
        </div>
      `;
    }

    return out;
  }

  attachInteractiveHandlers() {
    const ports = this.container.querySelectorAll('.port-slot');
    ports.forEach(p => {
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        const deviceId = p.dataset.deviceId;
        const portId = p.dataset.portId;

        if (store.cableDraft) {
          store.finishCableDraft(deviceId, portId);
        } else {
          const existing = store.getCableByPort(deviceId, portId);
          if (existing) {
            store.setSelection({ type: 'cable', id: existing.id, data: existing });
          } else {
            store.startCableDraft(deviceId, portId, e.clientX, e.clientY);
          }
        }
      });
    });

    const devices = this.container.querySelectorAll('.installed-device');
    devices.forEach(d => {
      d.addEventListener('click', (e) => {
        if (e.target.closest('.port-slot')) return;
        const deviceId = d.dataset.deviceId;
        const dev = store.getActiveRack()?.installedDevices.find(item => item.id === deviceId);
        if (dev) {
          store.setSelection({ type: 'device', id: dev.id, data: dev });
        }
      });
    });
  }

  calculateTotalPower(rack) {
    return rack.installedDevices.reduce((sum, d) => {
      const tpl = store.getTemplate(d.templateId);
      return sum + (tpl?.powerW || 0);
    }, 0);
  }
}
