import { useState } from 'react';
import { isValidIp, type Device } from '@ciscobanka/engine';
import { Field, Toggle } from '../../ui/fields';
import { DhcpPools } from './Router';
import type { Upd } from './common';

export function ServerServices({ d, upd }: { d: Device; upd: Upd }) {
  const sv = d.config.services ?? {};
  const dns = sv.dns ?? { enabled: false, records: [] };
  const http = sv.http ?? { enabled: false, title: 'Добро пожаловать', body: 'Это страница учебного веб-сервера.' };
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');
  const setSv = (fn: (s: NonNullable<Device['config']['services']>) => void, reason: string) =>
    upd((x) => fn((x.config.services ??= {})), reason);

  return (
    <div className="tab-body">
      <fieldset className="iface">
        <legend>
          <Toggle label="DHCP" checked={!!sv.dhcp} onChange={(v) => setSv((s) => void (s.dhcp = v), v ? 'DHCP включён' : 'DHCP выключен')} />
        </legend>
        {sv.dhcp && <DhcpPools d={d} upd={upd} />}
      </fieldset>

      <fieldset className="iface">
        <legend>
          <Toggle label="DNS" checked={dns.enabled} onChange={(v) => setSv((s) => void (s.dns = { ...dns, enabled: v }), v ? 'DNS включён' : 'DNS выключен')} />
        </legend>
        {dns.enabled && (
          <>
            <table className="grid">
              <thead>
                <tr><th>Имя</th><th>A-запись (IP)</th><th /></tr>
              </thead>
              <tbody>
                {dns.records.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td className="mono">{r.address}</td>
                    <td>
                      <button className="btn ghost small" onClick={() => setSv((s) => void s.dns!.records.splice(i, 1), 'Удалена DNS-запись')}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tools-row">
              <input placeholder="site.local" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="192.168.1.2" value={addr} onChange={(e) => setAddr(e.target.value)} />
              <button
                className="btn"
                disabled={!name.trim() || !isValidIp(addr.trim())}
                onClick={() => {
                  setSv((s) => void s.dns!.records.push({ name: name.trim(), address: addr.trim() }), 'Добавлена DNS-запись');
                  setName('');
                  setAddr('');
                }}
              >
                + Запись
              </button>
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="iface">
        <legend>
          <Toggle label="HTTP" checked={http.enabled} onChange={(v) => setSv((s) => void (s.http = { ...http, enabled: v }), v ? 'HTTP включён' : 'HTTP выключен')} />
        </legend>
        {http.enabled && (
          <div className="form-grid">
            <Field label="Заголовок страницы" value={http.title} onCommit={(v) => setSv((s) => void (s.http!.title = v!), 'Изменена страница')} />
            <Field label="Текст страницы" value={http.body} onCommit={(v) => setSv((s) => void (s.http!.body = v!), 'Изменена страница')} />
          </div>
        )}
      </fieldset>
    </div>
  );
}
