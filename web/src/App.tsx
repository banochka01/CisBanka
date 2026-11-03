import { lazy, Suspense, useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { emptyProject, migrateProject, type Project } from '@ciscobanka/engine';
import { useStore } from './store/project';
import { Canvas } from './canvas/Canvas';
import { PortPicker } from './canvas/PortPicker';
import { Palette } from './palette/Palette';
import { WindowLayer } from './windows/WindowLayer';
import { EXAMPLES } from './examples';
import { useSim } from './store/sim';
import { SimPanel } from './sim/SimPanel';
import { useCapture } from './store/capture';
import { openPcapFile, PCAP_ACCEPT } from './capture/pcapFile';

// Анализатор (разбор, фильтры, hex) грузится отдельным чанком при первом открытии панели.
const CaptureDock = lazy(() => import('./capture/CaptureDock'));
import { restoreDraft, startAutosave } from './store/draft';

function startFresh(p: Project) {
  useStore.getState().loadProject(p);
}

/** Сохранить проект файлом (.json) — его можно открыть здесь же или передать другому. */
function exportProject() {
  const project = useStore.getState().project;
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(project.name || 'проект').replace(/[\\/:*?"<>|]+/g, '-')}.cisbanka.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

async function importProject(f: File) {
  try {
    startFresh(migrateProject(JSON.parse(await f.text())));
  } catch (err) {
    alert(`Не удалось открыть «${f.name}»: ${(err as Error).message}`);
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.key === 'Escape') {
        if (st.cable || st.pending || st.picker) st.cancelCable();
        if (st.placing) st.setPlacing(null);
        if (useSim.getState().pdu) useSim.getState().togglePdu();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === 's' || e.code === 'KeyS')) {
        e.preventDefault();
        exportProject();
        return;
      }
      if (isTyping(e)) return;
      // e.code — чтобы работало и в русской раскладке
      if (mod && (k === 'z' || e.code === 'KeyZ') && !e.shiftKey) {
        e.preventDefault();
        st.undo();
      } else if (mod && (k === 'y' || e.code === 'KeyY' || ((k === 'z' || e.code === 'KeyZ') && e.shiftKey))) {
        e.preventDefault();
        st.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Toolbar() {
  const project = useStore((s) => s.project);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const readOnly = useStore((s) => s.readOnly);
  const { undo, redo, toggleTheme } = useStore.getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const pcapRef = useRef<HTMLInputElement>(null);

  return (
    <header className="toolbar">
      <div className="brand">CisBanka</div>
      <input
        className="project-name"
        value={project.name}
        onChange={(e) => useStore.setState((s) => ({ project: { ...s.project, name: e.target.value } }))}
        aria-label="Название проекта"
        readOnly={readOnly}
      />
      <button
        className="btn"
        onClick={() =>
          confirm('Начать новый проект? Текущий лучше сначала сохранить в файл.') && startFresh(emptyProject())
        }
      >
        Новый
      </button>
      <select
        className="btn"
        value=""
        onChange={(e) => {
          const ex = EXAMPLES[Number(e.target.value)];
          if (ex) startFresh(ex.make());
        }}
      >
        <option value="">Примеры…</option>
        {EXAMPLES.map((ex, i) => (
          <option key={i} value={i}>
            {ex.title}
          </option>
        ))}
      </select>
      <button className="btn" onClick={exportProject} title="Скачать проект файлом (Ctrl+S)">
        Сохранить проект
      </button>
      <button className="btn" onClick={() => fileRef.current?.click()} title="Открыть файл проекта (.json)">
        Открыть проект
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importProject(f);
        }}
      />
      <button className="btn" onClick={() => pcapRef.current?.click()} title="Открыть .pcap/.pcapng в анализаторе трафика">
        Открыть .pcap
      </button>
      <input
        ref={pcapRef}
        type="file"
        accept={PCAP_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openPcapFile(f);
        }}
      />
      <div className="spacer" />
      <button className="btn icon" onClick={undo} disabled={!canUndo} title="Отменить (Ctrl+Z)">↶</button>
      <button className="btn icon" onClick={redo} disabled={!canRedo} title="Повторить (Ctrl+Y)">↷</button>
      <button className="btn icon" onClick={toggleTheme} title="Сменить тему">{theme === 'dark' ? '☀' : '☾'}</button>
    </header>
  );
}

function StatusBar() {
  const n = useStore((s) => s.project.devices.length);
  const l = useStore((s) => s.project.links.length);
  const mode = useSim((s) => s.mode);
  const switchMode = useSim((s) => s.switchMode);
  return (
    <footer className="statusbar">
      <div className="mode-switch" role="tablist">
        <button className={mode === 'realtime' ? 'active' : ''} role="tab" aria-selected={mode === 'realtime'} onClick={() => switchMode('realtime')}>
          Реальное время
        </button>
        <button className={mode === 'simulation' ? 'active' : ''} role="tab" aria-selected={mode === 'simulation'} onClick={() => switchMode('simulation')}>
          Симуляция
        </button>
      </div>
      <span className="muted">
        Устройств: {n}, проводов: {l}.{' '}
        {mode === 'simulation'
          ? 'Пакеты идут по шагам: ⏭ — один хоп, ▶ — воспроизведение. Клик по конверту — разбор по OSI.'
          : 'Двойной клик — настройка устройства, Delete — удалить, Ctrl+Z / Ctrl+Y — отмена/повтор.'}
      </span>
    </footer>
  );
}

export function App() {
  useHotkeys();
  const analyzer = useCapture((s) => s.tabs.length > 0);
  const theme = useStore((s) => s.theme);
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    restoreDraft();
    return startAutosave();
  }, []);
  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <div className="main">
          {!readOnly && <Palette />}
          <Canvas />
          <SimPanel />
        </div>
        {analyzer && (
          <Suspense fallback={<div className="cap-loading muted">Загрузка анализатора…</div>}>
            <CaptureDock />
          </Suspense>
        )}
        <StatusBar />
      </div>
      <WindowLayer />
      <PortPicker />
    </ReactFlowProvider>
  );
}
