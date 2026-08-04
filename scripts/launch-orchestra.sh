#!/bin/bash
# Desktop launcher: boot the studio (OBS + daemon) and open the dashboard.
"$HOME/Documents/GitHub/ORCHESTRA/scripts/ensure-studio.sh"
open "http://127.0.0.1:8722/" >/dev/null 2>&1 || true
exit 0
