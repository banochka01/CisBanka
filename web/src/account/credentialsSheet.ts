// Выданные логины и пароли: печать карточек для раздачи и выгрузка CSV.
import type { IssuedCredentials } from '../api';

interface SheetClass {
  name: string;
  code: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** CSV для Excel: UTF-8 с BOM и «;» — так русский Excel открывает без мастера импорта. */
export function downloadCsv(rows: IssuedCredentials[], cls: SheetClass) {
  const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['Имя', 'Логин', 'Пароль', 'Код класса', 'Адрес'], ...rows.map((r) => [r.name, r.login, r.password, cls.code, location.origin])];
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${cls.name.replace(/[\\/:*?"<>|]/g, '_')} — пароли.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Карточки «вырежи и отдай ученику» в отдельном окне печати. */
export function printSheet(rows: IssuedCredentials[], cls: SheetClass, oneTime: boolean) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) {
    alert('Браузер заблокировал окно печати — разрешите всплывающие окна для этого сайта или скачайте CSV.');
    return;
  }
  const site = esc(location.host);
  const cards = rows
    .map(
      (r) => `<div class="card">
  <div class="name">${esc(r.name)}</div>
  <table>
    <tr><td>Сайт</td><td><b>${site}</b></td></tr>
    <tr><td>Код класса</td><td class="mono">${esc(cls.code)}</td></tr>
    <tr><td>Логин</td><td class="mono">${esc(r.login)}</td></tr>
    <tr><td>Пароль</td><td class="mono">${esc(r.password)}</td></tr>
  </table>
  ${oneTime ? '<div class="note">Пароль одноразовый: после входа придумайте свой.</div>' : ''}
</div>`,
    )
    .join('\n');
  w.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(cls.name)} — логины и пароли</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #000; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0; }
  .card { border: 1px dashed #888; padding: 10px 14px; break-inside: avoid; }
  .name { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  td { padding: 1px 10px 1px 0; vertical-align: top; }
  td:first-child { color: #555; }
  .mono { font: 600 16px/1.3 ui-monospace, Consolas, monospace; letter-spacing: .04em; }
  .note { font-size: 12px; color: #555; margin-top: 4px; }
  @media print { .noprint { display: none; } body { margin: 0; } }
</style></head><body>
<h1>CisBanka · класс ${esc(cls.name)} · ${rows.length} уч. <button class="noprint" onclick="print()">Печать</button></h1>
<div class="grid">${cards}</div>
<script>setTimeout(() => print(), 300)</script>
</body></html>`);
  w.document.close();
}
