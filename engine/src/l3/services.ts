import type { Device, DhcpPool, IPv4, MAC } from '../model/topology';
import type { DhcpPayload, Packet, TcpFlag } from '../model/packet';
import type { Verdict } from '../model/events';
import type { Simulator } from '../sim/Simulator';
import { inSubnet, intToIp, ipToInt } from '../util/ip';
import { BCAST_IP, broadcastOut, defaultTtl, l3Interfaces, sendIp, type L3If } from './stack';
import { dhcpJobLine } from '../apps/jobs';

const drop = (reason: string): Verdict => ({ action: 'drop', reason });

// ---------- DHCP: сервер и relay ----------

function allocate(sim: Simulator, d: Device, pool: DhcpPool, mac: MAC): IPv4 | null {
  const rt = sim.rt(d.id);
  const existing = rt.leases.find((l) => l.mac === mac && l.pool === pool.name);
  if (existing) return existing.ip;
  const used = new Set(rt.leases.map((l) => l.ip));
  for (const i of l3Interfaces(sim, d)) if (i.ip) used.add(i.ip);
  if (pool.gateway) used.add(pool.gateway);
  if (pool.dns) used.add(pool.dns);
  for (let n = ipToInt(pool.start); n <= ipToInt(pool.end); n++) {
    const ip = intToIp(n);
    if (!used.has(ip)) {
      rt.leases.push({ ip, mac, pool: pool.name });
      return ip;
    }
  }
  return null;
}

export function dhcpServerRx(sim: Simulator, d: Device, iface: L3If, pkt: Packet): Verdict {
  const dh = pkt.dhcp!;

  // Ответ сервера пришёл на relay-агент (роутер) — раздаём в сеть клиента.
  if (dh.op === 'OFFER' || dh.op === 'ACK' || dh.op === 'NAK') {
    const out = d.kind === 'router' ? l3Interfaces(sim, d).find((i) => i.ip && i.ip === dh.giaddr) : undefined;
    if (!out) return drop('DHCP-ответ сервера пришёл не на relay-агента — отброшен');
    broadcastOut(sim, d, out, {
      l3: { src: out.ip!, dst: BCAST_IP, ttl: defaultTtl(d), proto: 'UDP' },
      l4: { srcPort: 67, dstPort: 68 },
      dhcp: dh,
    });
    return { action: 'relay', reason: `DHCP relay: ответ сервера (${dh.op}) разослан широковещательно в сеть интерфейса ${out.name}` };
  }

  // Запрос клиента пришёл на роутер с ip helper-address — пересылаем на сервер.
  if (!dh.giaddr && iface.helper) {
    if (!iface.ip) return drop('ip helper-address задан, но у интерфейса нет IP — relay невозможен');
    const err = sendIp(sim, d, {
      l3: { src: iface.ip, dst: iface.helper, ttl: defaultTtl(d), proto: 'UDP' },
      l4: { srcPort: 67, dstPort: 67 },
      dhcp: { ...dh, giaddr: iface.ip },
    });
    if (err) return drop(`DHCP relay не смог переслать запрос на ${iface.helper}: ${err}`);
    return {
      action: 'relay',
      reason: `DHCP relay: широковещательный ${dh.op} не уходит в другую сеть, поэтому роутер переслал его адресно на сервер ${iface.helper} (giaddr=${iface.ip})`,
    };
  }

  const pools = d.config.dhcpPools ?? [];
  const serves = d.kind === 'router' ? pools.length > 0 : d.kind === 'server' && !!d.config.services?.dhcp;
  if (!serves) {
    return drop(
      d.kind === 'router'
        ? 'Роутер не пересылает широковещательные пакеты в другие сети. Чтобы DHCP-сервер из другой подсети работал, задайте на этом интерфейсе ip helper-address'
        : 'DHCP-сервис на устройстве не запущен — запрос проигнорирован',
    );
  }
  if (!iface.ip) return drop('У интерфейса DHCP-сервера нет IP-адреса');
  const netIp = dh.giaddr ?? iface.ip;
  const pool = pools.find((p) => inSubnet(netIp, p.network, p.mask));
  if (!pool) return drop(`Нет DHCP-пула для сети ${netIp} — запрос проигнорирован`);

  let reply: DhcpPayload;
  if (dh.op === 'DISCOVER') {
    const ip = allocate(sim, d, pool, dh.chaddr);
    if (!ip) return drop(`Пул «${pool.name}» исчерпан — свободных адресов нет`);
    reply = { op: 'OFFER', xid: dh.xid, chaddr: dh.chaddr, yiaddr: ip, giaddr: dh.giaddr, serverId: iface.ip, mask: pool.mask, router: pool.gateway, dns: pool.dns };
  } else if (dh.op === 'REQUEST') {
    if (dh.serverId && dh.serverId !== iface.ip) return drop('Клиент выбрал другой DHCP-сервер');
    const ip = allocate(sim, d, pool, dh.chaddr);
    reply = ip && ip === dh.requestedIp
      ? { op: 'ACK', xid: dh.xid, chaddr: dh.chaddr, yiaddr: ip, giaddr: dh.giaddr, serverId: iface.ip, mask: pool.mask, router: pool.gateway, dns: pool.dns }
      : { op: 'NAK', xid: dh.xid, chaddr: dh.chaddr, giaddr: dh.giaddr, serverId: iface.ip };
  } else {
    return drop(`Неожиданное DHCP-сообщение ${dh.op}`);
  }

  if (dh.giaddr) {
    sendIp(sim, d, { l3: { src: iface.ip, dst: dh.giaddr, ttl: defaultTtl(d), proto: 'UDP' }, l4: { srcPort: 67, dstPort: 67 }, dhcp: reply });
  } else {
    broadcastOut(sim, d, iface, { l3: { src: iface.ip, dst: BCAST_IP, ttl: defaultTtl(d), proto: 'UDP' }, l4: { srcPort: 67, dstPort: 68 }, dhcp: reply });
  }
  const what = reply.op === 'OFFER' ? `предлагаю адрес ${reply.yiaddr} из пула «${pool.name}»` : reply.op === 'ACK' ? `подтверждаю аренду ${reply.yiaddr}` : 'отказ (NAK)';
  return { action: 'reply', reason: `DHCP-сервер получил ${dh.op}: ${what}${dh.giaddr ? ` — ответ через relay ${dh.giaddr}` : ''}` };
}

