// Колонки списка, номера TCP-потоков, разбор и фильтрация — лениво и с кэшем на захват.
// Относительные номера TCP и tcp.stream зависят от предыдущих кадров, поэтому строки считаются по порядку.
import {
  compileFilter,
  decodeFrame,
  dissect,
  fieldValues,
  frameBytes,
  isImported,
  summarize,
  TcpSeqContext,
  TcpStreamIndex,
  type AnyFrame,
  type Decoded,
  type Dissection,
  type FilterFn,
  type Summary,
} from '@ciscobanka/engine';

export interface Row extends Summary {
  no: number;
  /** Секунды от первого кадра захвата. */
  time: number;
  length: number;
  /** Номер TCP-потока, -1 — не TCP. */
  stream: number;
  frame: AnyFrame;
  decoded: Decoded;
}

interface Cache {
  rows: Row[];
  ctx: TcpSeqContext;
  streams: TcpStreamIndex;
  filter?: { text: string; fn: FilterFn; matched: number[]; scanned: number };
}

/** Живой захват или открытый файл — для списка важны только кадры. */
type Source = { frames: readonly AnyFrame[] };

const caches = new WeakMap<Source, Cache>();
const dissections = new WeakMap<Row, Dissection>();
const fieldCache = new WeakMap<Row, ReturnType<typeof fieldValues>>();

function cacheOf(cap: Source): Cache {
  let c = caches.get(cap);
  const frames = cap.frames;
  // Кадры «будущего» убрали (шаг назад, очистка) — пересчитываем с нуля.
  if (c && (c.rows.length > frames.length || (c.rows.length && c.rows[c.rows.length - 1].frame !== frames[c.rows.length - 1]))) c = undefined;
  if (!c) {
    c = { rows: [], ctx: new TcpSeqContext(), streams: new TcpStreamIndex() };
    caches.set(cap, c);
  }
  return c;
}

/** Строки 0..upTo-1 (досчитывает недостающие). */
export function rowsOf(cap: Source, upTo = cap.frames.length): Row[] {
  const c = cacheOf(cap);
  const frames = cap.frames;
  const t0 = frames[0]?.time ?? 0;
  for (let i = c.rows.length; i < Math.min(upTo, frames.length); i++) {
    const f = frames[i];
    const bytes = frameBytes(f);
    const decoded = decodeFrame(bytes);
    // Length — длина в проводе (у кадров из файла может быть больше сохранённой).
    const length = isImported(f) ? f.origLen : bytes.length;
    c.rows.push({ ...summarize(decoded, c.ctx), no: f.no, time: (f.time - t0) / 1000, length, stream: c.streams.add(decoded), frame: f, decoded });
  }
  return c.rows;
}

export function rowDissection(r: Row): Dissection {
  let d = dissections.get(r);
  if (!d) {
    d = dissect(r.decoded.bytes, { number: r.no, relTime: r.time, tcpStream: r.stream >= 0 ? r.stream : undefined });
    dissections.set(r, d);
  }
  return d;
}

/**
 * Индексы строк, прошедших фильтр (null — фильтр пуст, видно всё).
 * Новые кадры досматриваются инкрементально.
 */
export function filteredOf(cap: Source, text: string): number[] | null {
  const c = cacheOf(cap);
  const rows = rowsOf(cap);
  if (!text.trim()) {
    c.filter = undefined;
    return null;
  }
  if (!c.filter || c.filter.text !== text || c.filter.scanned > rows.length) {
    const r = compileFilter(text);
    if (!r.ok) return null;
    c.filter = { text, fn: r.fn, matched: [], scanned: 0 };
  }
  const f = c.filter;
  for (let i = f.scanned; i < rows.length; i++) {
    const r = rows[i];
    // Для фильтра дерево подписей не нужно — только значения полей; они кэшируются, и смена фильтра дешёвая.
    let v = fieldCache.get(r);
    if (!v) {
      v = fieldValues(r.decoded, { number: r.no, relTime: r.time, tcpStream: r.stream >= 0 ? r.stream : undefined });
      fieldCache.set(r, v);
    }
    if (f.fn(v)) f.matched.push(i);
  }
  f.scanned = rows.length;
  return f.matched;
}

/** CSS-класс цвета строки, как раскраска по умолчанию в Wireshark. */
export function rowClass(r: Row): string {
  const tcp = r.decoded.tcp?.h;
  if (tcp && tcp.flags & 0x04) return 'pk-rst';
  if (tcp && tcp.flags & 0x03 && r.protocol === 'TCP') return 'pk-tcp-ctl';
  if (r.protocol === 'ICMP' && r.decoded.icmp && r.decoded.icmp.h.type !== 0 && r.decoded.icmp.h.type !== 8) return 'pk-icmp-err';
  return `pk-${r.protocol.toLowerCase()}`;
}
