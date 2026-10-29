// Прикладные «Инструменты» ПК: ping, traceroute, открыть сайт, nslookup, DHCP-клиент.
// Каждая задача — Job с текстовым выводом; всё состояние хранится в SimState,
// поэтому шаг назад откатывает и вывод.
import type { Device } from '../model/topology';
import type { Packet } from '../model/packet';
import type { Verdict } from '../model/events';
import type { Simulator } from '../sim/Simulator';
import type { Job, Timer } from '../sim/state';
import { isValidIp } from '../util/ip';
import { BCAST_IP, broadcastOut, defaultTtl, effectiveDns, l3Interfaces, sendIp } from '../l3/stack';

const PING_INTERVAL = 1000;
const PING_TIMEOUT = 1000;
const TRACE_MAX_HOPS = 30;
const DNS_TIMEOUT = 2000;
const HTTP_TIMEOUT = 3000;
const DHCP_TIMEOUT = 4000;

const drop = (reason: string): Verdict => ({ action: 'drop', reason });

function finish(job: Job, line?: string) {
  if (line) job.lines.push(line);
  job.done = true;
}

function echo(sim: Simulator, d: Device, job: Job, seq: number, ttl: number) {
  return sendIp(sim, d, { l3: { src: '', dst: job.ip!, ttl, proto: 'ICMP' }, icmp: { type: 'echo-request', id: job.id, seq } });
}

// ---------- запуск задач ----------

function start(sim: Simulator, kind: Job['kind'], deviceId: string, target: string): Job {
  const job = sim.newJob(kind, deviceId, target.trim());
  if (isValidIp(job.target)) {
    job.ip = job.target;
    proceed(sim, job);
  } else resolve(sim, job);
  return job;
}

export function startPing(sim: Simulator, deviceId: string, target: string, count: number): Job {
  const job = sim.newJob('ping', deviceId, target.trim());
  job.count = count;
  job.sentAt = {};
  job.results = {};
  job.rtts = [];
  if (isValidIp(job.target)) {
    job.ip = job.target;
    proceed(sim, job);
  } else resolve(sim, job);
  return job;
}

export const startTraceroute = (sim: Simulator, deviceId: string, target: string) => start(sim, 'traceroute', deviceId, target);
export const startNslookup = (sim: Simulator, deviceId: string, name: string) => start(sim, 'nslookup', deviceId, name);

export function startHttp(sim: Simulator, deviceId: string, url: string): Job {
  const m = /^(?:https?:\/\/)?([^/:\s]+)(\/[^\s]*)?$/i.exec(url.trim());
  const job = sim.newJob('http', deviceId, m?.[1] ?? url);
  if (!m) {
    finish(job, `Некорректный адрес: ${url}`);
    return job;
  }
  job.path = m[2] ?? '/';
  if (isValidIp(job.target)) {
    job.ip = job.target;
    proceed(sim, job);
  } else resolve(sim, job);
  return job;
}

export function startDhcp(sim: Simulator, deviceId: string): Job {
  const d = sim.device(deviceId);
  const job = sim.newJob('dhcp', deviceId, 'DHCP');
  const port = d.ports.find((p) => p.l3?.dhcp);
  if (!port) {
    finish(job, 'На интерфейсе не включён режим DHCP');
    return job;
  }
  sim.schedule(0, { kind: 'timer', deviceId, timer: { t: 'dhcp-start', job: job.id, ifaceId: port.id } });
  return job;
}

export function dhcpJobLine(sim: Simulator, jobId: number, line: string, done: boolean) {
  const job = sim.job(jobId);
  if (!job || job.done) return;
  job.lines.push(line);
  job.done = done;
}

