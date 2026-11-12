/**
 * RackStudio - Automated Logical L1/L2 Network Topology Engine (Pure SVG)
 */

import { store } from './state.js';
import { findDeviceLocation, getPortDisplayName } from './cable-length.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function evalCubicBezier(geom, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  const a = mt2 * mt;
  const b = 3 * mt2 * t;
  const c = 3 * mt * t2;
  const d = t2 * t;
  return {
    x: a * geom.x1 + b * geom.cx1 + c * geom.cx2 + d * geom.x2,
    y: a * geom.y1 + b * geom.cy1 + c * geom.cy2 + d * geom.y2
  };
}

function rectsOverlapArea(r1, r2, pad = 0) {
  const ox = Math.min(r1.x + r1.w + pad, r2.x + r2.w) - Math.max(r1.x - pad, r2.x);
  if (ox <= 0) return 0;
  const oy = Math.min(r1.y + r1.h + pad, r2.y + r2.h) - Math.max(r1.y - pad, r2.y);
  if (oy <= 0) return 0;
  return ox * oy;
}

function pointNearRect(px, py, rect, pad = 4) {
  return (
    px >= rect.x - pad &&
    px <= rect.x + rect.w + pad &&
    py >= rect.y - pad &&
    py <= rect.y + rect.h + pad
  );
}

/**
 * Computes SVG Bezier path and control points between two topology nodes.
 * Uses live node rectangles so edges adapt naturally regardless of manual dragging.
 */
function computeTopologyEdgeGeometry(a, b, edge) {
  const offsetShift = ((edge.parallelIndex || 0) - ((edge.parallelTotal || 1) - 1) / 2) * 28;
  const cyA = a.y + a.h / 2;
  const cyB = b.y + b.h / 2;
  const upper = cyA <= cyB ? a : b;
  const lower = cyA <= cyB ? b : a;
  const verticalGap = lower.y - (upper.y + upper.h);

  let x1, y1, x2, y2, cx1, cy1, cx2, cy2;

  if (verticalGap >= 12) {
    x1 = upper.x + upper.w / 2 + offsetShift * 0.45;
    y1 = upper.y + upper.h;
    x2 = lower.x + lower.w / 2 + offsetShift * 0.45;
    y2 = lower.y;
    const midY = (y1 + y2) / 2;
    cx1 = x1 + offsetShift * 0.6;
    cy1 = midY;
    cx2 = x2 + offsetShift * 0.6;
    cy2 = midY;
  } else {
    const left = a.x <= b.x ? a : b;
    const right = a.x <= b.x ? b : a;
    const horizGap = right.x - (left.x + left.w);

    if (horizGap >= 150) {
      x1 = left.x + left.w;
      y1 = left.y + left.h / 2 + offsetShift * 0.35;
      x2 = right.x;
      y2 = right.y + right.h / 2 + offsetShift * 0.35;
      const midX = (x1 + x2) / 2;
      cx1 = midX;
      cy1 = y1 + offsetShift * 0.35;
      cx2 = midX;
      cy2 = y2 + offsetShift * 0.35;
    } else {
      x1 = left.x + left.w / 2;
      y1 = left.y;
      x2 = right.x + right.w / 2;
      y2 = right.y;
      const minTop = Math.min(y1, y2);
      const arcLift = 38 + Math.abs((edge.parallelIndex || 0) + 1) * 20;
      cx1 = x1;
      cy1 = minTop - arcLift;
      cx2 = x2;
      cy2 = minTop - arcLift;
    }
  }

  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  return {
    d: `M ${x1.toFixed(1)},${y1.toFixed(1)} C ${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`,
    x1,
    y1,
    cx1,
    cy1,
    cx2,
    cy2,
    x2,
    y2,
    nx,
    ny,
    spanLen: len,
    labelX: 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2,
    labelY: 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2
  };
}

/**
 * Finds collision-free pill coordinates along each edge's Bezier curve.
 * Avoids pill-to-pill overlap, pill-to-node overlap, and unnecessary crossing lines.
 */
