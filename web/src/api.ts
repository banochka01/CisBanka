// Клиент HTTP API сервера (cookie-сессия, ошибки — по-русски от сервера).
import type { Project } from '@ciscobanka/engine';

export interface User {
  id: number;
  role: 'teacher' | 'student';
  login: string;
  name: string;
  class: { id: number; name: string; code: string } | null;
  /** Вошёл по одноразовому паролю — должен задать свой. */
  mustChangePassword: boolean;
}

export interface ProjectMeta {
  id: number;
  name: string;
  assignmentId: number | null;
  shared: boolean;
  updatedAt: number;
}

export interface ProjectDoc {
  id: number;
  name: string;
  data: Project;
  updatedAt: number;
  readOnly: boolean;
  assignmentId: number | null;
  shareToken: string | null;
  owner: { id: number; name: string; login: string };
}

export interface ClassInfo {
  id: number;
  name: string;
  code: string;
  joinOpen: boolean;
  students: number;
}

export interface Student {
  id: number;
  login: string;
  name: string;
  mustChangePassword: boolean;
  projects: { id: number; name: string; assignmentId: number | null; updatedAt: number }[];
}

/** Выданные учителем логин и пароль (пароль виден только один раз). */
export interface IssuedCredentials {
  id: number;
  name: string;
  login: string;
  password: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Тело ответа с ошибкой (например, canRegister). */
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Сервер недоступен — проверьте подключение');
  }
  const json = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, json?.error ?? `Ошибка ${r.status}`, json);
  return json as T;
}

export const api = {
  me: () => call<{ user: User }>('GET', '/api/auth/me'),
  teacherLogin: (login: string, password: string) => call<{ user: User }>('POST', '/api/auth/teacher/login', { login, password }),
  teacherRegister: (invite: string, login: string, password: string, name: string) =>
    call<{ user: User }>('POST', '/api/auth/teacher/register', { invite, login, password, name }),
  studentLogin: (classCode: string, login: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/student/login', { classCode, login, password }),
  studentRegister: (classCode: string, login: string, password: string, name: string) =>
    call<{ user: User }>('POST', '/api/auth/student/register', { classCode, login, password, name }),
  changePassword: (password: string, current?: string) => call<{ user: User }>('POST', '/api/auth/password', { password, current }),
  logout: () => call('POST', '/api/auth/logout'),

  projects: () => call<{ projects: ProjectMeta[] }>('GET', '/api/projects'),
  project: (id: number) => call<ProjectDoc>('GET', `/api/projects/${id}`),
  createProject: (name: string, data: Project) => call<{ id: number; updatedAt: number }>('POST', '/api/projects', { name, data }),
  saveProject: (id: number, name: string, data: Project) => call<{ updatedAt: number }>('PUT', `/api/projects/${id}`, { name, data }),
  deleteProject: (id: number) => call('DELETE', `/api/projects/${id}`),
  share: (id: number) => call<{ token: string }>('POST', `/api/projects/${id}/share`),
  unshare: (id: number) => call('DELETE', `/api/projects/${id}/share`),
  shared: (token: string) => call<{ name: string; data: Project; owner: { name: string } }>('GET', `/api/share/${encodeURIComponent(token)}`),

  classes: () => call<{ classes: ClassInfo[] }>('GET', '/api/classes'),
  createClass: (name: string) => call<{ class: ClassInfo }>('POST', '/api/classes', { name }),
  updateClass: (id: number, patch: { name?: string; joinOpen?: boolean }) => call('PATCH', `/api/classes/${id}`, patch),
  students: (classId: number) => call<{ students: Student[] }>('GET', `/api/classes/${classId}/students`),
  addStudents: (classId: number, names: string[]) =>
    call<{ students: IssuedCredentials[] }>('POST', `/api/classes/${classId}/students`, { names }),
  resetPassword: (classId: number, studentId: number) =>
    call<{ password: string }>('POST', `/api/classes/${classId}/students/${studentId}/password`),
  removeStudent: (classId: number, studentId: number) => call('DELETE', `/api/classes/${classId}/students/${studentId}`),
  assign: (classId: number, title: string, data: Project) =>
    call<{ delivered: number }>('POST', `/api/classes/${classId}/assignments`, { title, data }),
};

export const shareUrl = (token: string) => `${location.origin}/s/${token}`;
