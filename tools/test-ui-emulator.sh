#!/usr/bin/env bash
# UI smoke test of the watch app in the Pebble emulator, driven by the canned PebbleKit JS
# fixture (src/pkjs/ui-fixture.js).
#
#   tools/test-ui-emulator.sh [platform]      # default: basalt (aplite basalt chalk diorite emery)
#
# Builds with PKJS_ENTRY=src/pkjs/ui-fixture.js, installs on the emulator, writes screenshots to
# test/ui-out/<platform>-{1-initial,2-down2,3-select,4-down5,5-anim-N,6-end,7-refresh,8-heading90,
# 9-heading90-dropoff}.png (notification and other scenes: tools/screenshots.sh), checks the
# phone-side logs for 'UI-FIXTURE select <listId> 2' (SELECT on the 3rd row) and 'UI-FIXTURE refresh'
# (long SELECT, done as a 1.2 s press with `pebble emu-button click select --duration 1200`), then kills
# the emulator. 5-anim-N are frames grabbed while UP is held (`emu-button push`) from the list end: the
# repeats keep retargeting the scroll animation, so the wheel is caught between rows; 6-end: list end.
# Emulator/pypkjs state is isolated under test/ui-out/.state. Exits non-zero on failure.
# Re-runs itself inside nix-shell when `pebble` is not on PATH.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pebble >/dev/null 2>&1; then
  exec nix-shell "$ROOT/shell.nix" --run "bash $(printf '%q' "${BASH_SOURCE[0]}") $*"
fi

P="${1:-basalt}"
OUT="$ROOT/test/ui-out"
STATE="$OUT/.state"
LOG="$STATE/$P-logs.txt"
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
mkdir -p "$OUT" "$STATE/xdg/pebble-sdk" "$STATE/tmp"
# Share the installed SDKs (read-only use) but keep emulator/pypkjs state private.
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME="$STATE/xdg" TMPDIR="$STATE/tmp"
cd "$ROOT" || exit 1

fail=0
LOGS_PID=""
note() { echo "[ui-test $P] $*"; }
bad() { echo "[ui-test $P] FAIL: $*" >&2; fail=1; }

cleanup() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  pebble kill >/dev/null 2>&1
  # anything still running from our isolated state dir
  for sig in TERM KILL; do
    for pid in $(ps -eo pid,args | grep -E '[q]emu-pebble|[p]ypkjs' | grep -F "$STATE/" | awk '{print $1}'); do
      kill -s "$sig" "$pid" 2>/dev/null
    done
    sleep 1
  done
  # the fixture bundle must never be mistaken for the real app: waf does not track PKJS_ENTRY
  pebble clean >/dev/null 2>&1
}
trap cleanup EXIT

[ -f src/pkjs/ui-fixture.js ] || { bad "src/pkjs/ui-fixture.js is missing"; exit 1; }

note "building with ui-fixture.js"
pebble clean >/dev/null 2>&1
if ! PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build >"$STATE/build.log" 2>&1; then
  tail -30 "$STATE/build.log" >&2
  bad "pebble build failed (see $STATE/build.log)"
  exit 1
fi
PBW="$STATE/bus-watch-ui-fixture.pbw"
cp build/bus-watch.pbw "$PBW"

cleanup  # start from a fresh emulator
# The fixture's times are relative to its FIXED_NOW: pin the emulator clock to it (also makes its wakeup fire).
FIXED_NOW=$(sed -n 's/^var FIXED_NOW = \([0-9]*\);.*/\1/p' src/pkjs/ui-fixture.js)
timeout 120 pebble emu-set-time --emulator "$P" "$FIXED_NOW" >/dev/null 2>&1 || bad "emu-set-time"
note "installing on emulator"
if ! timeout 120 pebble install --emulator "$P" "$PBW" >"$STATE/$P-install.log" 2>&1; then
  cat "$STATE/$P-install.log" >&2
  bad "install failed"
  exit 1
fi

: >"$LOG"
pebble logs --emulator "$P" >"$LOG" 2>&1 &
LOGS_PID=$!

wait_log() {  # wait_log PATTERN SECONDS
  local i
  for ((i = 0; i < $2; i++)); do
    grep -q -- "$1" "$LOG" && return 0
    sleep 1
  done
  return 1
}

shot() {  # shot NAME
  local f="$OUT/$P-$1.png" try
  for try in 1 2 3; do
    rm -f "$f"
    timeout 30 pebble screenshot --no-open --emulator "$P" "$f" >/dev/null 2>&1
    [ -s "$f" ] && { note "screenshot $f"; return 0; }
    sleep 2
  done
  bad "screenshot $1 failed"
}

btn() { timeout 20 pebble emu-button --emulator "$P" "$@" >/dev/null 2>&1 || bad "emu-button $*"; sleep 1; }

