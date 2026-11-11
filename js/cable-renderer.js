/**
 * RackStudio - Cable SVG Routing & Interaction Engine
 */

import { store } from './state.js';

export class CableRenderer {
  constructor(svgContainer, rackElement) {
    this.svg = svgContainer;
    this.rackEl = rackElement;
    this.activeHoverCableId = null;

    this.initEvents();
  }

  initEvents() {
    window.addEventListener('mousemove', (e) => {
      if (store.cableDraft) {
        store.updateCableDraft(e.clientX, e.clientY);
        this.renderDraft();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && store.cableDraft) {
        store.cancelCableDraft();
        this.render();
      }
    });

    // Hover Spotlight: подсветка кабелей при наведении на любой порт устройства
    this.rackEl.addEventListener('mouseover', (e) => {
      if (store.cableDraft) return;
      const portEl = e.target.closest('[data-port-id][data-device-id]');
      if (!portEl) return;

      const key = `${portEl.dataset.deviceId}:${portEl.dataset.portId}`;
      this.applyPortFocus(key);
    });

    this.rackEl.addEventListener('mouseout', (e) => {
      const portEl = e.target.closest('[data-port-id][data-device-id]');
      if (!portEl) return;
      if (e.relatedTarget && portEl.contains(e.relatedTarget)) return;
      this.clearFocus();
    });

    const ro = new ResizeObserver(() => {
      this.render();
    });
    ro.observe(this.rackEl);
  }

  applyPortFocus(portKey) {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (!cablesLayer) return;

    const groups = cablesLayer.querySelectorAll('.cable-group');
    let matchedAny = false;

    groups.forEach((g) => {
      if (g.dataset.fromKey === portKey || g.dataset.toKey === portKey) {
        g.classList.add('is-focused');
        matchedAny = true;

        const peerKey = g.dataset.fromKey === portKey ? g.dataset.toKey : g.dataset.fromKey;
        const [peerDevId, peerPortId] = peerKey.split(':');
        const peerEl = this.rackEl.querySelector(`[data-device-id="${peerDevId}"][data-port-id="${peerPortId}"]`);
        if (peerEl) peerEl.classList.add('port-cable-hover');
      } else {
        g.classList.remove('is-focused');
      }
    });

    if (matchedAny) {
      cablesLayer.classList.add('cables-has-focus');
    }
  }

  clearFocus() {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (cablesLayer) {
      cablesLayer.classList.remove('cables-has-focus');
      cablesLayer.querySelectorAll('.cable-group.is-focused').forEach(g => g.classList.remove('is-focused'));
    }
    this.rackEl.querySelectorAll('.port-cable-hover').forEach(el => el.classList.remove('port-cable-hover'));
  }

  getPortCoordinates(deviceId, portId) {
    const portSlot = this.rackEl.querySelector(`[data-device-id="${deviceId}"][data-port-id="${portId}"]`);
    if (!portSlot) return null;

    const jackEl = portSlot.querySelector('.port-jack') || portSlot;
    const jackRect = jackEl.getBoundingClientRect();
    const svgRect = this.svg.getBoundingClientRect();

    return {
      x: jackRect.left + jackRect.width / 2 - svgRect.left,
      y: jackRect.top + jackRect.height / 2 - svgRect.top,
      element: portSlot
    };
  }

  getRackBounds() {
    const rackRect = this.rackEl.getBoundingClientRect();
    const svgRect = this.svg.getBoundingClientRect();
    const left = rackRect.left - svgRect.left;
    const right = rackRect.right - svgRect.left;
    return {
      left,
      right,
      centerX: (left + right) / 2
    };
  }

  generateArcPath(p1, p2, cableIndex = 0) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const verticalDistance = Math.abs(dy);
    const isAdjacent = verticalDistance < 80;

    let slack;
    let cx1, cy1, cx2, cy2;

    if (isAdjacent) {
      slack = 36 + (cableIndex % 5) * 4;
      cx1 = p1.x + dx * 0.15;
      cy1 = p1.y + slack;
      cx2 = p2.x - dx * 0.15;
      cy2 = p2.y + slack;
    } else {
      slack = Math.min(95, Math.max(45, verticalDistance * 0.25)) + (cableIndex % 4) * 5;
      if (dy > 0) {
        cx1 = p1.x + dx * 0.2;
        cy1 = p1.y + slack;
        cx2 = p2.x - dx * 0.2;
        cy2 = p2.y - slack * 0.5;
      } else {
        cx1 = p1.x + dx * 0.2;
        cy1 = p1.y - slack * 0.5;
        cx2 = p2.x - dx * 0.2;
        cy2 = p2.y + slack;
      }
    }

