// DHCP (RFC 2131/2132) поверх BOOTP: фиксированная часть 236 байт, magic cookie, опции.
import type { DhcpPayload } from '../model/packet';
import { ipToBytes, ipToString, macToBytes, macToCisco, u16, u32, Writer } from './bytes';

export const DHCP_MAGIC = 0x63825363;
/** Срок аренды в OFFER/ACK — в модели аренды бессрочные, в байтах пишем сутки. */
export const DHCP_LEASE_SECONDS = 86400;
/** BOOTP-сообщение дополняется до 300 байт, как это делают реальные клиенты. */
const BOOTP_MIN = 300;

export const DHCP_MSG_TYPE: Record<DhcpPayload['op'], number> = { DISCOVER: 1, OFFER: 2, REQUEST: 3, ACK: 5, NAK: 6 };
const MSG_BY_NUM: Record<number, DhcpPayload['op']> = { 1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 5: 'ACK', 6: 'NAK' };
export const DHCP_MSG_NAMES: Record<number, string> = { 1: 'Discover', 2: 'Offer', 3: 'Request', 4: 'Decline', 5: 'ACK', 6: 'NAK', 7: 'Release', 8: 'Inform' };

export const DHCP_OPT = { pad: 0, mask: 1, router: 3, dns: 6, requestedIp: 50, lease: 51, msgType: 53, serverId: 54, paramList: 55, end: 255 } as const;

export interface DhcpOption {
  code: number;
  len: number;
  /** Смещение кода опции. */
  offset: number;
  data: Uint8Array;
}

export interface DhcpHeader {
  op: number;
  htype: number;
  hlen: number;
  hops: number;
  xid: number;
  secs: number;
  flags: number;
  ciaddr: Uint8Array;
  yiaddr: Uint8Array;
  siaddr: Uint8Array;
  giaddr: Uint8Array;
  chaddr: Uint8Array;
  magic: number;
  options: DhcpOption[];
  msgType?: number;
}

export function encodeDhcp(m: DhcpPayload): Uint8Array {
  const fromClient = m.op === 'DISCOVER' || m.op === 'REQUEST';
  const w = new Writer()
    .u8(fromClient ? 1 : 2)
    .u8(1)
    .u8(6)
    .u8(m.giaddr ? 1 : 0)
    .u32(m.xid >>> 0)
    .u16(0)
    .u16(0x8000)
    .bytes(ipToBytes(undefined))
    .bytes(ipToBytes(m.yiaddr))
    .bytes(ipToBytes(undefined))
    .bytes(ipToBytes(m.giaddr))
    .bytes(macToBytes(m.chaddr))
    .zeros(10 + 64 + 128)
    .u32(DHCP_MAGIC);
  const ip = (code: number, v?: string) => v && w.u8(code).u8(4).bytes(ipToBytes(v));
  w.u8(DHCP_OPT.msgType).u8(1).u8(DHCP_MSG_TYPE[m.op]);
  if (m.op === 'REQUEST') ip(DHCP_OPT.requestedIp, m.requestedIp);
  ip(DHCP_OPT.serverId, m.serverId);
  if (m.op === 'OFFER' || m.op === 'ACK') {
    w.u8(DHCP_OPT.lease).u8(4).u32(DHCP_LEASE_SECONDS);
    ip(DHCP_OPT.mask, m.mask);
    ip(DHCP_OPT.router, m.router);
    ip(DHCP_OPT.dns, m.dns);
  }
  if (fromClient) w.u8(DHCP_OPT.paramList).u8(3).u8(DHCP_OPT.mask).u8(DHCP_OPT.router).u8(DHCP_OPT.dns);
  w.u8(DHCP_OPT.end);
  if (w.len < BOOTP_MIN) w.zeros(BOOTP_MIN - w.len);
  return w.finish();
}

export function decodeDhcp(b: Uint8Array, o: number, end: number): DhcpHeader | null {
  if (end - o < 240) return null;
  const h: DhcpHeader = {
    op: b[o],
    htype: b[o + 1],
    hlen: b[o + 2],
    hops: b[o + 3],
    xid: u32(b, o + 4),
    secs: u16(b, o + 8),
    flags: u16(b, o + 10),
    ciaddr: b.slice(o + 12, o + 16),
    yiaddr: b.slice(o + 16, o + 20),
    siaddr: b.slice(o + 20, o + 24),
    giaddr: b.slice(o + 24, o + 28),
    chaddr: b.slice(o + 28, o + 44),
    magic: u32(b, o + 236),
    options: [],
  };
  for (let i = o + 240; i < end; ) {
    const code = b[i];
    if (code === DHCP_OPT.pad) {
      i++;
      continue;
    }
    if (code === DHCP_OPT.end) {
      h.options.push({ code, len: 0, offset: i, data: new Uint8Array(0) });
      break;
    }
    if (i + 1 >= end) break;
    const len = b[i + 1];
    if (i + 2 + len > end) break;
    const data = b.slice(i + 2, i + 2 + len);
    h.options.push({ code, len, offset: i, data });
    if (code === DHCP_OPT.msgType && len === 1) h.msgType = data[0];
    i += 2 + len;
  }
  return h;
}

/** Обратно в сообщение модели (для проверки кодирования туда-обратно). */
export function dhcpToPayload(h: DhcpHeader): DhcpPayload | null {
  const op = h.msgType !== undefined ? MSG_BY_NUM[h.msgType] : undefined;
  if (!op) return null;
  const opt = (code: number) => {
    const o = h.options.find((x) => x.code === code && x.len === 4);
    return o ? ipToString(o.data) : undefined;
  };
  const nz = (a: Uint8Array) => (a.some((x) => x) ? ipToString(a) : undefined);
  const p: DhcpPayload = { op, xid: h.xid, chaddr: macToCisco(h.chaddr) };
  const set = <K extends keyof DhcpPayload>(k: K, v: DhcpPayload[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set('yiaddr', nz(h.yiaddr));
  set('giaddr', nz(h.giaddr));
  set('serverId', opt(DHCP_OPT.serverId));
  set('requestedIp', opt(DHCP_OPT.requestedIp));
  set('mask', opt(DHCP_OPT.mask));
  set('router', opt(DHCP_OPT.router));
  set('dns', opt(DHCP_OPT.dns));
  return p;
}
