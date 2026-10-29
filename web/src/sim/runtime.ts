// Единственный экземпляр симулятора для UI. Топология живёт в Zustand,
// симулятор получает её копию через setTopology (Runtime при этом сбрасывается).
import { Simulator, type Project } from '@ciscobanka/engine';

let sim: Simulator | null = null;

export function getSim(): Simulator {
  if (!sim) throw new Error('Симулятор ещё не создан');
  return sim;
}

/** Режим реального времени: применить топологию и сразу досчитать всё (DHCP и т.п.). */
export function syncSim(project: Project, reason?: string) {
  if (!sim) sim = new Simulator(project);
  else sim.setTopology(project, reason);
  sim.runUntilIdle();
}
