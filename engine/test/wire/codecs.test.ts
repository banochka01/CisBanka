// Кодеки протоколов: контрольные суммы, побайтовая сверка с эталоном и разбор эталонных кадров.
// Эталоны (reference.json) собраны независимой реализацией на Python (refgen.py — struct + своя
// контрольная сумма), а не нашим кодом.
import { describe, expect, it } from 'vitest';
import ref from './reference.json';
import type { Packet } from '../../src/model/packet';
import {
  arpToPayload,
  bytesToHex,
  decodeFrame,
  decodeHttp,
  dhcpToPayload,
  dnsToPayload,
  encodeDhcp,
  encodeDns,
  encodeFrame,
  encodeHttp,
  hexToBytes,
  internetChecksum,
  ipToString,
  macToString,
  bitsToFlags,
} from '../../src/wire';

const A = '0060.5C3A.1B01';
const B = '0060.5C3A.1B02';
const BC = 'FFFF.FFFF.FFFF';
const R = ref as Record<string, string>;

const frame = (p: Omit<Packet, 'id' | 'frameId' | 'l2Hops'>): Packet => ({ id: 1, frameId: 1, l2Hops: 0, ...p });

describe('интернет-контрольная сумма (RFC 1071)', () => {
  it('пример из RFC 1071: 00 01 f2 03 f4 f5 f6 f7 → 0x220d', () => {
    expect(internetChecksum(hexToBytes('0001f203f4f5f6f7'))).toBe(0x220d);
  });

  it('IPv4-заголовок из Википедии: контрольная сумма 0xb861', () => {
    const h = hexToBytes('450000730000400040110000c0a80001c0a800c7');
    expect(internetChecksum(h)).toBe(0xb861);
    h[10] = 0xb8;
    h[11] = 0x61;
    expect(internetChecksum(h)).toBe(0);
  });

  it('нечётная длина дополняется нулём', () => {
    expect(internetChecksum(hexToBytes('01'))).toBe(internetChecksum(hexToBytes('0100')));
  });
});

describe('кодирование совпадает с эталоном побайтово', () => {
  const cases: [string, Packet][] = [
    ['arp_request', frame({ l2: { src: A, dst: BC, etherType: 'ARP' }, arp: { op: 'request', senderMac: A, senderIp: '192.168.1.10', targetMac: '0000.0000.0000', targetIp: '192.168.1.20' } })],
    ['arp_reply_vlan', frame({ l2: { src: B, dst: A, etherType: 'ARP', vlanTag: 10 }, arp: { op: 'reply', senderMac: B, senderIp: '192.168.1.20', targetMac: A, targetIp: '192.168.1.10' } })],
    [
      'icmp_echo_request',
      frame({ l2: { src: A, dst: B, etherType: 'IPv4' }, l3: { src: '192.168.1.10', dst: '192.168.1.20', ttl: 128, proto: 'ICMP', ipId: 7 }, icmp: { type: 'echo-request', id: 0x1234, seq: 1 } }),
    ],
    [
      'icmp_time_exceeded',
      frame({
        l2: { src: B, dst: A, etherType: 'IPv4' },
        l3: { src: '192.168.1.1', dst: '192.168.1.10', ttl: 255, proto: 'ICMP', ipId: 3 },
        icmp: {
          type: 'time-exceeded',
          id: 5,
          seq: 1,
          original: { src: '192.168.1.10', dst: '10.0.0.1' },
          originalPacket: { l3: { src: '192.168.1.10', dst: '10.0.0.1', ttl: 1, proto: 'ICMP', ipId: 9 }, icmp: { type: 'echo-request', id: 5, seq: 1 } },
        },
      }),
    ],
    [
      'dns_query',
      frame({
        l2: { src: A, dst: B, etherType: 'IPv4' },
        l3: { src: '192.168.1.10', dst: '192.168.1.2', ttl: 128, proto: 'UDP', ipId: 11 },
        l4: { srcPort: 1066, dstPort: 53 },
        dns: { id: 42, qr: 'query', name: 'site.local' },
      }),
    ],
    [
      'dns_response',
      frame({
        l2: { src: B, dst: A, etherType: 'IPv4' },
        l3: { src: '192.168.1.2', dst: '192.168.1.10', ttl: 128, proto: 'UDP', ipId: 12 },
        l4: { srcPort: 53, dstPort: 1066 },
        dns: { id: 42, qr: 'response', name: 'site.local', answer: '192.168.1.2', rcode: 'NOERROR' },
      }),
    ],
    [
      'dhcp_discover',
      frame({
        l2: { src: A, dst: BC, etherType: 'IPv4' },
        l3: { src: '0.0.0.0', dst: '255.255.255.255', ttl: 128, proto: 'UDP', ipId: 1 },
        l4: { srcPort: 68, dstPort: 67 },
        dhcp: { op: 'DISCOVER', xid: 0xdeadbeef, chaddr: A },
      }),
    ],
    [
      'tcp_syn',
      frame({
        l2: { src: A, dst: B, etherType: 'IPv4' },
        l3: { src: '192.168.1.10', dst: '192.168.1.2', ttl: 128, proto: 'TCP', ipId: 20 },
        l4: { srcPort: 49200, dstPort: 80, flags: ['SYN'], seq: 2197249643, ack: 0, window: 64240, mss: 1460 },
      }),
    ],
    [
      'tcp_http_get',
      frame({
        l2: { src: A, dst: B, etherType: 'IPv4' },
        l3: { src: '192.168.1.10', dst: '192.168.1.2', ttl: 128, proto: 'TCP', ipId: 22 },
        l4: { srcPort: 49200, dstPort: 80, flags: ['PSH', 'ACK'], seq: 2197249644, ack: 2276102493, window: 64240 },
        http: { kind: 'request', method: 'GET', host: 'site.local', path: '/' },
      }),
    ],
  ];

  for (const [name, p] of cases) {
    it(name, () => {
      expect(bytesToHex(encodeFrame(p))).toBe(R[name]);
    });
  }

  it('кодирование детерминировано и не зависит от порядка ключей', () => {
    const [, p] = cases[cases.length - 1];
    const shuffled = JSON.parse(JSON.stringify({ http: p.http, l4: p.l4, l3: p.l3, l2: p.l2, id: 99, frameId: 5, l2Hops: 3 }));
    expect(bytesToHex(encodeFrame(shuffled))).toBe(bytesToHex(encodeFrame(p)));
  });
});

