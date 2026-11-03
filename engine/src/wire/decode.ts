// Байты кадра → заголовки всех уровней. Не доверяет входу: обрезанные и чужие кадры
// (например, из импортированного .pcap) разбираются настолько, насколько возможно.
import { type ArpHeader, decodeArp } from './arp';
import { decodeDhcp, type DhcpHeader } from './dhcp';
import { decodeDns, type DnsHeader } from './dns';
import { decodeEthernet, ETH_ARP, ETH_IPV4, type EthHeader } from './ethernet';
import { decodeHttp, type HttpParsed } from './http';
import { decodeIcmp, type IcmpHeader } from './icmp';
import { decodeIpv4, IP_ICMP, IP_TCP, IP_UDP, type Ipv4Header } from './ipv4';
import { decodeTcp, type TcpHeader } from './tcp';
import { decodeUdp, type UdpHeader } from './udp';

export interface Decoded {
  bytes: Uint8Array;
  eth?: EthHeader;
  arp?: { off: number; h: ArpHeader };
  ip?: { off: number; h: Ipv4Header; /** Конец IP-датаграммы (без паддинга Ethernet). */ end: number };
  icmp?: { off: number; h: IcmpHeader };
  udp?: { off: number; h: UdpHeader };
  tcp?: { off: number; h: TcpHeader };
  dhcp?: { off: number; end: number; h: DhcpHeader };
  dns?: { off: number; end: number; h: DnsHeader };
  /** HTTP — только если сегмент начинается со стартовой строки HTTP. */
  http?: { off: number; end: number; h: HttpParsed };
  /** Данные TCP без распознанного протокола. */
  data?: { off: number; end: number };
}

const isPort = (u: { srcPort: number; dstPort: number }, ...ports: number[]) => ports.includes(u.srcPort) || ports.includes(u.dstPort);

export function decodeFrame(bytes: Uint8Array): Decoded {
  const d: Decoded = { bytes };
  const eth = decodeEthernet(bytes);
  if (!eth) return d;
  d.eth = eth;
  const o = eth.headerLen;
  if (eth.etherType === ETH_ARP) {
    const h = decodeArp(bytes, o);
    if (h) d.arp = { off: o, h };
    return d;
  }
  if (eth.etherType !== ETH_IPV4) return d;
  const ip = decodeIpv4(bytes, o);
  if (!ip) return d;
  const end = Math.min(bytes.length, o + Math.max(ip.totalLength, ip.headerLen));
  d.ip = { off: o, h: ip, end };
  const l4 = o + ip.headerLen;
  if (ip.fragOffset !== 0) return d;

  if (ip.proto === IP_ICMP) {
    const h = decodeIcmp(bytes, l4, end);
    if (h) d.icmp = { off: l4, h };
  } else if (ip.proto === IP_UDP) {
    const h = decodeUdp(bytes, l4, end, ip.src, ip.dst);
    if (!h) return d;
    d.udp = { off: l4, h };
    const p = l4 + 8;
    const pend = Math.min(end, l4 + h.length);
    if (isPort(h, 67, 68)) {
      const dh = decodeDhcp(bytes, p, pend);
      if (dh) d.dhcp = { off: p, end: pend, h: dh };
    } else if (isPort(h, 53)) {
      const dn = decodeDns(bytes, p, pend);
      if (dn) d.dns = { off: p, end: pend, h: dn };
    }
  } else if (ip.proto === IP_TCP) {
    const h = decodeTcp(bytes, l4, end, ip.src, ip.dst);
    if (!h) return d;
    d.tcp = { off: l4, h };
    if (h.payloadLen > 0) {
      const p = h.payloadStart;
      const http = isPort(h, 80, 8080) ? decodeHttp(bytes.subarray(p, end)) : null;
      if (http) d.http = { off: p, end, h: http };
      else d.data = { off: p, end };
    }
  }
  return d;
}