function resolveTopologyEdgeLabels(preparedEdges, nodeBoxes, canvasWidth = 1200) {
  if (!preparedEdges.length) return;

  const tSteps = [0.16, 0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 0.84];
  const sampledCurves = preparedEdges.map(item =>
    tSteps.map(t => evalCubicBezier(item.geom, t))
  );

  // Place shorter edges first so tight spans keep center positions while long spans slide easily
  const order = preparedEdges
    .map((item, idx) => ({ idx, span: item.geom.spanLen }))
    .sort((a, b) => a.span - b.span)
    .map(entry => entry.idx);

  const placedPills = [];
  const tCandidates = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];
  const normalOffsets = [0, 22, -22, 34, -34, 46, -46];

  order.forEach(idx => {
    const item = preparedEdges[idx];
    const { geom, pillW, pillH } = item;

    let bestScore = Infinity;
    let bestX = geom.labelX;
    let bestY = geom.labelY;

    for (const off of normalOffsets) {
      for (const t of tCandidates) {
        if (Math.abs(off) > 0 && (t < 0.3 || t > 0.7)) continue;

        const pt = evalCubicBezier(geom, t);
        const cx = pt.x + geom.nx * off;
        const cy = pt.y + geom.ny * off;
        const box = {
          x: cx - pillW / 2,
          y: cy - pillH / 2,
          w: pillW,
          h: pillH
        };

        let score = Math.abs(t - 0.5) * 45 + Math.abs(off) * 0.75;

        // Strong priority: never overlap another already-placed edge pill
        for (const placed of placedPills) {
          const ov = rectsOverlapArea(box, placed, 4);
          if (ov > 0) {
            score += 50000 + ov * 120;
          }
        }

        // High penalty: never cover a device card
        for (const node of nodeBoxes) {
          const ov = rectsOverlapArea(box, node, 4);
          if (ov > 0) {
            score += 4000 + ov * 15;
          }
        }

        // Moderate penalty: avoid sitting directly over another edge curve
        for (let j = 0; j < sampledCurves.length; j++) {
          if (j === idx) continue;
          const pts = sampledCurves[j];
          for (let k = 0; k < pts.length; k++) {
            if (pointNearRect(pts[k].x, pts[k].y, box, 4)) {
              score += 280;
              break;
            }
          }
        }

        // Keep pill inside visible horizontal bounds when possible
        if (box.x < 6) score += 600 + (6 - box.x) * 20;
        if (box.x + box.w > canvasWidth - 6) score += 600 + (box.x + box.w - (canvasWidth - 6)) * 20;

        if (score < bestScore) {
          bestScore = score;
          bestX = cx;
          bestY = cy;
          if (score < 12) break;
        }
      }
      if (bestScore < 12) break;
    }

    item.labelX = bestX;
    item.labelY = bestY;
    placedPills.push({
      x: bestX - pillW / 2,
      y: bestY - pillH / 2,
      w: pillW,
      h: pillH
    });
  });
}

function getCategoryMeta(category, vendor = '', name = '') {
  const isEltex = String(vendor).toLowerCase().includes('eltex');
  const fullName = `${vendor} ${name}`.toLowerCase();
  if (isEltex && /ltp/.test(fullName)) {
    return { icon: '🌐', label: 'Eltex LTP / OLT', accent: '#0284c7', border: '#0369a1' };
  }
  if (isEltex && /tau/.test(fullName)) {
    return { icon: '📞', label: 'Eltex TAU / VoIP-шлюз', accent: '#059669', border: '#047857' };
  }
  switch (category) {
    case 'router':
      return { icon: '🛡', label: isEltex ? 'Eltex ESR / Шлюз' : 'Шлюз / Маршрутизатор', accent: '#10b981', border: '#059669' };
    case 'switch':
      return { icon: '🔀', label: isEltex ? 'Eltex MES Коммутатор' : 'Коммутатор', accent: '#06b6d4', border: '#0891b2' };
    case 'server':
      return { icon: '🖥', label: 'Сервер / СХД', accent: '#3b82f6', border: '#2563eb' };
    case 'patch_panel':
      return { icon: '🔌', label: 'Патч-панель / АРМ', accent: '#a855f7', border: '#9333ea' };
    case 'pdu':
      return { icon: '⚡', label: 'PDU / Питание', accent: '#f59e0b', border: '#d97706' };
    default:
      return { icon: '📦', label: 'Устройство', accent: '#64748b', border: '#475569' };
  }
}

