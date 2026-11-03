// TCP: рукопожатие, передача HTTP, закрытие через FIN/ACK и RST на закрытый порт.
// Номера последовательности считаются честно (SYN и FIN занимают по одному номеру),
// ISN берётся из PRNG симуляции — один и тот же сценарий даёт те же номера.
// Упрощения: без ретрансляций, окно не меняется, TIME_WAIT не моделируется.
import type { Device, IPv4 } from '../model/topology';
import type { HttpPayload, Packet, TcpFlag } from '../model/packet';
import type { Verdict } from '../model/events';
import type { Simulator } from '../sim/Simulator';
import type { Job, TcpConn } from '../sim/state';
import { defaultTtl, routeLookup, sendIp } from '../l3/stack';
import { encodeHttp } from '../wire/http';

export const TCP_WINDOW = 64240;
export const TCP_MSS = 1460;
export const HTTP_PORT = 80;

const drop = (reason: string): Verdict => ({ action: 'drop', reason });
const add32 = (a: number, b: number) => (a + b) >>> 0;
const connKey = (localIp: IPv4, localPort: number, remoteIp: IPv4, remotePort: number) => `${localIp}:${localPort}>${remoteIp}:${remotePort}`;
const keyOf = (c: TcpConn) => connKey(c.localIp, c.localPort, c.remoteIp, c.remotePort);

/** Сколько байт данных несёт сегмент. */
export function payloadLength(p: Pick<Packet, 'l4' | 'http'>): number {
  if (p.l4?.chunk) return p.l4.chunk[1] - p.l4.chunk[0];
  return p.http ? encodeHttp(p.http).length : 0;
}

/** Длина сегмента в номерах последовательности: данные + SYN + FIN. */
function segLength(p: Packet): number {
  const f = p.l4!.flags ?? [];
  return payloadLength(p) + (f.includes('SYN') ? 1 : 0) + (f.includes('FIN') ? 1 : 0);
}

/** Отправить сегмент от имени соединения; sndNxt сдвигается на длину сегмента. */
function send(sim: Simulator, d: Device, c: TcpConn, flags: TcpFlag[], extra: { http?: HttpPayload; chunk?: [number, number]; mss?: number } = {}) {
  const pkt: Packet = {
    id: 0,
    frameId: 0,
    l2Hops: 0,
    l2: { src: '', dst: '', etherType: 'IPv4' },
    l3: { src: c.localIp, dst: c.remoteIp, ttl: defaultTtl(d), proto: 'TCP' },
    l4: {
      srcPort: c.localPort,
      dstPort: c.remotePort,
      flags,
      seq: c.sndNxt,
      ack: flags.includes('ACK') ? c.rcvNxt : 0,
      window: TCP_WINDOW,
      ...(extra.mss ? { mss: extra.mss } : {}),
      ...(extra.chunk ? { chunk: extra.chunk } : {}),
    },
    ...(extra.http ? { http: extra.http } : {}),
  };
  c.sndNxt = add32(c.sndNxt, segLength(pkt));
  const { id: _i, frameId: _f, l2Hops: _h, l2: _l2, ...body } = pkt;
  return sendIp(sim, d, body as Parameters<typeof sendIp>[2]);
}

const isn = (sim: Simulator) => Math.floor(sim.random() * 0x100000000) >>> 0;

/** Клиент: открыть соединение (SYN). Возвращает текст ошибки или null. */
export function tcpConnect(sim: Simulator, d: Device, job: Job, remoteIp: IPv4, remotePort: number): string | null {
  const r = routeLookup(sim, d, remoteIp);
  const localIp = 'error' in r ? '' : r.iface.ip!;
  const iss = isn(sim);
  const c: TcpConn = { state: 'SYN_SENT', localIp, localPort: job.srcPort!, remoteIp, remotePort, iss, sndNxt: iss, rcvNxt: 0, jobId: job.id };
  const err = send(sim, d, c, ['SYN'], { mss: TCP_MSS });
  if (!err) sim.rt(d.id).tcp[keyOf(c)] = c;
  return err;
}

