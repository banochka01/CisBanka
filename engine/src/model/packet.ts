import type { IPv4, MAC } from './topology';

export type Protocol = 'ARP' | 'ICMP' | 'DHCP' | 'DNS' | 'HTTP' | 'TCP' | 'UDP';
export type TcpFlag = 'SYN' | 'ACK' | 'FIN' | 'RST' | 'PSH';

export interface ArpPayload {
  op: 'request' | 'reply';
  senderMac: MAC;
  senderIp: IPv4;
  targetMac: MAC;
  targetIp: IPv4;
}

export interface IcmpPayload {
  type: 'echo-request' | 'echo-reply' | 'dest-unreachable' | 'time-exceeded';
  code?: 'net' | 'host' | 'port';
  /** Для ошибок — id/seq исходного эхо-запроса. */
  id: number;
  seq: number;
  original?: { src: IPv4; dst: IPv4 };
}

export interface DhcpPayload {
  op: 'DISCOVER' | 'OFFER' | 'REQUEST' | 'ACK' | 'NAK';
  xid: number;
  chaddr: MAC;
  yiaddr?: IPv4;
  giaddr?: IPv4;
  serverId?: IPv4;
  requestedIp?: IPv4;
  mask?: IPv4;
  router?: IPv4;
  dns?: IPv4;
}

export interface DnsPayload {
  id: number;
  qr: 'query' | 'response';
  name: string;
  answer?: IPv4;
  rcode?: 'NOERROR' | 'NXDOMAIN';
}

export interface HttpPayload {
  kind: 'request' | 'response';
  method?: 'GET';
  host?: string;
  path?: string;
  status?: number;
  title?: string;
  body?: string;
}

/** Пакет, разложенный по уровням OSI. Объекты пакетов не мутируются — только копируются. */
export interface Packet {
  /** Уникален для каждой передачи по проводу. */
  id: number;
  /** Общий для всех копий одного кадра (flooding). */
  frameId: number;
  /** Сколько свитчей кадр уже прошёл — защита от петель. */
  l2Hops: number;
  l2: { src: MAC; dst: MAC; vlanTag?: number; etherType: 'ARP' | 'IPv4' };
  arp?: ArpPayload;
  l3?: { src: IPv4; dst: IPv4; ttl: number; proto: 'ICMP' | 'UDP' | 'TCP' };
  l4?: { srcPort: number; dstPort: number; flags?: TcpFlag[] };
  icmp?: IcmpPayload;
  dhcp?: DhcpPayload;
  dns?: DnsPayload;
  http?: HttpPayload;
}

/** IP-часть пакета до формирования кадра. */
export type IpBody = Omit<Packet, 'id' | 'frameId' | 'l2Hops' | 'l2' | 'arp'> & {
  l3: NonNullable<Packet['l3']>;
};

export function protocolOf(p: Pick<Packet, 'arp' | 'icmp' | 'dhcp' | 'dns' | 'http' | 'l3'>): Protocol {
  if (p.arp) return 'ARP';
  if (p.icmp) return 'ICMP';
  if (p.dhcp) return 'DHCP';
  if (p.dns) return 'DNS';
  if (p.http) return 'HTTP';
  if (p.l3?.proto === 'TCP') return 'TCP';
  return 'UDP';
}
