// Пакет модели → настоящие байты кадра Ethernet.
// Кодирование чисто функциональное и детерминированное: одинаковый пакет — одинаковые байты.
import type { IpBody, Packet } from '../model/packet';
import { encodeArp } from './arp';
import { encodeDhcp } from './dhcp';
import { encodeDns } from './dns';
import { encodeEthernet, ETH_ARP, ETH_IPV4 } from './ethernet';
import { encodeHttp } from './http';
import { encodeIcmp } from './icmp';
import { encodeIpv4, PROTO_NUM } from './ipv4';
import { encodeTcp } from './tcp';
import { encodeUdp } from './udp';

type IpPart = Pick<IpBody, 'l3' | 'l4' | 'icmp' | 'dhcp' | 'dns' | 'http'>;

function tcpPayload(p: IpPart): Uint8Array {
  if (!p.http) return new Uint8Array(0);
  const all = encodeHttp(p.http);
  return p.l4?.chunk ? all.subarray(p.l4.chunk[0], p.l4.chunk[1]) : all;
}

function l4Bytes(p: IpPart): Uint8Array {
  const { l3, l4 } = p;
  switch (l3.proto) {
    case 'ICMP': {
      const icmp = p.icmp ?? { type: 'echo-request' as const, id: 0, seq: 0 };
      // В ошибку ICMP вкладываются заголовок исходного IP-пакета и первые 8 байт его данных.
      const quoted = icmp.originalPacket ? encodeIpDatagram(icmp.originalPacket).subarray(0, 28) : undefined;
      return encodeIcmp(icmp, quoted);
    }
    case 'UDP': {
      const payload = p.dhcp ? encodeDhcp(p.dhcp) : p.dns ? encodeDns(p.dns) : new Uint8Array(0);
      return encodeUdp(l3.src, l3.dst, l4?.srcPort ?? 0, l4?.dstPort ?? 0, payload);
    }
    case 'TCP':
      return encodeTcp({
        src: l3.src,
        dst: l3.dst,
        srcPort: l4?.srcPort ?? 0,
        dstPort: l4?.dstPort ?? 0,
        seq: l4?.seq ?? 0,
        ack: l4?.ack ?? 0,
        flags: l4?.flags ?? [],
        window: l4?.window ?? 0,
        mss: l4?.mss,
        payload: tcpPayload(p),
      });
  }
}

/** IP-датаграмма целиком (заголовок + L4). */
export function encodeIpDatagram(p: IpPart): Uint8Array {
  return encodeIpv4({
    src: p.l3.src,
    dst: p.l3.dst,
    ttl: p.l3.ttl,
    proto: PROTO_NUM[p.l3.proto],
    id: p.l3.ipId ?? 0,
    // Как у Windows/Linux: TCP идёт с запретом фрагментации.
    dontFragment: p.l3.proto === 'TCP',
    payload: l4Bytes(p),
  });
}

/** Кадр Ethernet II без FCS (так его пишет libpcap с linktype Ethernet). */
export function encodeFrame(p: Packet): Uint8Array {
  if (p.arp) return encodeEthernet(p.l2.dst, p.l2.src, ETH_ARP, encodeArp(p.arp), p.l2.vlanTag);
  if (p.l3) return encodeEthernet(p.l2.dst, p.l2.src, ETH_IPV4, encodeIpDatagram(p as IpPart), p.l2.vlanTag);
  return encodeEthernet(p.l2.dst, p.l2.src, p.l2.etherType === 'ARP' ? ETH_ARP : ETH_IPV4, new Uint8Array(0), p.l2.vlanTag);
}
