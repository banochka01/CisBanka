import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { migrateProject, SCHEMA_VERSION, ProjectFormatError } from '../src/model/project';
import { maskToPrefix } from '../src/util/ip';
import { twoSubnets } from './helpers';

describe('детерминизм и шаг назад', () => {
  it('одинаковое зерно — одинаковые MAC и xid; разное — разные', () => {
    const mk = (seed: number) => {
      const b = new TopologyBuilder('x', seed);
      const pc = b.add('pc', 'ПК');
      b.dhcpClient(pc);
      const sim = new Simulator(b.project);
      sim.step();
      return { mac: pc.ports[0].mac, xid: sim.rt(pc.id).dhcp[pc.ports[0].id].xid };
    };
    expect(mk(5)).toEqual(mk(5));
    expect(mk(5).mac).not.toBe(mk(6).mac);
    expect(mk(5).xid).not.toBe(mk(6).xid);
  });

  it('шаг назад и снова вперёд даёт тот же журнал', () => {
    const { b, pc1 } = twoSubnets();
    const sim = new Simulator(b.project);
    sim.ping(pc1.id, '192.168.2.10', 2);
    for (let i = 0; i < 30; i++) sim.step();
    const ref = JSON.stringify(sim.log);
    const refState = JSON.stringify(sim.state);
    for (let i = 0; i < 12; i++) expect(sim.stepBack()).toBe(true);
    expect(sim.log.length).toBeLessThan(JSON.parse(ref).length);
    for (let i = 0; i < 12; i++) sim.step();
    expect(JSON.stringify(sim.log)).toBe(ref);
    expect(JSON.stringify(sim.state)).toBe(refState);
  });

  it('изменение топологии сбрасывает Runtime с записью в журнале', () => {
    const { b, pc1 } = twoSubnets();
    const sim = new Simulator(b.project);
    sim.ping(pc1.id, '192.168.2.10', 1);
    sim.runUntilIdle();
    expect(Object.keys(sim.rt(pc1.id).arp)).toHaveLength(1);
    sim.setTopology(b.project, 'Изменён IP');
    expect(sim.log.at(-1)!.kind).toBe('reset');
    expect(sim.log.at(-1)!.reason).toContain('Изменён IP');
    expect(Object.keys(sim.rt(pc1.id).arp)).toHaveLength(0);
    expect(sim.canStepBack).toBe(false);
  });
});

describe('проект', () => {
  it('миграция v0 → текущая', () => {
    const p = migrateProject({ devices: [{ id: 'pc1', kind: 'pc', name: 'ПК', position: { x: 0, y: 0 }, ports: [], config: {} }] });
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect(p.seed).toBe(1);
    expect(p.devices[0].config.autoMdix).toBe(false);
  });

  it('отказ на мусоре и на будущей версии', () => {
    expect(() => migrateProject(42)).toThrow(ProjectFormatError);
    expect(() => migrateProject({ schemaVersion: 999, devices: [] })).toThrow(/более новой версии/);
  });

  it('маски', () => {
    expect(maskToPrefix('255.255.255.0')).toBe(24);
    expect(maskToPrefix('255.255.255.255')).toBe(32);
    expect(maskToPrefix('0.0.0.0')).toBe(0);
    expect(maskToPrefix('255.0.255.0')).toBeNull();
  });
});
