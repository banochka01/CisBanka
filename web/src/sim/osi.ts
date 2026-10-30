// Разбор пакета по уровням OSI с объяснением простым языком (окно «Вход / Выход»).
import type { Packet, Simulator } from '@ciscobanka/engine';
import { CABLE_LABELS } from '../ui/portInfo';

export interface Layer {
  n: number;
  name: string;
  /** Заголовок: поля уровня одной строкой. */
  head: string;
  /** Объяснение простым языком. */
  text: string;
}

const BCAST = 'FFFF.FFFF.FFFF';

const WELL_KNOWN: Record<number, string> = {
  53: 'DNS',
  67: 'DHCP-сервер',
  68: 'DHCP-клиент',
  80: 'HTTP (веб-сервер)',
};

const TCP_FLAGS: Record<string, string> = {
  SYN: 'SYN — «давай установим соединение»',
  ACK: 'ACK — «получил, подтверждаю»',
  FIN: 'FIN — «я закончил, закрываем соединение»',
  RST: 'RST — «соединения нет / порт закрыт, сброс»',
  PSH: 'PSH — «передаю данные приложению сразу»',
};

export function osiLayers(sim: Simulator, portId: string | undefined, p: Packet, dir: 'in' | 'out'): Layer[] {
  const layers: Layer[] = [];
  const pe = portId ? sim.portById(portId) : undefined;
  const link = portId ? sim.linkOf(portId) : undefined;

  if (pe) {
    let peer = '';
    if (link) {
      const other = link.a.portId === portId ? link.b : link.a;
      const o = sim.portById(other.portId);
      peer = o ? ` · ${CABLE_LABELS[link.cable]} к ${o.device.name} ${o.port.name}` : '';
    }
    layers.push({
      n: 1,
      name: 'Физический',
      head: `Порт ${pe.port.name}${peer}`,
      text:
        dir === 'in'
          ? `Сигнал пришёл по кабелю в порт ${pe.port.name} устройства «${pe.device.name}».`
          : `Устройство «${pe.device.name}» отправляет сигнал в кабель через порт ${pe.port.name}.`,
    });
  }

  const l2 = p.l2;
  const bcast = l2.dst === BCAST;
  layers.push({
    n: 2,
    name: 'Канальный',
    head: `Ethernet: ${l2.src} → ${l2.dst}${l2.vlanTag !== undefined ? ` · 802.1Q VLAN ${l2.vlanTag}` : ''}`,
    text:
      (bcast
        ? 'MAC получателя FFFF.FFFF.FFFF — широковещательный: кадр получат все устройства в этом сегменте (VLAN). Свитч рассылает его во все порты.'
        : `Кадр адресован сетевой карте с MAC ${l2.dst}. Свитчи по своей MAC-таблице решают, в какой порт его отдать.`) +
      (l2.vlanTag !== undefined ? ` Тег VLAN ${l2.vlanTag} говорит соседу по транку, к какой VLAN относится кадр.` : ''),
  });

  if (p.arp) {
    const a = p.arp;
    layers.push({
      n: 3,
      name: 'ARP',
      head: `ARP ${a.op === 'request' ? 'запрос' : 'ответ'}: ${a.senderIp} (${a.senderMac}) → ${a.targetIp}`,
      text:
        a.op === 'request'
          ? `Отправитель знает IP получателя (${a.targetIp}), но не знает его MAC. Он спрашивает всех: «У кого ${a.targetIp}? Сообщите ${a.senderIp}».`
          : `Ответ на ARP-запрос: «${a.senderIp} — это я, мой MAC ${a.senderMac}». Отправитель запомнит это в ARP-таблице.`,
    });
    return layers;
  }

  if (p.l3) {
    const ip = p.l3;
    layers.push({
      n: 3,
      name: 'Сетевой',
      head: `IPv4: ${ip.src} → ${ip.dst} · TTL ${ip.ttl}`,
      text: `IP-адреса — «почтовый адрес» пакета: откуда (${ip.src}) и куда (${ip.dst}) он идёт через все сети. TTL ${ip.ttl} — сколько ещё роутеров пакет может пройти; каждый роутер уменьшает TTL на 1, на нуле пакет уничтожается.${ip.dst === '255.255.255.255' ? ' Адрес 255.255.255.255 — широковещательный: «всем в моей сети».' : ''}`,
    });
  }

  if (p.icmp) {
    const i = p.icmp;
    const text: Record<string, string> = {
      'echo-request': 'Эхо-запрос (ping): «Ты здесь? Ответь».',
      'echo-reply': 'Эхо-ответ: «Да, я здесь». По времени ответа ping считает задержку.',
      'time-exceeded': 'Роутер сообщает: TTL пакета кончился в пути — пакет уничтожен. Так работает traceroute, а ещё так проявляются петли маршрутизации.',
      'dest-unreachable': 'Сообщение об ошибке: получатель недостижим (нет маршрута, хост не отвечает или порт закрыт).',
    };
    layers.push({ n: 3, name: 'ICMP', head: `ICMP ${i.type} · id ${i.id} seq ${i.seq}`, text: text[i.type] });
  }

  if (p.l4) {
    const l4 = p.l4;
    const svc = WELL_KNOWN[l4.dstPort] ?? WELL_KNOWN[l4.srcPort];
    const tcp = p.l3?.proto === 'TCP';
    layers.push({
      n: 4,
      name: 'Транспортный',
      head: `${tcp ? 'TCP' : 'UDP'}: порт ${l4.srcPort} → ${l4.dstPort}${l4.flags?.length ? ` · ${l4.flags.join(', ')}` : ''}`,
      text:
        `Порт — номер «квартиры» программы внутри устройства${svc ? `: ${svc}` : ''}. ` +
        (tcp
          ? `TCP доставляет данные надёжно, с установкой соединения.${l4.flags?.length ? ' Флаги: ' + l4.flags.map((f) => TCP_FLAGS[f] ?? f).join('; ') + '.' : ''}`
          : 'UDP отправляет данные без установки соединения — быстро, но без гарантий.'),
    });
  }

  if (p.dhcp) {
    const d = p.dhcp;
    const text: Record<string, string> = {
      DISCOVER: 'Клиент без адреса кричит на всю сеть: «Есть DHCP-сервер? Мне нужен IP».',
      OFFER: `Сервер предлагает адрес ${d.yiaddr ?? ''}.`,
      REQUEST: `Клиент просит: «Беру адрес ${d.requestedIp ?? d.yiaddr ?? ''}».`,
      ACK: `Сервер подтверждает: адрес ${d.yiaddr ?? ''} ваш, маска ${d.mask ?? '—'}, шлюз ${d.router ?? '—'}, DNS ${d.dns ?? '—'}.`,
      NAK: 'Сервер отказал в выдаче адреса.',
    };
    layers.push({
      n: 7,
      name: 'Прикладной',
      head: `DHCP ${d.op} · xid ${d.xid.toString(16)}${d.giaddr ? ` · relay ${d.giaddr}` : ''}`,
      text: text[d.op] + (d.giaddr ? ` Через relay-агента ${d.giaddr} (ip helper-address на роутере).` : ''),
    });
  }

  if (p.dns) {
    const d = p.dns;
    layers.push({
      n: 7,
      name: 'Прикладной',
      head: `DNS ${d.qr === 'query' ? 'запрос' : 'ответ'}: ${d.name}${d.answer ? ` = ${d.answer}` : d.rcode && d.qr === 'response' ? ` · ${d.rcode}` : ''}`,
      text:
        d.qr === 'query'
          ? `Клиент спрашивает DNS-сервер: «Какой IP у имени ${d.name}?»`
          : d.answer
            ? `DNS-сервер отвечает: ${d.name} — это ${d.answer}.`
            : `DNS-сервер отвечает: имени ${d.name} не существует (NXDOMAIN).`,
    });
  }

  if (p.http) {
    const h = p.http;
    layers.push({
      n: 7,
      name: 'Прикладной',
      head: h.kind === 'request' ? `HTTP ${h.method} http://${h.host ?? ''}${h.path ?? '/'}` : `HTTP ${h.status}${h.title ? ` · «${h.title}»` : ''}`,
      text: h.kind === 'request' ? 'Браузер просит у веб-сервера страницу.' : 'Веб-сервер отдаёт страницу браузеру.',
    });
  }

  return layers;
}
