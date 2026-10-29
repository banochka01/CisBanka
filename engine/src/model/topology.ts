// Топология и конфигурация — то, что сохраняется в проект.
// Состояние «во время работы» (таблицы, очереди) живёт отдельно в sim/state.ts.

export type DeviceKind = 'router' | 'switch' | 'pc' | 'laptop' | 'server' | 'hub';
/** MAC в формате Cisco: 0060.5C3A.1B01 */
export type MAC = string;
export type IPv4 = string;
export type CableType = 'straight' | 'crossover' | 'fiber';
export type Media = 'copper' | 'fiber';
export type NatRole = 'inside' | 'outside';
/** Поле под STP. Пока реализовано только как фильтр: не-forwarding порт не пропускает кадры. */
export type StpState = 'disabled' | 'blocking' | 'listening' | 'learning' | 'forwarding';

export interface IpAddress {
  addr: IPv4;
  /** Маска в точечной записи: 255.255.255.0 */
  mask: IPv4;
}

/** L3-настройки интерфейса (физического или сабинтерфейса). */
export interface L3Config {
  ip?: IpAddress;
  /** Получать адрес по DHCP (для хостов). */
  dhcp?: boolean;
  /** DHCP relay (ip helper-address) — только роутер. */
  helperAddress?: IPv4;
  /** NAT: роль интерфейса. Реализация позже. */
  nat?: NatRole;
}

/** Сабинтерфейс роутера, например Gi0/0.10 encapsulation dot1q 10. MAC — как у родительского порта. */
export interface SubInterface {
  id: string;
  name: string;
  dot1q: number;
  adminUp: boolean;
  l3: L3Config;
}

export interface SwitchportConfig {
  mode: 'access' | 'trunk';
  accessVlan: number;
  nativeVlan: number;
  /** Разрешённые VLAN на транке; undefined = все. */
  allowedVlans?: number[];
}

export interface Port {
  id: string;
  name: string;
  media: Media;
  mac: MAC;
  adminUp: boolean;
  l3?: L3Config;
  subinterfaces?: SubInterface[];
  switchport?: SwitchportConfig;
  stpState?: StpState;
  stpCost?: number;
}

export interface StaticRoute {
  network: IPv4;
  mask: IPv4;
  nextHop: IPv4;
}

export interface DhcpPool {
  name: string;
  network: IPv4;
  mask: IPv4;
  gateway?: IPv4;
  dns?: IPv4;
  start: IPv4;
  end: IPv4;
}

export interface Vlan {
  id: number;
  name: string;
}

export interface DnsRecord {
  name: string;
  address: IPv4;
}

export interface NatStaticRule {
  insideLocal: IPv4;
  insideGlobal: IPv4;
}

/** NAT — только модель, реализация позже. */
export interface NatConfig {
  staticRules: NatStaticRule[];
  pat?: {
    enabled: boolean;
    insideNetwork: IPv4;
    insideMask: IPv4;
    /** id порта/сабинтерфейса, чей адрес используется для PAT (overload) */
    outsideInterfaceId: string;
  };
}

export interface ServicesConfig {
  dhcp?: boolean;
  dns?: { enabled: boolean; records: DnsRecord[] };
  http?: { enabled: boolean; title: string; body: string };
}

export interface DeviceConfig {
  /** Auto-MDIX: если включён хотя бы на одном конце, тип медного кабеля не важен. */
  autoMdix: boolean;
  gateway?: IPv4;
  dns?: IPv4;
  staticRoutes?: StaticRoute[];
  /** DHCP-пулы (роутер или сервер с включённым сервисом DHCP). */
  dhcpPools?: DhcpPool[];
  vlans?: Vlan[];
  /** Поле под STP. Реализация позже. */
  bridgePriority?: number;
  nat?: NatConfig;
  services?: ServicesConfig;
}

export type PhysicalPlace = { place: 'rack'; unit: number } | { place: 'desk'; slot: number };

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  position: { x: number; y: number };
  physical?: PhysicalPlace;
  ports: Port[];
  config: DeviceConfig;
}

export interface LinkEnd {
  deviceId: string;
  portId: string;
}

export interface Link {
  id: string;
  cable: CableType;
  a: LinkEnd;
  b: LinkEnd;
}

export interface Project {
  schemaVersion: number;
  name: string;
  /** Зерно PRNG: MAC-адреса, DHCP xid и всё случайное детерминированы. */
  seed: number;
  devices: Device[];
  links: Link[];
}
