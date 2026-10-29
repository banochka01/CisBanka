import type { CableType, Device, DeviceKind, Link, Media, Port, Project } from './topology';
import { deriveMac } from '../util/prng';

export const DEVICE_LABELS: Record<DeviceKind, string> = {
  router: 'Роутер',
  switch: 'Свитч',
  pc: 'ПК',
  laptop: 'Ноутбук',
  server: 'Сервер',
  hub: 'Хаб',
};

function portList(kind: DeviceKind): { name: string; media: Media }[] {
  const cu = (name: string) => ({ name, media: 'copper' as const });
  switch (kind) {
    case 'router':
      return [cu('Gi0/0'), cu('Gi0/1'), cu('Gi0/2'), { name: 'Gi0/3', media: 'fiber' }];
    case 'switch':
      return [
        ...Array.from({ length: 24 }, (_, i) => cu(`Fa0/${i + 1}`)),
        cu('Gi0/1'),
        { name: 'Gi0/2', media: 'fiber' },
      ];
    case 'hub':
      return Array.from({ length: 8 }, (_, i) => cu(`Port${i}`));
    default:
      return [cu('Fa0')];
  }
}

/** Создаёт устройство с портами по умолчанию. MAC выводятся из зерна проекта. */
export function createDevice(
  kind: DeviceKind,
  id: string,
  name: string,
  seed: number,
  position = { x: 0, y: 0 },
): Device {
  const ports: Port[] = portList(kind).map((p, i) => {
    const port: Port = { id: `${id}:${p.name}`, name: p.name, media: p.media, mac: deriveMac(seed, id, i), adminUp: true };
    if (kind === 'switch') {
      port.switchport = { mode: 'access', accessVlan: 1, nativeVlan: 1 };
      port.adminUp = true;
    } else if (kind !== 'hub') {
      port.l3 = {};
    }
    return port;
  });
  // Как в Cisco: интерфейсы роутера по умолчанию выключены (shutdown).
  if (kind === 'router') ports.forEach((p) => (p.adminUp = false));
  return {
    id,
    kind,
    name,
    position,
    ports,
    config: {
      autoMdix: false,
      ...(kind === 'switch' ? { vlans: [{ id: 1, name: 'default' }], bridgePriority: 32768 } : {}),
    },
  };
}

export function cableFitsPort(cable: CableType, port: Port): boolean {
  return cable === 'fiber' ? port.media === 'fiber' : port.media === 'copper';
}

/** Удобный построитель топологий — используется в тестах и готовых примерах. */
export class TopologyBuilder {
  readonly project: Project;
  private counters: Record<string, number> = {};

  constructor(name = 'Проект', seed = 1) {
    this.project = { schemaVersion: 1, name, seed, devices: [], links: [] };
  }

  add(kind: DeviceKind, name: string, position = { x: 0, y: 0 }): Device {
    const n = (this.counters[kind] = (this.counters[kind] ?? 0) + 1);
    const d = createDevice(kind, `${kind}${n}`, name, this.project.seed, position);
    this.project.devices.push(d);
    return d;
  }

  port(d: Device, name: string): Port {
    const p = d.ports.find((x) => x.name === name);
    if (!p) throw new Error(`У ${d.name} нет порта ${name}`);
    return p;
  }

  /** Задать IP на порту (и включить его). */
  ip(d: Device, portName: string, addr: string, mask: string): this {
    const p = this.port(d, portName);
    p.l3 = { ...p.l3, ip: { addr, mask }, dhcp: false };
    p.adminUp = true;
    return this;
  }

  dhcpClient(d: Device, portName = 'Fa0'): this {
    const p = this.port(d, portName);
    p.l3 = { ...p.l3, dhcp: true, ip: undefined };
    return this;
  }

  gateway(d: Device, gw: string): this {
    d.config.gateway = gw;
    return this;
  }

  subif(d: Device, portName: string, vlan: number, addr: string, mask: string): this {
    const p = this.port(d, portName);
    p.adminUp = true;
    (p.subinterfaces ??= []).push({
      id: `${p.id}.${vlan}`,
      name: `${p.name}.${vlan}`,
      dot1q: vlan,
      adminUp: true,
      l3: { ip: { addr, mask } },
    });
    return this;
  }

  vlan(sw: Device, id: number, name = `VLAN${id}`): this {
    (sw.config.vlans ??= []).push({ id, name });
    return this;
  }

  access(sw: Device, portName: string, vlan: number): this {
    this.port(sw, portName).switchport = { mode: 'access', accessVlan: vlan, nativeVlan: 1 };
    return this;
  }

  trunk(sw: Device, portName: string, allowedVlans?: number[]): this {
    this.port(sw, portName).switchport = { mode: 'trunk', accessVlan: 1, nativeVlan: 1, allowedVlans };
    return this;
  }

  link(a: Device, pa: string, b: Device, pb: string, cable: CableType): Link {
    const l: Link = {
      id: `link${this.project.links.length + 1}`,
      cable,
      a: { deviceId: a.id, portId: this.port(a, pa).id },
      b: { deviceId: b.id, portId: this.port(b, pb).id },
    };
    this.project.links.push(l);
    return l;
  }
}
