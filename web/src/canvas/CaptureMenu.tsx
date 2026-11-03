// ПКМ по проводу или устройству: запустить/остановить захват трафика.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CapturePoint } from '@ciscobanka/engine';
import { useStore } from '../store/project';
import { pointTitle, useCapture } from '../store/capture';
import { getSim, settle } from '../sim/runtime';

export type MenuTarget = { x: number; y: number } & ({ kind: 'link'; linkId: string } | { kind: 'device'; deviceId: string });

function Item({ point, label }: { point: CapturePoint; label: string }) {
  const tab = useCapture((s) =>
    s.tabs.find((t) => (point.kind === 'link' ? t.point.kind === 'link' && t.point.linkId === point.linkId : t.point.kind === 'port' && t.point.portId === point.portId)),
  );
  const running = !!tab?.cap.running;
  return (
    <button
      className="ctx-item"
      role="menuitem"
      onClick={() => (running ? useCapture.getState().stop(tab!.id) : useCapture.getState().start(point))}
    >
      {running ? '■ Остановить захват' : '🔍 Начать захват'} <span className="muted">— {label}</span>
    </button>
  );
}

export function CaptureMenu({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: target.x, y: target.y });
  // Не даём меню вылезти за край окна.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)) });
  }, [target.x, target.y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('.ctx-menu')) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  let items: { point: CapturePoint; label: string }[] = [];
  let title = '';
  let clear: { label: string; run: () => void } | null = null;
  if (target.kind === 'link') {
    const point: CapturePoint = { kind: 'link', linkId: target.linkId };
    title = pointTitle(point);
    items = [{ point, label: 'на этом проводе' }];
  } else {
    const d = project.devices.find((x) => x.id === target.deviceId);
    if (!d) return null;
    title = d.name;
    const linked = new Set(project.links.flatMap((l) => [l.a.portId, l.b.portId]));
    items = d.ports.filter((p) => linked.has(p.id)).map((p) => ({ point: { kind: 'port', portId: p.id }, label: `интерфейс ${p.name}` }));
    // Очистка таблиц — команда симулятора (переигрывается при шаге назад), как ping из окна.
    const after = () => {
      settle();
      useStore.getState().bumpSim();
    };
    if (d.kind === 'switch') clear = { label: '🧹 Очистить MAC-таблицу', run: () => (getSim().clearMacTable(d.id), after()) };
    else if (d.kind !== 'hub') clear = { label: '🧹 Очистить ARP-кэш', run: () => (getSim().clearArpCache(d.id), after()) };
  }

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onClick={onClose}>
      <div className="ctx-title">{title}</div>
      {items.length ? items.map((it, i) => <Item key={i} {...it} />) : <div className="ctx-item muted">Нет подключённых интерфейсов</div>}
      {clear && (
        <>
          <div className="ctx-sep" />
          <button className="ctx-item" role="menuitem" onClick={clear.run}>
            {clear.label}
          </button>
        </>
      )}
    </div>
  );
}
