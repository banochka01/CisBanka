// Display-фильтры в синтаксисе Wireshark: ip.addr==10.0.0.1 && !(tcp.port==80) || arp.
// Поддержано: поля-протоколы (tcp, arp…), сравнения == != > < >= <= (и eq ne gt lt ge le),
// contains, логика && || ! (and or not), скобки, адреса IPv4 с маской /24, MAC в любом виде.
// Семантика как у Wireshark 3.6+: для поля с несколькими значениями (ip.addr — это и src, и dst)
// «==» истинно, если совпало любое, «!=» — если не совпало ни одно.
import type { FieldValue } from './dissect';

type FieldType = 'proto' | 'uint' | 'ipv4' | 'ether' | 'string';

/** Известные поля и их типы. */
export const FILTER_FIELDS: Record<string, FieldType> = {
  frame: 'proto', 'frame.number': 'uint', 'frame.len': 'uint', 'frame.cap_len': 'uint', 'frame.time_relative': 'uint',
  eth: 'proto', 'eth.addr': 'ether', 'eth.src': 'ether', 'eth.dst': 'ether', 'eth.type': 'uint', 'eth.dst.ig': 'uint', 'eth.dst.lg': 'uint',
  vlan: 'proto', 'vlan.id': 'uint', 'vlan.priority': 'uint', 'vlan.dei': 'uint', 'vlan.etype': 'uint',
  arp: 'proto', 'arp.opcode': 'uint', 'arp.src.hw_mac': 'ether', 'arp.dst.hw_mac': 'ether', 'arp.src.proto_ipv4': 'ipv4', 'arp.dst.proto_ipv4': 'ipv4',
  'arp.hw.type': 'uint', 'arp.proto.type': 'uint', 'arp.hw.size': 'uint', 'arp.proto.size': 'uint',
  ip: 'proto', 'ip.addr': 'ipv4', 'ip.src': 'ipv4', 'ip.dst': 'ipv4', 'ip.ttl': 'uint', 'ip.proto': 'uint', 'ip.id': 'uint', 'ip.len': 'uint',
  'ip.version': 'uint', 'ip.hdr_len': 'uint', 'ip.dsfield': 'uint', 'ip.flags': 'uint', 'ip.flags.df': 'uint', 'ip.flags.mf': 'uint', 'ip.flags.rb': 'uint',
  'ip.frag_offset': 'uint', 'ip.checksum': 'uint',
  icmp: 'proto', 'icmp.type': 'uint', 'icmp.code': 'uint', 'icmp.checksum': 'uint', 'icmp.ident': 'uint', 'icmp.seq': 'uint', 'icmp.seq_le': 'uint',
  udp: 'proto', 'udp.port': 'uint', 'udp.srcport': 'uint', 'udp.dstport': 'uint', 'udp.length': 'uint', 'udp.checksum': 'uint',
  tcp: 'proto', 'tcp.port': 'uint', 'tcp.srcport': 'uint', 'tcp.dstport': 'uint', 'tcp.stream': 'uint', 'tcp.len': 'uint', 'tcp.seq': 'uint', 'tcp.ack': 'uint',
  'tcp.hdr_len': 'uint', 'tcp.flags': 'uint', 'tcp.flags.syn': 'uint', 'tcp.flags.ack': 'uint', 'tcp.flags.fin': 'uint', 'tcp.flags.reset': 'uint',
  'tcp.flags.rst': 'uint', 'tcp.flags.push': 'uint', 'tcp.flags.psh': 'uint', 'tcp.window_size': 'uint', 'tcp.checksum': 'uint',
  'tcp.urgent_pointer': 'uint', 'tcp.options.mss_val': 'uint', 'tcp.payload': 'proto',
  dhcp: 'proto', bootp: 'proto', 'dhcp.option.dhcp': 'uint', 'dhcp.option.type': 'uint', 'dhcp.type': 'uint', 'dhcp.id': 'uint', 'dhcp.hops': 'uint',
  'dhcp.flags': 'uint', 'dhcp.ip.client': 'ipv4', 'dhcp.ip.your': 'ipv4', 'dhcp.ip.server': 'ipv4', 'dhcp.ip.relay': 'ipv4', 'dhcp.hw.mac_addr': 'ether',
  'dhcp.secs': 'uint', 'dhcp.hw.type': 'uint', 'dhcp.hw.len': 'uint', 'dhcp.cookie': 'uint',
  dns: 'proto', 'dns.id': 'uint', 'dns.flags': 'uint', 'dns.flags.response': 'uint', 'dns.flags.rcode': 'uint', 'dns.flags.opcode': 'uint',
  'dns.flags.recdesired': 'uint', 'dns.flags.recavail': 'uint', 'dns.qry.name': 'string', 'dns.qry.type': 'uint', 'dns.qry.class': 'uint',
  'dns.a': 'ipv4', 'dns.resp.name': 'string', 'dns.resp.type': 'uint', 'dns.resp.ttl': 'uint', 'dns.resp.len': 'uint',
  'dns.count.queries': 'uint', 'dns.count.answers': 'uint', 'dns.count.auth_rr': 'uint', 'dns.count.add_rr': 'uint',
  http: 'proto', 'http.request': 'proto', 'http.response': 'proto', 'http.request.method': 'string', 'http.request.uri': 'string',
  'http.request.version': 'string', 'http.response.code': 'uint', 'http.response.phrase': 'string', 'http.response.version': 'string',
  'http.host': 'string', 'http.user_agent': 'string', 'http.content_type': 'string', 'http.content_length': 'uint', 'http.connection': 'string',
  'http.server': 'string', 'http.accept': 'string', 'http.file_data': 'string',
  data: 'proto', 'data.len': 'uint', 'data.data': 'string',
};

