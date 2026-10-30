# CisBanka

Учебный симулятор компьютерной сети в браузере — упрощённый Packet Tracer на русском.
Топология на холсте, настройка устройств через окна (без CLI), режим симуляции с конвертами по проводам,
разбором пакетов по OSI, классы учеников и задания от учителя.

- `engine/` — движок сети на чистом TypeScript (Ethernet, VLAN, ARP, IPv4, маршрутизация, ICMP, DHCP, DNS, HTTP/TCP), тесты на Vitest.
- `web/` — интерфейс: React + Vite + React Flow + Zustand.
- `server/` — Fastify + SQLite: вход учителей и учеников, проекты, классы, задания, ссылки «только просмотр».

## Роли

- **Учитель** регистрируется кодом приглашения `ADMIN_INVITE_CODE` из `.env`. Открытой регистрации нет.
- Учитель создаёт **класс** и получает **код класса** (например `K7Q2MX`).
- **Ученик** входит по коду класса + своему логину и паролю. Первый вход с новым логином создаёт аккаунт, если учитель не закрыл приём в класс («Принимать новых учеников»).
- Учитель видит проекты учеников своего класса только на чтение, может сменить ученику пароль и **раздать текущий проект как задание** — каждый ученик (и пришедшие позже) получит свою копию.
- Любой проект можно открыть по ссылке «только просмотр» (`https://домен/s/…`), без входа. Доступ по ссылке закрывается в «Мои проекты».
- Проекты сохраняются автоматически каждые ~30 секунд (индикатор «Сохранено» вверху; Ctrl+S — сохранить сразу). Экспорт/импорт JSON работает и без входа.

## Локальный запуск (разработка)

Нужен Node.js 22+.

```bash
npm install
```

В одном терминале — сервер API (порт 3000, база в `server/data/`, код приглашения учителя в разработке — `dev-invite`):

```bash
npm run dev:server
```

