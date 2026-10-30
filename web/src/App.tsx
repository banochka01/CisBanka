import { useEffect, useRef } from 'react';
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
import { startAutosave, useAccount } from './store/account';
import { AccountBar, AccountDialogs, ReadOnlyBanner } from './account/AccountUI';

/** Открыть новый/пример/импорт: текущий сохраняем, новый ещё не привязан к аккаунту. */
async function startFresh(p: Project) {
  await useAccount.getState().saveNow();
  useAccount.getState().detach();
  useStore.getState().loadProject(p);
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
        if (useAccount.getState().user) void useAccount.getState().saveNow();
        else useAccount.getState().openDialog('auth');
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
      await startFresh(migrateProject(JSON.parse(await f.text())));
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
        readOnly={readOnly}
      />
      <button
        className="btn"
        onClick={() =>
          (useAccount.getState().user || confirm('Начать новый проект? Несохранённые изменения пропадут.')) && void startFresh(emptyProject())
        }
      >
        Новый
      </button>
      <select
        className="btn"
        value=""
        onChange={(e) => {
          const ex = EXAMPLES[Number(e.target.value)];
          if (ex) void startFresh(ex.make());
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
      <AccountBar />
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
  const theme = useStore((s) => s.theme);
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    void useAccount.getState().init();
    return startAutosave();
  }, []);
  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <ReadOnlyBanner />
        <div className="main">
          {!readOnly && <Palette />}
          <Canvas />
          <SimPanel />
        </div>
        <StatusBar />
      </div>
      <WindowLayer />
      <PortPicker />
      <AccountDialogs />
    </ReactFlowProvider>
  );
}
