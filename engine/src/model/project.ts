import type { Project } from './topology';

export const SCHEMA_VERSION = 1;

type AnyProject = Record<string, any>;

/** migrations[v] переводит проект из версии v в v+1. */
const migrations: Record<number, (p: AnyProject) => AnyProject> = {
  // v0 — черновой формат без версии, зерна и Auto-MDIX.
  0: (p) => ({
    ...p,
    schemaVersion: 1,
    name: p.name ?? 'Без названия',
    seed: typeof p.seed === 'number' ? p.seed : 1,
    links: p.links ?? [],
    devices: (p.devices ?? []).map((d: AnyProject) => ({
      ...d,
      config: { autoMdix: false, ...(d.config ?? {}) },
    })),
  }),
};

export class ProjectFormatError extends Error {}

/** Приводит проект любой известной версии к текущей. Бросает ProjectFormatError, если формат не распознан. */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AnyProject).devices)) {
    throw new ProjectFormatError('Файл не похож на проект: нет списка устройств');
  }
  let p = raw as AnyProject;
  let v: number = typeof p.schemaVersion === 'number' ? p.schemaVersion : 0;
  if (v > SCHEMA_VERSION) {
    throw new ProjectFormatError(`Проект создан в более новой версии (схема ${v}), обновите приложение`);
  }
  while (v < SCHEMA_VERSION) {
    const m = migrations[v];
    if (!m) throw new ProjectFormatError(`Нет миграции для версии схемы ${v}`);
    p = m(p);
    v = p.schemaVersion;
  }
  return p as Project;
}

export function emptyProject(name = 'Новый проект', seed = 1): Project {
  return { schemaVersion: SCHEMA_VERSION, name, seed, devices: [], links: [] };
}