export class TopologyRenderer {
  constructor(viewportElement) {
    this.viewport = viewportElement;
    this.scope = 'active'; // 'active' | 'all'
    this.aggregateBundles = true;
    this.showStandalone = true;
    this.zoom = 1;
    this.lastModel = null;
    this.dragState = null;
    this.suppressNextClick = false;
    this.suppressTimer = null;

    this.onWindowMouseMove = (e) => this.handleDragMove(e);
    this.onWindowMouseUp = () => this.handleDragEnd();
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  getScopeKey(scope = this.scope) {
    if (scope === 'all') return 'all';
    const activeRack = store.getActiveRack();
    return activeRack?.id || 'default';
  }

  isSuppressingClick() {
    return Boolean(this.suppressNextClick);
  }

  resetLayout() {
    store.resetTopologyPositions(this.getScopeKey());
  }

  setScope(scope) {
    this.scope = scope === 'all' ? 'all' : 'active';
    this.render();
  }

  setAggregateBundles(val) {
    this.aggregateBundles = Boolean(val);
    this.render();
  }

  setShowStandalone(val) {
    this.showStandalone = Boolean(val);
    this.render();
  }

  setZoom(nextZoom) {
    const num = Number(nextZoom);
    this.zoom = Number.isFinite(num) ? Math.min(2.0, Math.max(0.3, Math.round(num * 100) / 100)) : 1;
    this.applyZoom();
  }

  stepZoom(dir) {
    const next = Math.round((this.zoom + (dir > 0 ? 0.15 : -0.15)) * 100) / 100;
    this.setZoom(next);
  }

  applyZoom() {
    const stage = this.viewport?.querySelector('#topology-svg-stage');
    const pctBtn = this.viewport?.querySelector('#topo-zoom-reset');
    if (stage) {
      stage.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
    }
    if (pctBtn) {
      pctBtn.textContent = `${Math.round(this.zoom * 100)}%`;
    }
  }

  /**
   * Computes nodes, layered coordinates, aggregated edges, and STP/LAG warnings.
   */
  computeTopologyModel({ scope = this.scope, aggregateBundles = this.aggregateBundles, showStandalone = this.showStandalone } = {}) {
    const state = store.state;
    const activeRack = store.getActiveRack();
    const racks = state.racks || [];
    const allCables = state.cables || [];

    const visibleDeviceIds = new Set();
    const externalDeviceIds = new Set();

    if (scope === 'all') {
      racks.forEach(r => r.installedDevices.forEach(d => visibleDeviceIds.add(d.id)));
    } else if (activeRack) {
      activeRack.installedDevices.forEach(d => visibleDeviceIds.add(d.id));
    }

    const relevantCables = allCables.filter(c => {
      if (scope === 'all') {
        return visibleDeviceIds.has(c.from.deviceId) && visibleDeviceIds.has(c.to.deviceId);
      }
      const inFrom = visibleDeviceIds.has(c.from.deviceId);
      const inTo = visibleDeviceIds.has(c.to.deviceId);
      if (inFrom && !inTo) externalDeviceIds.add(c.to.deviceId);
      if (inTo && !inFrom) externalDeviceIds.add(c.from.deviceId);
      return inFrom || inTo;
    });

    const linkedIds = new Set();
    relevantCables.forEach(c => {
      linkedIds.add(c.from.deviceId);
      linkedIds.add(c.to.deviceId);
    });

    const nodeIds = new Set([...visibleDeviceIds, ...externalDeviceIds]);
    const nodes = [];
    const nodeMap = new Map();

    nodeIds.forEach(devId => {
      const loc = findDeviceLocation(state, devId);
      if (!loc) return;
      const isExternal = externalDeviceIds.has(devId);
      const isLinked = linkedIds.has(devId);
      if (!showStandalone && !isLinked && !isExternal) return;

      const devCables = relevantCables.filter(c => c.from.deviceId === devId || c.to.deviceId === devId);
      const totalPorts = loc.template?.ports?.length || 0;
      const node = {
        id: devId,
        device: loc.device,
        template: loc.template,
        rack: loc.rack,
        isExternal,
        category: loc.template?.category || 'device',
        vendor: loc.template?.vendor || '',
        usedPorts: devCables.length,
        totalPorts,
        neighbors: new Set(),
        tier: 2,
        row: 0,
        col: 0,
        x: 0,
        y: 0,
        w: 224,
        h: 82
      };
      nodes.push(node);
      nodeMap.set(devId, node);
    });

    relevantCables.forEach(c => {
      const nA = nodeMap.get(c.from.deviceId);
      const nB = nodeMap.get(c.to.deviceId);
      if (nA && nB && nA.id !== nB.id) {
        nA.neighbors.add(nB.id);
        nB.neighbors.add(nA.id);
      }
    });

    // Tiering (BFS for switch hops from routers; routers = 0, core switch = 1, access = 2+, server = +3, patch = +4)
    const routers = nodes.filter(n => n.category === 'router');
    const switchDepth = new Map();
    const queue = [];

    routers.forEach(r => {
      r.tier = 0;
      r.neighbors.forEach(nbId => {
        const nb = nodeMap.get(nbId);
        if (nb && nb.category === 'switch' && !switchDepth.has(nb.id)) {
          switchDepth.set(nb.id, 1);
          queue.push(nb.id);
        }
      });
    });

    while (queue.length > 0) {
      const currId = queue.shift();
      const currDepth = switchDepth.get(currId);
      const currNode = nodeMap.get(currId);
      currNode?.neighbors.forEach(nbId => {
        const nb = nodeMap.get(nbId);
        if (nb && nb.category === 'switch' && !switchDepth.has(nb.id)) {
          switchDepth.set(nb.id, Math.min(currDepth + 1, 3));
          queue.push(nb.id);
        }
      });
    }

    // Any disconnected switches or switches in racks without router: group top switches (core/sfp or higher U) at tier 1
    const unvisitedSwitches = nodes.filter(n => n.category === 'switch' && !switchDepth.has(n.id));
    if (unvisitedSwitches.length > 0) {
      // Heuristic: switches linked to SFP/routers or highest rack U act as aggregation tier 1
      const sortedUnvisited = [...unvisitedSwitches].sort((a, b) => (b.device.uPosition || 0) - (a.device.uPosition || 0));
      const rootSw = sortedUnvisited[0];
      if (rootSw && !switchDepth.has(rootSw.id)) {
        switchDepth.set(rootSw.id, 1);
        const q2 = [rootSw.id];
        while (q2.length > 0) {
          const cid = q2.shift();
          const cdepth = switchDepth.get(cid);
          nodeMap.get(cid)?.neighbors.forEach(nbId => {
            const nb = nodeMap.get(nbId);
            if (nb && nb.category === 'switch' && !switchDepth.has(nb.id)) {
              switchDepth.set(nb.id, Math.min(cdepth + 1, 3));
              q2.push(nb.id);
            }
          });
        }
      }
      unvisitedSwitches.forEach(sw => {
        if (!switchDepth.has(sw.id)) switchDepth.set(sw.id, 1);
      });
    }

    let maxSwitchDepth = 1;
    switchDepth.forEach(d => {
      if (d > maxSwitchDepth) maxSwitchDepth = d;
    });

    nodes.forEach(n => {
      if (n.category === 'router') {
        n.tier = 0;
      } else if (n.category === 'switch') {
        n.tier = switchDepth.get(n.id) || 1;
      } else if (n.category === 'server' || n.category === 'pdu' || n.category === 'device') {
        n.tier = maxSwitchDepth + 1;
      } else if (n.category === 'patch_panel') {
        n.tier = maxSwitchDepth + 2;
      } else {
        n.tier = maxSwitchDepth + 1;
      }
    });

    // Compress non-empty tiers sequentially to row 0, 1, 2...
    const distinctTiers = Array.from(new Set(nodes.map(n => n.tier))).sort((a, b) => a - b);
    const tierToRow = new Map(distinctTiers.map((t, idx) => [t, idx]));

    const rows = distinctTiers.map(() => []);
    nodes.forEach(n => {
      n.row = tierToRow.get(n.tier) ?? 0;
      rows[n.row].push(n);
    });

    // Sort row 0 cleanly by rack & U descending, subsequent rows by parent barycenter to reduce line crossings
    if (rows[0]) {
      rows[0].sort((a, b) => (b.device.uPosition || 0) - (a.device.uPosition || 0));
    }

    for (let rIdx = 1; rIdx < rows.length; rIdx++) {
      const upperOrder = new Map();
      rows[rIdx - 1].forEach((n, idx) => upperOrder.set(n.id, idx));

      rows[rIdx].sort((a, b) => {
        const score = (node) => {
          const parentIdxs = [];
          node.neighbors.forEach(nbId => {
            if (upperOrder.has(nbId)) parentIdxs.push(upperOrder.get(nbId));
          });
          if (parentIdxs.length === 0) return 999 - (node.device.uPosition || 0) * 0.01;
          return parentIdxs.reduce((s, v) => s + v, 0) / parentIdxs.length;
        };
        const diff = score(a) - score(b);
        if (Math.abs(diff) > 0.001) return diff;
        return (b.device.uPosition || 0) - (a.device.uPosition || 0);
      });
    }

    // Geometry placement
    const nodeW = 224;
    const nodeH = 84;
    const gapX = 56;
    const gapY = 98;
    const padX = 64;
    const padY = 44;

    const maxCols = Math.max(1, ...rows.map(r => r.length));
    let canvasWidth = Math.max(820, padX * 2 + maxCols * nodeW + Math.max(0, maxCols - 1) * gapX);
    let canvasHeight = Math.max(360, padY * 2 + rows.length * nodeH + Math.max(0, rows.length - 1) * gapY);

    rows.forEach((rowNodes, rowIdx) => {
      const rowTotalW = rowNodes.length * nodeW + Math.max(0, rowNodes.length - 1) * gapX;
      const startX = (canvasWidth - rowTotalW) / 2;
      const y = padY + rowIdx * (nodeH + gapY);

      rowNodes.forEach((node, colIdx) => {
        node.col = colIdx;
        node.w = nodeW;
        node.h = nodeH;
        node.x = startX + colIdx * (nodeW + gapX);
        node.y = y;
      });
    });

    // Overlay user-dragged custom coordinates for this scope
    const scopeKey = this.getScopeKey(scope);
    const customPositions = store.getTopologyPositions(scopeKey);
    let hasCustomPositions = false;
    nodes.forEach(node => {
      const custom = customPositions?.[node.id];
      if (custom && Number.isFinite(Number(custom.x)) && Number.isFinite(Number(custom.y))) {
        node.x = Math.max(16, Math.round(Number(custom.x)));
        node.y = Math.max(16, Math.round(Number(custom.y)));
        node.isCustomPositioned = true;
        hasCustomPositions = true;
      } else {
        node.isCustomPositioned = false;
      }
      canvasWidth = Math.max(canvasWidth, node.x + node.w + padX);
      canvasHeight = Math.max(canvasHeight, node.y + node.h + padY);
    });

    // Edge aggregation (E.3) & parallel / STP loop detection
    const pairCableTotals = new Map();
    relevantCables.forEach(c => {
      const a = c.from.deviceId;
      const b = c.to.deviceId;
      const pairKey = a < b ? `${a}__${b}` : `${b}__${a}`;
      pairCableTotals.set(pairKey, (pairCableTotals.get(pairKey) || 0) + 1);
    });

    // Cycle detection on router/switch L2 backbone graph
    const l2Nodes = nodes.filter(n => n.category === 'router' || n.category === 'switch');
    const l2Adj = new Map(l2Nodes.map(n => [n.id, new Set()]));
    relevantCables.forEach(c => {
      const a = c.from.deviceId;
      const b = c.to.deviceId;
      if (l2Adj.has(a) && l2Adj.has(b) && a !== b) {
        l2Adj.get(a).add(b);
        l2Adj.get(b).add(a);
      }
    });

    const cyclePairKeys = new Set();
    const visited = new Set();
    const parent = new Map();
    const stack = [];

    // Mark edges that close a >=3 node cycle in L2 switch/router backbone
    const dfs = (u) => {
      visited.add(u);
      stack.push(u);
      l2Adj.get(u)?.forEach(v => {
        if (parent.get(u) === v) return;
        if (visited.has(v)) {
          const idx = stack.indexOf(v);
          if (idx !== -1 && stack.length - idx >= 3) {
            for (let i = idx; i < stack.length - 1; i++) {
              const x = stack[i];
              const y = stack[i + 1];
              cyclePairKeys.add(x < y ? `${x}__${y}` : `${y}__${x}`);
            }
            cyclePairKeys.add(u < v ? `${u}__${v}` : `${v}__${u}`);
          }
        } else {
          parent.set(v, u);
          dfs(v);
        }
      });
      stack.pop();
    };
    l2Nodes.forEach(n => {
      if (!visited.has(n.id)) dfs(n.id);
    });

    const edgeGroups = new Map();
    relevantCables.forEach((cable, idx) => {
      const nA = nodeMap.get(cable.from.deviceId);
      const nB = nodeMap.get(cable.to.deviceId);
      if (!nA || !nB) return;

      const sortedIds = nA.id < nB.id ? [nA.id, nB.id] : [nB.id, nA.id];
      const basePairKey = `${sortedIds[0]}__${sortedIds[1]}`;
      const bundleKey = aggregateBundles
        ? `${basePairKey}__${cable.groupId || 'NOGRP'}`
        : `single__${cable.id || idx}`;

      if (!edgeGroups.has(bundleKey)) {
        const grp = cable.groupId ? store.getGroup(cable.groupId) : null;
        edgeGroups.set(bundleKey, {
          key: bundleKey,
          pairKey: basePairKey,
          fromNode: nodeMap.get(sortedIds[0]),
          toNode: nodeMap.get(sortedIds[1]),
          groupId: cable.groupId || '',
          group: grp,
          color: grp?.color || cable.color || '#38bdf8',
          cables: [],
          isInterRack: store.isInterRackCable(cable),
          isL2Trunk: false,
          isLoopRisk: false
        });
      }
      const edge = edgeGroups.get(bundleKey);
      edge.cables.push(cable);
      if (store.isInterRackCable(cable)) edge.isInterRack = true;
    });

    // Split curve offsets for multiple parallel bundles between the same two nodes
    const pairBundleList = new Map();
    const edges = Array.from(edgeGroups.values());
    edges.forEach(edge => {
      if (!pairBundleList.has(edge.pairKey)) pairBundleList.set(edge.pairKey, []);
      pairBundleList.get(edge.pairKey).push(edge);

      const bothL2 =
        (edge.fromNode.category === 'router' || edge.fromNode.category === 'switch') &&
        (edge.toNode.category === 'router' || edge.toNode.category === 'switch');
      const totalOnPair = pairCableTotals.get(edge.pairKey) || 0;
      edge.isL2Trunk = bothL2 && totalOnPair >= 2;
      edge.isLoopRisk = cyclePairKeys.has(edge.pairKey);
    });

    pairBundleList.forEach(list => {
      list.forEach((edge, i) => {
        edge.parallelIndex = i;
        edge.parallelTotal = list.length;
      });
    });

    const lagCount = edges.filter(e => e.isL2Trunk).length;
    const loopCount = cyclePairKeys.size;

    return {
      scope,
      scopeKey,
      hasCustomPositions,
      nodes,
      edges,
      canvasWidth,
      canvasHeight,
      lagCount,
      loopCount,
      totalCables: relevantCables.length
    };
  }

  /**
   * Builds reusable SVG markup for either the interactive dark canvas or light print passport.
   */
  buildSvgMarkup(model, { theme = 'dark', interactive = true } = {}) {
    const isLight = theme === 'light';
    const activeFilter = store.getActiveGroupFilter();
    const dimInactive = store.state.dimInactiveCables;
    const selectedEntity = store.selectedEntity;

    const bgFill = isLight ? '#ffffff' : '#0b0e14';
    const nodeFill = isLight ? '#f8fafc' : '#131722';
    const nodeTextPrimary = isLight ? '#0f172a' : '#f1f5f9';
    const nodeTextMuted = isLight ? '#475569' : '#94a3b8';
    const badgeFill = isLight ? '#ffffff' : '#0f172a';
    const pillTextColor = isLight ? '#0f172a' : '#e2e8f0';

    const preparedEdges = [];
    model.edges.forEach(edge => {
      const a = edge.fromNode;
      const b = edge.toNode;
      const isFilterMatch = activeFilter === 'ALL' || edge.groupId === activeFilter;
      if (!isFilterMatch && !dimInactive) {
        return;
      }

      const geom = computeTopologyEdgeGeometry(a, b, edge);
      const isSingle = edge.cables.length === 1;
      const primaryCable = edge.cables[0];
      const isEdgeSelected = interactive && (
        (selectedEntity?.type === 'cable' && edge.cables.some(c => c.id === selectedEntity.id)) ||
        (selectedEntity?.type === 'cable_bundle' && selectedEntity.bundleKey === edge.key) ||
        (selectedEntity?.type === 'device' && (a.id === selectedEntity.id || b.id === selectedEntity.id))
      );

      const opacity = isFilterMatch ? (isEdgeSelected ? 1 : 0.92) : 0.14;
      const strokeW = isSingle ? (isEdgeSelected ? 3.5 : 2.2) : Math.min(6, 2.4 + Math.log2(edge.cables.length) * 1.4);

      let labelText = '';
      if (isSingle) {
        const pFrom = getPortDisplayName(findDeviceLocation(store.state, primaryCable.from.deviceId)?.template, primaryCable.from.portId);
        const pTo = getPortDisplayName(findDeviceLocation(store.state, primaryCable.to.deviceId)?.template, primaryCable.to.portId);
        const shortFrom = pFrom.replace(/^Port\s+/i, 'P');
        const shortTo = pTo.replace(/^Port\s+/i, 'P');
        labelText = `${shortFrom} ⇄ ${shortTo}`;
      } else {
        const grpTitle = edge.group ? `VLAN ${edge.group.vlan}` : (primaryCable.type || 'Линки');
        labelText = `${grpTitle} · ×${edge.cables.length}`;
      }

      if (edge.isLoopRisk) {
        labelText += ' [STP]';
      } else if (edge.isL2Trunk) {
        labelText += ' (LAG)';
      }

      const pillW = Math.max(54, labelText.length * 5.9 + 14);
      const pillH = 20;

      preparedEdges.push({
        edge,
        geom,
        opacity,
        strokeW,
        isEdgeSelected,
        labelText,
        pillW,
        pillH,
        labelX: geom.labelX,
        labelY: geom.labelY
      });
    });

    const nodeBoxes = model.nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    resolveTopologyEdgeLabels(preparedEdges, nodeBoxes, model.canvasWidth);
    model.renderedEdges = preparedEdges;

    // Expand SVG viewBox if top same-row arches or nudged pills rise above y=0
    let minViewY = 0;
    preparedEdges.forEach(item => {
      minViewY = Math.min(minViewY, item.labelY - item.pillH / 2 - 8);
      for (const t of [0.25, 0.5, 0.75]) {
        const pt = evalCubicBezier(item.geom, t);
        minViewY = Math.min(minViewY, pt.y - 8);
      }
    });
    minViewY = Math.floor(minViewY);

    const edgesMarkup = preparedEdges.map(item => {
      const { edge, geom, opacity, strokeW, isEdgeSelected, labelText } = item;
      return `
        <g class="topo-edge ${interactive ? 'cursor-pointer' : ''}"
           opacity="${opacity}"
           data-bundle-key="${escapeHtml(edge.key)}"
           data-cable-ids="${escapeHtml(edge.cables.map(c => c.id).join(','))}">
          <desc>${escapeHtml(labelText)}</desc>
          <path class="topo-edge-hit" d="${geom.d}" fill="none" stroke="transparent" stroke-width="14"/>
          <path class="topo-edge-line" d="${geom.d}" fill="none"
                stroke="${isEdgeSelected ? (isLight ? '#0f172a' : '#ffffff') : edge.color}"
                stroke-width="${strokeW + (isEdgeSelected ? 2 : 0)}"
                ${edge.isInterRack ? 'stroke-dasharray="7 4"' : ''}
                stroke-linecap="round"/>
        </g>
      `;
    }).join('');

    const edgeLabelsMarkup = preparedEdges.map(item => {
      const { edge, opacity, isEdgeSelected, labelText, pillW, pillH, labelX, labelY } = item;
      return `
        <g class="topo-edge-badge ${interactive ? 'cursor-pointer' : ''}"
           opacity="${opacity}"
           data-bundle-key="${escapeHtml(edge.key)}"
           data-cable-ids="${escapeHtml(edge.cables.map(c => c.id).join(','))}">
          <rect class="topo-edge-pill"
                x="${(labelX - pillW / 2).toFixed(1)}"
                y="${(labelY - pillH / 2).toFixed(1)}"
                width="${pillW}" height="${pillH}" rx="6"
                fill="${badgeFill}"
                stroke="${edge.isLoopRisk ? '#f59e0b' : edge.color}"
                stroke-width="${edge.isLoopRisk || isEdgeSelected ? '1.6' : '1.1'}"/>
          <text class="topo-edge-label"
                x="${labelX.toFixed(1)}" y="${(labelY + 3.5).toFixed(1)}"
                text-anchor="middle"
                fill="${edge.isLoopRisk ? (isLight ? '#b45309' : '#fbbf24') : pillTextColor}"
                font-size="9.5"
                font-family="JetBrains Mono, monospace">${escapeHtml(labelText)}</text>
        </g>
      `;
    }).join('');

    const nodesMarkup = model.nodes.map(n => {
      const meta = getCategoryMeta(n.category, n.vendor, n.device?.customName || n.template?.name || '');
      const isSelected = interactive && selectedEntity?.type === 'device' && selectedEntity.id === n.id;

      let matchesActiveFilter = true;
      if (activeFilter !== 'ALL') {
        const hasMatchingCable = model.edges.some(e =>
          e.groupId === activeFilter && (e.fromNode.id === n.id || e.toNode.id === n.id)
        );
        matchesActiveFilter = hasMatchingCable;
      }
      const nodeOpacity = matchesActiveFilter || !dimInactive ? 1 : 0.45;
      const displayName = n.device.customName.length > 23
        ? `${n.device.customName.slice(0, 22)}…`
        : n.device.customName;
      const metaLine = `${n.rack?.name || 'Стойка'} · U${n.device.uPosition}${n.device.ipAddress ? ` · ${n.device.ipAddress}` : ''}`;
      const shortMeta = metaLine.length > 31 ? `${metaLine.slice(0, 30)}…` : metaLine;

      return `
        <g class="topo-node"
           opacity="${nodeOpacity}"
           data-device-id="${escapeHtml(n.id)}">
          <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10"
                fill="${nodeFill}"
                stroke="${isSelected ? '#22d3ee' : (n.isExternal ? '#818cf8' : meta.border)}"
                stroke-width="${isSelected ? '2.5' : '1.4'}"
                ${n.isExternal ? 'stroke-dasharray="5 3"' : ''}/>
          <rect x="${n.x}" y="${n.y}" width="6" height="${n.h}" rx="3" fill="${meta.accent}"/>
          <text x="${n.x + 16}" y="${n.y + 22}" fill="${meta.accent}" font-size="9.5" font-weight="700" font-family="JetBrains Mono, monospace">
            ${escapeHtml(meta.label)}${n.isExternal ? ' (Внеш.)' : ''}
          </text>
          <text x="${n.x + 16}" y="${n.y + 42}" fill="${nodeTextPrimary}" font-size="12" font-weight="700" font-family="Inter, sans-serif">
            ${escapeHtml(displayName)}
          </text>
          <text x="${n.x + 16}" y="${n.y + 59}" fill="${nodeTextMuted}" font-size="9.5" font-family="JetBrains Mono, monospace">
            ${escapeHtml(shortMeta)}
          </text>
          <text x="${n.x + 16}" y="${n.y + 74}" fill="${nodeTextMuted}" font-size="9" font-family="JetBrains Mono, monospace">
            Портов занято: ${n.usedPorts} / ${n.totalPorts}
          </text>
        </g>
      `;
    }).join('');

    const totalViewH = model.canvasHeight - minViewY;
    return `
      <svg id="${interactive ? 'topology-svg' : 'print-topology-svg'}"
           viewBox="0 ${minViewY} ${model.canvasWidth} ${totalViewH}"
           width="${model.canvasWidth}"
           height="${totalViewH}"
           style="background:${bgFill}; max-width:100%; height:auto;"
           xmlns="http://www.w3.org/2000/svg">
        <g id="topo-edges-layer">${edgesMarkup}</g>
        <g id="topo-nodes-layer">${nodesMarkup}</g>
        <g id="topo-edge-labels-layer">${edgeLabelsMarkup}</g>
      </svg>
    `;
  }

  render() {
    if (!this.viewport) return;
    const model = this.computeTopologyModel();
    this.lastModel = model;

    const svgContainer = this.viewport.querySelector('#topology-svg-stage');
    const summaryEl = this.viewport.querySelector('#topology-health-summary');
    const resetBtn = this.viewport.querySelector('#btn-topo-reset-layout');

    if (resetBtn) {
      resetBtn.disabled = !model.hasCustomPositions;
    }

    if (summaryEl) {
      const alerts = [];
      if (model.loopCount > 0) {
        alerts.push(`<span class="px-2 py-0.5 rounded bg-amber-950/80 border border-amber-700/70 text-amber-300 font-mono text-[11px]">⚠ Циклы L2 / STP: ${model.loopCount}</span>`);
      }
      if (model.lagCount > 0) {
        alerts.push(`<span class="px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/70 text-cyan-300 font-mono text-[11px]">⚡ Параллельных магистралей (LAG/Trunk): ${model.lagCount}</span>`);
      }
      summaryEl.innerHTML = `
        <span class="text-slate-400 text-xs font-mono">Узлов: <b class="text-slate-200">${model.nodes.length}</b> • Линков на схеме: <b class="text-slate-200">${model.edges.length}</b> (кабелей: ${model.totalCables})</span>
        ${alerts.join('')}
      `;
    }

    if (!svgContainer) return;

    if (model.nodes.length === 0) {
      svgContainer.innerHTML = '<div class="p-10 text-center text-slate-500 text-sm">Нет устройств для отображения на логической схеме. Добавьте устройства в стойку или включите показ несвязанных узлов.</div>';
      return;
    }

    const isLight = document.documentElement.dataset.theme === 'light';
    svgContainer.innerHTML = this.buildSvgMarkup(model, { theme: isLight ? 'light' : 'dark', interactive: true });
    this.applyZoom();

    // Node drag & click handlers
    const svgEl = svgContainer.querySelector('#topology-svg');
    const edgeElMap = new Map();
    const badgeElMap = new Map();
    svgContainer.querySelectorAll('.topo-edge').forEach(el => {
      const key = el.dataset.bundleKey;
      if (key) edgeElMap.set(key, el);
    });
    svgContainer.querySelectorAll('.topo-edge-badge').forEach(el => {
      const key = el.dataset.bundleKey;
      if (key) badgeElMap.set(key, el);
    });

    const renderedEdgeItems = (model.renderedEdges || []).map(item => {
      const edgeG = edgeElMap.get(item.edge.key);
      const badgeG = badgeElMap.get(item.edge.key);
      return {
        item,
        hitPath: edgeG?.querySelector('.topo-edge-hit') || null,
        linePath: edgeG?.querySelector('.topo-edge-line') || null,
        pillRect: badgeG?.querySelector('.topo-edge-pill') || null,
        pillText: badgeG?.querySelector('.topo-edge-label') || null
      };
    });

    svgContainer.querySelectorAll('.topo-node').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !svgEl) return;
        e.stopPropagation();
        const devId = el.dataset.deviceId;
        const nodeModel = model.nodes.find(n => n.id === devId);
        if (!nodeModel) return;

        const pt = this.clientToSvgPoint(svgEl, e.clientX, e.clientY);

        this.dragState = {
          svgEl,
          nodeEl: el,
          nodeModel,
          deviceId: devId,
          origX: nodeModel.x,
          origY: nodeModel.y,
          startSvgX: pt.x,
          startSvgY: pt.y,
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false,
          model,
          renderedEdgeItems
        };
      });

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.suppressNextClick) return;
        const devId = el.dataset.deviceId;
        const loc = findDeviceLocation(store.state, devId);
        if (loc) {
          store.setSelection({ type: 'device', id: devId, data: loc.device });
        }
      });
    });

    // Edge or pill badge click -> select single cable or inspect bundle
    svgContainer.querySelectorAll('.topo-edge, .topo-edge-badge').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const cableIds = (el.dataset.cableIds || '').split(',').filter(Boolean);
        const bundleKey = el.dataset.bundleKey;
        if (cableIds.length === 1) {
          const cable = store.state.cables.find(c => c.id === cableIds[0]);
          if (cable) {
            store.setSelection({ type: 'cable', id: cable.id, data: cable });
          }
        } else if (cableIds.length > 1) {
          const edge = model.edges.find(ed => ed.key === bundleKey);
          store.setSelection({
            type: 'cable_bundle',
            id: bundleKey,
            bundleKey,
            cableIds,
            fromName: edge?.fromNode?.device?.customName || 'Узел А',
            toName: edge?.toNode?.device?.customName || 'Узел Б',
            groupId: edge?.groupId || ''
          });
        }
      });
    });
  }

  clientToSvgPoint(svgEl, clientX, clientY) {
    const ctm = svgEl?.getScreenCTM?.();
    if (!ctm) return { x: clientX, y: clientY };
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  handleDragMove(e) {
    const ds = this.dragState;
    if (!ds) return;

    const dist = Math.hypot(e.clientX - ds.startClientX, e.clientY - ds.startClientY);
    if (!ds.moved) {
      if (dist < 4) return;
      ds.moved = true;
      document.body.classList.add('is-dragging-topo-node');
      ds.svgEl.classList.add('topo-dragging');
      ds.nodeEl.classList.add('is-dragging');
      ds.nodeEl.parentNode?.appendChild(ds.nodeEl);
    }

    const pt = this.clientToSvgPoint(ds.svgEl, e.clientX, e.clientY);
    const nextX = Math.max(16, Math.round(ds.origX + (pt.x - ds.startSvgX)));
    const nextY = Math.max(16, Math.round(ds.origY + (pt.y - ds.startSvgY)));

    ds.nodeModel.x = nextX;
    ds.nodeModel.y = nextY;
    ds.nodeEl.setAttribute('transform', `translate(${nextX - ds.origX}, ${nextY - ds.origY})`);

    ds.renderedEdgeItems.forEach(entry => {
      if (entry.item.edge.fromNode.id === ds.deviceId || entry.item.edge.toNode.id === ds.deviceId) {
        entry.item.geom = computeTopologyEdgeGeometry(entry.item.edge.fromNode, entry.item.edge.toNode, entry.item.edge);
        if (entry.hitPath) entry.hitPath.setAttribute('d', entry.item.geom.d);
        if (entry.linePath) entry.linePath.setAttribute('d', entry.item.geom.d);
      }
    });

    const nodeBoxes = ds.model.nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    resolveTopologyEdgeLabels(
      ds.renderedEdgeItems.map(entry => entry.item),
      nodeBoxes,
      ds.model.canvasWidth
    );

    ds.renderedEdgeItems.forEach(entry => {
      const { labelX, labelY, pillW, pillH } = entry.item;
      if (entry.pillRect) {
        entry.pillRect.setAttribute('x', (labelX - pillW / 2).toFixed(1));
        entry.pillRect.setAttribute('y', (labelY - pillH / 2).toFixed(1));
      }
      if (entry.pillText) {
        entry.pillText.setAttribute('x', labelX.toFixed(1));
        entry.pillText.setAttribute('y', (labelY + 3.5).toFixed(1));
      }
    });
  }

  handleDragEnd() {
    const ds = this.dragState;
    if (!ds) return;
    this.dragState = null;

    document.body.classList.remove('is-dragging-topo-node');
    ds.svgEl?.classList.remove('topo-dragging');
    ds.nodeEl?.classList.remove('is-dragging');

    if (!ds.moved) return;

    clearTimeout(this.suppressTimer);
    this.suppressNextClick = true;
    this.suppressTimer = setTimeout(() => {
      this.suppressNextClick = false;
    }, 60);

    store.setTopologyNodePosition(this.getScopeKey(), ds.deviceId, ds.nodeModel.x, ds.nodeModel.y);
  }
}
