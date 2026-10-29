import type { IpBody, Packet } from '../model/packet';
import type { IPv4, MAC } from '../model/topology';

export interface ArpEntry {
  mac: MAC;
  ifaceId: string;
  expires: number;
}

export interface MacEntry {
  vlan: number;
  mac: MAC;
  portId: string;
  updated: number;
}

export interface PendingArp {
  ifaceId: string;
  ip: IPv4;
  packets: IpBody[];
}

export interface DhcpClientState {
  state: 'selecting' | 'requesting' | 'bound' | 'failed';
  xid: number;
  jobId: number;
  ip?: IPv4;
  mask?: IPv4;
  gateway?: IPv4;
  dns?: IPv4;
  server?: IPv4;
}

export interface DhcpLease {
  ip: IPv4;
  mac: MAC;
  pool: string;
}

export interface DeviceRuntime {
  macTable: MacEntry[];
  arp: Record<IPv4, ArpEntry>;
  /** ключ: `${ifaceId}|${nextHopIp}` */
  pendingArp: Record<string, PendingArp>;
  /** DHCP-клиент, ключ — id интерфейса */
  dhcp: Record<string, DhcpClientState>;
  leases: DhcpLease[];
}

export type JobKind = 'ping' | 'traceroute' | 'http' | 'nslookup' | 'dhcp';

/** Задача «Инструментов» ПК: ping, traceroute, открыть сайт… Вывод — строки текста. */
export interface Job {
  id: number;
  kind: JobKind;
  deviceId: string;
  target: string;
  lines: string[];
  done: boolean;
  phase: 'dns' | 'run' | 'syn' | 'wait';
  ip?: IPv4;
  // ping
  count?: number;
  sentAt?: Record<number, number>;
  results?: Record<number, 'ok' | 'lost' | 'err'>;
  rtts?: number[];
  // traceroute
  ttl?: number;
  answeredTtl?: number;
  // http
  path?: string;
  srcPort?: number;
}

export type Timer =
  | { t: 'ping-send'; job: number; seq: number }
  | { t: 'ping-timeout'; job: number; seq: number }
  | { t: 'trace-send'; job: number; ttl: number }
  | { t: 'trace-timeout'; job: number; ttl: number }
  | { t: 'dns-timeout'; job: number }
  | { t: 'http-timeout'; job: number }
  | { t: 'dhcp-start'; job: number; ifaceId: string }
  | { t: 'dhcp-timeout'; job: number; ifaceId: string; xid: number }
  | { t: 'arp-timeout'; key: string };

export type QEvent = { seq: number; time: number } & (
  | {
      kind: 'rx';
      deviceId: string;
      portId: string;
      linkId: string;
      fromDeviceId: string;
      fromPortId: string;
      sentAt: number;
      packet: Packet;
    }
  | { kind: 'timer'; deviceId: string; timer: Timer }
);

/** Всё изменяемое состояние симуляции — целиком попадает в снапшот. */
export interface SimState {
  time: number;
  seq: number;
  nextId: number;
  rng: number;
  queue: QEvent[];
  rt: Record<string, DeviceRuntime>;
  jobs: Record<number, Job>;
  tick: { t: number; n: number };
}

export function emptyRuntime(): DeviceRuntime {
  return { macTable: [], arp: {}, pendingArp: {}, dhcp: {}, leases: [] };
}
