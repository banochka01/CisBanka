// Настоящие байты кадра → пакет модели. Нужен для «Linux-хоста» (VM v86): его кадры попадают
// в симуляцию, где ПК, сервер и роутер работают с моделью, а не с байтами.
//
// То, что движок умеет моделировать (ARP, эхо ICMP, TCP, HTTP-запрос), раскладывается по полям,
// а исходные байты сохраняются в l2.raw — захват и свитч показывают кадр ровно таким, каким его
// отправил Linux. Всё остальное (IPv6, mDNS, IGMP, LLDP…) — непрозрачный кадр etherType 'raw':
// свитч пересылает его по MAC, хосты игнорируют.
import type { Packet } from '../model/packet';
import { ipToString, macToCisco } from './bytes';
import { decodeFrame } from './decode';
import { bitsToFlags } from './tcp';

/** Кадр от внешнего хоста. id/frameId/l2Hops назначит симулятор. */
export function packetFromFrame(bytes: Uint8Array): Packet {
  const raw = bytes.slice();
  const d = decodeFrame(raw);
  const base = { id: 0, frameId: 0, l2Hops: 0 };
  const eth = d.eth;
  if (!eth) return { ...base, l2: { src: '0000.0000.0000', dst: '0000.0000.0000', etherType: 'raw', raw } };
  const l2 = { src: macToCisco(eth.src), dst: macToCisco(eth.dst), raw };
  const opaque = (): Packet => ({ ...base, l2: { ...l2, etherType: 'raw' } });
  // Кадры с тегом от хоста не ждём: VM подключается к access-порту.
  if (eth.vlan) return opaque();

  if (d.arp) {
    const a = d.arp.h;
    if (a.htype !== 1 || a.ptype !== 0x0800 || (a.op !== 1 && a.op !== 2)) return opaque();
    return {
      ...base,
      l2: { ...l2, etherType: 'ARP' },
      arp: { op: a.op === 1 ? 'request' : 'reply', senderMac: macToCisco(a.sha), senderIp: ipToString(a.spa), targetMac: macToCisco(a.tha), targetIp: ipToString(a.tpa) },
    };
  }

  const ip = d.ip;
  if (!ip || !ip.h.checksumOk || ip.h.headerLen !== 20 || ip.h.fragOffset !== 0 || ip.h.flags & 1) return opaque();
  const l3 = { src: ipToString(ip.h.src), dst: ipToString(ip.h.dst), ttl: ip.h.ttl, ipId: ip.h.id };

  if (d.icmp) {
    const h = d.icmp.h;
    if (h.type !== 0 && h.type !== 8) return opaque();
    return {
      ...base,
      l2: { ...l2, etherType: 'IPv4' },
      l3: { ...l3, proto: 'ICMP' },
      icmp: { type: h.type === 8 ? 'echo-request' : 'echo-reply', id: h.id, seq: h.seq, data: raw.slice(h.dataStart, h.dataStart + h.dataLen) },
    };
  }

  if (d.tcp) {
    const h = d.tcp.h;
    const payload = raw.slice(h.payloadStart, h.payloadStart + h.payloadLen);
    const mss = h.options.find((o) => o.kind === 2)?.value;
    const http = d.http?.h.payload?.kind === 'request' ? d.http.h.payload : undefined;
    return {
      ...base,
      l2: { ...l2, etherType: 'IPv4' },
      l3: { ...l3, proto: 'TCP' },
      l4: {
        srcPort: h.srcPort,
        dstPort: h.dstPort,
        flags: bitsToFlags(h.flags),
        seq: h.seq,
        ack: h.ack,
        window: h.window,
        ...(mss ? { mss } : {}),
        ...(payload.length ? { payload } : {}),
      },
      ...(http ? { http } : {}),
    };
  }
  return opaque();
}
