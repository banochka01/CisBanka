import { describe, expect, it } from 'vitest';
import {
  FileCapture,
  frameBytes,
  framesToPcap,
  LINKTYPE_ETHERNET,
  PcapError,
  readPcap,
  writePcap,
  writePcapng,
} from '../src/pcap';
import { compileFilter, dissect, fieldValues, summarize, TcpSeqContext, TcpStreamIndex } from '../src/capture';
import { decodeFrame } from '../src/wire';
import { referenceScenario } from './fixtures/reference';

const u32le = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);

/** Детерминированный PRNG для фаззинга. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('экспорт .pcap (libpcap 2.4, Ethernet)', () => {
  const { cap } = referenceScenario();
  const file = framesToPcap(cap.frames);

  it('глобальный заголовок: magic, версия 2.4, snaplen, LINKTYPE_ETHERNET', () => {
    expect([...file.subarray(0, 24)]).toEqual([
      0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, LINKTYPE_ETHERNET, 0, 0, 0,
    ]);
  });

  it('записи: время — модельное (с/мкс), длины и байты кадров', () => {
    let o = 24;
    for (const f of cap.frames) {
      const data = frameBytes(f);
      const us = Math.round(f.time * 1000);
      expect(u32le(file, o)).toBe(Math.floor(us / 1e6));
      expect(u32le(file, o + 4)).toBe(us % 1e6);
      expect(u32le(file, o + 8)).toBe(data.length);
      expect(u32le(file, o + 12)).toBe(data.length);
      expect(file.subarray(o + 16, o + 16 + data.length)).toEqual(data);
      // Ethernet без FCS, не короче минимума.
      expect(data.length).toBeGreaterThanOrEqual(60);
      o += 16 + data.length;
    }
    expect(o).toBe(file.length);
  });

  it('один и тот же сценарий → побайтно тот же файл', () => {
    const again = framesToPcap(referenceScenario().cap.frames);
    expect(again).toEqual(file);
  });

  it('файл читается обратно без потерь', () => {
    const r = readPcap(file);
    expect(r.format).toBe('pcap');
    expect(r.warnings).toEqual([]);
    expect(r.frames.length).toBe(cap.frames.length);
    r.frames.forEach((f, i) => {
      expect(f.data).toEqual(frameBytes(cap.frames[i]));
      expect(f.time).toBeCloseTo(cap.frames[i].time, 3);
    });
  });

  it('дробное модельное время округляется до микросекунды', () => {
    const data = new Uint8Array(60);
    const b = writePcap([{ time: 1234.5678, data }, { time: 0.0004, data }]);
    expect([u32le(b, 24), u32le(b, 28)]).toEqual([1, 234568]);
    expect([u32le(b, 24 + 76), u32le(b, 28 + 76)]).toEqual([0, 0]);
  });

  it('повторный экспорт импортированного файла даёт тот же файл', () => {
    const fc = FileCapture.open('ref.pcap', file);
    expect(framesToPcap(fc.frames)).toEqual(file);
  });
});

/** Классический pcap вручную: любой порядок байтов, мкс или нс, любой linktype. */
function rawPcap(opts: { be?: boolean; nanos?: boolean; linkType?: number; records: { sec: number; frac: number; data: Uint8Array; orig?: number }[] }) {
  const le = !opts.be;
  const size = 24 + opts.records.reduce((s, r) => s + 16 + r.data.length, 0);
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, opts.nanos ? 0xa1b23c4d : 0xa1b2c3d4, le);
  v.setUint16(4, 2, le);
  v.setUint16(6, 4, le);
  v.setUint32(16, 65535, le);
  v.setUint32(20, opts.linkType ?? 1, le);
  let o = 24;
  for (const r of opts.records) {
    v.setUint32(o, r.sec, le);
    v.setUint32(o + 4, r.frac, le);
    v.setUint32(o + 8, r.data.length, le);
    v.setUint32(o + 12, r.orig ?? r.data.length, le);
    b.set(r.data, o + 16);
    o += 16 + r.data.length;
  }
  return b;
}

