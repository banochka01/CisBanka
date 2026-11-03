// DNS (RFC 1035): запрос A-записи и ответ, имена со сжатием (указатели 0xC0).
import type { DnsPayload } from '../model/packet';
import { ipToBytes, ipToString, u16, u32, Writer } from './bytes';

export const DNS_TYPE_A = 1;
export const DNS_CLASS_IN = 1;
export const DNS_TTL = 86400;
export const RCODE_NXDOMAIN = 3;

export interface DnsQuestion {
  name: string;
  type: number;
  cls: number;
  offset: number;
  len: number;
}

export interface DnsAnswer extends DnsQuestion {
  ttl: number;
  rdlength: number;
  rdata: Uint8Array;
}

export interface DnsHeader {
  id: number;
  flags: number;
  qr: boolean;
  opcode: number;
  rd: boolean;
  ra: boolean;
  rcode: number;
  qdcount: number;
  ancount: number;
  nscount: number;
  arcount: number;
  questions: DnsQuestion[];
  answers: DnsAnswer[];
}

function writeName(w: Writer, name: string) {
  for (const label of name.split('.').filter(Boolean)) {
    const b = new TextEncoder().encode(label).subarray(0, 63);
    w.u8(b.length).bytes(b);
  }
  w.u8(0);
}

export function encodeDns(m: DnsPayload): Uint8Array {
  const resp = m.qr === 'response';
  const nx = m.rcode === 'NXDOMAIN';
  const flags = resp ? 0x8180 | (nx ? RCODE_NXDOMAIN : 0) : 0x0100;
  const answer = resp && !nx && m.answer;
  const w = new Writer()
    .u16(m.id & 0xffff)
    .u16(flags)
    .u16(1)
    .u16(answer ? 1 : 0)
    .u16(0)
    .u16(0);
  writeName(w, m.name);
  w.u16(DNS_TYPE_A).u16(DNS_CLASS_IN);
  // Имя в ответе — указатель на вопрос (смещение 12).
  if (answer) w.u16(0xc00c).u16(DNS_TYPE_A).u16(DNS_CLASS_IN).u32(DNS_TTL).u16(4).bytes(ipToBytes(m.answer));
  return w.finish();
}

/** Читает имя; возвращает имя и длину в исходном месте (указатель — 2 байта). */
function readName(b: Uint8Array, base: number, o: number, end: number): { name: string; len: number } | null {
  const labels: string[] = [];
  let i = o;
  let len = -1;
  for (let guard = 0; guard < 128; guard++) {
    if (i >= end) return null;
    const n = b[i];
    if (n === 0) {
      if (len < 0) len = i + 1 - o;
      return { name: labels.join('.'), len };
    }
    if ((n & 0xc0) === 0xc0) {
      if (i + 1 >= end) return null;
      if (len < 0) len = i + 2 - o;
      i = base + (((n & 0x3f) << 8) | b[i + 1]);
      continue;
    }
    if (i + 1 + n > end) return null;
    labels.push(new TextDecoder().decode(b.subarray(i + 1, i + 1 + n)));
    i += 1 + n;
  }
  return null;
}

export function decodeDns(b: Uint8Array, o: number, end: number): DnsHeader | null {
  if (end - o < 12) return null;
  const flags = u16(b, o + 2);
  const h: DnsHeader = {
    id: u16(b, o),
    flags,
    qr: !!(flags & 0x8000),
    opcode: (flags >> 11) & 0xf,
    rd: !!(flags & 0x0100),
    ra: !!(flags & 0x0080),
    rcode: flags & 0xf,
    qdcount: u16(b, o + 4),
    ancount: u16(b, o + 6),
    nscount: u16(b, o + 8),
    arcount: u16(b, o + 10),
    questions: [],
    answers: [],
  };
  let i = o + 12;
  for (let q = 0; q < h.qdcount; q++) {
    const n = readName(b, o, i, end);
    if (!n || i + n.len + 4 > end) return h;
    h.questions.push({ name: n.name, type: u16(b, i + n.len), cls: u16(b, i + n.len + 2), offset: i, len: n.len + 4 });
    i += n.len + 4;
  }
  for (let a = 0; a < h.ancount; a++) {
    const n = readName(b, o, i, end);
    if (!n || i + n.len + 10 > end) return h;
    const p = i + n.len;
    const rdlength = u16(b, p + 8);
    if (p + 10 + rdlength > end) return h;
    h.answers.push({
      name: n.name,
      type: u16(b, p),
      cls: u16(b, p + 2),
      ttl: u32(b, p + 4),
      rdlength,
      rdata: b.slice(p + 10, p + 10 + rdlength),
      offset: i,
      len: n.len + 10 + rdlength,
    });
    i = p + 10 + rdlength;
  }
  return h;
}

export function dnsToPayload(h: DnsHeader): DnsPayload {
  const a = h.answers.find((x) => x.type === DNS_TYPE_A && x.rdlength === 4);
  const p: DnsPayload = { id: h.id, qr: h.qr ? 'response' : 'query', name: h.questions[0]?.name ?? '' };
  if (h.qr) {
    if (a) p.answer = ipToString(a.rdata);
    p.rcode = h.rcode === RCODE_NXDOMAIN ? 'NXDOMAIN' : 'NOERROR';
  }
  return p;
}
