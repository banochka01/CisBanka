import type { Device, Link, Port, Project } from '../model/topology';
import type { Packet } from '../model/packet';
import { protocolOf } from '../model/packet';
import type { LogEntry, Verdict } from '../model/events';
import { checkCable } from '../l1/cabling';
import { mulberry32 } from '../util/prng';
import { emptyRuntime, type CommandKind, type CommandRec, type DeviceRuntime, type Job, type QEvent, type SimState } from './state';
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
   * (PRNG живёт в состоянии). Внешние команды (ping, renewDhcp…) пишутся в историю
   * (cmds) с номером шага и переигрываются при реплее; после команды — внеочередной чекпоинт.
   * При перемотке назад журнал, чекпоинты и границы хопов «будущего» не удаляются.
   */
  private checkpoints: { step: number; state: SimState; logLen: number }[] = [];
  /**
   * Границы «хопов» режима симуляции: hopMarks[k] — номер шага, которым закончился хоп k.
   * hopMarks[0] — точка, с которой начали шагать (дальше назад шагать нельзя).
   */
  private hopMarks: number[] = [0];
  /** Текущий хоп; хопы дальше него — просчитанное будущее. */
  private hopIdx = 0;
  /** Длина журнала «в настоящем» (см. logCursor). */
  private cursor = 0;
  private cmds: CommandRec[] = [];
  private cmdSeq = 0;
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
    this.log.length = this.cursor;
    this.state = this.freshState(this.state.time, this.state.nextId);
    this.checkpoints = [];
    this.hopMarks = [0];
    this.hopIdx = 0;
    this.cmds = [];
    this.addLog({
      kind: 'reset',
      reason: `${reason}: состояние симуляции сброшено — MAC- и ARP-таблицы очищены, пакеты в пути удалены, задачи остановлены`,
    });
    this.boot();
    this.checkpoint();
  }

  private freshState(time: number, nextId = 1): SimState {
    return { time, step: 0, seq: 0, nextId, rng: this.project.seed >>> 0, queue: [], rt: {}, jobs: {}, tick: { t: -1, n: 0 }, cmdApplied: 0, cmdJobs: {} };
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
    const entry = { id: this.cursor + 1, time: this.state.time, step, ...e } as LogEntry;
    if (entry.packet) entry.protocol = protocolOf(entry.packet);
    // в «прошлом» реплей детерминирован — перезаписываем ту же запись будущего
    this.log[this.cursor++] = entry;
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

  /**
   * Сколько записей журнала относится к настоящему моменту. Записи дальше — «будущее»,
   * которое уже было просчитано: после перемотки назад оно не теряется, а шаг вперёд
   * детерминированно воспроизводит его заново (записи перезаписываются теми же).
   */
  get logCursor() {
    return this.cursor;
  }

  /** История внешних команд (для отображения и сценариев). */
  get commands(): readonly CommandRec[] {
    return this.cmds;
  }

  /** Задача, запущенная командой cmdId в текущем состоянии (нет — команда ещё не выполнена). */
  commandJob(cmdId: number): Job | undefined {
    const id = this.state.cmdJobs[cmdId];
    return id === undefined ? undefined : this.state.jobs[id];
  }

  /** Обработать одно событие. Возвращает новые записи журнала или null, если очередь пуста. */
  step(): LogEntry[] | null {
    return this.process(true);
  }

  stepBack(): boolean {
    if (this.state.step === 0) return false;
    return this.seek(this.state.step - 1);
  }

  /**
   * Восстановить состояние на шаге target: ближайший чекпоинт + детерминированный реплей
   * событий и внешних команд. Команды, выданные ровно в момент target, тоже выполняются —
   * перемотка «до отправки» показывает пакет у отправителя, а не удаляет его.
   */
  private seek(target: number): boolean {
    let i = this.checkpoints.length - 1;
    while (i >= 0 && this.checkpoints[i].step > target) i--;
    if (i < 0) return false;
    const cp = this.checkpoints[i];
    this.state = structuredClone(cp.state);
    this.cursor = cp.logLen;
    while (this.state.step < target && this.process(false));
    this.applyCommands();
    return true;
  }

  get canStepBack() {
    return this.state.step > 0 && this.checkpoints.length > 0 && this.checkpoints[0].step < this.state.step;
  }

  /**
   * Чекпоинт только на «переднем крае»: если впереди уже есть чекпоинты (идём по
   * просчитанному будущему), новые не нужны — старые остаются верными.
   */
  private checkpoint() {
    const last = this.checkpoints.at(-1);
    if (last && (last.step > this.state.step || (last.step === this.state.step && last.state.cmdApplied >= this.state.cmdApplied))) return;
    this.checkpoints.push({ step: this.state.step, state: structuredClone(this.state), logLen: this.cursor });
    if (this.checkpoints.length > this.opts.maxCheckpoints) this.checkpoints.shift();
  }

  /** Забыть просчитанное будущее (новая команда в прошлом меняет дальнейшие события). */
  dropFuture() {
    this.log.length = this.cursor;
    this.hopMarks.length = this.hopIdx + 1;
    this.cmds.length = this.state.cmdApplied;
    const s = this.state;
    this.checkpoints = this.checkpoints.filter((c) => c.step < s.step || (c.step === s.step && c.state.cmdApplied <= s.cmdApplied));
  }

  private runCommand(c: CommandRec): Job {
    this.inCommand = true;
    this.current = null;
    try {
      let job: Job;
      if (c.kind === 'ping') job = apps.startPing(this, c.deviceId, c.target, c.count ?? 4);
      else if (c.kind === 'traceroute') job = apps.startTraceroute(this, c.deviceId, c.target);
      else if (c.kind === 'http') job = apps.startHttp(this, c.deviceId, c.target);
      else if (c.kind === 'nslookup') job = apps.startNslookup(this, c.deviceId, c.target);
      else job = apps.startDhcp(this, c.deviceId);
      job.cmdId = c.id;
      this.state.cmdJobs[c.id] = job.id;
      this.state.cmdApplied++;
      return job;
    } finally {
      this.inCommand = false;
      this.current = null;
    }
  }

  /** Выполнить команды из истории, чей момент настал. Возвращает true, если что-то выполнено. */
  private applyCommands(): boolean {
    let any = false;
    while (this.state.cmdApplied < this.cmds.length && this.cmds[this.state.cmdApplied].step <= this.state.step) {
      this.runCommand(this.cmds[this.state.cmdApplied]);
      any = true;
    }
    return any;
  }

  /** Внешняя команда: записать в историю с текущим моментом, выполнить и зафиксировать чекпоинт. */
  private command(kind: CommandKind, deviceId: string, target: string, count?: number): Job {
    this.applyCommands();
    this.dropFuture();
    const c: CommandRec = { id: ++this.cmdSeq, step: this.state.step, time: this.state.time, kind, deviceId, target, count };
    this.cmds.push(c);
    const job = this.runCommand(c);
    this.checkpoint();
    return job;
  }

  // ---------- режим симуляции: шаг = хоп ----------

  /** Начать пошаговый режим с текущего состояния: назад дальше этой точки не шагаем. */
  beginHops() {
    this.dropFuture();
    this.hopMarks = [this.state.step];
    this.hopIdx = 0;
    this.checkpoint();
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
    return this.hopIdx;
  }

  /** Сколько хопов уже просчитано (включая «будущее» после перемотки назад). */
  get hopCount() {
    return this.hopMarks.length - 1;
  }

  get canStepForward() {
    return this.hopIdx < this.hopCount || this.state.queue.length > 0;
  }

  /**
   * Один шаг режима симуляции — одно перемещение пакетов между устройствами.
   * Обрабатываются служебные события (таймеры) до первого прихода кадра, затем —
   * все кадры, пришедшие в тот же момент: при флуде копии двигаются одновременно.
   * Если этот хоп уже был просчитан (после перемотки), идём ровно до его границы.
   * Возвращает новые записи журнала или null, если в сети ничего не происходит.
   */
  stepHop(): LogEntry[] | null {
    const before = this.cursor;
    if (this.hopIdx < this.hopCount) {
      const target = this.hopMarks[this.hopIdx + 1];
      while (this.state.step < target && this.process(true));
    } else {
      if (!this.state.queue.length) return null;
      let t: number | null = null;
      while (this.state.queue.length) {
        const ev = this.state.queue[0];
        if (t !== null && !(ev.kind === 'rx' && ev.time === t)) break;
        this.process(true);
        if (ev.kind === 'rx') t = ev.time;
      }
      this.hopMarks.push(this.state.step);
    }
    this.hopIdx++;
    // команда, выданная после этого хопа, — сразу показать её пакет у отправителя
    if (this.applyCommands()) {
      this.checkpoint();
      this.primeHop();
    }
    return this.log.slice(before, this.cursor);
  }

  stepBackHop(): boolean {
    return this.hopIdx > 0 && this.seekHop(this.hopIdx - 1);
  }

  /** Перемотать к концу хопа k — назад или вперёд по уже просчитанному будущему. */
  seekHop(k: number): boolean {
    if (k < 0 || k > this.hopCount) return false;
    if (k > this.hopIdx) {
      while (this.hopIdx < k) this.stepHop();
      return true;
    }
    if (!this.seek(this.hopMarks[k])) return false;
    this.hopIdx = k;
    this.primeHop();
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
  hopEntries(k = this.hopIdx): LogEntry[] {
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
    if (this.applyCommands() && withHistory) this.checkpoint();
    const ev = this.state.queue[0];
    if (!ev) return null;
    if (withHistory && this.state.step % this.opts.checkpointEvery === 0) this.checkpoint();
    this.state.queue.shift();
    this.state.step++;
    this.state.time = ev.time;
    const before = this.cursor;
    this.current = null;
    if (ev.kind === 'rx') this.handleRx(ev);
    else apps.handleTimer(this, ev.deviceId, ev.timer, onArpTimeout);
    this.current = null;
    return this.log.slice(before, this.cursor);
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
    return this.command('ping', deviceId, target, count);
  }

  traceroute(deviceId: string, target: string): Job {
    return this.command('traceroute', deviceId, target);
  }

  openUrl(deviceId: string, url: string): Job {
    return this.command('http', deviceId, url);
  }

  nslookup(deviceId: string, name: string): Job {
    return this.command('nslookup', deviceId, name);
  }

  renewDhcp(deviceId: string): Job {
    return this.command('dhcp', deviceId, 'DHCP');
  }
}
