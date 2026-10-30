// Настройки из переменных окружения (.env читает docker compose).
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  jwtSecret: string;
  adminInviteCode: string;
  /** Папка со сборкой фронтенда; пусто — статику не раздаём (режим разработки). */
  webDist: string | null;
  /** Сколько попыток входа в минуту с одного IP. */
  loginRateLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? '';
  const adminInviteCode = env.ADMIN_INVITE_CODE ?? '';
  const production = env.NODE_ENV === 'production';
  if (production && jwtSecret.length < 32) throw new Error('JWT_SECRET не задан или короче 32 символов — см. .env.example');
  if (production && adminInviteCode.length < 8) throw new Error('ADMIN_INVITE_CODE не задан или короче 8 символов — см. .env.example');
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : resolve(env.DB_PATH ?? 'data/cisbanka.db'),
    jwtSecret: jwtSecret || 'dev-secret-dev-secret-dev-secret-0000',
    adminInviteCode: adminInviteCode || 'dev-invite',
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
  };
}
