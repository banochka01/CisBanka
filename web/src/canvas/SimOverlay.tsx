import { useEffect, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { protocolOf, type LogEntry, type Packet, type Protocol } from '@ciscobanka/engine';
import { useStore } from '../store/project';
import { useSim } from '../store/sim';
import { getSim } from '../sim/runtime';
import { CENTER, PROTO_COLORS, decisionLabel, exitDist } from '../sim/visual';

type Pt = { x: number; y: number };

/** Расстояние между конвертами на одном проводе (поперёк провода). */
const SPREAD = 16;

interface Env {
  key: string;
  linkId: string;
  from: string;
  to: string;
  protocol: Protocol;
  /** Клик по конверту: какая запись журнала и какая вкладка разбора. */
  entryId: number | null;
  tab: 'in' | 'out';
}

function Envelope({ color, selected }: { color: string; selected: boolean }) {
  return (
    <svg width="24" height="17" viewBox="0 0 24 17" aria-hidden>
      <rect x="1" y="1" width="22" height="15" rx="2" fill={color} stroke={selected ? 'var(--text)' : '#fff'} strokeWidth={selected ? 2 : 1.2} />
      <path d="M2 2.5 L12 9.5 L22 2.5" fill="none" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

/** Конверты, крестики сброса и подписи решений поверх холста (режим симуляции). */
export function SimOverlay() {
  const devices = useStore((s) => s.project.devices);
  useStore((s) => s.simTick);
  const anim = useSim((s) => s.anim);
  const hidden = useSim((s) => s.hidden);
  const selected = useSim((s) => s.selected);
  const select = useSim((s) => s.select);
  const [now, setNow] = useState(() => performance.now());
  const [openCross, setOpenCross] = useState<number | null>(null);

  const sim = getSim();
  const animating = !!anim && anim.hop === sim.hop && anim.duration > 0 && now - anim.start < anim.duration;

  useEffect(() => {
    if (!anim || anim.duration <= 0) return;
    let raf = 0;
    const tick = () => {
      const t = performance.now();
      setNow(t);
      if (t - anim.start < anim.duration) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF не тикает во фоновой вкладке — гарантируем финальный кадр таймером
    const done = setTimeout(() => setNow(performance.now()), anim.duration + 30);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [anim]);

  useEffect(() => setOpenCross(null), [anim, sim.hop]);

  const center = (id: string): Pt | null => {
    const d = devices.find((x) => x.id === id);
    return d ? { x: d.position.x + CENTER.x, y: d.position.y + CENTER.y } : null;
  };

  /** Отрезок провода между краями узлов (по нему едут конверты). */
  const segment = (from: string, to: string): [Pt, Pt, Pt] | null => {
    const a = center(from);
    const b = center(to);
    if (!a || !b) return null;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let da = exitDist(ux, uy) + 10;
    let db = exitDist(-ux, -uy) + 10;
    if (da + db > len) da = db = len / 2;
    return [
      { x: a.x + ux * da, y: a.y + uy * da },
      { x: b.x - ux * db, y: b.y - uy * db },
      { x: -uy, y: ux },
    ];
  };

  const visible = (p?: Protocol) => !p || !hidden.includes(p);
  const t = animating ? Math.min(1, (now - anim!.start) / anim!.duration) : 1;
  const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

  // конверты: во время анимации — пришедшие в этом хопе кадры, иначе — кадры в пути (ещё у отправителя)
  const envs: Env[] = [];
  if (animating) {
    for (const e of sim.hopEntries()) {
      if (e.kind !== 'frame' || !e.linkId || !e.fromDeviceId || !visible(e.protocol)) continue;
      envs.push({ key: `e${e.id}`, linkId: e.linkId, from: e.fromDeviceId, to: e.deviceId!, protocol: e.protocol!, entryId: e.id, tab: 'in' });
    }
  } else {
    for (const ev of sim.pending) {
      if (ev.kind !== 'rx') continue;
      const protocol = protocolOf(ev.packet);
      if (!visible(protocol)) continue;
      envs.push({ key: `p${ev.packet.id}`, linkId: ev.linkId, from: ev.fromDeviceId, to: ev.deviceId, protocol, entryId: sourceEntry(ev.packet), tab: 'out' });
    }
  }
  const perLink = new Map<string, number>();
  for (const e of envs) perLink.set(e.linkId, (perLink.get(e.linkId) ?? 0) + 1);
  const seen = new Map<string, number>();

  const entries = animating ? [] : sim.hopEntries();
  const crosses: { e: LogEntry; at: Pt }[] = [];
  const labels = new Map<string, string[]>();
  for (const e of entries) {
    if (!visible(e.protocol)) continue;
    if (e.action === 'drop' && (e.kind === 'frame' || e.kind === 'drop')) {
      let at: Pt | null = null;
      if (e.kind === 'frame' && e.fromDeviceId) {
        // на проводе чуть раньше устройства — чтобы не закрывать подпись решения над ним
        const s = segment(e.fromDeviceId, e.deviceId!);
        if (s) {
          const [a, b] = s;
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const k = Math.max(0, 1 - 28 / len);
          at = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        }
      }
      else if (e.portId) {
        const link = sim.linkOf(e.portId);
        const peer = link && (link.a.portId === e.portId ? link.b.deviceId : link.a.deviceId);
        if (peer) {
          const s = segment(e.deviceId!, peer);
          if (s) at = { x: s[0].x + (s[1].x - s[0].x) * 0.25, y: s[0].y + (s[1].y - s[0].y) * 0.25 };
        }
      }
      const c = center(e.deviceId!);
      at ??= c && { x: c.x + 26, y: c.y - 26 };
      if (at) crosses.push({ e, at: { x: at.x + crosses.filter((x) => x.at.x === at!.x && x.at.y === at!.y).length * 10, y: at.y } });
    }
    if (e.kind === 'frame' || e.kind === 'send' || e.kind === 'drop') {
      const l = decisionLabel(sim, e);
      const arr = labels.get(e.deviceId!) ?? [];
      if (l && !arr.includes(l)) arr.push(l);
      labels.set(e.deviceId!, arr);
    }
  }

  return (
    <ViewportPortal>
      <div className="sim-overlay">
        {[...labels].map(([id, ls]) => {
          const c = center(id);
          if (!c || !ls.length) return null;
          const text = ls.length > 2 ? `${ls.slice(0, 2).join(' · ')} …` : ls.join(' · ');
          return (
            <div key={`l${id}`} className="decision" style={{ transform: `translate(-50%,-100%) translate(${c.x}px,${c.y - 36}px)` }}>
              {text}
            </div>
          );
        })}
        {envs.map((e) => {
          const s = segment(e.from, e.to);
          if (!s) return null;
          const [a, b, n] = s;
          const k = animating ? ease : 0;
          const i = seen.get(e.linkId) ?? 0;
          seen.set(e.linkId, i + 1);
          const off = (i - ((perLink.get(e.linkId) ?? 1) - 1) / 2) * SPREAD;
          const x = a.x + (b.x - a.x) * k + n.x * off;
          const y = a.y + (b.y - a.y) * k + n.y * off;
          const isSel = selected?.entryId === e.entryId && e.entryId !== null;
          return (
            <button
              key={e.key}
              className="envelope nodrag nopan"
              style={{ transform: `translate(-50%,-50%) translate(${x}px,${y}px)` }}
              title={`${e.protocol} — нажмите, чтобы разобрать пакет`}
              onClick={() => e.entryId !== null && select(e.entryId, e.tab)}
            >
              <Envelope color={PROTO_COLORS[e.protocol]} selected={isSel} />
            </button>
          );
        })}
        {crosses.map(({ e, at }) => (
          <div key={`x${e.id}`} className="drop-mark-wrap" style={{ transform: `translate(${at.x}px,${at.y}px)` }}>
            <button
              className="drop-mark nodrag nopan"
              title="Пакет сброшен — нажмите, чтобы узнать почему"
              onClick={() => {
                setOpenCross(openCross === e.id ? null : e.id);
                select(e.id, 'in');
              }}
            >
              ✕
            </button>
            {openCross === e.id && (
              <div className="drop-pop">
                <b>Почему сброшен:</b> {e.reason}
              </div>
            )}
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

/** Запись журнала, в «Выходе» которой есть этот пакет (кто его отправил). */
function sourceEntry(p: Packet): number | null {
  const log = getSim().log;
  for (let i = log.length - 1; i >= 0 && i >= log.length - 2000; i--) {
    if (log[i].out?.some((o) => o.packet.id === p.id)) return log[i].id;
  }
  return null;
}
