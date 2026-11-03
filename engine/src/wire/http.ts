// HTTP/1.1 поверх TCP: сообщение модели ⇄ байты.
// Кодирование детерминированное: никаких дат и случайных заголовков.
import type { HttpPayload } from '../model/packet';
import { fromUtf8, utf8 } from './bytes';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const REASONS: Record<number, string> = { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error' };

export function httpHtml(h: HttpPayload): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(h.title ?? '')}</title></head><body><p>${esc(h.body ?? '')}</p></body></html>`;
}

export function encodeHttp(h: HttpPayload): Uint8Array {
  if (h.kind === 'request') {
    return utf8(
      `${h.method ?? 'GET'} ${h.path ?? '/'} HTTP/1.1\r\n` +
        `Host: ${h.host ?? ''}\r\n` +
        'User-Agent: CisBanka/1.0\r\n' +
        'Accept: text/html\r\n' +
        'Connection: close\r\n\r\n',
    );
  }
  const body = utf8(httpHtml(h));
  const status = h.status ?? 200;
  const head = utf8(
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\n` +
      'Server: CisBanka\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n` +
      'Connection: close\r\n\r\n',
  );
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Длина HTTP-сообщения в байтах — нужна TCP для номеров последовательности. */
export const httpLength = (h: HttpPayload) => encodeHttp(h).length;

export interface HttpParsed {
  /** Стартовая строка: «GET / HTTP/1.1» или «HTTP/1.1 200 OK». */
  startLine: string;
  headers: { name: string; value: string; start: number; len: number }[];
  headerEnd: number;
  bodyStart: number;
  /** Восстановленное сообщение модели (если удалось). */
  payload?: HttpPayload;
}

/** Разбор HTTP-сообщения (или его начала — тогда без payload). */
export function decodeHttp(b: Uint8Array): HttpParsed | null {
  const text = fromUtf8(b);
  const lineEnd = text.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const startLine = text.slice(0, lineEnd);
  const req = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(startLine);
  const resp = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(startLine);
  if (!req && !resp) return null;

  // Смещения считаем в байтах: заголовки — ASCII, тело может быть UTF-8.
  const headers: HttpParsed['headers'] = [];
  let off = utf8(startLine).length + 2;
  let headerEnd = -1;
  const map: Record<string, string> = {};
  for (;;) {
    let e = off;
    while (e + 1 < b.length && !(b[e] === 13 && b[e + 1] === 10)) e++;
    if (e + 1 >= b.length) break;
    if (e === off) {
      headerEnd = off;
      break;
    }
    const line = fromUtf8(b.subarray(off, e));
    const c = line.indexOf(':');
    if (c > 0) {
      const name = line.slice(0, c);
      const value = line.slice(c + 1).trim();
      headers.push({ name, value, start: off, len: e - off });
      map[name.toLowerCase()] = value;
    }
    off = e + 2;
  }
  const bodyStart = headerEnd < 0 ? b.length : headerEnd + 2;
  let payload: HttpPayload | undefined;
  if (req) {
    payload = { kind: 'request', method: 'GET', path: req[2], host: map.host };
  } else if (headerEnd >= 0) {
    const len = Number(map['content-length'] ?? b.length - bodyStart);
    const html = fromUtf8(b.subarray(bodyStart, bodyStart + len));
    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
    const body = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1];
    payload = { kind: 'response', status: Number(resp![1]), title: title && unesc(title), body: body && unesc(body) };
  }
  return { startLine, headers, headerEnd, bodyStart, payload };
}
