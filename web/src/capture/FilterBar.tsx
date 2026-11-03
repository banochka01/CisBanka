// Строка display-фильтра: зелёная — фильтр верный, красная — ошибка (с подсказкой), Enter — применить.
import { useEffect, useMemo, useState } from 'react';
import { compileFilter } from '@ciscobanka/engine';

const EXAMPLES = ['ip.addr==192.168.1.10', 'arp', 'icmp', 'dns', 'dhcp', 'http', 'tcp.port==80', 'tcp.flags.syn==1', 'udp.port==53', '!arp && !dhcp', 'tcp.stream==0'];

export function FilterBar({ applied, onApply }: { applied: string; onApply: (text: string) => void }) {
  const [text, setText] = useState(applied);
  useEffect(() => setText(applied), [applied]);
  const r = useMemo(() => compileFilter(text), [text]);
  const state = !text.trim() ? '' : r.ok ? 'valid' : 'invalid';
  const dirty = text !== applied;
  return (
    <div className="cap-filter">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (r.ok) onApply(text);
        }}
      >
        <input
          className={`cap-filter-input ${state}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Фильтр отображения… например ip.addr==192.168.1.10 && tcp.port==80"
          aria-label="Display-фильтр"
          aria-invalid={state === 'invalid'}
          list="cap-filter-examples"
          spellCheck={false}
        />
        <datalist id="cap-filter-examples">
          {EXAMPLES.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <button className="btn small" type="submit" disabled={!r.ok || !dirty} title="Применить (Enter)">
          Применить
        </button>
        {applied && (
          <button className="btn small ghost" type="button" onClick={() => onApply('')} title="Сбросить фильтр">
            ✕
          </button>
        )}
      </form>
      {!r.ok && (
        <div className="cap-filter-err" role="alert">
          {r.error}
          <span className="mono muted"> — позиция {r.pos + 1}</span>
        </div>
      )}
    </div>
  );
}
