// Таблицы устройств для окна «Таблицы» (обновляются в реальном времени по ходу симуляции).
import type { Simulator } from './Simulator';
import { l3Interfaces, routingTable, type RouteRow } from '../l3/stack';

export interface MacRow { vlan: number; mac: string; port: string; age: number }
export interface ArpRow { ip: string; mac: string; iface: string; expiresIn: number }

export function macTable(sim: Simulator, deviceId: string): MacRow[] {
  const d = sim.device(deviceId);
  return sim
    .rt(deviceId)
    .macTable.filter((e) => sim.now - e.updated <= sim.opts.macAging)
    .map((e) => ({ vlan: e.vlan, mac: e.mac, port: d.ports.find((p) => p.id === e.portId)?.name ?? '?', age: sim.now - e.updated }))
    .sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
}

export function arpTable(sim: Simulator, deviceId: string): ArpRow[] {
  const ifs = l3Interfaces(sim, sim.device(deviceId));
  return Object.entries(sim.rt(deviceId).arp)
    .filter(([, e]) => e.expires > sim.now)
    .map(([ip, e]) => ({ ip, mac: e.mac, iface: ifs.find((i) => i.id === e.ifaceId)?.name ?? '?', expiresIn: e.expires - sim.now }));
}

export function routes(sim: Simulator, deviceId: string): RouteRow[] {
  return routingTable(sim, sim.device(deviceId));
}
