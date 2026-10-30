import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

process.env.NODE_ENV = 'test';

const project = (name = 'Сеть') => ({ schemaVersion: 1, name, seed: 1, devices: [], links: [] });

let app: FastifyInstance;

/** Мини-клиент с cookie, как браузер. */
function client() {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, payload: body as object, headers: cookie ? { cookie } : {} });
    const set = r.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return { call };
}

beforeEach(async () => {
  const cfg = loadConfig({ JWT_SECRET: 'x'.repeat(40), ADMIN_INVITE_CODE: 'invite-123', LOGIN_RATE_LIMIT: '5' });
  app = await buildApp(openDb(':memory:'), cfg);
});

async function teacherWithClass() {
  const t = client();
  expect((await t.call('POST', '/api/auth/teacher/register', { invite: 'invite-123', login: 'teacher', password: 'password1', name: 'Мария Ивановна' })).status).toBe(200);
  const cls = (await t.call('POST', '/api/classes', { name: '9А' })).body.class;
  return { t, cls };
}

describe('API', () => {
  it('healthcheck', async () => {
    expect((await client().call('GET', '/api/health')).body).toEqual({ ok: true });
  });

  it('регистрация учителя только по коду приглашения; открытой регистрации нет', async () => {
    const c = client();
    expect((await c.call('POST', '/api/auth/teacher/register', { invite: 'wrong', login: 'x1', password: 'password1' })).status).toBe(403);
    expect((await c.call('POST', '/api/auth/student/login', { classCode: 'NOPE00', login: 'vasya', password: '1234' })).status).toBe(401);
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
  });

  it('ученик входит по коду класса + логину; повторный вход проверяет пароль; закрытый приём', async () => {
    const { t, cls } = await teacherWithClass();
    const s = client();
    const r = await s.call('POST', '/api/auth/student/login', { classCode: cls.code.toLowerCase(), login: 'vasya', password: '1234', name: 'Вася' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.user).toMatchObject({ role: 'student', name: 'Вася', class: { code: cls.code } });
    expect((await client().call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'Vasya', password: 'wrong' })).status).toBe(401);
    expect((await client().call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'vasya', password: '1234' })).body.created).toBe(false);
    await t.call('PATCH', `/api/classes/${cls.id}`, { joinOpen: false });
    expect((await client().call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'petya', password: '1234' })).status).toBe(403);
    // ученику нельзя в учительские разделы
    expect((await s.call('GET', '/api/classes')).status).toBe(403);
  });

  it('учитель видит проекты учеников своего класса только на чтение; чужой учитель — нет', async () => {
    const { t, cls } = await teacherWithClass();
    const s = client();
    await s.call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'vasya', password: '1234' });
    const { id } = (await s.call('POST', '/api/projects', { name: 'Моя сеть', data: project() })).body;

    const list = (await t.call('GET', `/api/classes/${cls.id}/students`)).body.students;
    expect(list[0].projects[0]).toMatchObject({ id, name: 'Моя сеть' });
    const p = (await t.call('GET', `/api/projects/${id}`)).body;
    expect(p.readOnly).toBe(true);
    expect(p.owner.login).toBe('vasya');
    expect((await t.call('PUT', `/api/projects/${id}`, { data: project('взлом') })).status).toBe(403);

    const other = client();
    await other.call('POST', '/api/auth/teacher/register', { invite: 'invite-123', login: 'other', password: 'password2' });
    expect((await other.call('GET', `/api/projects/${id}`)).status).toBe(404);
    expect((await other.call('GET', `/api/classes/${cls.id}/students`)).status).toBe(404);
  });

  it('задание раздаётся всему классу, включая учеников, пришедших позже', async () => {
    const { t, cls } = await teacherWithClass();
    const a = client();
    await a.call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'anya', password: '1234' });
    const r = await t.call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Задание 1: VLAN', data: project('VLAN') });
    expect(r.body.delivered).toBe(1);
    expect((await a.call('GET', '/api/projects')).body.projects[0]).toMatchObject({ name: 'Задание 1: VLAN', assignmentId: r.body.assignment.id });
    const b = client();
    await b.call('POST', '/api/auth/student/login', { classCode: cls.code, login: 'boris', password: '1234' });
    const bp = (await b.call('GET', '/api/projects')).body.projects;
    expect(bp).toHaveLength(1);
    // повторный запрос не плодит копии
    expect((await b.call('GET', '/api/projects')).body.projects).toHaveLength(1);
    // ученик правит свою копию
    expect((await b.call('PUT', `/api/projects/${bp[0].id}`, { data: project('решение') })).status).toBe(200);
  });

  it('ссылка «только просмотр» открывается без входа и закрывается', async () => {
    const { t } = await teacherWithClass();
    const { id } = (await t.call('POST', '/api/projects', { name: 'Пример', data: project() })).body;
    const { token } = (await t.call('POST', `/api/projects/${id}/share`)).body;
    const anon = client();
    expect((await anon.call('GET', `/api/share/${token}`)).body).toMatchObject({ name: 'Пример', data: { devices: [] } });
    await t.call('DELETE', `/api/projects/${id}/share`);
    expect((await anon.call('GET', `/api/share/${token}`)).status).toBe(404);
  });

  it('проверка данных проекта', async () => {
    const { t } = await teacherWithClass();
    expect((await t.call('POST', '/api/projects', { name: 'x', data: { hello: 1 } })).status).toBe(400);
  });

  it('rate limit на вход', async () => {
    const c = client();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await c.call('POST', '/api/auth/teacher/login', { login: 'nobody', password: 'x' })).status);
    expect(codes.slice(0, 5).every((x) => x === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
