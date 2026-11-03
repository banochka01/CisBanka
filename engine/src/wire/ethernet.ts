// Ethernet II (+ тег 802.1Q). Кадры без FCS, дополняются нулями до 60 байт — как их видит libpcap.
import { macToBytes, u16, Writer } from './bytes';
import type { MAC } from '../model/topology';

export const ETH_IPV4 = 0x0800;
export const ETH_ARP = 0x0806;
export const ETH_VLAN = 0x8100;
/** Минимальная длина кадра без FCS. */
export const ETH_MIN = 60;

export interface EthHeader {
  dst: Uint8Array;
  src: Uint8Array;
  vlan?: { pcp: number; dei: number; id: number };
  etherType: number;
  /** 14 или 18 (с тегом). */
  headerLen: number;
}

export function encodeEthernet(dst: MAC, src: MAC, etherType: number, payload: Uint8Array, vlanId?: number): Uint8Array {
  const w = new Writer().bytes(macToBytes(dst)).bytes(macToBytes(src));
  if (vlanId !== undefined) w.u16(ETH_VLAN).u16(vlanId & 0x0fff);
  w.u16(etherType).bytes(payload);
  if (w.len < ETH_MIN) w.zeros(ETH_MIN - w.len);
  return w.finish();
}

export function decodeEthernet(b: Uint8Array): EthHeader | null {
  if (b.length < 14) return null;
  const h: EthHeader = { dst: b.slice(0, 6), src: b.slice(6, 12), etherType: u16(b, 12), headerLen: 14 };
  if (h.etherType === ETH_VLAN && b.length >= 18) {
    const tci = u16(b, 14);
    h.vlan = { pcp: tci >> 13, dei: (tci >> 12) & 1, id: tci & 0x0fff };
    h.etherType = u16(b, 16);
    h.headerLen = 18;
  }
  return h;
}
