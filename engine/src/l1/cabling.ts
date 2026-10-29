import type { CableType, Device, Port } from '../model/topology';

/** Устройства с MDI-разъёмом (передача на 1-2). У свитчей и хабов — MDI-X. */
const MDI = new Set(['pc', 'laptop', 'server', 'router']);

export interface CableCheck {
  ok: boolean;
  reason?: string;
}

export function requiredCopperCable(a: Device, b: Device): 'straight' | 'crossover' {
  return MDI.has(a.kind) === MDI.has(b.kind) ? 'crossover' : 'straight';
}

export function checkCable(
  cable: CableType,
  a: { device: Device; port: Port },
  b: { device: Device; port: Port },
): CableCheck {
  if (cable === 'fiber') {
    const bad = [a, b].find((e) => e.port.media !== 'fiber');
    return bad
      ? { ok: false, reason: `Оптический кабель подключён к медному порту ${bad.port.name} на «${bad.device.name}»` }
      : { ok: true };
  }
  const bad = [a, b].find((e) => e.port.media !== 'copper');
  if (bad) return { ok: false, reason: `Медный кабель подключён к оптическому порту ${bad.port.name} на «${bad.device.name}»` };
  if (a.device.config.autoMdix || b.device.config.autoMdix) return { ok: true };
  const need = requiredCopperCable(a.device, b.device);
  if (cable !== need) {
    const needRu = need === 'crossover' ? 'кроссовер' : 'прямой кабель';
    const haveRu = cable === 'crossover' ? 'кроссовер' : 'прямой кабель';
    return {
      ok: false,
      reason: `Неверный тип кабеля: между «${a.device.name}» и «${b.device.name}» нужен ${needRu}, а подключён ${haveRu} (Auto-MDIX выключен) — линк не поднялся`,
    };
  }
  return { ok: true };
}
