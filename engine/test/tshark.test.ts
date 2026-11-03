// Проверка экспорта настоящим Wireshark: эталонный сценарий → .pcap → tshark.
// Локально без tshark тест пропускается; в CI (REQUIRE_TSHARK=1) его отсутствие — ошибка.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dissect, summarize, TcpSeqContext } from '../src/capture';
import { frameBytes, framesToPcap } from '../src/pcap';
import { decodeFrame } from '../src/wire';
import { referenceScenario } from './fixtures/reference';

const TSHARK = process.env.TSHARK || 'tshark';
const required = process.env.REQUIRE_TSHARK === '1';
const probe = spawnSync(TSHARK, ['--version'], { encoding: 'utf8' });
const have = probe.status === 0;

// Проверка контрольных сумм IP/TCP/UDP по умолчанию выключена — включаем. -n: без резолва имён (MAC как есть).
const PREFS = ['-n', '-o', 'ip.check_checksum:TRUE', '-o', 'tcp.check_checksum:TRUE', '-o', 'udp.check_checksum:TRUE'];
const BAD = '_ws.malformed || _ws.expert.severity == "Error" || ip.checksum.status == "Bad" || tcp.checksum.status == "Bad" || udp.checksum.status == "Bad" || icmp.checksum.status == "Bad"';

function tshark(args: string[]) {
  const r = spawnSync(TSHARK, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Колонки списка: в Wireshark 4.2+ поля _ws.col.* в нижнем регистре, раньше — по заголовку колонки. */
function columns(file: string) {
  const names = [
    ['_ws.col.protocol', '_ws.col.def_src', '_ws.col.def_dst', '_ws.col.info'],
    ['_ws.col.Protocol', '_ws.col.Source', '_ws.col.Destination', '_ws.col.Info'],
  ];
  let last = '';
  for (const cols of names) {
    const fields = ['frame.number', 'frame.time_epoch', 'frame.len', 'frame.protocols', ...cols];
    const r = tshark(['-r', file, ...PREFS, '-T', 'fields', '-E', 'separator=\t', '-E', 'occurrence=f', ...fields.flatMap((f) => ['-e', f])]);
    if (r.code === 0) return r.out.split('\n').filter(Boolean).map((l) => l.split('\t'));
    last = r.err;
  }
  throw new Error(`tshark -T fields: ${last}`);
}

// Wireshark сопоставляет эхо-запросы и ответы по всему файлу («reply in 21»); мы этого не делаем — суффикс не сравниваем.
const normInfo = (s: string) => s.replace(/\s+\((reply in \d+|request in \d+|no response found!)\)$/, '').trim();

function scenario(name: string) {
  const { cap, capFar } = referenceScenario();
  const frames = name === 'pc' ? cap.frames : capFar.frames;
  const dir = mkdtempSync(join(tmpdir(), 'cisbanka-tshark-'));
  const file = join(dir, `reference-${name}.pcap`);
  writeFileSync(file, framesToPcap(frames));
  return { frames, file };
}

describe.skipIf(!have && !required)('Wireshark (tshark) открывает наш .pcap', () => {
  it('tshark установлен', () => {
    expect(have, `tshark не найден (${TSHARK}): ${probe.error?.message ?? probe.stderr}`).toBe(true);
    console.log(probe.stdout.split('\n')[0]);
  });

  for (const name of ['pc', 'far']) {
    describe(`эталонный сценарий, захват ${name === 'pc' ? 'на проводе ПК (DHCP, DNS, HTTP, ping, traceroute, RST)' : 'за роутером'}`, () => {
      const { frames, file } = scenario(name);

      it('tshark -V: нет Malformed и ошибок контрольных сумм', () => {
        const r = tshark(['-r', file, '-V', ...PREFS]);
        expect(r.code, r.err).toBe(0);
        const bad = r.out.split('\n').filter((l) => /Malformed Packet|status: Bad\]|incorrect, should be|Expert Info \(Error/i.test(l));
        expect(bad).toEqual([]);
        // Проверка сумм действительно включена: у каждого IP-кадра — Good (у ICMP-ошибок ещё и у вложенного заголовка).
        const ipFrames = frames.filter((f) => decodeFrame(frameBytes(f)).ip).length;
        const good = r.out.split('\n').filter((l) => /\[Header checksum status: Good\]/.test(l)).length;
        expect(good).toBeGreaterThanOrEqual(ipFrames);
      });

      it('display-фильтр ошибок (malformed, expert error, Bad checksum) не находит ни одного кадра', () => {
        const r = tshark(['-r', file, ...PREFS, '-Y', BAD]);
        expect(r.code, r.err).toBe(0);
        expect(r.out.trim()).toBe('');
      });

      it('число кадров, время, длины, протоколы и колонки совпадают с нашим разбором', () => {
        const rows = columns(file);
        expect(rows.length).toBe(frames.length);
        const ctx = new TcpSeqContext();
        const ours = frames.map((f) => {
          const bytes = frameBytes(f);
          const s = summarize(decodeFrame(bytes), ctx);
          // С -n Wireshark не подменяет ff:ff:ff:ff:ff:ff на «Broadcast».
          const dst = s.dst === 'Broadcast' ? 'ff:ff:ff:ff:ff:ff' : s.dst;
          return [String(f.no), (f.time / 1000).toFixed(6), String(bytes.length), dissect(bytes).protocols.join(':'), s.protocol, s.src, dst, s.info];
        });
        const theirs = rows.map(([no, t, len, protos, proto, src, dst, info]) => [no, Number(t).toFixed(6), len, protos, proto, src, dst, normInfo(info)]);
        expect(ours.map((r) => r.join(' | '))).toEqual(theirs.map((r) => r.join(' | ')));
      });
    });
  }
});
