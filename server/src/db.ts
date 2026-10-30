// SQLite: открытие базы и миграции схемы (PRAGMA user_version).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1: пользователи, классы, проекты, задания
  `
  CREATE TABLE classes (
    id          INTEGER PRIMARY KEY,
    teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    join_open   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
    login         TEXT NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    class_id      INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX ux_teacher_login ON users(lower(login)) WHERE role = 'teacher';
  CREATE UNIQUE INDEX ux_student_login ON users(class_id, lower(login)) WHERE role = 'student';
  CREATE TABLE assignments (
    id          INTEGER PRIMARY KEY,
    class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id            INTEGER PRIMARY KEY,
    owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    data          TEXT NOT NULL,
    assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
    share_token   TEXT UNIQUE,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX ix_projects_owner ON projects(owner_id);
  CREATE UNIQUE INDEX ux_projects_assignment ON projects(owner_id, assignment_id) WHERE assignment_id IS NOT NULL;
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const v = db.pragma('user_version', { simple: true }) as number;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
