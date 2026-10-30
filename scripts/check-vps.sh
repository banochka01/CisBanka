#!/usr/bin/env bash
# Проверка VPS перед запуском CisBanka: Docker, порты 80/443, RAM, диск, DNS домена, .env, доступ к образу.
# Ничего не меняет. Запуск из папки проекта:  ./scripts/check-vps.sh
# За своим nginx (без Caddy):                 ./scripts/check-vps.sh --behind-proxy
# Код выхода: 0 — можно запускать, 1 — есть ошибки (список в конце).
set -u
cd "$(dirname "$0")/.."

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G= Y= R= B= N=; fi
ERRORS=()
WARNINGS=()
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; WARNINGS+=("$*"); }
fail() { echo "  ${R}✖${N} $*"; ERRORS+=("$*"); }
info() { echo "    $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# значение из .env (без кавычек и комментариев)
envval() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n1 | sed 's/[[:space:]]*#.*$//; s/^["'\'']//; s/["'\'']$//'; }

IMAGE=ghcr.io/banochka01/cisbanka
BEHIND_PROXY=0
[ "${1:-}" = --behind-proxy ] && BEHIND_PROXY=1

echo "${B}Система${N}"
ARCH=$(uname -m)
if [ "$ARCH" = x86_64 ]; then ok "архитектура $ARCH"
else fail "архитектура $ARCH: образ в GHCR собран только под amd64 (x86_64) — соберите на сервере: docker compose -f docker-compose.yml up -d --build"; fi
[ -r /etc/os-release ] && info "$(. /etc/os-release; echo "$PRETTY_NAME")"

echo "${B}Docker${N}"
DOCKER_OK=0
if ! have docker; then
  fail "Docker не установлен: curl -fsSL https://get.docker.com | sudo sh"
elif ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" != 0 ] && ! id -nG | grep -qw docker; then
    fail "нет доступа к Docker у пользователя $(id -un): sudo usermod -aG docker $(id -un) и перелогиньтесь"
  else
    fail "Docker не запущен: sudo systemctl enable --now docker"
  fi
else
  DOCKER_OK=1
  ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"
  if docker compose version >/dev/null 2>&1; then ok "$(docker compose version | head -n1)"
  else fail "нет docker compose v2: sudo apt install docker-compose-plugin"; fi
fi

# Кто слушает порт: пусто — свободен
listener() { ss -Hltnp "sport = :$1" 2>/dev/null | head -n1; }
procname() { echo "$1" | grep -o 'users:(("[^"]*"' | sed 's/users:(("//'; }

PORTS_BUSY=0
if ! have ss; then
  echo "${B}Порты${N}"
  warn "нет утилиты ss (пакет iproute2) — порты не проверены"
elif [ "$BEHIND_PROXY" = 1 ]; then
  APP_PORT=$(envval APP_PORT); APP_PORT=${APP_PORT:-3000}
  echo "${B}Порт приложения ${APP_PORT} (режим за своим прокси)${N}"
  line=$(listener "$APP_PORT")
  if [ -z "$line" ]; then ok "порт 127.0.0.1:$APP_PORT свободен"
  elif [ "$DOCKER_OK" = 1 ] && docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'app' | grep -q ":$APP_PORT->"; then ok "порт $APP_PORT занят контейнером CisBanka — уже запущено"
  else fail "порт $APP_PORT занят${line:+: $(procname "$line")} — задайте другой APP_PORT в .env и в proxy_pass"; fi
