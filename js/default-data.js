/**
 * RackStudio - Default Templates & Demo Data
 */

export const DEFAULT_DEVICE_TEMPLATES = [
  {
    id: 'tpl-switch-24p',
    name: 'Switch 24-Port Pro Max PoE',
    vendor: 'UniFi Style',
    category: 'switch',
    uHeight: 1,
    powerW: 75,
    style: {
      theme: 'silver',
      accentColor: '#0066ff'
    },
    ports: [
      ...Array.from({ length: 24 }, (_, i) => {
        const col = Math.floor(i / 2);
        const row = i % 2; // 0 = top, 1 = bottom
        const startX = 26;
        const colSpacing = 2.4;
        return {
          id: `p-${i + 1}`,
          number: i + 1,
          name: `Port ${i + 1}`,
          type: 'rj45',
          speed: '1G/PoE+',
          x: Number((startX + col * colSpacing).toFixed(2)),
          y: row === 0 ? 33 : 67
        };
      }),
      {
        id: 'sfp-1',
        number: 25,
        name: 'SFP+ 1 (10G)',
        type: 'sfp',
        speed: '10G',
        x: 88.5,
        y: 40
      },
      {
        id: 'sfp-2',
        number: 26,
        name: 'SFP+ 2 (10G)',
        type: 'sfp',
        speed: '10G',
        x: 93.5,
        y: 40
      }
    ],
    decorations: {
      hasLcdScreen: true,
      lcdText: 'UniFi Pro Max 24',
      lcdSub: '192.168.1.2',
      hasLeds: true
    }
  },

  {
    id: 'tpl-patch-24p',
    name: 'Patch Panel 24P Cat6 UTP',
    vendor: 'Generic 19"',
    category: 'patch_panel',
    uHeight: 1,
    powerW: 0,
    style: {
      theme: 'black-matte',
      accentColor: '#666'
    },
    ports: Array.from({ length: 24 }, (_, i) => {
      const block = Math.floor(i / 6);
      const indexInBlock = i % 6;
      const blockStartX = 14 + block * 21;
      const portSpacing = 3.1;
      return {
        id: `p-${i + 1}`,
        number: i + 1,
        name: `Patch ${i + 1}`,
        type: 'rj45',
        speed: '1G/10G Cat6',
        x: Number((blockStartX + indexInBlock * portSpacing).toFixed(2)),
        y: 50
      };
    }),
    decorations: {
      hasLabelStrips: true
    }
  },

  {
    id: 'tpl-server-2u',
    name: 'Compute & Storage Server 2U',
    vendor: 'PowerEdge Style',
    category: 'server',
    uHeight: 2,
    powerW: 350,
    style: {
      theme: 'dark-mesh',
      accentColor: '#3b82f6'
    },
    ports: [
      { id: 'nic-1', number: 1, name: 'NIC 1 (1G)', type: 'rj45', speed: '1G', x: 74, y: 35 },
      { id: 'nic-2', number: 2, name: 'NIC 2 (1G)', type: 'rj45', speed: '1G', x: 78, y: 35 },
      { id: 'nic-3', number: 3, name: 'NIC 3 (10G)', type: 'rj45', speed: '10G', x: 74, y: 65 },
      { id: 'nic-4', number: 4, name: 'NIC 4 (10G)', type: 'rj45', speed: '10G', x: 78, y: 65 },
      { id: 'sfp-1', number: 5, name: 'SFP+ 1 (10G DAC)', type: 'sfp', speed: '10G', x: 84, y: 50 },
      { id: 'sfp-2', number: 6, name: 'SFP+ 2 (10G DAC)', type: 'sfp', speed: '10G', x: 88, y: 50 },
      { id: 'idrac', number: 7, name: 'iDRAC / Mgmt', type: 'rj45', speed: '1G Mgmt', x: 94, y: 50 }
    ],
    decorations: {
      hasDriveBays: true,
      driveCount: 8,
      hasLcdScreen: true,
      lcdText: 'SRV-STORAGE-01'
    }
  },

  {
    id: 'tpl-gateway-1u',
    name: 'Security Gateway / Router 1U',
    vendor: 'UniFi Style',
    category: 'router',
    uHeight: 1,
    powerW: 50,
    style: {
      theme: 'silver',
      accentColor: '#10b981'
    },
    ports: [
      { id: 'wan-1', number: 1, name: 'WAN 1 (RJ45 2.5G)', type: 'rj45', speed: '2.5G', x: 42, y: 50 },
      { id: 'wan-2', number: 2, name: 'WAN 2 (SFP+ 10G)', type: 'sfp', speed: '10G', x: 48, y: 50 },
      { id: 'lan-1', number: 3, name: 'LAN 1 (RJ45 1G)', type: 'rj45', speed: '1G', x: 55, y: 50 },
      { id: 'lan-2', number: 4, name: 'LAN 2 (RJ45 1G)', type: 'rj45', speed: '1G', x: 59, y: 50 },
      { id: 'lan-sfp', number: 5, name: 'LAN Uplink (SFP+ 10G)', type: 'sfp', speed: '10G', x: 66, y: 50 },
      { id: 'mgmt', number: 6, name: 'Console', type: 'console', speed: 'RS232/USB', x: 74, y: 50 }
    ],
    decorations: {
      hasLcdScreen: true,
      lcdText: 'Gateway Pro',
      lcdSub: 'WAN: 94.25.18.2'
    }
  },

  {
    id: 'tpl-pdu-1u',
    name: 'Smart Metered PDU 1U',
    vendor: 'APC Style',
    category: 'pdu',
    uHeight: 1,
    powerW: 10,
    style: {
      theme: 'black-matte',
      accentColor: '#22c55e'
    },
    ports: Array.from({ length: 8 }, (_, i) => ({
      id: `pwr-${i + 1}`,
      number: i + 1,
      name: `C13 Outlet ${i + 1}`,
      type: 'power',
      speed: '230V 10A',
      x: Number((25 + i * 8.5).toFixed(2)),
      y: 50
    })),
    decorations: {
      hasPowerMeter: true,
      meterText: '230V  4.2A  960W'
    }
  }
];

