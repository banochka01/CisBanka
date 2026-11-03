#!/usr/bin/env bash
# Автодеплой CisBanka. Запускается из GitHub Actions по SSH отдельным ключом, у которого в authorized_keys
# задан command="…/scripts/deploy.sh" — этим ключом нельзя выполнить ничего, кроме этого скрипта.
#
# Команда от клиента приходит в SSH_ORIGINAL_COMMAND и проверяется строго:
#   deploy <40-символьный sha коммита>   — обновить репозиторий до коммита и выкатить образ sha-<7>
#   status                               — показать версию и состояние контейнеров
# Вручную на сервере:  ./scripts/deploy.sh deploy <sha>   или   ./scripts/deploy.sh status
#
# Порядок: бэкап → git fast-forward до коммита → docker compose pull/up нужного образа → ожидание healthcheck
# и проверка версии в /api/health → при неудаче откат на прошлую успешную версию.
#
# Всё тело — в функции main: bash дочитывает файл целиком до запуска, поэтому git pull, меняющий
# этот же скрипт, не ломает текущий запуск.
set -euo pipefail

main() {
  local dir log lock req action sha tag prev
  dir="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
  cd "$dir"
  export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

  req="${SSH_ORIGINAL_COMMAND:-$*}"
  read -r action sha _extra <<<"$req" || true
  case "$action" in
    status)
      status
      return
      ;;
    deploy) ;;
    *)
      echo "Неизвестная команда: «${req}». Допустимо: deploy <sha коммита> | status" >&2
      return 2
      ;;
  esac
  if [[ ! "${sha:-}" =~ ^[0-9a-f]{40}$ || -n "${_extra:-}" ]]; then
    echo "Ожидался полный sha коммита (40 hex-символов), получено: «${req}»" >&2
    return 2
  fi
  tag="sha-${sha:0:7}"

  # Два деплоя одновременно (повторный запуск CI) не должны мешать друг другу.
  exec 9>"$dir/.deploy.lock"
  if ! flock -w 600 9; then
    echo "Другой деплой идёт дольше 10 минут — выхожу" >&2
    return 1
  fi

  mkdir -p backups
  log="backups/deploy.log"
  echo "$(date -Is) деплой $tag начат" >>"$log"
  prev="$(cat .deploy-tag 2>/dev/null || true)"

  echo "== 1/4 бэкап базы"
  if docker compose ps --status running -q app | grep -q .; then
    ./scripts/backup.sh
  else
    echo "приложение не запущено — бэкап пропущен"
  fi

  echo "== 2/4 репозиторий → ${sha:0:7}"
  git fetch --quiet origin
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "Коммит $sha не найден в origin — деплой остановлен" >&2
    return 1
  fi
  if ! git merge-base --is-ancestor HEAD "$sha"; then
    echo "Локальная ветка разошлась с $sha (локальные коммиты или правки?) — деплой остановлен, разберитесь вручную: git status" >&2
    return 1
  fi
  git merge --quiet --ff-only "$sha"

  echo "== 3/4 образ $tag"
  if ! up "$tag"; then
    echo "!! $tag не поднялся" >&2
    docker compose logs --no-color --tail 80 app >&2 || true
    if [[ -n "$prev" && "$prev" != "$tag" ]]; then
      echo "== откат на $prev" >&2
      up "$prev" || echo "!! откат тоже не поднялся — нужна ручная проверка" >&2
    fi
    echo "$(date -Is) деплой $tag ПРОВАЛЕН (откат на ${prev:-—})" >>"$log"
    return 1
  fi
  echo "$tag" >.deploy-tag

  echo "== 4/4 уборка"
  docker image prune -f >/dev/null || true
  echo "$(date -Is) деплой $tag успешен" >>"$log"
  status
}

# Поднять конкретный тег и дождаться: контейнер healthy и /api/health отвечает этой версией.
up() {
  local tag="$1" port cid health ver i svc=()
  # Режим «за своим nginx» (README): запущен только app, без Caddy — тогда и обновляем только app.
  if [[ -n "$(docker compose ps -a -q app)" && -z "$(docker compose ps -a -q caddy)" ]]; then svc=(app); fi
  CISBANKA_TAG="$tag" docker compose pull --quiet app
  CISBANKA_TAG="$tag" docker compose up -d "${svc[@]}"
  port="$(grep -E '^APP_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
  port="${port:-3000}"
  for i in $(seq 1 40); do
    cid="$(docker compose ps -q app)"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
    ver="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
    if [[ "$health" == healthy && "$ver" == *"\"version\":\"$tag\""* ]]; then
      echo "healthy, $ver"
      return 0
    fi
    sleep 3
  done
  echo "за 2 минуты не дождался: health=$health, /api/health=${ver:-нет ответа}" >&2
  return 1
}

status() {
  echo "версия: $(cat .deploy-tag 2>/dev/null || echo 'не деплоилось скриптом')"
  echo "коммит: $(git log -1 --format='%h %s')"
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
}

main "$@"
