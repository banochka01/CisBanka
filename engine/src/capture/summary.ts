// Колонки списка пакетов в стиле Wireshark: Source, Destination, Protocol, Info.
// Работает по байтам (decodeFrame), поэтому подходит и для импортированных .pcap.
import { ipToString, macToString } from '../wire/bytes';
import type { Decoded } from '../wire/decode';
import { DHCP_MSG_NAMES } from '../wire/dhcp';
import { DNS_TYPE_A } from '../wire/dns';
import { bitsToFlags } from '../wire/tcp';

export type ColumnProtocol = 'ARP' | 'ICMP' | 'DHCP' | 'DNS' | 'HTTP' | 'TCP' | 'UDP' | 'IPv4' | 'Ethernet';

export interface Summary {
  src: string;
  dst: string;
  protocol: ColumnProtocol;
  info: string;
}

/**
 * Относительные номера TCP (как в Wireshark): для каждого направления соединения
 * запоминается ISN. Кадры нужно подавать по порядку.
 */
export class TcpSeqContext {
  private isn = new Map<string, number>();

  base(key: string, seq: number, syn: boolean): number {
    let b = this.isn.get(key);
    if (b === undefined || syn) {
      b = seq;
      this.isn.set(key, b);
    }
    return b;
  }

  peek(key: string): number | undefined {
    return this.isn.get(key);
  }
}

const rel = (v: number, base: number | undefined) => (base === undefined ? v : (v - base) >>> 0);

const ICMP_NAMES: Record<number, string> = { 0: 'Echo (ping) reply', 3: 'Destination unreachable', 8: 'Echo (ping) request', 11: 'Time-to-live exceeded' };
const UNREACH: Record<number, string> = { 0: 'Network unreachable', 1: 'Host unreachable', 3: 'Port unreachable' };

const macName = (b: Uint8Array) => (b.every((x) => x === 0xff) ? 'Broadcast' : macToString(b));

export function summarize(d: Decoded, tcp?: TcpSeqContext): Summary {
  const eth = d.eth;
  if (!eth) return { src: '', dst: '', protocol: 'Ethernet', info: `Обрезанный кадр (${d.bytes.length} байт)` };
  const base = { src: macToString(eth.src), dst: macName(eth.dst) };

  if (d.arp) {
    const a = d.arp.h;
    const info =
      a.op === 1
        ? `Who has ${ipToString(a.tpa)}? Tell ${ipToString(a.spa)}`
        : a.op === 2
          ? `${ipToString(a.spa)} is at ${macToString(a.sha)}`
          : `ARP opcode ${a.op}`;
    return { ...base, protocol: 'ARP', info };
  }
  if (!d.ip) return { ...base, protocol: 'Ethernet', info: `EtherType 0x${eth.etherType.toString(16).padStart(4, '0')}` };

  const ip = d.ip.h;
  const addr = { src: ipToString(ip.src), dst: ipToString(ip.dst) };

  if (d.icmp) {
    const h = d.icmp.h;
    let info = ICMP_NAMES[h.type] ?? `Type ${h.type}`;
    if (h.type === 0 || h.type === 8) {
      const swapped = ((h.seq & 0xff) << 8) | (h.seq >> 8);
      info += `  id=0x${h.id.toString(16).padStart(4, '0')}, seq=${h.seq}/${swapped}, ttl=${ip.ttl}`;
    } else if (h.type === 3) info += ` (${UNREACH[h.code] ?? `code ${h.code}`})`;
    else if (h.type === 11) info += ' (Time to live exceeded in transit)';
    return { ...addr, protocol: 'ICMP', info };
  }

  if (d.dhcp) {
    const h = d.dhcp.h;
    const name = h.msgType !== undefined ? DHCP_MSG_NAMES[h.msgType] ?? `Type ${h.msgType}` : 'BOOTP';
    return { ...addr, protocol: 'DHCP', info: `DHCP ${name} - Transaction ID 0x${h.xid.toString(16).padStart(8, '0')}` };
  }

  if (d.dns) {
    const h = d.dns.h;
    const id = `0x${h.id.toString(16).padStart(4, '0')}`;
    const q = h.questions.map((x) => `${x.type === DNS_TYPE_A ? 'A' : `TYPE${x.type}`} ${x.name}`).join(' ');
    if (!h.qr) return { ...addr, protocol: 'DNS', info: `Standard query ${id} ${q}` };
    if (h.rcode === 3) return { ...addr, protocol: 'DNS', info: `Standard query response ${id} No such name ${q}` };
    const ans = h.answers.map((a) => (a.type === DNS_TYPE_A && a.rdlength === 4 ? `A ${ipToString(a.rdata)}` : `TYPE${a.type}`)).join(' ');
    return { ...addr, protocol: 'DNS', info: `Standard query response ${id} ${q} ${ans}`.trim() };
  }

  if (d.udp) {
    const h = d.udp.h;
    return { ...addr, protocol: 'UDP', info: `${h.srcPort} → ${h.dstPort} Len=${Math.max(0, h.length - 8)}` };
  }

  if (d.tcp) {
    const h = d.tcp.h;
    const flags = bitsToFlags(h.flags);
    const fwd = `${addr.src}:${h.srcPort}>${addr.dst}:${h.dstPort}`;
    const rev = `${addr.dst}:${h.dstPort}>${addr.src}:${h.srcPort}`;
    const seqBase = tcp?.base(fwd, h.seq, flags.includes('SYN'));
    const ackBase = tcp?.peek(rev);
    if (d.http) {
      const s = d.http.h.startLine;
      const ct = d.http.h.headers.find((x) => x.name.toLowerCase() === 'content-type')?.value.split(';')[0];
      return { ...addr, protocol: 'HTTP', info: d.http.h.payload?.kind === 'response' && ct ? `${s}  (${ct})` : s };
    }
    const parts = [`${h.srcPort} → ${h.dstPort}`, `[${flags.join(', ')}]`, `Seq=${rel(h.seq, seqBase)}`];
    if (flags.includes('ACK')) parts.push(`Ack=${rel(h.ack, ackBase)}`);
    parts.push(`Win=${h.window}`, `Len=${h.payloadLen}`);
    const mss = h.options.find((o) => o.kind === 2)?.value;
    if (mss) parts.push(`MSS=${mss}`);
    return { ...addr, protocol: 'TCP', info: parts.join(' ') };
  }

  return { ...addr, protocol: 'IPv4', info: `Protocol ${ip.proto}` };
}
