import { create } from 'zustand';
import {
  createDevice,
  emptyProject,
  DEVICE_LABELS,
  type CableType,
  type Device,
  type DeviceKind,
  type LinkEnd,
  type Project,
} from '@ciscobanka/engine';
import { syncSim } from '../sim/runtime';

const HISTORY_LIMIT = 200;

export interface FloatingWindow {
  deviceId: string;
  x: number;
  y: number;
  z: number;
}

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  /** Снимок до начала перетаскивания — одна запись в истории на весь drag. */
  dragBase: Project | null;

  cable: CableType | null;
  pending: LinkEnd | null;
  picker: { deviceId: string; x: number; y: number } | null;
  /** Запасной способ добавления (тачскрин): выбрали устройство в палитре, следующий клик по холсту ставит его. */
  placing: DeviceKind | null;

  windows: FloatingWindow[];
  /** Увеличивается при каждом изменении состояния симулятора — для перерисовки индикаторов и таблиц. */
  simTick: number;
  /** Растёт при открытии проекта — холст подгоняет масштаб. */
  loadSeq: number;
  theme: 'light' | 'dark';

  apply: (fn: (p: Project) => void, reason?: string) => void;
  loadProject: (p: Project) => void;
  undo: () => void;
  redo: () => void;

  addDevice: (kind: DeviceKind, pos: { x: number; y: number }) => void;
  updateDevice: (id: string, fn: (d: Device) => void, reason?: string) => void;
  beginDrag: () => void;
  dragTo: (id: string, pos: { x: number; y: number }) => void;
  endDrag: () => void;
  removeDevices: (ids: string[]) => void;
  removeLinks: (ids: string[]) => void;
  /** Удалить устройства и провода одним действием (одна запись в истории). */
  removeItems: (deviceIds: string[], linkIds: string[]) => void;

  setPlacing: (k: DeviceKind | null) => void;
  setCable: (c: CableType | null) => void;
  openPicker: (deviceId: string, x: number, y: number) => void;
  pickPort: (end: LinkEnd) => void;
  cancelCable: () => void;

  openWindow: (deviceId: string) => void;
  closeWindow: (deviceId: string) => void;
  focusWindow: (deviceId: string) => void;
  moveWindow: (deviceId: string, x: number, y: number) => void;

  bumpSim: () => void;
  toggleTheme: () => void;
}

function initialTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* нет доступа к storage */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function nextName(p: Project, kind: DeviceKind) {
  const base = DEVICE_LABELS[kind];
  let n = 0;
  while (p.devices.some((d) => d.name === `${base}${n}`)) n++;
  return `${base}${n}`;
}

