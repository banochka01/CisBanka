import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import type { LogEntry } from '../src/model/events';
import { twoPcsViaSwitch, twoSubnets } from './helpers';

const name = (sim: Simulator, id?: string) => (id ? sim.device(id).name : '?');
const arrivals = (es: LogEntry[]) => es.filter((e) => e.kind === 'frame');

describe('режим симуляции: шаг = хоп', () => {
  it('ping через свитч: каждый шаг — одно перемещение между устройствами', () => {
    const { b, pc1 } = twoPcsViaSwitch();
    const sim = new Simulator(b.project);
    sim.beginHops();
    sim.ping(pc1.id, '192.168.1.20', 1);
    const hops: string[] = [];
    let es: LogEntry[] | null;
    while ((es = sim.stepHop())) {
      const moves = arrivals(es).map((e) => `${name(sim, e.fromDeviceId)}→${name(sim, e.deviceId)}`);
      if (moves.length) hops.push(moves.join(','));
    }
    // ARP-запрос: ПК1→свитч, свитч флудит → ПК2; ARP-ответ: ПК2→свитч→ПК1; затем эхо туда и обратно
    expect(hops).toEqual(['ПК1→Свитч', 'Свитч→ПК2', 'ПК2→Свитч', 'Свитч→ПК1', 'ПК1→Свитч', 'Свитч→ПК2', 'ПК2→Свитч', 'Свитч→ПК1']);
  });

  it('исходящие кадры записываются в «Выход»: флуд свитча — все порты кроме входного', () => {
    const { b, pc1, sw } = twoPcsViaSwitch();
    b.add('pc', 'ПК3');
    const pc3 = b.project.devices.at(-1)!;
    b.ip(pc3, 'Fa0', '192.168.1.30', '255.255.255.0').link(pc3, 'Fa0', sw, 'Fa0/3', 'straight');
    const sim = new Simulator(b.project);
    sim.beginHops();
    sim.ping(pc1.id, '192.168.1.20', 1);
    const es = sim.stepHop()!;
    const send = es.find((e) => e.kind === 'send')!;
    expect(send.deviceId).toBe(pc1.id);
    expect(send.packet?.arp?.op).toBe('request');
    const atSwitch = arrivals(es)[0];
    expect(atSwitch.action).toBe('flood');
    expect(atSwitch.out!.map((o) => sim.portById(o.portId)!.port.name).sort()).toEqual(['Fa0/2', 'Fa0/3']);
    // отправка и приход кадра — в одном хопе
    expect(sim.hopEntries(1)).toContain(send);
  });

  it('шаг назад по хопам и перемотка к хопу дают тот же журнал', () => {
    const { b, pc1 } = twoSubnets();
    const sim = new Simulator(b.project, { checkpointEvery: 3 });
    sim.beginHops();
    sim.ping(pc1.id, '192.168.2.10', 2);
    for (let i = 0; i < 12; i++) sim.stepHop();
    const ref = JSON.stringify([sim.log, sim.state]);
    const first = sim.hopEntries(1)[0];
    expect(sim.hopOf(first)).toBe(1);
    const hop5 = JSON.stringify(sim.hopEntries(5));
    expect(sim.hop).toBe(12);
    for (let i = 0; i < 4; i++) expect(sim.stepBackHop()).toBe(true);
    expect(sim.hop).toBe(8);
    expect(sim.seekHop(5)).toBe(true);
    expect(JSON.stringify(sim.hopEntries())).toBe(hop5);
    for (let i = 0; i < 7; i++) sim.stepHop();
    expect(JSON.stringify([sim.log, sim.state])).toBe(ref);
    while (sim.stepBackHop());
    expect(sim.hop).toBe(0);
    // будущее не потеряно: просчитанные хопы и журнал на месте
    expect(sim.hopCount).toBe(12);
    expect(sim.hopOf(first)).toBe(1);
  });

  it('перемотка не теряет будущее; команды переигрываются, перемотка раньше отправки не удаляет пакет', () => {
    const { b, pc1, pc2 } = twoSubnets();
    const sim = new Simulator(b.project, { checkpointEvery: 4 });
    sim.beginHops();
    sim.ping(pc1.id, '192.168.2.10', 1);
    sim.primeHop();
    for (let i = 0; i < 5; i++) sim.stepHop();
    // вторая команда посреди симуляции — «Простой пакет» с ПК2
    const job2 = sim.ping(pc2.id, '192.168.1.10', 1);
    const cmd2 = sim.commands[1];
    expect(cmd2).toMatchObject({ kind: 'ping', deviceId: pc2.id, step: sim.state.step, time: sim.now });
    sim.primeHop();
    while (sim.stepHop());
    const total = sim.hopCount;
    const ref = JSON.stringify([sim.log, sim.state]);
    expect(sim.commandJob(cmd2.id)?.id).toBe(job2.id);
    expect(sim.commandJob(cmd2.id)?.results?.[1]).toBe('ok');

    // назад к хопу 2 — раньше второй команды: её задачи ещё нет, но команда и будущее целы
    expect(sim.seekHop(2)).toBe(true);
    expect(sim.commandJob(cmd2.id)).toBeUndefined();
    expect(sim.commands).toHaveLength(2);
    expect(sim.hopCount).toBe(total);
    expect(sim.logCursor).toBeLessThan(sim.log.length);
    const future = sim.log.slice(sim.logCursor).map((e) => e.id);
    expect(future.length).toBeGreaterThan(0);

    // назад к хопу 5 — ровно момент отправки: пакет снова у отправителя, задача есть
    expect(sim.seekHop(5)).toBe(true);
    expect(sim.commandJob(cmd2.id)?.done).toBe(false);
    expect(sim.pending.some((e) => e.kind === 'rx' && e.fromDeviceId === pc2.id)).toBe(true);

    // назад до начала и вперёд по серому будущему — тот же журнал и состояние
    expect(sim.seekHop(0)).toBe(true);
    expect(sim.commandJob(sim.commands[0].id)).toBeDefined();
    while (sim.stepHop());
    expect(sim.hop).toBe(total);
    expect(JSON.stringify([sim.log, sim.state])).toBe(ref);

    // перемотка вперёд кликом по будущей строке журнала
    sim.seekHop(1);
    expect(sim.seekHop(7)).toBe(true);
    expect(sim.hop).toBe(7);
  });

  it('новая команда в прошлом отменяет просчитанное будущее', () => {
    const { b, pc1 } = twoSubnets();
    const sim = new Simulator(b.project);
    sim.beginHops();
    sim.ping(pc1.id, '192.168.2.10', 1);
    while (sim.stepHop());
    sim.seekHop(3);
    sim.ping(pc1.id, '192.168.1.1', 1);
    expect(sim.hopCount).toBe(3);
    expect(sim.logCursor).toBe(sim.log.length);
    expect(sim.commands).toHaveLength(2);
  });

  it('сброс кадра у отправителя (нет кабеля) знает порт — для крестика у порта', () => {
    const { b, pc1 } = twoPcsViaSwitch();
    b.project.links = b.project.links.filter((l) => l.a.deviceId !== pc1.id && l.b.deviceId !== pc1.id);
    const sim = new Simulator(b.project);
    sim.beginHops();
    sim.ping(pc1.id, '192.168.1.20', 1);
    while (sim.stepHop());
    const d = sim.log.find((e) => e.kind === 'drop' && e.deviceId === pc1.id);
    expect(d?.portId).toBe(pc1.ports[0].id);
  });
});
