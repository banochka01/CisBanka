import { useState } from 'react';
import type { Device, Job } from '@ciscobanka/engine';
import { getSim, settle } from '../../sim/runtime';
import { useStore } from '../../store/project';
import { useSim } from '../../store/sim';

interface Run {
  title: string;
  target: string;
  jobId: number;
}

/** «Инструменты» ПК: ping, traceroute, открыть сайт, nslookup — вывод текстом. */
export function Tools({ d }: { d: Device }) {
  const [target, setTarget] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [hint, setHint] = useState('');
  const bumpSim = useStore((s) => s.bumpSim);
  useStore((s) => s.simTick);
  const mode = useSim((s) => s.mode);

  const runJob = (title: string, start: () => Job) => {
    if (!target.trim()) return setHint('Введите IP-адрес или имя узла.');
    setHint('');
    const job = start();
    settle();
    bumpSim();
    setRuns((r) => [...r, { title, target, jobId: job.id }]);
  };
  const sim = getSim();

  // вывод берём из задач симулятора: в режиме симуляции он дописывается по мере шагов
  const out = runs
    .map((r) => {
      const job = sim.job(r.jobId);
      if (!job) return `> ${r.title} ${r.target}\n(прервано: состояние симуляции сброшено)`;
      const tail = job.done ? '' : `${job.lines.length ? '\n' : ''}… идёт — шагайте симуляцию`;
      return `> ${r.title} ${r.target}\n${job.lines.join('\n')}${tail}`;
    })
    .join('\n\n');

  return (
    <div className="tab-body">
      <div className="tools-row">
        <input
          className="tools-target"
          placeholder="IP или имя: 192.168.1.1, site.local"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runJob('ping', () => sim.ping(d.id, target))}
        />
      </div>
      <div className="tools-row">
        <button className="btn primary" onClick={() => runJob('ping', () => sim.ping(d.id, target))}>Ping</button>
        <button className="btn" onClick={() => runJob('tracert', () => sim.traceroute(d.id, target))}>Traceroute</button>
        <button className="btn" onClick={() => runJob('открыть', () => sim.openUrl(d.id, target))}>Открыть сайт</button>
        <button className="btn" onClick={() => runJob('nslookup', () => sim.nslookup(d.id, target))}>nslookup</button>
        <button className="btn ghost" onClick={() => setRuns([])}>Очистить</button>
      </div>
      {hint && <div className="bad">{hint}</div>}
      {mode === 'simulation' && <div className="hint">Режим симуляции: команда поставлена в очередь, пакеты пойдут по шагам.</div>}
      <pre className="console">{out || 'Здесь появится результат.'}</pre>
    </div>
  );
}
