// Онлайн-бэкап SQLite (база не останавливается) с ротацией: хранит последние N копий.
// Запуск в контейнере: node dist/backup.js [--keep 7] [--dir /data/backups]
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const keep = Math.max(1, Number(opt('keep', '7')));
const dir = opt('dir', '/data/backups');
const { dbPath } = loadConfig({ ...process.env, NODE_ENV: 'backup' });

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
const file = join(dir, `cisbanka-${stamp}.db`);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
await db.backup(file);
db.close();

const old = readdirSync(dir)
  .filter((f) => /^cisbanka-.*\.db$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of old) rmSync(join(dir, f));

console.log(`Бэкап: ${file}; удалено старых: ${old.length}; хранится: ${keep}`);
