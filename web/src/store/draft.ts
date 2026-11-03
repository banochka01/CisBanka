// Черновик проекта в браузере: симулятор общедоступный, без аккаунтов — работа не теряется
// при перезагрузке страницы. Для переноса и обмена — «Сохранить проект» (файл .json).
import { migrateProject } from '@ciscobanka/engine';
import { useStore } from './project';

const KEY = 'cisbanka:draft';

export function restoreDraft() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) useStore.getState().loadProject(migrateProject(JSON.parse(raw)));
  } catch {
    // нет доступа к localStorage или черновик повреждён — начинаем с пустого проекта
  }
}

/** Сохранять черновик через секунду после изменений. Возвращает отписку. */
export function startAutosave() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(useStore.getState().project));
      } catch {
        // переполнение или запрет хранилища — черновик просто не сохранится
      }
    }, 1000);
  });
  return () => {
    clearTimeout(timer);
    unsub();
  };
}