export type FilterFn = (values: Map<string, FieldValue[]>) => boolean;
export type FilterResult = { ok: true; fn: FilterFn; empty: boolean } | { ok: false; error: string; pos: number };

type Tok =
  | { k: 'field' | 'word'; v: string; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'op'; v: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains'; pos: number }
  | { k: 'and' | 'or' | 'not' | '(' | ')'; pos: number };

class FilterError extends Error {
  constructor(
    msg: string,
    readonly pos: number,
  ) {
    super(msg);
  }
}

const WORD_OPS: Record<string, Tok['k'] | '=='> = { and: 'and', or: 'or', not: 'not' };
const CMP_WORDS: Record<string, '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains'> = { eq: '==', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<=', contains: 'contains' };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&') out.push({ k: 'and', pos: i }), (i += 2);
    else if (two === '||') out.push({ k: 'or', pos: i }), (i += 2);
    else if (two === '==' || two === '!=' || two === '>=' || two === '<=') out.push({ k: 'op', v: two, pos: i }), (i += 2);
    else if (c === '>' || c === '<') out.push({ k: 'op', v: c, pos: i }), i++;
    else if (c === '!') out.push({ k: 'not', pos: i }), i++;
    else if (c === '(' || c === ')') out.push({ k: c, pos: i }), i++;
    else if (c === '=') throw new FilterError('Одиночный «=» — для сравнения нужен «==»', i);
    else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        v += s[j++];
      }
      if (j >= s.length) throw new FilterError('Не закрыта кавычка', i);
      out.push({ k: 'str', v, pos: i });
      i = j + 1;
    } else if (/[A-Za-z0-9_.:\-/]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.:\-/]/.test(s[j])) j++;
      const w = s.slice(i, j);
      const lw = w.toLowerCase();
      if (WORD_OPS[lw]) out.push({ k: WORD_OPS[lw] as 'and' | 'or' | 'not', pos: i });
      else if (CMP_WORDS[lw]) out.push({ k: 'op', v: CMP_WORDS[lw], pos: i });
      else out.push({ k: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/i.test(w) && !/^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/i.test(w) ? 'field' : 'word', v: w, pos: i });
      i = j;
    } else throw new FilterError(`Неожиданный символ «${c}»`, i);
  }
  return out;
}

// ---------- значения ----------

function parseIp(s: string): { addr: number; mask: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return { addr: (addr & mask) >>> 0, mask };
}

function normMac(s: string): string | null {
  const h = s.toLowerCase().replace(/[:.\-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(h)) return null;
  if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$|^[0-9a-f]{12}$/.test(s.toLowerCase())) return null;
  return h.match(/../g)!.join(':');
}

