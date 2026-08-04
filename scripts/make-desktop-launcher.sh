#!/bin/bash
# Recreate the ORCHESTRA desktop launcher (Desktop/ORCHESTRA.app) with the
# custom icon. Double-clicking it starts the daemon (if down) and opens the
# dashboard. Run from the repo root.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/ORCHESTRA.app"
rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"$REPO/scripts/launch-orchestra.sh\""
cp "$REPO/assets/orchestra.icns" "$APP/Contents/Resources/applet.icns"
touch "$APP" "$APP/Contents/Resources/applet.icns"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "Created $APP"
