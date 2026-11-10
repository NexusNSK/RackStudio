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

    const ro = new ResizeObserver(() => {
      this.render();
    });
    ro.observe(this.rackEl);
  }

  getPortCoordinates(deviceId, portId) {
    const portEl = this.rackEl.querySelector(`[data-device-id="${deviceId}"][data-port-id="${portId}"]`);
    if (!portEl) return null;

    const portRect = portEl.getBoundingClientRect();
    const svgRect = this.svg.getBoundingClientRect();

    return {
      x: portRect.left + portRect.width / 2 - svgRect.left,
      y: portRect.top + portRect.height / 2 - svgRect.top,
      element: portEl
    };
  }

  generatePath(p1, p2, cableIndex = 0) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    const verticalDistance = Math.abs(dy);
    const isAdjacent = verticalDistance < 80;

    let slack;
    let cx1, cy1, cx2, cy2;

    if (isAdjacent) {
      slack = 38 + (cableIndex % 5) * 4;
      cx1 = p1.x + dx * 0.15;
      cy1 = p1.y + slack;
      cx2 = p2.x - dx * 0.15;
      cy2 = p2.y + slack;
    } else {
      slack = Math.min(100, Math.max(45, verticalDistance * 0.28)) + (cableIndex % 4) * 5;
      
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

  render() {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (!cablesLayer) return;
    cablesLayer.innerHTML = '';

    const cables = store.getCablesForActiveRack();
    const activeFilter = store.getActiveGroupFilter();
    const dimInactive = store.state.dimInactiveCables;
    const selectedEntity = store.selectedEntity;

    cables.forEach((cable, index) => {
      const p1 = this.getPortCoordinates(cable.from.deviceId, cable.from.portId);
      const p2 = this.getPortCoordinates(cable.to.deviceId, cable.to.portId);

      if (!p1 || !p2) return;

      const isGroupMatch = (activeFilter === 'ALL') || (cable.groupId === activeFilter);
      const isSelected = selectedEntity?.type === 'cable' && selectedEntity.id === cable.id;

      if (!isGroupMatch && !dimInactive) {
        return;
      }

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `cable-group ${isGroupMatch ? 'active-group' : 'inactive-group'} ${isSelected ? 'selected' : ''}`);
      g.dataset.cableId = cable.id;

      const pathData = this.generatePath(p1, p2, index);

      const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitPath.setAttribute('d', pathData);
      hitPath.setAttribute('fill', 'none');
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '18');
      hitPath.style.cursor = 'pointer';

      const shadowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shadowPath.setAttribute('d', pathData);
      shadowPath.setAttribute('fill', 'none');
      shadowPath.setAttribute('stroke', isGroupMatch ? cable.color : '#444');
      shadowPath.setAttribute('stroke-width', isSelected ? '8' : isGroupMatch && activeFilter !== 'ALL' ? '6' : '4');
      shadowPath.setAttribute('stroke-opacity', isGroupMatch ? (isSelected ? '0.6' : '0.25') : '0.04');
      shadowPath.setAttribute('class', 'cable-shadow');

      const corePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      corePath.setAttribute('d', pathData);
      corePath.setAttribute('fill', 'none');
      corePath.setAttribute('stroke', cable.color || '#3b82f6');
      corePath.setAttribute('stroke-linecap', 'round');
      corePath.setAttribute('stroke-width', isSelected ? '4.5' : isGroupMatch && activeFilter !== 'ALL' ? '4' : '3');
      
      if (!isGroupMatch && dimInactive) {
        corePath.setAttribute('stroke-opacity', '0.07');
        corePath.setAttribute('stroke', '#666666');
      } else {
        corePath.setAttribute('stroke-opacity', '0.95');
      }
      corePath.setAttribute('class', 'cable-core');

      const boot1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      boot1.setAttribute('cx', p1.x);
      boot1.setAttribute('cy', p1.y);
      boot1.setAttribute('r', isGroupMatch ? '3.5' : '2');
      boot1.setAttribute('fill', cable.color);
      boot1.setAttribute('opacity', isGroupMatch ? '1' : '0.2');

      const boot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      boot2.setAttribute('cx', p2.x);
      boot2.setAttribute('cy', p2.y);
      boot2.setAttribute('r', isGroupMatch ? '3.5' : '2');
      boot2.setAttribute('fill', cable.color);
      boot2.setAttribute('opacity', isGroupMatch ? '1' : '0.2');

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
        corePath.setAttribute('stroke-width', '5');
        shadowPath.setAttribute('stroke-opacity', '0.6');
        p1.element?.classList.add('port-cable-hover');
        p2.element?.classList.add('port-cable-hover');
        this.showTooltip(cable, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 + 20);
      });

      hitPath.addEventListener('mouseleave', () => {
        this.activeHoverCableId = null;
        corePath.setAttribute('stroke-width', isSelected ? '4.5' : isGroupMatch && activeFilter !== 'ALL' ? '4' : '3');
        shadowPath.setAttribute('stroke-opacity', isGroupMatch ? '0.25' : '0.04');
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

    const pathData = this.generatePath(p1, p2, 0);

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
