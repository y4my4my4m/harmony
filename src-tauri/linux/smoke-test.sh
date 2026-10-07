#!/bin/sh
# Starts Harmony on a private Xvfb display and session bus with a throwaway
# profile, then fails when the app exits early, logs a Chromium FATAL, or its main
# thread is busier than SMOKE_MAX_CPU percent of a core (default 15) over the 20 s
# after a 30 s startup. SMOKE_SANDBOX=on|off also fails when Chromium's sandbox
# state differs.
#
# Usage: smoke-test.sh <Harmony_x.y.z_amd64.AppImage | /usr/bin/harmony>
# Needs: xvfb-run (xvfb, xauth), dbus-run-session (dbus).
set -eu

app=$1
max_cpu=${SMOKE_MAX_CPU:-15}

if [ -z "${SMOKE_INNER:-}" ]; then
  exec env SMOKE_INNER=1 xvfb-run -a -s '-screen 0 1920x1080x24' \
    dbus-run-session -- sh "$0" "$app"
fi

work=$(mktemp -d)
export HOME="$work/home" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" \
  XDG_DATA_HOME="$work/data" XDG_STATE_HOME="$work/state"
mkdir -p "$HOME"

# uruntime falls back to extracting itself when FUSE is unavailable; forcing it
# keeps CI runners and containers on one path. It extracts under TMPDIR.
case "$app" in
  *.AppImage)
    mkdir -p "$work/tmp"
    TMPDIR="$work/tmp" APPIMAGE_EXTRACT_AND_RUN=1 "$(realpath "$app")" >"$work/app.log" 2>&1 & ;;
  *) "$app" >"$work/app.log" 2>&1 & ;;
esac
launcher=$!

# Every process started under the launcher, launcher first.
tree() {
  ps -eo pid=,ppid= | awk -v root="$launcher" '
    { parent[$1] = $2 }
    END {
      list[root] = 1; out = root; changed = 1
      while (changed) {
        changed = 0
        for (p in parent) if (!(p in list) && (parent[p] in list)) { list[p] = 1; out = out " " p; changed = 1 }
      }
      print out
    }'
}

cleanup() {
  for pid in $(tree); do kill "$pid" 2>/dev/null || true; done
  sleep 2
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "smoke test FAILED: $*"
  echo "--- app log (last 40 lines)"
  tail -n 40 "$work/app.log"
  exit 1
}

sleep 30
kill -0 "$launcher" 2>/dev/null || fail "$app exited during startup"

# The browser process: the first descendant that is not a Chromium child (--type=).
main=
for pid in $(tree); do
  args=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  case "$args" in
    *--type=*) ;;
    */bin/harmony*) main=$pid; break ;;
  esac
done
[ -n "$main" ] || fail "no harmony browser process under the launcher"

# utime + stime of the main thread, in clock ticks (fields 14 and 15).
ticks() { sed 's/^.*) //' "/proc/$main/task/$main/stat" | awk '{ print $12 + $13 }'; }
hz=$(getconf CLK_TCK)
before=$(ticks)
sleep 20
after=$(ticks)
cpu=$(awk -v a="$after" -v b="$before" -v hz="$hz" 'BEGIN { printf "%.1f", (a - b) * 100 / (20 * hz) }')

# CEF hands --no-sandbox to every child when the sandbox is off.
sandbox=on
for pid in $(tree); do
  case "$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)" in
    *--type=*--no-sandbox* | *--no-sandbox*--type=*) sandbox=off ;;
  esac
done

echo "browser process $main: $(tr '\0' ' ' <"/proc/$main/cmdline" | cut -c1-120)"
echo "main thread: ${cpu}% of one core over 20 s (limit ${max_cpu}%)"
echo "sandbox: $sandbox"
grep -h "running without Chromium's sandbox" "$work/app.log" || true
if grep -q FATAL "$work/app.log"; then fail "Chromium logged FATAL"; fi
awk -v c="$cpu" -v m="$max_cpu" 'BEGIN { exit !(c <= m) }' || fail "main thread is not idle"
[ -z "${SMOKE_SANDBOX:-}" ] || [ "$SMOKE_SANDBOX" = "$sandbox" ] ||
  fail "sandbox is $sandbox, expected $SMOKE_SANDBOX"
echo "smoke test passed"
