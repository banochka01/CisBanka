// Файлы захвата: запись классического libpcap и чтение libpcap/pcapng.
//
// Запись: libpcap 2.4, little-endian, микросекунды, LINKTYPE_ETHERNET. Время — модельное
// (мс от старта симуляции), поэтому один и тот же сценарий даёт побайтно один и тот же файл.
// Чтение не доверяет входу: всё, что не удалось разобрать, — понятная ошибка PcapError
// или предупреждение, но не исключение из глубины кода.

export const LINKTYPE_ETHERNET = 1;
export const PCAP_SNAPLEN = 65535;
/** Больше — повреждённая запись (Wireshark ограничивает так же). */
const MAX_RECORD = 262144;
/** Защита вкладки от гигантских файлов. */
export const PCAP_MAX_FRAMES = 200_000;

export interface PcapRecord {
  /** Время, мс. */
  time: number;
  data: Uint8Array;
  /** Длина кадра в проводе (если сохранена часть). */
  origLen?: number;
}

export interface PcapFrame extends PcapRecord {
  origLen: number;
}

export interface PcapFile {
  format: 'pcap' | 'pcapng';
  frames: PcapFrame[];
  /** Некритичные проблемы: обрезанный хвост, пропущенные кадры чужого типа… */
  warnings: string[];
}

export class PcapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PcapError';
  }
}

const LINKTYPE_NAMES: Record<number, string> = {
  0: 'BSD loopback (NULL)',
  6: 'Token Ring',
  9: 'PPP',
  10: 'FDDI',
  12: 'Raw IP',
  101: 'Raw IP',
  104: 'Cisco HDLC',
  105: 'IEEE 802.11 (Wi-Fi)',
  108: 'OpenBSD loopback',
  113: 'Linux cooked capture (SLL)',
  119: 'Prism 802.11',
  127: 'IEEE 802.11 + radiotap',
  147: 'USER0',
  187: 'Bluetooth HCI H4',
  189: 'USB Linux',
  195: 'IEEE 802.15.4',
  220: 'USB Linux (mmapped)',
  228: 'Raw IPv4',
  229: 'Raw IPv6',
  249: 'USBPcap',
  276: 'Linux cooked capture v2 (SLL2)',
};

export function linkTypeError(lt: number): string {
  const name = LINKTYPE_NAMES[lt];
  return `Тип канального уровня ${name ? `«${name}» ` : ''}(LINKTYPE ${lt}) не поддерживается: анализатор разбирает только Ethernet (LINKTYPE ${LINKTYPE_ETHERNET}). Снимите захват на Ethernet-интерфейсе (в Linux — на eth0/ens…, а не на «any»).`;
}

// ---------- запись ----------

/** Классический libpcap: глобальный заголовок 24 байта + записи (16 байт заголовка + кадр). */
export function writePcap(records: readonly PcapRecord[]): Uint8Array {
  let size = 24;
  for (const r of records) size += 16 + Math.min(r.data.length, PCAP_SNAPLEN);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xa1b2c3d4, true);
  v.setUint16(4, 2, true);
  v.setUint16(6, 4, true);
  v.setInt32(8, 0, true); // thiszone
  v.setUint32(12, 0, true); // sigfigs
  v.setUint32(16, PCAP_SNAPLEN, true);
  v.setUint32(20, LINKTYPE_ETHERNET, true);
  let o = 24;
  for (const r of records) {
    // Модельное время может быть дробным: округляем до микросекунды детерминированно.
    const us = Math.max(0, Math.round(r.time * 1000));
    const incl = Math.min(r.data.length, PCAP_SNAPLEN);
    v.setUint32(o, Math.floor(us / 1e6), true);
    v.setUint32(o + 4, us % 1e6, true);
    v.setUint32(o + 8, incl, true);
    v.setUint32(o + 12, Math.max(r.origLen ?? r.data.length, incl), true);
    out.set(r.data.subarray(0, incl), o + 16);
    o += 16 + incl;
  }
  return out;
}

// ---------- чтение ----------

const hex32 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

