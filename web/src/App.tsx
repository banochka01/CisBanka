import { useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { emptyProject, migrateProject } from '@ciscobanka/engine';
import { useStore } from './store/project';
import { Canvas } from './canvas/Canvas';
import { PortPicker } from './canvas/PortPicker';
import { Palette } from './palette/Palette';
import { WindowLayer } from './windows/WindowLayer';
import { EXAMPLES } from './examples';

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
        return;
      }
      if (isTyping(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
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
  const { undo, redo, toggleTheme, loadProject } = useStore.getState();
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name || 'проект'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (f: File) => {
    try {
      loadProject(migrateProject(JSON.parse(await f.text())));
    } catch (err) {
      alert(`Не удалось открыть файл: ${(err as Error).message}`);
    }
  };

  return (
    <header className="toolbar">
      <div className="brand">CisBanka</div>
      <input
        className="project-name"
        value={project.name}
        onChange={(e) => useStore.setState((s) => ({ project: { ...s.project, name: e.target.value } }))}
        aria-label="Название проекта"
      />
      <button className="btn" onClick={() => confirm('Начать новый проект? Несохранённые изменения пропадут.') && loadProject(emptyProject())}>
        Новый
      </button>
      <select
        className="btn"
        value=""
        onChange={(e) => {
          const ex = EXAMPLES[Number(e.target.value)];
          if (ex) loadProject(ex.make());
        }}
      >
        <option value="">Примеры…</option>
        {EXAMPLES.map((ex, i) => (
          <option key={i} value={i}>
            {ex.title}
          </option>
        ))}
      </select>
      <button className="btn" onClick={exportJson}>Экспорт JSON</button>
      <button className="btn" onClick={() => fileRef.current?.click()}>Импорт JSON</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
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
  return (
    <footer className="statusbar">
      <div className="mode-switch" role="tablist">
        <button className="active" role="tab" aria-selected>Реальное время</button>
        <button role="tab" disabled title="Появится на следующем этапе">Симуляция</button>
      </div>
      <span className="muted">
        Устройств: {n}, проводов: {l}. Двойной клик — настройка устройства, Delete — удалить, Ctrl+Z / Ctrl+Y — отмена/повтор.
      </span>
    </footer>
  );
}

export function App() {
  useHotkeys();
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <div className="main">
          <Palette />
          <Canvas />
        </div>
        <StatusBar />
      </div>
      <WindowLayer />
      <PortPicker />
    </ReactFlowProvider>
  );
}
