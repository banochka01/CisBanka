// Состояние режима симуляции в UI: шаги, анимация, фильтр, выбранный пакет, «Простой пакет».
import { create } from 'zustand';
import { l3Interfaces, type Protocol } from '@ciscobanka/engine';
import { getMode, getSim, setMode, settle, type SimMode } from '../sim/runtime';
import { useStore } from './project';

/** Длительность анимации одного хопа при скорости 1×, мс. */
export const HOP_MS = 900;

export interface Scenario {
  id: number;
  srcId: string;
  dstId: string;
  dstIp: string;
  jobId: number;
}

interface SimUi {
  mode: SimMode;
  playing: boolean;
  /** Множитель скорости: 0.25…4. */
  speed: number;
  hidden: Protocol[];
  /** Анимация текущего хопа: конверты едут от start за duration мс. */
  anim: { hop: number; start: number; duration: number } | null;
  selected: { entryId: number; tab: 'in' | 'out' } | null;
  /** Инструмент «Простой пакет»: ждём клик по источнику, потом по получателю. */
  pdu: { srcId: string | null } | null;
  pduError: string | null;
  scenarios: Scenario[];

  switchMode: (m: SimMode) => void;
  stepForward: () => boolean;
  stepBack: () => void;
  seekHop: (k: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  toggleProto: (p: Protocol) => void;
  select: (entryId: number | null, tab?: 'in' | 'out') => void;
  togglePdu: () => void;
  pduClick: (deviceId: string) => void;
  repeatScenario: (id: number) => void;
  removeScenario: (id: number) => void;
}

let scenarioSeq = 1;

const bump = () => useStore.getState().bumpSim();

/** IP устройства для ping: первый поднятый интерфейс с адресом (учитывая DHCP-аренду). */
function firstIp(deviceId: string): string | null {
  const sim = getSim();
  const ifs = l3Interfaces(sim, sim.device(deviceId));
  return ifs.find((i) => i.ip && i.up)?.ip ?? ifs.find((i) => i.ip)?.ip ?? null;
}

export const useSim = create<SimUi>((set, get) => ({
  mode: getMode(),
  playing: false,
  speed: 1,
  hidden: [],
  anim: null,
  selected: null,
  pdu: null,
  pduError: null,
  scenarios: [],

  switchMode(m) {
    if (m === get().mode) return;
    setMode(m);
    set({ mode: m, playing: false, anim: null, selected: null });
    bump();
  },

  stepForward() {
    const sim = getSim();
    const es = sim.stepHop();
    if (!es) {
      set({ playing: false, anim: null });
      return false;
    }
    const hidden = get().hidden;
    const visible = es.some((e) => e.kind === 'frame' && !(e.protocol && hidden.includes(e.protocol)));
    set({ anim: { hop: sim.hop, start: performance.now(), duration: visible ? HOP_MS / get().speed : 0 } });
    bump();
    return true;
  },

  stepBack() {
    const sim = getSim();
    if (sim.stepBackHop()) {
      // в самом начале — снова показать только что созданные пакеты у отправителей
      if (sim.hop === 0) settle();
      set({ anim: null, playing: false });
      bump();
    }
  },

  seekHop(k) {
    const sim = getSim();
    if (sim.seekHop(k)) {
      if (sim.hop === 0) settle();
      set({ anim: null, playing: false });
      bump();
    }
  },

  setPlaying(p) {
    set({ playing: p });
  },

  setSpeed(s) {
    set({ speed: s });
  },

  toggleProto(p) {
    set((st) => ({ hidden: st.hidden.includes(p) ? st.hidden.filter((x) => x !== p) : [...st.hidden, p] }));
  },

  select(entryId, tab = 'in') {
    set({ selected: entryId === null ? null : { entryId, tab } });
  },

  togglePdu() {
    useStore.getState().cancelCable();
    useStore.getState().setPlacing(null);
    set((st) => ({ pdu: st.pdu ? null : { srcId: null }, pduError: null }));
  },

  pduClick(deviceId) {
    const pdu = get().pdu;
    if (!pdu) return;
    const sim = getSim();
    if (!pdu.srcId) {
      if (!firstIp(deviceId)) {
        set({ pduError: `У «${sim.device(deviceId).name}» нет IP-адреса — он не может отправить ping.` });
        return;
      }
      set({ pdu: { srcId: deviceId }, pduError: null });
      return;
    }
    if (deviceId === pdu.srcId) return;
    const dstIp = firstIp(deviceId);
    if (!dstIp) {
      set({ pduError: `У «${sim.device(deviceId).name}» нет IP-адреса — выберите другого получателя.` });
      return;
    }
    const job = sim.ping(pdu.srcId, dstIp, 1);
    settle();
    set((st) => ({
      pdu: null,
      pduError: null,
      scenarios: [...st.scenarios, { id: scenarioSeq++, srcId: pdu.srcId!, dstId: deviceId, dstIp, jobId: job.id }],
    }));
    bump();
  },

  repeatScenario(id) {
    const sc = get().scenarios.find((s) => s.id === id);
    if (!sc) return;
    const sim = getSim();
    // адрес мог смениться (DHCP, правка настроек) — берём актуальный
    const dstIp = firstIp(sc.dstId) ?? sc.dstIp;
    const job = sim.ping(sc.srcId, dstIp, 1);
    settle();
    set((st) => ({ scenarios: st.scenarios.map((s) => (s.id === id ? { ...s, dstIp, jobId: job.id } : s)) }));
    bump();
  },

  removeScenario(id) {
    set((st) => ({ scenarios: st.scenarios.filter((s) => s.id !== id) }));
  },
}));

/** Устройства удалили — их сценарии тоже. */
useStore.subscribe((s, prev) => {
  if (s.project.devices === prev.project.devices) return;
  const ids = new Set(s.project.devices.map((d) => d.id));
  const sc = useSim.getState().scenarios;
  const keep = sc.filter((x) => ids.has(x.srcId) && ids.has(x.dstId));
  if (keep.length !== sc.length) useSim.setState({ scenarios: keep });
});
