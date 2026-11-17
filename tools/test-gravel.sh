#!/usr/bin/env bash
# Runs the real app through Gravel (https://github.com/jan-leila/gravel): a fresh Pebble emulator is attached as a
# watch to a DEBUG build of Gravel on an Android device or emulator (adb), and the .pbw is installed through Gravel's
# developer connection, so the phone side runs in Gravel's PebbleKit JS runtime, under Gravel's per-app permissions,
# against the live services (Metro Transit, Open-Meteo).
#
#   tools/test-gravel.sh [--expect waiting|answer|weather] [--permissions allow|default|deny] [--platform emery]
#                        [--mock-location LAT,LON] [--reset-settings] [--seconds N] [--serial ADB_SERIAL]
#                        [--update-waiting] [PBW]
#
# --expect says what has to be on the watch after at most N seconds (default 90):
#   waiting   the screen is still, pixel for pixel, the app's first one ("Waiting for phone",
#             test/gravel/<platform>-waiting.png). That is what Gravel's defaults have to give: a watchapp has neither
#             internet nor location until both are allowed, and on this script's usual target (an x86_64 Android
#             emulator) Gravel then does not start the phone side at all. (On arm64 phones it starts it with the
#             network blocked, so the watch may get as far as an error line there: not covered.)
#   answer    (default) the phone side ran and the watch answered it: the phone-side log has the app's
#             "PebbleKit JS ready" and a "watch message:" line (the watch only sends its WATCH_PREFS after a message
#             from the phone reached it), and the screen is no longer the first one.
#   weather   as answer, and the weather panel (CONTRACTS.md §17) is on the watch's screen: its temperature line,
#             the only red on the upper half of the screen, is in at least a fifth of the screen's columns (so a
#             colour platform is needed). The .pbw for this is built with PKJS_ENTRY=src/pkjs/gravel-weather.js, which
#             turns showWeather on in the stored settings and then runs the real phone side: position, the request to
#             Open-Meteo through Gravel and the WEATHER_* message are the real thing. Gravel's own log line
#             ("Sending app message: {"WEATHER_COUNT":24,…") is printed when found, but it is written late and is not
#             what decides. showWeather stays on in Gravel's storage for the app afterwards.
#   answer and weather stop as soon as they are met; waiting always takes the N seconds.
#
# --permissions sets the app's "Internet access" and "Location" in Gravel (Settings > Apps > Watch App Permissions >
#   Deutschebahned) by reading the screen (uiautomator) and tapping: allow, deny, or default (follow Gravel's default for
#   all apps, off unless changed). Without it they are left as they are. It is done before the app is installed when
#   Gravel already lists the app, else right after the first install.
# --mock-location feeds the Android *emulator's* fused location provider that position every 15 s while the test
#   runs (its own provider never has a fix, and the app then shows a location error). Refused on a real device.
# --reset-settings stops Gravel and deletes what the app's phone side stored there (its localStorage: settings,
#   learned weights, indexes), so that the run starts like a first install. Permissions are kept.
# --update-waiting saves the final screen as test/gravel/<platform>-waiting.png (only when the phone side logged
#   nothing; look at the picture before committing it).
#
# Needs adb and one device with a debug build of Gravel (release builds have no adb hooks), unlocked; a test device,
# since the emulator takes the place of the watch Gravel was connected to. Gravel's
# "Keep watch / Replace" question for the new emulator is answered with "Keep watch". Gravel is restarted at the start;
# when the Pebble emulator stops answering during the install (it does, at times), a new one is tried, up to 3. PBW defaults to
# build/deutschebahned.pbw (built when missing). Writes test/gravel-out/<platform>-<expect>.png (the watch's screen),
# <platform>-<expect>-logs.txt (pebble logs) and <platform>-<expect>-gravel.log (Gravel's log of the run). The Pebble
# emulator is this script's own (state under test/gravel-out/.state) and is stopped at the end.
# Exits non-zero on failure. Re-runs itself inside nix-shell when `pebble` is not on PATH.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if ! command -v pebble >/dev/null 2>&1; then
  exec nix-shell "$ROOT/shell.nix" --run "bash $(printf '%q' "${BASH_SOURCE[0]}")$([ $# -gt 0 ] && printf ' %q' "$@")"
fi
# The nix shell names an emulator here, and pebble-tool prefers it over --phone.
unset PEBBLE_EMULATOR

