import type { Device, Link, Port, Project } from '../model/topology';
import type { Packet } from '../model/packet';
import { protocolOf } from '../model/packet';
import type { LogEntry, Verdict } from '../model/events';
import { checkCable } from '../l1/cabling';
import { mulberry32 } from '../util/prng';
import { emptyRuntime, type DeviceRuntime, type Job, type QEvent, type SimState } from './state';
import { switchRx, hubRx } from '../l2/switching';
import { l3Rx, onArpTimeout } from '../l3/stack';
import * as apps from '../apps/jobs';

/** Задержка передачи по проводу, мс модельного времени. */
export const LINK_DELAY = 1;

export interface SimOptions {
  /** Сколько кадров может обработать сеть за один такт (1 мс). Больше — считаем broadcast storm. */
  maxEventsPerTick?: number;
  /** Сколько свитчей может пройти один кадр. Больше — петля. */
  maxL2Hops?: number;
  /** Глубина истории для «шага назад». */
  maxSnapshots?: number;
  arpTtl?: number;
  arpTimeout?: number;
  macAging?: number;
}

const DEFAULTS: Required<SimOptions> = {
  maxEventsPerTick: 500,
  maxL2Hops: 32,
  maxSnapshots: 2000,
  arpTtl: 120_000,
  arpTimeout: 1000,
  macAging: 300_000,
};

export type Led = 'none' | 'green' | 'orange' | 'red';

type NewEvent = QEvent extends infer E ? (E extends QEvent ? Omit<E, 'seq' | 'time'> : never) : never;

/**
 * Дискретно-событийный симулятор.
 *
 * Топология (Project) неизменна, пока идёт симуляция. Любое изменение топологии
 * или конфигурации делается через setTopology(): Runtime (MAC/ARP-таблицы, DHCP-аренды,
 * пакеты в пути, задачи) сбрасывается, история шагов очищается, в журнал пишется
 * запись kind='reset'. Так «шаг назад» никогда не смешивает две разные топологии.
 */
export class Simulator {
  readonly opts: Required<SimOptions>;
  project!: Project;
  state!: SimState;
  log: LogEntry[] = [];
  private devices = new Map<string, Device>();
  private ports = new Map<string, { device: Device; port: Port }>();
  private portLinks = new Map<string, Link>();
  private snapshots: { state: SimState; logLen: number }[] = [];

  constructor(project: Project, opts: SimOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.load(project);
    this.state = this.freshState(0);
    this.boot();
  }

  // ---------- топология ----------

  private load(project: Project) {
    this.project = structuredClone(project);
    this.devices.clear();
    this.ports.clear();
    this.portLinks.clear();
    for (const d of this.project.devices) {
      this.devices.set(d.id, d);
      for (const p of d.ports) this.ports.set(p.id, { device: d, port: p });
    }
    for (const l of this.project.links) {
      this.portLinks.set(l.a.portId, l);
      this.portLinks.set(l.b.portId, l);
    }
  }

  /** Применить изменённую топологию/конфиг: Runtime сбрасывается с пометкой в журнале. */
  setTopology(project: Project, reason = 'Топология или настройки изменены') {
    this.load(project);
    this.state = this.freshState(this.state.time, this.state.nextId);
    this.snapshots = [];
    this.addLog({
      kind: 'reset',
      reason: `${reason}: состояние симуляции сброшено — MAC- и ARP-таблицы очищены, пакеты в пути удалены, задачи остановлены`,
    });
    this.boot();
  }

  private freshState(time: number, nextId = 1): SimState {
    return { time, seq: 0, nextId, rng: this.project.seed >>> 0, queue: [], rt: {}, jobs: {}, tick: { t: -1, n: 0 } };
  }

  /** При старте хосты с DHCP сами запрашивают адрес. */
  private boot() {
    for (const d of this.project.devices) {
      if (d.ports.some((p) => p.l3?.dhcp)) apps.startDhcp(this, d.id);
    }
  }

  device(id: string): Device {
    const d = this.devices.get(id);
    if (!d) throw new Error(`Нет устройства ${id}`);
    return d;
  }

  portById(portId: string) {
    return this.ports.get(portId);
  }

  linkOf(portId: string): Link | undefined {
    return this.portLinks.get(portId);
  }

  linkStatus(link: Link): { up: boolean; reason?: string } {
    const a = this.ports.get(link.a.portId)!;
    const b = this.ports.get(link.b.portId)!;
    for (const e of [a, b]) {
      if (!e.port.adminUp) return { up: false, reason: `Порт ${e.port.name} на «${e.device.name}» выключен (shutdown)` };
    }
    const c = checkCable(link.cable, a, b);
    return c.ok ? { up: true } : { up: false, reason: c.reason };
  }

  /** Индикатор на конце провода у порта, как в Packet Tracer. */
  portLed(portId: string): Led {
    const link = this.linkOf(portId);
    if (!link) return 'none';
    if (!this.linkStatus(link).up) return 'red';
    const st = this.ports.get(portId)!.port.stpState;
    return st && st !== 'forwarding' && st !== 'disabled' ? 'orange' : 'green';
  }

  // ---------- состояние ----------

  get now() {
    return this.state.time;
  }

  rt(deviceId: string): DeviceRuntime {
    return (this.state.rt[deviceId] ??= emptyRuntime());
  }

  nextId(): number {
    return this.state.nextId++;
  }

  random(): number {
    const [v, s] = mulberry32(this.state.rng);
    this.state.rng = s;
    return v;
  }

  newJob(kind: Job['kind'], deviceId: string, target: string): Job {
    const job: Job = { id: this.nextId(), kind, deviceId, target, lines: [], done: false, phase: 'run' };
    this.state.jobs[job.id] = job;
    return job;
  }

