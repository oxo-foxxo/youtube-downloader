#!/bin/sh
set -eu
umask 077
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 1
done
openbox >/dev/null 2>&1 &
x11vnc -display :99 -localhost -nopw -forever -shared -rfbport 5900 -quiet >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &
python3 /app/scripts/session-browser.py &
server_pid=$!
trap 'kill -TERM "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; kill "$xvfb_pid" 2>/dev/null || true' TERM INT EXIT
wait "$server_pid"