describe('импорт .pcap и .pcapng', () => {
  const { cap } = referenceScenario();
  const recs = cap.frames.slice(0, 6).map((f) => ({ time: f.time, data: frameBytes(f) }));

  it('big-endian и наносекундный pcap', () => {
    const data = recs[0].data;
    const be = readPcap(rawPcap({ be: true, records: [{ sec: 2, frac: 500_000, data }] }));
    expect(be.frames[0]).toMatchObject({ time: 2500, origLen: data.length });
    expect(be.frames[0].data).toEqual(data);
    const ns = readPcap(rawPcap({ nanos: true, records: [{ sec: 1, frac: 1_500_000, data }] }));
    expect(ns.frames[0].time).toBeCloseTo(1001.5, 6);
  });

  it('обрезанный кадр (snaplen) сохраняет длину в проводе', () => {
    const r = readPcap(rawPcap({ records: [{ sec: 0, frac: 0, data: recs[0].data.subarray(0, 40), orig: 342 }] }));
    expect(r.frames[0].data.length).toBe(40);
    expect(r.frames[0].origLen).toBe(342);
  });

  it('pcapng (SHB + IDB + EPB): мкс и нс разрешение', () => {
    for (const tsresol of [6, 9]) {
      const r = readPcap(writePcapng(recs, { tsresol }));
      expect(r.format).toBe('pcapng');
      expect(r.warnings).toEqual([]);
      expect(r.frames.map((f) => f.data)).toEqual(recs.map((x) => x.data));
      r.frames.forEach((f, i) => expect(f.time).toBeCloseTo(recs[i].time, 3));
    }
  });

  it('pcapng: неизвестные блоки пропускаются, несколько секций читаются', () => {
    const a = writePcapng(recs.slice(0, 2));
    const b = writePcapng(recs.slice(2, 4));
    // Блок неизвестного типа (Name Resolution, 0x4) между ними.
    const nrb = new Uint8Array(16);
    new DataView(nrb.buffer).setUint32(0, 4, true);
    new DataView(nrb.buffer).setUint32(4, 16, true);
    new DataView(nrb.buffer).setUint32(12, 16, true);
    const all = new Uint8Array([...a, ...nrb, ...b]);
    const r = readPcap(all);
    expect(r.frames.map((f) => f.data)).toEqual(recs.slice(0, 4).map((x) => x.data));
  });

  it('linktype не Ethernet — понятная ошибка, а не падение', () => {
    const data = recs[0].data;
    const cases: [Uint8Array, RegExp][] = [
      [rawPcap({ linkType: 113, records: [{ sec: 0, frac: 0, data }] }), /Linux cooked capture \(SLL\).*LINKTYPE 113.*только Ethernet/],
      [rawPcap({ linkType: 105, records: [] }), /802\.11.*LINKTYPE 105/],
      [rawPcap({ linkType: 101, be: true, records: [] }), /Raw IP.*LINKTYPE 101/],
      [rawPcap({ linkType: 4242, records: [] }), /LINKTYPE 4242/],
      [writePcapng(recs, { linkType: 127 }), /radiotap.*LINKTYPE 127/],
    ];
    for (const [bytes, msg] of cases) {
      expect(() => readPcap(bytes)).toThrow(PcapError);
      expect(() => readPcap(bytes)).toThrow(msg);
    }
  });

  it('pcapng с Ethernet и не-Ethernet интерфейсами: Ethernet открывается, остальное — предупреждение', () => {
    const eth = writePcapng(recs.slice(0, 2));
    const wifi = writePcapng(recs.slice(0, 3), { linkType: 105 });
    const r = readPcap(new Uint8Array([...eth, ...wifi]));
    expect(r.frames.length).toBe(2);
    expect(r.warnings.join()).toMatch(/IEEE 802\.11 \(Wi-Fi\): 3/);
  });

  it('не pcap — понятные ошибки', () => {
    expect(() => readPcap(new Uint8Array())).toThrow('Файл пустой.');
    expect(() => readPcap(new Uint8Array([1, 2]))).toThrow(/слишком короткий/);
    expect(() => readPcap(new TextEncoder().encode('{"project": "CisBanka"}'))).toThrow(/неизвестная сигнатура 0x7b227072/);
    expect(() => readPcap(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]))).toThrow(/gzip/);
    expect(() => readPcap(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 2, 0]))).toThrow(/обрезан.*24 байта/);
  });

  it('обрезанный файл: целые кадры открываются, хвост — предупреждение', () => {
    const full = writePcap(recs);
    const cut = full.subarray(0, full.length - 10);
    const r = readPcap(cut);
    expect(r.frames.length).toBe(recs.length - 1);
    expect(r.warnings[0]).toMatch(/обрезан: кадр 6 неполный/);
    const ng = writePcapng(recs);
    const r2 = readPcap(ng.subarray(0, ng.length - 3));
    expect(r2.frames.length).toBe(recs.length - 1);
    expect(r2.warnings[0]).toMatch(/обрезан/);
  });

  it('фаззинг: случайные и обрезанные файлы дают PcapError или кадры, но не падение', () => {
    const rnd = prng(7);
    const base = [writePcap(recs), writePcapng(recs)];
    for (let i = 0; i < 3000; i++) {
      const src = base[i % 2];
      const b = src.slice(0, Math.floor(rnd() * src.length) + 1);
      for (let k = 0; k < 3; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      try {
        const r = readPcap(b);
        for (const f of r.frames) expect(f.data).toBeInstanceOf(Uint8Array);
      } catch (e) {
        expect(e).toBeInstanceOf(PcapError);
        // Ошибка должна быть осмысленной, а не перехваченным выходом за границы.
        expect((e as Error).message).not.toMatch(/повреждён и не читается/);
      }
    }
  });
});

