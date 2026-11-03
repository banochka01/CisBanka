// «Follow TCP stream»: диалог одного соединения — запрос клиента красным, ответ сервера синим.
import { useMemo, useState } from 'react';
import { followTcp } from '@ciscobanka/engine';
import { useCapture } from '../store/capture';
import { rowsOf } from './rows';

type View = 'ascii' | 'hex';

const asText = (b: Uint8Array) => Array.from(b, (x) => (x === 10 || x === 13 || x === 9 || (x >= 0x20 && x < 0x7f) ? String.fromCharCode(x) : '.')).join('');
const utf8 = new TextDecoder();

function hexdump(b: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const s = b.subarray(i, i + 16);
    out.push(`${i.toString(16).padStart(8, '0')}  ${Array.from(s, (x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${asText(s).replace(/[\r\n\t]/g, '.')}`);
  }
  return out.join('\n');
}

export function FollowDialog() {
  const follow = useCapture((s) => s.follow);
  const tab = useCapture((s) => s.tabs.find((t) => t.id === s.follow?.tabId));
  const [view, setView] = useState<View | 'utf8'>('utf8');
  const [side, setSide] = useState<'both' | 'client' | 'server'>('both');
  const stream = useMemo(() => {
    if (!follow || !tab) return null;
    return followTcp(rowsOf(tab.cap), follow.stream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, tab?.version]);

  if (!follow || !tab) return null;
  const close = () => useCapture.getState().setFollow(null);
  const chunks = stream?.chunks.filter((c) => side === 'both' || c.from === side) ?? [];
  const render = (b: Uint8Array) => (view === 'hex' ? hexdump(b) : view === 'ascii' ? asText(b) : utf8.decode(b));

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="follow" role="dialog" aria-label="Follow TCP stream" onClick={(e) => e.stopPropagation()}>
        <div className="follow-head">
          <b>Follow TCP Stream (tcp.stream eq {follow.stream})</b>
          {stream && (
            <span className="muted">
              {stream.client.ip}:{stream.client.port} → {stream.server.ip}:{stream.server.port}
            </span>
          )}
          <div className="spacer" />
          <button className="window-close" onClick={close} title="Закрыть">
            ✕
          </button>
        </div>
        <pre className="follow-body">
          {!stream || !chunks.length ? (
            <span className="muted">В этом соединении нет данных (только служебные сегменты).</span>
          ) : (
            chunks.map((c, i) => (
              <span key={i} className={c.from === 'client' ? 'fl-client' : 'fl-server'} title={`Кадр ${c.no}: ${c.data.length} байт`}>
                {render(c.data)}
                {view === 'hex' ? '\n' : ''}
              </span>
            ))
          )}
        </pre>
        {stream && (
          <div className="follow-foot">
            <span>
              <span className="fl-client">клиент → {stream.clientBytes} байт</span>, <span className="fl-server">сервер → {stream.serverBytes} байт</span>, сегментов: {stream.frames.length}
            </span>
            <div className="spacer" />
            <label>
              Показать{' '}
              <select className="btn small" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
                <option value="both">весь диалог</option>
                <option value="client">только клиент → сервер</option>
                <option value="server">только сервер → клиент</option>
              </select>
            </label>
            <label>
              как{' '}
              <select className="btn small" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
                <option value="utf8">UTF-8</option>
                <option value="ascii">ASCII</option>
                <option value="hex">Hex Dump</option>
              </select>
            </label>
            <button
              className="btn small"
              onClick={() => {
                useCapture.getState().setFilter(tab.id, `tcp.stream eq ${follow.stream}`);
                close();
              }}
              title="Оставить в списке только кадры этого соединения"
            >
              Фильтр по потоку
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
