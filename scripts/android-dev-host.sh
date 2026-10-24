#!/bin/sh
# Points a React Native debug app on an emulator at the run's own Metro, then starts it:
# android-dev-host.sh <serial> <application id> <metro port>. The emulator reaches the Mac as 10.0.2.2, so
# `adb reverse` can't map another port onto 8081; React Native reads the debug_http_host preference instead.
set -eu
serial="$1" app="$2" port="$3"
adb="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"
[ -x "$adb" ] || adb=adb
"$adb" -s "$serial" shell am force-stop "$app"
"$adb" -s "$serial" shell "run-as $app sh -c 'mkdir -p shared_prefs && echo \"<map><string name=\\\"debug_http_host\\\">10.0.2.2:$port</string></map>\" > shared_prefs/${app}_preferences.xml'"
"$adb" -s "$serial" shell monkey -p "$app" -c android.intent.category.LAUNCHER 1 >/dev/null