function newId(kind: DeviceKind) {
  return `${kind}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const initial = emptyProject();
syncSim(initial);

export const useStore = create<State>((set, get) => {
  /** Зафиксировать новую версию проекта: история + пересинхронизация симулятора. */
  const commit = (next: Project, prev: Project, reason: string) => {
    syncSim(next, reason);
    set((s) => ({
      project: next,
      past: [...s.past, prev].slice(-HISTORY_LIMIT),
      future: [],
      simTick: s.simTick + 1,
    }));
  };

  return {
    project: initial,
    past: [],
    future: [],
    dragBase: null,
    cable: null,
    pending: null,
    picker: null,
    placing: null,
    windows: [],
    simTick: 0,
    loadSeq: 0,
    theme: initialTheme(),

    apply(fn, reason = 'Топология или настройки изменены') {
      const prev = get().project;
      const next = structuredClone(prev);
      fn(next);
      commit(next, prev, reason);
    },

    loadProject(p) {
      syncSim(p, 'Открыт проект');
      set((s) => ({ project: p, past: [], future: [], windows: [], pending: null, picker: null, simTick: s.simTick + 1, loadSeq: s.loadSeq + 1 }));
    },

    undo() {
      const { past, project, future } = get();
      const prev = past.at(-1);
      if (!prev) return;
      syncSim(prev, 'Отмена действия');
      set((s) => ({ project: prev, past: past.slice(0, -1), future: [project, ...future], simTick: s.simTick + 1, ...pruneWindows(s.windows, prev) }));
    },

    redo() {
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      syncSim(next, 'Повтор действия');
      set((s) => ({ project: next, past: [...past, project], future: future.slice(1), simTick: s.simTick + 1, ...pruneWindows(s.windows, next) }));
    },

    addDevice(kind, pos) {
      get().apply((p) => {
        p.devices.push(createDevice(kind, newId(kind), nextName(p, kind), p.seed, pos));
      }, 'Добавлено устройство');
    },

    updateDevice(id, fn, reason) {
      get().apply((p) => {
        const d = p.devices.find((x) => x.id === id);
        if (d) fn(d);
      }, reason);
    },

    beginDrag() {
      if (!get().dragBase) set({ dragBase: get().project });
    },

    dragTo(id, pos) {
      // во время перетаскивания — без истории и без пересчёта симулятора
      set((s) => ({
        project: { ...s.project, devices: s.project.devices.map((d) => (d.id === id ? { ...d, position: pos } : d)) },
      }));
    },

    endDrag() {
      const base = get().dragBase;
      if (!base) return;
      set({ dragBase: null });
      const cur = get().project;
      if (cur === base) return;
      // позиция не влияет на сеть — симулятор не сбрасываем
      set((s) => ({ past: [...s.past, base].slice(-HISTORY_LIMIT), future: [] }));
    },

    removeDevices(ids) {
      if (!ids.length) return;
      get().apply((p) => {
        p.devices = p.devices.filter((d) => !ids.includes(d.id));
        p.links = p.links.filter((l) => !ids.includes(l.a.deviceId) && !ids.includes(l.b.deviceId));
      }, 'Удалено устройство');
      set((s) => ({ windows: s.windows.filter((w) => !ids.includes(w.deviceId)) }));
    },

    removeLinks(ids) {
      if (!ids.length) return;
      get().apply((p) => {
        p.links = p.links.filter((l) => !ids.includes(l.id));
      }, 'Удалён провод');
    },

    removeItems(deviceIds, linkIds) {
      if (!deviceIds.length && !linkIds.length) return;
      get().apply((p) => {
        p.devices = p.devices.filter((d) => !deviceIds.includes(d.id));
        p.links = p.links.filter((l) => !linkIds.includes(l.id) && !deviceIds.includes(l.a.deviceId) && !deviceIds.includes(l.b.deviceId));
      }, 'Удалены объекты');
      set((s) => ({ windows: s.windows.filter((w) => !deviceIds.includes(w.deviceId)) }));
    },

    setPlacing(k) {
      set({ placing: k, cable: null, pending: null, picker: null });
    },

    setCable(c) {
      set({ cable: c, pending: null, picker: null, placing: null });
    },

    openPicker(deviceId, x, y) {
      set({ picker: { deviceId, x, y } });
    },

    pickPort(end) {
      const { pending, cable } = get();
      set({ picker: null });
      if (!cable) return;
      if (!pending) {
        set({ pending: end });
        return;
      }
      if (pending.deviceId === end.deviceId) return;
      get().apply((p) => {
        p.links.push({ id: `link-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, cable, a: pending, b: end });
      }, 'Подключён провод');
      set({ pending: null, cable: null });
    },

    cancelCable() {
      set({ cable: null, pending: null, picker: null });
    },

    openWindow(deviceId) {
      set((s) => {
        const z = Math.max(0, ...s.windows.map((w) => w.z)) + 1;
        if (s.windows.some((w) => w.deviceId === deviceId)) {
          return { windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, z } : w)) };
        }
        const off = (s.windows.length % 6) * 28;
        return { windows: [...s.windows, { deviceId, x: 260 + off, y: 80 + off, z }] };
      });
    },

    closeWindow(deviceId) {
      set((s) => ({ windows: s.windows.filter((w) => w.deviceId !== deviceId) }));
    },

    focusWindow(deviceId) {
      set((s) => {
        const top = Math.max(0, ...s.windows.map((w) => w.z));
        const w = s.windows.find((x) => x.deviceId === deviceId);
        if (!w || w.z === top) return {};
        return { windows: s.windows.map((x) => (x.deviceId === deviceId ? { ...x, z: top + 1 } : x)) };
      });
    },

    moveWindow(deviceId, x, y) {
      set((s) => ({ windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, x, y } : w)) }));
    },

    bumpSim() {
      set((s) => ({ simTick: s.simTick + 1 }));
    },

    toggleTheme() {
      const theme = get().theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('theme', theme);
      } catch {
        /* нет доступа к storage */
      }
      set({ theme });
    },
  };
});

function pruneWindows(windows: FloatingWindow[], p: Project) {
  return { windows: windows.filter((w) => p.devices.some((d) => d.id === w.deviceId)) };
}
