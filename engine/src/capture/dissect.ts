// Дерево разбора кадра в стиле Wireshark: Frame → Ethernet → IP → TCP → HTTP…
// У каждого узла — диапазон байтов (для подсветки в hex-дампе) и, где есть смысл,
// имя поля фильтра (ip.src, tcp.flags.syn…). Значения полей собираются в карту для фильтров.
import { bytesToHex, ipToString, macToString, u16 } from '../wire/bytes';
import { decodeFrame, type Decoded } from '../wire/decode';
import { DHCP_MSG_NAMES, DHCP_OPT } from '../wire/dhcp';
import { decodeIpv4, IP_ICMP, IP_TCP, IP_UDP, type Ipv4Header } from '../wire/ipv4';
import { ETH_ARP, ETH_IPV4, ETH_VLAN } from '../wire/ethernet';
import { TCP_FLAG_BITS } from '../wire/tcp';
import type { DnsQuestion, DnsAnswer } from '../wire/dns';

export type FieldValue = number | string | boolean;

export interface Field {
  label: string;
  start: number;
  len: number;
  /** Имя поля фильтра (если поле можно фильтровать). */
  name?: string;
  children?: Field[];
}

export interface Dissection {
  decoded: Decoded;
  tree: Field[];
  /** Значения полей для фильтров; протоколы — как поле со значением true. */
  values: Map<string, FieldValue[]>;
  /** Цепочка протоколов: eth:ethertype:ip:tcp:http. */
  protocols: string[];
}

export interface FrameMeta {
  number?: number;
  /** Секунды от начала захвата. */
  relTime?: number;
  /** Номер TCP-потока (tcp.stream). */
  tcpStream?: number;
}

const hex = (v: number, w: number) => `0x${v.toString(16).padStart(w, '0')}`;
const PROTO_NAMES: Record<number, string> = { [IP_ICMP]: 'ICMP', [IP_TCP]: 'TCP', [IP_UDP]: 'UDP' };
const ETH_TYPES: Record<number, string> = { [ETH_IPV4]: 'IPv4', [ETH_ARP]: 'ARP', [ETH_VLAN]: '802.1Q Virtual LAN' };
const ICMP_TYPES: Record<number, string> = { 0: 'Echo (ping) reply', 3: 'Destination unreachable', 8: 'Echo (ping) request', 11: 'Time-to-live exceeded' };
const UNREACH: Record<number, string> = { 0: 'Network unreachable', 1: 'Host unreachable', 3: 'Port unreachable' };

class Tree {
  values = new Map<string, FieldValue[]>();
  set(name: string, v: FieldValue) {
    const a = this.values.get(name);
    if (a) a.push(v);
    else this.values.set(name, [v]);
  }
  /** Узел с полем фильтра: значение записывается в карту. */
  f(label: string, start: number, len: number, name?: string, value?: FieldValue, children?: Field[]): Field {
    if (name && value !== undefined) this.set(name, value);
    const node: Field = { label, start, len };
    if (name) node.name = name;
    if (children?.length) node.children = children;
    return node;
  }
  proto(name: string) {
    this.set(name, true);
  }
}

/** Строка битового поля: «.... ..1. = Syn: Set». */
function bitLine(value: number, bits: number, mask: number, text: string): string {
  let s = '';
  for (let i = bits - 1; i >= 0; i--) {
    const m = 1 << i;
    s += mask & m ? (value & m ? '1' : '0') : '.';
    if (i % 4 === 0 && i) s += ' ';
  }
  return `${s} = ${text}`;
}