export const DEFAULT_WORKPLACE_GROUPS = [];

export const DEFAULT_SWITCH_CLI_CONFIG = `! =======================================================
! Конфигурация коммутатора: Switch-Pro-Max-24-PoE
! =======================================================
hostname Core-Switch-24
!
! Нажмите кнопку "Сгенерировать по портам",
! чтобы автоматически составить конфигурацию на основе
! созданных вами групп и подключений!
!
end`;

export const DEFAULT_INITIAL_STATE = {
  version: 2,
  activeRackId: 'rack-1',
  activeGroupFilter: 'ALL',
  dimInactiveCables: true,
  racks: [
    {
      id: 'rack-1',
      name: 'Стойка №1 (Главная серверная)',
      uHeight: 24,
      model: '19" 600x800mm Enclosure',
      installedDevices: [
        {
          id: 'dev-gateway',
          templateId: 'tpl-gateway-1u',
          customName: 'USG Gateway Router Pro',
          uPosition: 24,
          ipAddress: '192.168.1.1',
          notes: 'Основной интернет-шлюз и межсетевой экран',
          cliConfig: `! Gateway Router Config\nhostname USG-Pro\ninterface wan1\n ip address 94.25.18.2 255.255.255.252\ninterface lan1\n ip address 192.168.1.1 255.255.255.0`
        },
        {
          id: 'dev-patch',
          templateId: 'tpl-patch-24p',
          customName: 'Патч-панель 24P Cat6 (Офис)',
          uPosition: 22,
          ipAddress: '',
          notes: 'Кабельные трассы от розеток в офисе',
          cliConfig: ''
        },
        {
          id: 'dev-switch',
          templateId: 'tpl-switch-24p',
          customName: 'Switch Pro Max 24 PoE',
          uPosition: 21,
          ipAddress: '192.168.1.2',
          notes: 'Основной коммутатор доступа и распределения',
          cliConfig: DEFAULT_SWITCH_CLI_CONFIG
        },
        {
          id: 'dev-server',
          templateId: 'tpl-server-2u',
          customName: 'SRV-STORAGE-01 (СХД 2U)',
          uPosition: 17,
          ipAddress: '192.168.1.100',
          notes: 'Сервер баз данных и дисковое хранилище ZFS',
          cliConfig: `! Linux Network Config (/etc/netplan/01-netcfg.yaml)\nnetwork:\n  version: 2\n  bonds:\n    bond0:\n      interfaces: [ens1f0, ens1f1]\n      parameters:\n        mode: 802.3ad\n      addresses: [192.168.30.10/24]`
        },
        {
          id: 'dev-pdu',
          templateId: 'tpl-pdu-1u',
          customName: 'Smart PDU APC 1U',
          uPosition: 1,
          ipAddress: '192.168.1.250',
          notes: 'Блок распределения питания с мониторингом тока',
          cliConfig: ''
        }
      ]
    }
  ],

  cables: [
    {
      id: 'c-uplink',
      groupId: '',
      from: { deviceId: 'dev-gateway', portId: 'lan-1' },
      to: { deviceId: 'dev-switch', portId: 'p-24' },
      color: '#38bdf8',
      type: 'Cat6 Uplink',
      lengthM: 0.5,
      label: 'Gateway LAN Uplink'
    }
  ],

  groups: DEFAULT_WORKPLACE_GROUPS,
  templates: DEFAULT_DEVICE_TEMPLATES
};
