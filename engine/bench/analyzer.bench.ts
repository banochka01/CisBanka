// Нагрузка анализатора: 10 000+ кадров — кодирование, разбор, сводка, фильтр.
import { Simulator } from '../src/sim/Simulator';
import { TopologyBuilder } from '../src/model/devices';
import { Capture, compileFilter, dissect, fieldValues, packetBytes, summarize, TcpSeqContext } from '../src/capture';
import { decodeFrame } from '../src/wire';

const b = new TopologyBuilder('bench', 1);
const pc = b.add('pc', 'ПК');
const sw = b.add('switch', 'Свитч');
const srv = b.add('server', 'Сервер');
b.ip(pc, 'Fa0', '10.0.0.1', '255.255.255.0').ip(srv, 'Fa0', '10.0.0.2', '255.255.255.0');
b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
b.link(srv, 'Fa0', sw, 'Fa0/2', 'straight');
const sim = new Simulator(b.project);
const cap = new Capture({ kind: 'link', linkId: b.project.links[0].id }, sim);
sim.ping(pc.id, '10.0.0.2', 5200);
sim.runUntilIdle();
cap.sync(sim);
const n = cap.frames.length;
const t = (label: string, fn: () => void) => {
  const s = performance.now();
  fn();
  console.log(`${label}: ${(performance.now() - s).toFixed(0)} мс (${n} кадров)`);
};
let bytes: Uint8Array[] = [];
t('encode', () => (bytes = cap.frames.map((f) => packetBytes(f.packet))));
t('decode+summary', () => {
  const ctx = new TcpSeqContext();
  for (const x of bytes) summarize(decodeFrame(x), ctx);
});
let ds: ReturnType<typeof dissect>[] = [];
t('dissect', () => (ds = bytes.map((x, i) => dissect(x, { number: i + 1, relTime: 0 }))));
const f = compileFilter('icmp.seq==1000 || ip.dst==10.0.0.1 && icmp.type==0 && icmp.seq<5');
if (!f.ok) throw new Error(f.error);
t('filter', () => ds.filter((d) => f.fn(d.values)));
t('fieldValues + filter (как в UI)', () => bytes.filter((x, i) => f.fn(fieldValues(decodeFrame(x), { number: i + 1 }))));
