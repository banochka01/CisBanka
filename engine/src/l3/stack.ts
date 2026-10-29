import type { Device, IPv4, MAC, Port } from '../model/topology';
import type { IcmpPayload, IpBody, Packet } from '../model/packet';
import type { Verdict } from '../model/events';
import type { Simulator } from '../sim/Simulator';
import { BCAST_MAC } from '../l2/switching';
import { broadcastOf, inSubnet, maskToPrefix, networkOf } from '../util/ip';
import { dhcpClientRx, dhcpServerRx, dnsServerRx, httpServerRx } from './services';
import * as apps from '../apps/jobs';

export const BCAST_IP = '255.255.255.255';

/** L3-интерфейс: физический порт или сабинтерфейс роутера. */
export interface L3If {
  id: string;
  name: string;
  portId: string;
  /** dot1q-тег сабинтерфейса; undefined — нетегированный. */
  vlan?: number;
  mac: MAC;
  ip?: IPv4;
  mask?: IPv4;
  up: boolean;
  helper?: IPv4;
  dhcpClient: boolean;
}

const drop = (reason: string): Verdict => ({ action: 'drop', reason });

export function defaultTtl(d: Device) {
  return d.kind === 'router' ? 255 : 128;
}

export function l3Interfaces(sim: Simulator, d: Device): L3If[] {
  const rt = sim.rt(d.id);
  const out: L3If[] = [];
  for (const p of d.ports) {
    if (!p.l3) continue;
    const lease = rt.dhcp[p.id];
    const ip = p.l3.dhcp ? (lease?.state === 'bound' ? { addr: lease.ip!, mask: lease.mask! } : undefined) : p.l3.ip;
    out.push({
      id: p.id,
      name: p.name,
      portId: p.id,
      mac: p.mac,
      ip: ip?.addr,
      mask: ip?.mask,
      up: p.adminUp,
      helper: p.l3.helperAddress,
      dhcpClient: !!p.l3.dhcp,
    });
    for (const s of p.subinterfaces ?? []) {
      out.push({
        id: s.id,
        name: s.name,
        portId: p.id,
        vlan: s.dot1q,
        mac: p.mac,
        ip: s.l3.ip?.addr,
        mask: s.l3.ip?.mask,
        up: p.adminUp && s.adminUp,
        helper: s.l3.helperAddress,
        dhcpClient: false,
      });
    }
  }
  return out;
}

export function effectiveGateway(sim: Simulator, d: Device): IPv4 | undefined {
  const lease = Object.values(sim.rt(d.id).dhcp).find((l) => l.state === 'bound');
  return lease ? lease.gateway : d.config.gateway;
}

export function effectiveDns(sim: Simulator, d: Device): IPv4 | undefined {
  const lease = Object.values(sim.rt(d.id).dhcp).find((l) => l.state === 'bound');
  return lease ? lease.dns : d.config.dns;
}

export interface Route {
  iface: L3If;
  nextHop: IPv4;
  desc: string;
}

export interface RouteRow {
  type: 'C' | 'S';
  network: IPv4;
  mask: IPv4;
  nextHop?: IPv4;
  iface?: string;
}

/** Таблица маршрутизации в виде строк — для окна «Таблицы». */
export function routingTable(sim: Simulator, d: Device): RouteRow[] {
  const ifs = l3Interfaces(sim, d).filter((i) => i.up && i.ip && i.mask);
  const rows: RouteRow[] = ifs.map((i) => ({ type: 'C', network: networkOf(i.ip!, i.mask!), mask: i.mask!, iface: i.name }));
  if (d.kind === 'router') {
    for (const r of d.config.staticRoutes ?? []) {
      const i = ifs.find((x) => inSubnet(r.nextHop, x.ip!, x.mask!));
      rows.push({ type: 'S', network: r.network, mask: r.mask, nextHop: r.nextHop, iface: i?.name });
    }
  } else {
    const gw = effectiveGateway(sim, d);
    if (gw) rows.push({ type: 'S', network: '0.0.0.0', mask: '0.0.0.0', nextHop: gw });
  }
  return rows;
}

