// Linux-хост (эксперимент): настоящие кадры Linux 6.8 из VM v86 (tcpdump внутри VM,
// сценарий: ping ПК, wget с нашего сервера, ping с ПК) → модель движка и обратно.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TopologyBuilder } from '../src/model/devices';
import { Simulator } from '../src/sim/Simulator';
import { readPcap } from '../src/pcap';
import { encodeFrame, packetFromFrame } from '../src/wire';
import { M24 } from './helpers';

const frames = readPcap(new Uint8Array(readFileSync(new URL('./fixtures/linux-vm.pcap', import.meta.url)))).frames.map((f) => f.data);

describe('кадры настоящего Linux', () => {
  it('раскладываются в модель, а байты сохраняются точно', () => {
    const kinds = frames.map((b) => {
      const p = packetFromFrame(b);
      expect(encodeFrame(p)).toEqual(b);
      return p.l2.etherType === 'raw' ? 'raw' : p.arp ? 'ARP' : p.icmp ? 'ICMP' : p.http ? 'HTTP' : p.l3?.proto;
    });
    expect(kinds.filter((k) => k === 'raw').length).toBeGreaterThan(0); // IPv6 MLD/ND
    expect(kinds).toContain('ARP');
    expect(kinds).toContain('ICMP');
    expect(kinds).toContain('HTTP');
  });

  it('SYN от Linux (MSS, SACK, timestamps, window scale) — наш сервер отвечает SYN-ACK; IPv6 свитч рассылает, хосты игнорируют', () => {
    const b = new TopologyBuilder('linux', 5);
    const lx = b.add('linux', 'Linux');
    const sw = b.add('switch', 'Свитч');
    const pc = b.add('pc', 'ПК');
    const srv = b.add('server', 'Сервер');
    b.ip(pc, 'Fa0', '192.168.1.10', M24).ip(srv, 'Fa0', '192.168.1.2', M24);
    srv.config.services = { http: { enabled: true, title: 'T', body: 'B' } };
    b.link(lx, 'eth0', sw, 'Fa0/1', 'straight');
    b.link(pc, 'Fa0', sw, 'Fa0/2', 'straight');
    b.link(srv, 'Fa0', sw, 'Fa0/3', 'straight');
    // MAC сервера в записи — 00d0.dd06.3775: подставляем его, чтобы кадры Linux были адресованы нашему серверу.
    srv.ports[0].mac = '00D0.DD06.3775';
    const sim = new Simulator(b.project);
    const got: Uint8Array[] = [];
    sim.externalRx = (_d, _p, pkt) => (got.push(encodeFrame(pkt)), true);
    const port = sim.project.devices.find((d) => d.id === lx.id)!.ports[0].id;
    const syn = frames.find((f) => f.length > 54 && f[23] === 6 && (f[47] & 0x12) === 0x02)!;
    const ipv6 = frames.find((f) => f[12] === 0x86 && f[13] === 0xdd)!;
    const arp = frames.find((f) => f[12] === 0x08 && f[13] === 0x06 && f[38] === 192 && f[41] === 2)!;
    for (const f of [ipv6, arp, syn]) {
      sim.injectFrame(lx.id, port, packetFromFrame(f));
      sim.runUntilIdle();
    }
    const synAck = got.find((f) => f[23] === 6 && (f[47] & 0x12) === 0x12);
    expect(synAck).toBeDefined();
    // подтверждает именно ISN Linux + 1
    const isn = new DataView(syn.buffer, syn.byteOffset).getUint32(38);
    expect(new DataView(synAck!.buffer, synAck!.byteOffset).getUint32(42)).toBe((isn + 1) >>> 0);
    const v6 = sim.log.filter((e) => e.kind === 'frame' && e.protocol === 'OTHER');
    expect(v6.some((e) => e.action === 'flood')).toBe(true);
    expect(v6.filter((e) => e.deviceId !== sw.id).every((e) => e.action === 'drop')).toBe(true);
  });
});
