#!/bin/sh
# A run's own Android emulator: avd-clone.sh <template> <name> makes AVD <name> as an APFS clone of <template> (no
# extra disk until the emulator writes), without the template's locks and last launch, rendering on the GPU.
# avd-clone.sh --remove <name> deletes it. AVDs live in $ANDROID_AVD_HOME (default ~/.android/avd).
set -eu
home="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
if [ "$1" = --remove ]; then rm -rf "$home/$2.avd" "$home/$2.ini"; exit 0; fi
t="$1" n="$2"
[ -d "$home/$t.avd" ] && [ -f "$home/$t.ini" ] || { echo "no AVD $t in $home" >&2; exit 1; }
rm -rf "$home/$n.avd" "$home/$n.ini"
cp -c -R "$home/$t.avd" "$home/$n.avd" 2>/dev/null || cp -R "$home/$t.avd" "$home/$n.avd"
rm -rf "$home/$n.avd"/*.lock "$home/$n.avd/emu-launch-params.txt"
cfg="$home/$n.avd/config.ini"
grep -v -e '^AvdId=' -e '^avd.ini.displayname=' -e '^hw.gpu.mode=' -e '^hw.gpu.enabled=' "$cfg" > "$cfg.new" || true
printf 'AvdId=%s\navd.ini.displayname=%s\nhw.gpu.mode=host\nhw.gpu.enabled=yes\n' "$n" "$n" >> "$cfg.new"
mv "$cfg.new" "$cfg"
sed -e "s|^path=.*|path=$home/$n.avd|" -e "s|^path.rel=.*|path.rel=avd/$n.avd|" "$home/$t.ini" > "$home/$n.ini"
echo "emulator AVD $n"
