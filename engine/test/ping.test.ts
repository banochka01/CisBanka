import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { macTable, arpTable, routes } from '../src/sim/tables';
import { TopologyBuilder } from '../src/model/devices';
import { M24, run, twoPcsViaSwitch, twoSubnets } from './helpers';

describe('ping через свитч', () => {
  it('проходит 4 из 4, свитч учит MAC, ARP-кэши заполнены', () => {
    const { b, pc1, pc2, sw } = twoPcsViaSwitch();
    const sim = new Simulator(b.project);
    const out = run(sim, sim.ping(pc1.id, '192.168.1.20'));
    expect(out).toContain('получено = 4, потеряно = 0');
    expect(macTable(sim, sw.id).map((r) => r.port).sort()).toEqual(['Fa0/1', 'Fa0/2']);
    expect(arpTable(sim, pc1.id)[0]).toMatchObject({ ip: '192.168.1.20', mac: b.port(pc2, 'Fa0').mac });
    // первый ARP-запрос — flooding, дальше свитч шлёт адресно
    expect(sim.log.find((e) => e.deviceId === sw.id)!.action).toBe('flood');
    expect(sim.log.some((e) => e.deviceId === sw.id && e.action === 'forward')).toBe(true);
  });

  it('несуществующий адрес — ARP без ответа, 100% потерь', () => {
    const { b, pc1 } = twoPcsViaSwitch();
    const sim = new Simulator(b.project);
    const out = run(sim, sim.ping(pc1.id, '192.168.1.99', 2));
    expect(out).toContain('потеряно = 2');
    expect(sim.log.some((e) => e.reason.includes('ARP: никто не ответил'))).toBe(true);
  });
});

describe('ping через роутер', () => {
  it('проходит между подсетями, TTL уменьшается', () => {
    const { b, pc1, pc2, r } = twoSubnets();
    const sim = new Simulator(b.project);
    const out = run(sim, sim.ping(pc1.id, '192.168.2.10'));
    expect(out).toContain('получено = 4');
    expect(out).toContain('TTL=127');
    expect(routes(sim, r.id).filter((x) => x.type === 'C')).toHaveLength(2);
    expect(arpTable(sim, pc1.id)[0].ip).toBe('192.168.1.1'); // ПК знает MAC шлюза, а не ПК2
    expect(run(sim, sim.ping(pc2.id, '192.168.1.1'))).toContain('получено = 4');
  });

  it('статический маршрут через второй роутер + traceroute', () => {
    const b = new TopologyBuilder('Три сети', 3);
    const pc1 = b.add('pc', 'ПК1');
    const pc2 = b.add('pc', 'ПК2');
    const r1 = b.add('router', 'R1');
    const r2 = b.add('router', 'R2');
    b.ip(pc1, 'Fa0', '10.0.1.10', M24).gateway(pc1, '10.0.1.1');
    b.ip(pc2, 'Fa0', '10.0.3.10', M24).gateway(pc2, '10.0.3.1');
    b.ip(r1, 'Gi0/0', '10.0.1.1', M24).ip(r1, 'Gi0/1', '10.0.2.1', M24);
    b.ip(r2, 'Gi0/0', '10.0.2.2', M24).ip(r2, 'Gi0/1', '10.0.3.1', M24);
    r1.config.staticRoutes = [{ network: '10.0.3.0', mask: M24, nextHop: '10.0.2.2' }];
    r2.config.staticRoutes = [{ network: '10.0.1.0', mask: M24, nextHop: '10.0.2.1' }];
    b.link(pc1, 'Fa0', r1, 'Gi0/0', 'crossover');
    b.link(r1, 'Gi0/1', r2, 'Gi0/0', 'crossover');
    b.link(r2, 'Gi0/1', pc2, 'Fa0', 'crossover');
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pc1.id, '10.0.3.10'))).toContain('получено = 4');
    const tr = run(sim, sim.traceroute(pc1.id, '10.0.3.10'));
    expect(tr).toMatch(/1\s+\d+ мс\s+10\.0\.1\.1/);
    expect(tr).toMatch(/2\s+\d+ мс\s+10\.0\.2\.2/);
    expect(tr).toMatch(/3\s+\d+ мс\s+10\.0\.3\.10/);
    expect(tr).toContain('Трассировка завершена');
  });
});
