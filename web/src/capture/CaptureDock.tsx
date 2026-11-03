// Анализатор трафика: док-панель снизу с изменяемой высотой (или плавающее окно) с вкладками захватов.
import { useRef, useState } from 'react';
import { pointTitle, useCapture, type CaptureTab } from '../store/capture';
import { useSim } from '../store/sim';
import { useStore } from '../store/project';
import { PacketList } from './PacketList';

function Toolbar({ tab }: { tab: CaptureTab }) {
  const { stop, resume, clear } = useCapture.getState();
  const mode = useSim((s) => s.mode);
  const playing = useSim((s) => s.playing);
  const running = tab.cap.running;
  return (
    <div className="cap-toolbar">
      <button className="btn small" onClick={() => resume(tab.id)} disabled={running} title="Продолжить захват">
        ▶ Старт
      </button>
      <button className="btn small" onClick={() => stop(tab.id)} disabled={!running} title="Остановить захват">
        ■ Стоп
      </button>
      <button className="btn small" onClick={() => clear(tab.id)} title="Очистить список">
        ⌫ Очистить
      </button>
      {mode === 'simulation' && (
        <button className="btn small" onClick={() => useSim.getState().setPlaying(!playing)} title="Пауза/продолжение симуляции">
          {playing ? '⏸ Пауза симуляции' : '⏵ Продолжить симуляцию'}
        </button>
      )}
      <span className="muted cap-count">
        {running ? <span className="cap-live">● идёт захват</span> : 'остановлен'} · кадров: {tab.cap.frames.length}
      </span>
    </div>
  );
}

export function CaptureDock() {
  const tabs = useCapture((s) => s.tabs);
  const active = useCapture((s) => s.active);
  const detached = useCapture((s) => s.detached);
  const height = useCapture((s) => s.height);
  const collapsed = useCapture((s) => s.collapsed);
  // подписи вкладок зависят от имён устройств
  useStore((s) => s.project);
  const [selected, setSelected] = useState<Record<number, number | null>>({});
  const [pos, setPos] = useState({ x: 16, y: 96 });
  const drag = useRef<{ x: number; y: number; h: number } | null>(null);
  const { setActive, close, setDetached, setHeight, setCollapsed } = useCapture.getState();

  if (!tabs.length) return null;
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  const onResizeStart = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (drag.current) setHeight(drag.current.h - (e.clientY - drag.current.y));
  };
  const onMoveStart = (e: React.PointerEvent) => {
    if (!detached || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y, h: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (detached && drag.current) setPos({
        x: Math.min(window.innerWidth - 200, Math.max(0, e.clientX - drag.current.x)),
        y: Math.min(window.innerHeight - 80, Math.max(0, e.clientY - drag.current.y)),
      });
  };

  const body = (
    <>
      <div className="cap-tabs" onPointerDown={onMoveStart} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
        <span className="cap-title">🔍 Анализатор</span>
        {tabs.map((t) => (
          <div key={t.id} className={`cap-tab${t.id === tab.id ? ' active' : ''}`} onClick={() => setActive(t.id)} title={pointTitle(t.point)}>
            <span className={t.cap.running ? 'cap-dot live' : 'cap-dot'} />
            {pointTitle(t.point)}
            <button
              className="cap-tab-x"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
              title="Закрыть вкладку"
            >
              ×
            </button>
          </div>
        ))}
        <div className="spacer" />
        {!detached && (
          <button className="btn ghost small" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Развернуть' : 'Свернуть'}>
            {collapsed ? '▴' : '▾'}
          </button>
        )}
        <button className="btn ghost small" onClick={() => setDetached(!detached)} title={detached ? 'Прикрепить к низу окна' : 'Открепить в отдельное окно'}>
          {detached ? '⇲ Прикрепить' : '⇱ Открепить'}
        </button>
      </div>
      {!(collapsed && !detached) && (
        <>
          <Toolbar tab={tab} />
          <PacketList tab={tab} selected={selected[tab.id] ?? null} onSelect={(no) => setSelected((s) => ({ ...s, [tab.id]: no }))} />
        </>
      )}
    </>
  );

  if (detached) {
    return (
      <div
        className="cap-float"
        style={{ left: pos.x, top: pos.y, maxWidth: `calc(100vw - ${pos.x + 16}px)`, maxHeight: `calc(100vh - ${pos.y + 16}px)` }} role="dialog" aria-label="Анализатор трафика">
        {body}
      </div>
    );
  }
  return (
    <section className="cap-dock" style={{ height: collapsed ? undefined : height }} aria-label="Анализатор трафика">
      {!collapsed && <div className="cap-resize" onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={() => (drag.current = null)} title="Потяните, чтобы изменить высоту" />}
      {body}
    </section>
  );
}