// ---------- DHCP: клиент ----------

export function dhcpClientRx(sim: Simulator, d: Device, iface: L3If, pkt: Packet): Verdict {
  const dh = pkt.dhcp!;
  const st = sim.rt(d.id).dhcp[iface.id];
  if (!st || st.xid !== dh.xid || dh.chaddr !== iface.mac) return drop('DHCP-ответ предназначен другому клиенту (не мой xid/MAC) — игнорирую');
  if (dh.op === 'OFFER' && st.state === 'selecting') {
    st.state = 'requesting';
    broadcastOut(sim, d, iface, {
      l3: { src: '0.0.0.0', dst: BCAST_IP, ttl: defaultTtl(d), proto: 'UDP' },
      l4: { srcPort: 68, dstPort: 67 },
      dhcp: { op: 'REQUEST', xid: st.xid, chaddr: iface.mac, requestedIp: dh.yiaddr, serverId: dh.serverId },
    });
    return { action: 'reply', reason: `Получил предложение ${dh.yiaddr} от ${dh.serverId} — прошу его (DHCPREQUEST)` };
  }
  if (dh.op === 'ACK' && st.state === 'requesting') {
    Object.assign(st, { state: 'bound', ip: dh.yiaddr, mask: dh.mask, gateway: dh.router, dns: dh.dns, server: dh.serverId });
    dhcpJobLine(sim, st.jobId, `Адрес получен: IP ${dh.yiaddr}, маска ${dh.mask}, шлюз ${dh.router ?? '—'}, DNS ${dh.dns ?? '—'}`, true);
    return { action: 'deliver', reason: `DHCPACK: адрес ${dh.yiaddr} мой, настраиваю интерфейс (маска ${dh.mask}, шлюз ${dh.router ?? '—'})` };
  }
  if (dh.op === 'NAK') {
    st.state = 'failed';
    dhcpJobLine(sim, st.jobId, 'Сервер отказал в выдаче адреса (DHCPNAK)', true);
    return drop('DHCPNAK — сервер отказал');
  }
  return drop(`DHCP ${dh.op} в состоянии ${st.state} — игнорирую`);
}

// ---------- DNS ----------

export function dnsServerRx(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const dns = d.config.services?.dns;
  if (!dns?.enabled) return drop('DNS-сервис на устройстве выключен — запрос отброшен');
  const q = pkt.dns!;
  const rec = dns.records.find((r) => r.name.toLowerCase() === q.name.toLowerCase());
  sendIp(sim, d, {
    l3: { src: pkt.l3!.dst, dst: pkt.l3!.src, ttl: defaultTtl(d), proto: 'UDP' },
    l4: { srcPort: 53, dstPort: pkt.l4!.srcPort },
    dns: { id: q.id, qr: 'response', name: q.name, answer: rec?.address, rcode: rec ? 'NOERROR' : 'NXDOMAIN' },
  });
  return {
    action: 'reply',
    reason: rec ? `DNS: нашёл запись ${q.name} → ${rec.address}, отвечаю` : `DNS: записи для ${q.name} нет — отвечаю NXDOMAIN`,
  };
}

// ---------- HTTP поверх упрощённого TCP ----------

export function httpServerRx(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const http = d.config.services?.http;
  const flags = pkt.l4!.flags ?? [];
  const reply = (fl: TcpFlag[], extra: Partial<Packet> = {}) =>
    sendIp(sim, d, {
      l3: { src: pkt.l3!.dst, dst: pkt.l3!.src, ttl: defaultTtl(d), proto: 'TCP' },
      l4: { srcPort: 80, dstPort: pkt.l4!.srcPort, flags: fl },
      ...extra,
    });
  if (!http?.enabled) {
    if (!flags.includes('RST')) reply(['RST', 'ACK']);
    return { action: 'reply', reason: 'Порт 80 закрыт — HTTP-сервис не запущен. Отвечаю TCP RST (соединение отклонено)' };
  }
  if (flags.includes('SYN')) {
    reply(['SYN', 'ACK']);
    return { action: 'reply', reason: 'TCP SYN на порт 80 — шаг 2 рукопожатия: отвечаю SYN-ACK' };
  }
  if (pkt.http?.kind === 'request') {
    reply(['PSH', 'ACK', 'FIN'], { http: { kind: 'response', status: 200, title: http.title, body: http.body } });
    return { action: 'reply', reason: `HTTP GET ${pkt.http.path ?? '/'} — отдаю страницу «${http.title}» (200 OK) и закрываю соединение` };
  }
  return { action: 'deliver', reason: 'TCP ACK — рукопожатие завершено, соединение установлено' };
}
