// Единственный экземпляр симулятора для UI. Топология живёт в Zustand,
// симулятор получает её копию через setTopology (Runtime при этом сбрасывается).
import { Simulator, type Project } from '@ciscobanka/engine';

export type SimMode = 'realtime' | 'simulation';

let sim: Simulator | null = null;
let mode: SimMode = 'realtime';
/** С какой записи журнала начинается текущий сеанс режима симуляции. */
let journalFrom = 0;

export function getSim(): Simulator {
  if (!sim) throw new Error('Симулятор ещё не создан');
  return sim;
}

export const getMode = () => mode;
export const getJournalFrom = () => journalFrom;

/**
 * Применить топологию. В реальном времени — сразу досчитать всё (DHCP и т.п.),
 * в режиме симуляции — начать пошаговый сеанс заново (сброс виден в журнале).
 */
export function syncSim(project: Project, reason?: string) {
  if (!sim) sim = new Simulator(project);
  else {
    if (mode === 'simulation') journalFrom = sim.log.length;
    sim.setTopology(project, reason);
  }
  settle();
}

export function setMode(m: SimMode) {
  const s = getSim();
  mode = m;
  if (m === 'simulation') {
    journalFrom = s.log.length;
    s.beginHops();
    s.primeHop();
  } else s.runUntilIdle();
}

/** После команды (ping, DHCP…): в реальном времени — досчитать до конца, в симуляции — ждать шагов. */
export function settle() {
  if (mode === 'realtime') getSim().runUntilIdle();
  else getSim().primeHop();
}
