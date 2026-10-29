import { useState } from 'react';
import type { Device } from '@ciscobanka/engine';
import { useStore } from '../../store/project';
import { peerLabel } from '../../ui/portInfo';
import { Field, Toggle } from '../../ui/fields';
import type { Upd } from './common';

export function SwitchVlans({ d, upd }: { d: Device; upd: Upd }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const vlans = d.config.vlans ?? [];
  const add = () => {
    const v = Number(id);
    if (!Number.isInteger(v) || v < 2 || v > 4094 || vlans.some((x) => x.id === v)) return;
    upd((x) => void (x.config.vlans ??= []).push({ id: v, name: name.trim() || `VLAN${v}` }), `Создан VLAN ${v}`);
    setId('');
    setName('');
  };
  return (
    <div className="tab-body">
      <table className="grid">
        <thead>
          <tr><th>ID</th><th>Имя</th><th>Порты (access)</th><th /></tr>
        </thead>
        <tbody>
          {vlans.map((v, i) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>
                {v.id === 1 ? v.name : <Field value={v.name} onCommit={(n) => upd((x) => void (x.config.vlans![i].name = n!), 'Переименован VLAN')} />}
              </td>
              <td className="muted">
                {d.ports.filter((p) => p.switchport?.mode === 'access' && p.switchport.accessVlan === v.id).map((p) => p.name).join(', ') || '—'}
              </td>
              <td>
                {v.id !== 1 && (
                  <button className="btn ghost small" onClick={() => upd((x) => void x.config.vlans!.splice(i, 1), `Удалён VLAN ${v.id}`)}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tools-row">
        <input className="small-input" placeholder="ID" value={id} onChange={(e) => setId(e.target.value)} />
        <input placeholder="Имя (необязательно)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn" onClick={add}>+ VLAN</button>
      </div>
    </div>
  );
}

function parseVlanList(s: string): number[] | null {
  const out: number[] = [];
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (a < 1 || b > 4094 || a > b) return null;
    for (let v = a; v <= b; v++) out.push(v);
  }
  return out;
}

export function SwitchPorts({ d, upd }: { d: Device; upd: Upd }) {
  const project = useStore((s) => s.project);
  const vlans = d.config.vlans ?? [];
  return (
    <div className="tab-body">
      <table className="grid">
        <thead>
          <tr><th>Порт</th><th>Вкл</th><th>Режим</th><th>VLAN / разрешённые</th><th>Подключён к</th></tr>
        </thead>
        <tbody>
          {d.ports.map((p, i) => {
            const sp = p.switchport ?? { mode: 'access' as const, accessVlan: 1, nativeVlan: 1 };
            const setSp = (fn: (s: typeof sp) => void, reason: string) =>
              upd((x) => {
                const port = x.ports[i];
                port.switchport ??= { mode: 'access', accessVlan: 1, nativeVlan: 1 };
                fn(port.switchport);
              }, `${p.name}: ${reason}`);
            const peer = peerLabel(project, p.id);
            return (
              <tr key={p.id} className={peer ? 'busy' : ''}>
                <td>{p.name}</td>
                <td>
                  <Toggle label="" checked={p.adminUp} onChange={(v) => upd((x) => void (x.ports[i].adminUp = v), `${p.name} ${v ? 'включён' : 'выключен'}`)} />
                </td>
                <td>
                  <select value={sp.mode} onChange={(e) => setSp((s) => void (s.mode = e.target.value as 'access' | 'trunk'), `режим ${e.target.value}`)}>
                    <option value="access">access</option>
                    <option value="trunk">trunk</option>
                  </select>
                </td>
                <td>
                  {sp.mode === 'access' ? (
                    <select value={sp.accessVlan} onChange={(e) => setSp((s) => void (s.accessVlan = Number(e.target.value)), `VLAN ${e.target.value}`)}>
                      {vlans.map((v) => (
                        <option key={v.id} value={v.id}>{v.id} {v.name}</option>
                      ))}
                      {!vlans.some((v) => v.id === sp.accessVlan) && <option value={sp.accessVlan}>{sp.accessVlan} (не создан!)</option>}
                    </select>
                  ) : (
                    <Field
                      placeholder="все"
                      optional
                      value={sp.allowedVlans?.join(',')}
                      check={(v) => (parseVlanList(v) ? null : 'Формат: 1,10,20-30')}
                      onCommit={(v) => setSp((s) => void (s.allowedVlans = v ? parseVlanList(v)! : undefined), 'разрешённые VLAN')}
                      width={110}
                    />
                  )}
                </td>
                <td>{peer ?? <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
