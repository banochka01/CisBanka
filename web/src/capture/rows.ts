// Колонки списка пакетов считаются лениво и кэшируются на захват.
// Относительные номера TCP зависят от предыдущих кадров, поэтому строки считаются по порядку.
import { decodeFrame, packetBytes, summarize, TcpSeqContext, type Capture, type CapturedFrame, type Summary } from '@ciscobanka/engine';

export interface Row extends Summary {
  no: number;
  /** Секунды от первого кадра захвата. */
  time: number;
  length: number;
  frame: CapturedFrame;
}

interface Cache {
  rows: Row[];
  ctx: TcpSeqContext;
}

const caches = new WeakMap<Capture, Cache>();

/** Строки 0..upTo-1 (досчитывает недостающие). */
export function rowsOf(cap: Capture, upTo = cap.frames.length): Row[] {
  let c = caches.get(cap);
  const frames = cap.frames;
  // Кадры «будущего» убрали (шаг назад, очистка) — пересчитываем с нуля.
  if (c && (c.rows.length > frames.length || (c.rows.length && c.rows[c.rows.length - 1].frame !== frames[c.rows.length - 1]))) c = undefined;
  if (!c) {
    c = { rows: [], ctx: new TcpSeqContext() };
    caches.set(cap, c);
  }
  const t0 = frames[0]?.time ?? 0;
  for (let i = c.rows.length; i < Math.min(upTo, frames.length); i++) {
    const f = frames[i];
    const bytes = packetBytes(f.packet);
    c.rows.push({ ...summarize(decodeFrame(bytes), c.ctx), no: f.no, time: (f.time - t0) / 1000, length: bytes.length, frame: f });
  }
  return c.rows;
}

/** CSS-класс цвета строки, как раскраска по умолчанию в Wireshark. */
export function rowClass(r: Row): string {
  if (r.protocol === 'TCP' && /\[(?:[^\]]*\b)?RST\b/.test(r.info)) return 'pk-rst';
  if (r.protocol === 'TCP' && /\[(?:SYN|FIN)|, (?:SYN|FIN)/.test(r.info)) return 'pk-tcp-ctl';
  if (r.protocol === 'ICMP' && !r.info.startsWith('Echo')) return 'pk-icmp-err';
  return `pk-${r.protocol.toLowerCase()}`;
}
