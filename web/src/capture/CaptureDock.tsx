// Анализатор трафика: док-панель снизу с изменяемой высотой (или плавающее окно) с вкладками захватов.
// Внутри — как в Wireshark: список пакетов, дерево разбора и hex-дамп с взаимной подсветкой.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fieldAt, type Field } from '@ciscobanka/engine';
import { pointTitle, useCapture, type CaptureTab } from '../store/capture';
import { useSim } from '../store/sim';
import { useStore } from '../store/project';
import { PacketList } from './PacketList';
import { DetailsTree, fieldByKey, keyOfPath, type FieldKey } from './DetailsTree';
import { HexDump } from './HexDump';
import { FilterBar } from './FilterBar';
import { FollowDialog } from './FollowDialog';
import { filteredOf, rowDissection, rowsOf } from './rows';

function Toolbar({ tab, shown, stream }: { tab: CaptureTab; shown: number; stream: number | null }) {
  const { stop, resume, clear, setFollow } = useCapture.getState();
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
      <button
        className="btn small"
        disabled={stream === null}
        onClick={() => stream !== null && setFollow({ tabId: tab.id, stream })}
        title={stream === null ? 'Выберите TCP-пакет' : `Показать диалог соединения tcp.stream ${stream}`}
      >
        ⇄ Follow TCP stream
      </button>
      <span className="muted cap-count">
        {running ? <span className="cap-live">● идёт захват</span> : 'остановлен'} · кадров: {tab.cap.frames.length}
        {tab.filter ? ` · показано: ${shown}` : ''}
      </span>
    </div>
  );
}

/** Содержимое вкладки: фильтр, список, дерево, hex. */
function TabBody({ tab, listH }: { tab: CaptureTab; listH: number }) {
  const { select, setFilter } = useCapture.getState();
  const indices = filteredOf(tab.cap, tab.filter);
  const shown = indices ? indices.length : tab.cap.frames.length;
  const row = tab.selected !== null ? rowsOf(tab.cap, tab.selected)[tab.selected - 1] : undefined;
  const dis = useMemo(() => (row ? rowDissection(row) : null), [row]);
  const [expanded, setExpanded] = useState<Set<FieldKey>>(new Set());
  const [fieldKey, setFieldKey] = useState<FieldKey | null>(null);
  // Новый пакет — сбрасываем выбранное поле (раскрытые уровни сохраняем, как в Wireshark).
  useEffect(() => setFieldKey(null), [row]);
  const field: Field | null = dis && fieldKey ? fieldByKey(dis.tree, fieldKey) : null;

  const toggle = (k: FieldKey) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const onByte = (off: number) => {
    if (!dis) return;
    const path = fieldAt(dis.tree, off);
    if (!path) return;
    const key = keyOfPath(dis.tree, path);
    // Раскрываем предков, чтобы поле было видно.
    setExpanded((s) => {
      const n = new Set(s);
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join('/'));
      return n;
    });
    setFieldKey(key);
  };

  return (
    <>
      <Toolbar tab={tab} shown={shown} stream={row && row.stream >= 0 ? row.stream : null} />
      <FilterBar applied={tab.filter} onApply={(t) => setFilter(tab.id, t)} />
      <div className="cap-panes">
        <div className="cap-list" style={{ height: listH }}>
          <PacketList tab={tab} indices={indices} onSelect={(no) => select(tab.id, no)} />
        </div>
        <div className="cap-detail">
          {dis && row ? (
            <>
              <DetailsTree tree={dis.tree} expanded={expanded} selected={fieldKey} onToggle={toggle} onSelect={(k) => setFieldKey(k)} />
              <HexDump bytes={row.decoded.bytes} range={field} onByte={onByte} />
            </>
          ) : (
            <div className="pk-empty muted">Выберите пакет в списке — здесь появятся разбор по уровням и байты. Клик по полю подсвечивает его байты, клик по байту — поле.</div>
          )}
        </div>
      </div>
      {field && (
        <div className="cap-status mono">
          {field.name ? <b>{field.name}</b> : null} {field.label}
          {field.len > 0 && <span className="muted"> · байты {field.start}–{field.start + field.len - 1} ({field.len})</span>}
        </div>
      )}
    </>
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
  const [pos, setPos] = useState({ x: 16, y: 96 });
  const [floatH, setFloatH] = useState(480);
  const floatRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; h: number } | null>(null);
  const { setActive, close, setDetached, setHeight, setCollapsed } = useCapture.getState();

  useEffect(() => {
    const el = floatRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFloatH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [detached]);

  if (!tabs.length) return <FollowDialog />;
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  // Список пакетов — ~40% высоты панели, остальное — дерево и hex.
  const listH = Math.max(80, Math.round(((detached ? floatH : height) - 130) * 0.5));

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
    if (detached && drag.current)
      setPos({
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
      {!(collapsed && !detached) && <TabBody key={tab.id} tab={tab} listH={listH} />}
    </>
  );

  return (
    <>
      {detached ? (
        <div
          ref={floatRef}
          className="cap-float"
          style={{ left: pos.x, top: pos.y, maxWidth: `calc(100vw - ${pos.x + 16}px)`, maxHeight: `calc(100vh - ${pos.y + 16}px)` }}
          role="dialog"
          aria-label="Анализатор трафика"
        >
          {body}
        </div>
      ) : (
        <section className="cap-dock" style={{ height: collapsed ? undefined : height }} aria-label="Анализатор трафика">
          {!collapsed && <div className="cap-resize" onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={() => (drag.current = null)} title="Потяните, чтобы изменить высоту" />}
          {body}
        </section>
      )}
      <FollowDialog />
    </>
  );
}
