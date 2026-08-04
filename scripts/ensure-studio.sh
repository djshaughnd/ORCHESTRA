#!/bin/bash
# Ensure the studio stack is up: OBS running + ORCHESTRA daemon responding.
# Silent, always exits 0. Shared by the desktop launcher and Stream Deck GO.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$HOME/Documents/GitHub/ORCHESTRA" 2>/dev/null || exit 0
pgrep -x OBS >/dev/null 2>&1 || open -a OBS >/dev/null 2>&1 || true
if ! curl -s -m 2 http://127.0.0.1:8722/status >/dev/null 2>&1; then
  nohup npm start >logs/daemon-console.log 2>&1 &
  for i in $(seq 1 25); do
    curl -s -m 1 http://127.0.0.1:8722/status >/dev/null 2>&1 && break
    sleep 1
  done
fi
exit 0