describe('разбор эталонных кадров', () => {
  it('ARP-запрос', () => {
    const d = decodeFrame(hexToBytes(R.arp_request));
    expect(macToString(d.eth!.dst)).toBe('ff:ff:ff:ff:ff:ff');
    expect(d.eth!.etherType).toBe(0x0806);
    expect(arpToPayload(d.arp!.h)).toEqual({ op: 'request', senderMac: A, senderIp: '192.168.1.10', targetMac: '0000.0000.0000', targetIp: '192.168.1.20' });
  });

  it('ARP-ответ с тегом 802.1Q', () => {
    const d = decodeFrame(hexToBytes(R.arp_reply_vlan));
    expect(d.eth!.vlan!.id).toBe(10);
    expect(d.eth!.headerLen).toBe(18);
    expect(d.arp!.h.op).toBe(2);
  });

  it('ICMP эхо-запрос: поля и контрольные суммы', () => {
    const d = decodeFrame(hexToBytes(R.icmp_echo_request));
    expect(d.ip!.h).toMatchObject({ version: 4, headerLen: 20, ttl: 128, proto: 1, id: 7, totalLength: 60, checksumOk: true });
    expect(ipToString(d.ip!.h.src)).toBe('192.168.1.10');
    expect(d.icmp!.h).toMatchObject({ type: 8, code: 0, id: 0x1234, seq: 1, dataLen: 32, checksumOk: true });
  });

  it('ICMP Time Exceeded содержит исходный заголовок', () => {
    const d = decodeFrame(hexToBytes(R.icmp_time_exceeded));
    expect(d.icmp!.h).toMatchObject({ type: 11, code: 0, checksumOk: true, dataLen: 28 });
    const inner = decodeFrame(new Uint8Array([...hexToBytes('000000000000000000000000'), 0x08, 0x00, ...d.bytes.subarray(d.icmp!.h.dataStart, d.icmp!.h.dataStart + 28)]));
    expect(ipToString(inner.ip!.h.dst)).toBe('10.0.0.1');
    expect(inner.ip!.h.ttl).toBe(1);
  });

  it('DNS-запрос и ответ', () => {
    const q = decodeFrame(hexToBytes(R.dns_query));
    expect(q.udp!.h).toMatchObject({ srcPort: 1066, dstPort: 53, checksumOk: true });
    expect(dnsToPayload(q.dns!.h)).toEqual({ id: 42, qr: 'query', name: 'site.local' });
    const r = decodeFrame(hexToBytes(R.dns_response));
    expect(r.dns!.h.answers[0]).toMatchObject({ name: 'site.local', ttl: 86400 });
    expect(dnsToPayload(r.dns!.h)).toEqual({ id: 42, qr: 'response', name: 'site.local', answer: '192.168.1.2', rcode: 'NOERROR' });
  });

  it('DHCP Discover', () => {
    const d = decodeFrame(hexToBytes(R.dhcp_discover));
    expect(d.udp!.h).toMatchObject({ srcPort: 68, dstPort: 67, checksumOk: true });
    expect(d.dhcp!.h).toMatchObject({ op: 1, xid: 0xdeadbeef, magic: 0x63825363, msgType: 1, flags: 0x8000 });
    expect(dhcpToPayload(d.dhcp!.h)).toEqual({ op: 'DISCOVER', xid: 0xdeadbeef, chaddr: A });
  });

  it('TCP SYN с MSS', () => {
    const d = decodeFrame(hexToBytes(R.tcp_syn));
    expect(d.ip!.h.flags).toBe(0b010);
    expect(d.tcp!.h).toMatchObject({ srcPort: 49200, dstPort: 80, seq: 2197249643, ack: 0, headerLen: 24, window: 64240, checksumOk: true, payloadLen: 0 });
    expect(bitsToFlags(d.tcp!.h.flags)).toEqual(['SYN']);
    expect(d.tcp!.h.options).toEqual([{ kind: 2, len: 4, offset: 14 + 20 + 20, value: 1460 }]);
  });

  it('TCP с HTTP GET', () => {
    const d = decodeFrame(hexToBytes(R.tcp_http_get));
    expect(bitsToFlags(d.tcp!.h.flags)).toEqual(['PSH', 'ACK']);
    expect(d.tcp!.h.checksumOk).toBe(true);
    expect(d.http!.h.startLine).toBe('GET / HTTP/1.1');
    expect(d.http!.h.payload).toEqual({ kind: 'request', method: 'GET', path: '/', host: 'site.local' });
  });

  it('испорченный байт ломает контрольную сумму', () => {
    const b = hexToBytes(R.tcp_http_get);
    b[b.length - 5] ^= 0xff;
    expect(decodeFrame(b).tcp!.h.checksumOk).toBe(false);
    const c = hexToBytes(R.icmp_echo_request);
    c[22] ^= 1; // TTL
    expect(decodeFrame(c).ip!.h.checksumOk).toBe(false);
  });

  it('обрезанный кадр не роняет разбор', () => {
    for (const hex of Object.values(R)) {
      const b = hexToBytes(hex);
      for (let n = 0; n <= b.length; n += 7) expect(() => decodeFrame(b.subarray(0, n))).not.toThrow();
    }
  });
});