export function routeLookup(sim: Simulator, d: Device, dst: IPv4): Route | { error: string } {
  const ifs = l3Interfaces(sim, d).filter((i) => i.up && i.ip && i.mask);
  if (d.kind !== 'router') {
    const i = ifs[0];
    if (!i) return { error: 'На интерфейсе не настроен IP-адрес (или он выключен)' };
    if (inSubnet(dst, i.ip!, i.mask!)) return { iface: i, nextHop: dst, desc: `${dst} в моей подсети — отправляю напрямую` };
    const gw = effectiveGateway(sim, d);
    if (!gw) return { error: `${dst} в другой подсети, а шлюз по умолчанию не задан` };
    if (!inSubnet(gw, i.ip!, i.mask!)) {
      return { error: `Шлюз ${gw} не входит в подсеть ${i.ip}/${maskToPrefix(i.mask!) ?? '?'} — до него не достучаться` };
    }
    return { iface: i, nextHop: gw, desc: `${dst} в другой подсети — отправляю на шлюз ${gw}` };
  }
  let best: (Route & { prefix: number }) | null = null;
  for (const i of ifs) {
    const prefix = maskToPrefix(i.mask!) ?? 0;
    if (inSubnet(dst, i.ip!, i.mask!) && (!best || prefix > best.prefix)) {
      best = { iface: i, nextHop: dst, prefix, desc: `сеть ${networkOf(i.ip!, i.mask!)}/${prefix} подключена напрямую к ${i.name}` };
    }
  }
  for (const r of d.config.staticRoutes ?? []) {
    const prefix = maskToPrefix(r.mask) ?? 0;
    if (!inSubnet(dst, r.network, r.mask) || (best && prefix <= best.prefix)) continue;
    const i = ifs.find((x) => inSubnet(r.nextHop, x.ip!, x.mask!));
    if (!i) continue;
    best = { iface: i, nextHop: r.nextHop, prefix, desc: `статический маршрут ${r.network}/${prefix} через ${r.nextHop}` };
  }
  return best ?? { error: `Нет маршрута к ${dst} в таблице маршрутизации` };
}

function frameOut(sim: Simulator, d: Device, iface: L3If, dstMac: MAC, body: Omit<Packet, 'id' | 'frameId' | 'l2Hops' | 'l2'>, etherType: 'ARP' | 'IPv4') {
  return sim.transmit(d.id, iface.portId, {
    id: 0,
    frameId: sim.nextId(),
    l2Hops: 0,
    l2: { src: iface.mac, dst: dstMac, vlanTag: iface.vlan, etherType },
    ...body,
  });
}

export function broadcastOut(sim: Simulator, d: Device, iface: L3If, body: IpBody) {
  return frameOut(sim, d, iface, BCAST_MAC, body, 'IPv4');
}

/** Отправить IP-пакет по таблице маршрутизации. Возвращает текст ошибки или null. */
export function sendIp(sim: Simulator, d: Device, body: IpBody): string | null {
  const r = routeLookup(sim, d, body.l3.dst);
  if ('error' in r) {
    sim.drop(d.id, { id: 0, frameId: 0, l2Hops: 0, l2: { src: '', dst: '', etherType: 'IPv4' }, ...body }, r.error);
    return r.error;
  }
  const b = body.l3.src ? body : { ...body, l3: { ...body.l3, src: r.iface.ip! } };
  toNextHop(sim, d, r.iface, r.nextHop, b);
  return null;
}

function toNextHop(sim: Simulator, d: Device, iface: L3If, nextHop: IPv4, body: IpBody) {
  const rt = sim.rt(d.id);
  const e = rt.arp[nextHop];
  if (e && e.expires > sim.now) {
    frameOut(sim, d, iface, e.mac, body, 'IPv4');
    return;
  }
  const key = `${iface.id}|${nextHop}`;
  const pending = rt.pendingArp[key];
  if (pending) {
    pending.packets.push(body);
    return;
  }
  rt.pendingArp[key] = { ifaceId: iface.id, ip: nextHop, packets: [body] };
  frameOut(
    sim,
    d,
    iface,
    BCAST_MAC,
    { arp: { op: 'request', senderMac: iface.mac, senderIp: iface.ip!, targetMac: '0000.0000.0000', targetIp: nextHop } },
    'ARP',
  );
  sim.schedule(sim.opts.arpTimeout, { kind: 'timer', deviceId: d.id, timer: { t: 'arp-timeout', key } });
}

