import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { M24, run, twoPcsViaSwitch, twoSubnets } from './helpers';

describe('типичные ошибки воспроизводятся честно', () => {
  it('прямой кабель ПК—ПК: линк красный, ping не проходит; с Auto-MDIX — проходит', () => {
    const b = new TopologyBuilder('ПК-ПК', 1);
    const pc1 = b.add('pc', 'ПК1');
    const pc2 = b.add('pc', 'ПК2');
    b.ip(pc1, 'Fa0', '10.0.0.1', M24).ip(pc2, 'Fa0', '10.0.0.2', M24);
    const link = b.link(pc1, 'Fa0', pc2, 'Fa0', 'straight');
    let sim = new Simulator(b.project);
    expect(sim.portLed(link.a.portId)).toBe('red');
    run(sim, sim.ping(pc1.id, '10.0.0.2', 1));
    expect(sim.log.some((e) => e.kind === 'drop' && e.reason.includes('нужен кроссовер'))).toBe(true);

    pc1.config.autoMdix = true;
    sim = new Simulator(b.project);
    expect(sim.portLed(link.a.portId)).toBe('green');
    expect(run(sim, sim.ping(pc1.id, '10.0.0.2', 1))).toContain('получено = 1');
  });

  it('интерфейс роутера выключен (по умолчанию shutdown)', () => {
    const { b, pc1, r } = twoSubnets();
    b.port(r, 'Gi0/0').adminUp = false;
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pc1.id, '192.168.2.10', 1))).toContain('потеряно = 1');
    expect(sim.log.some((e) => e.reason.includes('выключен'))).toBe(true);
  });

  it('нет шлюза по умолчанию', () => {
    const { b, pc1 } = twoSubnets();
    pc1.config.gateway = undefined;
    const sim = new Simulator(b.project);
    const out = run(sim, sim.ping(pc1.id, '192.168.2.10', 1));
    expect(out).toContain('шлюз по умолчанию не задан');
  });

  it('неправильная маска: ПК думает, что получатель в его сети, шлюз не используется', () => {
    const { b, pc1 } = twoSubnets();
    b.port(pc1, 'Fa0').l3!.ip!.mask = '255.255.0.0';
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pc1.id, '192.168.2.10', 1))).toContain('потеряно = 1');
    // роутер получил ARP о чужом адресе и проигнорировал его
    expect(sim.log.some((e) => e.reason.includes('ARP-запрос ищет 192.168.2.10'))).toBe(true);
    expect(sim.log.some((e) => e.reason.includes('ARP: никто не ответил'))).toBe(true);
  });

  it('нет маршрута — ICMP Destination Unreachable', () => {
    const { b, pc1 } = twoSubnets();
    const sim = new Simulator(b.project);
    const out = run(sim, sim.ping(pc1.id, '8.8.8.8', 1));
    expect(out).toContain('Ответ от 192.168.1.1: Заданная сеть недоступна.');
  });

  it('петля маршрутизации — TTL истекает, ICMP Time Exceeded', () => {
    const b = new TopologyBuilder('Петля маршрутов', 5);
    const pc = b.add('pc', 'ПК');
    const r1 = b.add('router', 'R1');
    const r2 = b.add('router', 'R2');
    b.ip(pc, 'Fa0', '10.0.1.10', M24).gateway(pc, '10.0.1.1');
    b.ip(r1, 'Gi0/0', '10.0.1.1', M24).ip(r1, 'Gi0/1', '10.0.2.1', M24);
    b.ip(r2, 'Gi0/0', '10.0.2.2', M24);
    r1.config.staticRoutes = [{ network: '172.16.0.0', mask: '255.255.0.0', nextHop: '10.0.2.2' }];
    r2.config.staticRoutes = [
      { network: '172.16.0.0', mask: '255.255.0.0', nextHop: '10.0.2.1' },
      { network: '10.0.1.0', mask: M24, nextHop: '10.0.2.1' },
    ];
    b.link(pc, 'Fa0', r1, 'Gi0/0', 'crossover');
    b.link(r1, 'Gi0/1', r2, 'Gi0/0', 'crossover');
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pc.id, '172.16.0.5', 1))).toContain('Превышен срок жизни (TTL)');
    expect(sim.log.some((e) => e.reason.startsWith('TTL истёк'))).toBe(true);
  });

  it('кабель не подключён', () => {
    const { b, pc1 } = twoPcsViaSwitch();
    b.project.links = [];
    const sim = new Simulator(b.project);
    run(sim, sim.ping(pc1.id, '192.168.1.20', 1));
    expect(sim.log.some((e) => e.reason.includes('не подключён кабель'))).toBe(true);
  });
});

describe('петля L2 (broadcast storm)', () => {
  function ring(opts = {}) {
    const b = new TopologyBuilder('Кольцо', 9);
    const pc = b.add('pc', 'ПК');
    const s1 = b.add('switch', 'SW1');
    const s2 = b.add('switch', 'SW2');
    b.ip(pc, 'Fa0', '10.0.0.1', M24);
    b.link(pc, 'Fa0', s1, 'Fa0/1', 'straight');
    b.link(s1, 'Fa0/23', s2, 'Fa0/23', 'crossover');
    b.link(s1, 'Fa0/24', s2, 'Fa0/24', 'crossover');
    return { sim: new Simulator(b.project, opts), pc };
  }

  it('кольцо из двух свитчей: кадр отбрасывается с причиной «петля», симуляция завершается', () => {
    const { sim, pc } = ring();
    sim.ping(pc.id, '10.0.0.2', 1);
    const n = sim.runUntilIdle(50_000);
    expect(n).toBeLessThan(50_000);
    expect(sim.log.some((e) => e.action === 'drop' && e.reason.startsWith('Петля в сети'))).toBe(true);
  });

  it('лимит событий за такт срабатывает', () => {
    const { sim, pc } = ring({ maxEventsPerTick: 3, maxL2Hops: 1000 });
    sim.ping(pc.id, '10.0.0.2', 1);
    expect(sim.runUntilIdle(50_000)).toBeLessThan(50_000);
    expect(sim.log.some((e) => e.reason.includes('широковещательный шторм'))).toBe(true);
  });
});