GRAVEL=com.anopticlabs.gravel.signed
APP_NAME="Deutschebahned"
APP_UUID=7df2b6a7-ddc2-40db-951f-26fc5dbdf5d5
DEVICE_PORT=12344
SERIAL=""
PLAT=emery
SECONDS_TO_RUN=90
EXPECT=answer
PERMISSIONS=""
MOCK_LOCATION=""
UPDATE_WAITING=0
RESET_SETTINGS=0
PBW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="$2"; shift ;;
    --platform) PLAT="$2"; shift ;;
    --seconds) SECONDS_TO_RUN="$2"; shift ;;
    --expect) EXPECT="$2"; shift ;;
    --permissions) PERMISSIONS="$2"; shift ;;
    --mock-location) MOCK_LOCATION="$2"; shift ;;
    --update-waiting) UPDATE_WAITING=1 ;;
    --reset-settings) RESET_SETTINGS=1 ;;
    -h|--help) sed -n '2,/^set -uo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) PBW="$1" ;;
  esac
  shift
done
case "$EXPECT" in waiting|answer|weather) ;; *) echo "--expect takes waiting, answer or weather" >&2; exit 2 ;; esac
case "$PERMISSIONS" in ""|allow|default|deny) ;; *) echo "--permissions takes allow, default or deny" >&2; exit 2 ;; esac
case "$EXPECT:$PLAT" in weather:aplite|weather:diorite) echo "--expect weather needs a colour platform" >&2; exit 2 ;; esac
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

OUT=$ROOT/test/gravel-out
STATE=$OUT/.state
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
mkdir -p "$OUT" "$STATE/xdg/pebble-sdk" "$STATE/tmp"
# Share the installed SDKs but keep the emulator's state private: other Pebble emulators of this user are left alone.
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME=$STATE/xdg TMPDIR=$STATE/tmp
cd "$ROOT" || exit 1

NAME=$PLAT-$EXPECT
LOG=$OUT/$NAME-logs.txt
SHOT=$OUT/$NAME.png
GRAVEL_LOG=$OUT/$NAME-gravel.log
WAITING_REF=$ROOT/test/gravel/$PLAT-waiting.png

QEMU_PID=""
LOGS_PID=""
LOC_PID=""
note() { echo "[gravel $PLAT] $*"; }
cleanup() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  if [ -n "$LOC_PID" ]; then
    kill "$LOC_PID" 2>/dev/null
    "${ADB[@]}" shell cmd location providers remove-test-provider fused >/dev/null 2>&1
  fi
  [ -n "$QEMU_PID" ] && kill "$QEMU_PID" 2>/dev/null
  # whatever else pebble-tool started from our private state (never anybody else's emulator)
  for pid in $(ps -eo pid,args | grep -E '[q]emu-pebble|[p]ypkjs' | grep -F "$STATE/" | awk '{print $1}'); do
    kill "$pid" 2>/dev/null
  done
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
broadcast() {  # broadcast ACTION RECEIVER [extras...]: prints the broadcast's result line
  "${ADB[@]}" shell am broadcast -a "coredevices.coreapp.$1" -n "$GRAVEL/coredevices.coreapp.debug.$2" "${@:3}" | tail -1
}

# ---- the phone's screen: read with uiautomator, tap by text -----------------------------------------------------
ui_nodes() {  # one line per node: "x1 y1 x2 y2 checked text" (text may be empty)
  "${ADB[@]}" exec-out uiautomator dump /dev/tty 2>/dev/null | sed 's/>/>\n/g' |
    sed -nE 's/.* text="([^"]*)".* checked="(true|false)".* bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\3 \4 \5 \6 \2 \1/p'
}
ui_find() {  # ui_find TEXT [top|bottom] <nodes: the centre "x y" of the top- or bottommost node with exactly that text
  awk -v t="$1" -v which="${2:-top}" '
    { s = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ [0-9]+ [a-z]+ ?/, "", s) }
    s == t && (!n++ || (which == "top" ? $2 < y : $2 > y)) { y = $2; at = int(($1 + $3) / 2) " " int(($2 + $4) / 2) }
    END { if (n) print at; else exit 1 }'
}
ui_has() { ui_find "$1" <<<"$NODES" >/dev/null; }
ui_tap() {  # ui_tap TEXT [top|bottom]: taps that node of $NODES
  local at
  at=$(ui_find "$@" <<<"$NODES") || return 1
  # shellcheck disable=SC2086
  "${ADB[@]}" shell input tap $at
  sleep 2
}
ui_swipe_up() {
  local w h
  read -r w h < <("${ADB[@]}" shell wm size | tr -d '\r' | sed -nE '$s/.* ([0-9]+)x([0-9]+).*/\1 \2/p')
  "${ADB[@]}" shell input swipe $((w / 2)) $((h * 3 / 4)) $((w / 2)) $((h / 4)) 300
  sleep 1
}
gravel_in_front() { "${ADB[@]}" shell dumpsys window 2>/dev/null | grep mCurrentFocus | grep -q "$GRAVEL/"; }
gravel_to_front() {
  gravel_in_front && return
  "${ADB[@]}" shell monkey -p "$GRAVEL" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 3
}
keep_watch() {  # Gravel asks this about every watch it has not seen before
  gravel_to_front
  NODES=$(ui_nodes)
  if ui_has "Keep watch" && ui_tap "Keep watch"; then
    note "answered Gravel's question with 'Keep watch'"
    # Gravel now empties and refills the watch's databases. An app transfer started in the middle of that has hung
    # the Pebble emulator (the watch stops answering for good): let it finish.
    sleep 20
  fi
  return 0
}

