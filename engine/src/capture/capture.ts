// Захват трафика («сниффер») на линке или интерфейсе.
//
// Захват не вмешивается в симуляцию: он читает журнал. Каждая запись kind='frame' —
// это кадр, который реально прошёл по проводу linkId от fromPortId к portId. Поэтому
// поведение среды учитывается само: за свитчем видно только то, что свитч отправил в этот
// порт (flood до изучения MAC, потом unicast), за хабом — всё.
// Перемотка назад отбрасывает кадры «будущего»; шаг вперёд добавляет их снова.
import type { LogEntry } from '../model/events';
import type { Packet } from '../model/packet';
import type { Simulator } from '../sim/Simulator';
import { encodeFrame } from '../wire/encode';

export type CapturePoint = { kind: 'link'; linkId: string } | { kind: 'port'; portId: string };

/**
 * Направление кадра:
 * - для линка: 'ab' — от конца a к b, 'ba' — обратно;
 * - для интерфейса: 'out' — устройство отправило, 'in' — получило.
 */
export type Direction = 'ab' | 'ba' | 'in' | 'out';

export interface CapturedFrame {
  /** Номер в захвате, с 1. */
  no: number;
  /** Модельное время, мс: когда кадр ушёл в провод (для входящих на интерфейс — когда пришёл). */
  time: number;
  direction: Direction;
  linkId: string;
  srcDeviceId: string;
  srcPortId: string;
  dstDeviceId: string;
  dstPortId: string;
  /** Запись журнала — для связи с анимацией и разбором. */
  logIndex: number;
  entry: LogEntry;
  packet: Packet;
}

/** Где захват видит кадр и в каком направлении; null — не видит. */
export function matchPoint(sim: Simulator, point: CapturePoint, e: LogEntry): Direction | null {
  if (e.kind !== 'frame' || !e.packet || !e.linkId || !e.fromPortId || !e.portId) return null;
  if (point.kind === 'port') {
    if (e.fromPortId === point.portId) return 'out';
    if (e.portId === point.portId) return 'in';
    return null;
  }
  if (e.linkId !== point.linkId) return null;
  const link = sim.project.links.find((l) => l.id === point.linkId);
  return link && link.a.portId === e.fromPortId ? 'ab' : 'ba';
}

export class Capture {
  frames: CapturedFrame[] = [];
  running = true;
  /** До какой записи журнала уже просмотрено. */
  private scanned: number;

  constructor(
    readonly point: CapturePoint,
    sim: Simulator,
  ) {
    this.scanned = sim.logCursor;
  }

  /** Подтянуть новые кадры из журнала. Возвращает true, если список изменился. */
  sync(sim: Simulator): boolean {
    if (!this.running) return false;
    const before = this.frames.length;
    let changed = false;
    const cursor = sim.logCursor;
    // Перемотка назад или сброс топологии: кадры «будущего» больше не в настоящем.
    if (cursor < this.scanned) this.scanned = cursor;
    while (this.frames.length) {
      const f = this.frames[this.frames.length - 1];
      if (f.logIndex < this.scanned && sim.log[f.logIndex] === f.entry) break;
      this.frames.pop();
      this.scanned = Math.min(this.scanned, f.logIndex);
      changed = true;
    }
    for (let i = this.scanned; i < cursor; i++) {
      const e = sim.log[i];
      const dir = matchPoint(sim, this.point, e);
      if (!dir) continue;
      this.frames.push({
        no: this.frames.length + 1,
        time: dir === 'in' ? e.time : e.sentAt ?? e.time,
        direction: dir,
        linkId: e.linkId!,
        srcDeviceId: e.fromDeviceId!,
        srcPortId: e.fromPortId!,
        dstDeviceId: e.deviceId!,
        dstPortId: e.portId!,
        logIndex: i,
        entry: e,
        packet: e.packet!,
      });
    }
    this.scanned = cursor;
    return changed || this.frames.length !== before;
  }

  stop(sim: Simulator) {
    this.sync(sim);
    this.running = false;
  }

  /** Продолжить с текущего момента (пропущенное, пока захват стоял, не попадёт). */
  resume(sim: Simulator) {
    this.running = true;
    this.scanned = sim.logCursor;
  }

  clear(sim: Simulator) {
    this.frames = [];
    this.scanned = sim.logCursor;
  }
}

// Пакеты модели не мутируются, поэтому байты можно кэшировать по объекту.
const bytesCache = new WeakMap<Packet, Uint8Array>();

/** Байты кадра (кодируются лениво, один раз). */
export function packetBytes(p: Packet): Uint8Array {
  let b = bytesCache.get(p);
  if (!b) {
    b = encodeFrame(p);
    bytesCache.set(p, b);
  }
  return b;
}
