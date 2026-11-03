// Захваты трафика (снифферы) в UI. Сам захват — engine Capture, читающий журнал симулятора;
// здесь — список вкладок, активная вкладка и состояние док-панели.
import { create } from 'zustand';
import { Capture, type CapturePoint } from '@ciscobanka/engine';
import { getSim } from '../sim/runtime';
import { useStore } from './project';

export interface CaptureTab {
  id: number;
  point: CapturePoint;
  cap: Capture;
  /** Меняется при каждом изменении списка кадров — для перерисовки. */
  version: number;
}

interface CaptureUi {
  tabs: CaptureTab[];
  active: number | null;
  /** Док-панель снизу или отдельное плавающее окно. */
  detached: boolean;
  height: number;
  collapsed: boolean;

  start: (point: CapturePoint) => void;
  stop: (id: number) => void;
  resume: (id: number) => void;
  clear: (id: number) => void;
  close: (id: number) => void;
  setActive: (id: number) => void;
  setDetached: (v: boolean) => void;
  setHeight: (h: number) => void;
  setCollapsed: (v: boolean) => void;
  /** Подтянуть новые кадры во все работающие захваты. */
  sync: () => void;
}

let seq = 1;

const samePoint = (a: CapturePoint, b: CapturePoint) =>
  a.kind === b.kind && (a.kind === 'link' ? a.linkId === (b as typeof a).linkId : a.portId === (b as Extract<CapturePoint, { kind: 'port' }>).portId);

/** Подпись вкладки: «ПК1 Fa0 ↔ Свитч Fa0/1» или «ПК1 Fa0». */
export function pointTitle(point: CapturePoint): string {
  const { project } = useStore.getState();
  const port = (portId: string) => {
    for (const d of project.devices) {
      const p = d.ports.find((x) => x.id === portId);
      if (p) return `${d.name} ${p.name}`;
    }
    return '?';
  };
  if (point.kind === 'port') return port(point.portId);
  const l = project.links.find((x) => x.id === point.linkId);
  return l ? `${port(l.a.portId)} ↔ ${port(l.b.portId)}` : 'Удалённый линк';
}

const tab = (t: CaptureTab): CaptureTab => ({ ...t, version: t.version + 1 });

export const useCapture = create<CaptureUi>((set, get) => ({
  tabs: [],
  active: null,
  detached: false,
  height: 300,
  collapsed: false,

  start(point) {
    const existing = get().tabs.find((t) => samePoint(t.point, point));
    if (existing) {
      if (!existing.cap.running) get().resume(existing.id);
      set({ active: existing.id, collapsed: false });
      return;
    }
    const t: CaptureTab = { id: seq++, point, cap: new Capture(point, getSim()), version: 0 };
    set((s) => ({ tabs: [...s.tabs, t], active: t.id, collapsed: false }));
  },

  stop(id) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? (t.cap.stop(getSim()), tab(t)) : t)) }));
  },

  resume(id) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? (t.cap.resume(getSim()), tab(t)) : t)) }));
  },

  clear(id) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? (t.cap.clear(getSim()), tab(t)) : t)) }));
  },

  close(id) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return { tabs, active: s.active === id ? tabs.at(-1)?.id ?? null : s.active };
    });
  },

  setActive(id) {
    set({ active: id, collapsed: false });
  },

  setDetached(v) {
    set({ detached: v });
  },

  setHeight(h) {
    set({ height: Math.max(120, Math.min(Math.round(window.innerHeight * 0.8), h)) });
  },

  setCollapsed(v) {
    set({ collapsed: v });
  },

  sync() {
    const sim = getSim();
    let any = false;
    const tabs = get().tabs.map((t) => {
      if (!t.cap.sync(sim)) return t;
      any = true;
      return tab(t);
    });
    if (any) set({ tabs });
  },
}));

/** Любое изменение симуляции (шаг, команда, смена топологии) — подтягиваем кадры. */
useStore.subscribe((s, prev) => {
  if (s.simTick !== prev.simTick && useCapture.getState().tabs.length) useCapture.getState().sync();
});

/** Идёт ли захват на этом линке (для лупы на проводе). */
export const useLinkCaptured = (linkId: string) =>
  useCapture((s) => s.tabs.some((t) => t.point.kind === 'link' && t.point.linkId === linkId && t.cap.running));

/** Идёт ли захват на одном из портов. */
export const usePortsCaptured = (portIds: string[]) =>
  useCapture((s) => s.tabs.some((t) => t.point.kind === 'port' && t.cap.running && portIds.includes(t.point.portId)));