# Brings Gravel to the app's page (the one with its permissions), from wherever it is. 0: there; 2: Gravel does not
# list the app (yet); 1: lost.
open_app_page() {
  local step before
  for step in $(seq 30); do
    gravel_to_front
    NODES=$(ui_nodes)
    if ui_has "Keep watch"; then ui_tap "Keep watch"
    elif ui_has "This app's access on your phone" && ui_has "$APP_NAME"; then return 0
    elif ui_has "Individual apps" || ui_has "Default for all apps" || ui_has "Classic PebbleKit"; then  # Watch App Permissions
      if ui_has "Individual apps" && ui_has "$APP_NAME"; then ui_tap "$APP_NAME"
      else
        before=$NODES
        ui_swipe_up
        [ "$(ui_nodes)" = "$before" ] && return 2   # the end of the list
      fi
    elif ui_has "Control internet, location and companion app access for watchfaces and apps"; then ui_tap "Watch App Permissions"
    elif ui_has "Phone Calendar" && ui_has "Get Help"; then ui_tap "Apps" top                          # Settings
    elif [ $((step % 2)) = 1 ] && ui_has "Settings"; then ui_tap "Settings" bottom                      # the tab
    else "${ADB[@]}" shell input keyevent BACK; sleep 1
    fi
  done
  return 1
}
# permission_is LABEL BUTTON <nodes: in the row under LABEL, the checked segment is the one whose text starts with BUTTON
permission_is() {
  awk -v label="$1" -v want="$2" '
    { s = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ [0-9]+ [a-z]+ ?/, "", s); x1[NR] = $1; y1[NR] = $2; x2[NR] = $3; chk[NR] = $5; txt[NR] = s }
    END {
      ly = -1; by = cy = 1e9
      for (i = 1; i <= NR; i++) if (txt[i] == label) ly = y1[i]
      if (ly < 0) exit 1
      for (i = 1; i <= NR; i++) if (y1[i] > ly) {
        if (index(txt[i], want) == 1 && y1[i] < by) { by = y1[i]; bx = (x1[i] + x2[i]) / 2 }
        if (chk[i] == "true" && y1[i] < cy) { cy = y1[i]; cx1 = x1[i]; cx2 = x2[i] }
      }
      exit !(by < 1e9 && cy < 1e9 && bx >= cx1 && bx <= cx2)
    }'
}
# permission_button LABEL BUTTON <nodes: the centre of that button in the row under LABEL
permission_button() {
  awk -v label="$1" -v want="$2" '
    { s = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ [0-9]+ [a-z]+ ?/, "", s); x1[NR] = $1; y1[NR] = $2; x2[NR] = $3; y2[NR] = $4; txt[NR] = s }
    END {
      ly = -1; by = 1e9
      for (i = 1; i <= NR; i++) if (txt[i] == label) ly = y1[i]
      for (i = 1; i <= NR; i++) if (ly >= 0 && y1[i] > ly && index(txt[i], want) == 1 && y1[i] < by) {
        by = y1[i]; at = int((x1[i] + x2[i]) / 2) " " int((y1[i] + y2[i]) / 2)
      }
      if (by < 1e9) print at; else exit 1
    }'
}
# 0: both permissions are as asked; 2: the app is not listed; 1: failed
set_permissions() {
  local button label at try
  case "$PERMISSIONS" in allow) button="Allow" ;; deny) button="Deny" ;; *) button="Default (" ;; esac
  open_app_page || return $?
  ui_has "Location" || { ui_swipe_up; NODES=$(ui_nodes); }
  for label in "Internet access" "Location"; do
    for try in 1 2 3; do
      permission_is "$label" "$button" <<<"$NODES" && continue 2
      at=$(permission_button "$label" "$button" <<<"$NODES") || return 1
      # shellcheck disable=SC2086
      "${ADB[@]}" shell input tap $at
      sleep 2
      NODES=$(ui_nodes)
    done
    return 1
  done
  note "Gravel: $APP_NAME has Internet access and Location on '$(echo "$button" | tr -d ' (')'"
}

