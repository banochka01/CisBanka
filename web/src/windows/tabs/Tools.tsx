import { useState } from 'react';
import type { Device, Job } from '@ciscobanka/engine';
import { getSim } from '../../sim/runtime';
import { useStore } from '../../store/project';

/** «Инструменты» ПК: ping, traceroute, открыть сайт, nslookup — вывод текстом. */
export function Tools({ d }: { d: Device }) {
  const [target, setTarget] = useState('');
  const [out, setOut] = useState('');
  const bumpSim = useStore((s) => s.bumpSim);

  const runJob = (title: string, start: () => Job) => {
    if (!target.trim()) return setOut('Введите IP-адрес или имя узла.');
    const sim = getSim();
    const job = start();
    sim.runUntilIdle();
    bumpSim();
    const lines = sim.job(job.id)?.lines ?? [];
    setOut((prev) => `${prev ? prev + '\n\n' : ''}> ${title} ${target}\n${lines.join('\n')}`);
  };
  const sim = () => getSim();

  return (
    <div className="tab-body">
      <div className="tools-row">
        <input
          className="tools-target"
          placeholder="IP или имя: 192.168.1.1, site.local"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runJob('ping', () => sim().ping(d.id, target))}
        />
      </div>
      <div className="tools-row">
        <button className="btn primary" onClick={() => runJob('ping', () => sim().ping(d.id, target))}>Ping</button>
        <button className="btn" onClick={() => runJob('tracert', () => sim().traceroute(d.id, target))}>Traceroute</button>
        <button className="btn" onClick={() => runJob('открыть', () => sim().openUrl(d.id, target))}>Открыть сайт</button>
        <button className="btn" onClick={() => runJob('nslookup', () => sim().nslookup(d.id, target))}>nslookup</button>
        <button className="btn ghost" onClick={() => setOut('')}>Очистить</button>
      </div>
      <pre className="console">{out || 'Здесь появится результат.'}</pre>
    </div>
  );
}
