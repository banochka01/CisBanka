#!/usr/bin/env bash
# Образы для эксперимента «Linux-хост» (v86): BIOS и готовый Buildroot-образ из проекта v86.
# Кладутся в web/public/v86/ (в git не хранятся), проверяются по sha256.
set -euo pipefail
cd "$(dirname "$0")/../web/public"
mkdir -p v86 && cd v86
fetch() {
  local name="$1" url="$2" sum="$3"
  if [ ! -f "$name" ] || ! echo "$sum  $name" | sha256sum -c --status; then
    curl -fsSL -o "$name" "$url"
  fi
  echo "$sum  $name" | sha256sum -c
}
fetch seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin 73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98
fetch vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880
fetch buildroot-bzimage68.bin https://i.copy.sh/buildroot-bzimage68.bin 507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c
