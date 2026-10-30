import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const app = await buildApp(db, cfg);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
