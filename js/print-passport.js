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

  getOptions() {
    const isChecked = (id, fallback = true) => {
      const el = this.modal?.querySelector(`#${id}`);
      return el ? el.checked : fallback;
    };
    return {
      includeSummary: isChecked('print-opt-summary', true),
      includeRack: isChecked('print-opt-rack', true),
      includeTopology: isChecked('print-opt-topology', true),
      includeCables: isChecked('print-opt-cables', true),
      includeDevices: isChecked('print-opt-devices', true),
      includeCli: isChecked('print-opt-cli', false),
      topologyScope: this.modal?.querySelector('#print-opt-scope')?.value || 'active'
    };
  }

  open() {
    if (!this.modal) return;
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

  captureRackSnapshotMarkup() {
    if (typeof this.onEnsureRackRendered === 'function') {
      this.onEnsureRackRendered();
    }
    const stage = document.getElementById('rack-zoom-stage');
    if (!stage) return '';

    const clone = stage.cloneNode(true);
    clone.removeAttribute('id');
    clone.style.transform = '';
    clone.style.width = '760px';
    clone.style.paddingBottom = '16px';

    const stageW = stage.offsetWidth || 760;
    const stageH = stage.offsetHeight || 600;
    const clonedSvg = clone.querySelector('#cables-svg');
    if (clonedSvg) {
      clonedSvg.removeAttribute('id');
      clonedSvg.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
      clonedSvg.setAttribute('width', String(stageW));
      clonedSvg.setAttribute('height', String(stageH));
    }
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

    // Scale cleanly to ~660px printable width while keeping exact SVG alignment
    const fitScale = 660 / stageW;
    const scaledH = Math.round(stageH * fitScale);

    return `
      <div class="print-rack-wrap" style="width: 660px; height: ${scaledH}px; overflow: hidden; margin: 0 auto; border-radius: 10px; background: #0f1115; padding: 6px; box-sizing: content-box;">
        <div style="position: relative; width: ${stageW}px; height: ${stageH}px; transform: scale(${fitScale.toFixed(4)}); transform-origin: top left;">
          ${clone.innerHTML}
        </div>
      </div>
    `;
  }

  buildReportHtml() {
    const rack = store.getActiveRack();
    if (!rack) return '<p>Нет активной стойки</p>';

    const opts = this.getOptions();
    const groups = store.getGroups(rack.id);
    const cables = store.getCablesForActiveRack();

    const occupiedUnits = rack.installedDevices.reduce((sum, d) => {
      const tpl = store.getTemplate(d.templateId);
      return sum + (tpl?.uHeight || 1);
    }, 0);
    const totalPowerW = rack.installedDevices.reduce((sum, d) => {
      const tpl = store.getTemplate(d.templateId);
      return sum + (tpl?.powerW || 0);
    }, 0);
    const interRackCount = cables.filter(c => store.isInterRackCable(c)).length;
    const dateStr = new Date().toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const parts = [];

    if (opts.includeSummary) {
      parts.push(`
        <section class="print-section print-header-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:14px;">
            <div>
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#0284c7; font-weight:700;">RackStudio PRO • Паспорт монтажного шкафа</div>
              <h1 style="font-size:20px; font-weight:800; color:#0f172a; margin:4px 0 2px;">${escapeHtml(rack.name)}</h1>
              <div style="font-size:12px; color:#475569;">Конструктив: ${escapeHtml(rack.model || `19" ${rack.uHeight}U`)}</div>
            </div>
            <div style="text-align:right; font-size:11px; color:#475569;">
              <div>Сформировано: <b>${escapeHtml(dateStr)}</b></div>
              <div>Всего стоек в проекте: <b>${store.getRacks().length}</b></div>
            </div>
          </div>

          <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:12px;">
            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px 10px; background:#f8fafc;">
              <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Занятость юнитов</div>
              <div style="font-size:16px; font-weight:700; color:#0f172a;">${occupiedUnits} / ${rack.uHeight} U</div>
            </div>
            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px 10px; background:#f8fafc;">
              <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Оборудование</div>
              <div style="font-size:16px; font-weight:700; color:#0f172a;">${rack.installedDevices.length} устр.</div>
            </div>
            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px 10px; background:#f8fafc;">
              <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Базовая мощность</div>
              <div style="font-size:16px; font-weight:700; color:#b45309;">${totalPowerW} Вт</div>
            </div>
            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px 10px; background:#f8fafc;">
              <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Патч-корды</div>
              <div style="font-size:16px; font-weight:700; color:#0369a1;">${cables.length} шт.${interRackCount > 0 ? ` (${interRackCount} межст.)` : ''}</div>
            </div>
          </div>

          ${groups.length > 0 ? `
            <div style="font-size:11px; color:#334155; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              <span style="font-weight:700;">Рабочие группы / VLAN:</span>
              ${groups.map(g => `
                <span style="display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border:1px solid #cbd5e1; border-radius:999px; background:#fff;">
                  <span style="width:8px; height:8px; border-radius:50%; background:${escapeHtml(g.color)}; display:inline-block;"></span>
                  <span>${escapeHtml(g.name)} (VLAN ${escapeHtml(g.vlan || 10)})</span>
                </span>
              `).join('')}
            </div>
          ` : ''}
        </section>
      `);
    }

    if (opts.includeRack) {
      parts.push(`
        <section class="print-section" style="margin-top:16px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            1. Монтажная схема шкафа (${escapeHtml(rack.name)})
          </h2>
          ${this.captureRackSnapshotMarkup()}
        </section>
      `);
    }

    if (opts.includeTopology && this.topologyRenderer) {
      const model = this.topologyRenderer.computeTopologyModel({
        scope: opts.topologyScope,
        aggregateBundles: true,
        showStandalone: true
      });
      const topoSvg = model.nodes.length > 0
        ? this.topologyRenderer.buildSvgMarkup(model, { theme: 'light', interactive: false })
        : '<div style="font-size:12px; color:#64748b;">Нет узлов для логической схемы</div>';

      parts.push(`
        <section class="print-section" style="margin-top:18px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            Логическая топология сети (${opts.topologyScope === 'all' ? 'Все стойки' : escapeHtml(rack.name)})
          </h2>
          <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px; background:#ffffff; text-align:center;">
            ${topoSvg}
          </div>
        </section>
      `);
    }

    if (opts.includeCables) {
      parts.push(`
        <section class="print-section" style="margin-top:18px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            Журнал подключений (Патч-корды: ${cables.length})
          </h2>
          ${cables.length === 0 ? '<p style="font-size:12px; color:#64748b;">Нет подключённых кабелей.</p>' : `
            <table style="width:100%; border-collapse:collapse; font-size:11px; color:#0f172a;">
              <thead>
                <tr style="background:#f1f5f9; text-align:left;">
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">№</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Сторона А</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Сторона Б</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Группа / VLAN</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Тип кабеля</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Длина</th>
                  <th style="border:1px solid #cbd5e1; padding:5px 7px;">Метка</th>
                </tr>
              </thead>
              <tbody>
                ${cables.map((c, idx) => {
                  const fromLoc = findDeviceLocation(store.state, c.from.deviceId);
                  const toLoc = findDeviceLocation(store.state, c.to.deviceId);
                  const inter = store.isInterRackCable(c);
                  const grp = c.groupId ? store.getGroup(c.groupId) : null;
                  const fromPort = getPortDisplayName(fromLoc?.template, c.from.portId);
                  const toPort = getPortDisplayName(toLoc?.template, c.to.portId);
                  const fromLabel = `${inter && fromLoc ? `[${fromLoc.rack.name}] ` : ''}${fromLoc?.device?.customName || c.from.deviceId} : ${fromPort}`;
                  const toLabel = `${inter && toLoc ? `[${toLoc.rack.name}] ` : ''}${toLoc?.device?.customName || c.to.deviceId} : ${toPort}`;
                  return `
                    <tr>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${idx + 1}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(fromLabel)}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px; font-family:monospace;">${escapeHtml(toLabel)}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px;">${grp ? `${escapeHtml(grp.name)} (VLAN ${escapeHtml(grp.vlan || 10)})` : 'Инфраструктура'}</td>
                      <td style="border:1px solid #cbd5e1; padding:4px 7px;">${escapeHtml(c.type)}${inter ? ' (Межст.)' : ''}</td>
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

    if (opts.includeDevices) {
      const sortedDevs = [...rack.installedDevices].sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
      parts.push(`
        <section class="print-section" style="margin-top:18px;">
          <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
            Состав оборудования (${sortedDevs.length} устр.)
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

    if (opts.includeCli) {
      const cliDevs = [...rack.installedDevices]
        .filter(d => d.cliConfig && d.cliConfig.trim())
        .sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));
      if (cliDevs.length > 0) {
        parts.push(`
          <section class="print-section" style="margin-top:18px;">
            <h2 style="font-size:14px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:10px;">
              Конфигурации CLI устройств (${cliDevs.length})
            </h2>
            ${cliDevs.map(d => `
              <div style="margin-bottom:12px; border:1px solid #cbd5e1; border-radius:6px; overflow:hidden; break-inside:avoid;">
                <div style="background:#f1f5f9; padding:5px 8px; font-size:11px; font-weight:700; color:#0f172a; border-bottom:1px solid #cbd5e1;">
                  ${escapeHtml(d.customName)} (U${d.uPosition}${d.ipAddress ? ` • ${escapeHtml(d.ipAddress)}` : ''})
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
