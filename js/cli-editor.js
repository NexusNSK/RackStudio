/**
 * RackStudio - Switch CLI Configuration Manager
 */

import { store } from './state.js';

export class CliEditor {
  constructor(modalElement) {
    this.modal = modalElement;
    this.currentDeviceId = null;
    this.initEvents();
  }

  initEvents() {
    this.modal.querySelector('#close-cli-modal')?.addEventListener('click', () => {
      this.close();
    });

    this.modal.querySelector('#cli-copy-btn')?.addEventListener('click', () => {
      this.copyToClipboard();
    });

    this.modal.querySelector('#cli-download-btn')?.addEventListener('click', () => {
      this.downloadConfig();
    });

    this.modal.querySelector('#cli-generate-btn')?.addEventListener('click', () => {
      this.generateFromConnections();
    });

    this.modal.querySelector('#cli-upload-input')?.addEventListener('change', (e) => {
      this.uploadConfig(e);
    });

    const textarea = this.modal.querySelector('#cli-code-area');
    if (textarea) {
      textarea.addEventListener('input', () => {
        this.saveCurrentText();
        this.updateLineNumbers();
      });
      textarea.addEventListener('scroll', () => {
        const lineNums = this.modal.querySelector('#cli-line-numbers');
        if (lineNums) lineNums.scrollTop = textarea.scrollTop;
      });
    }
  }

  open(deviceId) {
    this.currentDeviceId = deviceId;
    const rack = store.getActiveRack();
    const device = rack?.installedDevices.find(d => d.id === deviceId);
    if (!device) return;

    const tpl = store.getTemplate(device.templateId);

    const titleEl = this.modal.querySelector('#cli-modal-title');
    if (titleEl) {
      titleEl.innerHTML = `
        <span class="text-cyan-400 font-mono">CLI:</span> ${device.customName}
        <span class="text-xs text-slate-400 font-normal ml-2">(${tpl?.vendor || 'Switch'} • U${device.uPosition})</span>
      `;
    }

    const textarea = this.modal.querySelector('#cli-code-area');
    if (textarea) {
      textarea.value = device.cliConfig || this.createInitialScaffold(device, tpl);
      this.saveCurrentText();
      this.updateLineNumbers();
    }

    this.modal.classList.remove('hidden');
    this.modal.classList.add('flex');
  }

  close() {
    this.saveCurrentText();
    this.modal.classList.add('hidden');
    this.modal.classList.remove('flex');
    this.currentDeviceId = null;
  }

  saveCurrentText() {
    if (!this.currentDeviceId) return;
    const textarea = this.modal.querySelector('#cli-code-area');
    if (!textarea) return;

    store.updateDevice(this.currentDeviceId, {
      cliConfig: textarea.value
    });
  }

  updateLineNumbers() {
    const textarea = this.modal.querySelector('#cli-code-area');
    const lineNums = this.modal.querySelector('#cli-line-numbers');
    if (!textarea || !lineNums) return;

    const linesCount = textarea.value.split('\n').length;
    let numbers = '';
    for (let i = 1; i <= Math.max(linesCount, 25); i++) {
      numbers += `<div>${i}</div>`;
    }
    lineNums.innerHTML = numbers;
  }

  createInitialScaffold(device, template) {
    return `! =======================================================
! Конфигурация: ${device.customName}
! Создано в RackStudio
! =======================================================
hostname ${device.customName.replace(/\s+/g, '-')}
!
! Нажмите кнопку "Сгенерировать по соединениям" вверху,
! чтобы автоматически составить конфиг всех подключенных портов и VLAN!
!
end`;
  }