function resolve(sim: Simulator, job: Job) {
  const d = sim.device(job.deviceId);
  const dns = effectiveDns(sim, d);
  if (!dns) return finish(job, `Не удалось найти узел ${job.target}: DNS-сервер не задан`);
  job.phase = 'dns';
  const err = sendIp(sim, d, {
    l3: { src: '', dst: dns, ttl: defaultTtl(d), proto: 'UDP' },
    l4: { srcPort: 1024 + (job.id % 60000), dstPort: 53 },
    dns: { id: job.id, qr: 'query', name: job.target },
  });
  if (err) return finish(job, `Не удалось обратиться к DNS-серверу ${dns}: ${err}`);
  sim.schedule(DNS_TIMEOUT, { kind: 'timer', deviceId: d.id, timer: { t: 'dns-timeout', job: job.id } });
}

function proceed(sim: Simulator, job: Job) {
  const d = sim.device(job.deviceId);
  job.phase = 'run';
  const name = job.ip === job.target ? job.ip : `${job.target} [${job.ip}]`;
  switch (job.kind) {
    case 'ping':
      job.lines.push(`Обмен пакетами с ${name} по 32 байт:`);
      sim.schedule(0, { kind: 'timer', deviceId: d.id, timer: { t: 'ping-send', job: job.id, seq: 1 } });
      break;
    case 'traceroute':
      job.lines.push(`Трассировка маршрута к ${name}`, `с максимальным числом прыжков ${TRACE_MAX_HOPS}:`);
      sim.schedule(0, { kind: 'timer', deviceId: d.id, timer: { t: 'trace-send', job: job.id, ttl: 1 } });
      break;
    case 'nslookup':
      finish(job, `Имя: ${job.target}\nАдрес: ${job.ip}`);
      break;
    case 'http': {
      job.phase = 'syn';
      job.srcPort = 49152 + (job.id % 16000);
      job.lines.push(`Подключение к ${name}:80…`);
      const err = sendIp(sim, d, {
        l3: { src: '', dst: job.ip!, ttl: defaultTtl(d), proto: 'TCP' },
        l4: { srcPort: job.srcPort, dstPort: 80, flags: ['SYN'] },
      });
      if (err) return finish(job, `Не удалось подключиться: ${err}`);
      sim.schedule(HTTP_TIMEOUT, { kind: 'timer', deviceId: d.id, timer: { t: 'http-timeout', job: job.id } });
      break;
    }
  }
}

function pingCheckDone(job: Job) {
  const r = Object.values(job.results!);
  if (r.length < job.count!) return;
  const ok = r.filter((x) => x === 'ok').length;
  const lost = job.count! - ok;
  job.lines.push(
    '',
    `Статистика Ping для ${job.ip}:`,
    `    Пакетов: отправлено = ${job.count}, получено = ${ok}, потеряно = ${lost} (${Math.round((lost / job.count!) * 100)}% потерь)`,
  );
  if (job.rtts!.length) {
    const t = job.rtts!;
    job.lines.push(`Время приёма-передачи (мс): мин = ${Math.min(...t)}, макс = ${Math.max(...t)}, среднее = ${Math.round(t.reduce((a, b) => a + b, 0) / t.length)}`);
  }
  job.done = true;
}

// ---------- таймеры ----------

