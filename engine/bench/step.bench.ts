// Бенчмарк: ~30 устройств, все ПК получают адрес по DHCP и пингуют сервер.
// Запуск: npm run bench -w engine
import { TopologyBuilder } from '../src/model/devices';
import { Simulator } from '../src/sim/Simulator';

const M24 = '255.255.255.0';

function bigTopology() {
  const b = new TopologyBuilder('Бенчмарк', 77);
  const r = b.add('router', 'R');
  const srv = b.add('server', 'Сервер');
  const pcs = [];
  b.ip(r, 'Gi0/2', '10.0.0.1', M24);
  b.ip(srv, 'Fa0', '10.0.0.2', M24).gateway(srv, '10.0.0.1');
  srv.config.services = { dhcp: true };
  srv.config.dhcpPools = [];
  b.link(r, 'Gi0/2', srv, 'Fa0', 'crossover');
  for (let s = 0; s < 2; s++) {
    const sw = b.add('switch', `SW${s}`);
    const net = `192.168.${s + 1}`;
    b.ip(r, `Gi0/${s}`, `${net}.1`, M24);
    b.port(r, `Gi0/${s}`).l3!.helperAddress = '10.0.0.2';
    srv.config.dhcpPools.push({ name: `P${s}`, network: `${net}.0`, mask: M24, gateway: `${net}.1`, start: `${net}.100`, end: `${net}.200` });
    b.link(sw, 'Gi0/1', r, `Gi0/${s}`, 'straight');
    for (let i = 1; i <= 13; i++) {
      const pc = b.add('pc', `ПК${s}-${i}`);
      b.dhcpClient(pc);
      b.link(pc, 'Fa0', sw, `Fa0/${i}`, 'straight');
      pcs.push(pc);
    }
  }
  return { project: b.project, pcs };
}

function measure(withHistory: boolean, snapshotEvery = 1) {
  const { project, pcs } = bigTopology();
  const sim = new Simulator(project, { checkpointEvery: snapshotEvery, maxCheckpoints: 1_000_000 });
  let steps = 0;
  const t0 = performance.now();
  const go = () => {
    while (sim.pending.length) {
      if (withHistory) sim.step();
      else sim.runUntil(sim.pending[0].time);
    }
    steps = sim.state.step;
  };
  go();
  for (const pc of pcs) sim.ping(pc.id, '10.0.0.2', 2);
  go();
  const ms = performance.now() - t0;
  const snapBytes = Buffer.byteLength(JSON.stringify(sim.state));
  return { devices: project.devices.length, steps, logEntries: sim.log.length, ms, perStepUs: (ms / steps) * 1000, snapBytes, snapshotEvery };
}

const fmt = (r: ReturnType<typeof measure>) => ({ ...r, ms: r.ms.toFixed(1), perStepUs: r.perStepUs.toFixed(1) });
const fast = measure(false);
console.table({
  'без истории': fmt(fast),
  'чекпоинт каждый шаг': fmt(measure(true, 1)),
  'чекпоинт раз в 50 шагов': fmt(measure(true, 50)),
});
console.log(`Снапшот состояния: ~${(fast.snapBytes / 1024).toFixed(1)} КБ (JSON) в конце прогона`);

// цена шага назад при N=50
const { project, pcs } = bigTopology();
const sim = new Simulator(project);
for (const pc of pcs) sim.ping(pc.id, '10.0.0.2', 1);
while (sim.pending.length) sim.step();
const t0 = performance.now();
let back = 0;
while (back < 200 && sim.stepBack()) back++;
console.log(`Шаг назад (N=50): ${(((performance.now() - t0) / back) * 1000).toFixed(0)} мкс в среднем на ${back} шагов`);
