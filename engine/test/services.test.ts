import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { arpTable } from '../src/sim/tables';
import { M24, run } from './helpers';

/** ПК (DHCP) — свитч — сервер (DHCP+DNS+HTTP). */
function lan() {
  const b = new TopologyBuilder('DHCP + DNS + веб', 11);
  const pc = b.add('pc', 'ПК');
  const sw = b.add('switch', 'Свитч');
  const srv = b.add('server', 'Сервер');
  b.dhcpClient(pc);
  b.ip(srv, 'Fa0', '192.168.1.2', M24);
  srv.config.dhcpPools = [{ name: 'LAN', network: '192.168.1.0', mask: M24, gateway: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', end: '192.168.1.110' }];
  srv.config.services = {
    dhcp: true,
    dns: { enabled: true, records: [{ name: 'site.local', address: '192.168.1.2' }] },
    http: { enabled: true, title: 'Привет', body: 'Это учебный сайт' },
  };
  b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(srv, 'Fa0', sw, 'Fa0/2', 'straight');
  return { b, pc, sw, srv };
}

describe('DHCP, DNS, HTTP', () => {
  it('ПК получает адрес по DHCP (DISCOVER/OFFER/REQUEST/ACK)', () => {
    const { b, pc } = lan();
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    const dhcp = sim.log.filter((e) => e.protocol === 'DHCP' && e.kind === 'frame').map((e) => e.packet!.dhcp!.op);
    expect([...new Set(dhcp)]).toEqual(['DISCOVER', 'OFFER', 'REQUEST', 'ACK']);
    expect(sim.rt(pc.id).dhcp[b.port(pc, 'Fa0').id]).toMatchObject({ state: 'bound', ip: '192.168.1.100', gateway: '192.168.1.1' });
  });

  it('открыть сайт по имени: DNS → TCP-рукопожатие → HTTP 200', () => {
    const { b, pc } = lan();
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    const out = run(sim, sim.openUrl(pc.id, 'http://site.local/'));
    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('Это учебный сайт');
    expect(run(sim, sim.ping(pc.id, 'site.local', 1))).toContain('получено = 1');
    expect(run(sim, sim.nslookup(pc.id, 'nope.local'))).toContain('NXDOMAIN');
  });

  it('HTTP выключен — соединение отклонено (RST)', () => {
    const { b, pc, srv } = lan();
    srv.config.services!.http!.enabled = false;
    const sim = new Simulator(b.project);
    sim.runUntilIdle();
    expect(run(sim, sim.openUrl(pc.id, '192.168.1.2'))).toContain('Соединение отклонено');
  });

  it('DHCP-сервер выключен — адрес не получен', () => {
    const { b, pc, srv } = lan();
    srv.config.services!.dhcp = false;
    const sim = new Simulator(b.project);
    const job = sim.renewDhcp(pc.id);
    expect(run(sim, job)).toContain('DHCP-сервер не ответил');
  });

  it('DHCP relay: сервер в другой подсети, роутер с ip helper-address', () => {
    const b = new TopologyBuilder('Relay', 13);
    const pc = b.add('pc', 'ПК');
    const r = b.add('router', 'Роутер');
    const srv = b.add('server', 'Сервер');
    b.dhcpClient(pc);
    b.ip(r, 'Gi0/0', '192.168.10.1', M24).ip(r, 'Gi0/1', '10.0.0.1', M24);
    b.ip(srv, 'Fa0', '10.0.0.2', M24).gateway(srv, '10.0.0.1');
    srv.config.services = { dhcp: true };
    srv.config.dhcpPools = [{ name: 'V10', network: '192.168.10.0', mask: M24, gateway: '192.168.10.1', start: '192.168.10.50', end: '192.168.10.60' }];
    b.link(pc, 'Fa0', r, 'Gi0/0', 'crossover');
    b.link(r, 'Gi0/1', srv, 'Fa0', 'crossover');

    // без helper — роутер не пересылает broadcast
    let sim = new Simulator(b.project);
    sim.runUntilIdle();
    expect(sim.rt(pc.id).dhcp[b.port(pc, 'Fa0').id].state).toBe('failed');
    expect(sim.log.some((e) => e.reason.includes('ip helper-address'))).toBe(true);

    b.port(r, 'Gi0/0').l3!.helperAddress = '10.0.0.2';
    sim = new Simulator(b.project);
    sim.runUntilIdle();
    expect(sim.rt(pc.id).dhcp[b.port(pc, 'Fa0').id]).toMatchObject({ state: 'bound', ip: '192.168.10.50' });
    expect(sim.log.filter((e) => e.action === 'relay').length).toBeGreaterThanOrEqual(4);
    expect(run(sim, sim.ping(pc.id, '10.0.0.2', 1))).toContain('получено = 1');
  });
});

describe('VLAN и router-on-a-stick', () => {
  function stick() {
    const b = new TopologyBuilder('VLAN', 21);
    const pc10 = b.add('pc', 'ПК VLAN10');
    const pc20 = b.add('pc', 'ПК VLAN20');
    const pc10b = b.add('pc', 'ПК2 VLAN10');
    const sw = b.add('switch', 'Свитч');
    const r = b.add('router', 'Роутер');
    b.vlan(sw, 10).vlan(sw, 20);
    b.access(sw, 'Fa0/1', 10).access(sw, 'Fa0/2', 20).access(sw, 'Fa0/3', 10).trunk(sw, 'Gi0/1');
    b.ip(pc10, 'Fa0', '192.168.10.10', M24).gateway(pc10, '192.168.10.1');
    b.ip(pc10b, 'Fa0', '192.168.10.11', M24).gateway(pc10b, '192.168.10.1');
    b.ip(pc20, 'Fa0', '192.168.20.10', M24).gateway(pc20, '192.168.20.1');
    b.subif(r, 'Gi0/0', 10, '192.168.10.1', M24).subif(r, 'Gi0/0', 20, '192.168.20.1', M24);
    b.link(pc10, 'Fa0', sw, 'Fa0/1', 'straight');
    b.link(pc20, 'Fa0', sw, 'Fa0/2', 'straight');
    b.link(pc10b, 'Fa0', sw, 'Fa0/3', 'straight');
    b.link(sw, 'Gi0/1', r, 'Gi0/0', 'straight');
    return { b, pc10, pc20, pc10b, sw, r };
  }

  it('межвлановая маршрутизация через сабинтерфейсы работает, теги 802.1Q на транке', () => {
    const { b, pc10, sw, r } = stick();
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pc10.id, '192.168.20.10'))).toContain('получено = 4');
    const trunkFrames = sim.log.filter((e) => e.deviceId === r.id && e.kind === 'frame');
    expect(new Set(trunkFrames.map((e) => e.packet!.l2.vlanTag))).toEqual(new Set([10, 20]));
    expect(arpTable(sim, r.id).map((x) => x.iface).sort()).toEqual(['Gi0/0.10', 'Gi0/0.20']);
    void sw;
  });

  it('broadcast не выходит за VLAN', () => {
    const { b, pc10, pc20 } = stick();
    const sim = new Simulator(b.project);
    run(sim, sim.ping(pc10.id, '192.168.10.11', 1));
    expect(sim.log.some((e) => e.deviceId === pc20.id)).toBe(false);
  });

  it('без сабинтерфейса для VLAN 20 — кадр отброшен с понятной причиной', () => {
    const { b, pc20, r } = stick();
    b.port(r, 'Gi0/0').subinterfaces = b.port(r, 'Gi0/0').subinterfaces!.filter((s) => s.dot1q !== 20);
    const sim = new Simulator(b.project);
    run(sim, sim.ping(pc20.id, '192.168.10.10', 1));
    expect(sim.log.some((e) => e.reason.includes('нет сабинтерфейса с encapsulation dot1q 20'))).toBe(true);
  });
});