export function handleTimer(sim: Simulator, deviceId: string, timer: Timer, onArpTimeout: (sim: Simulator, deviceId: string, key: string) => void) {
  if (timer.t === 'arp-timeout') return onArpTimeout(sim, deviceId, timer.key);
  const job = sim.job(timer.job);
  if (!job || job.done) return;
  const d = sim.device(deviceId);
  switch (timer.t) {
    case 'ping-send': {
      const err = echo(sim, d, job, timer.seq, defaultTtl(d));
      job.sentAt![timer.seq] = sim.now;
      if (err) {
        job.results![timer.seq] = 'err';
        job.lines.push(`Сбой передачи: ${err}`);
      } else {
        sim.schedule(PING_TIMEOUT, { kind: 'timer', deviceId, timer: { t: 'ping-timeout', job: job.id, seq: timer.seq } });
      }
      if (timer.seq < job.count!) sim.schedule(PING_INTERVAL, { kind: 'timer', deviceId, timer: { t: 'ping-send', job: job.id, seq: timer.seq + 1 } });
      pingCheckDone(job);
      break;
    }
    case 'ping-timeout':
      if (job.results![timer.seq] === undefined) {
        job.results![timer.seq] = 'lost';
        job.lines.push('Превышен интервал ожидания для запроса.');
        pingCheckDone(job);
      }
      break;
    case 'trace-send': {
      if (timer.ttl > TRACE_MAX_HOPS) return finish(job, 'Трассировка завершена.');
      job.ttl = timer.ttl;
      job.sentAt = { [timer.ttl]: sim.now };
      const err = echo(sim, d, job, timer.ttl, timer.ttl);
      if (err) return finish(job, `Сбой передачи: ${err}`);
      sim.schedule(PING_TIMEOUT, { kind: 'timer', deviceId, timer: { t: 'trace-timeout', job: job.id, ttl: timer.ttl } });
      break;
    }
    case 'trace-timeout':
      if (job.ttl === timer.ttl && job.answeredTtl !== timer.ttl) {
        job.lines.push(`${String(timer.ttl).padStart(3)}     *        Превышен интервал ожидания для запроса.`);
        sim.schedule(0, { kind: 'timer', deviceId, timer: { t: 'trace-send', job: job.id, ttl: timer.ttl + 1 } });
      }
      break;
    case 'dns-timeout':
      if (job.phase === 'dns') finish(job, `DNS-сервер не отвечает — не удалось найти узел ${job.target}`);
      break;
    case 'http-timeout':
      finish(job, 'Сервер не отвечает (превышено время ожидания)');
      break;
    case 'dhcp-start': {
      const iface = l3Interfaces(sim, d).find((i) => i.id === timer.ifaceId)!;
      const xid = Math.floor(sim.random() * 0xffffffff);
      sim.rt(d.id).dhcp[iface.id] = { state: 'selecting', xid, jobId: job.id };
      job.lines.push(`DHCPDISCOVER отправлен (xid 0x${xid.toString(16).toUpperCase()})…`);
      broadcastOut(sim, d, iface, {
        l3: { src: '0.0.0.0', dst: BCAST_IP, ttl: defaultTtl(d), proto: 'UDP' },
        l4: { srcPort: 68, dstPort: 67 },
        dhcp: { op: 'DISCOVER', xid, chaddr: iface.mac },
      });
      sim.schedule(DHCP_TIMEOUT, { kind: 'timer', deviceId, timer: { t: 'dhcp-timeout', job: job.id, ifaceId: iface.id, xid } });
      break;
    }
    case 'dhcp-timeout': {
      const st = sim.rt(d.id).dhcp[timer.ifaceId];
      if (st && st.xid === timer.xid && st.state !== 'bound') {
        st.state = 'failed';
        finish(job, 'DHCP-сервер не ответил — адрес не получен');
      }
      break;
    }
  }
}

// ---------- входящие ответы ----------

