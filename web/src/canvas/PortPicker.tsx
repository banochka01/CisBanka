import { useEffect, useRef } from 'react';
import { cableFitsPort } from '@ciscobanka/engine';
import { useStore } from '../store/project';
import { peerLabel } from '../ui/portInfo';

/** Меню выбора порта при протягивании провода. Занятые порты подсвечены и недоступны. */
export function PortPicker() {
  const picker = useStore((s) => s.picker);
  const project = useStore((s) => s.project);
  const cable = useStore((s) => s.cable);
  const pending = useStore((s) => s.pending);
  const pickPort = useStore((s) => s.pickPort);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picker) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) useStore.setState({ picker: null });
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [picker]);

  if (!picker || !cable) return null;
  const d = project.devices.find((x) => x.id === picker.deviceId);
  if (!d) return null;
  const left = Math.min(picker.x, window.innerWidth - 260);
  const top = Math.min(picker.y, window.innerHeight - 320);

  return (
    <div className="port-picker" ref={ref} style={{ left, top }}>
      <div className="port-picker-title">{d.name}: выберите порт</div>
      <div className="port-picker-list">
        {d.ports.map((p) => {
          const peer = peerLabel(project, p.id);
          const fits = cableFitsPort(cable, p);
          const disabled = !!peer || !fits || pending?.deviceId === d.id;
          const note = peer ? `занят → ${peer}` : !fits ? (p.media === 'fiber' ? 'оптический порт' : 'медный порт') : p.media === 'fiber' ? 'оптика' : '';
          return (
            <button
              key={p.id}
              className={`port-item${peer ? ' busy' : ''}`}
              disabled={disabled}
              onClick={() => pickPort({ deviceId: d.id, portId: p.id })}
            >
              <span className={`port-dot ${p.adminUp ? 'up' : 'down'}`} />
              <span className="port-item-name">{p.name}</span>
              <span className="port-item-note">{note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
