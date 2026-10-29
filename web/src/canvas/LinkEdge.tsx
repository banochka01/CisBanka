import { memo, useState } from 'react';
import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import type { CableType, Led } from '@ciscobanka/engine';
import { CABLE_LABELS } from '../ui/portInfo';

export type LinkEdgeType = Edge<
  {
    cable: CableType;
    ledA: Led;
    ledB: Led;
    portA: string;
    portB: string;
    devA: string;
    devB: string;
    up: boolean;
    reason?: string;
    /** Линк лежит из-за кабеля (не тот тип/не тот порт) — провод красный с «!». */
    badCable: boolean;
  },
  'link'
>;

const LED_OFFSET = 40;
const LED_COLORS: Record<Led, string> = { none: 'transparent', green: 'var(--led-green)', orange: 'var(--led-orange)', red: 'var(--led-red)' };

export const LinkEdge = memo(function LinkEdge({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<LinkEdgeType>) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (!data) return null;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const a = { x: sourceX + ux * LED_OFFSET, y: sourceY + uy * LED_OFFSET };
  const b = { x: targetX - ux * LED_OFFSET, y: targetY - uy * LED_OFFSET };
  const mid = { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };
  const path = `M${sourceX},${sourceY} L${targetX},${targetY}`;
  const stroke = data.badCable ? 'var(--led-red)' : data.cable === 'fiber' ? 'var(--cable-fiber)' : 'var(--cable-copper)';
  const state = data.up ? 'Линк поднят' : 'Линк не поднят';

  return (
    <>
      <path
        d={path}
        stroke={stroke}
        strokeWidth={selected ? 3.5 : 2}
        strokeDasharray={data.cable === 'crossover' ? '7 5' : undefined}
        fill="none"
      />
      <path
        d={path}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        className="react-flow__edge-interaction"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      {len > LED_OFFSET * 2.4 && (
        <>
          <circle cx={a.x} cy={a.y} r={5} fill={LED_COLORS[data.ledA]} stroke="var(--bg)" strokeWidth={1.5} />
          <circle cx={b.x} cy={b.y} r={5} fill={LED_COLORS[data.ledB]} stroke="var(--bg)" strokeWidth={1.5} />
        </>
      )}
      <EdgeLabelRenderer>
        <div className="port-label" style={{ transform: `translate(-50%,-50%) translate(${a.x + uy * 14}px,${a.y - ux * 14}px)` }}>
          {data.portA}
        </div>
        <div className="port-label" style={{ transform: `translate(-50%,-50%) translate(${b.x + uy * 14}px,${b.y - ux * 14}px)` }}>
          {data.portB}
        </div>
        {data.badCable && (
          <button
            className="link-bang nodrag nopan"
            style={{ transform: `translate(-50%,-50%) translate(${mid.x}px,${mid.y}px)` }}
            onClick={() => setPinned((v) => !v)}
            title="Почему линк не работает?"
            data-edge={id}
          >
            !
          </button>
        )}
        {(hover || pinned) && (
          <div className="link-tooltip" style={{ transform: `translate(-50%, 16px) translate(${mid.x}px,${mid.y}px)` }}>
            <div>
              <b>{data.devA}</b> {data.portA} ↔ <b>{data.devB}</b> {data.portB}
            </div>
            <div>Кабель: {CABLE_LABELS[data.cable]}</div>
            <div className={data.up ? 'ok' : 'bad'}>{state}</div>
            {!data.up && data.reason && <div className="bad">{data.reason}</div>}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});