export function onIcmp(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const icmp = pkt.icmp!;
  const src = pkt.l3!.src;
  const job = sim.job(icmp.id);
  if (!job || job.deviceId !== d.id || job.done) return drop(`ICMP ${icmp.type} от ${src} — никто его не ждал (задача уже завершена)`);
  const rtt = sim.now - (job.sentAt?.[icmp.seq] ?? sim.now);

  if (job.kind === 'ping') {
    if (job.results![icmp.seq] !== undefined) return drop('Ответ пришёл слишком поздно — запрос уже засчитан как потерянный');
    if (icmp.type === 'echo-reply') {
      job.results![icmp.seq] = 'ok';
      job.rtts!.push(rtt);
      job.lines.push(`Ответ от ${src}: число байт=32 время=${rtt}мс TTL=${pkt.l3!.ttl}`);
    } else {
      job.results![icmp.seq] = 'err';
      job.lines.push(
        icmp.type === 'time-exceeded'
          ? `Ответ от ${src}: Превышен срок жизни (TTL) при передаче пакета.`
          : `Ответ от ${src}: Заданная сеть недоступна.`,
      );
    }
    pingCheckDone(job);
    return { action: 'deliver', reason: icmp.type === 'echo-reply' ? `Эхо-ответ от ${src} — ping успешен (${rtt} мс)` : `ICMP ${icmp.type} от ${src} — ping не прошёл` };
  }

  if (job.kind === 'traceroute' && icmp.seq === job.ttl && job.answeredTtl !== job.ttl) {
    job.answeredTtl = job.ttl;
    const hop = `${String(job.ttl).padStart(3)}  ${String(rtt).padStart(4)} мс    ${src}`;
    if (icmp.type === 'time-exceeded') {
      job.lines.push(hop);
      sim.schedule(0, { kind: 'timer', deviceId: d.id, timer: { t: 'trace-send', job: job.id, ttl: job.ttl + 1 } });
      return { action: 'deliver', reason: `Прыжок ${job.ttl}: ${src} сообщил, что TTL истёк — иду дальше с TTL ${job.ttl + 1}` };
    }
    if (icmp.type === 'echo-reply') {
      job.lines.push(hop, '', 'Трассировка завершена.');
      job.done = true;
      return { action: 'deliver', reason: 'Получатель ответил — трассировка завершена' };
    }
    job.lines.push(`${String(job.ttl).padStart(3)}  ${src} сообщает: Заданная сеть недоступна.`, '', 'Трассировка завершена.');
    job.done = true;
    return { action: 'deliver', reason: `${src} не знает маршрута — трассировка прервана` };
  }
  return drop('ICMP-ответ не относится к текущему шагу задачи');
}

export function onDns(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const r = pkt.dns!;
  const job = sim.job(r.id);
  if (!job || job.deviceId !== d.id || job.done || job.phase !== 'dns') return drop('DNS-ответ никто не ждал');
  if (!r.answer) {
    finish(job, `Не удалось найти узел ${job.target}: имя не существует (NXDOMAIN)`);
    return { action: 'deliver', reason: `DNS: имени ${r.name} нет на сервере` };
  }
  job.ip = r.answer;
  proceed(sim, job);
  return { action: 'deliver', reason: `DNS-ответ: ${r.name} = ${r.answer}. Продолжаю задачу` };
}

export function onTcp(sim: Simulator, d: Device, pkt: Packet): Verdict {
  const l4 = pkt.l4!;
  const flags = l4.flags ?? [];
  const job = Object.values(sim.state.jobs).find((j) => j.kind === 'http' && j.deviceId === d.id && j.srcPort === l4.dstPort && !j.done);
  if (!job) return drop(`TCP-порт ${l4.dstPort} закрыт — сегмент отброшен`);
  if (flags.includes('RST')) {
    finish(job, 'Соединение отклонено: на сервере не запущен HTTP-сервис (TCP RST)');
    return { action: 'deliver', reason: 'Сервер ответил RST — соединение отклонено' };
  }
  const reply = (fl: typeof flags, extra: Partial<Packet> = {}) =>
    sendIp(sim, d, {
      l3: { src: pkt.l3!.dst, dst: pkt.l3!.src, ttl: defaultTtl(d), proto: 'TCP' },
      l4: { srcPort: job.srcPort!, dstPort: 80, flags: fl },
      ...extra,
    });
  if (job.phase === 'syn' && flags.includes('SYN') && flags.includes('ACK')) {
    job.phase = 'wait';
    reply(['ACK']);
    reply(['PSH', 'ACK'], { http: { kind: 'request', method: 'GET', host: job.target, path: job.path } });
    return { action: 'reply', reason: 'SYN-ACK получен — шаг 3 рукопожатия: отправляю ACK, затем HTTP GET' };
  }
  if (pkt.http?.kind === 'response') {
    job.lines.push(`HTTP/1.1 ${pkt.http.status} OK`, '', `«${pkt.http.title ?? ''}»`, pkt.http.body ?? '');
    job.done = true;
    return { action: 'deliver', reason: `HTTP-ответ ${pkt.http.status}: страница получена, браузер её показывает` };
  }
  return { action: 'deliver', reason: 'TCP-сегмент принят' };
}
