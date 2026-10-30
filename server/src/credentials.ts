// Логины и пароли для учеников, которых учитель заводит списком.
import { randomInt } from 'node:crypto';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

const latin = (word: string) =>
  [...word.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]/g, '');

/**
 * «Иванов Пётр» → «ivanov.p»: латиница, чтобы не путаться с раскладкой.
 * Занятые логины получают номер: ivanov.p2, ivanov.p3…
 */
export function makeLogin(name: string, taken: (login: string) => boolean): string {
  const words = name.split(/\s+/).map(latin).filter(Boolean);
  let base = words[0]?.slice(0, 24) ?? '';
  if (words[1]) base += `.${words[1][0]}`;
  if (base.length < 2) base = 'student';
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
}

// Без похожих букв (l/i, o) — пароль переписывают с бумажки.
const CONS = 'bdfgkmnprstvz';
const VOWELS = 'aeu';

/** Читаемый пароль вида «bazu4721»: два слога + 4 цифры (~1,5·10⁷ вариантов; перебор упирается в rate limit входа). */
export function makePassword(): string {
  let s = '';
  for (let i = 0; i < 2; i++) s += CONS[randomInt(CONS.length)] + VOWELS[randomInt(VOWELS.length)];
  for (let i = 0; i < 4; i++) s += randomInt(10);
  return s;
}
