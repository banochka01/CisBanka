// Аккаунт и сохранение: вход, текущий документ на сервере, автосохранение, режим «только просмотр».
import { create } from 'zustand';
import { emptyProject, migrateProject, type Project } from '@ciscobanka/engine';
import { api, ApiError, type User } from '../api';
import { useStore } from './project';

/** Интервал автосохранения, мс. */
export const AUTOSAVE_MS = 30_000;

export type SaveState = 'local' | 'saved' | 'dirty' | 'saving' | 'error' | 'readonly';

/** Откуда открыт проект на холсте. */
export type Doc =
  | { kind: 'local' }
  | { kind: 'account'; id: number; readOnly: false; shareToken: string | null }
  | { kind: 'student'; id: number; readOnly: true; owner: string }
  | { kind: 'share'; readOnly: true; owner: string };

interface Account {
  user: User | null;
  /** Проверили ли сессию при старте. */
  ready: boolean;
  doc: Doc;
  saveState: SaveState;
  saveError: string | null;
  lastSavedAt: number | null;
  /** Проект в момент последнего сохранения — сравниваем по ссылке (проект неизменяемый). */
  savedRef: Project | null;
  dialog: 'auth' | 'projects' | 'classes' | 'password' | null;

  init: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  openDialog: (d: Account['dialog']) => void;
  /** Новый/пример/импорт: проект больше не связан с сохранённым. */
  detach: () => void;
  open: (id: number) => Promise<void>;
  saveNow: () => Promise<void>;
  setShareToken: (t: string | null) => void;
}

const isReadOnly = (d: Doc) => d.kind === 'student' || d.kind === 'share';

export const useAccount = create<Account>((set, get) => ({
  user: null,
  ready: false,
  doc: { kind: 'local' },
  saveState: 'local',
  saveError: null,
  lastSavedAt: null,
  savedRef: null,
  dialog: null,

  async init() {
    const share = /^\/s\/([\w-]+)$/.exec(location.pathname)?.[1];
    try {
      // вошли раньше: проект на холсте ещё не в аккаунте — уйдёт при первом автосохранении
      set({ user: (await api.me()).user, saveState: 'dirty' });
    } catch {
      /* не вошли — работаем локально */
    }
    set({ ready: true });
    if (share) {
      try {
        const r = await api.shared(share);
        load(migrateProject(r.data), { kind: 'share', readOnly: true, owner: r.owner.name }, r.name);
      } catch (e) {
        alert((e as Error).message);
        history.replaceState(null, '', '/');
      }
    }
  },

  setUser(u) {
    set({ user: u, dialog: null });
  },

  async logout() {
    await get().saveNow();
    await api.logout().catch(() => undefined);
    set({ user: null, doc: { kind: 'local' }, saveState: 'local', savedRef: null });
    useStore.getState().setReadOnly(false);
    // чужой проект не должен остаться на холсте и уйти в аккаунт следующего, кто войдёт
    useStore.getState().loadProject(emptyProject());
    if (location.pathname !== '/') history.replaceState(null, '', '/');
  },

  openDialog(d) {
    set({ dialog: d });
  },

  detach() {
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    set({ doc: { kind: 'local' }, savedRef: null, saveState: get().user ? 'dirty' : 'local', saveError: null });
    useStore.getState().setReadOnly(false);
  },

  async open(id) {
    await get().saveNow();
    const p = await api.project(id);
    const project = migrateProject(p.data);
    if (p.readOnly) load(project, { kind: 'student', id: p.id, readOnly: true, owner: `${p.owner.name} (${p.owner.login})` }, p.name);
    else load(project, { kind: 'account', id: p.id, readOnly: false, shareToken: p.shareToken }, p.name);
    set({ dialog: null, lastSavedAt: p.updatedAt });
  },

  async saveNow() {
    const { user, doc, savedRef, saveState } = get();
    const project = useStore.getState().project;
    if (!user || user.mustChangePassword || isReadOnly(doc) || saveState === 'saving') return;
    if (project === savedRef) return;
    // пустой новый проект на сервер не сохраняем
    if (doc.kind === 'local' && !project.devices.length) return;
    set({ saveState: 'saving' });
    try {
      const name = project.name || 'Без названия';
      if (doc.kind === 'account') {
        const r = await api.saveProject(doc.id, name, project);
        set({ lastSavedAt: r.updatedAt });
      } else {
        const r = await api.createProject(name, project);
        set({ doc: { kind: 'account', id: r.id, readOnly: false, shareToken: null }, lastSavedAt: r.updatedAt });
      }
      const changed = useStore.getState().project !== project;
      set({ savedRef: project, saveState: changed ? 'dirty' : 'saved', saveError: null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ user: null });
      set({ saveState: 'error', saveError: (e as Error).message });
    }
  },

  setShareToken(t) {
    const d = get().doc;
    if (d.kind === 'account') set({ doc: { ...d, shareToken: t } });
  },
}));

function load(project: Project, doc: Doc, name: string) {
  const p = { ...project, name };
  useStore.getState().loadProject(p);
  useStore.getState().setReadOnly(isReadOnly(doc));
  useAccount.setState({ doc, savedRef: p, saveState: isReadOnly(doc) ? 'readonly' : 'saved', saveError: null });
}

// Любое изменение проекта — «есть несохранённые изменения»
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  const a = useAccount.getState();
  if (a.saveState === 'readonly' || a.saveState === 'saving') return;
  if (!a.user) return;
  if (s.project !== a.savedRef && a.saveState !== 'dirty') useAccount.setState({ saveState: 'dirty' });
});

/** Автосохранение раз в ~30 секунд + перед закрытием вкладки. */
export function startAutosave() {
  const t = setInterval(() => void useAccount.getState().saveNow(), AUTOSAVE_MS);
  const onUnload = (e: BeforeUnloadEvent) => {
    const a = useAccount.getState();
    if (a.user && !a.user.mustChangePassword && (a.saveState === 'dirty' || a.saveState === 'error')) {
      void a.saveNow();
      e.preventDefault();
    }
  };
  window.addEventListener('beforeunload', onUnload);
  return () => {
    clearInterval(t);
    window.removeEventListener('beforeunload', onUnload);
  };
}