function ipFields(t: Tree, b: Uint8Array, o: number, h: Ipv4Header, inner = false): Field[] {
  const src = ipToString(h.src);
  const dst = ipToString(h.dst);
  const p = inner ? '' : 'ip';
  const nm = (n: string) => (p ? `${p}.${n}` : undefined);
  if (!inner) {
    t.set('ip.addr', src);
    t.set('ip.addr', dst);
  }
  const df = !!(h.flags & 0b010);
  const mf = !!(h.flags & 0b001);
  return [
    t.f(`${(h.version).toString(2).padStart(4, '0')} .... = Version: ${h.version}`, o, 1, nm('version'), h.version),
    t.f(`.... ${h.ihl.toString(2).padStart(4, '0')} = Header Length: ${h.headerLen} bytes (${h.ihl})`, o, 1, nm('hdr_len'), h.headerLen),
    t.f(`Differentiated Services Field: ${hex(b[o + 1], 2)} (DSCP: CS${h.dscp >> 3}, ECN: ${['Not-ECT', 'ECT(1)', 'ECT(0)', 'CE'][h.ecn]})`, o + 1, 1, nm('dsfield'), b[o + 1]),
    t.f(`Total Length: ${h.totalLength}`, o + 2, 2, nm('len'), h.totalLength),
    t.f(`Identification: ${hex(h.id, 4)} (${h.id})`, o + 4, 2, nm('id'), h.id),
    t.f(`Flags: ${hex(h.flags, 1)}${df ? ", Don't fragment" : ''}${mf ? ', More fragments' : ''}`, o + 6, 1, nm('flags'), h.flags, [
      t.f(bitLine(b[o + 6], 8, 0x80, 'Reserved bit: Not set'), o + 6, 1, nm('flags.rb'), (b[o + 6] >> 7) & 1),
      t.f(bitLine(b[o + 6], 8, 0x40, `Don't fragment: ${df ? 'Set' : 'Not set'}`), o + 6, 1, nm('flags.df'), df ? 1 : 0),
      t.f(bitLine(b[o + 6], 8, 0x20, `More fragments: ${mf ? 'Set' : 'Not set'}`), o + 6, 1, nm('flags.mf'), mf ? 1 : 0),
    ]),
    t.f(`Fragment Offset: ${h.fragOffset}`, o + 6, 2, nm('frag_offset'), h.fragOffset),
    t.f(`Time to Live: ${h.ttl}`, o + 8, 1, nm('ttl'), h.ttl),
    t.f(`Protocol: ${PROTO_NAMES[h.proto] ?? 'Unknown'} (${h.proto})`, o + 9, 1, nm('proto'), h.proto),
    t.f(`Header Checksum: ${hex(h.checksum, 4)} [${h.checksumOk ? 'correct' : 'incorrect'}]`, o + 10, 2, nm('checksum'), h.checksum),
    t.f(`Source Address: ${src}`, o + 12, 4, nm('src'), src),
    t.f(`Destination Address: ${dst}`, o + 16, 4, nm('dst'), dst),
  ];
}

function dnsName(q: DnsQuestion | DnsAnswer) {
  return q.name || '<Root>';
}

