import type { Packet, Protocol } from './packet';

export type Action = 'forward' | 'flood' | 'deliver' | 'reply' | 'relay' | 'drop';

export interface Verdict {
  action: Action;
  /** Объяснение простым языком — показывается в журнале и разборе пакета. */
  reason: string;
}

/** Кадр, который устройство отправило в порт в результате обработки. */
export interface OutFrame {
  portId: string;
  packet: Packet;
}

/**
 * Запись журнала.
 * - frame: устройство получило кадр и что-то с ним сделало (verdict);
 * - send: устройство само создало кадр (ping, DHCP, ARP по таймеру…) и отправило его;
 * - drop: кадр умер, не дойдя до провода (порт выключен, нет маршрута, ARP без ответа…);
 * - info: служебное сообщение;
 * - reset: состояние симуляции сброшено из-за изменения топологии/конфигурации.
 */
export interface LogEntry {
  id: number;
  time: number;
  kind: 'frame' | 'send' | 'drop' | 'info' | 'reset';
  /**
   * Номер шага движка, к которому относится запись: событие очереди №step.
   * Записи от внешних команд (ping из окна) относятся к следующему шагу.
   */
  step: number;
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
  /** Что устройство отправило дальше («Выход» в разборе пакета). */
  out?: OutFrame[];
}