else
  echo "${B}Порты 80 и 443${N}"
  for port in 80 443; do
    line=$(listener "$port")
    if [ -z "$line" ]; then ok "порт $port свободен"; continue; fi
    # занят нашим же Caddy (повторный запуск) — это нормально
    if [ "$DOCKER_OK" = 1 ] && docker ps --format '{{.Image}} {{.Ports}}' 2>/dev/null | grep -E '^caddy' | grep -q ":$port->"; then
      ok "порт $port занят контейнером Caddy от CisBanka — уже запущено"
      continue
    fi
    PORTS_BUSY=1
    proc=$(procname "$line")
    if [ -n "$proc" ]; then fail "порт $port занят: $proc"
    else fail "порт $port занят (запустите скрипт через sudo, чтобы увидеть, кем)"; fi
  done
  if [ "$PORTS_BUSY" = 1 ]; then
    info "Вариант без Caddy: только приложение за вашим nginx — README, раздел «Если порты 80/443 уже заняты»,"
    info "и проверка для этого режима: ./scripts/check-vps.sh --behind-proxy"
  fi
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for port in 80 443; do
      ufw status | grep ALLOW | grep -Eq "(^|,)$port(,|/|[[:space:]])" || warn "ufw включён, а порт $port не открыт: sudo ufw allow 80,443/tcp"
    done
  fi
fi

echo "${B}Память и диск${N}"
if [ -r /proc/meminfo ]; then
  avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  [ -z "$avail" ] && avail=$(awk '/^MemFree:/ {print int($2/1024)}' /proc/meminfo)   # старые ядра без MemAvailable
  total=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
  swap=$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)
  msg="свободно RAM ${avail} МБ из ${total} МБ, swap ${swap} МБ"
  # приложению хватает ~150 МБ, Caddy ~30 МБ; потолок контейнера — APP_MEM_LIMIT (512m)
  if [ "$avail" -lt 256 ]; then fail "$msg — нужно хотя бы 256 МБ"
  elif [ "$avail" -lt 512 ]; then warn "$msg — впритык; при нехватке задайте APP_MEM_LIMIT=256m в .env или добавьте swap"
  else ok "$msg"; fi
  [ "$swap" = 0 ] && [ "$total" -lt 2048 ] && info "swap нет — на маленьком VPS лучше добавить 1–2 ГБ (fallocate + mkswap + swapon)"
fi
check_disk() {
  local path=$1 label=$2 free
  free=$(df -Pm "$path" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -z "$free" ] && return
  if [ "$free" -lt 1024 ]; then fail "$label: свободно ${free} МБ — нужно от 1 ГБ (образ ~250 МБ + база + бэкапы)"
  elif [ "$free" -lt 3072 ]; then warn "$label: свободно ${free} МБ — хватит, но следите (docker image prune -f после обновлений)"
  else ok "$label: свободно $((free / 1024)) ГБ"; fi
}
check_disk . "диск под проектом ($(pwd))"
if [ "$DOCKER_OK" = 1 ]; then
  droot=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)
  [ -n "$droot" ] && [ "$(df -P "$droot" 2>/dev/null | awk 'NR==2{print $6}')" != "$(df -P . | awk 'NR==2{print $6}')" ] && check_disk "$droot" "диск Docker ($droot)"
fi

echo "${B}Файл .env${N}"
DOMAIN=""
if [ ! -f .env ]; then
  fail ".env нет: cp .env.example .env и заполните"
