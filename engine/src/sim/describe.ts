// Короткие человеческие описания пакетов — для журнала и подписей в режиме симуляции.
import type { Packet } from '../model/packet';

/** Что это за пакет, одной фразой: «ARP-запрос: у кого 192.168.1.1?». */
export function describePacket(p: Packet): string {
  if (p.arp) {
    return p.arp.op === 'request'
      ? `ARP-запрос: «У кого ${p.arp.targetIp}? Сообщите ${p.arp.senderIp}»`
      : `ARP-ответ: «${p.arp.senderIp} — это я, мой MAC ${p.arp.senderMac}»`;
  }
  if (p.icmp) {
    const t = p.icmp.type;
    if (t === 'echo-request') return `Ping: эхо-запрос ${p.l3!.src} → ${p.l3!.dst}`;
    if (t === 'echo-reply') return `Ping: эхо-ответ ${p.l3!.src} → ${p.l3!.dst}`;
    if (t === 'time-exceeded') return `ICMP «Время жизни истекло» для ${p.l3!.dst}`;
    return `ICMP «Получатель недостижим» для ${p.l3!.dst}`;
  }
  if (p.dhcp) return `DHCP ${p.dhcp.op}${p.dhcp.yiaddr ? ` (адрес ${p.dhcp.yiaddr})` : ''}`;
  if (p.dns) return p.dns.qr === 'query' ? `DNS-запрос: какой IP у ${p.dns.name}?` : `DNS-ответ: ${p.dns.name} = ${p.dns.answer ?? p.dns.rcode}`;
  if (p.http) return p.http.kind === 'request' ? `HTTP ${p.http.method} ${p.http.host ?? ''}${p.http.path ?? ''}` : `HTTP-ответ ${p.http.status}`;
  if (p.l4?.flags?.length) return `TCP ${p.l4.flags.join('+')} ${p.l3!.src}:${p.l4.srcPort} → ${p.l3!.dst}:${p.l4.dstPort}`;
  return `${p.l3?.proto ?? 'Кадр'} ${p.l3?.src ?? p.l2.src} → ${p.l3?.dst ?? p.l2.dst}`;
}
