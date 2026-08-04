#!/bin/bash
# Launch the ORCHESTRA daemon (if not already running) and open its dashboard.
# Used by the desktop launcher app (Desktop/ORCHESTRA.app).
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$HOME/Documents/GitHub/ORCHESTRA" || exit 1
if ! curl -s -m 2 http://127.0.0.1:8722/status >/dev/null 2>&1; then
  nohup npm start > logs/daemon-console.log 2>&1 &
  for i in $(seq 1 15); do
    curl -s -m 1 http://127.0.0.1:8722/status >/dev/null 2>&1 && break
    sleep 1
  done
fi
open "http://127.0.0.1:8722/"
