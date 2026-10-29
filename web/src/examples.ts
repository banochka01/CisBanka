import { TopologyBuilder, type Project } from '@ciscobanka/engine';

const M24 = '255.255.255.0';

function twoPcs(): Project {
  const b = new TopologyBuilder('Два ПК через свитч', 101);
  const sw = b.add('switch', 'Свитч0', { x: 300, y: 120 });
  const pc1 = b.add('pc', 'ПК0', { x: 120, y: 300 });
  const pc2 = b.add('pc', 'ПК1', { x: 480, y: 300 });
  b.ip(pc1, 'Fa0', '192.168.1.10', M24).ip(pc2, 'Fa0', '192.168.1.20', M24);
  b.link(pc1, 'Fa0', sw, 'Fa0/1', 'straight');
  b.link(pc2, 'Fa0', sw, 'Fa0/2', 'straight');
  return b.project;
}

function twoSubnets(): Project {
  const b = new TopologyBuilder('Две подсети через роутер', 102);
  const r = b.add('router', 'Роутер0', { x: 340, y: 60 });
  const s1 = b.add('switch', 'Свитч0', { x: 140, y: 220 });
  const s2 = b.add('switch', 'Свитч1', { x: 540, y: 220 });
  const p1 = b.add('pc', 'ПК0', { x: 60, y: 400 });
  const p2 = b.add('pc', 'ПК1', { x: 220, y: 400 });
  const p3 = b.add('pc', 'ПК2', { x: 620, y: 400 });
  b.ip(r, 'Gi0/0', '192.168.1.1', M24).ip(r, 'Gi0/1', '192.168.2.1', M24);
  b.ip(p1, 'Fa0', '192.168.1.10', M24).gateway(p1, '192.168.1.1');
  b.ip(p2, 'Fa0', '192.168.1.11', M24).gateway(p2, '192.168.1.1');
  b.ip(p3, 'Fa0', '192.168.2.10', M24).gateway(p3, '192.168.2.1');
  b.link(r, 'Gi0/0', s1, 'Gi0/1', 'straight');
  b.link(r, 'Gi0/1', s2, 'Gi0/1', 'straight');
  b.link(p1, 'Fa0', s1, 'Fa0/1', 'straight');
  b.link(p2, 'Fa0', s1, 'Fa0/2', 'straight');
  b.link(p3, 'Fa0', s2, 'Fa0/1', 'straight');
  return b.project;
}

function dhcpDnsWeb(): Project {
  const b = new TopologyBuilder('DHCP + DNS + веб-сервер', 103);
  const sw = b.add('switch', 'Свитч0', { x: 320, y: 140 });
  const srv = b.add('server', 'Сервер0', { x: 560, y: 60 });
  const pcs = [0, 1, 2].map((i) => b.add(i === 2 ? 'laptop' : 'pc', i === 2 ? 'Ноутбук0' : `ПК${i}`, { x: 120 + i * 200, y: 340 }));
  b.ip(srv, 'Fa0', '192.168.1.2', M24).gateway(srv, '192.168.1.1');
  srv.config.dns = '192.168.1.2';
  srv.config.dhcpPools = [{ name: 'LAN', network: '192.168.1.0', mask: M24, gateway: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', end: '192.168.1.150' }];
  srv.config.services = {
    dhcp: true,
    dns: { enabled: true, records: [{ name: 'site.local', address: '192.168.1.2' }] },
    http: { enabled: true, title: 'Учебный сайт', body: 'Если вы это видите — DHCP, DNS и HTTP работают!' },
  };
  b.link(srv, 'Fa0', sw, 'Gi0/1', 'straight');
  pcs.forEach((pc, i) => {
    b.dhcpClient(pc);
    b.link(pc, 'Fa0', sw, `Fa0/${i + 1}`, 'straight');
  });
  return b.project;
}

function vlan(): Project {
  const b = new TopologyBuilder('VLAN и router-on-a-stick', 104);
  const r = b.add('router', 'Роутер0', { x: 320, y: 40 });
  const sw = b.add('switch', 'Свитч0', { x: 320, y: 200 });
  const a1 = b.add('pc', 'Бухгалтерия-1', { x: 80, y: 380 });
  const a2 = b.add('pc', 'Бухгалтерия-2', { x: 240, y: 380 });
  const s1 = b.add('pc', 'Склад-1', { x: 420, y: 380 });
  const s2 = b.add('pc', 'Склад-2', { x: 580, y: 380 });
  b.vlan(sw, 10, 'Бухгалтерия').vlan(sw, 20, 'Склад');
  b.access(sw, 'Fa0/1', 10).access(sw, 'Fa0/2', 10).access(sw, 'Fa0/3', 20).access(sw, 'Fa0/4', 20).trunk(sw, 'Gi0/1');
  b.subif(r, 'Gi0/0', 10, '192.168.10.1', M24).subif(r, 'Gi0/0', 20, '192.168.20.1', M24);
  b.ip(a1, 'Fa0', '192.168.10.10', M24).gateway(a1, '192.168.10.1');
  b.ip(a2, 'Fa0', '192.168.10.11', M24).gateway(a2, '192.168.10.1');
  b.ip(s1, 'Fa0', '192.168.20.10', M24).gateway(s1, '192.168.20.1');
  b.ip(s2, 'Fa0', '192.168.20.11', M24).gateway(s2, '192.168.20.1');
  b.link(r, 'Gi0/0', sw, 'Gi0/1', 'straight');
  [a1, a2, s1, s2].forEach((pc, i) => b.link(pc, 'Fa0', sw, `Fa0/${i + 1}`, 'straight'));
  return b.project;
}

export const EXAMPLES: { title: string; make: () => Project }[] = [
  { title: 'Два ПК через свитч', make: twoPcs },
  { title: 'Две подсети через роутер', make: twoSubnets },
  { title: 'DHCP + DNS + веб-сервер', make: dhcpDnsWeb },
  { title: 'VLAN и router-on-a-stick', make: vlan },
];
