// Вкладка «Терминал» Linux-хоста. Сам v86 и xterm.js — в ленивом чанке, грузятся по кнопке.
import { lazy, Suspense, useState } from 'react';
import type { Device } from '@ciscobanka/engine';
import { useSim } from '../store/sim';

const LinuxConsole = lazy(() => import('./LinuxConsole'));
/** Какие VM уже запускали (чтобы при повторном открытии окна сразу показать терминал). */
const started = new Set<string>();

export function LinuxTab({ d }: { d: Device }) {
  const [on, setOn] = useState(started.has(d.id));
  const mode = useSim((s) => s.mode);
  if (!on)
    return (
      <div>
        <p className="hint">
          Экспериментальное устройство: настоящий Linux (Buildroot, ядро 6.8) в эмуляторе v86 прямо в браузере. Загрузка — около 10 МБ, Linux стартует
          за несколько секунд. IP берётся из вкладки «Настройка IP».
        </p>
        {mode === 'simulation' ? (
          <p className="hint strong">Недоступно в режиме симуляции — переключитесь в «Реальное время».</p>
        ) : (
          <button
            className="btn"
            onClick={() => {
              started.add(d.id);
              setOn(true);
            }}
          >
            ▶ Запустить Linux
          </button>
        )}
      </div>
    );
  return (
    <Suspense fallback={<p className="hint">Загрузка эмулятора…</p>}>
      <LinuxConsole
        d={d}
        onStop={() => {
          started.delete(d.id);
          setOn(false);
        }}
      />
    </Suspense>
  );
}
