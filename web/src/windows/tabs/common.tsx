import type { Device } from '@ciscobanka/engine';
import { useStore } from '../../store/project';
import { Field, Toggle } from '../../ui/fields';
import { peerLabel, shutdownWithIp } from '../../ui/portInfo';
import { getSim } from '../../sim/runtime';

export type Upd = (fn: (d: Device) => void, reason?: string) => void;

export function useUpd(id: string): Upd {
  const updateDevice = useStore((s) => s.updateDevice);
  return (fn, reason) => updateDevice(id, fn, reason);
}

/** Заметная подсказка: на интерфейсе задан IP, но он выключен. */
export function ShutdownHint({ d, upd }: { d: Device; upd: Upd }) {
  const off = shutdownWithIp(d);
  if (!off.length) return null;
  return (
    <div className="hint-banner">
      {off.map((o) => (
        <div key={o.portId} className="hint-row">
          <span>
            ⚠ Интерфейс <b>{o.name}</b> выключен, хотя на нём задан IP — пакеты через него не пойдут.
          </span>
          <button
            className="btn primary"
            onClick={() =>
              upd((x) => {
                x.ports.find((p) => p.id === o.portId)!.adminUp = true;
              }, `Включён интерфейс ${o.name}`)
            }
          >
            Включить
          </button>
        </div>
      ))}
    </div>
  );
}

export function GeneralTab({ d, upd }: { d: Device; upd: Upd }) {
  const project = useStore((s) => s.project);
  useStore((s) => s.simTick);
  const sim = getSim();
  return (
    <div className="tab-body">
      <Field
        label="Имя устройства"
        value={d.name}
        onCommit={(v) =>
          upd((x) => {
            x.name = v!;
          }, 'Переименовано устройство')
        }
      />
      <Toggle
        label="Auto-MDIX (подходит любой медный кабель)"
        checked={d.config.autoMdix}
        onChange={(v) =>
          upd((x) => {
            x.config.autoMdix = v;
          }, 'Изменён Auto-MDIX')
        }
      />
      <h4>Порты</h4>
      <table className="grid">
        <thead>
          <tr>
            <th>Порт</th>
            <th>Линк</th>
            <th>MAC</th>
            <th>Подключён к</th>
          </tr>
        </thead>
        <tbody>
          {d.ports.map((p) => {
            const peer = peerLabel(project, p.id);
            return (
              <tr key={p.id} className={peer ? 'busy' : ''}>
                <td>
                  {p.name}
                  {p.media === 'fiber' ? ' (оптика)' : ''}
                </td>
                <td>
                  <span className={`led led-${sim.portLed(p.id)}`} />
                  {!p.adminUp && <span className="muted"> выкл</span>}
                </td>
                <td className="mono">{p.mac}</td>
                <td>{peer ?? <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
