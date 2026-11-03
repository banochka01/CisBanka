// Список пакетов: виртуализирован — в DOM только видимые строки, тянет десятки тысяч кадров.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CaptureTab } from '../store/capture';
import { rowClass, rowsOf } from './rows';

const ROW_H = 22;
const OVERSCAN = 8;

export function PacketList({ tab, selected, onSelect }: { tab: CaptureTab; selected: number | null; onSelect: (no: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(200);
  const stick = useRef(true);
  const total = tab.cap.frames.length;

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

  const first = Math.max(0, Math.floor(scroll / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scroll + height) / ROW_H) + OVERSCAN);
  const rows = rowsOf(tab.cap, last).slice(first, last);

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
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H;
        }}
      >
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {rows.map((r) => (
            <div
              key={r.no}
              role="row"
              aria-selected={selected === r.no}
              className={`pk-row ${rowClass(r)}${selected === r.no ? ' sel' : ''}`}
              style={{ position: 'absolute', top: (r.no - 1) * ROW_H, height: ROW_H, left: 0, right: 0 }}
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
          ))}
        </div>
        {total === 0 && <div className="pk-empty muted">{tab.cap.running ? 'Захват идёт — кадров пока нет. Запустите ping или откройте сайт.' : 'Захват остановлен.'}</div>}
      </div>
    </div>
  );
}
