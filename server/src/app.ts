// HTTP API: вход учителя/ученика, классы, задания, проекты, ссылки «только просмотр».
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import type { DB } from './db.js';

type Role = 'teacher' | 'student';

interface UserRow {
  id: number;
  role: Role;
  login: string;
  name: string;
  password_hash: string;
  class_id: number | null;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { uid: number };
    user: { uid: number };
  }
}

const COOKIE = 'cb_token';
const SESSION_DAYS = 30;
/** Проект хранится как JSON; больше 5 МБ учебная топология не бывает. */
const BODY_LIMIT = 5 * 1024 * 1024;
const LOGIN_RE = /^[\p{L}\p{N}._-]{2,32}$/u;
/** Без похожих символов (0/O, 1/I/L) — код класса диктуют вслух. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bad = (msg: string) => new HttpError(400, msg);
const forbidden = (msg = 'Нет доступа') => new HttpError(403, msg);
const notFound = (msg = 'Не найдено') => new HttpError(404, msg);

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw bad(`Поле «${field}» не заполнено`);
  if (v.length > max) throw bad(`Поле «${field}» слишком длинное`);
  return v.trim();
}

function checkLogin(v: unknown): string {
  const login = str(v, 'логин', 32);
  if (!LOGIN_RE.test(login)) throw bad('Логин: 2–32 символа, буквы, цифры, точка, дефис или подчёркивание');
  return login;
}

function checkPassword(v: unknown, min: number): string {
  if (typeof v !== 'string' || v.length < min) throw bad(`Пароль должен быть не короче ${min} символов`);
  if (v.length > 200) throw bad('Пароль слишком длинный');
  return v;
}

/** Минимальная проверка, что это проект CisBanka, а не произвольный JSON. */
function checkProjectData(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Проект должен быть объектом');
  const p = v as { devices?: unknown; links?: unknown };
  if (!Array.isArray(p.devices) || !Array.isArray(p.links)) throw bad('В проекте нет списков devices и links');
  return JSON.stringify(v);
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const publicUser = (u: UserRow, db: DB) => {
  const cls = u.class_id ? (db.prepare('SELECT id, name, code FROM classes WHERE id = ?').get(u.class_id) as { id: number; name: string; code: string }) : null;
  return { id: u.id, role: u.role, login: u.login, name: u.name, class: cls };
};

export async function buildApp(db: DB, cfg: Config) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' }, bodyLimit: BODY_LIMIT, trustProxy: true });

  await app.register(cookie);
  await app.register(jwt, { secret: cfg.jwtSecret, cookie: { cookieName: COOKIE, signed: false }, sign: { expiresIn: `${SESSION_DAYS}d` } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Слишком много попыток входа. Подождите минуту.' });
    if (err.statusCode === 413) return reply.status(413).send({ error: 'Проект слишком большой' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  // ---------- сессия ----------

  const setSession = async (reply: FastifyReply, uid: number) => {
    const token = await reply.jwtSign({ uid });
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: SESSION_DAYS * 86400 });
  };

  const userById = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

  async function currentUser(req: FastifyRequest): Promise<UserRow | null> {
    try {
      const { uid } = await req.jwtVerify<{ uid: number }>();
      return userById(uid) ?? null;
    } catch {
      return null;
    }
  }

  async function requireUser(req: FastifyRequest, role?: Role): Promise<UserRow> {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, 'Войдите в аккаунт');
    if (role && u.role !== role) throw forbidden(role === 'teacher' ? 'Только для учителя' : 'Только для ученика');
    return u;
  }

  const loginLimit = { rateLimit: { max: cfg.loginRateLimit, timeWindow: '1 minute' } };

  // ---------- служебное ----------

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // ---------- вход ----------

  app.post('/api/auth/teacher/register', { config: loginLimit }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.invite !== 'string' || !safeEqual(b.invite, cfg.adminInviteCode)) throw forbidden('Неверный код приглашения');
    const login = checkLogin(b.login);
    const password = checkPassword(b.password, 8);
    const name = str(b.name ?? login, 'имя', 80);
    const exists = db.prepare(`SELECT 1 FROM users WHERE role = 'teacher' AND lower(login) = lower(?)`).get(login);
    if (exists) throw new HttpError(409, 'Учитель с таким логином уже есть');
    const r = db
      .prepare(`INSERT INTO users (role, login, name, password_hash, created_at) VALUES ('teacher', ?, ?, ?, ?)`)
      .run(login, name, await hash(password), Date.now());
    const u = userById(Number(r.lastInsertRowid))!;
    await setSession(reply, u.id);
    return { user: publicUser(u, db) };
  });

  app.post('/api/auth/teacher/login', { config: loginLimit }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const login = str(b.login, 'логин', 32);
    const password = typeof b.password === 'string' ? b.password : '';
    const u = db.prepare(`SELECT * FROM users WHERE role = 'teacher' AND lower(login) = lower(?)`).get(login) as UserRow | undefined;
    if (!u || !(await verify(u.password_hash, password))) throw new HttpError(401, 'Неверный логин или пароль');
    await setSession(reply, u.id);
    return { user: publicUser(u, db) };
  });

  /**
   * Ученик: код класса + логин + пароль. Первый вход с новым логином создаёт аккаунт —
   * только если учитель не закрыл приём в класс. Открытой регистрации без кода нет.
   */
  app.post('/api/auth/student/login', { config: loginLimit }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const code = str(b.classCode, 'код класса', 16).toUpperCase();
    const login = checkLogin(b.login);
    const password = checkPassword(b.password, 4);
    const cls = db.prepare('SELECT * FROM classes WHERE code = ?').get(code) as { id: number; join_open: number } | undefined;
    if (!cls) throw new HttpError(401, 'Класс с таким кодом не найден');
    let u = db.prepare(`SELECT * FROM users WHERE role = 'student' AND class_id = ? AND lower(login) = lower(?)`).get(cls.id, login) as UserRow | undefined;
    let created = false;
    if (u) {
      if (!(await verify(u.password_hash, password))) throw new HttpError(401, 'Неверный пароль');
    } else {
      if (!cls.join_open) throw forbidden('Учитель закрыл приём новых учеников в этот класс');
      const name = typeof b.name === 'string' && b.name.trim() ? str(b.name, 'имя', 80) : login;
      const r = db
        .prepare(`INSERT INTO users (role, login, name, password_hash, class_id, created_at) VALUES ('student', ?, ?, ?, ?, ?)`)
        .run(login, name, await hash(password), cls.id, Date.now());
      u = userById(Number(r.lastInsertRowid))!;
      created = true;
    }
    await setSession(reply, u.id);
    return { user: publicUser(u, db), created };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = await requireUser(req);
    return { user: publicUser(u, db) };
  });

  // ---------- классы (учитель) ----------

  const ownClass = (teacher: UserRow, id: number) => {
    const c = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(id, teacher.id) as
      | { id: number; name: string; code: string; join_open: number }
      | undefined;
    if (!c) throw notFound('Класс не найден');
    return c;
  };

  const newCode = () => {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!db.prepare('SELECT 1 FROM classes WHERE code = ?').get(c)) return c;
    }
  };

  app.get('/api/classes', async (req) => {
    const t = await requireUser(req, 'teacher');
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.code, c.join_open AS joinOpen,
                (SELECT count(*) FROM users u WHERE u.class_id = c.id) AS students
         FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at`,
      )
      .all(t.id) as { joinOpen: number }[];
    return { classes: rows.map((r) => ({ ...r, joinOpen: !!r.joinOpen })) };
  });

  app.post('/api/classes', async (req) => {
    const t = await requireUser(req, 'teacher');
    const name = str((req.body as Record<string, unknown>)?.name, 'название класса', 80);
    const code = newCode();
    const r = db.prepare('INSERT INTO classes (teacher_id, name, code, created_at) VALUES (?, ?, ?, ?)').run(t.id, name, code, Date.now());
    return { class: { id: Number(r.lastInsertRowid), name, code, joinOpen: true, students: 0 } };
  });

  app.patch('/api/classes/:id', async (req) => {
    const t = await requireUser(req, 'teacher');
    const c = ownClass(t, Number((req.params as { id: string }).id));
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.name !== undefined) db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(str(b.name, 'название класса', 80), c.id);
    if (typeof b.joinOpen === 'boolean') db.prepare('UPDATE classes SET join_open = ? WHERE id = ?').run(b.joinOpen ? 1 : 0, c.id);
    return { ok: true };
  });

  app.get('/api/classes/:id/students', async (req) => {
    const t = await requireUser(req, 'teacher');
    const c = ownClass(t, Number((req.params as { id: string }).id));
    const students = db.prepare(`SELECT id, login, name FROM users WHERE class_id = ? ORDER BY lower(name)`).all(c.id) as { id: number }[];
    const projects = db.prepare('SELECT id, name, assignment_id AS assignmentId, updated_at AS updatedAt FROM projects WHERE owner_id = ? ORDER BY updated_at DESC');
    return { students: students.map((s) => ({ ...s, projects: projects.all(s.id) })) };
  });

  app.post('/api/classes/:id/students/:sid/password', async (req) => {
    const t = await requireUser(req, 'teacher');
    const p = req.params as { id: string; sid: string };
    const c = ownClass(t, Number(p.id));
    const password = checkPassword((req.body as Record<string, unknown>)?.password, 4);
    const r = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND class_id = ? AND role = 'student'`).run(await hash(password), Number(p.sid), c.id);
    if (!r.changes) throw notFound('Ученик не найден');
    return { ok: true };
  });

  app.delete('/api/classes/:id/students/:sid', async (req) => {
    const t = await requireUser(req, 'teacher');
    const p = req.params as { id: string; sid: string };
    const c = ownClass(t, Number(p.id));
    const r = db.prepare(`DELETE FROM users WHERE id = ? AND class_id = ? AND role = 'student'`).run(Number(p.sid), c.id);
    if (!r.changes) throw notFound('Ученик не найден');
    return { ok: true };
  });

  // ---------- задания ----------

  app.get('/api/classes/:id/assignments', async (req) => {
    const t = await requireUser(req, 'teacher');
    const c = ownClass(t, Number((req.params as { id: string }).id));
    return { assignments: db.prepare('SELECT id, title, created_at AS createdAt FROM assignments WHERE class_id = ? ORDER BY created_at DESC').all(c.id) };
  });

  /** Раздать проект-задание всему классу: каждый ученик получит свою копию (и те, кто придёт позже). */
  app.post('/api/classes/:id/assignments', async (req) => {
    const t = await requireUser(req, 'teacher');
    const c = ownClass(t, Number((req.params as { id: string }).id));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = str(b.title, 'название задания', 120);
    const data = checkProjectData(b.data);
    const r = db.prepare('INSERT INTO assignments (class_id, title, data, created_at) VALUES (?, ?, ?, ?)').run(c.id, title, data, Date.now());
    const students = db.prepare(`SELECT id FROM users WHERE class_id = ? AND role = 'student'`).all(c.id) as { id: number }[];
    for (const s of students) materializeAssignments(s.id, c.id);
    return { assignment: { id: Number(r.lastInsertRowid), title }, delivered: students.length };
  });

  app.delete('/api/assignments/:id', async (req) => {
    const t = await requireUser(req, 'teacher');
    const r = db
      .prepare('DELETE FROM assignments WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE teacher_id = ?)')
      .run(Number((req.params as { id: string }).id), t.id);
    if (!r.changes) throw notFound('Задание не найдено');
    return { ok: true };
  });

  /** Создать ученику копии заданий класса, которых у него ещё нет. */
  function materializeAssignments(studentId: number, classId: number) {
    const missing = db
      .prepare(
        `SELECT a.id, a.title, a.data FROM assignments a
         WHERE a.class_id = ? AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = ? AND p.assignment_id = a.id)`,
      )
      .all(classId, studentId) as { id: number; title: string; data: string }[];
    const ins = db.prepare('INSERT INTO projects (owner_id, name, data, assignment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const a of missing) ins.run(studentId, a.title, a.data, a.id, now, now);
  }

  // ---------- проекты ----------

  interface ProjectRow {
    id: number;
    owner_id: number;
    name: string;
    data: string;
    assignment_id: number | null;
    share_token: string | null;
    updated_at: number;
  }

  /** Доступ к проекту: владелец — полный, учитель класса владельца — только чтение. */
  function access(u: UserRow, id: number): { p: ProjectRow; readOnly: boolean } {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!p) throw notFound('Проект не найден');
    if (p.owner_id === u.id) return { p, readOnly: false };
    if (u.role === 'teacher') {
      const ok = db
        .prepare('SELECT 1 FROM users s JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND c.teacher_id = ?')
        .get(p.owner_id, u.id);
      if (ok) return { p, readOnly: true };
    }
    throw notFound('Проект не найден');
  }

  app.get('/api/projects', async (req) => {
    const u = await requireUser(req);
    if (u.role === 'student' && u.class_id) materializeAssignments(u.id, u.class_id);
    const rows = db
      .prepare(
        `SELECT id, name, assignment_id AS assignmentId, share_token IS NOT NULL AS shared, updated_at AS updatedAt
         FROM projects WHERE owner_id = ? ORDER BY updated_at DESC`,
      )
      .all(u.id) as { shared: number }[];
    return { projects: rows.map((r) => ({ ...r, shared: !!r.shared })) };
  });

  app.post('/api/projects', async (req) => {
    const u = await requireUser(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name ?? 'Без названия', 'название', 120);
    const data = checkProjectData(b.data);
    const now = Date.now();
    const r = db.prepare('INSERT INTO projects (owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u.id, name, data, now, now);
    return { id: Number(r.lastInsertRowid), updatedAt: now };
  });

  app.get('/api/projects/:id', async (req) => {
    const u = await requireUser(req);
    const { p, readOnly } = access(u, Number((req.params as { id: string }).id));
    const owner = userById(p.owner_id)!;
    return {
      id: p.id,
      name: p.name,
      data: JSON.parse(p.data),
      updatedAt: p.updated_at,
      readOnly,
      assignmentId: p.assignment_id,
      shareToken: readOnly ? null : p.share_token,
      owner: { id: owner.id, name: owner.name, login: owner.login },
    };
  });

  app.put('/api/projects/:id', async (req) => {
    const u = await requireUser(req);
    const { p, readOnly } = access(u, Number((req.params as { id: string }).id));
    if (readOnly) throw forbidden('Проект ученика открыт только для просмотра');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = b.name === undefined ? p.name : str(b.name, 'название', 120);
    const data = b.data === undefined ? p.data : checkProjectData(b.data);
    const now = Math.max(Date.now(), p.updated_at + 1);
    db.prepare('UPDATE projects SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(name, data, now, p.id);
    return { updatedAt: now };
  });

  app.delete('/api/projects/:id', async (req) => {
    const u = await requireUser(req);
    const { p, readOnly } = access(u, Number((req.params as { id: string }).id));
    if (readOnly) throw forbidden();
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return { ok: true };
  });

  // ---------- ссылки «только просмотр» ----------

  app.post('/api/projects/:id/share', async (req) => {
    const u = await requireUser(req);
    const { p, readOnly } = access(u, Number((req.params as { id: string }).id));
    if (readOnly) throw forbidden();
    const token = p.share_token ?? randomBytes(18).toString('base64url');
    db.prepare('UPDATE projects SET share_token = ? WHERE id = ?').run(token, p.id);
    return { token };
  });

  app.delete('/api/projects/:id/share', async (req) => {
    const u = await requireUser(req);
    const { p, readOnly } = access(u, Number((req.params as { id: string }).id));
    if (readOnly) throw forbidden();
    db.prepare('UPDATE projects SET share_token = NULL WHERE id = ?').run(p.id);
    return { ok: true };
  });

  app.get('/api/share/:token', async (req) => {
    const token = (req.params as { token: string }).token;
    const p = db.prepare('SELECT * FROM projects WHERE share_token = ?').get(token) as ProjectRow | undefined;
    if (!p) throw notFound('Ссылка недействительна или доступ закрыт');
    const owner = userById(p.owner_id)!;
    return { name: p.name, data: JSON.parse(p.data), updatedAt: p.updated_at, owner: { name: owner.name } };
  });

  // ---------- фронтенд ----------

  if (cfg.webDist && existsSync(cfg.webDist)) {
    await app.register(fstatic, { root: cfg.webDist, wildcard: false, index: ['index.html'] });
    // SPA: любые не-API пути (например /s/<токен>) отдают index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Не найдено' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}