function parseUint(s: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

type Pred = (vals: FieldValue[]) => boolean;

function comparison(field: string, type: FieldType, op: string, raw: string, pos: number, quoted: boolean): Pred {
  if (type === 'proto') throw new FilterError(`«${field}» — протокол, его нельзя сравнивать со значением. Напишите просто «${field}»`, pos);
  if (op === 'contains') {
    if (type !== 'string') throw new FilterError(`contains работает только со строковыми полями, а «${field}» — не строка`, pos);
    const needle = raw.toLowerCase();
    return (vs) => vs.some((v) => String(v).toLowerCase().includes(needle));
  }
  const any = (test: (v: FieldValue) => boolean): Pred =>
    op === '!=' ? (vs) => vs.length > 0 && !vs.some(test) : (vs) => vs.some(test);
  const ordered = (cmp: (v: number) => number): Pred => {
    const f: Record<string, (x: number) => boolean> = { '==': (x) => x === 0, '!=': (x) => x === 0, '>': (x) => x > 0, '<': (x) => x < 0, '>=': (x) => x >= 0, '<=': (x) => x <= 0 };
    const t = f[op];
    return op === '!=' ? (vs) => vs.length > 0 && !vs.some((v) => cmp(v as number) === 0) : (vs) => vs.some((v) => t(cmp(v as number)));
  };
  switch (type) {
    case 'uint': {
      const n = quoted ? null : parseUint(raw);
      if (n === null) throw new FilterError(`«${raw}» — не число (поле ${field} числовое)`, pos);
      return ordered((v) => v - n);
    }
    case 'ipv4': {
      const ip = parseIp(raw);
      if (!ip) throw new FilterError(`«${raw}» — не IPv4-адрес (пример: 192.168.1.10 или 192.168.1.0/24)`, pos);
      if (op !== '==' && op !== '!=') throw new FilterError(`Для адресов годятся только == и !=`, pos);
      return any((v) => {
        const x = parseIp(String(v));
        return !!x && (x.addr & ip.mask) >>> 0 === ip.addr;
      });
    }
    case 'ether': {
      const mac = normMac(raw);
      if (!mac) throw new FilterError(`«${raw}» — не MAC-адрес (пример: 00:60:5c:3a:1b:01)`, pos);
      if (op !== '==' && op !== '!=') throw new FilterError(`Для MAC-адресов годятся только == и !=`, pos);
      return any((v) => v === mac);
    }
    case 'string': {
      if (op !== '==' && op !== '!=') throw new FilterError(`Для строк годятся ==, != и contains`, pos);
      return any((v) => String(v) === raw);
    }
  }
}

// ---------- парсер ----------

type Node = (vals: Map<string, FieldValue[]>) => boolean;

function parse(toks: Tok[], textLen: number): Node {
  let i = 0;
  const peek = () => toks[i];
  const end = textLen;

  const orExpr = (): Node => {
    let l = andExpr();
    while (peek()?.k === 'or') {
      i++;
      const a = l;
      const r = andExpr();
      l = (v) => a(v) || r(v);
    }
    return l;
  };
  const andExpr = (): Node => {
    let l = notExpr();
    while (peek()?.k === 'and') {
      i++;
      const a = l;
      const r = notExpr();
      l = (v) => a(v) && r(v);
    }
    return l;
  };
  const notExpr = (): Node => {
    if (peek()?.k === 'not') {
      i++;
      const e = notExpr();
      return (v) => !e(v);
    }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new FilterError('Выражение обрывается — не хватает условия', end);
    if (t.k === '(') {
      i++;
      const e = orExpr();
      if (peek()?.k !== ')') throw new FilterError('Не хватает закрывающей скобки «)»', peek()?.pos ?? end);
      i++;
      return e;
    }
    if (t.k !== 'field') {
      if (t.k === 'word' || t.k === 'str') throw new FilterError(`Ожидалось имя поля (например ip.addr), а встретилось «${t.v}»`, t.pos);
      throw new FilterError('Ожидалось имя поля или «(»', t.pos);
    }
    i++;
    const name = t.v.toLowerCase();
    const type = FILTER_FIELDS[name];
    if (!type) throw new FilterError(`Неизвестное поле «${t.v}»`, t.pos);
    const op = peek();
    if (op?.k !== 'op') return (v) => (v.get(name)?.length ?? 0) > 0;
    i++;
    if (type === 'proto') throw new FilterError(`«${name}» — протокол, его нельзя сравнивать со значением. Напишите просто «${name}»`, op.pos);
    const val = peek();
    if (!val || (val.k !== 'word' && val.k !== 'field' && val.k !== 'str')) throw new FilterError(`После «${op.v}» нужно значение`, val?.pos ?? end);
    i++;
    const pred = comparison(name, type, op.v, val.v, val.pos, val.k === 'str');
    return (v) => pred(v.get(name) ?? []);
  };

  const e = orExpr();
  if (i < toks.length) {
    const t = toks[i];
    throw new FilterError(t.k === ')' ? 'Лишняя закрывающая скобка «)»' : 'Между условиями нужен && или ||', t.pos);
  }
  return e;
}

/** Скомпилировать фильтр. Пустая строка — показывать всё. */
export function compileFilter(text: string): FilterResult {
  if (!text.trim()) return { ok: true, fn: () => true, empty: true };
  try {
    return { ok: true, fn: parse(lex(text), text.trimEnd().length), empty: false };
  } catch (e) {
    if (e instanceof FilterError) return { ok: false, error: e.message, pos: e.pos };
    throw e;
  }
}
