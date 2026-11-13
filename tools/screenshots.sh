#!/usr/bin/env bash
# Visual regression screenshots of the watch app in the Pebble emulator, driven by src/pkjs/ui-fixture.js.
#
#   tools/screenshots.sh [--update] [--threshold F] [platform...]   # default platforms: aplite basalt chalk diorite emery
#
# Builds the fixture app (PKJS_ENTRY=src/pkjs/ui-fixture.js, after `pebble clean`), then per platform walks the fixed
# SCENES below and saves test/screenshots/current/<platform>/<scene>.png (with --update: test/screenshots/baseline/...).
# Without --update the images are then compared with the baseline (tools/lib/png-diff.js): diff images go to
# test/screenshots/diff/, a table is printed, and the exit status is non-zero when any image differs by more than
# F (fraction of pixels, default 0.001) or is missing.
#
# Determinism: the fixture's times are relative to its FIXED_NOW and the emulator clock is pinned to it
# (`pebble emu-set-time`) before every shot; the compass is set explicitly; the marquee and scroll animation are
# frozen through the watch's test hook (the fixture's STEPS, advanced by a long SELECT each), so no frame depends
# on when the screenshot happens to be taken.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pebble >/dev/null 2>&1; then
  exec nix-shell "$ROOT/shell.nix" --run "bash $(printf '%q' "${BASH_SOURCE[0]}") $(printf '%q ' "$@")"
fi

UPDATE=0
THRESHOLD=0.001
PLATFORMS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --threshold) THRESHOLD="$2"; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) PLATFORMS+=("$1") ;;
  esac
  shift
