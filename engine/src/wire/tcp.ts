// TCP-заголовок (RFC 9293): флаги, seq/ack, окно, опция MSS, контрольная сумма по псевдозаголовку.
import type { TcpFlag } from '../model/packet';
import type { IPv4 } from '../model/topology';
import { internetChecksum, ipToBytes, pseudoHeaderSum, put16, u16, u32, Writer } from './bytes';
import { IP_TCP } from './ipv4';

export const TCP_FLAG_BITS: Record<TcpFlag, number> = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10 };
/** Порядок, в котором Wireshark перечисляет флаги в Info. */
export const TCP_FLAG_ORDER: TcpFlag[] = ['FIN', 'SYN', 'RST', 'PSH', 'ACK'];

export interface TcpParams {
  src: IPv4;
  dst: IPv4;
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: readonly TcpFlag[];
  window: number;
  mss?: number;
  payload: Uint8Array;
}

export interface TcpOption {
  kind: number;
  len: number;
  offset: number;
  value?: number;
}

export interface TcpHeader {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  headerLen: number;
  flags: number;
  window: number;
  checksum: number;
  checksumOk: boolean;
  urgent: number;
  options: TcpOption[];
  payloadStart: number;
  payloadLen: number;
}

export const flagsToBits = (f: readonly TcpFlag[]) => f.reduce((a, x) => a | TCP_FLAG_BITS[x], 0);
export const bitsToFlags = (bits: number) => TCP_FLAG_ORDER.filter((f) => bits & TCP_FLAG_BITS[f]);

export function encodeTcp(p: TcpParams): Uint8Array {
  const hlen = 20 + (p.mss ? 4 : 0);
  const w = new Writer()
    .u16(p.srcPort)
    .u16(p.dstPort)
    .u32(p.seq >>> 0)
    .u32(p.ack >>> 0)
    .u8((hlen / 4) << 4)
    .u8(flagsToBits(p.flags))
    .u16(p.window)
    .u16(0)
    .u16(0);
  if (p.mss) w.u8(2).u8(4).u16(p.mss);
  const out = w.bytes(p.payload).finish();
  put16(out, 16, internetChecksum(out, 0, out.length, pseudoHeaderSum(ipToBytes(p.src), ipToBytes(p.dst), IP_TCP, out.length)));
  return out;
}

export function decodeTcp(b: Uint8Array, o: number, end: number, src: Uint8Array, dst: Uint8Array): TcpHeader | null {
  if (end - o < 20) return null;
  const headerLen = (b[o + 12] >> 4) * 4;
  if (headerLen < 20 || o + headerLen > end) return null;
  const options: TcpOption[] = [];
  for (let i = o + 20; i < o + headerLen; ) {
    const kind = b[i];
    if (kind === 0) {
      options.push({ kind, len: 1, offset: i });
      break;
    }
    if (kind === 1) {
      options.push({ kind, len: 1, offset: i });
      i++;
      continue;
    }
    const len = b[i + 1];
    if (len < 2 || i + len > o + headerLen) break;
    options.push({ kind, len, offset: i, value: kind === 2 && len === 4 ? u16(b, i + 2) : undefined });
    i += len;
  }
  return {
    srcPort: u16(b, o),
    dstPort: u16(b, o + 2),
    seq: u32(b, o + 4),
    ack: u32(b, o + 8),
    headerLen,
    flags: b[o + 13],
    window: u16(b, o + 14),
    checksum: u16(b, o + 16),
    checksumOk: internetChecksum(b, o, end, pseudoHeaderSum(src, dst, IP_TCP, end - o)) === 0,
    urgent: u16(b, o + 18),
    options,
    payloadStart: o + headerLen,
    payloadLen: end - o - headerLen,
  };
}
