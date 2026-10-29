import { useRef, useState, type ReactNode } from 'react';
import { DEVICE_LABELS, type Device } from '@ciscobanka/engine';
import { useStore, type FloatingWindow } from '../store/project';
import { GeneralTab, ShutdownHint, useUpd, type Upd } from './tabs/common';
import { HostConfig } from './tabs/HostConfig';
import { Tools } from './tabs/Tools';
import { DhcpPools, RouterInterfaces, RouterRoutes } from './tabs/Router';
import { SwitchPorts, SwitchVlans } from './tabs/Switch';
import { ServerServices } from './tabs/Server';
import { Tables } from './tabs/Tables';
import { DeviceIcon } from '../canvas/icons';

type Tab = { key: string; title: string; render: (d: Device, upd: Upd) => ReactNode };

function tabsFor(kind: Device['kind']): Tab[] {
  const general: Tab = { key: 'general', title: 'Общее', render: (d, u) => <GeneralTab d={d} upd={u} /> };
  const tables: Tab = { key: 'tables', title: 'Таблицы', render: (d) => <Tables d={d} /> };
  switch (kind) {
    case 'pc':
    case 'laptop':
      return [
        { key: 'ip', title: 'Настройка IP', render: (d, u) => <HostConfig d={d} upd={u} /> },
        { key: 'tools', title: 'Инструменты', render: (d) => <Tools d={d} /> },
        tables,
        general,
      ];
    case 'server':
      return [
        { key: 'ip', title: 'Настройка IP', render: (d, u) => <HostConfig d={d} upd={u} /> },
        { key: 'services', title: 'Сервисы', render: (d, u) => <ServerServices d={d} upd={u} /> },
        { key: 'tools', title: 'Инструменты', render: (d) => <Tools d={d} /> },
        tables,
        general,
      ];
    case 'router':
      return [
        { key: 'ifaces', title: 'Интерфейсы', render: (d, u) => <RouterInterfaces d={d} upd={u} /> },
        { key: 'routes', title: 'Маршруты', render: (d, u) => <RouterRoutes d={d} upd={u} /> },
        { key: 'dhcp', title: 'DHCP', render: (d, u) => <DhcpPools d={d} upd={u} /> },
        tables,
        general,
      ];
    case 'switch':
      return [
        { key: 'ports', title: 'Порты', render: (d, u) => <SwitchPorts d={d} upd={u} /> },
        { key: 'vlans', title: 'VLAN', render: (d, u) => <SwitchVlans d={d} upd={u} /> },
        tables,
        general,
      ];
    default:
      return [general, tables];
  }
}

/** Немодальное окно устройства: можно открыть несколько и двигать за заголовок. */
function DeviceWindow({ w }: { w: FloatingWindow }) {
  const d = useStore((s) => s.project.devices.find((x) => x.id === w.deviceId));
  const { closeWindow, focusWindow, moveWindow } = useStore.getState();
  const upd = useUpd(w.deviceId);
  const tabs = tabsFor(d?.kind ?? 'pc');
  const [tab, setTab] = useState(tabs[0].key);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  if (!d) return null;
  const cur = tabs.find((t) => t.key === tab) ?? tabs[0];

  return (
    <div className="window" style={{ left: w.x, top: w.y, zIndex: 100 + w.z }} onMouseDown={() => focusWindow(d.id)}>
      <div
        className="window-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          drag.current = { dx: e.clientX - w.x, dy: e.clientY - w.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          moveWindow(d.id, Math.max(0, e.clientX - drag.current.dx), Math.max(0, e.clientY - drag.current.dy));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <DeviceIcon kind={d.kind} size={22} />
        <span className="window-title">
          {d.name} <span className="muted">— {DEVICE_LABELS[d.kind]}</span>
        </span>
        <button className="window-close" onClick={() => closeWindow(d.id)} title="Закрыть">
          ✕
        </button>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`tab${t.key === cur.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.title}
          </button>
        ))}
      </div>
      <div className="window-body">
        <ShutdownHint d={d} upd={upd} />
        {cur.render(d, upd)}
      </div>
    </div>
  );
}

export function WindowLayer() {
  const windows = useStore((s) => s.windows);
  return (
    <>
      {windows.map((w) => (
        <DeviceWindow key={w.deviceId} w={w} />
      ))}
    </>
  );
}
