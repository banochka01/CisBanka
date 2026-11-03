// Эталонный сценарий для проверки .pcap настоящим Wireshark (tshark) и для тестов формата.
// ПК (DHCP) — Свитч — Роутер — Сервер2; в LAN — Сервер (DHCP + DNS + HTTP).
// Захват на проводе ПК: DHCP, ARP, DNS (A и NXDOMAIN), HTTP, TCP RST (закрытый порт),
// ping и traceroute через роутер (ICMP Time-to-live exceeded).
import { TopologyBuilder } from '../../src/model/devices';
import { Simulator } from '../../src/sim/Simulator';
import { Capture } from '../../src/capture/capture';

const M24 = '255.255.255.0';

export function referenceScenario() {
  const b = new TopologyBuilder('Эталон для Wireshark', 2024);
  const pc = b.add('pc', 'ПК');
  const sw = b.add('switch', 'Свитч');
  const srv = b.add('server', 'Сервер');
  const r = b.add('router', 'Роутер');
  const far = b.add('server', 'Сервер2');
  b.dhcpClient(pc);
  b.ip(srv, 'Fa0', '192.168.1.2', M24).gateway(srv, '192.168.1.1');
  b.ip(r, 'Gi0/0', '192.168.1.1', M24).ip(r, 'Gi0/1', '10.0.0.1', M24);
  b.ip(far, 'Fa0', '10.0.0.10', M24).gateway(far, '10.0.0.1');
  srv.config.dhcpPools = [{ name: 'LAN', network: '192.168.1.0', mask: M24, gateway: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', end: '192.168.1.110' }];
  srv.config.services = {
    dhcp: true,
    dns: {
      enabled: true,
      records: [
        { name: 'site.local', address: '192.168.1.2' },
        { name: 'far.local', address: '10.0.0.10' },
      ],
    },
    http: { enabled: true, title: 'Учебный сайт', body: 'Привет из CisBanka! <b>HTML</b> & UTF-8.' },
  };
  // Сервер2 без HTTP — на порт 80 он отвечает RST.
  far.config.services = {};
  b.link(pc, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(srv, 'Fa0', sw, 'Fa0/2', 'straight');
  b.link(sw, 'Gi0/1', r, 'Gi0/0', 'straight');
  b.link(far, 'Fa0', r, 'Gi0/1', 'crossover');
  const pcLink = b.project.links.find((l) => l.a.deviceId === pc.id || l.b.deviceId === pc.id)!.id;
  const farLink = b.project.links.find((l) => l.a.deviceId === far.id || l.b.deviceId === far.id)!.id;

  const sim = new Simulator(b.project);
  const cap = new Capture({ kind: 'link', linkId: pcLink }, sim);
  const capFar = new Capture({ kind: 'link', linkId: farLink }, sim);
  sim.runUntilIdle(); // DHCP при включении
  sim.openUrl(pc.id, 'http://site.local/');
  sim.runUntilIdle();
  sim.nslookup(pc.id, 'nope.local');
  sim.runUntilIdle();
  sim.ping(pc.id, '192.168.1.2', 2);
  sim.runUntilIdle();
  sim.traceroute(pc.id, 'far.local');
  sim.runUntilIdle();
  sim.openUrl(pc.id, 'http://far.local/');
  sim.runUntilIdle();
  cap.sync(sim);
  capFar.sync(sim);
  return { sim, cap, capFar, pc, srv, far, r };
}
