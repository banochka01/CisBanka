// TCP-потоки: нумерация соединений (tcp.stream) и «Follow TCP stream» — диалог одного соединения.
import { ipToString } from '../wire/bytes';
import type { Decoded } from '../wire/decode';

export interface Endpoint {
  ip: string;
  port: number;
}

const epKey = (e: Endpoint) => `${e.ip}:${e.port}`;

function endpoints(d: Decoded): [Endpoint, Endpoint] | null {
  if (!d.ip || !d.tcp) return null;
  return [
    { ip: ipToString(d.ip.h.src), port: d.tcp.h.srcPort },
    { ip: ipToString(d.ip.h.dst), port: d.tcp.h.dstPort },
  ];
}

/**
 * Номер TCP-потока для каждого кадра (-1 — не TCP). Поток — пара концов; новый SYN
 * после уже начатого соединения с теми же концами открывает новый поток, как в Wireshark.
 */
export class TcpStreamIndex {
  private byKey = new Map<string, { index: number; synSeen: boolean }>();
  private next = 0;

  /** Кадры нужно подавать по порядку. */
  add(d: Decoded): number {
    const ep = endpoints(d);
    if (!ep) return -1;
    const [a, b] = ep;
    const key = [epKey(a), epKey(b)].sort().join('|');
    const flags = d.tcp!.h.flags;
    const synOnly = (flags & 0x02) !== 0 && (flags & 0x10) === 0;
    let s = this.byKey.get(key);
    if (!s || (synOnly && s.synSeen)) {
      s = { index: this.next++, synSeen: false };
      this.byKey.set(key, s);
    }
    if (synOnly) s.synSeen = true;
    return s.index;
  }
}

export interface StreamChunk {
  /** От клиента (тот, кто начал соединение) или от сервера. */
  from: 'client' | 'server';
  /** Номер кадра в захвате. */
  no: number;
  data: Uint8Array;
}

export interface FollowedStream {
  client: Endpoint;
  server: Endpoint;
  chunks: StreamChunk[];
  /** Сколько байт передал каждый. */
  clientBytes: number;
  serverBytes: number;
  /** Номера кадров, относящихся к потоку. */
  frames: number[];
}

/**
 * Собрать данные одного TCP-потока по порядку номеров последовательности.
 * Повторы и перекрытия (ретрансляции в импортированном .pcap) обрезаются.
 */
export function followTcp(frames: { no: number; decoded: Decoded; stream: number }[], stream: number): FollowedStream | null {
  let client: Endpoint | null = null;
  let server: Endpoint | null = null;
  const next = new Map<string, number>();
  const chunks: StreamChunk[] = [];
  const nums: number[] = [];
  let clientBytes = 0;
  let serverBytes = 0;
  for (const f of frames) {
    if (f.stream !== stream) continue;
    const ep = endpoints(f.decoded)!;
    const tcp = f.decoded.tcp!.h;
    if (!client) {
      // Клиент — кто прислал SYN; если начало соединения не попало в захват — отправитель первого кадра.
      const synAck = (tcp.flags & 0x12) === 0x12;
      [client, server] = synAck ? [ep[1], ep[0]] : ep;
    }
    nums.push(f.no);
    const from = epKey(ep[0]) === epKey(client) ? 'client' : 'server';
    const dirKey = from;
    let seq = tcp.seq;
    if (tcp.flags & 0x02) seq = (seq + 1) >>> 0;
    if (tcp.payloadLen === 0) {
      if (!next.has(dirKey)) next.set(dirKey, seq);
      continue;
    }
    let data = f.decoded.bytes.subarray(tcp.payloadStart, tcp.payloadStart + tcp.payloadLen);
    const expect = next.get(dirKey);
    if (expect !== undefined) {
      const skip = (expect - seq) | 0;
      if (skip >= data.length) continue;
      if (skip > 0) data = data.subarray(skip);
    }
    next.set(dirKey, (seq + tcp.payloadLen) >>> 0);
    const last = chunks[chunks.length - 1];
    if (last && last.from === from) {
      const merged = new Uint8Array(last.data.length + data.length);
      merged.set(last.data);
      merged.set(data, last.data.length);
      last.data = merged;
    } else chunks.push({ from, no: f.no, data: data.slice() });
    if (from === 'client') clientBytes += data.length;
    else serverBytes += data.length;
  }
  if (!client || !server) return null;
  return { client, server, chunks, clientBytes, serverBytes, frames: nums };
}
