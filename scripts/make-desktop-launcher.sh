#!/bin/bash
# Recreate the ORCHESTRA desktop launcher (Desktop/ORCHESTRA.app).
# Double-click = open OBS if needed + start daemon if down + open dashboard.
# Sets the custom icon via NSWorkspace (the method that actually sticks).
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/ORCHESTRA.app"
rm -rf "$APP"
# detached so the applet exits immediately and can never show an error dialog
osacompile -o "$APP" -e "do shell script \"nohup $REPO/scripts/launch-orchestra.sh >/dev/null 2>&1 &\""
cp "$REPO/assets/orchestra.icns" "$APP/Contents/Resources/applet.icns"
osascript <<OSA
use framework "AppKit"
set img to current application's NSImage's alloc()'s initWithContentsOfFile:"$REPO/assets/orchestra-icon.png"
(current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:"$APP" options:0)
OSA
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Created $APP (custom icon set). If Finder still shows a generic icon, restart Finder: killall Finder"
