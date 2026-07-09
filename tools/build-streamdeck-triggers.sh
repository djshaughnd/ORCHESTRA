#!/usr/bin/env bash
# Build silent macOS trigger apps for the Elgato Stream Deck (plugin-free).
#
# Each app runs one curl against the ORCHESTRA daemon and quits invisibly, so
# a Stream Deck key can fire it via the built-in "System > Open" action — no
# Companion, no third-party plugin, no browser. Re-run any time; it overwrites.
#
# Usage: tools/build-streamdeck-triggers.sh [OUT_DIR]
#   OUT_DIR defaults to ~/Documents/ORCHESTRA-StreamDeck
set -euo pipefail

OUT="${1:-$HOME/Documents/ORCHESTRA-StreamDeck}"
BASE="http://127.0.0.1:8722"
mkdir -p "$OUT"

# name|curl args (single-quoted where needed). Each becomes "<name>.app".
build() {
  local name="$1" ; shift
  local cmd="$*"
  local app="$OUT/$name.app"
  rm -rf "$app"
  # do shell script runs silently; no Terminal window, no dock persistence.
  osacompile -o "$app" -e "do shell script \"$cmd\"" 2>/dev/null
  echo "  built $name.app"
}

echo "Building Stream Deck triggers into: $OUT"
# GO = session + record + BEAT-REACTIVE cutting (fast, music-driven). REEL below
# runs the fixed scripted mixingReel instead, as a deterministic fallback.
build "GO"        "curl -sS -X POST $BASE/go -H 'Content-Type: application/json' -d '{\\\"profile\\\":\\\"dj\\\",\\\"reactive\\\":true}'"
build "MARK"      "curl -sS -X POST $BASE/session/mark -H 'Content-Type: application/json' -d '{\\\"label\\\":\\\"mark\\\"}'"
build "END"       "curl -sS -X POST $BASE/session/end"
build "CAM1-HERO" "curl -sS -X POST $BASE/cut/1"
build "CAM2-OVER" "curl -sS -X POST $BASE/cut/2"
build "REEL"      "curl -sS -X POST $BASE/profile/dj; curl -sS -X POST $BASE/sequence/mixingReel/run"
build "KILL"      "curl -sS -X POST $BASE/auto/disarm"

echo "Done. In the Elgato Stream Deck app, drag 'System > Open' onto a key and"
echo "point it at the matching .app in $OUT (e.g. GO.app for your GO button)."
