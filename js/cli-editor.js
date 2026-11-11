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
    const isEltex = String(template?.vendor || '').toLowerCase().includes('eltex');
    const host = (device.customName || 'Switch').replace(/\s+/g, '-');
    if (isEltex) {
      return `! =======================================================
! Конфигурация Eltex: ${device.customName} (${template?.name || 'MES'})
! Создано в RackStudio
! =======================================================
hostname ${host}
!
! interface gigabitethernet 1/0/1
!  switchport access vlan 10
! interface tengigabitethernet 1/0/1
!  switchport mode trunk
!
end`;
    }
    return `! =======================================================
! Конфигурация: ${device.customName}
! Создано в RackStudio
! =======================================================
hostname ${host}
!
end`;
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
