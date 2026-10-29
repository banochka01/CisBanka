import type { Device, Port, SwitchportConfig } from '../model/topology';
import type { Packet } from '../model/packet';
import type { Verdict } from '../model/events';
import type { Simulator } from '../sim/Simulator';

export const BCAST_MAC = 'FFFF.FFFF.FFFF';

const DEFAULT_SP: SwitchportConfig = { mode: 'access', accessVlan: 1, nativeVlan: 1 };

const drop = (reason: string): Verdict => ({ action: 'drop', reason });

function allowed(sp: SwitchportConfig, vlan: number) {
  return !sp.allowedVlans || sp.allowedVlans.includes(vlan);
}

function stpBlocks(port: Port) {
  return port.stpState !== undefined && port.stpState !== 'forwarding' && port.stpState !== 'disabled';
}

function inVlan(port: Port, vlan: number) {
  const sp = port.switchport ?? DEFAULT_SP;
  return sp.mode === 'access' ? sp.accessVlan === vlan : allowed(sp, vlan);
}

/** Отправить кадр из порта свитча с учётом access/trunk. false — порт не в этом VLAN. */
function egress(sim: Simulator, sw: Device, port: Port, vlan: number, pkt: Packet, silent: boolean): boolean {
  if (stpBlocks(port)) return false;
  const sp = port.switchport ?? DEFAULT_SP;
  let tag: number | undefined;
  if (sp.mode === 'access') {
    if (sp.accessVlan !== vlan) return false;
  } else {
    if (!allowed(sp, vlan)) return false;
    tag = vlan === sp.nativeVlan ? undefined : vlan;
  }
  return sim.transmit(sw.id, port.id, { ...pkt, l2: { ...pkt.l2, vlanTag: tag } }, silent);
}

export function switchRx(sim: Simulator, sw: Device, inPort: Port, pkt: Packet): Verdict {
  if (pkt.l2Hops >= sim.opts.maxL2Hops) {
    return drop(
      `Петля в сети: этот кадр уже прошёл через ${pkt.l2Hops} свитчей и ходит по кругу. Кадр отброшен. Уберите лишний кабель или включите STP.`,
    );
  }
  if (stpBlocks(inPort)) return drop(`Порт ${inPort.name} в состоянии STP «${inPort.stpState}» — кадры не принимаются`);

  const sp = inPort.switchport ?? DEFAULT_SP;
  let vlan: number;
  if (sp.mode === 'access') {
    if (pkt.l2.vlanTag !== undefined) {
      return drop(`Access-порт ${inPort.name} получил кадр с тегом 802.1Q (VLAN ${pkt.l2.vlanTag}) — такие кадры отбрасываются. Порт к другому свитчу/роутеру должен быть trunk.`);
    }
    vlan = sp.accessVlan;
  } else {
    vlan = pkt.l2.vlanTag ?? sp.nativeVlan;
    if (!allowed(sp, vlan)) return drop(`VLAN ${vlan} не разрешён на транке ${inPort.name} — кадр отброшен`);
  }
  if (!(sw.config.vlans ?? []).some((v) => v.id === vlan)) {
    return drop(`VLAN ${vlan} не создан на свитче — порт ${inPort.name} неактивен, кадр отброшен`);
  }

  // Обучение: запоминаем, за каким портом живёт MAC отправителя.
  const rt = sim.rt(sw.id);
  const now = sim.now;
  const src = pkt.l2.src;
  const old = rt.macTable.find((e) => e.vlan === vlan && e.mac === src);
  let learned = '';
  if (!old) {
    rt.macTable.push({ vlan, mac: src, portId: inPort.id, updated: now });
    learned = `Запомнил: ${src} → порт ${inPort.name} (VLAN ${vlan}). `;
  } else {
    if (old.portId !== inPort.id) learned = `MAC ${src} переехал на порт ${inPort.name}. `;
    old.portId = inPort.id;
    old.updated = now;
  }

  const out = { ...pkt, l2Hops: pkt.l2Hops + 1 };
  const dst = pkt.l2.dst;
  const flood = (why: string): Verdict => {
    let n = 0;
    const dead: string[] = [];
    for (const p of sw.ports) {
      if (p.id === inPort.id) continue;
      if (egress(sim, sw, p, vlan, out, true)) n++;
      else if (inVlan(p, vlan) && sim.linkOf(p.id)) dead.push(`${p.name}: ${sim.linkStatus(sim.linkOf(p.id)!).reason ?? 'линк не поднят'}`);
    }
    return {
      action: 'flood',
      reason: `${learned}${why} — разослал во все порты VLAN ${vlan}, кроме входящего (${n} шт.)${dead.length ? `. Не ушло: ${dead.join('; ')}` : ''}`,
    };
  };

  if (dst === BCAST_MAC) return flood('Широковещательный кадр');
  const e = rt.macTable.find((x) => x.vlan === vlan && x.mac === dst && now - x.updated <= sim.opts.macAging);
  if (!e) return flood(`Свитч не знал MAC ${dst} в VLAN ${vlan}`);
  if (e.portId === inPort.id) return drop(`${learned}Получатель ${dst} за тем же портом, откуда пришёл кадр — фильтрация`);
  const outPort = sw.ports.find((p) => p.id === e.portId)!;
  egress(sim, sw, outPort, vlan, out, false);
  return { action: 'forward', reason: `${learned}MAC ${dst} есть в таблице — отправил только в порт ${outPort.name}` };
}

/** Хаб — повторитель: копия во все порты, без таблиц. */
export function hubRx(sim: Simulator, hub: Device, inPort: Port, pkt: Packet): Verdict {
  if (pkt.l2Hops >= sim.opts.maxL2Hops) {
    return drop(`Петля в сети: кадр прошёл ${pkt.l2Hops} устройств второго уровня и ходит по кругу — отброшен`);
  }
  const out = { ...pkt, l2Hops: pkt.l2Hops + 1 };
  let n = 0;
  for (const p of hub.ports) if (p.id !== inPort.id && sim.transmit(hub.id, p.id, out, true)) n++;
  return { action: 'flood', reason: `Хаб не смотрит на адреса — повторил сигнал во все порты, кроме входящего (${n} шт.)` };
}
