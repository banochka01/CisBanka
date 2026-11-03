// UDP (RFC 768) с контрольной суммой по псевдозаголовку IPv4.
import type { IPv4 } from '../model/topology';
import { internetChecksum, ipToBytes, pseudoHeaderSum, put16, u16, Writer } from './bytes';
import { IP_UDP } from './ipv4';

export interface UdpHeader {
  srcPort: number;
  dstPort: number;
  length: number;
  checksum: number;
  checksumOk: boolean;
}

export function encodeUdp(src: IPv4, dst: IPv4, srcPort: number, dstPort: number, payload: Uint8Array): Uint8Array {
  const len = 8 + payload.length;
  const out = new Writer().u16(srcPort).u16(dstPort).u16(len).u16(0).bytes(payload).finish();
  const c = internetChecksum(out, 0, len, pseudoHeaderSum(ipToBytes(src), ipToBytes(dst), IP_UDP, len));
  put16(out, 6, c === 0 ? 0xffff : c);
  return out;
}

export function decodeUdp(b: Uint8Array, o: number, end: number, src: Uint8Array, dst: Uint8Array): UdpHeader | null {
  if (end - o < 8) return null;
  const length = u16(b, o + 4);
  const checksum = u16(b, o + 6);
  const e = Math.min(end, o + length);
  return {
    srcPort: u16(b, o),
    dstPort: u16(b, o + 2),
    length,
    checksum,
    checksumOk: checksum === 0 || internetChecksum(b, o, e, pseudoHeaderSum(src, dst, IP_UDP, length)) === 0,
  };
}
