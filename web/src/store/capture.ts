// Захваты трафика (снифферы) в UI. Сам захват — engine Capture, читающий журнал симулятора;
// здесь — список вкладок, активная вкладка и состояние док-панели.
import { create } from 'zustand';
import { Capture, type AnyFrame, type CapturedFrame, type CapturePoint, type FileCapture } from '@ciscobanka/engine';
import { getSim } from '../sim/runtime';
import { useStore } from './project';
import { useSim } from './sim';

/** Точка захвата или открытый файл (только просмотр, без связи со схемой). */
export type TabPoint = CapturePoint | { kind: 'file'; name: string };

export interface CaptureTab {
  id: number;
  point: TabPoint;
  cap: Capture | FileCapture;
  /** Меняется при каждом изменении списка кадров — для перерисовки. */
  version: number;
  /** Применённый display-фильтр. */
  filter: string;
  /** Выбранный кадр (номер). */
  selected: number | null;
  /** Счётчик «прокрути к выбранному» (выбор пришёл со схемы). */
  scrollSeq: number;
}

/** Путь выбранного пакета на схеме. */
export interface PathHighlight {
  links: Set<string>;
  devices: Set<string>;
}

interface CaptureUi {
  tabs: CaptureTab[];
  active: number | null;
  /** Док-панель снизу или отдельное плавающее окно. */
  detached: boolean;
  height: number;
  collapsed: boolean;
  highlight: PathHighlight | null;
  /** Открыт диалог «Follow TCP stream». */
  follow: { tabId: number; stream: number } | null;

  start: (point: CapturePoint) => void;
  /** Вкладка с открытым файлом захвата (разбор файла — capture/openPcap, грузится лениво). */
  openFile: (cap: FileCapture) => void;
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
  setFilter: (id: number, text: string) => void;
  /** Выбрать кадр; fromScheme — выбор пришёл со схемы (не дёргаем схему обратно). */
  select: (id: number, no: number | null, fromScheme?: boolean) => void;
  setFollow: (f: { tabId: number; stream: number } | null) => void;
}

/**
 * Путь пакета по схеме: все передачи этого кадра (копии при flood) и, для IP, этой же
 * датаграммы на других участках (тот же src/dst/proto/Identification — роутер пересоздаёт кадр).
 */
export function packetPath(f: CapturedFrame): PathHighlight {
  const sim = getSim();
  const p = f.packet;
  const links = new Set<string>();
  const devices = new Set<string>();
  const ip = p.l3;
  for (let i = 0; i < sim.logCursor; i++) {
    const e = sim.log[i];
    if (e.kind !== 'frame' || !e.packet || !e.linkId) continue;
    const q = e.packet;
    const same =
      q.frameId === p.frameId ||
      (!!ip && !!q.l3 && ip.ipId !== undefined && q.l3.ipId === ip.ipId && q.l3.src === ip.src && q.l3.dst === ip.dst && q.l3.proto === ip.proto && q.icmp?.type === p.icmp?.type);
    if (!same) continue;
    links.add(e.linkId);
    if (e.fromDeviceId) devices.add(e.fromDeviceId);
    if (e.deviceId) devices.add(e.deviceId);
  }
  return { links, devices };
}

let seq = 1;

const samePoint = (a: TabPoint, b: CapturePoint) =>
  a.kind === b.kind && (a.kind === 'link' ? a.linkId === (b as typeof a).linkId : a.kind === 'port' && a.portId === (b as Extract<CapturePoint, { kind: 'port' }>).portId);

