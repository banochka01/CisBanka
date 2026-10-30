#!/bin/sh
# Бэкап базы CisBanka: онлайн-копия SQLite внутри тома (/data/backups) и копия на хост (./backups).
# Хранится последние KEEP копий (по умолчанию 7). Пример cron — в README.
set -eu
cd "$(dirname "$0")/.."
KEEP="${KEEP:-7}"

docker compose exec -T app node server/backup.js --keep "$KEEP" --dir /data/backups
mkdir -p backups
docker compose cp app:/data/backups/. backups/
# ротация копий на хосте
ls -1t backups/cisbanka-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
echo "Копии на хосте: $(ls backups/cisbanka-*.db | wc -l) шт. в $(pwd)/backups"
