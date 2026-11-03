import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { Capture, packetBytes, summarize, TcpSeqContext, type CapturedFrame } from '../src/capture';
import { decodeFrame } from '../src/wire';
import { M24, run } from './helpers';

/** ПК1, ПК2, ПК3 на одном свитче; ПК2 — веб-сервер. */
function lan3() {
  const b = new TopologyBuilder('Сниффер', 3);
  const pc1 = b.add('pc', 'ПК1');
  const pc2 = b.add('server', 'ПК2');
  const pc3 = b.add('pc', 'ПК3');
  const sw = b.add('switch', 'Свитч');
  b.ip(pc1, 'Fa0', '192.168.1.10', M24).ip(pc2, 'Fa0', '192.168.1.20', M24).ip(pc3, 'Fa0', '192.168.1.30', M24);
  pc2.config.services = { http: { enabled: true, title: 'T', body: 'B' } };
  b.link(pc1, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(pc2, 'Fa0', sw, 'Fa0/2', 'straight');
  b.link(pc3, 'Fa0', sw, 'Fa0/3', 'straight');
  const link = (dev: { id: string }) => b.project.links.find((l) => l.a.deviceId === dev.id || l.b.deviceId === dev.id)!.id;
  return { b, pc1, pc2, pc3, sw, link };
}

const describeFrames = (fs: CapturedFrame[]) =>
  fs.map((f) => {
    const p = f.packet;
    if (p.arp) return `ARP ${p.arp.op}`;
    if (p.icmp) return `ICMP ${p.icmp.type} ${p.icmp.seq}`;
    return `${p.l3?.proto} ${p.l4?.flags?.join('+') ?? ''}`.trim();
  });

describe('захват на линке за свитчем', () => {
  it('посторонний линк видит только flood (ARP-запрос), unicast после изучения MAC — нет', () => {
    const { b, pc1, pc3, link } = lan3();
    const sim = new Simulator(b.project);
    const own = new Capture({ kind: 'link', linkId: link(pc1) }, sim);
    const other = new Capture({ kind: 'link', linkId: link(pc3) }, sim);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 2));
    own.sync(sim);
    other.sync(sim);
    expect(describeFrames(own.frames)).toEqual([
      'ARP request',
      'ARP reply',
      'ICMP echo-request 1',
      'ICMP echo-reply 1',
      'ICMP echo-request 2',
      'ICMP echo-reply 2',
    ]);
    // На линке ПК3 — только широковещательный ARP-запрос, который свитч разослал во все порты.
    expect(describeFrames(other.frames)).toEqual(['ARP request']);
    expect(other.frames[0].direction).toBe(b.project.links.find((l) => l.id === link(pc3))!.a.deviceId === pc3.id ? 'ba' : 'ab');
    expect(other.frames[0].srcDeviceId).not.toBe(pc3.id);
  });

  it('MAC-запись устарела — unicast снова летит flood-ом и виден на постороннем линке', () => {
    const { b, pc1, pc3, link } = lan3();
    // ARP на хостах живёт долго, а MAC-таблица свитча — полсекунды: второй эхо-запрос свитч уже не узнает.
    const sim = new Simulator(b.project, { macAging: 500 });
    const other = new Capture({ kind: 'link', linkId: link(pc3) }, sim);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 2));
    other.sync(sim);
    expect(describeFrames(other.frames)).toEqual(['ARP request', 'ICMP echo-request 2']);
  });

  it('направление и время: интерфейс различает in/out, время — модельное', () => {
    const { b, pc1, pc2 } = lan3();
    const sim = new Simulator(b.project);
    const cap = new Capture({ kind: 'port', portId: b.port(pc2, 'Fa0').id }, sim);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 2));
    cap.sync(sim);
    expect(cap.frames.map((f) => f.direction)).toEqual(['in', 'out', 'in', 'out', 'in', 'out']);
    expect(cap.frames.map((f) => f.no)).toEqual([1, 2, 3, 4, 5, 6]);
    // Входящий — время прихода, исходящий — время отправки в провод.
    for (const f of cap.frames) expect(f.time).toBe(f.direction === 'in' ? f.entry.time : f.entry.sentAt);
    // Второй эхо-запрос — через секунду; первый задержался на ARP-обмен (несколько мс).
    const req = cap.frames.filter((f) => f.packet.icmp?.type === 'echo-request');
    expect(req[1].time - req[0].time).toBeGreaterThan(990);
    expect(req[1].time - req[0].time).toBeLessThan(1000);
  });

  it('несколько захватов независимы; захват видит только то, что было после старта; стоп замораживает', () => {
    const { b, pc1, link } = lan3();
    const sim = new Simulator(b.project);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 1));
    const late = new Capture({ kind: 'link', linkId: link(pc1) }, sim);
    const stopped = new Capture({ kind: 'link', linkId: link(pc1) }, sim);
    stopped.stop(sim);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 1));
    late.sync(sim);
    stopped.sync(sim);
    // ARP уже известен — только эхо.
    expect(describeFrames(late.frames)).toEqual(['ICMP echo-request 1', 'ICMP echo-reply 1']);
    expect(stopped.frames).toEqual([]);
    late.clear(sim);
    expect(late.frames).toEqual([]);
  });
});

