import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LogEntry } from '@ciscobanka/engine';
import { useStore } from '../store/project';
import { useSim, type Scenario } from '../store/sim';
import { getJournalFrom, getSim } from './runtime';
import { PROTOCOLS, PROTO_COLORS, PROTO_HINTS, decisionLabel } from './visual';
import { osiLayers } from './osi';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const JOURNAL_LIMIT = 400;

/** Правая панель: управление симуляцией, легенда/фильтр, журнал, сценарии, разбор пакета. */
export function SimPanel() {
  const mode = useSim((s) => s.mode);
  const scenarios = useSim((s) => s.scenarios);
  const pdu = useSim((s) => s.pdu);
  const [tab, setTab] = useState<'log' | 'scen'>('log');
  const sim = mode === 'simulation';
  if (!sim && !scenarios.length && !pdu) return null;
  const t = sim ? tab : 'scen';

  return (
    <aside className="sim-panel">
      {sim && <Controls />}
      {sim && <Legend />}
      <div className="tabs">
        {sim && (
          <button className={`tab${t === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>
            Журнал
          </button>
        )}
        <button className={`tab${t === 'scen' ? ' active' : ''}`} onClick={() => setTab('scen')}>
          Сценарии{scenarios.length ? ` (${scenarios.length})` : ''}
        </button>
      </div>
      {t === 'log' ? <Journal /> : <Scenarios />}
      {sim && <PacketDetails />}
    </aside>
  );
}

function usePlayLoop() {
  const playing = useSim((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      const st = useSim.getState();
      if (!st.playing || !st.stepForward()) return;
      const a = useSim.getState().anim;
      timer = setTimeout(loop, (a?.duration ?? 0) + 200 / useSim.getState().speed);
    };
    loop();
    return () => clearTimeout(timer);
  }, [playing]);
}

function Controls() {
  usePlayLoop();
  useStore((s) => s.simTick);
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const { stepForward, stepBack, setPlaying, setSpeed, togglePdu } = useSim.getState();
  const pdu = useSim((s) => s.pdu);
  const s = getSim();
  const idle = s.pending.length === 0;

  return (
    <div className="sim-controls">
      <div className="sim-buttons">
        <button className="btn icon" onClick={stepBack} disabled={s.hop === 0} title="Шаг назад">⏮</button>
        <button
          className="btn icon primary"
          onClick={() => setPlaying(!playing)}
          disabled={idle && !playing}
          title={playing ? 'Пауза' : 'Воспроизвести'}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button className="btn icon" onClick={() => stepForward()} disabled={idle || playing} title="Шаг вперёд (один хоп)">⏭</button>
        <button className={`btn${pdu ? ' primary' : ''}`} onClick={togglePdu} title="Простой пакет: клик по отправителю, затем по получателю">
          ✉ Простой пакет
        </button>
      </div>
      <div className="sim-status">
        <span>Хоп {s.hop}</span>
        <span>t = {s.now} мс</span>
        <label className="speed">
          Скорость
          <input type="range" min={0} max={SPEEDS.length - 1} step={1} value={SPEEDS.indexOf(speed)} onChange={(e) => setSpeed(SPEEDS[Number(e.target.value)])} />
          {speed}×
        </label>
      </div>
      {idle && <div className="hint">В сети тихо. Отправьте «Простой пакет» или ping из окна ПК.</div>}
    </div>
  );
}

function Legend() {
  const hidden = useSim((s) => s.hidden);
  const toggle = useSim((s) => s.toggleProto);
  return (
    <div className="legend" aria-label="Фильтр протоколов">
      {PROTOCOLS.map((p) => {
        const off = hidden.includes(p);
        return (
          <button key={p} className={`chip${off ? ' off' : ''}`} onClick={() => toggle(p)} title={`${PROTO_HINTS[p]} — ${off ? 'показать' : 'скрыть'}`}>
            <span className="chip-dot" style={{ background: PROTO_COLORS[p] }} />
            {p}
          </button>
        );
      })}
    </div>
  );
}

function entryWhere(e: LogEntry) {
  const s = getSim();
  const n = (id?: string) => (id ? safeName(id) : '');
  if (e.kind === 'frame' && e.fromDeviceId) return `${n(e.fromDeviceId)} → ${n(e.deviceId)}`;
  return n(e.deviceId) || '—';

  function safeName(id: string) {
    try {
      return s.device(id).name;
    } catch {
      return '?';
    }
  }
}

function Journal() {
  useStore((s) => s.simTick);
  const hidden = useSim((s) => s.hidden);
  const selected = useSim((s) => s.selected);
  const ref = useRef<HTMLDivElement>(null);
  const s = getSim();
  const all = s.log.slice(getJournalFrom());
  const rows = all.filter((e) => !e.protocol || !hidden.includes(e.protocol)).slice(-JOURNAL_LIMIT);
  const cur = s.hop;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const open = (e: LogEntry) => {
    const k = s.hopOf(e);
    const st = useSim.getState();
    if (k >= 1 && k !== s.hop) st.seekHop(k);
    st.select(e.id, e.kind === 'send' ? 'out' : 'in');
  };

  return (
    <div className="journal" ref={ref}>
      {!rows.length && <p className="muted pad">Журнал пуст. Шагайте вперёд — здесь появится каждое событие.</p>}
      <table className="grid journal-table">
        <tbody>
          {rows.map((e) => {
            const k = s.hopOf(e);
            const label = e.kind === 'reset' ? 'Сброс' : e.kind === 'info' ? 'Инфо' : decisionLabel(s, e);
            return (
              <tr
                key={e.id}
                className={`${k === cur && cur > 0 ? 'current' : ''}${selected?.entryId === e.id ? ' sel' : ''}${e.action === 'drop' ? ' dropped' : ''}`}
                onClick={() => open(e)}
                title={e.reason}
              >
                <td className="muted">{k > 0 ? k : ''}</td>
                <td>{e.protocol && <span className="chip-dot" style={{ background: PROTO_COLORS[e.protocol] }} title={e.protocol} />}</td>
                <td className="j-where">{entryWhere(e)}</td>
                <td className="j-what">
                  <b>{label}</b> <span className="muted">{e.reason}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function scenarioStatus(sc: Scenario): { text: string; cls: string } {
  const job = getSim().job(sc.jobId);
  if (!job) return { text: 'не запущен', cls: 'muted' };
  if (!job.done) return { text: 'в пути…', cls: '' };
  return Object.values(job.results ?? {}).includes('ok') ? { text: 'Успешно', cls: 'ok' } : { text: 'Неудача', cls: 'bad' };
}

function Scenarios() {
  useStore((s) => s.simTick);
  const devices = useStore((s) => s.project.devices);
  const scenarios = useSim((s) => s.scenarios);
  const { repeatScenario, removeScenario, togglePdu } = useSim.getState();
  const pdu = useSim((s) => s.pdu);
  const name = (id: string) => devices.find((d) => d.id === id)?.name ?? '?';
  return (
    <div className="scenarios">
      {!scenarios.length && <p className="muted pad">Нажмите «✉ Простой пакет», затем отправителя и получателя на холсте.</p>}
      {scenarios.length > 0 && (
        <table className="grid">
          <thead>
            <tr><th>№</th><th>Откуда</th><th>Куда</th><th>Статус</th><th /></tr>
          </thead>
          <tbody>
            {scenarios.map((sc, i) => {
              const st = scenarioStatus(sc);
              return (
                <tr key={sc.id}>
                  <td>{i + 1}</td>
                  <td>{name(sc.srcId)}</td>
                  <td title={sc.dstIp}>{name(sc.dstId)}</td>
                  <td className={st.cls}>{st.text}</td>
                  <td className="nowrap">
                    <button className="btn small" onClick={() => repeatScenario(sc.id)} title="Отправить ещё раз">↻</button>{' '}
                    <button className="btn small" onClick={() => removeScenario(sc.id)} title="Удалить сценарий">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="pad">
        <button className={`btn${pdu ? ' primary' : ''}`} onClick={togglePdu}>✉ Простой пакет</button>
      </div>
    </div>
  );
}

function PacketDetails() {
  useStore((s) => s.simTick);
  const selected = useSim((s) => s.selected);
  const select = useSim((s) => s.select);
  const [outIdx, setOutIdx] = useState(0);
  useEffect(() => setOutIdx(0), [selected?.entryId]);
  if (!selected) return null;
  const s = getSim();
  const e = s.log[selected.entryId - 1];
  if (!e || e.id !== selected.entryId) return null;
  const devName = e.deviceId ? s.device(e.deviceId).name : '';
  const out = e.out ?? [];
  const o = out[Math.min(outIdx, out.length - 1)];
  const tab = selected.tab;

  let body: React.ReactNode;
  if (tab === 'in') {
    if (e.kind === 'send') body = <p className="muted">Пакет создан на этом устройстве — входящего кадра нет. Смотрите «Выход».</p>;
    else if (e.packet) body = <Layers layers={osiLayers(s, e.portId, e.packet, 'in')} />;
    else body = <p className="muted">Нет данных о пакете.</p>;
  } else if (o) {
    body = (
      <>
        {out.length > 1 && (
          <div className="out-ports">
            Копии ушли в {out.length} порта:{' '}
            {out.map((x, i) => (
              <button key={i} className={`chip${i === outIdx ? '' : ' off'}`} onClick={() => setOutIdx(i)}>
                {s.portById(x.portId)?.port.name}
              </button>
            ))}
          </div>
        )}
        <Layers layers={osiLayers(s, o.portId, o.packet, 'out')} />
      </>
    );
  } else {
    body = <p className="muted">{e.action === 'drop' ? 'Ничего не отправлено — пакет сброшен.' : 'Устройство ничего не отправило дальше.'}</p>;
  }

  return (
    <div className="pdu-details">
      <div className="pdu-head">
        <b>
          {e.protocol ?? 'Событие'} · {devName}
          {e.portId && s.portById(e.portId) ? ` (${s.portById(e.portId)!.port.name})` : ''}
        </b>
        <button className="window-close" onClick={() => select(null)} title="Закрыть">✕</button>
      </div>
      <div className={`decision-box${e.action === 'drop' ? ' bad-box' : ''}`}>
        <b>{decisionLabel(s, e) || 'Решение'}:</b> {e.reason}
      </div>
      <div className="tabs">
        <button className={`tab${tab === 'in' ? ' active' : ''}`} onClick={() => select(e.id, 'in')}>Вход</button>
        <button className={`tab${tab === 'out' ? ' active' : ''}`} onClick={() => select(e.id, 'out')}>
          Выход{out.length ? ` (${out.length})` : ''}
        </button>
      </div>
      <div className="pdu-body">{body}</div>
    </div>
  );
}

function Layers({ layers }: { layers: ReturnType<typeof osiLayers> }) {
  return (
    <ol className="osi">
      {layers.map((l, i) => (
        <li key={i}>
          <div className="osi-head">
            <span className="osi-n">L{l.n}</span> <span className="muted">{l.name}</span>
          </div>
          <div className="mono">{l.head}</div>
          <div className="osi-text">{l.text}</div>
        </li>
      ))}
    </ol>
  );
}
