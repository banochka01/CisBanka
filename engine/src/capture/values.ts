// Значения полей для фильтров без построения дерева подписей — в ~10 раз быстрее dissect().
// Должны совпадать с dissect(...).values (проверяется тестом на всех эталонных кадрах).
import { bytesToHex, ipToString, macToString } from '../wire/bytes';
import type { Decoded } from '../wire/decode';
import type { FieldValue, FrameMeta } from './dissect';

export function fieldValues(d: Decoded, meta: FrameMeta = {}): Map<string, FieldValue[]> {
  const m = new Map<string, FieldValue[]>();
  const set = (k: string, v: FieldValue) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  const b = d.bytes;
  const L = b.length;
  set('frame', true);
  if (meta.relTime !== undefined) set('frame.time_relative', meta.relTime);
  if (meta.number !== undefined) set('frame.number', meta.number);
  set('frame.len', L);
  set('frame.cap_len', L);
  const eth = d.eth;
  if (!eth) return m;

  const src = macToString(eth.src);
  const dst = macToString(eth.dst);
  set('eth', true);
  set('eth.addr', dst);
  set('eth.addr', src);
  set('eth.dst', dst);
  set('eth.dst.lg', (eth.dst[0] >> 1) & 1);
  set('eth.dst.ig', eth.dst[0] & 1);
  set('eth.src', src);
  set('eth.type', eth.vlan ? 0x8100 : eth.etherType);
  if (eth.vlan) {
    set('vlan', true);
    set('vlan.priority', eth.vlan.pcp);
    set('vlan.dei', eth.vlan.dei);
    set('vlan.id', eth.vlan.id);
    set('vlan.etype', eth.etherType);
  }

  if (d.arp) {
    const h = d.arp.h;
    set('arp', true);
    set('arp.hw.type', h.htype);
    set('arp.proto.type', h.ptype);
    set('arp.hw.size', h.hlen);
    set('arp.proto.size', h.plen);
    set('arp.opcode', h.op);
    set('arp.src.hw_mac', macToString(h.sha));
    set('arp.src.proto_ipv4', ipToString(h.spa));
    set('arp.dst.hw_mac', macToString(h.tha));
    set('arp.dst.proto_ipv4', ipToString(h.tpa));
  }

  const ipVals = (o: number, h: NonNullable<Decoded['ip']>['h'], prefix: boolean) => {
    if (!prefix) return;
    const s = ipToString(h.src);
    const t = ipToString(h.dst);
    set('ip.addr', s);
    set('ip.addr', t);
    set('ip.version', h.version);
    set('ip.hdr_len', h.headerLen);
    set('ip.dsfield', b[o + 1]);
    set('ip.len', h.totalLength);
    set('ip.id', h.id);
    set('ip.flags', h.flags);
    set('ip.flags.rb', (b[o + 6] >> 7) & 1);
    set('ip.flags.df', h.flags & 0b010 ? 1 : 0);
    set('ip.flags.mf', h.flags & 0b001 ? 1 : 0);
    set('ip.frag_offset', h.fragOffset);
    set('ip.ttl', h.ttl);
    set('ip.proto', h.proto);
    set('ip.checksum', h.checksum);
    set('ip.src', s);
    set('ip.dst', t);
  };
  if (d.ip) {
    set('ip', true);
    ipVals(d.ip.off, d.ip.h, true);
  }

  if (d.icmp && d.ip) {
    const { off: o, h } = d.icmp;
    set('icmp', true);
    set('icmp.type', h.type);
    set('icmp.code', h.code);
    set('icmp.checksum', h.checksum);
    if (h.type === 0 || h.type === 8) {
      set('icmp.ident', h.id);
      set('icmp.seq', h.seq);
      set('icmp.seq_le', ((h.seq & 0xff) << 8) | (h.seq >> 8));
      if (h.dataLen > 0) {
        set('data', true);
        set('data.len', h.dataLen);
        set('data.data', bytesToHex(b.subarray(o + 8, d.ip.end)));
      }
    }
  }

  if (d.udp && d.ip) {
    const h = d.udp.h;
    set('udp', true);
    set('udp.port', h.srcPort);
    set('udp.port', h.dstPort);
    set('udp.srcport', h.srcPort);
    set('udp.dstport', h.dstPort);
    set('udp.length', h.length);
    set('udp.checksum', h.checksum);
  }

  if (d.tcp && d.ip) {
    const h = d.tcp.h;
    set('tcp', true);
    set('tcp.port', h.srcPort);
    set('tcp.port', h.dstPort);
    set('tcp.srcport', h.srcPort);
    set('tcp.dstport', h.dstPort);
    if (meta.tcpStream !== undefined) set('tcp.stream', meta.tcpStream);
    set('tcp.len', h.payloadLen);
    set('tcp.seq', h.seq);
    set('tcp.ack', h.ack);
    set('tcp.hdr_len', h.headerLen);
    set('tcp.flags', h.flags);
    set('tcp.flags.ack', h.flags & 0x10 ? 1 : 0);
    set('tcp.flags.push', h.flags & 0x08 ? 1 : 0);
    set('tcp.flags.reset', h.flags & 0x04 ? 1 : 0);
    set('tcp.flags.syn', h.flags & 0x02 ? 1 : 0);
    set('tcp.flags.fin', h.flags & 0x01 ? 1 : 0);
    set('tcp.window_size', h.window);
    set('tcp.checksum', h.checksum);
    set('tcp.urgent_pointer', h.urgent);
    set('tcp.flags.psh', h.flags & 0x08 ? 1 : 0);
    set('tcp.flags.rst', h.flags & 0x04 ? 1 : 0);
    for (const op of h.options) if (op.kind === 2 && op.value !== undefined) set('tcp.options.mss_val', op.value);
    if (h.payloadLen > 0) set('tcp.payload', true);
  }

  if (d.dhcp) {
    const h = d.dhcp.h;
    set('dhcp', true);
    set('bootp', true);
    set('dhcp.type', h.op);
    set('dhcp.hw.type', h.htype);
    set('dhcp.hw.len', h.hlen);
    set('dhcp.hops', h.hops);
    set('dhcp.id', h.xid);
    set('dhcp.secs', h.secs);
    set('dhcp.flags', h.flags);
    set('dhcp.ip.client', ipToString(h.ciaddr));
    set('dhcp.ip.your', ipToString(h.yiaddr));
    set('dhcp.ip.server', ipToString(h.siaddr));
    set('dhcp.ip.relay', ipToString(h.giaddr));
    set('dhcp.hw.mac_addr', macToString(h.chaddr));
    set('dhcp.cookie', h.magic);
    for (const op of h.options) {
      if (op.code === 53) set('dhcp.option.dhcp', op.data[0]);
      else set('dhcp.option.type', op.code);
    }
  }

  if (d.dns) {
    const h = d.dns.h;
    set('dns', true);
    set('dns.id', h.id);
    set('dns.flags', h.flags);
    set('dns.flags.response', h.qr ? 1 : 0);
    set('dns.flags.opcode', h.opcode);
    set('dns.flags.recdesired', h.rd ? 1 : 0);
    if (h.qr) {
      set('dns.flags.recavail', h.ra ? 1 : 0);
      set('dns.flags.rcode', h.rcode);
    }
    set('dns.count.queries', h.qdcount);
    set('dns.count.answers', h.ancount);
    set('dns.count.auth_rr', h.nscount);
    set('dns.count.add_rr', h.arcount);
    for (const q of h.questions) {
      set('dns.qry.name', q.name);
      set('dns.qry.type', q.type);
      set('dns.qry.class', q.cls);
    }
    for (const a of h.answers) {
      if (a.type === 1 && a.rdlength === 4) set('dns.a', ipToString(a.rdata));
      set('dns.resp.name', a.name);
      set('dns.resp.type', a.type);
      set('dns.resp.ttl', a.ttl);
      set('dns.resp.len', a.rdlength);
    }
  }

  if (d.http) {
    const { off: o, end, h } = d.http;
    set('http', true);
    const reqm = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(h.startLine);
    const respm = /^(HTTP\/1\.[01]) (\d{3}) ?(.*)$/.exec(h.startLine);
    if (reqm) {
      set('http.request', true);
      set('http.request.method', reqm[1]);
      set('http.request.uri', reqm[2]);
      set('http.request.version', reqm[3]);
    } else if (respm) {
      set('http.response', true);
      set('http.response.version', respm[1]);
      set('http.response.code', Number(respm[2]));
      set('http.response.phrase', respm[3]);
    }
    const HDR: Record<string, string> = { host: 'http.host', 'user-agent': 'http.user_agent', 'content-type': 'http.content_type', 'content-length': 'http.content_length', connection: 'http.connection', server: 'http.server', accept: 'http.accept' };
    for (const hd of h.headers) {
      const key = HDR[hd.name.toLowerCase()];
      if (key) set(key, key === 'http.content_length' ? Number(hd.value) : hd.value);
    }
    if (end - (o + h.bodyStart) > 0) set('http.file_data', new TextDecoder().decode(b.subarray(o + h.bodyStart, end)));
  } else if (d.data) {
    set('data', true);
    set('data.data', bytesToHex(b.subarray(d.data.off, d.data.end)));
  }
  return m;
}
