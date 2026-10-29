import { expect } from 'vitest';
import { TopologyBuilder } from '../src/model/devices';
import { Simulator } from '../src/sim/Simulator';
import type { Job } from '../src/sim/state';

export const M24 = '255.255.255.0';

/** Выполнить задачу до конца в «реальном времени» и вернуть вывод. */
export function run(sim: Simulator, job: Job): string {
  sim.runUntilIdle();
  expect(sim.job(job.id)!.done).toBe(true);
  return sim.job(job.id)!.lines.join('\n');
}

/** ПК1 — свитч — ПК2, одна подсеть. */
export function twoPcsViaSwitch() {
  const b = new TopologyBuilder('Два ПК через свитч', 42);
  const pc1 = b.add('pc', 'ПК1');
  const pc2 = b.add('pc', 'ПК2');
  const sw = b.add('switch', 'Свитч');
  b.ip(pc1, 'Fa0', '192.168.1.10', M24).ip(pc2, 'Fa0', '192.168.1.20', M24);
  b.link(pc1, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(pc2, 'Fa0', sw, 'Fa0/2', 'straight');
  return { b, pc1, pc2, sw };
}

/** ПК1 — свитч — роутер — ПК2, две подсети. */
export function twoSubnets() {
  const b = new TopologyBuilder('Две подсети', 7);
  const pc1 = b.add('pc', 'ПК1');
  const pc2 = b.add('pc', 'ПК2');
  const sw = b.add('switch', 'Свитч');
  const r = b.add('router', 'Роутер');
  b.ip(pc1, 'Fa0', '192.168.1.10', M24).gateway(pc1, '192.168.1.1');
  b.ip(pc2, 'Fa0', '192.168.2.10', M24).gateway(pc2, '192.168.2.1');
  b.ip(r, 'Gi0/0', '192.168.1.1', M24).ip(r, 'Gi0/1', '192.168.2.1', M24);
  b.link(pc1, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(sw, 'Gi0/1', r, 'Gi0/0', 'straight');
  b.link(pc2, 'Fa0', r, 'Gi0/1', 'crossover');
  return { b, pc1, pc2, sw, r };
}
