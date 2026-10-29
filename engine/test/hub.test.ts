import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { macTable } from '../src/sim/tables';
import { M24, run } from './helpers';

function hubLan() {
  const b = new TopologyBuilder('Хаб', 4);
  const hub = b.add('hub', 'Хаб');
  const pcs = [1, 2, 3].map((i) => {
    const pc = b.add('pc', `ПК${i}`);
    b.ip(pc, 'Fa0', `10.0.0.${i}`, M24);
    b.link(pc, 'Fa0', hub, `Port${i - 1}`, 'straight');
    return pc;
  });
  return { b, hub, pcs };
}

describe('хаб', () => {
  it('каждый кадр уходит во все порты, кроме входного — даже адресный', () => {
    const { b, hub, pcs } = hubLan();
    const sim = new Simulator(b.project);
    expect(run(sim, sim.ping(pcs[0].id, '10.0.0.2', 1))).toContain('получено = 1');

    const hubRx = sim.log.filter((e) => e.deviceId === hub.id);
    expect(hubRx.length).toBeGreaterThan(0);
    for (const e of hubRx) {
      expect(e.action).toBe('flood');
      // копии этого кадра пришли на все ПК, кроме отправителя
      const copies = sim.log.filter((x) => x.fromDeviceId === hub.id && x.packet!.frameId === e.packet!.frameId);
      expect(copies.map((x) => x.deviceId).sort()).toEqual(pcs.map((p) => p.id).filter((id) => id !== e.fromDeviceId).sort());
    }
    // эхо-ответ адресован ПК1, но ПК3 его тоже получил и отбросил как «не мой MAC»
    expect(sim.log.some((e) => e.deviceId === pcs[2].id && e.packet?.icmp?.type === 'echo-reply' && e.reason.includes('не мой'))).toBe(true);
  });

  it('у хаба нет MAC-таблицы', () => {
    const { b, hub, pcs } = hubLan();
    const sim = new Simulator(b.project);
    run(sim, sim.ping(pcs[0].id, '10.0.0.3', 2));
    expect(macTable(sim, hub.id)).toEqual([]);
    expect(sim.rt(hub.id).macTable).toHaveLength(0);
  });
});