describe('импортированные кадры с незнакомыми протоколами', () => {
  const eth = (type: number, payload: number[]) => new Uint8Array([...[2, 0, 0, 0, 0, 1], ...[2, 0, 0, 0, 0, 2], type >> 8, type & 0xff, ...payload]);
  const ipv4 = (proto: number, payload: number[]) => {
    const len = 20 + payload.length;
    return [0x45, 0, len >> 8, len & 0xff, 0, 1, 0, 0, 64, proto, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2, ...payload];
  };

  const frames: [string, Uint8Array, string][] = [
    ['IPv6', eth(0x86dd, [0x60, 0, 0, 0, 0, 8, 17, 64, ...new Array(40).fill(0)]), 'eth:ethertype:data'],
    ['LLDP', eth(0x88cc, [2, 7, 4, 0, 1, 2, 3, 4, 5]), 'eth:ethertype:data'],
    ['GRE в IPv4', eth(0x0800, ipv4(47, [0, 0, 8, 0, 1, 2, 3, 4])), 'eth:ethertype:ip:data'],
    ['UDP на порт 5000', eth(0x0800, ipv4(17, [0x13, 0x88, 0x13, 0x88, 0, 12, 0, 0, 1, 2, 3, 4])), 'eth:ethertype:ip:udp:data'],
    ['битый заголовок IPv4', eth(0x0800, [0x4f, 0, 0, 10]), 'eth:ethertype:data'],
    ['обрезанный TCP', eth(0x0800, ipv4(6, [0, 80, 0, 81, 0])), 'eth:ethertype:ip:data'],
    ['обрезанный Ethernet', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), ''],
  ];

  for (const [name, bytes, protos] of frames) {
    it(`${name} → ${protos || 'Frame'}`, () => {
      const d = decodeFrame(bytes);
      const s = summarize(d, new TcpSeqContext());
      const dis = dissect(bytes, { number: 1 });
      expect(dis.protocols.join(':')).toBe(protos);
      expect(s.info).toBeTruthy();
      if (protos.endsWith('data')) {
        const node = dis.tree.at(-1)!;
        expect(node.label).toMatch(/^Data \(\d+ bytes\)$/);
        const ok = compileFilter('data');
        expect(ok.ok && ok.fn(fieldValues(d, { number: 1 }))).toBe(true);
      }
    });
  }

  it('фаззинг: разбор, сводка, фильтр и потоки не падают на любых байтах', () => {
    const { cap } = referenceScenario();
    const rnd = prng(42);
    const filters = ['tcp.port == 80 || dns', 'ip.addr == 10.0.0.0/8 && !arp', 'data', 'http.host contains "site"', 'icmp.type == 11', 'dhcp.option.dhcp == 1'].map((t) => {
      const r = compileFilter(t);
      if (!r.ok) throw new Error(r.error);
      return r.fn;
    });
    const ctx = new TcpSeqContext();
    const streams = new TcpStreamIndex();
    const check = (b: Uint8Array) => {
      const d = decodeFrame(b);
      summarize(d, ctx);
      streams.add(d);
      const dis = dissect(b, { number: 1, relTime: 0 });
      const v = fieldValues(d, { number: 1, relTime: 0 });
      for (const fn of filters) expect(fn(v)).toBe(fn(dis.values));
    };
    const real = cap.frames.map(frameBytes);
    for (const b of real) for (let n = 0; n <= b.length; n++) check(b.subarray(0, n));
    for (let i = 0; i < 4000; i++) {
      const b = real[i % real.length].slice();
      const flips = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < flips; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      check(b);
    }
    for (let i = 0; i < 1000; i++) check(Uint8Array.from({ length: Math.floor(rnd() * 400) }, () => Math.floor(rnd() * 256)));
  });
});
