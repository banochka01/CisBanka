// ICMP (RFC 792): эхо-запрос/ответ, «получатель недостижим», «время жизни истекло».
import type { IcmpPayload } from '../model/packet';
import { internetChecksum, put16, u16, utf8, Writer } from './bytes';

/** 32 байта данных эхо-запроса — как у ping в Windows. */
export const ICMP_ECHO_DATA = utf8('abcdefghijklmnopqrstuvwabcdefghi');

export const ICMP_TYPE = { 'echo-reply': 0, 'dest-unreachable': 3, 'echo-request': 8, 'time-exceeded': 11 } as const;
export const UNREACH_CODE = { net: 0, host: 1, port: 3 } as const;

export interface IcmpHeader {
  type: number;
  code: number;
  checksum: number;
  checksumOk: boolean;
  /** Для эха: identifier и sequence number. */
  id: number;
  seq: number;
  dataStart: number;
  dataLen: number;
}

/** quoted — для ошибок: IP-заголовок исходного пакета + первые 8 байт его данных. */
export function encodeIcmp(m: IcmpPayload, quoted?: Uint8Array): Uint8Array {
  const echo = m.type === 'echo-request' || m.type === 'echo-reply';
  const w = new Writer().u8(ICMP_TYPE[m.type]).u8(m.type === 'dest-unreachable' ? UNREACH_CODE[m.code ?? 'net'] : 0).u16(0);
  if (echo) w.u16(m.id & 0xffff).u16(m.seq & 0xffff).bytes(ICMP_ECHO_DATA);
  else w.u32(0).bytes(quoted ?? new Uint8Array(28));
  const out = w.finish();
  put16(out, 2, internetChecksum(out));
  return out;
}

export function decodeIcmp(b: Uint8Array, o: number, end: number): IcmpHeader | null {
  if (end - o < 8) return null;
  return {
    type: b[o],
    code: b[o + 1],
    checksum: u16(b, o + 2),
    checksumOk: internetChecksum(b, o, end) === 0,
    id: u16(b, o + 4),
    seq: u16(b, o + 6),
    dataStart: o + 8,
    dataLen: end - o - 8,
  };
}
