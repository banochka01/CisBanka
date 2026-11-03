// ARP для Ethernet/IPv4 (RFC 826).
import type { ArpPayload } from '../model/packet';
import { ipToBytes, ipToString, macToBytes, macToCisco, u16, Writer } from './bytes';

export const ARP_LEN = 28;

export interface ArpHeader {
  htype: number;
  ptype: number;
  hlen: number;
  plen: number;
  op: number;
  sha: Uint8Array;
  spa: Uint8Array;
  tha: Uint8Array;
  tpa: Uint8Array;
}

export function encodeArp(a: ArpPayload): Uint8Array {
  return new Writer()
    .u16(1)
    .u16(0x0800)
    .u8(6)
    .u8(4)
    .u16(a.op === 'request' ? 1 : 2)
    .bytes(macToBytes(a.senderMac))
    .bytes(ipToBytes(a.senderIp))
    .bytes(macToBytes(a.targetMac))
    .bytes(ipToBytes(a.targetIp))
    .finish();
}

export function decodeArp(b: Uint8Array, o: number): ArpHeader | null {
  if (b.length < o + ARP_LEN) return null;
  return {
    htype: u16(b, o),
    ptype: u16(b, o + 2),
    hlen: b[o + 4],
    plen: b[o + 5],
    op: u16(b, o + 6),
    sha: b.slice(o + 8, o + 14),
    spa: b.slice(o + 14, o + 18),
    tha: b.slice(o + 18, o + 24),
    tpa: b.slice(o + 24, o + 28),
  };
}

export function arpToPayload(h: ArpHeader): ArpPayload {
  return {
    op: h.op === 1 ? 'request' : 'reply',
    senderMac: macToCisco(h.sha),
    senderIp: ipToString(h.spa),
    targetMac: macToCisco(h.tha),
    targetIp: ipToString(h.tpa),
  };
}
