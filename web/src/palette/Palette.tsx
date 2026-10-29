import { DEVICE_LABELS, type CableType, type DeviceKind } from '@ciscobanka/engine';
import { DeviceIcon } from '../canvas/icons';
import { useStore } from '../store/project';
import { CABLE_LABELS } from '../ui/portInfo';

const KINDS: DeviceKind[] = ['router', 'switch', 'hub', 'pc', 'laptop', 'server'];
const CABLES: CableType[] = ['straight', 'crossover', 'fiber'];

export function Palette() {
  const cable = useStore((s) => s.cable);
  const pending = useStore((s) => s.pending);
  const setCable = useStore((s) => s.setCable);

  return (
    <aside className="palette">
      <h3>Устройства</h3>
      <p className="hint">Перетащите на холст</p>
      <div className="palette-grid">
        {KINDS.map((k) => (
          <div
            key={k}
            className="palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-device', k);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title={`${DEVICE_LABELS[k]} — перетащите на холст`}
          >
            <DeviceIcon kind={k} size={44} />
            <span>{DEVICE_LABELS[k]}</span>
          </div>
        ))}
      </div>

      <h3>Провода</h3>
      <div className="cable-list">
        {CABLES.map((c) => (
          <button key={c} className={`cable-btn cable-${c}${cable === c ? ' active' : ''}`} onClick={() => setCable(cable === c ? null : c)}>
            <svg width="36" height="10" aria-hidden>
              <line x1="2" y1="5" x2="34" y2="5" strokeWidth="3" strokeDasharray={c === 'crossover' ? '6 4' : undefined} />
            </svg>
            {CABLE_LABELS[c]}
          </button>
        ))}
      </div>
      {cable && (
        <p className="hint strong">
          {pending ? 'Теперь кликните второе устройство.' : 'Кликните первое устройство и выберите порт.'} Esc — отмена.
        </p>
      )}
      <p className="hint">
        ПК/сервер/роутер ↔ свитч/хаб — прямой кабель.
        <br />
        Одинаковые (ПК↔ПК, свитч↔свитч, ПК↔роутер) — кроссовер.
      </p>
    </aside>
  );
}
