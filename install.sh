#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/oxo-foxxo/youtube-downloader.git"
ARCHIVE_URL="https://github.com/oxo-foxxo/youtube-downloader/archive/refs/heads/main.zip"
DOCKER_MAC_ARM64_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
DOCKER_MAC_AMD64_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
INSTALL_DIR="${VIDEORIX_DIR:-$HOME/Videorix}"
MANAGED_MARKER="$INSTALL_DIR/.videorix-managed"
TEMP_DIR=""
DOCKER_MOUNT_POINT=""

step() {
  printf '\n\033[1;32mVideorix:\033[0m %s\n' "$1"
}

fail() {
  printf '\nVideorix: %s\n' "$1" >&2
  exit 1
}

ensure_temp_dir() {
  if [[ -z "$TEMP_DIR" ]]; then
    TEMP_DIR="$(mktemp -d)"
  fi
}

cleanup() {
  if [[ -n "$DOCKER_MOUNT_POINT" && -d "$DOCKER_MOUNT_POINT" ]]; then
    hdiutil detach "$DOCKER_MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

refresh_docker_path() {
  export PATH="$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
  hash -r
}

confirm_docker_install() {
  printf '\nDocker Desktop не найден.\n'
  printf 'Videorix скачает официальный установщик Docker и запросит пароль macOS.\n'
  printf 'Условия Docker вы примете самостоятельно при первом запуске приложения.\n'
  printf 'Лицензия: https://docs.docker.com/subscription-billing/desktop-license/\n'
  local answer
  if [[ -r /dev/tty ]]; then
    read -r -p "Скачать и установить Docker Desktop? [y/N] " answer </dev/tty
  else
    fail "Для установки Docker нужен интерактивный терминал."
  fi
  [[ "$answer" =~ ^[YyДд]$ ]] || fail "Установка отменена."
}

install_docker_desktop() {
  [[ "$(uname -s)" == "Darwin" ]] ||
    fail "Автоматическая установка Docker поддерживается этим скриптом только на macOS."
  confirm_docker_install
  ensure_temp_dir

  local architecture
  local download_url
  architecture="$(uname -m)"
  case "$architecture" in
    arm64) download_url="$DOCKER_MAC_ARM64_URL" ;;
    x86_64) download_url="$DOCKER_MAC_AMD64_URL" ;;
    *) fail "Архитектура $architecture не поддерживается Docker Desktop." ;;
  esac

  local dmg="$TEMP_DIR/Docker.dmg"
  step "Скачиваю Docker Desktop с desktop.docker.com"
  curl -fL --retry 3 --connect-timeout 15 "$download_url" -o "$dmg"

  step "Проверяю цифровую подпись Docker"
  local mount_output
  mount_output="$(hdiutil attach -nobrowse -readonly "$dmg")"
  DOCKER_MOUNT_POINT="$(
    printf '%s\n' "$mount_output" |
      sed -n 's|^.*\(/Volumes/.*\)$|\1|p' |
      tail -n 1
  )"
  [[ -d "$DOCKER_MOUNT_POINT/Docker.app" ]] || fail "Не удалось подключить официальный образ Docker."
  codesign --verify --deep --strict "$DOCKER_MOUNT_POINT/Docker.app" >/dev/null 2>&1 ||
    fail "Цифровая подпись Docker Desktop недействительна."
  spctl --assess --type execute "$DOCKER_MOUNT_POINT/Docker.app" >/dev/null 2>&1 ||
    fail "macOS не доверяет загруженному Docker Desktop."

  step "Устанавливаю Docker Desktop"
  sudo "$DOCKER_MOUNT_POINT/Docker.app/Contents/MacOS/install"
  hdiutil detach "$DOCKER_MOUNT_POINT" -quiet
  DOCKER_MOUNT_POINT=""
  refresh_docker_path
  command -v docker >/dev/null 2>&1 || fail "Docker установлен, но его CLI не найден."
}

start_docker_desktop() {
  if docker info >/dev/null 2>&1; then
    return
  fi
  [[ "$(uname -s)" == "Darwin" ]] && [[ -d "/Applications/Docker.app" ]] ||
    fail "Docker установлен, но Docker Desktop не найден."

  step "Запускаю Docker Desktop"
  open -g -a Docker
  printf 'Если Docker покажет лицензионное соглашение, прочитайте и примите его в окне приложения.\n'
  for _ in {1..300}; do
    docker info >/dev/null 2>&1 && return
    sleep 2
  done
  fail "Docker Desktop не запустился за 10 минут. Завершите настройку Docker и повторите команду."
}

install_from_archive() {
  ensure_temp_dir
  local archive="$TEMP_DIR/videorix.zip"
  local extracted="$TEMP_DIR/extracted"
  local source="$extracted/youtube-downloader-main"

  step "Скачиваю актуальную версию Videorix"
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
  if [[ ! -f "$MANAGED_MARKER" ]] &&
    [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail "$INSTALL_DIR уже содержит другие файлы. Задайте другую папку через VIDEORIX_DIR."
  fi

  if [[ -f "$MANAGED_MARKER" ]]; then
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
      ! -name '.env' ! -name '.videorix-managed' -exec rm -rf -- {} +
  fi
  cp -R "$source"/. "$INSTALL_DIR"/
  printf '%s\n' "$REPOSITORY_URL" >"$MANAGED_MARKER"
}

case "$INSTALL_DIR" in
  "" | "/" | "$HOME") fail "Небезопасная папка установки: $INSTALL_DIR" ;;
esac

command -v curl >/dev/null 2>&1 || fail "Не найден curl. Установите его и повторите команду."
refresh_docker_path
if ! command -v docker >/dev/null 2>&1; then
  install_docker_desktop
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 недоступен. Обновите Docker Desktop."
start_docker_desktop

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
  APP_URL_PORT="$(
    sed -nE \
      's/^[[:space:]]*APP_PORT[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' \
      .env |
      tail -n 1
  )"
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