  job(id: number): Job | undefined {
    return this.state.jobs[id];
  }

  schedule(delay: number, ev: NewEvent) {
    const time = this.state.time + delay;
    const q = this.state.queue;
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    q.splice(lo, 0, { ...ev, time, seq: this.state.seq++ } as QEvent);
  }

  addLog(e: Omit<LogEntry, 'id' | 'time'>): LogEntry {
    const entry = { id: this.log.length + 1, time: this.state.time, ...e } as LogEntry;
    if (entry.packet) entry.protocol = protocolOf(entry.packet);
    this.log.push(entry);
    return entry;
  }

  drop(deviceId: string, packet: Packet | undefined, reason: string) {
    this.addLog({ kind: 'drop', deviceId, packet, action: 'drop', reason });
  }

  /**
   * Отправить кадр в порт. silent=true — для flooding: в порты без живого линка
   * кадр просто не уходит, без записи в журнал.
   */
  transmit(deviceId: string, portId: string, packet: Packet, silent = false): boolean {
    const { port } = this.ports.get(portId)!;
    const link = this.linkOf(portId);
    let err: string | undefined;
    if (!port.adminUp) err = `Интерфейс ${port.name} выключен (shutdown) — кадр не отправлен`;
    else if (!link) err = `К порту ${port.name} не подключён кабель`;
    else {
      const st = this.linkStatus(link);
      if (!st.up) err = st.reason;
    }
    if (err || !link) {
      if (!silent) this.drop(deviceId, packet, err!);
      return false;
    }
    const peer = link.a.portId === portId ? link.b : link.a;
    this.schedule(LINK_DELAY, {
      kind: 'rx',
      deviceId: peer.deviceId,
      portId: peer.portId,
      linkId: link.id,
      fromDeviceId: deviceId,
      fromPortId: portId,
      sentAt: this.state.time,
      packet: { ...packet, id: this.nextId() },
    });
    return true;
  }

  // ---------- шаги ----------

  get pending(): readonly QEvent[] {
    return this.state.queue;
  }

  /** Обработать одно событие. Возвращает новые записи журнала или null, если очередь пуста. */
  step(): LogEntry[] | null {
    return this.process(true);
  }

  stepBack(): boolean {
    const s = this.snapshots.pop();
    if (!s) return false;
    this.state = s.state;
    this.log.length = s.logLen;
    return true;
  }

  get canStepBack() {
    return this.snapshots.length > 0;
  }

  /** Выполнять события до момента time включительно (без истории — режим реального времени). */
  runUntil(time: number, withHistory = false) {
    while (this.state.queue.length && this.state.queue[0].time <= time) this.process(withHistory);
    if (this.state.time < time) this.state.time = time;
  }

  /** Выполнить всё до опустошения очереди. Защита от бесконечности — maxEvents. */
  runUntilIdle(maxEvents = 200_000, withHistory = false): number {
    let n = 0;
    while (this.state.queue.length && n < maxEvents) {
      this.process(withHistory);
      n++;
    }
    return n;
  }

  private process(withHistory: boolean): LogEntry[] | null {
    const ev = this.state.queue[0];
    if (!ev) return null;
    if (withHistory) {
      this.snapshots.push({ state: structuredClone(this.state), logLen: this.log.length });
      if (this.snapshots.length > this.opts.maxSnapshots) this.snapshots.shift();
    }
    this.state.queue.shift();
    this.state.time = ev.time;
    const before = this.log.length;
    if (ev.kind === 'rx') this.handleRx(ev);
    else apps.handleTimer(this, ev.deviceId, ev.timer, onArpTimeout);
    return this.log.slice(before);
  }

  private handleRx(ev: Extract<QEvent, { kind: 'rx' }>) {
    const d = this.device(ev.deviceId);
    const { port } = this.ports.get(ev.portId)!;
    const entry = this.addLog({
      kind: 'frame',
      deviceId: d.id,
      portId: port.id,
      fromDeviceId: ev.fromDeviceId,
      fromPortId: ev.fromPortId,
      linkId: ev.linkId,
      sentAt: ev.sentAt,
      packet: ev.packet,
      reason: '',
    });
    const tick = Math.floor(ev.time);
    if (this.state.tick.t !== tick) this.state.tick = { t: tick, n: 0 };
    let v: Verdict;
    if (++this.state.tick.n > this.opts.maxEventsPerTick) {
      v = {
        action: 'drop',
        reason: `Петля в сети: за 1 мс по сети прошло больше ${this.opts.maxEventsPerTick} кадров (широковещательный шторм). Кадр отброшен. Уберите лишний кабель между свитчами или включите STP.`,
      };
    } else if (d.kind === 'switch') v = switchRx(this, d, port, ev.packet);
    else if (d.kind === 'hub') v = hubRx(this, d, port, ev.packet);
    else v = l3Rx(this, d, port, ev.packet);
    entry.action = v.action;
    entry.reason = v.reason;
  }

  // ---------- инструменты (вкладка «Инструменты» на ПК) ----------

  ping(deviceId: string, target: string, count = 4): Job {
    return apps.startPing(this, deviceId, target, count);
  }

  traceroute(deviceId: string, target: string): Job {
    return apps.startTraceroute(this, deviceId, target);
  }

  openUrl(deviceId: string, url: string): Job {
    return apps.startHttp(this, deviceId, url);
  }

  nslookup(deviceId: string, name: string): Job {
    return apps.startNslookup(this, deviceId, name);
  }

  renewDhcp(deviceId: string): Job {
    return apps.startDhcp(this, deviceId);
  }
}