/** Подпись вкладки: «ПК1 Fa0 ↔ Свитч Fa0/1» или «ПК1 Fa0». */
export function pointTitle(point: TabPoint): string {
  if (point.kind === 'file') return `📄 ${point.name}`;
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
  height: Math.max(260, Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * 0.45)),
  collapsed: false,
  highlight: null,
  follow: null,

  start(point) {
    const existing = get().tabs.find((t) => samePoint(t.point, point));
    if (existing) {
      if (!existing.cap.running) get().resume(existing.id);
      set({ active: existing.id, collapsed: false });
      return;
    }
    const t: CaptureTab = { id: seq++, point, cap: new Capture(point, getSim()), version: 0, filter: '', selected: null, scrollSeq: 0 };
    set((s) => ({ tabs: [...s.tabs, t], active: t.id, collapsed: false }));
  },

  openFile(cap) {
    const t: CaptureTab = { id: seq++, point: { kind: 'file', name: cap.name }, cap, version: 0, filter: '', selected: null, scrollSeq: 0 };
    set((s) => ({ tabs: [...s.tabs, t], active: t.id, collapsed: false, highlight: null }));
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
      return { tabs, active: s.active === id ? tabs.at(-1)?.id ?? null : s.active, highlight: s.active === id ? null : s.highlight, follow: s.follow?.tabId === id ? null : s.follow };
    });
  },

  setActive(id) {
    set({ active: id, collapsed: false, highlight: null });
    const t = get().tabs.find((x) => x.id === id);
    if (t?.selected) get().select(id, t.selected);
  },

  setFilter(id, text) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...tab(t), filter: text } : t)) }));
  },

  select(id, no, fromScheme = false) {
    const t = get().tabs.find((x) => x.id === id);
    if (!t) return;
    const f: AnyFrame | undefined = no === null ? undefined : t.cap.frames[no - 1];
    // Кадры из файла не связаны со схемой — подсветки пути нет.
    // (проверка без isImported: модуль файлов захвата грузится лениво вместе с анализатором)
    const live = f && !('bytes' in f) ? f : undefined;
    set((s) => ({
      tabs: s.tabs.map((x) => (x.id === id ? { ...x, selected: f ? no : null, scrollSeq: fromScheme ? x.scrollSeq + 1 : x.scrollSeq } : x)),
      highlight: live ? packetPath(live) : null,
    }));
    // В режиме симуляции — открыть разбор этой записи журнала (и выделить конверт).
    if (live && !fromScheme && useSim.getState().mode === 'simulation' && useSim.getState().selected?.entryId !== live.entry.id) {
      useSim.getState().select(live.entry.id, 'in');
    }
  },

  setFollow(f) {
    set({ follow: f });
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
      const keep = t.selected !== null && t.selected <= t.cap.frames.length;
      return { ...tab(t), selected: keep ? t.selected : null };
    });
    if (any) set({ tabs });
  },
}));

/** Любое изменение симуляции (шаг, команда, смена топологии) — подтягиваем кадры. */
useStore.subscribe((s, prev) => {
  if (s.simTick !== prev.simTick && useCapture.getState().tabs.length) useCapture.getState().sync();
});

/**
 * Выбор со схемы (конверт, строка журнала) → выбрать этот кадр в активном захвате.
 * Ищем ту же запись журнала, иначе тот же кадр (frameId) на этом проводе.
 */
useSim.subscribe((s, prev) => {
  const id = s.selected?.entryId;
  if (!id || id === prev.selected?.entryId) return;
  const st = useCapture.getState();
  const order = [...st.tabs].sort((a, b) => (a.id === st.active ? -1 : b.id === st.active ? 1 : 0));
  const entry = getSim().log[id - 1];
  for (const t of order) {
    if (!(t.cap instanceof Capture)) continue;
    const f = t.cap.frames.find((x) => x.entry.id === id) ?? (entry?.packet && t.cap.frames.find((x) => x.packet.frameId === entry.packet!.frameId));
    if (f) {
      if (t.selected === f.no && st.active === t.id) return;
      useCapture.setState({ active: t.id });
      st.select(t.id, f.no, true);
      return;
    }
  }
});

/** Идёт ли захват на этом линке (для лупы на проводе). */
export const useLinkCaptured = (linkId: string) =>
  useCapture((s) => s.tabs.some((t) => t.point.kind === 'link' && t.point.linkId === linkId && t.cap.running));

/** Идёт ли захват на одном из портов. */
export const usePortsCaptured = (portIds: string[]) =>
  useCapture((s) => s.tabs.some((t) => t.point.kind === 'port' && t.cap.running && portIds.includes(t.point.portId)));

// Только в разработке: «перерисовать после команд из консоли» (см. __cisbanka в sim/runtime).
if (import.meta.env.DEV) Object.assign((globalThis as unknown as Record<string, object>).__cisbanka ?? {}, { bump: () => useStore.getState().bumpSim() });