# 'ready' fires when the app opens; the list should follow. If the logs connected too late to see
# 'ready', relaunching is not needed: just give the list a moment to arrive.
wait_log 'UI-FIXTURE ready' 20 || note "did not see 'UI-FIXTURE ready' in logs (continuing)"
sleep 4
shot 1-initial

btn click down
btn click down
shot 2-down2

btn click select
shot 3-select
wait_log 'UI-FIXTURE select [0-9]* 2' 10 || bad "no 'UI-FIXTURE select <listId> 2' in logs"

btn click down
btn click down
btn click down
shot 4-down5

# Hold DOWN to the end of the list (6-end), then hold UP for the mid-animation frames (5-anim-N).
timeout 20 pebble emu-button --emulator "$P" push down >/dev/null 2>&1 || bad "emu-button push down"
sleep 2
timeout 20 pebble emu-button --emulator "$P" release down >/dev/null 2>&1 || bad "emu-button release down"
sleep 1
shot 6-end
# `pebble screenshot` takes seconds, far longer than a scroll, so mid-animation frames come straight from
# QEMU's monitor (`screendump`, instant) while UP is held from the list end. The monitor port is in the
# pebble tool's emulator metadata ($TMPDIR/pb-emulator.json). Frames are deduplicated; up to 4 distinct
# ones are kept as <platform>-5-anim-<n>.png (QEMU's 2 px display border cropped).
rm -f "$OUT/$P"-5-anim*.png "$STATE"/frame-*.ppm
MON=$(jq -r --arg p "$P" '.[$p] | to_entries[] | .value.qemu.monitor // empty' "$TMPDIR/pb-emulator.json" 2>/dev/null | head -1)
timeout 20 pebble emu-button --emulator "$P" push up >/dev/null 2>&1 || bad "emu-button push up"
if [ -n "$MON" ] && exec 3<>"/dev/tcp/127.0.0.1/$MON"; then
  for i in $(seq -w 1 16); do printf 'screendump %s\n' "$STATE/frame-$i.ppm" >&3; sleep 0.1; done
  sleep 0.5
  exec 3>&-
else
  bad "QEMU monitor port not found"
fi
timeout 20 pebble emu-button --emulator "$P" release up >/dev/null 2>&1 || bad "emu-button release up"
python3 - "$STATE" "$OUT/$P-5-anim" <<'PY' | while read -r f; do note "screenshot $f"; done
import glob, hashlib, sys
from PIL import Image
state, prefix = sys.argv[1], sys.argv[2]
seen, frames = set(), []
for path in sorted(glob.glob(state + '/frame-*.ppm')):
    try:
        im = Image.open(path).convert('RGB')
    except Exception:
        continue
    im = im.crop((2, 2, im.width - 2, im.height - 2))
    h = hashlib.md5(im.tobytes()).hexdigest()
    if h not in seen:
        seen.add(h)
        frames.append(im)
# the first and last distinct frames are usually at rest; prefer the ones in between
mid = frames[1:-1] or frames
for n, im in enumerate(mid[:4], 1):
    out = '%s-%d.png' % (prefix, n)
    im.save(out)
    print(out)
PY
ls "$OUT/$P"-5-anim-*.png >/dev/null 2>&1 || bad "no mid-animation frames captured"
sleep 1

btn click select --duration 1200
wait_log 'UI-FIXTURE refresh' 10 || bad "no 'UI-FIXTURE refresh' in logs after long SELECT"
sleep 3
shot 7-refresh

# Compass: back to the top (two-lane tile), then face east -> every arrow turns 90 degrees anticlockwise.
timeout 20 pebble emu-button --emulator "$P" push up >/dev/null 2>&1 || bad "emu-button push up"
sleep 2
timeout 20 pebble emu-button --emulator "$P" release up >/dev/null 2>&1 || bad "emu-button release up"
sleep 1
timeout 20 pebble emu-compass --emulator "$P" --calibrated --heading 90 >/dev/null 2>&1 || bad "emu-compass"
sleep 2
shot 8-heading90
btn click down
shot 9-heading90-dropoff
timeout 20 pebble emu-compass --emulator "$P" --calibrated --heading 0 >/dev/null 2>&1 || bad "emu-compass"


# Wakeups: the fixture sent cookies 3, 1, 2 (1 at ready + 70 s); the watch schedules them sorted and reports
# cookie 1 as {WAKEUP_FIRED: 1} when it fires while the app runs.
grep -q 'wakeup scheduled: cookie 1' "$LOG" || note "'wakeup scheduled' not in logs (sent before the log stream connected)"
wait_log 'UI-FIXTURE wakeup 1' 90 || bad "no 'UI-FIXTURE wakeup 1' in logs (wakeup not fired / not reported)"

grep -E 'UI-FIXTURE|wakeup|rror' "$LOG" | sed "s/^/[ui-test $P] log: /"
if [ "$fail" = 0 ]; then note "PASS"; else note "FAILED"; fi
exit "$fail"
