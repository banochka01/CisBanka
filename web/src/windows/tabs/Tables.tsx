import { arpTable, macTable, routes, type Device } from '@ciscobanka/engine';
import { getSim } from '../../sim/runtime';
import { useStore } from '../../store/project';

const sec = (ms: number) => `${Math.round(ms / 1000)} с`;

export function Tables({ d }: { d: Device }) {
  useStore((s) => s.simTick);
  const sim = getSim();
  if (d.kind === 'switch') {
    const rows = macTable(sim, d.id);
    return (
      <div className="tab-body">
        <h4>MAC-таблица</h4>
        <table className="grid">
          <thead><tr><th>VLAN</th><th>MAC</th><th>Порт</th><th>Возраст</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vlan + r.mac}><td>{r.vlan}</td><td className="mono">{r.mac}</td><td>{r.port}</td><td>{sec(r.age)}</td></tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="muted">Пусто: свитч ещё не видел кадров. Сделайте ping.</p>}
      </div>
    );
  }
  if (d.kind === 'hub') return <div className="tab-body muted">У хаба нет таблиц: он просто повторяет сигнал во все порты.</div>;
  const arp = arpTable(sim, d.id);
  const rt = routes(sim, d.id);
  return (
    <div className="tab-body">
      <h4>ARP-таблица</h4>
      <table className="grid">
        <thead><tr><th>IP</th><th>MAC</th><th>Интерфейс</th><th>Истекает</th></tr></thead>
        <tbody>
          {arp.map((r) => (
            <tr key={r.ip}><td className="mono">{r.ip}</td><td className="mono">{r.mac}</td><td>{r.iface}</td><td>{sec(r.expiresIn)}</td></tr>
          ))}
        </tbody>
      </table>
      {!arp.length && <p className="muted">Пусто.</p>}
      <h4>Таблица маршрутизации</h4>
      <table className="grid">
        <thead><tr><th>Тип</th><th>Сеть</th><th>Маска</th><th>Через</th><th>Интерфейс</th></tr></thead>
        <tbody>
          {rt.map((r, i) => (
            <tr key={i}>
              <td title={r.type === 'C' ? 'подключена напрямую' : 'статический'}>{r.type}</td>
              <td className="mono">{r.network}</td>
              <td className="mono">{r.mask}</td>
              <td className="mono">{r.nextHop ?? '—'}</td>
              <td>{r.iface ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
