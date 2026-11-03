// Низкоуровневые помощники для сетевых байтов: big-endian запись/чтение,
// интернет-контрольная сумма (RFC 1071), преобразование MAC/IPv4.
import type { IPv4, MAC } from '../model/topology';

/** Растущий буфер с записью в сетевом порядке байтов. */
export class Writer {
  private buf = new Uint8Array(256);
  len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number) {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u32(v: number) {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number) {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export const u16 = (b: Uint8Array, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
export const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function put16(b: Uint8Array, o: number, v: number) {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}

/** Сумма 16-битных слов без свёртки (для псевдозаголовков). */
function sum16(b: Uint8Array, start: number, end: number, acc = 0): number {
  let s = acc;
  let i = start;
  for (; i + 1 < end; i += 2) s += (b[i] << 8) | b[i + 1];
  if (i < end) s += b[i] << 8;
  return s;
}

function fold(s: number): number {
  while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
  return s;
}

/** Интернет-контрольная сумма RFC 1071 по диапазону [start, end). */
export function internetChecksum(b: Uint8Array, start = 0, end = b.length, initial = 0): number {
  return ~fold(sum16(b, start, end, initial)) & 0xffff;
}

/** Частичная сумма псевдозаголовка IPv4 для TCP/UDP. */
export function pseudoHeaderSum(src: Uint8Array, dst: Uint8Array, proto: number, length: number): number {
  return ((src[0] << 8) | src[1]) + ((src[2] << 8) | src[3]) + ((dst[0] << 8) | dst[1]) + ((dst[2] << 8) | dst[3]) + proto + length;
}

export function macToBytes(mac: MAC): Uint8Array {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(6);
  if (hex.length !== 12) return out;
  for (let i = 0; i < 6; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** MAC в привычном для Wireshark виде: 00:60:5c:3a:1b:01. */
export function macToString(b: Uint8Array, o = 0): string {
  return Array.from(b.subarray(o, o + 6), (x) => x.toString(16).padStart(2, '0')).join(':');
}

/** MAC в формате Cisco, как в модели: 0060.5C3A.1B01. */
export function macToCisco(b: Uint8Array, o = 0): MAC {
  const h = Array.from(b.subarray(o, o + 6), (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}

export function ipToBytes(ip: IPv4 | undefined): Uint8Array {
  const out = new Uint8Array(4);
  if (!ip) return out;
  const parts = ip.split('.');
  if (parts.length !== 4) return out;
  for (let i = 0; i < 4; i++) out[i] = Number(parts[i]) & 0xff;
  return out;
}

export const ipToString = (b: Uint8Array, o = 0): IPv4 => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);

export const hex = (v: number, width: number) => `0x${v.toString(16).padStart(width, '0')}`;

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(s: string): Uint8Array {
  const h = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
