// Дерево разбора, display-фильтры и Follow TCP stream.
import { describe, expect, it } from 'vitest';
import ref from './wire/reference.json';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { Capture, compileFilter, dissect, fieldAt, fieldValues, FILTER_FIELDS, followTcp, packetBytes, TcpStreamIndex, type Field, type FieldValue } from '../src/capture';
import { decodeFrame, fromUtf8, hexToBytes } from '../src/wire';
import { M24, run } from './helpers';

const R = ref as Record<string, string>;

function walk(fs: Field[], fn: (f: Field, parent: Field | null) => void, parent: Field | null = null) {
  for (const f of fs) {
    fn(f, parent);
    if (f.children) walk(f.children, fn, f);
  }
}

describe('дерево разбора', () => {
  it('уровни и подписи как в Wireshark', () => {
    const d = dissect(hexToBytes(R.tcp_http_get), { number: 4, relTime: 0.012 });
    expect(d.tree.map((f) => f.label.split(',')[0])).toEqual(['Frame 4: 154 bytes on wire (1232 bits)', 'Ethernet II', 'Internet Protocol Version 4', 'Transmission Control Protocol', 'Hypertext Transfer Protocol']);
    expect(d.protocols).toEqual(['eth', 'ethertype', 'ip', 'tcp', 'http']);
    const tcp = d.tree[3];
    const flags = tcp.children!.find((f) => f.name === 'tcp.flags')!;
    expect(flags.label).toBe('Flags: 0x018 (PSH, ACK)');
    expect(flags.children!.map((f) => f.label)).toContain('.... .... 1... = Push: Set');
    const http = d.tree[4];
    expect(http.children!.map((f) => f.label)).toContain('Connection: close\\r\\n');
  });

  it('диапазоны байтов: поля внутри кадра и внутри родителя, адреса указывают на свои байты', () => {
    for (const hex of Object.values(R)) {
      const b = hexToBytes(hex);
      const d = dissect(b);
      walk(d.tree, (f, p) => {
        expect(f.start).toBeGreaterThanOrEqual(0);
        expect(f.start + f.len).toBeLessThanOrEqual(b.length);
        // Как в Wireshark: паддинг вложен в Ethernet II, а TCP payload — в TCP, хотя лежат за заголовком.
        if (p && f.len > 0 && p.len > 0 && f.name !== 'eth.padding' && f.name !== 'tcp.payload') {
          expect(f.start).toBeGreaterThanOrEqual(p.start);
          expect(f.start + f.len).toBeLessThanOrEqual(p.start + p.len);
        }
      });
    }
    const d = dissect(hexToBytes(R.icmp_echo_request));
    const src = d.tree[2].children!.find((f) => f.name === 'ip.src')!;
    expect([src.start, src.len]).toEqual([26, 4]);
    // Клик по байту 27 (второй октет IP источника) → путь Internet Protocol → Source Address.
    expect(fieldAt(d.tree, 27)!.map((f) => f.name)).toEqual(['ip', 'ip.src']);
    expect(fieldAt(d.tree, 0)!.at(-1)!.name).toBe('eth.dst.lg');
  });

  it('паддинг Ethernet, ICMP-ошибка с вложенным заголовком, DHCP-опции, DNS-ответ', () => {
    const arp = dissect(hexToBytes(R.arp_request));
    expect(arp.tree[1].children!.at(-1)!.label).toMatch(/^Padding: 0{36}$/);
    const te = dissect(hexToBytes(R.icmp_time_exceeded));
    const icmp = te.tree.find((f) => f.name === 'icmp')!;
    expect(icmp.children!.some((f) => f.label === 'Internet Protocol Version 4, Src: 192.168.1.10, Dst: 10.0.0.1')).toBe(true);
    // Вложенный заголовок не портит ip.src внешнего пакета.
    expect(te.values.get('ip.src')).toEqual(['192.168.1.1']);
    const dh = dissect(hexToBytes(R.dhcp_discover));
    expect(dh.tree.find((f) => f.name === 'dhcp')!.label).toBe('Dynamic Host Configuration Protocol (Discover)');
    expect(dh.values.get('dhcp.option.dhcp')).toEqual([1]);
    const dns = dissect(hexToBytes(R.dns_response));
    expect(dns.values.get('dns.a')).toEqual(['192.168.1.2']);
    expect(dns.values.get('dns.qry.name')).toEqual(['site.local']);
  });

  it('быстрые значения для фильтров (fieldValues) совпадают с полным разбором', () => {
    const b = new TopologyBuilder('Все кадры', 4);
    const pc = b.add('pc', 'ПК');
    const sw = b.add('switch', 'Свитч');
    const srv = b.add('server', 'Сервер');
    const r = b.add('router', 'Роутер');
    b.dhcpClient(pc);
    b.ip(srv, 'Fa0', '192.168.1.2', M24).gateway(srv, '192.168.1.1');
    b.ip(r, 'Gi0/0', '192.168.1.1', M24);
    srv.config.dhcpPools = [{ name: 'L', network: '192.168.1.0', mask: M24, gateway: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', end: '192.168.1.110' }];
    srv.config.services = { dhcp: true, dns: { enabled: true, records: [{ name: 'site.local', address: '192.168.1.2' }] }, http: { enabled: true, title: 'T', body: 'B' } };
    b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
    b.link(srv, 'Fa0', sw, 'Fa0/2', 'straight');
    b.link(r, 'Gi0/0', sw, 'Fa0/3', 'straight');
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    run(sim, sim.openUrl(pc.id, 'http://site.local/'));
    run(sim, sim.nslookup(pc.id, 'nope.local'));
    run(sim, sim.ping(pc.id, '10.9.9.9', 1));
    const all = [...Object.values(R).map(hexToBytes), ...sim.log.filter((e) => e.kind === 'frame' && e.packet).map((e) => packetBytes(e.packet!))];
    const norm = (m: Map<string, FieldValue[]>) => [...m.entries()].sort(([a], [b2]) => a.localeCompare(b2));
    for (const [i, bytes] of all.entries()) {
      const meta = { number: i + 1, relTime: i / 10, tcpStream: 3 };
      expect(norm(fieldValues(decodeFrame(bytes), meta))).toEqual(norm(dissect(bytes, meta).values));
    }
    // Каждое поле, которое умеет разбор, известно фильтру.
    const names = new Set(all.flatMap((x) => [...dissect(x).values.keys()]));
    for (const n of names) expect(FILTER_FIELDS[n], n).toBeDefined();
  });

  it('обрезанные кадры не роняют разбор', () => {
    for (const hex of Object.values(R)) {
      const b = hexToBytes(hex);
      for (let n = 0; n <= b.length; n += 5) expect(() => dissect(b.subarray(0, n))).not.toThrow();
    }
  });
});

describe('display-фильтры', () => {
  const vals = (hex: string, stream?: number) => dissect(hexToBytes(hex), { tcpStream: stream }).values;
  const match = (f: string, v: Map<string, FieldValue[]>) => {
    const r = compileFilter(f);
    if (!r.ok) throw new Error(`${f}: ${r.error}`);
    return r.fn(v);
  };
  const syn = vals(R.tcp_syn, 0);
  const get = vals(R.tcp_http_get, 0);
  const arp = vals(R.arp_request);
  const dnsq = vals(R.dns_query);
  const dhcp = vals(R.dhcp_discover);
  const icmp = vals(R.icmp_echo_request);

  it.each([
    ['ip.addr==192.168.1.2', syn, true],
    ['ip.addr == 192.168.1.10', syn, true],
    ['ip.addr==192.168.1.99', syn, false],
    ['ip.addr==192.168.1.0/24', syn, true],
    ['ip.addr==10.0.0.0/8', syn, false],
    ['ip.src==192.168.1.10', syn, true],
    ['ip.dst==192.168.1.10', syn, false],
    ['ip.addr!=192.168.1.2', syn, false],
    ['ip.addr!=10.1.1.1', syn, true],
    ['eth.addr==00:60:5c:3a:1b:01', syn, true],
    ['eth.addr==0060.5C3A.1B02', syn, true],
    ['eth.src==00-60-5c-3a-1b-02', syn, false],
    ['eth.dst==ff:ff:ff:ff:ff:ff', arp, true],
    ['arp', arp, true],
    ['arp', syn, false],
    ['icmp', icmp, true],
    ['tcp', syn, true],
    ['udp', syn, false],
    ['udp', dnsq, true],
    ['dns', dnsq, true],
    ['dhcp', dhcp, true],
    ['bootp', dhcp, true],
    ['dhcp', dnsq, false],
    ['http', get, true],
    ['http', syn, false],
    ['tcp.port==80', syn, true],
    ['tcp.port==49200', syn, true],
    ['tcp.port==443', syn, false],
    ['udp.port==53', dnsq, true],
    ['udp.port==53', syn, false],
    ['tcp.flags.syn==1', syn, true],
    ['tcp.flags.syn==1', get, false],
    ['tcp.flags.syn==1 && tcp.flags.ack==0', syn, true],
    ['tcp.flags.reset==1 || tcp.flags.fin==1', syn, false],
    ['!arp', syn, true],
    ['not arp', arp, false],
    ['!(tcp.port==80)', syn, false],
    ['tcp && !(ip.dst==192.168.1.10)', syn, true],
    ['(arp || icmp) && eth.src==00:60:5c:3a:1b:01', icmp, true],
    ['arp || icmp && ip.ttl==1', arp, true],
    ['(arp || icmp) && ip.ttl==1', arp, false],
    ['ip.ttl > 64', syn, true],
    ['ip.ttl le 64', syn, false],
    ['tcp.window_size >= 0xfaf0', syn, true],
    ['tcp.options.mss_val == 1460', syn, true],
    ['tcp.stream == 0', syn, true],
    ['frame.len == 154', get, true],
    ['http.request.method == "GET"', get, true],
    ['http.request.method == GET', get, true],
    ['http.host contains "site"', get, true],
    ['dns.qry.name == "site.local"', dnsq, true],
    ['dns.qry.name contains LOCAL', dnsq, true],
    ['icmp.type == 8 and icmp.seq == 1', icmp, true],
    ['ip.proto == 6', syn, true],
    ['TCP.PORT == 80', syn, true],
  ] as const)('%s', (f, v, want) => {
    expect(match(f, v as Map<string, FieldValue[]>)).toBe(want);
  });

  it('пустой фильтр — всё видно', () => {
    const r = compileFilter('   ');
    expect(r.ok && r.empty && r.fn(new Map())).toBe(true);
  });

  it.each([
    ['ip.adr==1.1.1.1', 'Неизвестное поле «ip.adr»', 0],
    ['ip.addr==300.1.1.1', '«300.1.1.1» — не IPv4-адрес', 9],
    ['ip.addr=1.1.1.1', 'Одиночный «=»', 7],
    ['tcp.port==', 'После «==» нужно значение', 10],
    ['tcp.port==http', '«http» — не число', 10],
    ['(arp || icmp', 'Не хватает закрывающей скобки', 12],
    ['arp)', 'Лишняя закрывающая скобка', 3],
    ['arp icmp', 'Между условиями нужен && или ||', 4],
    ['arp &&', 'Выражение обрывается', 6],
    ['tcp == 1', 'протокол, его нельзя сравнивать', 4],
    ['eth.addr==zz:00:00:00:00:00', 'не MAC-адрес', 10],
    ['ip.addr > 1.1.1.1', 'только == и !=', 10],
    ['dns.qry.name == "x', 'Не закрыта кавычка', 16],
    ['tcp.port contains 80', 'contains работает только', 18],
    ['192.168.1.1', 'Ожидалось имя поля', 0],
    ['tcp.port==80 $', 'Неожиданный символ «$»', 13],
  ] as const)('ошибка: %s', (f, msg, pos) => {
    const r = compileFilter(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(msg);
      expect(r.pos).toBe(pos);
    }
  });
});

describe('Follow TCP stream', () => {
  function web() {
    const b = new TopologyBuilder('Follow', 9);
    const pc = b.add('pc', 'ПК');
    const pc2 = b.add('pc', 'ПК2');
    const sw = b.add('switch', 'Свитч');
    const srv = b.add('server', 'Сервер');
    b.ip(pc, 'Fa0', '192.168.1.10', M24).ip(pc2, 'Fa0', '192.168.1.11', M24).ip(srv, 'Fa0', '192.168.1.2', M24);
    srv.config.services = { http: { enabled: true, title: 'Привет', body: 'Учебный сайт' } };
    b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
    b.link(pc2, 'Fa0', sw, 'Fa0/2', 'straight');
    b.link(srv, 'Fa0', sw, 'Fa0/3', 'straight');
    const sim = new Simulator(b.project);
    const link = b.project.links.find((l) => l.a.deviceId === srv.id || l.b.deviceId === srv.id)!;
    const cap = new Capture({ kind: 'link', linkId: link.id }, sim);
    run(sim, sim.openUrl(pc.id, '192.168.1.2'));
    run(sim, sim.openUrl(pc2.id, '192.168.1.2'));
    run(sim, sim.openUrl(pc.id, '192.168.1.2'));
    run(sim, sim.ping(pc.id, '192.168.1.2', 1));
    cap.sync(sim);
    const idx = new TcpStreamIndex();
    return cap.frames.map((f) => {
      const decoded = decodeFrame(packetBytes(f.packet));
      return { no: f.no, decoded, stream: idx.add(decoded) };
    });
  }

  it('нумерация потоков: три соединения, не-TCP кадры — -1', () => {
    const fr = web();
    expect([...new Set(fr.map((f) => f.stream))].sort()).toEqual([-1, 0, 1, 2]);
    for (const s of [0, 1, 2]) expect(fr.filter((f) => f.stream === s)).toHaveLength(9);
    // Повторное подключение того же ПК с другого порта — новый поток.
    expect(fr.filter((f) => f.stream === 2)[0].decoded.tcp!.h.srcPort).not.toBe(fr.filter((f) => f.stream === 0)[0].decoded.tcp!.h.srcPort);
  });

  it('диалог: запрос клиента, затем ответ сервера; стороны определены по SYN', () => {
    const fr = web();
    const s = followTcp(fr, 1)!;
    expect(s.client.ip).toBe('192.168.1.11');
    expect(s.server).toEqual({ ip: '192.168.1.2', port: 80 });
    expect(s.chunks.map((c) => c.from)).toEqual(['client', 'server']);
    expect(fromUtf8(s.chunks[0].data)).toMatch(/^GET \/ HTTP\/1\.1\r\nHost: 192\.168\.1\.2\r\n/);
    expect(fromUtf8(s.chunks[1].data)).toContain('<title>Привет</title>');
    expect(s.clientBytes).toBe(s.chunks[0].data.length);
    expect(s.frames).toHaveLength(9);
    expect(followTcp(fr, 7)).toBeNull();
  });

  it('повтор сегмента (ретрансляция) не дублирует данные', () => {
    const fr = web().filter((f) => f.stream === 0);
    const get = fr.find((f) => f.decoded.http)!;
    const dup = [...fr.slice(0, fr.indexOf(get) + 1), { ...get, no: 99 }, ...fr.slice(fr.indexOf(get) + 1)];
    const s = followTcp(dup, 0)!;
    expect(s.chunks.map((c) => c.from)).toEqual(['client', 'server']);
    expect(s.clientBytes).toBe(get.decoded.tcp!.h.payloadLen);
  });
});
