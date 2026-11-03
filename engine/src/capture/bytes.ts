// Байты кадра модели. Отдельный модуль: кодировщики нужны только анализатору и экспорту,
// а не схеме, поэтому при ленивой загрузке остаются в чанке анализатора.
import type { Packet } from '../model/packet';
import { encodeFrame } from '../wire/encode';

// Пакеты модели не мутируются, поэтому байты можно кэшировать по объекту.
const bytesCache = new WeakMap<Packet, Uint8Array>();

/** Байты кадра (кодируются лениво, один раз). */
export function packetBytes(p: Packet): Uint8Array {
  let b = bytesCache.get(p);
  if (!b) {
    b = encodeFrame(p);
    bytesCache.set(p, b);
  }
  return b;
}
