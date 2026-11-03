// Терминал Linux-хоста: serial-консоль VM в xterm.js. Ленивый чанк вместе с v86.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Device } from '@ciscobanka/engine';
import { useSim } from '../store/sim';
import { getVm, MAX_VMS, startVm, stopVm, type LinuxVm } from './vm';

const STATE_TEXT: Record<LinuxVm['state'], string> = {
  loading: 'Загрузка образа…',
  booting: 'Загрузка Linux…',
  configuring: 'Настройка IP…',
  ready: 'Работает',
  paused: 'Пауза (режим симуляции)',
  error: 'Ошибка',
};

export default function LinuxConsole({ d, onStop }: { d: Device; onStop: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [vm, setVm] = useState<LinuxVm | null>(() => getVm(d.id) ?? null);
  const [err, setErr] = useState('');
  const [, force] = useState(0);
  const mode = useSim((s) => s.mode);

  useEffect(() => {
    if (vm) return;
    const r = startVm(d.id);
    if (typeof r === 'string') setErr(r);
    else setVm(r);
  }, [d.id, vm]);

  useEffect(() => {
    if (!vm || !host.current) return;
    const term = new Terminal({ rows: 20, cols: 80, fontSize: 13, convertEol: false, cursorBlink: true, theme: { background: '#0b0f14' } });
    term.open(host.current);
    const offOut = vm.onOutput((b) => term.write(b));
    const offIn = term.onData((s) => vm.send(s));
    const offState = vm.onState(() => force((n) => n + 1));
    // Счётчики кадров обновляем раз в секунду.
    const tick = setInterval(() => force((n) => n + 1), 1000);
    term.focus();
    return () => {
      offOut();
      offIn.dispose();
      offState();
      clearInterval(tick);
      term.dispose();
    };
  }, [vm]);

  if (err) return <p className="hint strong">{err}</p>;
  const boot = vm?.t.ready && vm.t.start ? ((vm.t.ready - vm.t.start) / 1000).toFixed(1) : null;
  return (
    <div className="linux-console">
      <div className="linux-bar">
        <span className={`linux-state ${vm?.state ?? ''}`}>{vm ? STATE_TEXT[vm.state] : '…'}</span>
        {boot && <span className="muted">старт {boot} с</span>}
        {vm && <span className="muted">кадров: в VM {vm.framesIn}, из VM {vm.framesOut}</span>}
        <div className="spacer" />
        <button
          className="btn small"
          onClick={() => {
            stopVm(d.id);
            onStop();
          }}
          title="Выключить VM (при следующем открытии загрузится заново)"
        >
          ⏻ Выключить
        </button>
      </div>
      {mode === 'simulation' && <p className="hint strong">Недоступно в режиме симуляции: Linux-хост работает только в реальном времени. VM на паузе, кадры к ней отбрасываются.</p>}
      <div ref={host} className="linux-term" />
      <p className="hint">Попробуйте: <code>ping -c 3 &lt;IP ПК&gt;</code>, <code>wget -O - http://&lt;IP сервера&gt;/</code>, <code>tcpdump -nn -i eth0</code>. Не больше {MAX_VMS} VM одновременно.</p>
    </div>
  );
}