export function dissect(bytes: Uint8Array, meta: FrameMeta = {}): Dissection {
  const d = decodeFrame(bytes);
  const t = new Tree();
  const tree: Field[] = [];
  const protos: string[] = [];
  const L = bytes.length;

  // ---------- Frame ----------
  const frameKids: Field[] = [];
  if (meta.relTime !== undefined) frameKids.push(t.f(`[Time since reference or first frame: ${meta.relTime.toFixed(6)} seconds]`, 0, 0, 'frame.time_relative', meta.relTime));
  if (meta.number !== undefined) frameKids.push(t.f(`Frame Number: ${meta.number}`, 0, 0, 'frame.number', meta.number));
  frameKids.push(t.f(`Frame Length: ${L} bytes (${L * 8} bits)`, 0, 0, 'frame.len', L));
  frameKids.push(t.f(`Capture Length: ${L} bytes (${L * 8} bits)`, 0, 0, 'frame.cap_len', L));
  const protoLine = frameKids.push(t.f('', 0, 0)) - 1;
  t.proto('frame');
  tree.push(t.f(`Frame ${meta.number ?? ''}: ${L} bytes on wire (${L * 8} bits), ${L} bytes captured (${L * 8} bits)`.replace('Frame :', 'Frame:'), 0, L, 'frame', undefined, frameKids));

  const eth = d.eth;
  if (!eth) {
    frameKids[protoLine].label = '[Protocols in frame: (обрезанный кадр)]';
    return { decoded: d, tree, values: t.values, protocols: protos };
  }

  // ---------- Ethernet ----------
  const src = macToString(eth.src);
  const dst = macToString(eth.dst);
  t.proto('eth');
  protos.push('eth', 'ethertype');
  t.set('eth.addr', dst);
  t.set('eth.addr', src);
  const ig = (b: Uint8Array) => (b[0] & 1 ? 'Group address (multicast/broadcast)' : 'Individual address (unicast)');
  const lg = (b: Uint8Array) => (b[0] & 2 ? 'Locally administered address' : 'Globally unique address (factory default)');
  const ethKids: Field[] = [
    t.f(`Destination: ${dst}`, 0, 6, 'eth.dst', dst, [
      t.f(`.... ..${(eth.dst[0] >> 1) & 1}. .... .... .... .... = LG bit: ${lg(eth.dst)}`, 0, 3, 'eth.dst.lg', (eth.dst[0] >> 1) & 1),
      t.f(`.... ...${eth.dst[0] & 1} .... .... .... .... = IG bit: ${ig(eth.dst)}`, 0, 3, 'eth.dst.ig', eth.dst[0] & 1),
    ]),
    t.f(`Source: ${src}`, 6, 6, 'eth.src', src),
  ];
  let typeOff = 12;
  if (eth.vlan) {
    ethKids.push(t.f('Type: 802.1Q Virtual LAN (0x8100)', 12, 2, 'eth.type', ETH_VLAN));
    typeOff = 16;
  } else ethKids.push(t.f(`Type: ${ETH_TYPES[eth.etherType] ?? 'Unknown'} (${hex(eth.etherType, 4)})`, 12, 2, 'eth.type', eth.etherType));
  tree.push(t.f(`Ethernet II, Src: ${src}, Dst: ${dst === 'ff:ff:ff:ff:ff:ff' ? 'Broadcast (ff:ff:ff:ff:ff:ff)' : dst}`, 0, eth.headerLen, 'eth', undefined, ethKids));

  if (eth.vlan) {
    t.proto('vlan');
    protos.push('vlan', 'ethertype');
    const tci = u16(bytes, 14);
    tree.push(
      t.f(`802.1Q Virtual LAN, PRI: ${eth.vlan.pcp}, DEI: ${eth.vlan.dei}, ID: ${eth.vlan.id}`, 14, 4, 'vlan', undefined, [
        t.f(`${bitLine(tci, 16, 0xe000, `Priority: ${eth.vlan.pcp}`)}`, 14, 2, 'vlan.priority', eth.vlan.pcp),
        t.f(`${bitLine(tci, 16, 0x1000, `DEI: ${eth.vlan.dei}`)}`, 14, 2, 'vlan.dei', eth.vlan.dei),
        t.f(`${bitLine(tci, 16, 0x0fff, `ID: ${eth.vlan.id}`)}`, 14, 2, 'vlan.id', eth.vlan.id),
        t.f(`Type: ${ETH_TYPES[eth.etherType] ?? 'Unknown'} (${hex(eth.etherType, 4)})`, typeOff, 2, 'vlan.etype', eth.etherType),
      ]),
    );
  }

  let used = eth.headerLen;

  // ---------- ARP ----------
  if (d.arp) {
    const { off: o, h } = d.arp;
    t.proto('arp');
    protos.push('arp');
    const op = h.op === 1 ? 'request' : h.op === 2 ? 'reply' : `${h.op}`;
    tree.push(
      t.f(`Address Resolution Protocol (${op})`, o, 28, 'arp', undefined, [
        t.f(`Hardware type: Ethernet (${h.htype})`, o, 2, 'arp.hw.type', h.htype),
        t.f(`Protocol type: IPv4 (${hex(h.ptype, 4)})`, o + 2, 2, 'arp.proto.type', h.ptype),
        t.f(`Hardware size: ${h.hlen}`, o + 4, 1, 'arp.hw.size', h.hlen),
        t.f(`Protocol size: ${h.plen}`, o + 5, 1, 'arp.proto.size', h.plen),
        t.f(`Opcode: ${op} (${h.op})`, o + 6, 2, 'arp.opcode', h.op),
        t.f(`Sender MAC address: ${macToString(h.sha)}`, o + 8, 6, 'arp.src.hw_mac', macToString(h.sha)),
        t.f(`Sender IP address: ${ipToString(h.spa)}`, o + 14, 4, 'arp.src.proto_ipv4', ipToString(h.spa)),
        t.f(`Target MAC address: ${macToString(h.tha)}`, o + 18, 6, 'arp.dst.hw_mac', macToString(h.tha)),
        t.f(`Target IP address: ${ipToString(h.tpa)}`, o + 24, 4, 'arp.dst.proto_ipv4', ipToString(h.tpa)),
      ]),
    );
    used = o + 28;
  }

  // ---------- IPv4 ----------
  if (d.ip) {
    const { off: o, h, end } = d.ip;
    t.proto('ip');
    protos.push('ip');
    tree.push(t.f(`Internet Protocol Version 4, Src: ${ipToString(h.src)}, Dst: ${ipToString(h.dst)}`, o, h.headerLen, 'ip', undefined, ipFields(t, bytes, o, h)));
    used = end;
  }

  // ---------- ICMP ----------
  if (d.icmp && d.ip) {
    const { off: o, h } = d.icmp;
    const end = d.ip.end;
    t.proto('icmp');
    protos.push('icmp');
    const kids: Field[] = [
      t.f(`Type: ${h.type} (${ICMP_TYPES[h.type] ?? 'Unknown'})`, o, 1, 'icmp.type', h.type),
      t.f(`Code: ${h.code}${h.type === 3 ? ` (${UNREACH[h.code] ?? ''})` : h.type === 11 ? ' (Time to live exceeded in transit)' : ''}`, o + 1, 1, 'icmp.code', h.code),
      t.f(`Checksum: ${hex(h.checksum, 4)} [${h.checksumOk ? 'correct' : 'incorrect'}]`, o + 2, 2, 'icmp.checksum', h.checksum),
    ];
    if (h.type === 0 || h.type === 8) {
      const le = ((h.id & 0xff) << 8) | (h.id >> 8);
      const sle = ((h.seq & 0xff) << 8) | (h.seq >> 8);
      kids.push(
        t.f(`Identifier (BE): ${h.id} (${hex(h.id, 4)})`, o + 4, 2, 'icmp.ident', h.id),
        t.f(`Identifier (LE): ${le} (${hex(le, 4)})`, o + 4, 2),
        t.f(`Sequence Number (BE): ${h.seq} (${hex(h.seq, 4)})`, o + 6, 2, 'icmp.seq', h.seq),
        t.f(`Sequence Number (LE): ${sle} (${hex(sle, 4)})`, o + 6, 2, 'icmp.seq_le', sle),
      );
      if (h.dataLen > 0) {
        // Как в Wireshark: данные эха — отдельный протокол «data» (eth:ethertype:ip:icmp:data).
        t.proto('data');
        protos.push('data');
        kids.push(t.f(`Data (${h.dataLen} bytes)`, o + 8, h.dataLen, 'data.len', h.dataLen, [t.f(`Data: ${bytesToHex(bytes.subarray(o + 8, end))}`, o + 8, h.dataLen, 'data.data', bytesToHex(bytes.subarray(o + 8, end)))]));
      }
    } else {
      kids.push(t.f('Unused: 00000000', o + 4, 4));
      const ih = decodeIpv4(bytes, o + 8);
      if (ih) {
        // Процитированная датаграмма: eth:ethertype:ip:icmp:ip:icmp (или :ip:udp, :ip:tcp).
        protos.push('ip');
        const inner = PROTO_NAMES[ih.proto];
        if (inner && end - (o + 8 + ih.headerLen) >= 8) protos.push(inner.toLowerCase());
        kids.push(t.f(`Internet Protocol Version 4, Src: ${ipToString(ih.src)}, Dst: ${ipToString(ih.dst)}`, o + 8, ih.headerLen, undefined, undefined, ipFields(t, bytes, o + 8, ih, true)));
        const rest = end - (o + 8 + ih.headerLen);
        if (rest > 0) kids.push(t.f(`Original datagram data (${rest} bytes)`, o + 8 + ih.headerLen, rest));
      }
    }
    tree.push(t.f('Internet Control Message Protocol', o, end - o, 'icmp', undefined, kids));
  }

  // ---------- UDP ----------
  if (d.udp && d.ip) {
    const { off: o, h } = d.udp;
    t.proto('udp');
    protos.push('udp');
    t.set('udp.port', h.srcPort);
    t.set('udp.port', h.dstPort);
    tree.push(
      t.f(`User Datagram Protocol, Src Port: ${h.srcPort}, Dst Port: ${h.dstPort}`, o, 8, 'udp', undefined, [
        t.f(`Source Port: ${h.srcPort}`, o, 2, 'udp.srcport', h.srcPort),
        t.f(`Destination Port: ${h.dstPort}`, o + 2, 2, 'udp.dstport', h.dstPort),
        t.f(`Length: ${h.length}`, o + 4, 2, 'udp.length', h.length),
        t.f(`Checksum: ${hex(h.checksum, 4)} [${h.checksum === 0 ? 'zero' : h.checksumOk ? 'correct' : 'incorrect'}]`, o + 6, 2, 'udp.checksum', h.checksum),
      ]),
    );
  }

  // ---------- TCP ----------
  if (d.tcp && d.ip) {
    const { off: o, h } = d.tcp;
    t.proto('tcp');
    protos.push('tcp');
    t.set('tcp.port', h.srcPort);
    t.set('tcp.port', h.dstPort);
    const names = (['FIN', 'SYN', 'RST', 'PSH', 'ACK'] as const).filter((f) => h.flags & TCP_FLAG_BITS[f]);
    const flagRow = (bit: number, name: string, key: string) => {
      const set = !!(h.flags & bit);
      return t.f(bitLine(h.flags, 12, bit, `${name}: ${set ? 'Set' : 'Not set'}`), o + 12, 2, `tcp.flags.${key}`, set ? 1 : 0);
    };
    const kids: Field[] = [
      t.f(`Source Port: ${h.srcPort}`, o, 2, 'tcp.srcport', h.srcPort),
      t.f(`Destination Port: ${h.dstPort}`, o + 2, 2, 'tcp.dstport', h.dstPort),
    ];
    if (meta.tcpStream !== undefined) kids.push(t.f(`[Stream index: ${meta.tcpStream}]`, o, 0, 'tcp.stream', meta.tcpStream));
    kids.push(
      t.f(`[TCP Segment Len: ${h.payloadLen}]`, o, 0, 'tcp.len', h.payloadLen),
      t.f(`Sequence Number (raw): ${h.seq}`, o + 4, 4, 'tcp.seq', h.seq),
      t.f(`Acknowledgment Number (raw): ${h.ack}`, o + 8, 4, 'tcp.ack', h.ack),
      t.f(`${(h.headerLen / 4).toString(2).padStart(4, '0')} .... = Header Length: ${h.headerLen} bytes (${h.headerLen / 4})`, o + 12, 1, 'tcp.hdr_len', h.headerLen),
      t.f(`Flags: ${hex(h.flags, 3)} (${names.join(', ')})`, o + 12, 2, 'tcp.flags', h.flags, [
        flagRow(0x10, 'Acknowledgment', 'ack'),
        flagRow(0x08, 'Push', 'push'),
        flagRow(0x04, 'Reset', 'reset'),
        flagRow(0x02, 'Syn', 'syn'),
        flagRow(0x01, 'Fin', 'fin'),
      ]),
      t.f(`Window: ${h.window}`, o + 14, 2, 'tcp.window_size', h.window),
      t.f(`Checksum: ${hex(h.checksum, 4)} [${h.checksumOk ? 'correct' : 'incorrect'}]`, o + 16, 2, 'tcp.checksum', h.checksum),
      t.f(`Urgent Pointer: ${h.urgent}`, o + 18, 2, 'tcp.urgent_pointer', h.urgent),
    );
    // Синонимы, как в Wireshark: tcp.flags.push/reset ↔ psh/rst.
    t.set('tcp.flags.psh', h.flags & 0x08 ? 1 : 0);
    t.set('tcp.flags.rst', h.flags & 0x04 ? 1 : 0);
    if (h.options.length) {
      const optKids = h.options.map((op) =>
        op.kind === 2
          ? t.f(`TCP Option - Maximum segment size: ${op.value} bytes`, op.offset, op.len, 'tcp.options.mss_val', op.value!, [
              t.f('Kind: Maximum Segment Size (2)', op.offset, 1),
              t.f(`Length: ${op.len}`, op.offset + 1, 1),
              t.f(`MSS Value: ${op.value}`, op.offset + 2, 2),
            ])
          : t.f(op.kind === 1 ? 'TCP Option - No-Operation (NOP)' : op.kind === 0 ? 'TCP Option - End of Option List (EOL)' : `TCP Option - Kind ${op.kind}`, op.offset, op.len),
      );
      kids.push(t.f(`Options: (${h.headerLen - 20} bytes)`, o + 20, h.headerLen - 20, undefined, undefined, optKids));
    }
    if (h.payloadLen > 0) kids.push(t.f(`TCP payload (${h.payloadLen} bytes)`, h.payloadStart, h.payloadLen, 'tcp.payload', true));
    tree.push(
      t.f(
        `Transmission Control Protocol, Src Port: ${h.srcPort}, Dst Port: ${h.dstPort}, Seq: ${h.seq}${h.flags & 0x10 ? `, Ack: ${h.ack}` : ''}, Len: ${h.payloadLen}`,
        o,
        h.headerLen,
        'tcp',
        undefined,
        kids,
      ),
    );
  }

  // ---------- DHCP ----------
  if (d.dhcp) {
    const { off: o, end, h } = d.dhcp;
    t.proto('dhcp');
    t.proto('bootp');
    protos.push('dhcp');
    const msg = h.msgType !== undefined ? DHCP_MSG_NAMES[h.msgType] ?? `${h.msgType}` : undefined;
    const ip = (b: Uint8Array) => ipToString(b);
    const optLabel = (code: number, data: Uint8Array) => {
      switch (code) {
        case DHCP_OPT.msgType:
          return `Option: (53) DHCP Message Type (${DHCP_MSG_NAMES[data[0]] ?? data[0]})`;
        case DHCP_OPT.mask:
          return `Option: (1) Subnet Mask (${ip(data)})`;
        case DHCP_OPT.router:
          return `Option: (3) Router (${ip(data)})`;
        case DHCP_OPT.dns:
          return `Option: (6) Domain Name Server (${ip(data)})`;
        case DHCP_OPT.requestedIp:
          return `Option: (50) Requested IP Address (${ip(data)})`;
        case DHCP_OPT.lease: {
          const s = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
          return `Option: (51) IP Address Lease Time (${s}s)`;
        }
        case DHCP_OPT.serverId:
          return `Option: (54) DHCP Server Identifier (${ip(data)})`;
        case DHCP_OPT.paramList:
          return `Option: (55) Parameter Request List`;
        case DHCP_OPT.end:
          return 'Option: (255) End';
        default:
          return `Option: (${code})`;
      }
    };
    const kids: Field[] = [
      t.f(`Message type: ${h.op === 1 ? 'Boot Request' : 'Boot Reply'} (${h.op})`, o, 1, 'dhcp.type', h.op),
      t.f(`Hardware type: Ethernet (${hex(h.htype, 2)})`, o + 1, 1, 'dhcp.hw.type', h.htype),
      t.f(`Hardware address length: ${h.hlen}`, o + 2, 1, 'dhcp.hw.len', h.hlen),
      t.f(`Hops: ${h.hops}`, o + 3, 1, 'dhcp.hops', h.hops),
      t.f(`Transaction ID: ${hex(h.xid, 8)}`, o + 4, 4, 'dhcp.id', h.xid),
      t.f(`Seconds elapsed: ${h.secs}`, o + 8, 2, 'dhcp.secs', h.secs),
      t.f(`Bootp flags: ${hex(h.flags, 4)} (${h.flags & 0x8000 ? 'Broadcast' : 'Unicast'})`, o + 10, 2, 'dhcp.flags', h.flags),
      t.f(`Client IP address: ${ip(h.ciaddr)}`, o + 12, 4, 'dhcp.ip.client', ip(h.ciaddr)),
      t.f(`Your (client) IP address: ${ip(h.yiaddr)}`, o + 16, 4, 'dhcp.ip.your', ip(h.yiaddr)),
      t.f(`Next server IP address: ${ip(h.siaddr)}`, o + 20, 4, 'dhcp.ip.server', ip(h.siaddr)),
      t.f(`Relay agent IP address: ${ip(h.giaddr)}`, o + 24, 4, 'dhcp.ip.relay', ip(h.giaddr)),
      t.f(`Client MAC address: ${macToString(h.chaddr)}`, o + 28, 6, 'dhcp.hw.mac_addr', macToString(h.chaddr)),
      t.f('Client hardware address padding: 00000000000000000000', o + 34, 10),
      t.f('Server host name not given', o + 44, 64),
      t.f('Boot file name not given', o + 108, 128),
      t.f(`Magic cookie: ${h.magic === 0x63825363 ? 'DHCP' : hex(h.magic, 8)}`, o + 236, 4, 'dhcp.cookie', h.magic),
      ...h.options.map((op) =>
        t.f(
          optLabel(op.code, op.data),
          op.offset,
          op.code === DHCP_OPT.end ? 1 : 2 + op.len,
          op.code === DHCP_OPT.msgType ? 'dhcp.option.dhcp' : `dhcp.option.type`,
          op.code === DHCP_OPT.msgType ? op.data[0] : op.code,
          op.code === DHCP_OPT.end ? undefined : [t.f(`Length: ${op.len}`, op.offset + 1, 1)],
        ),
      ),
    ];
    const last = h.options.at(-1);
    const padFrom = last ? last.offset + (last.code === DHCP_OPT.end ? 1 : 2 + last.len) : o + 240;
    if (padFrom < end) kids.push(t.f(`Padding: ${end - padFrom} bytes`, padFrom, end - padFrom));
    tree.push(t.f(`Dynamic Host Configuration Protocol${msg ? ` (${msg})` : ''}`, o, end - o, 'dhcp', undefined, kids));
  }

  // ---------- DNS ----------
  if (d.dns) {
    const { off: o, end, h } = d.dns;
    t.proto('dns');
    protos.push('dns');
    const typeName = (x: number) => (x === 1 ? 'A' : `${x}`);
    const fl = h.flags;
    const flagKids = [
      t.f(bitLine(fl, 16, 0x8000, `Response: Message is a ${h.qr ? 'response' : 'query'}`), o + 2, 2, 'dns.flags.response', h.qr ? 1 : 0),
      t.f(bitLine(fl, 16, 0x7800, `Opcode: Standard query (${h.opcode})`), o + 2, 2, 'dns.flags.opcode', h.opcode),
      t.f(bitLine(fl, 16, 0x0100, `Recursion desired: ${h.rd ? 'Do' : "Don't"} query recursively`), o + 2, 2, 'dns.flags.recdesired', h.rd ? 1 : 0),
    ];
    if (h.qr) {
      flagKids.push(
        t.f(bitLine(fl, 16, 0x0080, `Recursion available: Server ${h.ra ? 'can' : "can't"} do recursive queries`), o + 2, 2, 'dns.flags.recavail', h.ra ? 1 : 0),
        t.f(bitLine(fl, 16, 0x000f, `Reply code: ${h.rcode === 3 ? 'No such name' : 'No error'} (${h.rcode})`), o + 2, 2, 'dns.flags.rcode', h.rcode),
      );
    }
    const qKids = h.questions.map((q) => {
      return t.f(`${dnsName(q)}: type ${typeName(q.type)}, class IN`, q.offset, q.len, undefined, undefined, [
        t.f(`Name: ${dnsName(q)}`, q.offset, q.len - 4, 'dns.qry.name', q.name),
        t.f(`Type: ${typeName(q.type)} (${q.type})`, q.offset + q.len - 4, 2, 'dns.qry.type', q.type),
        t.f(`Class: IN (${hex(q.cls, 4)})`, q.offset + q.len - 2, 2, 'dns.qry.class', q.cls),
      ]);
    });
    const aKids = h.answers.map((a) => {
      const p = a.offset + a.len - 10 - a.rdlength;
      const addr = a.type === 1 && a.rdlength === 4 ? ipToString(a.rdata) : undefined;
      if (addr) t.set('dns.a', addr);
      return t.f(`${dnsName(a)}: type ${typeName(a.type)}, class IN${addr ? `, addr ${addr}` : ''}`, a.offset, a.len, undefined, undefined, [
        t.f(`Name: ${dnsName(a)}`, a.offset, p - a.offset, 'dns.resp.name', a.name),
        t.f(`Type: ${typeName(a.type)} (${a.type})`, p, 2, 'dns.resp.type', a.type),
        t.f(`Class: IN (${hex(a.cls, 4)})`, p + 2, 2),
        t.f(`Time to live: ${a.ttl} (${Math.round(a.ttl / 3600)} hours)`, p + 4, 4, 'dns.resp.ttl', a.ttl),
        t.f(`Data length: ${a.rdlength}`, p + 8, 2, 'dns.resp.len', a.rdlength),
        ...(addr ? [t.f(`Address: ${addr}`, p + 10, 4)] : []),
      ]);
    });
    const kids: Field[] = [
      t.f(`Transaction ID: ${hex(h.id, 4)}`, o, 2, 'dns.id', h.id),
      t.f(`Flags: ${hex(fl, 4)} Standard query${h.qr ? ` response, ${h.rcode === 3 ? 'No such name' : 'No error'}` : ''}`, o + 2, 2, 'dns.flags', fl, flagKids),
      t.f(`Questions: ${h.qdcount}`, o + 4, 2, 'dns.count.queries', h.qdcount),
      t.f(`Answer RRs: ${h.ancount}`, o + 6, 2, 'dns.count.answers', h.ancount),
      t.f(`Authority RRs: ${h.nscount}`, o + 8, 2, 'dns.count.auth_rr', h.nscount),
      t.f(`Additional RRs: ${h.arcount}`, o + 10, 2, 'dns.count.add_rr', h.arcount),
    ];
    if (qKids.length) kids.push(t.f('Queries', qKids[0].start, qKids.reduce((s, q) => s + q.len, 0), undefined, undefined, qKids));
    if (aKids.length) kids.push(t.f('Answers', aKids[0].start, aKids.reduce((s, q) => s + q.len, 0), undefined, undefined, aKids));
    tree.push(t.f(`Domain Name System (${h.qr ? 'response' : 'query'})`, o, end - o, 'dns', undefined, kids));
  }

  // ---------- HTTP ----------
  if (d.http) {
    const { off: o, end, h } = d.http;
    t.proto('http');
    protos.push('http');
    const sl = new TextEncoder().encode(h.startLine).length;
    const kids: Field[] = [];
    const reqm = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(h.startLine);
    const respm = /^(HTTP\/1\.[01]) (\d{3}) ?(.*)$/.exec(h.startLine);
    if (reqm) {
      t.set('http.request', true);
      kids.push(
        t.f(`${h.startLine}\\r\\n`, o, sl + 2, undefined, undefined, [
          t.f(`Request Method: ${reqm[1]}`, o, reqm[1].length, 'http.request.method', reqm[1]),
          t.f(`Request URI: ${reqm[2]}`, o + reqm[1].length + 1, reqm[2].length, 'http.request.uri', reqm[2]),
          t.f(`Request Version: ${reqm[3]}`, o + sl - reqm[3].length, reqm[3].length, 'http.request.version', reqm[3]),
        ]),
      );
    } else if (respm) {
      t.set('http.response', true);
      const code = Number(respm[2]);
      kids.push(
        t.f(`${h.startLine}\\r\\n`, o, sl + 2, undefined, undefined, [
          t.f(`Response Version: ${respm[1]}`, o, respm[1].length, 'http.response.version', respm[1]),
          t.f(`Status Code: ${code}`, o + respm[1].length + 1, 3, 'http.response.code', code),
          t.f(`Response Phrase: ${respm[3]}`, o + respm[1].length + 5, respm[3].length, 'http.response.phrase', respm[3]),
        ]),
      );
    }
    const HDR: Record<string, string> = { host: 'http.host', 'user-agent': 'http.user_agent', 'content-type': 'http.content_type', 'content-length': 'http.content_length', connection: 'http.connection', server: 'http.server', accept: 'http.accept' };
    for (const hd of h.headers) {
      const key = HDR[hd.name.toLowerCase()];
      const v = key === 'http.content_length' ? Number(hd.value) : hd.value;
      kids.push(t.f(`${hd.name}: ${hd.value}\\r\\n`, o + hd.start, hd.len + 2, key, key ? v : undefined));
    }
    if (h.headerEnd >= 0) kids.push(t.f('\\r\\n', o + h.headerEnd, 2));
    const bodyLen = end - (o + h.bodyStart);
    if (bodyLen > 0) {
      kids.push(t.f(`File Data: ${bodyLen} bytes`, o + h.bodyStart, bodyLen, 'http.file_data', new TextDecoder().decode(bytes.subarray(o + h.bodyStart, end))));
    }
    tree.push(t.f('Hypertext Transfer Protocol', o, end - o, 'http', undefined, kids));
    if (bodyLen > 0 && h.headers.some((x) => x.name.toLowerCase() === 'content-type' && x.value.startsWith('text/html'))) {
      protos.push('data-text-lines');
      tree.push(t.f('Line-based text data: text/html (1 lines)', o + h.bodyStart, bodyLen, undefined, undefined, [t.f(new TextDecoder().decode(bytes.subarray(o + h.bodyStart, end)).slice(0, 200), o + h.bodyStart, bodyLen)]));
    }
  } else if (d.data) {
    const { off: o, end } = d.data;
    t.proto('data');
    protos.push('data');
    tree.push(t.f(`Data (${end - o} bytes)`, o, end - o, 'data', undefined, [t.f(`Data: ${bytesToHex(bytes.subarray(o, Math.min(end, o + 64)))}${end - o > 64 ? '…' : ''}`, o, end - o, 'data.data', bytesToHex(bytes.subarray(o, end)))]));
  }

  // Паддинг Ethernet до 60 байт.
  if (used < L && (d.arp || d.ip)) {
    tree[1].children!.push(t.f(`Padding: ${bytesToHex(bytes.subarray(used, L))}`, used, L - used, 'eth.padding'));
  }

  frameKids[protoLine].label = `[Protocols in frame: ${protos.join(':')}]`;
  return { decoded: d, tree, values: t.values, protocols: protos };
}

/**
 * Самое глубокое поле, накрывающее байт (для клика по hex-дампу): путь от верхнего уровня.
 * Frame накрывает весь кадр, поэтому среди соседей выбирается самый глубокий путь.
 */
export function fieldAt(tree: Field[], byte: number): Field[] | null {
  let best: Field[] | null = null;
  for (const f of tree) {
    if (!(f.len > 0 && byte >= f.start && byte < f.start + f.len)) continue;
    const deeper = f.children ? fieldAt(f.children, byte) : null;
    const path = deeper ? [f, ...deeper] : [f];
    if (!best || path.length > best.length) best = path;
  }
  return best;
}
