import { useState } from 'react';
import type { Device, DhcpPool, L3Config } from '@ciscobanka/engine';
import { Field, Toggle } from '../../ui/fields';
import type { Upd } from './common';

function L3Fields({ l3, set }: { l3: L3Config; set: (fn: (l3: L3Config) => void, reason: string) => void }) {
  return (
    <div className="form-grid">
      <Field
        label="IP-адрес"
        kind="ip"
        optional
        value={l3.ip?.addr}
        onCommit={(v) => set((x) => void (x.ip = v ? { addr: v, mask: x.ip?.mask ?? '255.255.255.0' } : undefined), 'Изменён IP интерфейса')}
      />
      <Field
        label="Маска"
        kind="mask"
        optional
        value={l3.ip ? l3.ip.mask : undefined}
        onCommit={(v) => set((x) => void (x.ip && (x.ip.mask = v ?? '255.255.255.0')), 'Изменена маска интерфейса')}
      />
      <Field
        label="DHCP relay (ip helper-address)"
        kind="ip"
        optional
        placeholder="адрес DHCP-сервера"
        value={l3.helperAddress}
        onCommit={(v) => set((x) => void (x.helperAddress = v), 'Изменён ip helper-address')}
      />
    </div>
  );
}

export function RouterInterfaces({ d, upd }: { d: Device; upd: Upd }) {
  const [newVlan, setNewVlan] = useState<Record<string, string>>({});
  return (
    <div className="tab-body">
      {d.ports.map((p, pi) => {
        const setPort = (fn: (x: Device['ports'][number]) => void, reason: string) => upd((x) => fn(x.ports[pi]), `${p.name}: ${reason}`);
        return (
          <fieldset key={p.id} className="iface">
            <legend>
              {p.name} {p.media === 'fiber' && <span className="muted">(оптика)</span>}
            </legend>
            <Toggle label="Включён (no shutdown)" checked={p.adminUp} onChange={(v) => setPort((x) => void (x.adminUp = v), v ? 'включён' : 'выключен')} />
            <L3Fields l3={p.l3 ?? {}} set={(fn, r) => setPort((x) => fn((x.l3 ??= {})), r)} />

            {(p.subinterfaces ?? []).map((s, si) => (
              <div key={s.id} className="subif">
                <div className="subif-head">
                  <b>{s.name}</b> <span className="muted">encapsulation dot1q {s.dot1q}</span>
                  <Toggle label="вкл" checked={s.adminUp} onChange={(v) => setPort((x) => void (x.subinterfaces![si].adminUp = v), `${s.name} ${v ? 'включён' : 'выключен'}`)} />
                  <button className="btn ghost small" onClick={() => setPort((x) => void x.subinterfaces!.splice(si, 1), `удалён ${s.name}`)}>
                    Удалить
                  </button>
                </div>
                <L3Fields l3={s.l3} set={(fn, r) => setPort((x) => fn(x.subinterfaces![si].l3), r)} />
              </div>
            ))}
            <div className="tools-row">
              <input
                className="small-input"
                placeholder="VLAN"
                value={newVlan[p.id] ?? ''}
                onChange={(e) => setNewVlan({ ...newVlan, [p.id]: e.target.value })}
              />
              <button
                className="btn small"
                onClick={() => {
                  const v = Number(newVlan[p.id]);
                  if (!Number.isInteger(v) || v < 1 || v > 4094 || p.subinterfaces?.some((s) => s.dot1q === v)) return;
                  setPort(
                    (x) => void (x.subinterfaces ??= []).push({ id: `${x.id}.${v}`, name: `${x.name}.${v}`, dot1q: v, adminUp: true, l3: {} }),
                    `добавлен сабинтерфейс .${v}`,
                  );
                  setNewVlan({ ...newVlan, [p.id]: '' });
                }}
              >
                + Сабинтерфейс (router-on-a-stick)
              </button>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

export function RouterRoutes({ d, upd }: { d: Device; upd: Upd }) {
  const routes = d.config.staticRoutes ?? [];
  return (
    <div className="tab-body">
      <p className="hint">Статический маршрут: «чтобы попасть в сеть X, отдай пакет соседу Y».</p>
      <table className="grid">
        <thead>
          <tr>
            <th>Сеть</th>
            <th>Маска</th>
            <th>Следующий узел</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {routes.map((r, i) => (
            <tr key={i}>
              <td><Field kind="ip" value={r.network} onCommit={(v) => upd((x) => void (x.config.staticRoutes![i].network = v!), 'Изменён маршрут')} /></td>
              <td><Field kind="mask" value={r.mask} onCommit={(v) => upd((x) => void (x.config.staticRoutes![i].mask = v!), 'Изменён маршрут')} /></td>
              <td><Field kind="ip" value={r.nextHop} onCommit={(v) => upd((x) => void (x.config.staticRoutes![i].nextHop = v!), 'Изменён маршрут')} /></td>
              <td><button className="btn ghost small" onClick={() => upd((x) => void x.config.staticRoutes!.splice(i, 1), 'Удалён маршрут')}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn"
        onClick={() => upd((x) => void (x.config.staticRoutes ??= []).push({ network: '0.0.0.0', mask: '0.0.0.0', nextHop: '0.0.0.0' }), 'Добавлен маршрут')}
      >
        + Маршрут
      </button>
    </div>
  );
}

export function DhcpPools({ d, upd }: { d: Device; upd: Upd }) {
  const pools = d.config.dhcpPools ?? [];
  const set = (i: number, k: keyof DhcpPool, v: string | undefined) =>
    upd((x) => void ((x.config.dhcpPools![i] as unknown as Record<string, string | undefined>)[k] = v), 'Изменён DHCP-пул');
  return (
    <div className="tab-body">
      {pools.map((p, i) => (
        <fieldset key={i} className="iface">
          <legend>
            Пул «{p.name}»{' '}
            <button className="btn ghost small" onClick={() => upd((x) => void x.config.dhcpPools!.splice(i, 1), 'Удалён DHCP-пул')}>Удалить</button>
          </legend>
          <div className="form-grid">
            <Field label="Имя" value={p.name} onCommit={(v) => set(i, 'name', v)} />
            <Field label="Сеть" kind="ip" value={p.network} onCommit={(v) => set(i, 'network', v)} />
            <Field label="Маска" kind="mask" value={p.mask} onCommit={(v) => set(i, 'mask', v)} />
            <Field label="Шлюз" kind="ip" optional value={p.gateway} onCommit={(v) => set(i, 'gateway', v)} />
            <Field label="DNS" kind="ip" optional value={p.dns} onCommit={(v) => set(i, 'dns', v)} />
            <Field label="Первый адрес" kind="ip" value={p.start} onCommit={(v) => set(i, 'start', v)} />
            <Field label="Последний адрес" kind="ip" value={p.end} onCommit={(v) => set(i, 'end', v)} />
          </div>
        </fieldset>
      ))}
      <button
        className="btn"
        onClick={() =>
          upd(
            (x) =>
              void (x.config.dhcpPools ??= []).push({
                name: `POOL${pools.length + 1}`,
                network: '192.168.1.0',
                mask: '255.255.255.0',
                gateway: '192.168.1.1',
                start: '192.168.1.100',
                end: '192.168.1.200',
              }),
            'Добавлен DHCP-пул',
          )
        }
      >
        + DHCP-пул
      </button>
    </div>
  );
}