В другом — интерфейс (http://127.0.0.1:5173, запросы `/api` проксируются на сервер):

```bash
npm run dev
```

Тесты и проверка типов:

```bash
npm test
```

```bash
npm run typecheck
```

## Развёртывание на VPS (Ubuntu) через Docker

Образ собирается в GitHub Actions и публикуется в GHCR: `ghcr.io/banochka01/cisbanka`
(теги `latest` — последний зелёный коммит в `main`, и `sha-<7 символов коммита>` — для отката).
На сервере ничего не компилируется: `docker-compose.prod.yml` только скачивает готовый образ.
Образ собран под `linux/amd64`.

### 1. Установить Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # перелогиньтесь, чтобы работать без sudo
docker compose version          # должна быть v2
```

### 2. DNS: A-запись

В панели регистратора домена создайте A-запись `cisbanka.example.ru → IP вашего VPS`
(и AAAA, если есть IPv6) — без неё Caddy не получит сертификат. Порты 80 и 443 должны быть открыты в файрволе:

```bash
sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp
```

### 3. Склонировать и настроить `.env`

Из репозитория на сервере нужны только `docker-compose.prod.yml`, `Caddyfile`, `.env.example` и `scripts/` —
проще склонировать целиком:

```bash
git clone https://github.com/banochka01/CisBanka.git && cd CisBanka
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
echo "COMPOSE_FILE=docker-compose.prod.yml" >> .env
nano .env
```

| Переменная | Что это |
|---|---|
| `DOMAIN` | ваш домен из A-записи, например `cisbanka.example.ru` |
| `JWT_SECRET` | секрет сессий, сгенерируйте: `openssl rand -hex 32` |
| `ADMIN_INVITE_CODE` | код приглашения учителей (от 8 символов), сообщайте только учителям |
| `COMPOSE_FILE` | `docker-compose.prod.yml` — тогда все команды ниже (и `scripts/backup.sh`) работают с готовым образом |
| `CISBANKA_TAG` | версия образа: `latest` (по умолчанию) или `sha-abc1234` |
| `APP_PORT` | порт приложения на `127.0.0.1` хоста (по умолчанию 3000) |
| `APP_MEM_LIMIT` | потолок памяти контейнера приложения (по умолчанию `512m`) |
| `LOGIN_RATE_LIMIT` | попыток входа в минуту с одного IP (по умолчанию 10) |

### 4. Проверить сервер

```bash
./scripts/check-vps.sh
```

Скрипт проверит Docker и compose, свободны ли порты 80/443, хватает ли RAM и диска,
указывает ли `DOMAIN` на IP этого сервера и заполнен ли `.env`. В конце — список, что исправить.

### 5. Доступ к образу в GHCR

Вариант А — сделать пакет публичным (один раз, тогда логин на сервере не нужен):
GitHub → профиль → **Packages** → `cisbanka` → **Package settings** → **Change visibility** → Public.

Вариант Б — оставить приватным и залогиниться на сервере. Создайте на GitHub
(Settings → Developer settings → Personal access tokens → Tokens (classic)) токен только с правом `read:packages`:

```bash
echo "ВАШ_ТОКЕН" | docker login ghcr.io -u banochka01 --password-stdin
```

### 6. Запустить

```bash
docker compose pull
docker compose up -d
```

Поднимутся два контейнера: `app` (Node.js, SQLite) и `caddy` (HTTPS, сертификат Let's Encrypt выпускается сам).
Caddy стартует после того, как `app` прошёл healthcheck (`GET /api/health`). Проверка:

```bash
docker compose ps
curl -s https://cisbanka.example.ru/api/health
```

Откройте `https://ваш-домен`, нажмите «Войти» → «Регистрация учителя» и введите `ADMIN_INVITE_CODE`.

База и бэкапы лежат в docker-томе `cisbanka-data` (`/data` в контейнере), сертификаты — в томе `caddy-data`.
У контейнеров есть потолок памяти (`app` — 512 МБ, `caddy` — 128 МБ) и ротация логов (3 × 10 МБ),
чтобы не мешать соседним сервисам.

### 7. Обновить

После пуша в `main` дождитесь зелёного CI (джоб `publish`), затем на сервере:

```bash
cd CisBanka
./scripts/backup.sh              # на всякий случай
git pull                         # если менялись compose/Caddyfile/скрипты
docker compose pull
docker compose up -d
docker image prune -f            # удалить старые образы
```

Схема базы мигрирует автоматически при старте. Откат на прошлую версию: `CISBANKA_TAG=sha-<коммит>` в `.env`,
затем `docker compose up -d`.

### Сборка на самом сервере (без GHCR)

Если сервер мощный или нужен свой форк: без `COMPOSE_FILE` в `.env` используется `docker-compose.yml`,
который собирает образ локально — `docker compose up -d --build`.

## Если порты 80/443 уже заняты (nginx или другой сервис)

Caddy не нужен — запускайте только приложение, оно слушает `127.0.0.1:${APP_PORT}` (по умолчанию 3000):

```bash
docker compose up -d app
```

И добавьте сайт в существующий прокси. Пример для nginx (`/etc/nginx/sites-available/cisbanka`):

```nginx
server {
    listen 80;
    server_name cisbanka.example.ru;

    client_max_body_size 6m;   # проект до 5 МБ

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cisbanka /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cisbanka.example.ru    # HTTPS для nginx
```

Важно передавать `X-Forwarded-For` (на нём работает ограничение попыток входа) и `X-Forwarded-Proto`
(без него cookie сессии не получит флаг `Secure`). Если порт 3000 на хосте занят, поменяйте `APP_PORT` в `.env`
и в `proxy_pass`. Для Traefik/HAProxy и т.п. — то же самое: проксировать на `127.0.0.1:APP_PORT`.

## Бэкап SQLite

`scripts/backup.sh` делает онлайн-копию базы (без остановки сервиса) в томе (`/data/backups`) и копирует её на хост в `./backups`.
Хранятся последние 7 копий (переменная `KEEP`).

```bash
./scripts/backup.sh
```

Ежедневно в 03:30 через cron (`crontab -e`), путь замените на свой:

```cron
30 3 * * * cd /home/ubuntu/CisBanka && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Копию с хоста стоит регулярно уносить на другую машину (например `rsync` или `rclone` в облако).

### Восстановление из бэкапа

```bash
docker compose stop app
docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" --entrypoint sh app \
  -c "cp /restore/cisbanka-ГГГГ-ММ-ДД-….db /data/cisbanka.db && rm -f /data/cisbanka.db-wal /data/cisbanka.db-shm"
docker compose start app
```

## Проверка «с нуля»

GitHub Actions (`.github/workflows/ci.yml`) на каждом пуше на чистой Ubuntu:
тесты и сборка, затем `docker compose up -d --build`, ожидание healthcheck, запросы через Caddy по HTTPS,
регистрация учителя, бэкап и перезапуск с проверкой, что данные сохранились.
