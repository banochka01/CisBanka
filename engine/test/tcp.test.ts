import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import type { LogEntry } from '../src/model/events';
import type { Packet } from '../src/model/packet';
import { arpToPayload, bytesToHex, decodeFrame, dhcpToPayload, dnsToPayload, encodeFrame, ipToString, bitsToFlags } from '../src/wire';
import { TCP_MSS } from '../src/l4/tcp';
import { M24, run } from './helpers';

/** ПК — свитч — сервер (DHCP+DNS+HTTP), ПК получает адрес по DHCP. */
function lan(seed = 11, body = 'Это учебный сайт') {
  const b = new TopologyBuilder('TCP', seed);
  const pc = b.add('pc', 'ПК');
  const sw = b.add('switch', 'Свитч');
  const srv = b.add('server', 'Сервер');
  b.dhcpClient(pc);
  b.ip(srv, 'Fa0', '192.168.1.2', M24);
  srv.config.dhcpPools = [{ name: 'LAN', network: '192.168.1.0', mask: M24, gateway: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', end: '192.168.1.110' }];
  srv.config.services = {
    dhcp: true,
    dns: { enabled: true, records: [{ name: 'site.local', address: '192.168.1.2' }] },
    http: { enabled: true, title: 'Привет', body },
  };
  b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(srv, 'Fa0', sw, 'Fa0/2', 'straight');
  return { b, pc, sw, srv };
}

/** TCP-сегменты, пришедшие на конечные узлы (не на свитч), по порядку. */
function segments(sim: Simulator, from = 0): Packet[] {
  return sim.log
    .slice(from)
    .filter((e) => e.kind === 'frame' && e.packet?.l3?.proto === 'TCP' && sim.device(e.deviceId!).kind !== 'switch')
    .map((e) => e.packet!);
}

const fl = (p: Packet) => p.l4!.flags!.join('+');

describe('TCP: seq/ack, MSS, закрытие FIN/ACK', () => {
  it('открыть сайт: рукопожатие, GET, ответ и закрытие — 9 сегментов с честными номерами', () => {
    const { b, pc, srv } = lan();
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    const from = sim.log.length;
    expect(run(sim, sim.openUrl(pc.id, '192.168.1.2'))).toContain('HTTP/1.1 200 OK');
    const s = segments(sim, from);
    expect(s.map((p) => `${p.l3!.src === '192.168.1.2' ? 'S' : 'C'}:${fl(p)}`)).toEqual([
      'C:SYN',
      'S:SYN+ACK',
      'C:ACK',
      'C:PSH+ACK', // GET
      'S:PSH+ACK', // 200 OK
      'S:FIN+ACK',
      'C:ACK',
      'C:FIN+ACK',
      'S:ACK',
    ]);
    const [syn, synAck, ack, get, resp, sFin, cAck, cFin, last] = s.map((p) => p.l4!);
    const x = syn.seq!;
    const y = synAck.seq!;
    const getLen = encodeFrame(s[3]).length - 14 - 20 - 20;
    const respLen = encodeFrame(s[4]).length - 14 - 20 - 20;
    expect(syn).toMatchObject({ ack: 0, mss: TCP_MSS, window: 64240 });
    expect(synAck).toMatchObject({ ack: x + 1, mss: TCP_MSS });
    expect(ack).toMatchObject({ seq: x + 1, ack: y + 1 });
    expect(ack.mss).toBeUndefined();
    expect(get).toMatchObject({ seq: x + 1, ack: y + 1 });
    expect(resp).toMatchObject({ seq: y + 1, ack: x + 1 + getLen });
    expect(sFin).toMatchObject({ seq: y + 1 + respLen, ack: x + 1 + getLen });
    expect(cAck).toMatchObject({ seq: x + 1 + getLen, ack: y + 1 + respLen });
    expect(cFin).toMatchObject({ seq: x + 1 + getLen, ack: y + 2 + respLen });
    expect(last).toMatchObject({ seq: y + 2 + respLen, ack: x + 2 + getLen });
    // Соединения закрыты с обеих сторон.
    expect(sim.rt(pc.id).tcp).toEqual({});
    expect(sim.rt(srv.id).tcp).toEqual({});
  });

  it('ISN берутся из PRNG: тот же проект — те же номера, другое зерно — другие', () => {
    const isn = (seed: number) => {
      const { b, pc } = lan(seed);
      const sim = new Simulator(b.project);
      sim.runUntilIdle();
      const from = sim.log.length;
      run(sim, sim.openUrl(pc.id, '192.168.1.2'));
      return segments(sim, from).slice(0, 2).map((p) => p.l4!.seq);
    };
    expect(isn(11)).toEqual(isn(11));
    expect(isn(11)).not.toEqual(isn(12));
  });

  it('HTTP выключен — сервер отвечает RST+ACK с seq 0 и ack = ISN+1', () => {
    const { b, pc, srv } = lan();
    srv.config.services!.http!.enabled = false;
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    const from = sim.log.length;
    expect(run(sim, sim.openUrl(pc.id, '192.168.1.2'))).toContain('Соединение отклонено');
    const [syn, rst] = segments(sim, from);
    expect(segments(sim, from)).toHaveLength(2);
    expect(rst.l4).toMatchObject({ flags: ['RST', 'ACK'], seq: 0, ack: syn.l4!.seq! + 1, srcPort: 80, dstPort: syn.l4!.srcPort });
    expect(sim.rt(pc.id).tcp).toEqual({});
  });

  it('на ПК нет веб-сервера — тоже RST (закрытый порт)', () => {
    const b = new TopologyBuilder('RST', 5);
    const pc1 = b.add('pc', 'ПК1');
    const pc2 = b.add('pc', 'ПК2');
    b.ip(pc1, 'Fa0', '10.0.0.1', M24).ip(pc2, 'Fa0', '10.0.0.2', M24);
    b.link(pc1, 'Fa0', pc2, 'Fa0', 'crossover');
    const sim = new Simulator(b.project);
    expect(run(sim, sim.openUrl(pc1.id, '10.0.0.2'))).toContain('Соединение отклонено');
    const rst = sim.log.find((e) => e.kind === 'frame' && e.packet?.l4?.flags?.includes('RST'))!;
    expect(rst.packet!.l3!.src).toBe('10.0.0.2');
    expect(sim.log.some((e) => e.reason.includes('TCP-порт 80 закрыт — отвечаю RST'))).toBe(true);
  });

  it('большая страница режется на сегменты по MSS, браузер собирает её целиком', () => {
    const body = 'Б'.repeat(2000); // 4000 байт UTF-8
    const { b, pc } = lan(11, body);
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    const from = sim.log.length;
    expect(run(sim, sim.openUrl(pc.id, '192.168.1.2'))).toContain(body);
    const data = segments(sim, from).filter((p) => p.l3!.src === '192.168.1.2' && p.l4!.chunk);
    expect(data.length).toBe(3);
    for (const p of data) expect(p.l4!.chunk![1] - p.l4!.chunk![0]).toBeLessThanOrEqual(TCP_MSS);
    expect(data.map(fl)).toEqual(['ACK', 'ACK', 'PSH+ACK']);
    // Каждый кадр укладывается в MTU 1500 (+14 байт Ethernet).
    for (const p of data) expect(encodeFrame(p).length).toBeLessThanOrEqual(1514);
    // Номера идут подряд.
    expect(data[1].l4!.seq).toBe(data[0].l4!.seq! + TCP_MSS);
  });
});

describe('байты на проводе', () => {
  /** DHCP, DNS, HTTP, ping, traceroute через роутер — все виды кадров. */
  function scenario(seed = 11) {
    const { b, pc, srv } = lan(seed);
    const r = b.add('router', 'Роутер');
    const far = b.add('pc', 'Дальний');
    b.ip(r, 'Gi0/0', '192.168.1.1', M24).ip(r, 'Gi0/1', '10.0.0.1', M24);
    b.ip(far, 'Fa0', '10.0.0.2', M24).gateway(far, '10.0.0.1');
    b.gateway(srv, '192.168.1.1');
    b.link(r, 'Gi0/0', b.project.devices.find((d) => d.kind === 'switch')!, 'Fa0/3', 'straight');
    b.link(r, 'Gi0/1', far, 'Fa0', 'crossover');
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    run(sim, sim.openUrl(pc.id, 'http://site.local/'));
    run(sim, sim.ping(pc.id, '10.0.0.2', 2));
    run(sim, sim.traceroute(pc.id, '10.0.0.2'));
    run(sim, sim.ping(pc.id, '172.16.0.1', 1));
    return sim;
  }
  const wire = (sim: Simulator) => sim.log.filter((e): e is LogEntry & { packet: Packet } => e.kind === 'frame' && !!e.packet);

  it('каждый кадр кодируется с верными контрольными суммами и разбирается обратно в тот же пакет', () => {
    const sim = scenario();
    const frames = wire(sim);
    const kinds = new Set<string>();
    for (const { packet: p } of frames) {
      const d = decodeFrame(encodeFrame(p));
      expect(d.bytes.length).toBeGreaterThanOrEqual(60);
      if (p.arp) {
        kinds.add('arp');
        expect(arpToPayload(d.arp!.h)).toEqual(p.arp);
        continue;
      }
      expect(d.ip!.h.checksumOk).toBe(true);
      expect(ipToString(d.ip!.h.src)).toBe(p.l3!.src);
      expect(d.ip!.h.ttl).toBe(p.l3!.ttl);
      if (p.icmp) {
        kinds.add(`icmp:${p.icmp.type}`);
        expect(d.icmp!.h.checksumOk).toBe(true);
      }
      if (d.udp) expect(d.udp.h.checksumOk).toBe(true);
      if (p.dhcp) {
        kinds.add('dhcp');
        expect(dhcpToPayload(d.dhcp!.h)).toEqual(p.dhcp);
      }
      if (p.dns) {
        kinds.add('dns');
        expect(dnsToPayload(d.dns!.h)).toEqual(p.dns);
      }
      if (p.l3!.proto === 'TCP') {
        kinds.add('tcp');
        expect(d.tcp!.h.checksumOk).toBe(true);
        expect(d.tcp!.h).toMatchObject({ seq: p.l4!.seq, ack: p.l4!.ack, window: p.l4!.window });
        expect(bitsToFlags(d.tcp!.h.flags).sort()).toEqual([...p.l4!.flags!].sort());
        if (p.http && !p.l4!.chunk) expect(d.http!.h.payload).toMatchObject({ kind: p.http.kind });
      }
    }
    expect([...kinds].sort()).toEqual(['arp', 'dhcp', 'dns', 'icmp:dest-unreachable', 'icmp:echo-reply', 'icmp:echo-request', 'icmp:time-exceeded', 'tcp']);
  });

  it('IP Identification сохраняется при маршрутизации, TTL уменьшается', () => {
    const sim = scenario();
    const echo = wire(sim).filter((e) => e.packet.icmp?.type === 'echo-request' && e.packet.l3!.dst === '10.0.0.2' && e.packet.l3!.ttl >= 127);
    const byId = new Map<number, number[]>();
    for (const e of echo) byId.set(e.packet.l3!.ipId!, [...(byId.get(e.packet.l3!.ipId!) ?? []), e.packet.l3!.ttl]);
    expect([...byId.values()].some((ttls) => ttls.includes(128) && ttls.includes(127))).toBe(true);
  });

  it('один и тот же сценарий даёт побайтово одинаковые кадры', () => {
    const dump = (sim: Simulator) => wire(sim).map((e) => `${e.time}|${bytesToHex(encodeFrame(e.packet))}`).join('\n');
    expect(dump(scenario())).toBe(dump(scenario()));
    expect(dump(scenario(11))).not.toBe(dump(scenario(12)));
  });
});