describe('туда-обратно', () => {
  it('DHCP: все типы сообщений', () => {
    const msgs = [
      { op: 'DISCOVER', xid: 1, chaddr: A },
      { op: 'OFFER', xid: 2, chaddr: A, yiaddr: '192.168.1.100', serverId: '192.168.1.2', mask: '255.255.255.0', router: '192.168.1.1', dns: '192.168.1.2' },
      { op: 'REQUEST', xid: 3, chaddr: A, requestedIp: '192.168.1.100', serverId: '192.168.1.2' },
      { op: 'ACK', xid: 4, chaddr: A, yiaddr: '192.168.1.100', giaddr: '10.0.0.1', serverId: '192.168.1.2', mask: '255.255.255.0' },
      { op: 'NAK', xid: 0xffffffff, chaddr: A, serverId: '192.168.1.2' },
    ] as const;
    for (const m of msgs) {
      const b = encodeDhcp(m);
      expect(b.length).toBeGreaterThanOrEqual(300);
      const d = decodeFrame(encodeFrame(frame({ l2: { src: A, dst: BC, etherType: 'IPv4' }, l3: { src: '0.0.0.0', dst: '255.255.255.255', ttl: 128, proto: 'UDP' }, l4: { srcPort: 68, dstPort: 67 }, dhcp: m })));
      expect(dhcpToPayload(d.dhcp!.h)).toEqual(m);
    }
  });

  it('DNS: NXDOMAIN', () => {
    const m = { id: 7, qr: 'response', name: 'nope.local', rcode: 'NXDOMAIN' } as const;
    const d = decodeFrame(encodeFrame(frame({ l2: { src: A, dst: B, etherType: 'IPv4' }, l3: { src: '1.1.1.1', dst: '2.2.2.2', ttl: 64, proto: 'UDP' }, l4: { srcPort: 53, dstPort: 5000 }, dns: m })));
    expect(d.dns!.h.rcode).toBe(3);
    expect(dnsToPayload(d.dns!.h)).toEqual(m);
    expect(encodeDns(m).length).toBe(12 + 12 + 4);
  });

  it('HTTP-ответ с UTF-8 и спецсимволами', () => {
    const m = { kind: 'response', status: 200, title: 'Привет <мир> & всё', body: 'Учебный сайт' } as const;
    const b = encodeHttp(m);
    const p = decodeHttp(b)!;
    expect(p.startLine).toBe('HTTP/1.1 200 OK');
    expect(p.headers.find((h) => h.name === 'Content-Length')!.value).toBe(String(b.length - p.bodyStart));
    expect(p.payload).toEqual(m);
  });
});
