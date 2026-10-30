import type { Device } from '@ciscobanka/engine';
import { useStore } from '../../store/project';
import { getSim, settle } from '../../sim/runtime';
import { Field, Toggle } from '../../ui/fields';
import type { Upd } from './common';

/** Настройка ПК, ноутбука, сервера: IP/маска/шлюз/DNS или DHCP. */
export function HostConfig({ d, upd }: { d: Device; upd: Upd }) {
  useStore((s) => s.simTick);
  const bumpSim = useStore((s) => s.bumpSim);
  const port = d.ports[0];
  const l3 = port.l3 ?? {};
  const lease = getSim().rt(d.id).dhcp[port.id];
  const setPort = (fn: (p: Device['ports'][number]) => void, reason: string) =>
    upd((x) => fn(x.ports[0]), reason);

  return (
    <div className="tab-body">
      <Toggle
        label={`Интерфейс ${port.name} включён`}
        checked={port.adminUp}
        onChange={(v) => setPort((p) => void (p.adminUp = v), v ? 'Интерфейс включён' : 'Интерфейс выключен')}
      />
      <div className="radio-row">
        <label>
          <input type="radio" checked={!l3.dhcp} onChange={() => setPort((p) => void (p.l3 = { ...p.l3, dhcp: false }), 'Статический IP')} />
          Статический IP
        </label>
        <label>
          <input type="radio" checked={!!l3.dhcp} onChange={() => setPort((p) => void (p.l3 = { ...p.l3, dhcp: true }), 'Включён DHCP')} />
          DHCP
        </label>
      </div>

      {l3.dhcp ? (
        <div className="lease">
          {lease?.state === 'bound' ? (
            <>
              <div>IP: <b>{lease.ip}</b></div>
              <div>Маска: {lease.mask}</div>
              <div>Шлюз: {lease.gateway ?? '—'}</div>
              <div>DNS: {lease.dns ?? '—'}</div>
              <div className="muted">Выдал сервер {lease.server}</div>
            </>
          ) : (
            <div className="bad">{lease?.state === 'failed' ? 'DHCP-сервер не ответил — адрес не получен' : 'Адрес ещё не получен'}</div>
          )}
          <button
            className="btn"
            onClick={() => {
              const sim = getSim();
              sim.renewDhcp(d.id);
              settle();
              bumpSim();
            }}
          >
            Запросить адрес заново
          </button>
        </div>
      ) : (
        <div className="form-grid">
          <Field
            label="IP-адрес"
            kind="ip"
            optional
            value={l3.ip?.addr}
            onCommit={(v) => setPort((p) => void (p.l3 = { ...p.l3, ip: v ? { addr: v, mask: p.l3?.ip?.mask ?? '255.255.255.0' } : undefined }), 'Изменён IP')}
          />
          <Field
            label="Маска"
            kind="mask"
            value={l3.ip?.mask ?? (l3.ip ? '255.255.255.0' : '')}
            optional
            onCommit={(v) => setPort((p) => void (p.l3!.ip && (p.l3!.ip.mask = v ?? '255.255.255.0')), 'Изменена маска')}
          />
          <Field label="Шлюз по умолчанию" kind="ip" optional value={d.config.gateway} onCommit={(v) => upd((x) => void (x.config.gateway = v), 'Изменён шлюз')} />
          <Field label="DNS-сервер" kind="ip" optional value={d.config.dns} onCommit={(v) => upd((x) => void (x.config.dns = v), 'Изменён DNS')} />
        </div>
      )}
    </div>
  );
}