export function readPcap(bytes: Uint8Array): PcapFile {
  try {
    return parse(bytes);
  } catch (e) {
    // Последний рубеж: любой выход за границы в повреждённом файле — понятная ошибка.
    if (e instanceof PcapError) throw e;
    throw new PcapError(`Файл повреждён и не читается (${e instanceof Error ? e.message : String(e)}).`);
  }
}

function parse(bytes: Uint8Array): PcapFile {
  if (bytes.length < 4) throw new PcapError(bytes.length ? `Файл слишком короткий (${bytes.length} байт) — это не pcap.` : 'Файл пустой.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = v.getUint32(0, false);
  if (magic === 0x0a0d0d0a) return readPcapng(bytes, v);
  if (magic === 0xa1b2c3d4 || magic === 0xd4c3b2a1 || magic === 0xa1b23c4d || magic === 0x4d3cb2a1) return readLibpcap(bytes, v, magic);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new PcapError('Файл сжат gzip (.pcap.gz) — распакуйте его и откройте .pcap.');
  if (magic === 0xa1b2cd34 || magic === 0x34cdb2a1) throw new PcapError('Это «модифицированный» pcap (Kuznetzov) — пересохраните его в Wireshark как Wireshark/tcpdump - pcap.');
  if (bytes[0] === 0x73 && bytes[1] === 0x6e && bytes[2] === 0x6f && bytes[3] === 0x6f) throw new PcapError('Это файл snoop (Solaris) — пересохраните его в Wireshark как pcap или pcapng.');
  throw new PcapError(`Это не файл pcap/pcapng: неизвестная сигнатура ${hex32(magic)}. Поддерживаются .pcap (libpcap) и .pcapng.`);
}

function readLibpcap(bytes: Uint8Array, v: DataView, magic: number): PcapFile {
  const le = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
  const nanos = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  if (bytes.length < 24) throw new PcapError(`Файл обрезан: заголовок pcap занимает 24 байта, а в файле ${bytes.length}.`);
  const major = v.getUint16(4, le);
  if (major !== 2) throw new PcapError(`Версия формата pcap ${major}.${v.getUint16(6, le)} не поддерживается (нужна 2.4).`);
  // Старшие биты поля linktype — FCS-флаги; сам тип — младшие 28 бит.
  const raw = v.getUint32(20, le);
  const lt = raw & 0x0fffffff;
  const fcs = raw & 0x10000000 ? ((raw >>> 29) & 7) * 2 : 0;
  if (lt !== LINKTYPE_ETHERNET) throw new PcapError(linkTypeError(lt));
  const frames: PcapFrame[] = [];
  const warnings: string[] = [];
  let o = 24;
  while (o < bytes.length) {
    if (frames.length >= PCAP_MAX_FRAMES) {
      warnings.push(`Открыты первые ${PCAP_MAX_FRAMES} кадров, остальные пропущены.`);
      break;
    }
    if (o + 16 > bytes.length) {
      warnings.push(`Файл обрезан: заголовок записи ${frames.length + 1} неполный — хвост (${bytes.length - o} байт) пропущен.`);
      break;
    }
    const sec = v.getUint32(o, le);
    const frac = v.getUint32(o + 4, le);
    const incl = v.getUint32(o + 8, le);
    const orig = v.getUint32(o + 12, le);
    if (incl > MAX_RECORD) {
      warnings.push(`Запись ${frames.length + 1} повреждена (длина ${incl} байт) — чтение остановлено.`);
      break;
    }
    if (o + 16 + incl > bytes.length) {
      warnings.push(`Файл обрезан: кадр ${frames.length + 1} неполный (${bytes.length - o - 16} из ${incl} байт) — пропущен.`);
      break;
    }
    const data = bytes.slice(o + 16, o + 16 + Math.max(0, incl - Math.min(fcs, incl)));
    frames.push({ time: sec * 1000 + (nanos ? frac / 1e6 : frac / 1e3), data, origLen: Math.max(orig, incl) });
    o += 16 + incl;
  }
  return { format: 'pcap', frames, warnings };
}

interface Iface {
  linkType: number;
  /** Единиц времени в секунде. */
  tsPerSec: number;
  tsOffset: number;
  snaplen: number;
}

/** pcapng: SHB, IDB, EPB, SPB и устаревший PB; прочие блоки пропускаются. */
function readPcapng(bytes: Uint8Array, v: DataView): PcapFile {
  const frames: PcapFrame[] = [];
  const warnings: string[] = [];
  const skippedTypes = new Map<number, number>();
  let le = true;
  let ifaces: Iface[] = [];
  let o = 0;
  let section = 0;
  const pushFrame = (ifId: number, tsHigh: number, tsLow: number, data: Uint8Array, orig: number) => {
    const iface = ifaces[ifId];
    if (!iface) {
      warnings.push(`Кадр ссылается на несуществующий интерфейс ${ifId} — пропущен.`);
      return;
    }
    if (iface.linkType !== LINKTYPE_ETHERNET) {
      skippedTypes.set(iface.linkType, (skippedTypes.get(iface.linkType) ?? 0) + 1);
      return;
    }
    const ts = tsHigh * 4294967296 + tsLow;
    frames.push({ time: (ts / iface.tsPerSec + iface.tsOffset) * 1000, data: data.slice(), origLen: Math.max(orig, data.length) });
  };

  while (o < bytes.length) {
    if (frames.length >= PCAP_MAX_FRAMES) {
      warnings.push(`Открыты первые ${PCAP_MAX_FRAMES} кадров, остальные пропущены.`);
      break;
    }
    if (o + 12 > bytes.length) {
      warnings.push(`Файл обрезан: неполный блок в конце (${bytes.length - o} байт) пропущен.`);
      break;
    }
    const type = v.getUint32(o, le);
    if (type === 0x0a0d0d0a) {
      if (o + 16 > bytes.length) {
        if (section === 0) throw new PcapError('Файл обрезан: заголовок секции pcapng неполный.');
        warnings.push('Файл обрезан: заголовок последней секции неполный — пропущен.');
        break;
      }
      // Порядок байтов секции — по byte-order magic.
      const bom = v.getUint32(o + 8, true);
      if (bom === 0x1a2b3c4d) le = true;
      else if (bom === 0x4d3c2b1a) le = false;
      else throw new PcapError(`Повреждённый pcapng: неверный byte-order magic ${hex32(bom)} в секции ${section + 1}.`);
      const major = v.getUint16(o + 12, le);
      if (major !== 1) throw new PcapError(`Версия pcapng ${major}.${v.getUint16(o + 14, le)} не поддерживается (нужна 1.0).`);
      ifaces = [];
      section++;
    } else if (section === 0) {
      throw new PcapError('Повреждённый pcapng: файл не начинается с Section Header Block.');
    }
    const len = v.getUint32(o + 4, le);
    if (len < 12 || len % 4 !== 0 || o + len > bytes.length) {
      if (o + len > bytes.length && len >= 12) warnings.push(`Файл обрезан: блок на смещении ${o} неполный — пропущен.`);
      else warnings.push(`Повреждённый блок на смещении ${o} (длина ${len}) — чтение остановлено.`);
      break;
    }
    if (v.getUint32(o + len - 4, le) !== len) {
      warnings.push(`Повреждённый блок на смещении ${o}: длины в начале и в конце блока не совпадают — чтение остановлено.`);
      break;
    }
    const body = o + 8;
    const bodyEnd = o + len - 4;
    if (type === 1 && bodyEnd - body >= 8) {
      // Interface Description Block
      const iface: Iface = { linkType: v.getUint16(body, le), snaplen: v.getUint32(body + 4, le), tsPerSec: 1e6, tsOffset: 0 };
      forOptions(v, body + 8, bodyEnd, le, (code, at, olen) => {
        if (code === 9 && olen >= 1) {
          const r = bytes[at];
          iface.tsPerSec = r & 0x80 ? 2 ** (r & 0x7f) : 10 ** r;
        } else if (code === 14 && olen >= 8) {
          iface.tsOffset = Number(v.getBigInt64(at, le));
        }
      });
      ifaces.push(iface);
    } else if (type === 6 && bodyEnd - body >= 20) {
      // Enhanced Packet Block
      const cap = v.getUint32(body + 12, le);
      if (body + 20 + cap > bodyEnd) warnings.push(`Блок кадра на смещении ${o} повреждён (длина данных ${cap}) — пропущен.`);
      else pushFrame(v.getUint32(body, le), v.getUint32(body + 4, le), v.getUint32(body + 8, le), bytes.subarray(body + 20, body + 20 + cap), v.getUint32(body + 16, le));
    } else if (type === 3 && bodyEnd - body >= 4) {
      // Simple Packet Block: без времени, длина — min(orig, snaplen, размер блока).
      const orig = v.getUint32(body, le);
      const snap = ifaces[0]?.snaplen || Infinity;
      const cap = Math.min(orig, snap, bodyEnd - body - 4);
      pushFrame(0, 0, 0, bytes.subarray(body + 4, body + 4 + cap), orig);
    } else if (type === 2 && bodyEnd - body >= 20) {
      // Packet Block (устаревший)
      const cap = v.getUint32(body + 12, le);
      if (body + 20 + cap <= bodyEnd) pushFrame(v.getUint16(body, le), v.getUint32(body + 4, le), v.getUint32(body + 8, le), bytes.subarray(body + 20, body + 20 + cap), v.getUint32(body + 16, le));
    }
    o += len;
  }

  if (skippedTypes.size) {
    const list = [...skippedTypes].map(([lt, n]) => `${LINKTYPE_NAMES[lt] ?? `LINKTYPE ${lt}`}: ${n}`).join(', ');
    if (!frames.length) throw new PcapError(linkTypeError([...skippedTypes.keys()][0]));
    warnings.push(`Пропущены кадры с интерфейсов не-Ethernet (${list}).`);
  }
  return { format: 'pcapng', frames, warnings };
}

function forOptions(v: DataView, from: number, to: number, le: boolean, fn: (code: number, at: number, len: number) => void) {
  let o = from;
  while (o + 4 <= to) {
    const code = v.getUint16(o, le);
    const len = v.getUint16(o + 2, le);
    if (code === 0 || o + 4 + len > to) return;
    fn(code, o + 4, len);
    o += 4 + ((len + 3) & ~3);
  }
}

// ---------- pcapng на запись (только для тестов чтения и совместимости) ----------

/** Минимальный pcapng: SHB + IDB (с if_tsresol) + EPB. Нужен для тестов импорта. */
export function writePcapng(records: readonly PcapRecord[], opts: { linkType?: number; tsresol?: number } = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  const block = (type: number, body: Uint8Array) => {
    const len = 12 + ((body.length + 3) & ~3);
    const b = new Uint8Array(len);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, len, true);
    b.set(body, 8);
    v.setUint32(len - 4, len, true);
    blocks.push(b);
  };
  const shb = new Uint8Array(16);
  const sv = new DataView(shb.buffer);
  sv.setUint32(0, 0x1a2b3c4d, true);
  sv.setUint16(4, 1, true);
  sv.setUint16(6, 0, true);
  sv.setBigInt64(8, -1n, true);
  block(0x0a0d0d0a, shb);
  const res = opts.tsresol ?? 6;
  const idb = new Uint8Array(8 + 8 + 4);
  const iv = new DataView(idb.buffer);
  iv.setUint16(0, opts.linkType ?? LINKTYPE_ETHERNET, true);
  iv.setUint32(4, PCAP_SNAPLEN, true);
  iv.setUint16(8, 9, true);
  iv.setUint16(10, 1, true);
  idb[12] = res;
  block(1, idb);
  for (const r of records) {
    const epb = new Uint8Array(20 + r.data.length);
    const ev = new DataView(epb.buffer);
    const ts = Math.round((r.time / 1000) * 10 ** res);
    ev.setUint32(0, 0, true);
    ev.setUint32(4, Math.floor(ts / 4294967296), true);
    ev.setUint32(8, ts >>> 0, true);
    ev.setUint32(12, r.data.length, true);
    ev.setUint32(16, r.origLen ?? r.data.length, true);
    epb.set(r.data, 20);
    block(6, epb);
  }
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