/** Забыть соединения задачи (тайм-аут «открыть сайт»). */
export function tcpAbort(sim: Simulator, deviceId: string, jobId: number) {
  const conns = sim.rt(deviceId).tcp;
  for (const [k, c] of Object.entries(conns)) if (c.jobId === jobId) delete conns[k];
}

/** RST в ответ на сегмент, для которого нет соединения (RFC 9293, 3.10.7.1). */
function reset(sim: Simulator, d: Device, pkt: Packet) {
  const l4 = pkt.l4!;
  const flags = l4.flags ?? [];
  if (flags.includes('RST')) return;
  const c: TcpConn = {
    state: 'ESTABLISHED',
    localIp: pkt.l3!.dst,
    localPort: l4.dstPort,
    remoteIp: pkt.l3!.src,
    remotePort: l4.srcPort,
    iss: 0,
    sndNxt: flags.includes('ACK') ? l4.ack ?? 0 : 0,
    rcvNxt: add32(l4.seq ?? 0, segLength(pkt)),
  };
  send(sim, d, c, flags.includes('ACK') ? ['RST'] : ['RST', 'ACK']);
}

function httpEnabled(d: Device) {
  return !!d.config.services?.http?.enabled;
}

/** Приём TCP-сегмента, адресованного устройству. */
export function tcpRx(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const l4 = pkt.l4!;
  const flags = l4.flags ?? [];
  const conns = sim.rt(d.id).tcp;
  const key = connKey(pkt.l3!.dst, l4.dstPort, pkt.l3!.src, l4.srcPort);
  const c = conns[key];

  if (!c) {
    if (flags.includes('RST')) return drop('TCP RST для несуществующего соединения — игнорирую');
    if (flags.includes('SYN') && !flags.includes('ACK') && l4.dstPort === HTTP_PORT && httpEnabled(d)) {
      const iss = isn(sim);
      const nc: TcpConn = {
        state: 'SYN_RCVD',
        localIp: pkt.l3!.dst,
        localPort: l4.dstPort,
        remoteIp: pkt.l3!.src,
        remotePort: l4.srcPort,
        iss,
        sndNxt: iss,
        rcvNxt: add32(l4.seq ?? 0, 1),
      };
      conns[key] = nc;
      send(sim, d, nc, ['SYN', 'ACK'], { mss: TCP_MSS });
      return { action: 'reply', reason: `TCP SYN на порт ${l4.dstPort} — шаг 2 рукопожатия: отвечаю SYN-ACK (мой ISN ${iss}, подтверждаю ${nc.rcvNxt})` };
    }
    reset(sim, d, pkt);
    if (l4.dstPort === HTTP_PORT && d.kind === 'server' && !httpEnabled(d)) {
      return { action: 'reply', reason: 'Порт 80 закрыт — HTTP-сервис не запущен. Отвечаю TCP RST (соединение отклонено)' };
    }
    return { action: 'reply', reason: `TCP-порт ${l4.dstPort} закрыт — отвечаю RST` };
  }

  const job = c.jobId !== undefined ? sim.job(c.jobId) : undefined;

  if (flags.includes('RST')) {
    delete conns[key];
    if (job && !job.done) {
      job.lines.push(
        c.state === 'SYN_SENT' ? 'Соединение отклонено: на сервере не запущен HTTP-сервис (TCP RST)' : 'Соединение сброшено сервером (TCP RST)',
      );
      job.done = true;
    }
    return { action: 'deliver', reason: c.state === 'SYN_SENT' ? 'Сервер ответил RST — соединение отклонено' : 'Получен RST — соединение сброшено' };
  }

  // Клиент: шаг 3 рукопожатия и запрос.
  if (c.state === 'SYN_SENT') {
    if (!(flags.includes('SYN') && flags.includes('ACK')) || l4.ack !== c.sndNxt) return drop('Ожидался SYN-ACK с подтверждением моего SYN — сегмент отброшен');
    c.rcvNxt = add32(l4.seq ?? 0, 1);
    c.state = 'ESTABLISHED';
    send(sim, d, c, ['ACK']);
    if (job) {
      job.phase = 'wait';
      send(sim, d, c, ['PSH', 'ACK'], { http: { kind: 'request', method: 'GET', host: job.target, path: job.path } });
    }
    return { action: 'reply', reason: 'SYN-ACK получен — шаг 3 рукопожатия: отправляю ACK, затем HTTP GET' };
  }

  if (flags.includes('SYN')) return drop('Повторный SYN в открытом соединении — игнорирую');
  if ((l4.seq ?? 0) !== c.rcvNxt) return drop(`Сегмент не по порядку: seq ${l4.seq}, ожидался ${c.rcvNxt} — отброшен`);

  const reasons: string[] = [];
  let action: Verdict['action'] = 'deliver';

  // Подтверждения.
  if (flags.includes('ACK')) {
    if (c.state === 'SYN_RCVD' && l4.ack === c.sndNxt) {
      c.state = 'ESTABLISHED';
      reasons.push('TCP ACK — рукопожатие завершено, соединение установлено');
    } else if (c.state === 'FIN_WAIT_1' && l4.ack === c.sndNxt) {
      c.state = 'FIN_WAIT_2';
    } else if (c.state === 'FIN_WAIT_1' || c.state === 'ESTABLISHED') {
      reasons.push(`ACK ${l4.ack}: собеседник подтвердил получение данных`);
    } else if (c.state === 'LAST_ACK' && l4.ack === c.sndNxt) {
      delete conns[key];
      return { action: 'deliver', reason: 'ACK на мой FIN — соединение закрыто с обеих сторон' };
    }
  }

  // Данные.
  const len = payloadLength(pkt);
  if (len > 0) {
    c.rcvNxt = add32(c.rcvNxt, len);
    const whole = !l4.chunk || l4.chunk[1] === encodeHttp(pkt.http!).length;
    if (pkt.http?.kind === 'request' && c.jobId === undefined) {
      const http = d.config.services?.http;
      const resp: HttpPayload = { kind: 'response', status: 200, title: http?.title, body: http?.body };
      const total = encodeHttp(resp).length;
      for (let s = 0; s < total; s += TCP_MSS) {
        const e = Math.min(total, s + TCP_MSS);
        send(sim, d, c, e === total ? ['PSH', 'ACK'] : ['ACK'], { http: resp, ...(total > TCP_MSS ? { chunk: [s, e] as [number, number] } : {}) });
      }
      send(sim, d, c, ['FIN', 'ACK']);
      c.state = 'FIN_WAIT_1';
      action = 'reply';
      reasons.push(`HTTP GET ${pkt.http.path ?? '/'} — отдаю страницу «${http?.title ?? ''}» (200 OK) и закрываю соединение (FIN)`);
    } else if (pkt.http?.kind === 'response') {
      if (whole && job && !job.done) {
        job.lines.push(`HTTP/1.1 ${pkt.http.status} OK`, '', `«${pkt.http.title ?? ''}»`, pkt.http.body ?? '');
        job.done = true;
      }
      if (!flags.includes('FIN')) send(sim, d, c, ['ACK']);
      action = 'reply';
      reasons.push(
        whole ? `HTTP-ответ ${pkt.http.status}: страница получена, браузер её показывает. Подтверждаю данные (ACK ${c.rcvNxt})` : `Часть HTTP-ответа (${len} байт) — подтверждаю ACK ${c.rcvNxt}`,
      );
    } else {
      if (!flags.includes('FIN')) send(sim, d, c, ['ACK']);
      reasons.push(`Принято ${len} байт данных`);
    }
  }

  // Закрытие.
  if (flags.includes('FIN')) {
    c.rcvNxt = add32(c.rcvNxt, 1);
    action = 'reply';
    if (c.state === 'ESTABLISHED') {
      send(sim, d, c, ['FIN', 'ACK']);
      c.state = 'LAST_ACK';
      reasons.push('Собеседник закрывает соединение (FIN) — подтверждаю и закрываю со своей стороны (FIN-ACK)');
    } else {
      send(sim, d, c, ['ACK']);
      delete conns[key];
      reasons.push('Получен FIN в ответ на мой — подтверждаю (ACK), соединение закрыто');
    }
  }

  return { action, reason: reasons.join('. ') || 'TCP-сегмент принят' };
}
