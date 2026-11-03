// Список пакетов: виртуализирован — в DOM только видимые строки, тянет десятки тысяч кадров.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CaptureTab } from '../store/capture';
import { rowClass, rowsOf } from './rows';

const ROW_H = 22;
const OVERSCAN = 8;

interface Props {
  tab: CaptureTab;
  /** Индексы видимых строк после фильтра (null — все). */
  indices: number[] | null;
  onSelect: (no: number) => void;
}

export function PacketList({ tab, indices, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(200);
  const stick = useRef(true);
  const total = indices ? indices.length : tab.cap.frames.length;
  const selected = tab.selected;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Как в Wireshark: если список прокручен до конца, новые кадры прокручивают его дальше.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [total, tab.version]);

  const posOf = (no: number) => (indices ? indices.indexOf(no - 1) : no - 1);

  // Выбор пришёл со схемы — прокручиваем к строке.
  useEffect(() => {
    const el = ref.current;
    if (!el || selected === null || !tab.scrollSeq) return;
    const p = posOf(selected);
    if (p < 0) return;
    const top = p * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 2;
    stick.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.scrollSeq]);

  const first = Math.max(0, Math.floor(scroll / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scroll + height) / ROW_H) + OVERSCAN);
  const all = rowsOf(tab.cap, indices ? (indices[last - 1] ?? -1) + 1 : last);
  const visible: { pos: number; i: number }[] = [];
  for (let p = first; p < last; p++) visible.push({ pos: p, i: indices ? indices[p] : p });

  const move = (delta: number) => {
    if (!total) return;
    const cur = selected === null ? -1 : posOf(selected);
    const p = Math.max(0, Math.min(total - 1, cur < 0 ? (delta > 0 ? 0 : total - 1) : cur + delta));
    const i = indices ? indices[p] : p;
    onSelect(i + 1);
    const el = ref.current;
    if (el) {
      const top = p * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
  };

  return (
    <div className="pk-list" role="grid" aria-rowcount={total}>
      <div className="pk-row pk-head" role="row">
        <span>No.</span>
        <span>Time</span>
        <span>Source</span>
        <span>Destination</span>
        <span>Protocol</span>
        <span>Length</span>
        <span>Info</span>
      </div>
      <div
        className="pk-body"
        ref={ref}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -1e9, End: 1e9 }[e.key];
          if (step !== undefined) {
            e.preventDefault();
            move(step);
          }
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H;
        }}
      >
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map(({ pos, i }) => {
            const r = all[i];
            if (!r) return null;
            const sel = selected === r.no;
            return (
              <div
                key={r.no}
                role="row"
                aria-selected={sel}
                className={`pk-row ${rowClass(r)}${sel ? ' sel' : ''}`}
                style={{ position: 'absolute', top: pos * ROW_H, height: ROW_H, left: 0, right: 0 }}
                onClick={() => onSelect(r.no)}
              >
                <span>{r.no}</span>
                <span>{r.time.toFixed(6)}</span>
                <span>{r.src}</span>
                <span>{r.dst}</span>
                <span>{r.protocol}</span>
                <span>{r.length}</span>
                <span title={r.info}>{r.info}</span>
              </div>
            );
          })}
        </div>
        {total === 0 && (
          <div className="pk-empty muted">
            {indices ? 'Ни один кадр не подходит под фильтр.' : tab.cap.running ? 'Захват идёт — кадров пока нет. Запустите ping или откройте сайт.' : 'Захват остановлен.'}
          </div>
        )}
      </div>
    </div>
  );
}
