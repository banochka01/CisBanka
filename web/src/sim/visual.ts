// Общее для отрисовки симуляции: цвета протоколов, подписи решений, геометрия проводов.
import type { LogEntry, Protocol, Simulator } from '@ciscobanka/engine';

export const PROTOCOLS: Protocol[] = ['ARP', 'ICMP', 'DHCP', 'DNS', 'HTTP', 'TCP', 'UDP'];

export const PROTO_COLORS: Record<Protocol, string> = {
  ARP: '#e0a91b',
  ICMP: '#d6457a',
  DHCP: '#2a9d5c',
  DNS: '#2f80d1',
  HTTP: '#8a4fd8',
  TCP: '#6b7a8c',
  UDP: '#139c9c',
};

export const PROTO_HINTS: Record<Protocol, string> = {
  ARP: 'поиск MAC-адреса по IP',
  ICMP: 'ping и сообщения об ошибках',
  DHCP: 'автоматическая выдача IP',
  DNS: 'имя → IP-адрес',
  HTTP: 'веб-страницы',
  TCP: 'установка соединения',
  UDP: 'прочие датаграммы',
};

/** Центр иконки устройства относительно левого верхнего угла узла. */
export const CENTER = { x: 40, y: 32 };

/** Габариты узла относительно центра иконки: иконка 64×64, под ней имя. */
const NODE_BOX = { left: 42, right: 42, up: 36, down: 54 };

/** Расстояние от центра узла до края его рамки вдоль направления (ux, uy). */
export function exitDist(ux: number, uy: number) {
  const tx = ux > 0 ? NODE_BOX.right / ux : ux < 0 ? NODE_BOX.left / -ux : Infinity;
  const ty = uy > 0 ? NODE_BOX.down / uy : uy < 0 ? NODE_BOX.up / -uy : Infinity;
  return Math.min(tx, ty);
}

const portName = (sim: Simulator, portId: string) => sim.portById(portId)?.port.name ?? '?';

/** Короткая подпись над устройством: что оно сделало с пакетом. */
export function decisionLabel(sim: Simulator, e: LogEntry): string {
  if (e.kind === 'send') return `Отправил в ${portName(sim, e.portId!)}`;
  if (e.kind === 'drop') return 'Сбросил';
  switch (e.action) {
    case 'flood':
      return 'Флуд';
    case 'forward':
      return e.out?.length ? `Переслал в ${e.out.map((o) => portName(sim, o.portId)).join(', ')}` : 'Ищу MAC (ARP)';
    case 'reply':
      return 'Ответил';
    case 'deliver':
      return 'Принял';
    case 'relay':
      return e.out?.length ? `Relay в ${e.out.map((o) => portName(sim, o.portId)).join(', ')}` : 'Relay';
    case 'drop':
      return 'Сбросил';
    default:
      return '';
  }
}