done
[ ${#PLATFORMS[@]} -gt 0 ] || PLATFORMS=(aplite basalt chalk diorite emery)

SHOTS="$ROOT/test/screenshots"
if [ "$UPDATE" = 1 ]; then DEST="$SHOTS/baseline"; else DEST="$SHOTS/current"; fi
STATE="$SHOTS/.state"
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
mkdir -p "$STATE/xdg/pebble-sdk" "$STATE/tmp"
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME="$STATE/xdg" TMPDIR="$STATE/tmp"
cd "$ROOT" || exit 1

FIXED_NOW=$(sed -n 's/^var FIXED_NOW = \([0-9]*\);.*/\1/p' src/pkjs/ui-fixture.js)
[ -n "$FIXED_NOW" ] || { echo "FIXED_NOW not found in src/pkjs/ui-fixture.js" >&2; exit 1; }

fail=0
P=""
LOGS_PID=""
LOG=""
note() { echo "[screenshots $P] $*"; }
bad() { echo "[screenshots $P] FAIL: $*" >&2; fail=1; }

kill_emulator() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  LOGS_PID=""
  pebble kill >/dev/null 2>&1
  for sig in TERM KILL; do
    for pid in $(ps -eo pid,args | grep -E '[q]emu-pebble|[p]ypkjs' | grep -F "$STATE/" | awk '{print $1}'); do
      kill -s "$sig" "$pid" 2>/dev/null
    done
    sleep 1
  done
}
trap 'kill_emulator; pebble clean >/dev/null 2>&1' EXIT

echo "[screenshots] building with ui-fixture.js"
pebble clean >/dev/null 2>&1
if ! PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build >"$STATE/build.log" 2>&1; then
  tail -30 "$STATE/build.log" >&2
  echo "[screenshots] pebble build failed (see $STATE/build.log)" >&2
  exit 1
fi
PBW="$STATE/bus-watch-ui-fixture.pbw"
cp build/bus-watch.pbw "$PBW"
pebble clean >/dev/null 2>&1  # the fixture bundle must never be mistaken for the real app

e() { timeout 30 pebble "$1" --emulator "$P" "${@:2}" >/dev/null 2>&1; }
btn() { e emu-button "$@" || bad "emu-button $*"; sleep 1; }
hold() { e emu-button push "$1" || bad "push $1"; sleep "$2"; e emu-button release "$1" || bad "release $1"; sleep 1; }
compass() { e emu-compass --calibrated --heading "$1" || bad "emu-compass $1"; sleep 1; }

wait_log() {  # wait_log PATTERN SECONDS
  local i
  for ((i = 0; i < $2; i++)); do
    grep -q -- "$1" "$LOG" && return 0
    sleep 1
  done
  return 1
}

STEP=0
next_step() {  # long SELECT -> REFRESH -> the fixture runs its next STEP
  STEP=$((STEP + 1))
  e emu-button click select --duration 1200 || bad "long select"
  wait_log "UI-FIXTURE step ${STEP}\b" 15 || bad "fixture step $STEP not seen in logs"
  sleep 2
}

shot() {  # shot NAME
  local f="$DEST/$P/$1.png" try
  e emu-set-time "$FIXED_NOW" || bad "emu-set-time"
  sleep 1
  for try in 1 2 3; do
    rm -f "$f"
    timeout 30 pebble screenshot --no-open --emulator "$P" "$f" >/dev/null 2>&1
    [ -s "$f" ] && { note "$1"; return 0; }
    sleep 2
  done
  bad "screenshot $1 failed"
}

# The scene list. Each next_step must match the fixture's STEPS order (src/pkjs/ui-fixture.js).
run_scenes() {
  next_step;            shot 01-top                # two-lane pickup selected, marquee at its start, heading 0
  next_step;            shot 02-marquee-mid
  next_step;            shot 03-marquee-end
  next_step
  compass 90;           shot 04-heading90
  compass 0
  btn click down;       shot 05-down1-dropoff      # drop-off tile selected
  btn click down;       shot 06-down2
  next_step;            shot 07-anim-mid           # wheel halfway between rows 2 and 3
  next_step
  btn click down; btn click down;  shot 08-two-lane
  btn click down; btn click down;  shot 09-long-title       # long stop + route names, neighbours cut with an ellipsis
  next_step;            shot 10-long-title-end
  next_step                                          # planned-trip legs pinned first
  hold up 3;            shot 11-trip-board
  btn click down;       shot 12-trip-riding
  next_step;            shot 13-notify
  btn click down; btn click down; btn click down;  shot 14-notify-scroll
  btn click back
  next_step;            shot 15-empty
}

for P in "${PLATFORMS[@]}"; do
  mkdir -p "$DEST/$P"
  rm -f "$DEST/$P"/*.png
  LOG="$STATE/$P-logs.txt"
  STEP=0
  kill_emulator
  note "starting emulator"
  e emu-set-time "$FIXED_NOW" || e emu-set-time "$FIXED_NOW" || bad "emu-set-time"
  compass 0
  if ! timeout 120 pebble install --emulator "$P" "$PBW" >"$STATE/$P-install.log" 2>&1; then
    cat "$STATE/$P-install.log" >&2
    bad "install failed"
    continue
  fi
  : >"$LOG"
  pebble logs --emulator "$P" >"$LOG" 2>&1 &
  LOGS_PID=$!
  sleep 6  # list + wakeups arrive
  run_scenes
  kill_emulator
done

P=""
if [ "$UPDATE" = 1 ]; then
  echo "[screenshots] baseline written to $DEST"
  exit "$fail"
fi
rm -rf "$SHOTS/diff"
sel=()
for P in "${PLATFORMS[@]}"; do sel+=("$P"); done
# compare only the platforms that ran
CMP_BASE="$STATE/cmp-baseline"; CMP_CUR="$STATE/cmp-current"
rm -rf "$CMP_BASE" "$CMP_CUR"; mkdir -p "$CMP_BASE" "$CMP_CUR"
for P in "${sel[@]}"; do
  [ -d "$SHOTS/baseline/$P" ] && cp -r "$SHOTS/baseline/$P" "$CMP_BASE/$P"
  [ -d "$DEST/$P" ] && cp -r "$DEST/$P" "$CMP_CUR/$P"
done
node tools/lib/png-diff.js compare "$CMP_BASE" "$CMP_CUR" "$SHOTS/diff" --threshold "$THRESHOLD" || fail=1
exit "$fail"