# ---- the watch's screen ---------------------------------------------------------------------------------------
# screen: 'none' (no screenshot), 'waiting' (the app's first screen), 'weather' (the panel's red line is there) or
# 'app' (anything else)
screen() {
  rm -f "$SHOT"
  timeout 60 pebble screenshot --no-open --phone 127.0.0.1 "$SHOT" >/dev/null 2>&1
  [ -s "$SHOT" ] || { echo none; return; }
  node -e "
    const { decode, diff } = require('./tools/lib/png-diff');
    const fs = require('fs');
    const [ref, file] = process.argv.slice(1);
    const shot = decode(fs.readFileSync(file));
    if (fs.existsSync(ref)) {
      const d = diff(decode(fs.readFileSync(ref)), shot, {});
      if (!d.sizeMismatch && d.diffPixels === 0) { console.log('waiting'); process.exit(0); }
    }
    // red as the watch draws it (GColorRed) or as the emulator's colour-corrected, smoothed screenshot shows it (227,84,98)
    const red = (r, g, b) => r >= 200 && r - Math.max(g, b) >= 100;
    let columns = 0;   // columns of the upper half with a red pixel
    for (let x = 0; x < shot.width; x++) {
      for (let y = 0; y < shot.height / 2; y++) {
        const i = (y * shot.width + x) * 4;
        if (red(shot.data[i], shot.data[i + 1], shot.data[i + 2])) { columns++; break; }
      }
    }
    console.log(columns * 5 >= shot.width ? 'weather' : 'app');" "$WAITING_REF" "$SHOT"
}
phone_log() { grep -a 'pkjs>' "$LOG" 2>/dev/null; }
phone_answered() { phone_log | grep -q 'PebbleKit JS ready' && phone_log | grep -q 'watch message:'; }
gravel_log() {  # Gravel's log since the start of this run (it writes no logcat; UTC timestamps, some seconds late)
  "${ADB[@]}" exec-out run-as "$GRAVEL" cat cache/logs/latest.log 2>/dev/null | awk -v start="$STARTED" '/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/ { keep = $1 >= start } keep'
}

# ---- preparation ----------------------------------------------------------------------------------------------
"${ADB[@]}" get-state >/dev/null 2>&1 || fail "no adb device"
"${ADB[@]}" shell pm path "$GRAVEL" | grep -q . || fail "Gravel ($GRAVEL) is not installed on the device"
[ "$EXPECT" != waiting ] || [ -f "$WAITING_REF" ] || [ "$UPDATE_WAITING" = 1 ] ||
  fail "no $WAITING_REF to compare with (see --update-waiting)"
STARTED=$("${ADB[@]}" shell date -u +%Y-%m-%dT%H:%M:%S | tr -d '\r')

if [ -z "$PBW" ] && [ "$EXPECT" = weather ]; then
  note "building with gravel-weather.js"
  PBW=$STATE/deutschebahned-weather.pbw
  pebble clean >/dev/null 2>&1   # waf does not track PKJS_ENTRY
  PKJS_ENTRY=src/pkjs/gravel-weather.js pebble build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; fail "pebble build"; }
  cp build/deutschebahned.pbw "$PBW"
  # the seeding bundle must never be mistaken for the real app: put the real one back
  pebble clean >/dev/null 2>&1
  pebble build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; fail "pebble build"; }
elif [ -z "$PBW" ]; then
  PBW=build/deutschebahned.pbw
  [ -f "$PBW" ] || pebble build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; fail "pebble build"; }
fi
[ -f "$PBW" ] || fail "$PBW is missing"

