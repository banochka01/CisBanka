import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, shareUrl, type ClassInfo, type IssuedCredentials, type ProjectMeta, type Student, type User } from '../api';
import { downloadCsv, printSheet } from './credentialsSheet';
import { useAccount, type SaveState } from '../store/account';
import { useStore } from '../store/project';

const fmtTime = (t: number) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const SAVE_TEXT: Record<SaveState, string> = {
  local: 'Не сохраняется — войдите',
  saved: 'Сохранено',
  dirty: 'Есть изменения',
  saving: 'Сохраняю…',
  error: 'Ошибка сохранения',
  readonly: 'Только просмотр',
};

/** Правая часть верхней панели: индикатор сохранения, вход, проекты, классы. */
export function AccountBar() {
  const user = useAccount((s) => s.user);
  const ready = useAccount((s) => s.ready);
  const saveState = useAccount((s) => s.saveState);
  const saveError = useAccount((s) => s.saveError);
  const lastSavedAt = useAccount((s) => s.lastSavedAt);
  const { openDialog, saveNow, logout } = useAccount.getState();
  if (!ready) return null;

  const title =
    saveState === 'error'
      ? saveError ?? ''
      : saveState === 'saved' && lastSavedAt
        ? `Сохранено в ${fmtTime(lastSavedAt)}. Автосохранение каждые 30 секунд.`
        : 'Автосохранение каждые 30 секунд. Ctrl+S — сохранить сейчас.';

  return (
    <div className="account-bar">
      {user && (
        <button className={`save-state save-${saveState}`} title={title} onClick={() => void saveNow()} disabled={saveState === 'readonly'}>
          <span className="save-dot" />
          {SAVE_TEXT[saveState]}
        </button>
      )}
      {user ? (
        <>
          <button className="btn" onClick={() => openDialog('projects')}>Мои проекты</button>
          {user.role === 'teacher' && <button className="btn" onClick={() => openDialog('classes')}>Классы</button>}
          <button className="user-chip" title={`${user.class ? `Класс ${user.class.name}` : 'Учитель'} · сменить пароль`} onClick={() => openDialog('password')}>
            {user.role === 'teacher' ? '👩‍🏫' : '🎓'} {user.name}
          </button>
          <button className="btn ghost" onClick={() => void logout()}>Выйти</button>
        </>
      ) : (
        <button className="btn primary" onClick={() => openDialog('auth')}>Войти</button>
      )}
    </div>
  );
}

