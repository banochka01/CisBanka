// IPv4 (RFC 791): заголовок 20 байт без опций, контрольная сумма заголовка.
import type { IPv4 } from '../model/topology';
import { internetChecksum, ipToBytes, put16, u16, Writer } from './bytes';

export const IP_ICMP = 1;
export const IP_TCP = 6;
export const IP_UDP = 17;
export const PROTO_NUM = { ICMP: IP_ICMP, TCP: IP_TCP, UDP: IP_UDP } as const;

export interface Ipv4Params {
  src: IPv4;
  dst: IPv4;
  ttl: number;
  proto: number;
  id: number;
  dontFragment?: boolean;
  payload: Uint8Array;
}

export interface Ipv4Header {
  version: number;
  ihl: number;
  /** Длина заголовка в байтах. */
  headerLen: number;
  dscp: number;
  ecn: number;
  totalLength: number;
  id: number;
  flags: number;
  fragOffset: number;
  ttl: number;
  proto: number;
  checksum: number;
  checksumOk: boolean;
  src: Uint8Array;
  dst: Uint8Array;
}

export function encodeIpv4(p: Ipv4Params): Uint8Array {
  const out = new Writer()
    .u8(0x45)
    .u8(0)
    .u16(20 + p.payload.length)
    .u16(p.id & 0xffff)
    .u16(p.dontFragment ? 0x4000 : 0)
    .u8(p.ttl & 0xff)
    .u8(p.proto)
    .u16(0)
    .bytes(ipToBytes(p.src))
    .bytes(ipToBytes(p.dst))
    .bytes(p.payload)
    .finish();
  put16(out, 10, internetChecksum(out, 0, 20));
  return out;
}

export function decodeIpv4(b: Uint8Array, o: number): Ipv4Header | null {
  if (b.length < o + 20) return null;
  const ihl = b[o] & 0x0f;
  const headerLen = ihl * 4;
  if (headerLen < 20 || b.length < o + headerLen) return null;
  const ff = u16(b, o + 6);
  return {
    version: b[o] >> 4,
    ihl,
    headerLen,
    dscp: b[o + 1] >> 2,
    ecn: b[o + 1] & 3,
    totalLength: u16(b, o + 2),
    id: u16(b, o + 4),
    flags: ff >> 13,
    fragOffset: ff & 0x1fff,
    ttl: b[o + 8],
    proto: b[o + 9],
    checksum: u16(b, o + 10),
    checksumOk: internetChecksum(b, o, o + headerLen) === 0,
    src: b.slice(o + 12, o + 16),
    dst: b.slice(o + 16, o + 20),
  };
}
