import type { Device, Link, Project } from '@ciscobanka/engine';

export const CABLE_LABELS = { straight: 'Медь, прямой', crossover: 'Медь, кроссовер', fiber: 'Оптика' } as const;

export function portName(p: Project, deviceId: string, portId: string) {
  const d = p.devices.find((x) => x.id === deviceId);
  return { device: d?.name ?? '?', port: d?.ports.find((x) => x.id === portId)?.name ?? '?' };
}

export function linkOfPort(p: Project, portId: string): Link | undefined {
  return p.links.find((l) => l.a.portId === portId || l.b.portId === portId);
}

/** С кем соединён порт: «ПК1 Fa0». */
export function peerLabel(p: Project, portId: string): string | null {
  const l = linkOfPort(p, portId);
  if (!l) return null;
  const peer = l.a.portId === portId ? l.b : l.a;
  const n = portName(p, peer.deviceId, peer.portId);
  return `${n.device} ${n.port}`;
}

/** Интерфейсы, на которых задан IP, но они выключены (shutdown) — частая ошибка новичка. */
export function shutdownWithIp(d: Device): { portId: string; name: string }[] {
  return d.ports
    .filter((p) => !p.adminUp && (p.l3?.ip || p.subinterfaces?.some((s) => s.l3.ip)))
    .map((p) => ({ portId: p.id, name: p.name }));
}
