import type { Packet, Protocol } from './packet';

export type Action = 'forward' | 'flood' | 'deliver' | 'reply' | 'relay' | 'drop';

export interface Verdict {
  action: Action;
  /** Объяснение простым языком — показывается в журнале и разборе пакета. */
  reason: string;
}

/**
 * Запись журнала.
 * - frame: устройство получило кадр и что-то с ним сделало (verdict);
 * - drop: кадр умер, не дойдя до провода (порт выключен, нет маршрута, ARP без ответа…);
 * - info: служебное сообщение;
 * - reset: состояние симуляции сброшено из-за изменения топологии/конфигурации.
 */
export interface LogEntry {
  id: number;
  time: number;
  kind: 'frame' | 'drop' | 'info' | 'reset';
  deviceId?: string;
  portId?: string;
  fromDeviceId?: string;
  fromPortId?: string;
  linkId?: string;
  /** Момент, когда кадр ушёл в провод (для анимации конверта: sentAt → time). */
  sentAt?: number;
  protocol?: Protocol;
  packet?: Packet;
  action?: Action;
  reason: string;
}
