/**
 * mulberry32: состояние — одно 32-битное число, поэтому оно целиком
 * попадает в снапшот и шаг назад/вперёд даёт те же «случайные» значения.
 */
export function mulberry32(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Детерминированный MAC порта: зависит только от зерна проекта, id устройства и номера порта. */
export function deriveMac(seed: number, deviceId: string, portIndex: number): string {
  const [r1, s] = mulberry32(fnv1a(`${seed}:${deviceId}:${portIndex}`));
  const [r2] = mulberry32(s);
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  return `00D0.${hex(Math.floor(r1 * 65536))}.${hex(Math.floor(r2 * 65536))}`;
}
