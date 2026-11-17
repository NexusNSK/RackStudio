/**
 * RackStudio - Rack Passport & Print / PDF Exporter
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

export class PrintPassport {
  constructor({ modalElement, reportRoot, topologyRenderer, onEnsureRackRendered }) {
    this.modal = modalElement;
    this.reportRoot = reportRoot;
    this.topologyRenderer = topologyRenderer;
    this.onEnsureRackRendered = onEnsureRackRendered;
    this.initEvents();
  }

  initEvents() {
    if (!this.modal) return;

    this.modal.querySelector('#close-print-modal')?.addEventListener('click', () => this.close());
    this.modal.querySelector('#btn-cancel-print-modal')?.addEventListener('click', () => this.close());
    this.modal.querySelector('#btn-execute-print')?.addEventListener('click', () => this.printToPdf());

    const optionIds = [
      'print-opt-summary',
      'print-opt-rack',
      'print-opt-topology',
      'print-opt-cables',
      'print-opt-devices',
      'print-opt-cli'
    ];
    optionIds.forEach(id => {
      this.modal.querySelector(`#${id}`)?.addEventListener('change', () => {
        this.refreshReport();
      });
    });

    this.modal.querySelector('#print-opt-scope')?.addEventListener('change', () => {
      this.refreshReport();
    });
  }

  updateScopeSelectLabels() {
    const scopeSelect = this.modal?.querySelector('#print-opt-scope');
    if (!scopeSelect) return;
    const activeRack = store.getActiveRack();
    const racks = store.getRacks();
    const optActive = scopeSelect.querySelector('option[value="active"]');
    const optAll = scopeSelect.querySelector('option[value="all"]');
    if (optActive) {
      optActive.textContent = activeRack ? `Активная стойка (${activeRack.name})` : 'Активная стойка';
    }
    if (optAll) {
      optAll.textContent = `Все стойки проекта (${racks.length} шт.)`;
    }
  }

  getOptions() {
    const isChecked = (id, fallback = true) => {
      const el = this.modal?.querySelector(`#${id}`);
      return el ? el.checked : fallback;
    };
    const scopeVal = this.modal?.querySelector('#print-opt-scope')?.value || 'active';
    return {
      includeSummary: isChecked('print-opt-summary', true),
      includeRack: isChecked('print-opt-rack', true),
      includeTopology: isChecked('print-opt-topology', true),
      includeCables: isChecked('print-opt-cables', true),
      includeDevices: isChecked('print-opt-devices', true),
      includeCli: isChecked('print-opt-cli', false),
      scope: scopeVal,
      topologyScope: scopeVal
    };
  }

  open() {
    if (!this.modal) return;
    this.updateScopeSelectLabels();
    this.refreshReport();
    this.modal.classList.remove('hidden');
    this.modal.classList.add('flex');
    this.modal.style.display = 'flex';
  }

  close() {
    if (!this.modal) return;
    this.modal.classList.add('hidden');
    this.modal.classList.remove('flex');
    this.modal.style.display = 'none';
  }

  stripSnapshotInteractivity(rootEl) {
    if (!rootEl) return;
    // Remove UI action buttons that belong to the live editor, not a printable diagram
    rootEl.querySelectorAll(
      'button[onclick*="openEditRackModal"], button[onclick*="deleteRackConfirm"], .slot-empty button'
    ).forEach(btn => btn.remove());

    const headerDivider = rootEl.querySelector('.rack-cabinet .w-px');
    if (headerDivider) headerDivider.remove();

    const stripNodeAttrs = (node) => {
      Array.from(node.attributes || []).forEach(attr => {
        if (attr.name.toLowerCase().startsWith('on') || attr.name === 'draggable' || attr.name === 'tabindex') {
          node.removeAttribute(attr.name);
        }
      });
      if (node.classList) {
        node.classList.remove('cursor-grab', 'cursor-pointer', 'hover:brightness-105', 'group');
      }
      if (node.style && node.style.cursor) {
        node.style.cursor = 'default';
      }
    };

    stripNodeAttrs(rootEl);
    rootEl.querySelectorAll('*').forEach(stripNodeAttrs);
  }

  captureRackSnapshotMarkup(targetRackId = null, snapshotOpts = null) {
    if (typeof this.onEnsureRackRendered === 'function') {
      this.onEnsureRackRendered(targetRackId, snapshotOpts);
    }
    const stage = document.getElementById('rack-zoom-stage');
    if (!stage) return '';

    const stageW = stage.offsetWidth || 760;
    const stageH = stage.offsetHeight || 600;

    // Measure full SVG cable extents (including side channels & inter-rack badges outside [0..stageW])
    let extraLeft = 0;
    let extraRight = 0;
    let extraTop = 0;
    let extraBottom = 0;
    const liveCablesLayer = document.getElementById('cables-layer');
    if (liveCablesLayer && liveCablesLayer.childElementCount > 0) {
      try {
        const bbox = liveCablesLayer.getBBox();
        const pad = 16;
        if (Number.isFinite(bbox.x) && Number.isFinite(bbox.width)) {
          extraLeft = Math.max(0, Math.ceil(-(bbox.x - pad)));
          extraRight = Math.max(0, Math.ceil((bbox.x + bbox.width + pad) - stageW));
          extraTop = Math.max(0, Math.ceil(-(bbox.y - pad)));
          extraBottom = Math.max(0, Math.ceil((bbox.y + bbox.height + pad) - stageH));
        }
      } catch {
        // Fallback padding if SVG is not measurable
        extraLeft = 48;
        extraRight = 48;
      }
    }

    const totalW = stageW + extraLeft + extraRight;
    const totalH = stageH + extraTop + extraBottom;

    const clone = stage.cloneNode(true);
    this.stripSnapshotInteractivity(clone);

    const clonedRack = clone.querySelector('#rack-container');
    if (clonedRack) {
      clonedRack.style.position = 'relative';
      clonedRack.style.left = `${extraLeft}px`;
      clonedRack.style.top = `${extraTop}px`;
      clonedRack.style.width = `${stageW}px`;
    }

    const clonedSvg = clone.querySelector('#cables-svg');
    if (clonedSvg) {
      clonedSvg.removeAttribute('id');
      clonedSvg.setAttribute('viewBox', `${-extraLeft} ${-extraTop} ${totalW} ${totalH}`);
      clonedSvg.setAttribute('width', String(totalW));
      clonedSvg.setAttribute('height', String(totalH));
      clonedSvg.setAttribute('class', 'pointer-events-none z-30 overflow-visible');
      clonedSvg.style.position = 'absolute';
      clonedSvg.style.left = '0';
      clonedSvg.style.top = '0';
      clonedSvg.style.width = `${totalW}px`;
      clonedSvg.style.height = `${totalH}px`;
      clonedSvg.style.pointerEvents = 'none';

      // Always render SVG bridge casings with light theme styling in passport snapshot (saving printer toner)
      clonedSvg.querySelectorAll('.cable-casing').forEach(p => {
        p.setAttribute('stroke', '#f8fafc');
      });
      clonedSvg.querySelectorAll('.cable-shadow').forEach(p => {
        p.setAttribute('stroke-opacity', '0');
      });
    }
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

    // Dynamically scale rack to fit A4 page height when combined with title summary
    const maxPrintH = (snapshotOpts && snapshotOpts.maxHeight) || (snapshotOpts && snapshotOpts.fitFirstPage ? 820 : null);
    const maxPrintW = (snapshotOpts && snapshotOpts.maxWidth) || 660;

    const scaleW = maxPrintW / totalW;
    const scaleH = maxPrintH ? (maxPrintH / totalH) : scaleW;
    const fitScale = maxPrintH ? Math.min(scaleW, scaleH) : scaleW;

    const scaledW = Math.round(totalW * fitScale);
    const scaledH = Math.round(totalH * fitScale);
    const wrapBg = '#f1f5f9; border: 1px solid #cbd5e1';

    return `
      <div class="print-rack-wrap" inert style="width: ${scaledW}px; height: ${scaledH}px; overflow: hidden; margin: 0 auto; border-radius: 10px; background: ${wrapBg}; padding: 6px; box-sizing: content-box; pointer-events: none; user-select: none;">
        <div style="position: relative; width: ${totalW}px; height: ${totalH}px; transform: scale(${fitScale.toFixed(4)}); transform-origin: top left; pointer-events: none;">
          ${clone.innerHTML}
        </div>
      </div>
    `;
  }

  buildReportHtml() {
    const allRacks = store.getRacks();
    if (allRacks.length === 0) return '<p>Нет стоек в проекте</p>';

    const activeRack = store.getActiveRack();
    const opts = this.getOptions();
    const isAllScope = opts.scope === 'all';

    if (!isAllScope && !activeRack) {
      return '<p>Нет активной стойки</p>';
    }

    const dateStr = new Date().toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const parts = [];

    // --- Section 1: All Racks Scope Summary & Diagrams ---
    if (isAllScope) {
      if (opts.includeSummary) {
        const totalOccupiedU = allRacks.reduce((sum, r) => {
          return sum + r.installedDevices.reduce((dSum, d) => {
            const tpl = store.getTemplate(d.templateId);
            return dSum + (tpl?.uHeight || 1);
          }, 0);
        }, 0);
        const totalCapacityU = allRacks.reduce((sum, r) => sum + (r.uHeight || 42), 0);
        const totalDevCount = allRacks.reduce((sum, r) => sum + r.installedDevices.length, 0);
        const totalPowerW = allRacks.reduce((sum, r) => {
          return sum + r.installedDevices.reduce((dSum, d) => {
            const tpl = store.getTemplate(d.templateId);
            return dSum + (tpl?.powerW || 0);
          }, 0);
        }, 0);
        const allCables = store.state.cables || [];
        const interRackCount = allCables.filter(c => store.isInterRackCable(c)).length;
        const intraRackCount = allCables.length - interRackCount;
        const allGroups = store.state.connectionGroups || [];

        parts.push(`
          <section class="print-section print-header-card" style="page-break-after:always; break-after:page;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0f172a; padding-bottom:8px; margin-bottom:10px;">
              <div>
                <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#0284c7; font-weight:700;">Сводный паспорт серверных стоек проекта</div>
                <h1 style="font-size:20px; font-weight:800; color:#0f172a; margin:4px 0 2px;">Все стойки проекта (${allRacks.length} шт.)</h1>
                <div style="font-size:12px; color:#475569;">Сводная спецификация и схемы коммутации проекта</div>
              </div>
              <div style="text-align:right; font-size:11px; color:#475569;">
                <div>Сформировано: <b>${escapeHtml(dateStr)}</b></div>
                <div>Всего стоек: <b>${allRacks.length}</b></div>
              </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-bottom:10px;">
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:6px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Занятость юнитов</div>
                <div style="font-size:15px; font-weight:700; color:#0f172a;">${totalOccupiedU} / ${totalCapacityU} U</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:6px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Оборудование</div>
                <div style="font-size:15px; font-weight:700; color:#0f172a;">${totalDevCount} устр.</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:6px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Базовая мощность</div>
                <div style="font-size:15px; font-weight:700; color:#b45309;">${totalPowerW} Вт</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:6px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Патч-корды</div>
                <div style="font-size:15px; font-weight:700; color:#0369a1;">${allCables.length} шт.${interRackCount > 0 ? ` (${intraRackCount} внутр. / ${interRackCount} межст.)` : ''}</div>
              </div>
            </div>

            ${allGroups.length > 0 ? `
              <div style="font-size:11px; color:#334155; display:flex; flex-wrap:wrap; gap:5px; align-items:center;">
                <span style="font-weight:700;">Рабочие группы проекта:</span>
                ${allGroups.map(g => `
                  <span style="display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border:1px solid #cbd5e1; border-radius:999px; background:#fff; font-size:10px;">
                    <span style="width:7px; height:7px; border-radius:50%; background:${escapeHtml(g.color)}; display:inline-block;"></span>
                    <span>${escapeHtml(g.name)}</span>
                  </span>
                `).join('')}
              </div>
            ` : ''}
          </section>
        `);
      }

      if (opts.includeRack) {
        const rackBlocks = allRacks.map((r, idx) => {
          const rOccupied = r.installedDevices.reduce((sum, d) => sum + (store.getTemplate(d.templateId)?.uHeight || 1), 0);
          const rPower = r.installedDevices.reduce((sum, d) => sum + (store.getTemplate(d.templateId)?.powerW || 0), 0);
          const rCables = store.getCablesForRack(r.id);
          return `
            <div style="margin-bottom:20px; page-break-inside:avoid; break-inside:avoid;">
              <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
                <h3 style="font-size:13px; font-weight:700; color:#0f172a; margin:0;">
                  1.${idx + 1}. Стойка "${escapeHtml(r.name)}" (${escapeHtml(r.model || `19" ${r.uHeight}U`)})
                </h3>
                <div style="font-size:11px; color:#475569;">
                  Занятость: <b>${rOccupied}/${r.uHeight}U</b> • Оборудование: <b>${r.installedDevices.length}</b> • Мощность: <b>${rPower} Вт</b> • Кабели: <b>${rCables.length}</b>
                </div>
              </div>
              ${this.captureRackSnapshotMarkup(r.id)}
            </div>
          `;
        }).join('');

        parts.push(`
          <section class="print-section" style="margin-top:16px;">
            <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:2px solid #cbd5e1; padding-bottom:6px; margin-bottom:14px;">
              1. Монтажные схемы стоек (${allRacks.length} шт.)
            </h2>
            ${rackBlocks}
          </section>
        `);
      }
    } else {
      // --- Active Rack Scope: Unified Titular Page (Summary + Rack Visualization) ---
      if (opts.includeSummary || opts.includeRack) {
        const occupiedUnits = activeRack.installedDevices.reduce((sum, d) => {
          const tpl = store.getTemplate(d.templateId);
          return sum + (tpl?.uHeight || 1);
        }, 0);
        const totalPowerW = activeRack.installedDevices.reduce((sum, d) => {
          const tpl = store.getTemplate(d.templateId);
          return sum + (tpl?.powerW || 0);
        }, 0);
        const cables = store.getCablesForActiveRack();
        const interRackCount = cables.filter(c => store.isInterRackCable(c)).length;
        const groups = store.getGroups(activeRack.id);

        const summaryHtml = opts.includeSummary ? `
          <div class="print-header-card" style="border-bottom:2px solid #0f172a; padding-bottom:8px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <div>
                <h1 style="font-size:20px; font-weight:800; color:#0f172a; margin:0 0 2px;">${escapeHtml(activeRack.name)}</h1>
                <div style="font-size:12px; color:#475569;">Конструктив: ${escapeHtml(activeRack.model || `19" ${activeRack.uHeight}U`)}</div>
              </div>
              <div style="text-align:right; font-size:11px; color:#475569;">
                <div>Сформировано: <b>${escapeHtml(dateStr)}</b></div>
                <div>Всего стоек в проекте: <b>${allRacks.length}</b></div>
              </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-bottom:8px;">
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:5px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Занятость юнитов</div>
                <div style="font-size:15px; font-weight:700; color:#0f172a;">${occupiedUnits} / ${activeRack.uHeight} U</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:5px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Оборудование</div>
                <div style="font-size:15px; font-weight:700; color:#0f172a;">${activeRack.installedDevices.length} устр.</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:6px; padding:5px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Базовая мощность</div>
                <div style="font-size:15px; font-weight:700; color:#b45309;">${totalPowerW} Вт</div>
              </div>
              <div style="border:1px solid #cbd5e1; border-radius:8px; padding:5px 8px; background:#f8fafc;">
                <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Патч-корды</div>
                <div style="font-size:15px; font-weight:700; color:#0369a1;">${cables.length} шт.${interRackCount > 0 ? ` (${interRackCount} межст.)` : ''}</div>
              </div>
            </div>

            ${groups.length > 0 ? `
              <div style="font-size:11px; color:#334155; display:flex; flex-wrap:wrap; gap:5px; align-items:center;">
                <span style="font-weight:700;">Рабочие группы:</span>
                ${groups.map(g => `
                  <span style="display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border:1px solid #cbd5e1; border-radius:999px; background:#fff; font-size:10px;">
                    <span style="width:7px; height:7px; border-radius:50%; background:${escapeHtml(g.color)}; display:inline-block;"></span>
                    <span>${escapeHtml(g.name)}</span>
                  </span>
                `).join('')}
              </div>
            ` : ''}
          </div>
        ` : '';

        const rackHtml = opts.includeRack ? `
          <div style="text-align:center;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
              <h2 style="font-size:13px; font-weight:700; color:#0f172a; margin:0;">
                1. Монтажная схема шкафа (${escapeHtml(activeRack.name)})
              </h2>
            </div>
            ${this.captureRackSnapshotMarkup(activeRack.id, { fitFirstPage: opts.includeSummary })}
          </div>
        ` : '';

        parts.push(`
          <section class="print-section print-titular-page" style="page-break-after:always; break-after:page;">
            ${summaryHtml}
            ${rackHtml}
          </section>
        `);
      }
    }

    // --- Section 2: Topology ---
    if (opts.includeTopology && this.topologyRenderer) {
      const model = this.topologyRenderer.computeTopologyModel({
        scope: isAllScope ? 'all' : 'active',
        aggregateBundles: true,
        showStandalone: true
      });
      const topoSvg = model.nodes.length > 0
        ? this.topologyRenderer.buildSvgMarkup(model, { theme: 'light', interactive: false })
        : '<div style="font-size:12px; color:#64748b;">Нет узлов для логической схемы</div>';

      parts.push(`
        <section class="print-section" style="margin-top:18px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            2. Логическая топология сети (${isAllScope ? `Все стойки (${allRacks.length} шт.)` : escapeHtml(activeRack.name)})
          </h2>
          <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px; background:#ffffff; text-align:center;">
            ${topoSvg}
          </div>
        </section>
      `);
    }

    // --- Section 3: Cables ---
    if (opts.includeCables) {
      const cablesToRender = isAllScope ? (store.state.cables || []) : store.getCablesForActiveRack();
      const sectionTitle = isAllScope
        ? `3. Сводный журнал подключений (Патч-корды: ${cablesToRender.length})`
        : `3. Журнал подключений (Патч-корды: ${cablesToRender.length})`;

      parts.push(`
        <section class="print-section" style="margin-top:18px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            ${sectionTitle}
          </h2>
          ${cablesToRender.length === 0 ? '<p style="font-size:12px; color:#64748b;">Нет подключённых кабелей.</p>' : `
            <table style="width:100%; border-collapse:collapse; font-size:11px; color:#0f172a;">
              <thead>
                <tr style="background:#f1f5f9; text-align:left;">
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">№</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Сторона А</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Сторона Б</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Группа</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Тип кабеля</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Длина</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Метка</th>
                </tr>
              </thead>
              <tbody>
                ${cablesToRender.map((c, idx) => {
                  const fromLoc = findDeviceLocation(store.state, c.from.deviceId);
                  const toLoc = findDeviceLocation(store.state, c.to.deviceId);
                  const inter = store.isInterRackCable(c);
                  const grp = c.groupId ? store.getGroup(c.groupId) : null;
                  const fromPort = getPortDisplayName(fromLoc?.template, c.from.portId);
                  const toPort = getPortDisplayName(toLoc?.template, c.to.portId);
                  const fromPrefix = isAllScope
                    ? (fromLoc?.rack?.name ? `[${fromLoc.rack.name}] ` : '')
                    : (inter && fromLoc ? `[${fromLoc.rack.name}] ` : '');
                  const toPrefix = isAllScope
                    ? (toLoc?.rack?.name ? `[${toLoc.rack.name}] ` : '')
                    : (inter && toLoc ? `[${toLoc.rack.name}] ` : '');
                  const fromLabel = `${fromPrefix}${fromLoc?.device?.customName || c.from.deviceId} : ${fromPort}`;
                  const toLabel = `${toPrefix}${toLoc?.device?.customName || c.to.deviceId} : ${toPort}`;
                  const typeLabel = isAllScope
                    ? `${escapeHtml(c.type)}${inter ? ' (Межст.)' : ' (Внутр.)'}`
                    : `${escapeHtml(c.type)}${inter ? ' (Межст.)' : ''}`;
                  return `
                    <tr>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${idx + 1}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(fromLabel)}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(toLabel)}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px;">${grp ? escapeHtml(grp.name) : 'Инфраструктура'}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px;">${typeLabel}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(c.lengthM)} м</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(c.label || '—')}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </section>
      `);
    }

    // --- Section 4: Devices ---
    if (opts.includeDevices) {
      if (isAllScope) {
        const allDeviceRows = [];
        allRacks.forEach(r => {
          const sorted = [...r.installedDevices].sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
          sorted.forEach(dev => {
            allDeviceRows.push({ dev, rack: r });
          });
        });

        parts.push(`
          <section class="print-section" style="margin-top:18px;">
            <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
              4. Сводная спецификация оборудования (${allDeviceRows.length} устр.)
            </h2>
            ${allDeviceRows.length === 0 ? '<p style="font-size:12px; color:#64748b;">В проекте нет оборудования.</p>' : `
              <table style="width:100%; border-collapse:collapse; font-size:11px; color:#0f172a;">
                <thead>
                  <tr style="background:#f1f5f9; text-align:left;">
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Стойка</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Юнит</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Имя в стойке</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Модель / Вендор</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">IP управления</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Примечания</th>
                  </tr>
                </thead>
                <tbody>
                  ${allDeviceRows.map(({ dev, rack: devRack }) => {
                    const tpl = store.getTemplate(dev.templateId);
                    return `
                      <tr>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-weight:600;">${escapeHtml(devRack.name)}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">U${dev.uPosition} (${tpl?.uHeight || 1}U)</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-weight:600;">${escapeHtml(dev.customName)}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(tpl?.vendor || '')} ${escapeHtml(tpl?.name || '')}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(dev.ipAddress || '—')}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(dev.notes || '—')}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            `}
          </section>
        `);
      } else {
        const sortedDevs = [...activeRack.installedDevices].sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
        parts.push(`
          <section class="print-section" style="margin-top:18px;">
            <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
              4. Состав оборудования (${sortedDevs.length} устр.)
            </h2>
            ${sortedDevs.length === 0 ? '<p style="font-size:12px; color:#64748b;">Стойка пуста.</p>' : `
              <table style="width:100%; border-collapse:collapse; font-size:11px; color:#0f172a;">
                <thead>
                  <tr style="background:#f1f5f9; text-align:left;">
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Юнит</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Имя в стойке</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Модель / Вендор</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">IP управления</th>
                    <th style="border:1px solid #cbd5e1; padding:5px 7px;">Примечания</th>
                  </tr>
                </thead>
                <tbody>
                  ${sortedDevs.map(dev => {
                    const tpl = store.getTemplate(dev.templateId);
                    return `
                      <tr>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">U${dev.uPosition} (${tpl?.uHeight || 1}U)</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-weight:600;">${escapeHtml(dev.customName)}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(tpl?.vendor || '')} ${escapeHtml(tpl?.name || '')}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(dev.ipAddress || '—')}</td>
                        <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(dev.notes || '—')}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            `}
          </section>
        `);
      }
    }

    // --- Section 5: CLI Configs ---
    if (opts.includeCli) {
      const cliDevs = [];
      if (isAllScope) {
        allRacks.forEach(r => {
          const devs = [...r.installedDevices]
            .filter(d => d.cliConfig && d.cliConfig.trim())
            .sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
          devs.forEach(dev => {
            cliDevs.push({ dev, rack: r });
          });
        });
      } else {
        const devs = [...activeRack.installedDevices]
          .filter(d => d.cliConfig && d.cliConfig.trim())
          .sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
        devs.forEach(dev => {
          cliDevs.push({ dev, rack: activeRack });
        });
      }

      if (cliDevs.length > 0) {
        parts.push(`
          <section class="print-section" style="margin-top:18px;">
            <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
              5. Конфигурации CLI устройств (${cliDevs.length})
            </h2>
            ${cliDevs.map(({ dev: d, rack: devRack }) => `
              <div style="margin-bottom:12px; border:1px solid #cbd5e1; border-radius:6px; overflow:hidden; break-inside:avoid;">
                <div style="background:#f1f5f9; padding:5px 8px; font-size:11px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1;">
                  ${isAllScope ? `[${escapeHtml(devRack.name)}] ` : ''}${escapeHtml(d.customName)} (U${d.uPosition}${d.ipAddress ? ` • ${escapeHtml(d.ipAddress)}` : ''})
                </div>
                <pre style="margin:0; padding:8px; font-family:monospace; font-size:10px; white-space:pre-wrap; background:#ffffff; color:#1e293b;">${escapeHtml(d.cliConfig)}</pre>
              </div>
            `).join('')}
          </section>
        `);
      }
    }

    if (parts.length === 0) {
      parts.push('<p style="font-size:13px; color:#64748b;">Выберите хотя бы один раздел паспорта слева.</p>');
    }

    return `<div class="print-passport-sheet">${parts.join('')}</div>`;
  }

  refreshReport() {
    this.updateScopeSelectLabels();
    const html = this.buildReportHtml();
    const previewEl = this.modal?.querySelector('#print-preview-container');
    if (previewEl) {
      previewEl.innerHTML = html;
    }
    if (this.reportRoot) {
      this.reportRoot.innerHTML = html;
    }
  }

  printToPdf() {
    this.refreshReport();
    window.print();
  }
}