/** Плашка «только просмотр» под верхней панелью. */
export function ReadOnlyBanner() {
  const doc = useAccount((s) => s.doc);
  const user = useAccount((s) => s.user);
  if (doc.kind !== 'student' && doc.kind !== 'share') return null;
  const copy = () => {
    useAccount.getState().detach();
    const p = useStore.getState().project;
    useStore.getState().loadProject({ ...p, name: `${p.name} (копия)` });
  };
  return (
    <div className="readonly-banner">
      <span>
        👁 Только просмотр: проект {doc.kind === 'student' ? 'ученика' : 'автора'} <b>{doc.owner}</b>. Симуляция работает, правки не сохраняются.
      </span>
      <button className="btn small" onClick={copy}>
        {user ? 'Сделать свою копию' : 'Редактировать копию'}
      </button>
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal aria-label={title}>
        <div className="window-head">
          <span className="window-title">{title}</span>
          <button className="window-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function AccountDialogs() {
  const dialog = useAccount((s) => s.dialog);
  const user = useAccount((s) => s.user);
  const close = () => useAccount.getState().openDialog(null);
  if (user?.mustChangePassword) return <PasswordDialog forced onClose={() => void useAccount.getState().logout()} />;
  if (dialog === 'password' && user) return <PasswordDialog onClose={close} />;
  if (dialog === 'auth') return <AuthDialog onClose={close} />;
  if (dialog === 'projects') return <ProjectsDialog onClose={close} />;
  if (dialog === 'classes') return <ClassesDialog onClose={close} />;
  return null;
}

// ---------- вход ----------

function AuthDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'student' | 'teacher' | 'register'>('student');
  const [f, setF] = useState({ code: '', login: '', password: '', name: '', invite: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** Ученика с таким логином нет, а класс разрешает регистрацию — спрашиваем «Создать аккаунт?». */
  const [askCreate, setAskCreate] = useState(false);
  const field = (k: keyof typeof f, label: string, type = 'text', hint?: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} autoComplete={type === 'password' ? 'current-password' : 'off'} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );

  const attempt = async (fn: () => Promise<{ user: User }>) => {
    setErr('');
    setBusy(true);
    try {
      signedIn((await fn()).user);
    } catch (ex) {
      if (ex instanceof ApiError && ex.body?.canRegister) setAskCreate(true);
      else setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'student' && askCreate) return void attempt(() => api.studentRegister(f.code.trim(), f.login.trim(), f.password, f.name.trim()));
    void attempt(() =>
      tab === 'student'
        ? api.studentLogin(f.code.trim(), f.login.trim(), f.password)
        : tab === 'teacher'
          ? api.teacherLogin(f.login.trim(), f.password)
          : api.teacherRegister(f.invite.trim(), f.login.trim(), f.password, f.name.trim() || f.login.trim()),
    );
  };

  return (
    <Modal title="Вход в CisBanka" onClose={onClose}>
      <div className="tabs flush">
        {(
          [
            ['student', 'Ученик'],
            ['teacher', 'Учитель'],
            ['register', 'Регистрация учителя'],
          ] as const
        ).map(([k, t]) => (
          <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => (setTab(k), setAskCreate(false), setErr(''))} type="button">
            {t}
          </button>
        ))}
      </div>
      <form className="auth-form" onSubmit={submit}>
        {tab === 'student' && !askCreate && (
          <>
            {field('code', 'Код класса', 'text', 'Код класса, логин и пароль выдаёт учитель')}
            {field('login', 'Логин')}
            {field('password', 'Пароль', 'password')}
          </>
        )}
        {tab === 'student' && askCreate && (
          <div className="ask-create">
            <p>
              Такого ученика нет: <b className="mono">{f.login.trim()}</b>. Создать аккаунт?
            </p>
            <p className="hint">Если учитель уже выдал вам логин — нажмите «Нет» и проверьте, как он написан.</p>
            {field('name', 'Имя и фамилия (увидит учитель)')}
            <p className="hint">Паролем станет тот, что вы ввели. Запомните его.</p>
          </div>
        )}
        {tab === 'teacher' && (
          <>
            {field('login', 'Логин')}
            {field('password', 'Пароль', 'password')}
          </>
        )}
        {tab === 'register' && (
          <>
            {field('invite', 'Код приглашения', 'password', 'ADMIN_INVITE_CODE из настроек сервера (.env)')}
            {field('name', 'Имя (видят ученики)')}
            {field('login', 'Логин')}
            {field('password', 'Пароль (от 8 символов)', 'password')}
          </>
        )}
        {err && <div className="bad">{err}</div>}
        <div className="tools-row">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Подождите…' : tab === 'register' ? 'Зарегистрироваться' : askCreate ? 'Да, создать аккаунт' : 'Войти'}
          </button>
          {askCreate && (
            <button className="btn" type="button" onClick={() => setAskCreate(false)}>
              Нет
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** После входа: несохранённый локальный проект сразу уйдёт в аккаунт (если не нужно сменить пароль). */
function signedIn(user: User) {
  useAccount.getState().setUser(user);
  if (user.mustChangePassword) return;
  useAccount.setState({ saveState: 'dirty' });
  void useAccount.getState().saveNow();
}

/** Смена пароля; forced — после одноразового пароля, закрыть нельзя (только выйти). */
function PasswordDialog({ forced, onClose }: { forced?: boolean; onClose: () => void }) {
  const user = useAccount((s) => s.user)!;
  const [f, setF] = useState({ current: '', password: '', repeat: '' });
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const min = user.role === 'teacher' ? 8 : 4;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (f.password.length < min) return setErr(`Пароль должен быть не короче ${min} символов`);
    if (f.password !== f.repeat) return setErr('Пароли не совпадают');
    try {
      const r = await api.changePassword(f.password, forced ? undefined : f.current);
      if (forced) signedIn(r.user);
      else setDone(true);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };
  const input = (k: keyof typeof f, label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="password" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} autoComplete={k === 'current' ? 'current-password' : 'new-password'} />
    </label>
  );
  return (
    <Modal title={forced ? 'Придумайте свой пароль' : 'Смена пароля'} onClose={onClose}>
      <form className="auth-form" onSubmit={submit}>
        {forced && <p>Вы вошли по одноразовому паролю от учителя. Придумайте свой — дальше входите с ним.</p>}
        {done ? (
          <div className="ok">Пароль изменён.</div>
        ) : (
          <>
            {!forced && input('current', 'Текущий пароль')}
            {input('password', `Новый пароль (от ${min} символов)`)}
            {input('repeat', 'Повторите новый пароль')}
            {err && <div className="bad">{err}</div>}
          </>
        )}
        <div className="tools-row">
          {!done && <button className="btn primary">Сохранить пароль</button>}
          <button className="btn" type="button" onClick={onClose}>
            {forced ? 'Выйти' : 'Закрыть'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- мои проекты ----------

function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [err, setErr] = useState('');
  const doc = useAccount((s) => s.doc);
  const reload = () => api.projects().then((r) => setList(r.projects), (e) => setErr(e.message));
  useEffect(() => void reload(), []);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title="Мои проекты" onClose={onClose} wide>
      <div className="tools-row">
        <button
          className="btn primary"
          onClick={async () => {
            await useAccount.getState().saveNow();
            useAccount.getState().detach();
            useStore.getState().loadProject({ ...useStore.getState().project, devices: [], links: [], name: 'Новый проект' });
            onClose();
          }}
        >
          + Новый проект
        </button>
        <span className="hint">Проект сохраняется автоматически, как только на холсте появятся устройства.</span>
      </div>
      {err && <div className="bad">{err}</div>}
      {!list && !err && <p className="muted">Загрузка…</p>}
      {list && !list.length && <p className="muted">Пока нет сохранённых проектов.</p>}
      {list && list.length > 0 && (
        <table className="grid">
          <thead>
            <tr><th>Название</th><th>Изменён</th><th>Ссылка</th><th /></tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className={doc.kind === 'account' && doc.id === p.id ? 'sel' : ''}>
                <td>
                  {p.assignmentId && <span className="badge">задание</span>} {p.name}
                </td>
                <td className="muted">{fmtTime(p.updatedAt)}</td>
                <td><ShareCell id={p.id} shared={p.shared} onChange={reload} /></td>
                <td className="nowrap">
                  <button className="btn small" onClick={() => act(() => useAccount.getState().open(p.id))}>Открыть</button>{' '}
                  <button
                    className="btn small"
                    title="Удалить проект"
                    onClick={() => confirm(`Удалить «${p.name}»?`) && act(async () => {
                      await api.deleteProject(p.id);
                      if (doc.kind === 'account' && doc.id === p.id) useAccount.getState().detach();
                    })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** Ссылка «только просмотр»: создать/скопировать/закрыть. */
function ShareCell({ id, shared, onChange }: { id: number; shared: boolean; onChange: () => void }) {
  const [msg, setMsg] = useState('');
  const copy = async () => {
    const { token } = await api.share(id);
    const url = shareUrl(token);
    try {
      await navigator.clipboard.writeText(url);
      setMsg('Скопировано');
    } catch {
      prompt('Ссылка только для просмотра:', url);
    }
    onChange();
  };
  return (
    <span className="nowrap">
      <button className="btn small" onClick={() => void copy()} title="Любой, у кого есть ссылка, сможет посмотреть проект без входа">
        🔗 {shared ? 'Копировать' : 'Создать'}
      </button>
      {shared && (
        <button className="btn small ghost" onClick={() => void api.unshare(id).then(onChange)} title="Закрыть доступ по ссылке">
          закрыть
        </button>
      )}
      {msg && <span className="ok"> {msg}</span>}
    </span>
  );
}

// ---------- классы (учитель) ----------

function ClassesDialog({ onClose }: { onClose: () => void }) {
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  /** Панель «добавить списком» открыта: текст из textarea. */
  const [adding, setAdding] = useState<string | null>(null);
  /** Только что выданные логины/пароли — показываем один раз. */
  const [issued, setIssued] = useState<{ rows: IssuedCredentials[]; oneTime: boolean } | null>(null);

  const loadClasses = () =>
    api.classes().then((r) => {
      setClasses(r.classes);
      setSel((s) => s ?? r.classes[0]?.id ?? null);
    }, (e) => setErr(e.message));
  useEffect(() => void loadClasses(), []);
  useEffect(() => {
    setAdding(null);
    setIssued(null);
    if (sel) api.students(sel).then((r) => setStudents(r.students), (e) => setErr(e.message));
    else setStudents([]);
  }, [sel]);

  const cls = classes.find((c) => c.id === sel);
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    setNote('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const assign = () =>
    run(async () => {
      const p = useStore.getState().project;
      const title = prompt('Название задания для класса:', p.name || 'Задание');
      if (!title || !cls) return;
      const r = await api.assign(cls.id, title, p);
      setNote(`Задание «${title}» выдано: ${r.delivered} уч. Новые ученики класса получат его при входе.`);
      setStudents((await api.students(cls.id)).students);
    });

  const refresh = async (id: number) => {
    setStudents((await api.students(id)).students);
    await loadClasses();
  };

  const addList = () =>
    run(async () => {
      if (!cls || adding === null) return;
      const names = adding.split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
      if (!names.length) return setErr('Вставьте имена — по одному в строке');
      const r = await api.addStudents(cls.id, names);
      setAdding(null);
      setIssued({ rows: r.students, oneTime: false });
      await refresh(cls.id);
    });

  const resetPassword = (s: Student) =>
    confirm(`Выдать ${s.name} новый одноразовый пароль? Старый перестанет работать.`) &&
    run(async () => {
      if (!cls) return;
      const { password } = await api.resetPassword(cls.id, s.id);
      setIssued({ rows: [{ id: s.id, name: s.name, login: s.login, password }], oneTime: true });
      await refresh(cls.id);
    });

  return (
    <Modal title="Классы" onClose={onClose} wide>
      <div className="classes">
        <div className="class-list">
          {classes.map((c) => (
            <button key={c.id} className={`class-item${c.id === sel ? ' active' : ''}`} onClick={() => setSel(c.id)}>
              <b>{c.name}</b>
              <span className="muted">{c.students} уч.</span>
            </button>
          ))}
          <form
            className="new-class"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim())
                run(async () => {
                  const r = await api.createClass(name.trim());
                  setName('');
                  await loadClasses();
                  setSel(r.class.id);
                });
            }}
          >
            <input placeholder="Новый класс, например 9А" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn small">Создать</button>
          </form>
        </div>
        <div className="class-detail">
          {err && <div className="bad">{err}</div>}
          {!cls && <p className="muted">Создайте класс — ученики войдут по его коду.</p>}
          {cls && (
            <>
              <div className="class-code">
                Код класса: <span className="mono code">{cls.code}</span>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={cls.joinOpen}
                    onChange={(e) => run(async () => {
                      await api.updateClass(cls.id, { joinOpen: e.target.checked });
                      await loadClasses();
                    })}
                  />
                  Ученики могут зарегистрироваться сами
                </label>
              </div>
              <div className="tools-row">
                <button className="btn primary" onClick={() => (setIssued(null), setAdding(adding ?? ''))}>
                  + Ученики списком
                </button>
                <button className="btn" onClick={() => void assign()} title="Каждый ученик получит свою копию текущего проекта">
                  Раздать текущий проект как задание
                </button>
              </div>
              {note && <div className="ok">{note}</div>}
              {adding !== null && (
                <div className="add-students">
                  <label className="field">
                    <span className="field-label">Имена учеников — по одному в строке («Фамилия Имя»)</span>
                    <textarea
                      rows={8}
                      autoFocus
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      placeholder={'Иванов Пётр\nСмирнова Анна\n…'}
                    />
                    <span className="hint">Логины и пароли придумает система. Список можно вставить из Excel или журнала.</span>
                  </label>
                  <div className="tools-row">
                    <button className="btn primary" onClick={() => void addList()}>
                      Создать {adding.split('\n').filter((n) => n.trim()).length || ''} уч.
                    </button>
                    <button className="btn" onClick={() => setAdding(null)}>Отмена</button>
                  </div>
                </div>
              )}
              {issued && (
                <div className="issued">
                  <div className="issued-head">
                    <b>{issued.oneTime ? 'Новый одноразовый пароль' : `Создано учеников: ${issued.rows.length}`}</b>
                    <span className="bad">Пароли видны только сейчас — распечатайте или скачайте.</span>
                  </div>
                  <table className="grid">
                    <thead>
                      <tr><th>Ученик</th><th>Логин</th><th>Пароль</th></tr>
                    </thead>
                    <tbody>
                      {issued.rows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.name}</td>
                          <td className="mono">{r.login}</td>
                          <td className="mono">{r.password}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="tools-row">
                    <button className="btn primary" onClick={() => printSheet(issued.rows, cls, issued.oneTime)}>🖨 Печать карточек</button>
                    <button className="btn" onClick={() => downloadCsv(issued.rows, cls)}>⬇ CSV</button>
                    <button className="btn ghost" onClick={() => confirm('Пароли больше не будут видны. Закрыть?') && setIssued(null)}>Готово</button>
                    <span className="hint">Код класса {cls.code}, адрес {location.host}</span>
                  </div>
                </div>
              )}
              {!students.length && adding === null && <p className="muted">Учеников пока нет. Нажмите «+ Ученики списком».</p>}
              {students.length > 0 && (
                <table className="grid">
                  <thead>
                    <tr><th>Ученик</th><th>Проекты (только просмотр)</th><th /></tr>
                  </thead>
                  <tbody>
                    {students.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.name}
                          <div className="muted mono">{s.login}</div>
                          {s.mustChangePassword && <span className="badge" title="Выдан одноразовый пароль, ученик ещё не вошёл">одноразовый пароль</span>}
                        </td>
                        <td>
                          {!s.projects.length && <span className="muted">нет</span>}
                          {s.projects.map((p) => (
                            <button key={p.id} className="btn small project-link" onClick={() => run(() => useAccount.getState().open(p.id))} title={`Изменён ${fmtTime(p.updatedAt)}`}>
                              {p.assignmentId ? '📝 ' : ''}
                              {p.name}
                            </button>
                          ))}
                        </td>
                        <td className="nowrap">
                          <button className="btn small" onClick={() => resetPassword(s)} title="Выдать новый одноразовый пароль">
                            Сбросить пароль
                          </button>{' '}
                          <button
                            className="btn small"
                            title="Удалить ученика и его проекты"
                            onClick={() => confirm(`Удалить ученика ${s.name} и все его проекты?`) && run(async () => {
                              await api.removeStudent(cls.id, s.id);
                              await refresh(cls.id);
                            })}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