describe('захват и режим симуляции', () => {
  it('шаг назад убирает кадры из захвата, шаг вперёд возвращает те же', () => {
    const { b, pc1, link } = lan3();
    const sim = new Simulator(b.project);
    sim.beginHops();
    const cap = new Capture({ kind: 'link', linkId: link(pc1) }, sim);
    sim.ping(pc1.id, '192.168.1.20', 1);
    sim.primeHop();
    const counts: number[] = [];
    while (sim.stepHop()) {
      cap.sync(sim);
      counts.push(cap.frames.length);
    }
    const full = describeFrames(cap.frames);
    expect(full).toEqual(['ARP request', 'ARP reply', 'ICMP echo-request 1', 'ICMP echo-reply 1']);
    expect(counts.at(-1)).toBe(4);

    for (let i = 0; i < 4; i++) sim.stepBackHop();
    cap.sync(sim);
    expect(cap.frames.length).toBeLessThan(4);
    while (sim.stepHop()) cap.sync(sim);
    expect(describeFrames(cap.frames)).toEqual(full);
    expect(cap.frames.map((f) => f.no)).toEqual([1, 2, 3, 4]);
  });
});

describe('колонки списка пакетов', () => {
  it('Info в стиле Wireshark: ARP, ICMP, TCP с относительными номерами, HTTP', () => {
    const { b, pc1, link } = lan3();
    const sim = new Simulator(b.project);
    const cap = new Capture({ kind: 'link', linkId: link(pc1) }, sim);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 1));
    run(sim, sim.openUrl(pc1.id, '192.168.1.20'));
    cap.sync(sim);
    const ctx = new TcpSeqContext();
    const rows = cap.frames.map((f) => summarize(decodeFrame(packetBytes(f.packet)), ctx));
    expect(rows[0]).toEqual({ src: b.port(pc1, 'Fa0').mac.replace(/\./g, '').toLowerCase().replace(/(..)(?!$)/g, '$1:'), dst: 'Broadcast', protocol: 'ARP', info: 'Who has 192.168.1.20? Tell 192.168.1.10' });
    expect(rows[1].info).toMatch(/^192\.168\.1\.20 is at ([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    expect(rows[2]).toMatchObject({ src: '192.168.1.10', dst: '192.168.1.20', protocol: 'ICMP' });
    expect(rows[2].info).toMatch(/^Echo \(ping\) request {2}id=0x[0-9a-f]{4}, seq=1\/256, ttl=128$/);
    const tcp = rows.slice(4);
    expect(tcp.map((r) => r.protocol)).toEqual(['TCP', 'TCP', 'TCP', 'HTTP', 'HTTP', 'TCP', 'TCP', 'TCP', 'TCP']);
    expect(tcp[0].info).toMatch(/^\d+ → 80 \[SYN\] Seq=0 Win=64240 Len=0 MSS=1460$/);
    expect(tcp[1].info).toMatch(/^80 → \d+ \[SYN, ACK\] Seq=0 Ack=1 Win=64240 Len=0 MSS=1460$/);
    expect(tcp[2].info).toMatch(/\[ACK\] Seq=1 Ack=1 /);
    expect(tcp[3].info).toBe('GET / HTTP/1.1');
    expect(tcp[4].info).toBe('HTTP/1.1 200 OK  (text/html)');
    expect(tcp[5].info).toMatch(/\[FIN, ACK\] Seq=\d+ Ack=\d+/);
  });
});