    return `M ${p1.x.toFixed(1)},${p1.y.toFixed(1)} C ${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }

  generateChannelPath(p1, p2, cableIndex = 0, channelState = null, rackBounds = null) {
    const verticalDistance = Math.abs(p2.y - p1.y);
    // Короткие соединения (соседние юниты или на одном устройстве) рисуем компактной дугой
    if (verticalDistance <= 85 || !rackBounds) {
      return this.generateArcPath(p1, p2, cableIndex);
    }

    const avgX = (p1.x + p2.x) / 2;
    const side = avgX < rackBounds.centerX ? -1 : 1; // -1 = левый канал, +1 = правый канал

    let lane = 0;
    if (channelState) {
      if (side === -1) {
        lane = channelState.leftLane % 10;
        channelState.leftLane++;
      } else {
        lane = channelState.rightLane % 10;
        channelState.rightLane++;
      }
    }

    const laneOffset = lane * 4.5;
    const channelX = side === -1
      ? Math.min(rackBounds.left - 14, p1.x - 26, p2.x - 26) - laneOffset
      : Math.max(rackBounds.right + 14, p1.x + 26, p2.x + 26) + laneOffset;

    const dropOffset = 14 + (lane % 4) * 3;
    const y1Out = p1.y + dropOffset;
    const y2Out = p2.y + dropOffset;
    const dirY = y2Out > y1Out ? 1 : -1;
    const r = 10;

    return [
      `M ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`,
      `Q ${p1.x.toFixed(1)},${y1Out.toFixed(1)} ${(p1.x + side * r).toFixed(1)},${y1Out.toFixed(1)}`,
      `L ${(channelX - side * r).toFixed(1)},${y1Out.toFixed(1)}`,
      `Q ${channelX.toFixed(1)},${y1Out.toFixed(1)} ${channelX.toFixed(1)},${(y1Out + dirY * r).toFixed(1)}`,
      `L ${channelX.toFixed(1)},${(y2Out - dirY * r).toFixed(1)}`,
      `Q ${channelX.toFixed(1)},${y2Out.toFixed(1)} ${(channelX - side * r).toFixed(1)},${y2Out.toFixed(1)}`,
      `L ${(p2.x + side * r).toFixed(1)},${y2Out.toFixed(1)}`,
      `Q ${p2.x.toFixed(1)},${y2Out.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    ].join(' ');
  }

  generatePath(p1, p2, cableIndex = 0, channelState = null, rackBounds = null) {
    const mode = store.getCableRoutingMode();
    if (mode === 'channels') {
      return this.generateChannelPath(p1, p2, cableIndex, channelState, rackBounds);
    }
    return this.generateArcPath(p1, p2, cableIndex);
  }

  render() {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (!cablesLayer) return;
    cablesLayer.innerHTML = '';
    cablesLayer.classList.remove('cables-has-focus');

    const cables = store.getCablesForActiveRack();
    const activeFilter = store.getActiveGroupFilter();
    const dimInactive = store.state.dimInactiveCables;
    const selectedEntity = store.selectedEntity;
    const isDeviceSelected = selectedEntity?.type === 'device';
    const selectedDeviceId = isDeviceSelected ? selectedEntity.id : null;

    const rackBounds = this.getRackBounds();
    const channelState = { leftLane: 0, rightLane: 0 };

    cables.forEach((cable, index) => {
      const p1 = this.getPortCoordinates(cable.from.deviceId, cable.from.portId);
      const p2 = this.getPortCoordinates(cable.to.deviceId, cable.to.portId);

      if (!p1 || !p2) return;

      const isGroupMatch = (activeFilter === 'ALL') || (cable.groupId === activeFilter);
      const isSelected = selectedEntity?.type === 'cable' && selectedEntity.id === cable.id;
      const isDeviceMatch = !isDeviceSelected || (cable.from.deviceId === selectedDeviceId || cable.to.deviceId === selectedDeviceId);

      if (!isGroupMatch && !dimInactive) {
        return;
      }

      const isEffectiveActive = isGroupMatch && isDeviceMatch;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `cable-group ${isEffectiveActive ? 'active-group' : 'inactive-group'} ${isSelected ? 'selected' : ''}`);
      g.dataset.cableId = cable.id;
      g.dataset.fromKey = `${cable.from.deviceId}:${cable.from.portId}`;
      g.dataset.toKey = `${cable.to.deviceId}:${cable.to.portId}`;

      const pathData = this.generatePath(p1, p2, index, channelState, rackBounds);

      const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitPath.setAttribute('d', pathData);
      hitPath.setAttribute('fill', 'none');
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '16');
      hitPath.style.cursor = 'pointer';

      // Тёмная подложка («эффект моста») для чёткого разделения пересекающихся кабелей
      const casingPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      casingPath.setAttribute('d', pathData);
      casingPath.setAttribute('fill', 'none');
      casingPath.setAttribute('stroke', '#0b0e14');
      casingPath.setAttribute('stroke-width', isSelected ? '7' : '4.5');
      casingPath.setAttribute('stroke-linecap', 'round');
      casingPath.setAttribute('stroke-linejoin', 'round');
      casingPath.setAttribute('stroke-opacity', isEffectiveActive ? '0.92' : '0.12');
      casingPath.setAttribute('class', 'cable-casing');

      // Мягкое свечение — видно только при наведении, выборе или явном фильтре
      const shadowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shadowPath.setAttribute('d', pathData);
      shadowPath.setAttribute('fill', 'none');
      shadowPath.setAttribute('stroke', isEffectiveActive ? cable.color : '#444');
      shadowPath.setAttribute('stroke-width', isSelected ? '8' : '6');
      shadowPath.setAttribute('stroke-opacity', isSelected ? '0.55' : '0');
      shadowPath.setAttribute('class', 'cable-shadow');

      const corePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      corePath.setAttribute('d', pathData);
      corePath.setAttribute('fill', 'none');
      corePath.setAttribute('stroke', cable.color || '#3b82f6');
      corePath.setAttribute('stroke-linecap', 'round');
      corePath.setAttribute('stroke-linejoin', 'round');
      corePath.setAttribute('stroke-width', isSelected ? '4' : (isEffectiveActive && activeFilter !== 'ALL') ? '2.8' : '2.2');

      if (!isEffectiveActive) {
        corePath.setAttribute('stroke-opacity', '0.1');
        if (!isGroupMatch) {
          corePath.setAttribute('stroke', '#666666');
        }
      } else {
        corePath.setAttribute('stroke-opacity', '0.9');
      }
      corePath.setAttribute('class', 'cable-core');

      const boot1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      boot1.setAttribute('cx', p1.x);
      boot1.setAttribute('cy', p1.y);
      boot1.setAttribute('r', isEffectiveActive ? '3.2' : '2');
      boot1.setAttribute('fill', cable.color);
      boot1.setAttribute('opacity', isEffectiveActive ? '1' : '0.18');

      const boot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      boot2.setAttribute('cx', p2.x);
      boot2.setAttribute('cy', p2.y);
      boot2.setAttribute('r', isEffectiveActive ? '3.2' : '2');
      boot2.setAttribute('fill', cable.color);
      boot2.setAttribute('opacity', isEffectiveActive ? '1' : '0.18');

      g.appendChild(casingPath);
      g.appendChild(shadowPath);
      g.appendChild(corePath);
      g.appendChild(boot1);
      g.appendChild(boot2);
      g.appendChild(hitPath);

      hitPath.addEventListener('click', (e) => {
        e.stopPropagation();
        store.setSelection({ type: 'cable', id: cable.id, data: cable });
      });

      hitPath.addEventListener('mouseenter', () => {
        this.activeHoverCableId = cable.id;
        cablesLayer.classList.add('cables-has-focus');
        g.classList.add('is-focused');
        p1.element?.classList.add('port-cable-hover');
        p2.element?.classList.add('port-cable-hover');
        this.showTooltip(cable, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 + 20);
      });

      hitPath.addEventListener('mouseleave', () => {
        this.activeHoverCableId = null;
        cablesLayer.classList.remove('cables-has-focus');
        g.classList.remove('is-focused');
        p1.element?.classList.remove('port-cable-hover');
        p2.element?.classList.remove('port-cable-hover');
        this.hideTooltip();
      });

      cablesLayer.appendChild(g);
    });

    this.renderDraft();
  }

  renderDraft() {
    const draftLayer = this.svg.querySelector('#draft-layer');
    if (!draftLayer) return;
    draftLayer.innerHTML = '';

    if (!store.cableDraft) return;

    const p1 = this.getPortCoordinates(store.cableDraft.deviceId, store.cableDraft.portId);
    if (!p1) return;

    const svgRect = this.svg.getBoundingClientRect();
    const p2 = {
      x: store.cableDraft.clientX - svgRect.left,
      y: store.cableDraft.clientY - svgRect.top
    };

    // Для перетягивания кабеля курсором всегда используем прямую живую дугу
    const pathData = this.generateArcPath(p1, p2, 0);

    const activeGroupId = store.getActiveGroupFilter();
    const activeGroup = activeGroupId !== 'ALL' ? store.getGroup(activeGroupId) : null;
    const draftColor = activeGroup?.color || '#00d2ff';

    const draftPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    draftPath.setAttribute('d', pathData);
    draftPath.setAttribute('fill', 'none');
    draftPath.setAttribute('stroke', draftColor);
    draftPath.setAttribute('stroke-width', '3');
    draftPath.setAttribute('stroke-dasharray', '6 4');
    draftPath.setAttribute('class', 'animate-pulse');

    const startCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    startCircle.setAttribute('cx', p1.x);
    startCircle.setAttribute('cy', p1.y);
    startCircle.setAttribute('r', '5');
    startCircle.setAttribute('fill', draftColor);

    const endCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    endCircle.setAttribute('cx', p2.x);
    endCircle.setAttribute('cy', p2.y);
    endCircle.setAttribute('r', '4');
    endCircle.setAttribute('fill', draftColor);
    draftLayer.appendChild(draftPath);
    draftLayer.appendChild(startCircle);
    draftLayer.appendChild(endCircle);
  }

  showTooltip(cable, x, y) {
    let tip = document.getElementById('cable-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'cable-tooltip';
      tip.className = 'fixed z-50 pointer-events-none px-3 py-2 bg-slate-900/95 backdrop-blur border border-slate-700 text-xs rounded-lg shadow-xl text-slate-200 transition-opacity';
      document.body.appendChild(tip);
    }

    const grp = store.getGroup(cable.groupId);
    const grpBadge = grp 
      ? `<span class="inline-block w-2.5 h-2.5 rounded-full mr-1.5" style="background:${grp.color}"></span><span class="font-medium text-white">${grp.name}</span>`
      : '<span class="text-slate-400">Без группы</span>';

    const fromDev = store.getActiveRack()?.installedDevices.find(d => d.id === cable.from.deviceId);
    const toDev = store.getActiveRack()?.installedDevices.find(d => d.id === cable.to.deviceId);

    tip.innerHTML = `
      <div class="flex items-center gap-2 mb-1.5 border-b border-slate-700/80 pb-1">
        ${grpBadge}
      </div>
      <div class="flex items-center gap-1.5 font-mono text-[11px] text-cyan-300">
        <span>${fromDev?.customName || 'Dev'}: <b>${cable.from.portId}</b></span>
        <span class="text-slate-500">⇄</span>
        <span>${toDev?.customName || 'Dev'}: <b>${cable.to.portId}</b></span>
      </div>
      <div class="mt-1 text-[10px] text-slate-400 flex justify-between gap-3">
        <span>Тип: <b class="text-slate-300">${cable.type}</b></span>
        <span>Длина: <b class="text-slate-300">${cable.lengthM}м</b></span>
      </div>
      ${cable.label ? `<div class="mt-1 text-[10px] text-amber-300 font-sans italic">"${cable.label}"</div>` : ''}
    `;

    const svgRect = this.svg.getBoundingClientRect();
    tip.style.left = `${svgRect.left + x}px`;
    tip.style.top = `${svgRect.top + y}px`;
    tip.style.opacity = '1';
    tip.style.transform = 'translate(-50%, 0)';
  }

  hideTooltip() {
    const tip = document.getElementById('cable-tooltip');
    if (tip) tip.style.opacity = '0';
  }
}
