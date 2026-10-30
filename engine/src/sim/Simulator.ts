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
import { describePacket } from './describe';

/** Задержка передачи по проводу, мс модельного времени. */
export const LINK_DELAY = 1;

export interface SimOptions {
  /** Сколько кадров может обработать сеть за один такт (1 мс). Больше — считаем broadcast storm. */
  maxEventsPerTick?: number;
  /** Сколько свитчей может пройти один кадр. Больше — петля. */
  maxL2Hops?: number;
  /** Чекпоинт состояния делается раз в N шагов; шаг назад = восстановить чекпоинт + реплей. */
  checkpointEvery?: number;
  /** Сколько чекпоинтов хранить (глубина истории ≈ checkpointEvery × maxCheckpoints шагов). */
  maxCheckpoints?: number;
  arpTtl?: number;
  arpTimeout?: number;
  macAging?: number;
}

const DEFAULTS: Required<SimOptions> = {
  maxEventsPerTick: 500,
  maxL2Hops: 32,
  checkpointEvery: 50,
  maxCheckpoints: 400,
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
  /**
   * История для шага назад. Полный снапшот на каждом шаге дорог (~1,5 мс и ~40 КБ
   * на 30 устройствах), поэтому храним чекпоинты раз в N шагов, а шаг назад —
   * это восстановление ближайшего чекпоинта и детерминированный реплей событий
   * (PRNG живёт в состоянии). Внешние команды (ping, renewDhcp…) не являются
   * событиями очереди, поэтому сразу после них делается внеочередной чекпоинт:
   * реплей никогда не перешагивает через команду.
   */
  private checkpoints: { step: number; state: SimState; logLen: number }[] = [];
  /**
   * Границы «хопов» режима симуляции: hopMarks[k] — номер шага, которым закончился хоп k.
   * hopMarks[0] — точка, с которой начали шагать (дальше назад шагать нельзя).
   */
  private hopMarks: number[] = [0];
  /** Запись журнала, внутри обработки которой мы сейчас: исходящие кадры приписываются к ней. */
  private current: LogEntry | null = null;
  private inCommand = false;

  constructor(project: Project, opts: SimOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.load(project);
    this.state = this.freshState(0);
    this.boot();
    this.checkpoint();
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
    this.checkpoints = [];
    this.hopMarks = [0];
    this.addLog({
      kind: 'reset',
      reason: `${reason}: состояние симуляции сброшено — MAC- и ARP-таблицы очищены, пакеты в пути удалены, задачи остановлены`,
    });
    this.boot();
    this.checkpoint();
  }

  private freshState(time: number, nextId = 1): SimState {
    return { time, step: 0, seq: 0, nextId, rng: this.project.seed >>> 0, queue: [], rt: {}, jobs: {}, tick: { t: -1, n: 0 } };
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

  addLog(e: Omit<LogEntry, 'id' | 'time' | 'step'>): LogEntry {
    const step = this.inCommand ? this.state.step + 1 : this.state.step;
    const entry = { id: this.log.length + 1, time: this.state.time, step, ...e } as LogEntry;
    if (entry.packet) entry.protocol = protocolOf(entry.packet);
    this.log.push(entry);
    return entry;
  }

  drop(deviceId: string, packet: Packet | undefined, reason: string, portId?: string) {
    this.addLog({ kind: 'drop', deviceId, portId, packet, action: 'drop', reason });
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
      if (!silent) this.drop(deviceId, packet, err!, portId);
      return false;
    }
    const peer = link.a.portId === portId ? link.b : link.a;
    const sent = { ...packet, id: this.nextId() };
    if (this.current?.deviceId === deviceId) (this.current.out ??= []).push({ portId, packet: sent });
    else {
      const d = this.device(deviceId);
      this.current = this.addLog({
        kind: 'send',
        deviceId,
        portId,
        packet: sent,
        action: 'forward',
        reason: `${d.name} создаёт пакет и отправляет его в ${port.name}. ${describePacket(sent)}`,
        out: [{ portId, packet: sent }],
      });
    }
    this.schedule(LINK_DELAY, {
      kind: 'rx',
      deviceId: peer.deviceId,
      portId: peer.portId,
      linkId: link.id,
      fromDeviceId: deviceId,
      fromPortId: portId,
      sentAt: this.state.time,
      packet: sent,
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
    if (this.state.step === 0) return false;
    return this.seek(this.state.step - 1);
  }

  /** Восстановить состояние на шаге target: ближайший чекпоинт + детерминированный реплей. */
  private seek(target: number): boolean {
    let i = this.checkpoints.length - 1;
    while (i >= 0 && this.checkpoints[i].step > target) i--;
    if (i < 0) return false;
    this.checkpoints.length = i + 1;
    const cp = this.checkpoints[i];
    this.state = structuredClone(cp.state);
    this.log.length = cp.logLen;
    while (this.state.step < target) this.process(false);
    return true;
  }

  get canStepBack() {
    return this.state.step > 0 && this.checkpoints.length > 0 && this.checkpoints[0].step < this.state.step;
  }

  private checkpoint() {
    this.checkpoints.push({ step: this.state.step, state: structuredClone(this.state), logLen: this.log.length });
    if (this.checkpoints.length > this.opts.maxCheckpoints) this.checkpoints.shift();
  }

  /** Внешняя команда: выполнить и сразу зафиксировать чекпоинт. */
  private command<T>(fn: () => T): T {
    this.inCommand = true;
    this.current = null;
    try {
      return fn();
    } finally {
      this.inCommand = false;
      this.current = null;
      this.checkpoint();
    }
  }

  // ---------- режим симуляции: шаг = хоп ----------

  /** Начать пошаговый режим с текущего состояния: назад дальше этой точки не шагаем. */
  beginHops() {
    this.hopMarks = [this.state.step];
    if (this.checkpoints.at(-1)?.step !== this.state.step) this.checkpoint();
  }

  /**
   * Выполнить служебные события, назначенные на «прямо сейчас» (таймер старта ping/DHCP
   * сразу после команды), — чтобы созданный пакет стал виден у отправителя ещё до шага.
   * Эти события входят в следующий хоп.
   */
  primeHop() {
    const q = this.state.queue;
    while (q.length && q[0].kind === 'timer' && q[0].time <= this.state.time) this.process(true);
  }

  /** Номер текущего хопа (0 — ещё не шагали). */
  get hop() {
    return this.hopMarks.length - 1;
  }

  /**
   * Один шаг режима симуляции — одно перемещение пакетов между устройствами.
   * Обрабатываются служебные события (таймеры) до первого прихода кадра, затем —
   * все кадры, пришедшие в тот же момент: при флуде копии двигаются одновременно.
   * Возвращает новые записи журнала или null, если в сети ничего не происходит.
   */
  stepHop(): LogEntry[] | null {
    if (!this.state.queue.length) return null;
    const before = this.log.length;
    let t: number | null = null;
    while (this.state.queue.length) {
      const ev = this.state.queue[0];
      if (t !== null && !(ev.kind === 'rx' && ev.time === t)) break;
      this.process(true);
      if (ev.kind === 'rx') t = ev.time;
    }
    this.hopMarks.push(this.state.step);
    return this.log.slice(before);
  }

  stepBackHop(): boolean {
    return this.hop > 0 && this.seekHop(this.hop - 1);
  }

  /** Перемотать к концу хопа k (k ≤ текущего). */
  seekHop(k: number): boolean {
    if (k < 0 || k > this.hop) return false;
    if (!this.seek(this.hopMarks[k])) return false;
    this.hopMarks.length = k + 1;
    return true;
  }

  /** Хоп, к которому относится запись журнала (−1 — до начала пошагового режима). */
  hopOf(entry: LogEntry): number {
    const m = this.hopMarks;
    if (entry.step <= m[0]) return -1;
    let lo = 1;
    let hi = m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid] >= entry.step) hi = mid;
      else lo = mid + 1;
    }
    return lo < m.length && m[lo] >= entry.step ? lo : -1;
  }

  /** Записи журнала хопа k (по умолчанию текущего) — то, что показывается на холсте. */
  hopEntries(k = this.hop): LogEntry[] {
    if (k <= 0) return [];
    const from = this.hopMarks[k - 1];
    const to = this.hopMarks[k];
    return this.log.filter((e) => e.step > from && e.step <= to);
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
    if (withHistory && this.state.step % this.opts.checkpointEvery === 0 && this.checkpoints.at(-1)?.step !== this.state.step) {
      this.checkpoint();
    }
    this.state.queue.shift();
    this.state.step++;
    this.state.time = ev.time;
    const before = this.log.length;
    this.current = null;
    if (ev.kind === 'rx') this.handleRx(ev);
    else apps.handleTimer(this, ev.deviceId, ev.timer, onArpTimeout);
    this.current = null;
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
    this.current = entry;
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
    return this.command(() => apps.startPing(this, deviceId, target, count));
  }

  traceroute(deviceId: string, target: string): Job {
    return this.command(() => apps.startTraceroute(this, deviceId, target));
  }

  openUrl(deviceId: string, url: string): Job {
    return this.command(() => apps.startHttp(this, deviceId, url));
  }

  nslookup(deviceId: string, name: string): Job {
    return this.command(() => apps.startNslookup(this, deviceId, name));
  }

  renewDhcp(deviceId: string): Job {
    return this.command(() => apps.startDhcp(this, deviceId));
  }
}
