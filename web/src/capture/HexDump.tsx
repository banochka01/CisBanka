// Hex + ASCII дамп кадра. Байты выбранного поля подсвечены; клик по байту выбирает поле в дереве.
import { useEffect, useRef } from 'react';

interface Props {
  bytes: Uint8Array;
  /** Диапазон выбранного поля. */
  range: { start: number; len: number } | null;
  onByte: (offset: number) => void;
}

const printable = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');

export function HexDump({ bytes, range, onByte }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lo = range && range.len > 0 ? range.start : -1;
  const hi = range && range.len > 0 ? range.start + range.len : -1;
  const lines = Math.ceil(bytes.length / 16);

  useEffect(() => {
    if (lo < 0) return;
    ref.current?.querySelector(`[data-off="${lo}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [lo]);

  const cell = (i: number, text: string, cls: string) => (
    <span key={`${cls}${i}`} data-off={cls === 'hx-b' ? i : undefined} className={`${cls}${i >= lo && i < hi ? ' on' : ''}`} onClick={() => onByte(i)}>
      {text}
    </span>
  );

  return (
    <div className="hx" ref={ref} aria-label="Байты кадра">
      {Array.from({ length: lines }, (_, l) => {
        const base = l * 16;
        const hexCells = [];
        const asciiCells = [];
        for (let j = 0; j < 16; j++) {
          const i = base + j;
          if (i >= bytes.length) break;
          hexCells.push(cell(i, bytes[i].toString(16).padStart(2, '0'), 'hx-b'));
          if (j === 7) hexCells.push(<span key={`g${i}`} className="hx-gap" />);
          asciiCells.push(cell(i, printable(bytes[i]), 'hx-a'));
        }
        return (
          <div key={l} className="hx-line">
            <span className="hx-off">{base.toString(16).padStart(4, '0')}</span>
            <span className="hx-hex">{hexCells}</span>
            <span className="hx-ascii">{asciiCells}</span>
          </div>
        );
      })}
    </div>
  );
}