else
  DOMAIN=$(envval DOMAIN)
  jwt=$(envval JWT_SECRET); invite=$(envval ADMIN_INVITE_CODE); cf=$(envval COMPOSE_FILE)
  if [ -z "$DOMAIN" ] || [ "$DOMAIN" = cisbanka.example.ru ]; then fail "DOMAIN не задан (сейчас «${DOMAIN}»)"; else ok "DOMAIN=$DOMAIN"; fi
  if [ ${#jwt} -lt 32 ]; then fail "JWT_SECRET пустой или короче 32 символов: sed -i \"s/^JWT_SECRET=.*/JWT_SECRET=\$(openssl rand -hex 32)/\" .env"; else ok "JWT_SECRET задан"; fi
  if [ ${#invite} -lt 8 ]; then fail "ADMIN_INVITE_CODE пустой или короче 8 символов"; else ok "ADMIN_INVITE_CODE задан"; fi
  if [ "$cf" = docker-compose.prod.yml ]; then ok "COMPOSE_FILE=docker-compose.prod.yml — готовый образ из GHCR"
  else warn "COMPOSE_FILE не задан — docker compose будет собирать образ на сервере; добавьте: echo COMPOSE_FILE=docker-compose.prod.yml >> .env"; fi
fi

echo "${B}DNS${N}"
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != cisbanka.example.ru ]; then
  if [ "$DOMAIN" = localhost ]; then
    warn "DOMAIN=localhost — Caddy выдаст самоподписанный сертификат, снаружи сайт не откроется"
  elif ! have dig && ! have getent; then
    warn "нет ни dig, ни getent — DNS не проверен (sudo apt install dnsutils)"
  else
    resolve() { # $1 = A | AAAA
      if have dig; then dig +short "$1" "$DOMAIN" | grep -E '^[0-9a-fA-F:.]+$'
      elif [ "$1" = A ]; then getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u
      else getent ahostsv6 "$DOMAIN" | awk '{print $1}' | grep -v '^::ffff:' | sort -u; fi
    }
    fetch() { if have curl; then curl -s --max-time 5 "$@"; elif have wget; then wget -qO- -T 5 "${@: -1}"; fi; }
    dns4=$(resolve A | tr '\n' ' ' | sed 's/ $//')
    dns6=$(resolve AAAA | tr '\n' ' ' | sed 's/ $//')
    my4=$(fetch -4 https://api.ipify.org 2>/dev/null)
    my6=$(fetch -6 https://api6.ipify.org 2>/dev/null)
    info "этот сервер: IPv4 ${my4:-не определён}${my6:+, IPv6 $my6}"
    if [ -z "$dns4" ] && [ -z "$dns6" ]; then
      fail "$DOMAIN не резолвится — создайте A-запись на ${my4:-IP сервера} (обновление DNS занимает до часа)"
    else
      if [ -z "$dns4" ]; then warn "у $DOMAIN нет A-записи"
      elif [ -z "$my4" ]; then warn "A-запись $DOMAIN → $dns4, а внешний IPv4 сервера определить не удалось — сверьте вручную"
      elif echo " $dns4 " | grep -q " $my4 "; then ok "A-запись $DOMAIN → $dns4 — это этот сервер"
      else fail "A-запись $DOMAIN → $dns4, а у сервера IPv4 $my4 — исправьте A-запись"; fi
      # Let's Encrypt предпочитает IPv6: чужая AAAA-запись ломает выпуск сертификата
      if [ -n "$dns6" ]; then
        if [ -n "$my6" ] && echo " $dns6 " | grep -q " $my6 "; then ok "AAAA-запись $DOMAIN → $dns6 — это этот сервер"
        else fail "AAAA-запись $DOMAIN → $dns6 не ведёт на этот сервер${my6:+ ($my6)} — удалите или исправьте её, иначе Let's Encrypt не выдаст сертификат"; fi
      fi
    fi
  fi
else
  info "пропущено: DOMAIN не задан"
fi

echo "${B}Образ ${IMAGE}${N}"
if [ "$DOCKER_OK" = 1 ]; then
  tag=$(envval CISBANKA_TAG); tag=${tag:-latest}
  if docker manifest inspect "$IMAGE:$tag" >/dev/null 2>&1; then ok "образ $IMAGE:$tag доступен"
  else fail "образ $IMAGE:$tag недоступен: сделайте пакет публичным или docker login ghcr.io (README, «Доступ к образу в GHCR»)"; fi
else
  info "пропущено: Docker недоступен"
fi

echo
if [ ${#ERRORS[@]} -eq 0 ]; then
  echo "${G}${B}Всё готово к запуску${N}${WARNINGS[*]:+ (предупреждений: ${#WARNINGS[@]})}:"
  if [ "$BEHIND_PROXY" = 1 ]; then echo "  docker compose pull app && docker compose up -d app"; else echo "  docker compose pull && docker compose up -d"; fi
  exit 0
fi
echo "${R}${B}Что исправить перед запуском (${#ERRORS[@]}):${N}"
i=1
for e in "${ERRORS[@]}"; do echo "  $i. $e"; i=$((i + 1)); done
exit 1
