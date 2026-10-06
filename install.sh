#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/oxo-foxxo/youtube-downloader.git"
ARCHIVE_URL="https://github.com/oxo-foxxo/youtube-downloader/archive/refs/heads/main.zip"
INSTALL_DIR="${VIDEORIX_DIR:-$HOME/Videorix}"
MANAGED_MARKER="$INSTALL_DIR/.videorix-managed"
TEMP_DIR=""

step() {
  printf '\n\033[1;32mVideorix:\033[0m %s\n' "$1"
}

fail() {
  printf '\nVideorix: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

case "$INSTALL_DIR" in
  "" | "/" | "$HOME") fail "Небезопасная папка установки: $INSTALL_DIR" ;;
esac

command -v curl >/dev/null 2>&1 || fail "Не найден curl. Установите его и повторите команду."
command -v docker >/dev/null 2>&1 || fail "Сначала установите Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 недоступен. Обновите Docker Desktop."

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "/Applications/Docker.app" ]]; then
    step "Запускаю Docker Desktop"
    open -g -a Docker
    for _ in {1..60}; do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
fi
docker info >/dev/null 2>&1 || fail "Docker Desktop не запущен. Запустите его и повторите команду."

install_from_archive() {
  TEMP_DIR="$(mktemp -d)"
  local archive="$TEMP_DIR/videorix.zip"
  local extracted="$TEMP_DIR/extracted"
  local source="$extracted/youtube-downloader-main"

  step "Скачиваю актуальную версию"
  curl -fL --retry 3 --connect-timeout 15 "$ARCHIVE_URL" -o "$archive"
  mkdir -p "$extracted"
  if command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$archive" "$extracted"
  elif command -v unzip >/dev/null 2>&1; then
    unzip -q "$archive" -d "$extracted"
  else
    fail "Не найден распаковщик ZIP."
  fi
  [[ -f "$source/docker-compose.yml" ]] || fail "Архив Videorix имеет неверную структуру."

  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR уже существует и не является папкой."
  fi
  mkdir -p "$INSTALL_DIR"
  if [[ ! -f "$MANAGED_MARKER" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail "$INSTALL_DIR уже содержит другие файлы. Задайте другую папку через VIDEORIX_DIR."
  fi

  if [[ -f "$MANAGED_MARKER" ]]; then
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
      ! -name '.env' ! -name '.videorix-managed' -exec rm -rf -- {} +
  fi
  cp -R "$source"/. "$INSTALL_DIR"/
  printf '%s\n' "$REPOSITORY_URL" > "$MANAGED_MARKER"
}

if [[ -d "$INSTALL_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
  step "Обновляю существующую установку"
  if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only origin main
  else
    step "Найдены локальные изменения — запускаю текущую версию без обновления"
  fi
else
  install_from_archive
fi

cd "$INSTALL_DIR"
step "Собираю и запускаю контейнеры"
docker compose up -d --build

APP_URL_PORT="${APP_PORT:-}"
if [[ -z "$APP_URL_PORT" && -f .env ]]; then
  APP_URL_PORT="$(sed -nE 's/^[[:space:]]*APP_PORT[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' .env | tail -n 1)"
fi
APP_URL_PORT="${APP_URL_PORT:-8080}"
APP_URL="http://localhost:$APP_URL_PORT"

step "Жду готовности сервиса"
ready=false
for _ in {1..90}; do
  if curl -fsS "$APP_URL/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "$ready" != true ]]; then
  docker compose ps
  docker compose logs --tail=80 app
  fail "Сервис не запустился. Диагностика показана выше."
fi

step "Готово: $APP_URL"
if [[ "${VIDEORIX_NO_OPEN:-0}" != "1" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open "$APP_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL" >/dev/null 2>&1 || true
  fi
fi