if [ "$RESET_SETTINGS" = 1 ]; then
  # Gravel keeps a watchapp's localStorage in a preferences file of its own; a debug build lets adb at it
  "${ADB[@]}" shell am force-stop "$GRAVEL"
  "${ADB[@]}" shell "run-as $GRAVEL rm -f shared_prefs/${GRAVEL}_pkjs_$APP_UUID.xml" || fail "could not delete the app's stored settings in Gravel"
  note "deleted the app's stored settings in Gravel"
fi

if [ -n "$MOCK_LOCATION" ]; then
  [ "$("${ADB[@]}" shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || fail "--mock-location is for an Android emulator"
  "${ADB[@]}" shell appops set com.android.shell android:mock_location allow
  "${ADB[@]}" shell cmd location providers add-test-provider fused >/dev/null 2>&1
  "${ADB[@]}" shell cmd location providers set-test-provider-enabled fused true >/dev/null 2>&1
  "${ADB[@]}" shell cmd location providers set-test-provider-location fused --location "$MOCK_LOCATION" --accuracy 20 ||
    fail "could not set the emulator's location to $MOCK_LOCATION"
  ( while sleep 15; do
      "${ADB[@]}" shell cmd location providers set-test-provider-location fused --location "$MOCK_LOCATION" --accuracy 20 >/dev/null 2>&1
    done ) &
  LOC_PID=$!
  note "the phone's position is $MOCK_LOCATION"
fi

# ---- a fresh watch for Gravel, and the app on it ----------------------------------------------------------------
stop_watch() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  [ -n "$QEMU_PID" ] && kill "$QEMU_PID" 2>/dev/null
  LOGS_PID=""
  QEMU_PID=""
}
# Boots a Pebble emulator and makes it Gravel's watch. 1: Gravel did not connect to it.
start_watch() {
  local before pid port dir
  # a watch as it comes with the SDK, not the one of the last run (apps, settings, a flash image a hung emulator left)
  for dir in "$STATE"/xdg/pebble-sdk/*; do
    [ -L "$dir" ] || rm -rf "${dir:?}/$PLAT"
  done
  # pebble-tool starts the emulator together with its own phone simulator (pypkjs), which holds the watch's only
  # connection: stop it and hand the connection to Gravel.
  before=$(pgrep -x qemu-pebble | tr '\n' ' ')
  timeout 180 pebble emu-battery --percent 100 --emulator "$PLAT" >/dev/null 2>&1 || fail "the Pebble emulator did not start"
  for pid in $(pgrep -x qemu-pebble); do
    case " $before " in *" $pid "*) ;; *) QEMU_PID=$pid ;; esac
  done
  [ -n "$QEMU_PID" ] || fail "no new qemu-pebble process"
  port=$(tr '\0' '\n' <"/proc/$QEMU_PID/cmdline" | grep -o 'tcp::[0-9]*' | sed -n 1p | cut -d: -f3)
  pkill -f "pypkjs --qemu localhost:$port " || true
  sleep 1

  # Always the same port on the device, so that Gravel sees the same watch on every run.
  "${ADB[@]}" reverse "tcp:$DEVICE_PORT" "tcp:$port" >/dev/null || fail "adb reverse"
  "${ADB[@]}" forward tcp:9000 tcp:9000 >/dev/null || fail "adb forward"
  # Gravel is started afresh: nothing of an earlier run is left running in it, and its watch manager (0.12.0) can end
  # up connecting to nothing ("Already connecting to … (this is a bug)" in its log) when a watch is added while it
  # is still retrying one that is gone.
  "${ADB[@]}" shell am force-stop "$GRAVEL"
  gravel_to_front
  broadcast ADD_QEMU_WATCH QemuSetupReceiver --es host 127.0.0.1 --ei port "$DEVICE_PORT" | grep -q 'result=0' ||
    fail "Gravel did not take the watch (a release build has no adb hooks)"
  note "attached the emulator to Gravel"
  for _ in $(seq 30); do  # until Gravel has the watch and its developer connection answers
    keep_watch
    broadcast DEV_CONNECTION DevConnectionReceiver | grep -q 'result=0' && [ "$(screen)" != none ] && return 0
    sleep 3
  done
  return 1
}
# Installs $PBW through Gravel, with `pebble logs` attached first. 1: the watch stopped answering.
install_app() {
  local silent=0
  for _ in $(seq 20); do  # while Gravel is still setting the watch up, installs fail: again
    keep_watch
    broadcast DEV_CONNECTION DevConnectionReceiver >/dev/null
    [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
    : >"$LOG"
    pebble logs --phone 127.0.0.1 >"$LOG" 2>&1 &
    LOGS_PID=$!
    sleep 2
    timeout 120 pebble install --phone 127.0.0.1 "$PBW" 2>&1 | grep -q 'succeeded' && return 0
    if [ "$(screen)" = none ]; then silent=$((silent + 1)); else silent=0; fi
    [ "$silent" -ge 2 ] && return 1
    sleep 5
  done
  return 1
}

permissions_done=0
installed=0
for attempt in 1 2 3; do
  start_watch || fail "Gravel did not connect to the watch"
  if [ -n "$PERMISSIONS" ] && [ "$permissions_done" = 0 ]; then
    set_permissions
    case $? in
      0) permissions_done=1 ;;
      2) note "Gravel does not list $APP_NAME yet: permissions after the install" ;;
      *) fail "could not set the permissions in Gravel's settings" ;;
    esac
  fi
  if install_app; then installed=1; break; fi
  # The Pebble emulator at times stops answering for good in the middle of an app transfer.
  note "the watch no longer answers: once more with a new emulator"
  stop_watch
done
[ "$installed" = 1 ] || fail "could not install $PBW through Gravel"
note "installed $PBW"
if [ -n "$PERMISSIONS" ] && [ "$permissions_done" = 0 ]; then
  set_permissions || fail "could not set the permissions in Gravel's settings"
fi

# ---- the verdict ----------------------------------------------------------------------------------------------
state=none
verdict() {  # 0 when what --expect asks for is there
  case "$EXPECT" in
    waiting) [ "$state" = waiting ] ;;
    answer) phone_answered && { [ "$state" = app ] || [ "$state" = weather ]; } ;;
    weather) phone_answered && [ "$state" = weather ] ;;
  esac
}
deadline=$((SECONDS + SECONDS_TO_RUN))
while :; do
  left=$((deadline - SECONDS))
  [ "$left" -le 0 ] && break
  sleep $((left < 15 ? left : 15))
  [ "$EXPECT" = waiting ] && [ "$SECONDS" -lt "$deadline" ] && continue
  state=$(screen)
  verdict && break
done
[ "$state" = none ] && state=$(screen)

sleep 3   # let the last log lines arrive
gravel_log >"$GRAVEL_LOG"
note "phone side log ($LOG):"
phone_log | cut -c1-200 | sed 's/^/  /'
note "Gravel's log ($GRAVEL_LOG):"
grep -a -e "Not running PebbleKit JS for $APP_UUID" -e 'WEATHER_COUNT' "$GRAVEL_LOG" | cut -c1-200 | tail -4 | sed 's/^/  /'
note "watch screen: $SHOT ($state)"

if [ "$UPDATE_WAITING" = 1 ]; then
  [ "$state" != none ] || fail "no screenshot"
  phone_log | grep -q . && fail "the phone side ran: this is not the app's first screen"
  mkdir -p "$(dirname "$WAITING_REF")"
  cp "$SHOT" "$WAITING_REF"
  echo "saved $WAITING_REF: look at it before committing"
  exit 0
fi
if verdict; then
  case "$EXPECT" in
    waiting) echo "PASS ($PLAT): nothing reached the watch, it still shows 'Waiting for phone'" ;;
    answer) echo "PASS ($PLAT): the phone side ran in Gravel and the watch answered it" ;;
    weather) echo "PASS ($PLAT): the weather panel is on the watch" ;;
  esac
  exit 0
fi
case "$EXPECT:$state" in
  *:none) fail "no screenshot of the watch (a hung Pebble emulator? run again)" ;;
  waiting:*) fail "expected the watch to stay on 'Waiting for phone', but its screen changed (see $SHOT)" ;;
  *:waiting) fail "the watch still shows 'Waiting for phone': the phone side did not run or could not reach it (Gravel: Watch App Permissions > $APP_NAME; --permissions allow)" ;;
  answer:*) fail "the phone side did not log both 'PebbleKit JS ready' and a 'watch message:' (see $LOG)" ;;
  weather:*) phone_answered && fail "the phone side answered, but there is no weather panel on the watch (no position? see $LOG, $SHOT)"
             fail "the phone side did not log both 'PebbleKit JS ready' and a 'watch message:' (see $LOG)" ;;
esac