export function onArpTimeout(sim: Simulator, deviceId: string, key: string) {
  const rt = sim.rt(deviceId);
  const p = rt.pendingArp[key];
  if (!p) return;
  delete rt.pendingArp[key];
  sim.addLog({
    kind: 'drop',
    deviceId,
    action: 'drop',
    reason: `ARP: никто не ответил, у кого адрес ${p.ip}. Отброшено пакетов: ${p.packets.length}. Проверьте IP и маску получателя, кабель и VLAN.`,
  });
}

function learnArp(sim: Simulator, d: Device, ip: IPv4, mac: MAC, iface: L3If) {
  sim.rt(d.id).arp[ip] = { mac, ifaceId: iface.id, expires: sim.now + sim.opts.arpTtl };
}

function flushPending(sim: Simulator, d: Device, iface: L3If, ip: IPv4, mac: MAC): number {
  const rt = sim.rt(d.id);
  const key = `${iface.id}|${ip}`;
  const p = rt.pendingArp[key];
  if (!p) return 0;
  delete rt.pendingArp[key];
  for (const b of p.packets) frameOut(sim, d, iface, mac, b, 'IPv4');
  return p.packets.length;
}

/** ICMP-ошибка отправителю. На ICMP-ошибки ошибками не отвечаем. */
function icmpError(sim: Simulator, d: Device, iface: L3If, pkt: Packet, type: IcmpPayload['type'], code?: IcmpPayload['code']) {
  if (pkt.icmp && pkt.icmp.type !== 'echo-request' && pkt.icmp.type !== 'echo-reply') return;
  sendIp(sim, d, {
    l3: { src: iface.ip ?? '', dst: pkt.l3!.src, ttl: defaultTtl(d), proto: 'ICMP' },
    icmp: { type, code, id: pkt.icmp?.id ?? 0, seq: pkt.icmp?.seq ?? 0, original: { src: pkt.l3!.src, dst: pkt.l3!.dst } },
  });
}

/** Приём кадра устройством с IP-стеком (ПК, сервер, роутер). */
export function l3Rx(sim: Simulator, d: Device, port: Port, pkt: Packet): Verdict {
  const ifs = l3Interfaces(sim, d);
  const tag = pkt.l2.vlanTag;
  const iface = ifs.find((i) => i.portId === port.id && i.vlan === tag);
  if (!iface) {
    if (tag === undefined) return drop('Интерфейс не настроен');
    return d.kind === 'router'
      ? drop(`На ${port.name} нет сабинтерфейса с encapsulation dot1q ${tag} — кадр VLAN ${tag} отброшен`)
      : drop(`Хост получил кадр с тегом 802.1Q (VLAN ${tag}) — не понимает его и отбрасывает. Порт свитча к хосту должен быть access.`);
  }
  if (!iface.up) return drop(`Интерфейс ${iface.name} выключен (shutdown)`);
  if (pkt.l2.dst !== iface.mac && pkt.l2.dst !== BCAST_MAC) {
    return drop(`MAC назначения ${pkt.l2.dst} не мой (${iface.mac}) — кадр не для меня, отбрасываю`);
  }
  if (pkt.arp) return arpRx(sim, d, iface, pkt);
  if (pkt.l3) return ipRx(sim, d, iface, ifs, pkt);
  return drop('Неизвестный тип кадра');
}

function arpRx(sim: Simulator, d: Device, iface: L3If, pkt: Packet): Verdict {
  const a = pkt.arp!;
  if (!iface.ip) return drop('У интерфейса нет IP-адреса — ARP игнорируется');
  if (a.op === 'request') {
    if (a.targetIp !== iface.ip) return drop(`ARP-запрос ищет ${a.targetIp}, а у меня ${iface.ip} — не мне, игнорирую`);
    learnArp(sim, d, a.senderIp, a.senderMac, iface);
    flushPending(sim, d, iface, a.senderIp, a.senderMac);
    frameOut(
      sim,
      d,
      iface,
      a.senderMac,
      { arp: { op: 'reply', senderMac: iface.mac, senderIp: iface.ip, targetMac: a.senderMac, targetIp: a.senderIp } },
      'ARP',
    );
    return { action: 'reply', reason: `ARP-запрос ищет мой IP ${iface.ip} — запомнил отправителя и ответил своим MAC ${iface.mac}` };
  }
  if (a.targetIp !== iface.ip) return drop('ARP-ответ не мне');
  learnArp(sim, d, a.senderIp, a.senderMac, iface);
  const n = flushPending(sim, d, iface, a.senderIp, a.senderMac);
  return { action: 'deliver', reason: `ARP-ответ: ${a.senderIp} это ${a.senderMac}. Записал в ARP-таблицу, отправляю ждавшие пакеты (${n} шт.)` };
}