  generateFromConnections() {
    if (!this.currentDeviceId) return;
    const rack = store.getActiveRack();
    const device = rack?.installedDevices.find(d => d.id === this.currentDeviceId);
    if (!device) return;
    const template = store.getTemplate(device.templateId);
    if (!template) return;

    const cables = store.state.cables.filter(c => c.from.deviceId === this.currentDeviceId || c.to.deviceId === this.currentDeviceId);

    const groupIds = new Set(cables.map(c => c.groupId).filter(Boolean));
    const usedGroups = Array.from(groupIds).map(id => store.getGroup(id)).filter(Boolean);

    let cfg = `! =======================================================\n`;
    cfg += `! Конфигурация: ${device.customName}\n`;
    cfg += `! IP-адрес: ${device.ipAddress || '192.168.1.254'}\n`;
    cfg += `! Дата генерации: ${new Date().toLocaleString()}\n`;
    cfg += `! =======================================================\n\n`;
    cfg += `hostname ${device.customName.replace(/\s+/g, '-')}\n`;
    cfg += `no ip domain-lookup\n`;
    cfg += `spanning-tree mode rstp\n\n`;

    if (usedGroups.length > 0) {
      cfg += `! --- Рабочие места и VLAN сервисов ---\n`;
      usedGroups.forEach(grp => {
        const vlanId = grp.vlan || 10;
        const vlanName = grp.name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
        cfg += `vlan ${vlanId}\n`;
        cfg += `  name ${vlanName}\n`;
      });
      cfg += `!\n\n`;
    }

    cfg += `! --- Конфигурация физических интерфейсов ---\n`;

    template.ports.forEach(port => {
      const cable = store.getCableByPort(this.currentDeviceId, port.id);
      const isConnected = !!cable;

      let ifName = `GigabitEthernet0/${port.number || 1}`;
      if (port.type === 'sfp') {
        ifName = `TenGigabitEthernet0/${port.number || 25}`;
      } else if (port.speed?.includes('10G')) {
        ifName = `TenGigabitEthernet0/${port.number || 1}`;
      }

      cfg += `interface ${ifName}\n`;

      if (isConnected) {
        const otherEnd = cable.from.deviceId === this.currentDeviceId ? cable.to : cable.from;
        const otherDev = rack.installedDevices.find(d => d.id === otherEnd.deviceId);
        const grp = store.getGroup(cable.groupId);

        let desc = `Подключение: ${otherDev?.customName || 'Устройство'}:${otherEnd.portId}`;
        if (grp) desc += ` [${grp.name}]`;
        if (cable.label) desc += ` (${cable.label})`;

        cfg += `  description ${desc}\n`;

        if (port.type === 'sfp' || port.name.includes('Uplink')) {
          cfg += `  switchport mode trunk\n`;
          cfg += `  switchport trunk allowed vlan 1,10,20,30,50\n`;
        } else {
          const vlanId = grp?.vlan || 1;
          cfg += `  switchport mode access\n`;
          cfg += `  switchport access vlan ${vlanId}\n`;
          cfg += `  spanning-tree portfast\n`;
          if (port.speed?.includes('PoE')) {
            cfg += `  power inline auto\n`;
          }
        }
        cfg += `  no shutdown\n`;
      } else {
        cfg += `  description [Свободный порт]\n`;
        cfg += `  shutdown\n`;
      }
      cfg += `!\n`;
    });

    cfg += `end\n`;

    const textarea = this.modal.querySelector('#cli-code-area');
    if (textarea) {
      textarea.value = cfg;
      this.saveCurrentText();
      this.updateLineNumbers();
    }
  }

  copyToClipboard() {
    const textarea = this.modal.querySelector('#cli-code-area');
    if (!textarea) return;
    navigator.clipboard.writeText(textarea.value).then(() => {
      const btn = this.modal.querySelector('#cli-copy-btn');
      if (btn) {
        const oldText = btn.innerHTML;
        btn.innerHTML = '✓ Скопировано!';
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerHTML = oldText;
          btn.classList.remove('text-emerald-400');
        }, 1500);
      }
    });
  }

  downloadConfig() {
    const textarea = this.modal.querySelector('#cli-code-area');
    if (!textarea) return;
    const rack = store.getActiveRack();
    const dev = rack?.installedDevices.find(d => d.id === this.currentDeviceId);
    const fileName = `${(dev?.customName || 'switch').replace(/\s+/g, '_')}_config.cfg`;

    const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  uploadConfig(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result;
      if (typeof content === 'string') {
        const textarea = this.modal.querySelector('#cli-code-area');
        if (textarea) {
          textarea.value = content;
          this.saveCurrentText();
          this.updateLineNumbers();
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }
}
