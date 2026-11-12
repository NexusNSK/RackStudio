/**
 * RackStudio - Cable SVG Routing & Interaction Engine
 */

import { store } from './state.js';
import { getPortDisplayName } from './cable-length.js';

export class CableRenderer {
  constructor(svgContainer, rackElement) {
    this.svg = svgContainer;
    this.rackEl = rackElement;
    this.viewportEl = document.getElementById('rack-viewport') || rackElement.parentElement || rackElement;
    this.activeHoverCableId = null;
    this.activeHoverCableGroup = null;
    this.renderedCables = [];
    this.hitSvgPoint = this.svg?.createSVGPoint?.() || null;
    this._mouseDownPos = null;

    this.initEvents();
  }

  isLightTheme() {
    return document.documentElement.dataset.theme === 'light';
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
      if (store.cableDraft || document.body.classList.contains('is-dragging-device')) return;
      const portEl = e.target.closest('[data-port-id][data-device-id]');
      if (!portEl) return;

      this.clearCableHover(true);
      const key = `${portEl.dataset.deviceId}:${portEl.dataset.portId}`;
      this.applyPortFocus(key);
    });

    this.rackEl.addEventListener('mouseout', (e) => {
      const portEl = e.target.closest('[data-port-id][data-device-id]');
      if (!portEl) return;
      if (e.relatedTarget && portEl.contains(e.relatedTarget)) return;
      this.clearFocus();
    });

    // Приоритет взаимодействия: порт > кабель > панель/слот
    this.viewportEl.addEventListener('mousedown', (e) => {
      this._mouseDownPos = { x: e.clientX, y: e.clientY };
    });

    this.viewportEl.addEventListener('mousemove', (e) => {
      if (store.cableDraft || document.body.classList.contains('is-dragging-device')) {
        this.clearCableHover(true);
        this.viewportEl.style.cursor = '';
        return;
      }

      if (e.target.closest('.port-slot') || e.target.closest('.inter-rack-badge')) {
        this.clearCableHover(true);
        if (e.target.closest('.inter-rack-badge')) {
          this.viewportEl.style.cursor = 'pointer';
        } else {
          this.viewportEl.style.cursor = '';
        }
        return;
      }

      const hit = this.findCableAtClientPoint(e.clientX, e.clientY);
      if (hit) {
        this.setCableHover(hit, e.clientX, e.clientY);
        this.viewportEl.style.cursor = 'pointer';
      } else {
        if (this.activeHoverCableId !== null) {
          this.clearCableHover(false);
        }
        this.viewportEl.style.cursor = '';
      }
    });

    this.viewportEl.addEventListener('mouseleave', () => {
      if (this.activeHoverCableId !== null) {
        this.clearCableHover(false);
      }
      this.viewportEl.style.cursor = '';
    });

    this.viewportEl.addEventListener('click', (e) => {
      if (store.cableDraft || document.body.classList.contains('is-dragging-device')) return;
      if (e.target.closest('.port-slot') || e.target.closest('.inter-rack-badge')) return;
      if (this._mouseDownPos && Math.hypot(e.clientX - this._mouseDownPos.x, e.clientY - this._mouseDownPos.y) >= 5) {
        return;
      }

      const hit = this.findCableAtClientPoint(e.clientX, e.clientY);
      if (hit) {
        e.stopPropagation();
        store.setSelection({ type: 'cable', id: hit.cable.id, data: hit.cable });
      }
    }, true);

    const ro = new ResizeObserver(() => {
      this.render();
    });
    ro.observe(this.rackEl);
  }

  getScale() {
    if (!this.rackEl || !this.rackEl.offsetWidth) return 1;
    const scale = this.rackEl.getBoundingClientRect().width / this.rackEl.offsetWidth;
    return scale > 0.05 ? scale : 1;
  }

  clientToSvgPoint(clientX, clientY) {
    const svgRect = this.svg.getBoundingClientRect();
    const scale = this.getScale();
    return {
      x: (clientX - svgRect.left) / scale,
      y: (clientY - svgRect.top) / scale
    };
  }

  findCableAtClientPoint(clientX, clientY) {
    if (!this.renderedCables.length || !this.svg) return null;
    if (!this.hitSvgPoint && this.svg.createSVGPoint) {
      this.hitSvgPoint = this.svg.createSVGPoint();
    }
    if (!this.hitSvgPoint) return null;

    const pt = this.clientToSvgPoint(clientX, clientY);
    this.hitSvgPoint.x = pt.x;
    this.hitSvgPoint.y = pt.y;

    for (let i = this.renderedCables.length - 1; i >= 0; i--) {
      const item = this.renderedCables[i];
      if (typeof item.hitPath.isPointInStroke === 'function' && item.hitPath.isPointInStroke(this.hitSvgPoint)) {
        return item;
      }
    }
    return null;
  }

  setCableHover(item, clientX, clientY) {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (!cablesLayer) return;

    if (this.activeHoverCableId !== item.cable.id) {
      this.clearFocus();
      this.activeHoverCableId = item.cable.id;
      this.activeHoverCableGroup = item.g;
      cablesLayer.classList.add('cables-has-focus');
      item.g.classList.add('is-focused');
      item.p1.element?.classList.add('port-cable-hover');
      item.p2.element?.classList.add('port-cable-hover');
    }

    this.showTooltip(item.cable, clientX, clientY + 18);
  }

  clearCableHover(keepPortFocus = false) {
    if (this.activeHoverCableId === null) {
      if (!keepPortFocus) this.hideTooltip();
      return;
    }
    this.activeHoverCableId = null;
    this.activeHoverCableGroup = null;
    this.hideTooltip();
    if (!keepPortFocus) {
      this.clearFocus();
    }
  }

  applyPortFocus(portKey) {
    const cablesLayer = this.svg.querySelector('#cables-layer');
    if (!cablesLayer) return;

    this.clearFocus();
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
    const deviceEl = portSlot.closest('.installed-device');
    const devRect = deviceEl ? deviceEl.getBoundingClientRect() : jackRect;
    const svgRect = this.svg.getBoundingClientRect();
    const scale = this.getScale();

    return {
      x: (jackRect.left + jackRect.width / 2 - svgRect.left) / scale,
      y: (jackRect.top + jackRect.height / 2 - svgRect.top) / scale,
      devTop: (devRect.top - svgRect.top) / scale,
      devBottom: (devRect.bottom - svgRect.top) / scale,
      labelPos: portSlot.dataset.labelPos || 'bottom',
      deviceId,
      element: portSlot
    };
  }

  getSeamExitY(portCoord, lane = 0) {
    const seamStagger = ((lane % 3) - 1) * 1.5;
    if (portCoord.labelPos === 'top' && typeof portCoord.devTop === 'number') {
      return Math.max(portCoord.devTop, portCoord.y - 28) + seamStagger;
    }
    if (typeof portCoord.devBottom === 'number') {
      return Math.min(portCoord.devBottom, portCoord.y + 28) + seamStagger;
    }
    return portCoord.y + 16 + seamStagger;
  }

  getRackBounds() {
    const rackRect = this.rackEl.getBoundingClientRect();
    const svgRect = this.svg.getBoundingClientRect();
    const scale = this.getScale();
    const left = (rackRect.left - svgRect.left) / scale;
    const right = (rackRect.right - svgRect.left) / scale;
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
    const sameRowBand = verticalDistance <= 22;

    let cx1, cy1, cx2, cy2;

    if (sameRowBand) {
      const dir = (p1.labelPos === 'top' && p2.labelPos === 'top') ? -1 : 1;
      const slack = 15 + (cableIndex % 4) * 3;
      const bowX = Math.abs(dx) < 8 ? 10 : 0;
      cx1 = p1.x + dx * 0.2 + bowX;
      cy1 = p1.y + dir * slack;
      cx2 = p2.x - dx * 0.2 + bowX;
      cy2 = p2.y + dir * slack;
    } else if (verticalDistance < 85) {
      const offset = Math.min(48, Math.max(18, verticalDistance * 0.36)) + (cableIndex % 4) * 3;
      if (dy > 0) {
        cx1 = p1.x + dx * 0.22;
        cy1 = p1.y + offset;
        cx2 = p2.x - dx * 0.22;
        cy2 = p2.y - offset * 0.75;
      } else {
        cx1 = p1.x + dx * 0.22;
        cy1 = p1.y - offset * 0.75;
        cx2 = p2.x - dx * 0.22;
        cy2 = p2.y + offset;
      }
    } else {
      const slack = Math.min(95, Math.max(45, verticalDistance * 0.25)) + (cableIndex % 4) * 5;
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

    const y1Out = this.getSeamExitY(p1, lane);
    const y2Out = this.getSeamExitY(p2, lane);
    const dirY = y2Out >= y1Out ? 1 : -1;
    const r = 8;
    const ry = Math.min(r, Math.abs(y2Out - y1Out) / 2);

    return [
      `M ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`,
      `Q ${p1.x.toFixed(1)},${y1Out.toFixed(1)} ${(p1.x + side * r).toFixed(1)},${y1Out.toFixed(1)}`,
      `L ${(channelX - side * r).toFixed(1)},${y1Out.toFixed(1)}`,
      `Q ${channelX.toFixed(1)},${y1Out.toFixed(1)} ${channelX.toFixed(1)},${(y1Out + dirY * ry).toFixed(1)}`,
      `L ${channelX.toFixed(1)},${(y2Out - dirY * ry).toFixed(1)}`,
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
    this.renderedCables = [];
    this.activeHoverCableId = null;
    this.activeHoverCableGroup = null;
    this.hideTooltip();

    const cables = store.getCablesForActiveRack();
    const activeFilter = store.getActiveGroupFilter();
    const dimInactive = store.state.dimInactiveCables;
    const selectedEntity = store.selectedEntity;
    const isDeviceSelected = selectedEntity?.type === 'device';
    const selectedDeviceId = isDeviceSelected ? selectedEntity.id : null;

    const rackBounds = this.getRackBounds();
    const channelState = { leftLane: 0, rightLane: 0, crossLeft: 0, crossRight: 0 };

    cables.forEach((cable, index) => {
      const p1 = this.getPortCoordinates(cable.from.deviceId, cable.from.portId);
      const p2 = this.getPortCoordinates(cable.to.deviceId, cable.to.portId);

      if (!p1 && !p2) return;

      const isInterRack = !(p1 && p2);
      const isGroupMatch = (activeFilter === 'ALL') || (cable.groupId === activeFilter);
      const isSelected = selectedEntity?.type === 'cable' && selectedEntity.id === cable.id;
      const isDeviceMatch = !isDeviceSelected || (cable.from.deviceId === selectedDeviceId || cable.to.deviceId === selectedDeviceId);

      if (!isGroupMatch && !dimInactive) {
        return;
      }

      const isEffectiveActive = isGroupMatch && isDeviceMatch;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `cable-group ${isInterRack ? 'inter-rack-cable' : ''} ${isEffectiveActive ? 'active-group' : 'inactive-group'} ${isSelected ? 'selected' : ''}`);
      g.dataset.cableId = cable.id;
      g.dataset.fromKey = `${cable.from.deviceId}:${cable.from.portId}`;
      g.dataset.toKey = `${cable.to.deviceId}:${cable.to.portId}`;

      let pathData = '';
      let endBootCoord = p2;
      let startBootCoord = p1;
      let crossBadgeInfo = null;

      if (!isInterRack) {
        pathData = this.generatePath(p1, p2, index, channelState, rackBounds);
      } else {
        const localCoord = p1 || p2;
        const remoteEnd = p1 ? cable.to : cable.from;
        const remoteLoc = store.findDeviceLocation(remoteEnd.deviceId);
        const side = localCoord.x < rackBounds.centerX ? -1 : 1;
        const crossLane = side === -1 ? (channelState.crossLeft++ % 6) : (channelState.crossRight++ % 6);
        const outY = this.getSeamExitY(localCoord, crossLane);
        const outX = side === -1
          ? rackBounds.left - 16 - (crossLane * 4)
          : rackBounds.right + 16 + (crossLane * 4);

        pathData = [
          `M ${localCoord.x.toFixed(1)},${localCoord.y.toFixed(1)}`,
          `Q ${localCoord.x.toFixed(1)},${outY.toFixed(1)} ${(localCoord.x + side * 8).toFixed(1)},${outY.toFixed(1)}`,
          `L ${outX.toFixed(1)},${outY.toFixed(1)}`
        ].join(' ');

        startBootCoord = localCoord;
        endBootCoord = { x: outX, y: outY, element: localCoord.element };
        crossBadgeInfo = {
          x: outX,
          y: outY,
          side,
          remoteRackId: remoteLoc?.rack?.id || null,
          remoteRackName: remoteLoc?.rack?.name || 'Другая стойка',
          remotePortLabel: getPortDisplayName(remoteLoc?.template, remoteEnd.portId) || remoteEnd.portId
        };
      }

      const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitPath.setAttribute('d', pathData);
      hitPath.setAttribute('fill', 'none');
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '14');
      hitPath.setAttribute('stroke-linecap', 'round');
      hitPath.setAttribute('stroke-linejoin', 'round');
      hitPath.setAttribute('pointer-events', 'none');

      // Тёмная подложка («эффект моста») для чёткого разделения пересекающихся кабелей
      const isLight = this.isLightTheme();
      const casingPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      casingPath.setAttribute('d', pathData);
      casingPath.setAttribute('fill', 'none');
      casingPath.setAttribute('stroke', isLight ? '#f8fafc' : '#0b0e14');
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
      if (isInterRack) {
        corePath.setAttribute('stroke-dasharray', '6 3');
      }

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
      boot1.setAttribute('cx', startBootCoord.x);
      boot1.setAttribute('cy', startBootCoord.y);
      boot1.setAttribute('r', isEffectiveActive ? '3.2' : '2');
      boot1.setAttribute('fill', cable.color);
      boot1.setAttribute('opacity', isEffectiveActive ? '1' : '0.18');

      const boot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      boot2.setAttribute('cx', endBootCoord.x);
      boot2.setAttribute('cy', endBootCoord.y);
      boot2.setAttribute('r', isEffectiveActive ? '3.2' : '2');
      boot2.setAttribute('fill', cable.color);
      boot2.setAttribute('opacity', isEffectiveActive ? '1' : '0.18');

      g.appendChild(casingPath);
      g.appendChild(shadowPath);
      g.appendChild(corePath);
      g.appendChild(boot1);
      g.appendChild(boot2);
      g.appendChild(hitPath);

      if (crossBadgeInfo) {
        const badgeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        badgeG.setAttribute('class', 'inter-rack-badge cursor-pointer pointer-events-auto');
        badgeG.dataset.targetRackId = crossBadgeInfo.remoteRackId || '';
        badgeG.dataset.cableId = cable.id;

        const shortRack = crossBadgeInfo.remoteRackName.length > 12
          ? `${crossBadgeInfo.remoteRackName.slice(0, 11)}…`
          : crossBadgeInfo.remoteRackName;
        const labelText = `⇄ ${shortRack}`;
        const pillW = Math.max(58, labelText.length * 6.2 + 12);
        const pillH = 16;
        const rectX = crossBadgeInfo.side === -1
          ? crossBadgeInfo.x - pillW - 4
          : crossBadgeInfo.x + 4;
        const rectY = crossBadgeInfo.y - pillH / 2;

        const pillRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        pillRect.setAttribute('x', rectX);
        pillRect.setAttribute('y', rectY);
        pillRect.setAttribute('width', pillW);
        pillRect.setAttribute('height', pillH);
        pillRect.setAttribute('rx', '4');
        pillRect.setAttribute('fill', isLight ? '#ffffff' : '#111827');
        pillRect.setAttribute('stroke', cable.color || '#6366f1');
        pillRect.setAttribute('stroke-width', '1.2');
        pillRect.setAttribute('fill-opacity', isEffectiveActive ? '0.96' : (isLight ? '0.88' : '0.35'));

        const pillTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pillTxt.setAttribute('x', rectX + pillW / 2);
        pillTxt.setAttribute('y', crossBadgeInfo.y + 3);
        pillTxt.setAttribute('text-anchor', 'middle');
        pillTxt.setAttribute('fill', isEffectiveActive ? (isLight ? '#0f172a' : '#e0e7ff') : (isLight ? '#475569' : '#64748b'));
        pillTxt.setAttribute('font-size', '9');
        pillTxt.setAttribute('font-family', 'JetBrains Mono, monospace');
        pillTxt.textContent = labelText;

        badgeG.appendChild(pillRect);
        badgeG.appendChild(pillTxt);
        badgeG.addEventListener('click', (evt) => {
          evt.stopPropagation();
          if (crossBadgeInfo.remoteRackId) {
            store.setActiveRack(crossBadgeInfo.remoteRackId);
            store.setSelection({ type: 'cable', id: cable.id, data: cable });
          }
        });
        g.appendChild(badgeG);
      }

      this.renderedCables.push({
        cable,
        g,
        hitPath,
        p1: startBootCoord,
        p2: endBootCoord,
        isInterRack
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

    let p1 = this.getPortCoordinates(store.cableDraft.deviceId, store.cableDraft.portId);
    const isCrossRackDraft = !p1;
    if (!p1) {
      const rackBounds = this.getRackBounds();
      p1 = {
        x: Math.max(0, rackBounds.left - 12),
        y: 52,
        labelPos: 'top'
      };
    }

    const p2 = this.clientToSvgPoint(store.cableDraft.clientX, store.cableDraft.clientY);

    // Для перетягивания кабеля курсором всегда используем прямую живую дугу
    const pathData = this.generateArcPath(p1, p2, 0);

    const activeGroupId = store.getActiveGroupFilter();
    const activeGroup = activeGroupId !== 'ALL' ? store.getGroup(activeGroupId) : null;
    const draftColor = activeGroup?.color || (isCrossRackDraft ? '#818cf8' : '#00d2ff');

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

    const fromLoc = store.findDeviceLocation(cable.from.deviceId);
    const toLoc = store.findDeviceLocation(cable.to.deviceId);
    const interRack = Boolean(fromLoc && toLoc && fromLoc.rack.id !== toLoc.rack.id);
    const fromPortName = getPortDisplayName(fromLoc?.template, cable.from.portId) || cable.from.portId;
    const toPortName = getPortDisplayName(toLoc?.template, cable.to.portId) || cable.to.portId;

    tip.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-1.5 border-b border-slate-700/80 pb-1">
        <div>${grpBadge}</div>
        ${interRack ? '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700/80">Межстоечный</span>' : ''}
      </div>
      <div class="flex items-center gap-1.5 font-mono text-[11px] text-cyan-300">
        <span>${interRack && fromLoc ? `[${fromLoc.rack.name}] ` : ''}${fromLoc?.device?.customName || 'Dev'}: <b>${fromPortName}</b></span>
        <span class="text-slate-500">⇄</span>
        <span>${interRack && toLoc ? `[${toLoc.rack.name}] ` : ''}${toLoc?.device?.customName || 'Dev'}: <b>${toPortName}</b></span>
      </div>
      <div class="mt-1 text-[10px] text-slate-400 flex justify-between gap-3">
        <span>Тип: <b class="text-slate-300">${cable.type}</b></span>
        <span>Длина: <b class="text-slate-300">${cable.lengthM}м</b>${cable.lengthAuto ? ' <span class="text-cyan-400">(авто)</span>' : ''}</span>
      </div>
      ${cable.label ? `<div class="mt-1 text-[10px] text-amber-300 font-sans italic">"${cable.label}"</div>` : ''}
    `;

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.opacity = '1';
    tip.style.transform = 'translate(-50%, 0)';
  }

  hideTooltip() {
    const tip = document.getElementById('cable-tooltip');
    if (tip) tip.style.opacity = '0';
  }
}