function ipRx(sim: Simulator, d: Device, iface: L3If, ifs: L3If[], pkt: Packet): Verdict {
  const ip = pkt.l3!;
  const mine =
    ip.dst === BCAST_IP ||
    ifs.some((i) => i.ip === ip.dst) ||
    (!!iface.ip && !!iface.mask && ip.dst === broadcastOf(iface.ip, iface.mask));
  if (mine) return localDeliver(sim, d, iface, pkt);
  if (d.kind !== 'router') return drop(`Пакет адресован ${ip.dst}, а мой IP ${iface.ip ?? 'не задан'} — хост не маршрутизирует, отбрасываю`);
  if (pkt.l2.dst === BCAST_MAC) return drop('Широковещательные кадры роутер в другие сети не пересылает');

  if (ip.ttl <= 1) {
    icmpError(sim, d, iface, pkt, 'time-exceeded');
    return drop(`TTL истёк (был ${ip.ttl}) — пакет уничтожен, отправителю ушёл ICMP Time Exceeded. Возможна петля маршрутизации.`);
  }
  const r = routeLookup(sim, d, ip.dst);
  if ('error' in r) {
    icmpError(sim, d, iface, pkt, 'dest-unreachable', 'net');
    return drop(`${r.error} — пакет отброшен, отправителю ушёл ICMP Destination Unreachable`);
  }
  toNextHop(sim, d, r.iface, r.nextHop, { ...stripL2(pkt), l3: { ...ip, ttl: ip.ttl - 1 } });
  return {
    action: 'forward',
    reason: `Маршрутизация: ${r.desc} → выход ${r.iface.name}${r.nextHop !== ip.dst ? `, следующий узел ${r.nextHop}` : ''}. TTL ${ip.ttl}→${ip.ttl - 1}, новый кадр с MAC ${r.iface.mac}`,
  };
}

function stripL2(p: Packet): IpBody {
  const { id: _i, frameId: _f, l2Hops: _h, l2: _l2, arp: _a, ...rest } = p;
  return rest as IpBody;
}

function localDeliver(sim: Simulator, d: Device, iface: L3If, pkt: Packet): Verdict {
  const ip = pkt.l3!;
  if (pkt.icmp) {
    if (pkt.icmp.type === 'echo-request') {
      const err = sendIp(sim, d, {
        l3: { src: ip.dst === BCAST_IP ? iface.ip ?? '' : ip.dst, dst: ip.src, ttl: defaultTtl(d), proto: 'ICMP' },
        icmp: { type: 'echo-reply', id: pkt.icmp.id, seq: pkt.icmp.seq },
      });
      return err ? drop(`Эхо-запрос получен, но ответить не могу: ${err}`) : { action: 'reply', reason: `Эхо-запрос (ping) адресован мне — отправляю эхо-ответ на ${ip.src}` };
    }
    return apps.onIcmp(sim, d, pkt);
  }
  const l4 = pkt.l4;
  if (!l4) return drop('Пакет без L4');
  if (ip.proto === 'UDP') {
    if (pkt.dhcp && l4.dstPort === 67) return dhcpServerRx(sim, d, iface, pkt);
    if (pkt.dhcp && l4.dstPort === 68) return dhcpClientRx(sim, d, iface, pkt);
    if (pkt.dns?.qr === 'query' && l4.dstPort === 53) return dnsServerRx(sim, d, pkt);
    if (pkt.dns?.qr === 'response') return apps.onDns(sim, d, pkt);
    return drop(`UDP-порт ${l4.dstPort} закрыт — пакет отброшен`);
  }
  if (l4.dstPort === 80) return httpServerRx(sim, d, pkt);
  return apps.onTcp(sim, d, pkt);
}
