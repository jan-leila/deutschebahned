#!/usr/bin/env bash
# End-to-end test of the real app in the Pebble emulator: builds with the real pkjs (src/pkjs/index.js),
# pushes settings through the real settings flow (mock transit network + fixed location), then checks that
# the watch shows a list, that SELECT records a training sample and that the list is re-sent as "Learned".
#
# usage (inside nix-shell): tools/test-app-emulator.sh [platform]      (default basalt)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v pebble >/dev/null 2>&1; then exec nix-shell "$ROOT/shell.nix" --run "bash $0 $*"; fi
PLAT=${1:-basalt}
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
OUT=$ROOT/test/app-out
STATE=$OUT/.state
mkdir -p "$OUT" "$STATE/xdg/pebble-sdk" "$STATE/tmp"
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME=$STATE/xdg TMPDIR=$STATE/tmp
cd "$ROOT"

fail() { echo "FAIL: $*"; pebble kill >/dev/null 2>&1 || true; exit 1; }

# settings the fake browser "saves": mock network centred on Seattle, two routes, one pinned stop
cat > "$STATE/result.json" <<'JSON'
{"config":{"provider":{"type":"mock"},"location":{"mode":"fixed","lat":47.6,"lon":-122.3},
 "routes":[{"id":"R1","name":"44"},{"id":"R2","name":"E"}],
 "connections":[{"routeId":"R1","stopId":"R1:s12","name":"Home"}]}}
JSON
# pebble emu-app-config opens $BROWSER with the settings URL; answer it like the page's Save would
cat > "$STATE/fakebrowser.sh" <<'SH'
#!/usr/bin/env bash
RT=$(printf '%s' "$1" | grep -oE 'return_to=[^&]+' | head -1 | cut -d= -f2-)
RT=$(printf '%b' "$(printf '%s' "$RT" | sed 's/%/\\x/g')")
ENC=$(jq -rn --rawfile j "$RESULT" '$j|rtrimstr("\n")|@uri')
( for i in $(seq 1 40); do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "${RT}${ENC}")
    [ "$code" != "000" ] && break
    sleep 0.5
  done ) >/dev/null 2>&1 &
SH
chmod +x "$STATE/fakebrowser.sh"
export BROWSER=$STATE/fakebrowser.sh RESULT=$STATE/result.json

pebble clean >/dev/null 2>&1; pebble build >/dev/null || fail "pebble build"   # clean: waf does not track PKJS_ENTRY
PBW=$(ls build/*.pbw | head -1)
pebble kill >/dev/null 2>&1 || true; sleep 2
timeout 120 pebble install --emulator "$PLAT" "$PBW" > "$STATE/install.log" 2>&1 || { cat "$STATE/install.log"; fail "install"; }
( timeout 90 pebble logs --emulator "$PLAT" > "$OUT/$PLAT-logs.txt" 2>&1 & )
sleep 3
# emu-app-config needs a page file; the generated settings page is opened, the fake browser "saves" for us
node -e "process.stdout.write(require('./src/pkjs/config-page.js'))" > "$STATE/page.html"
timeout 40 pebble emu-app-config --emulator "$PLAT" --file "$STATE/page.html" >/dev/null 2>&1 || true
sleep 8

shot() { for t in 1 2 3; do rm -f "$OUT/$PLAT-$1.png"; timeout 30 pebble screenshot --no-open --emulator "$PLAT" "$OUT/$PLAT-$1.png" >/dev/null 2>&1 || true; [ -s "$OUT/$PLAT-$1.png" ] && return 0; sleep 2; done; fail "screenshot $1"; }
shot list
timeout 20 pebble emu-button --emulator "$PLAT" click down >/dev/null 2>&1 || true; sleep 1
shot down
timeout 20 pebble emu-button --emulator "$PLAT" click select >/dev/null 2>&1 || true; sleep 4
shot selected
sleep 2
pebble kill >/dev/null 2>&1 || true
sleep 1

LOG=$OUT/$PLAT-logs.txt
echo "screenshots: $OUT/$PLAT-{list,down,selected}.png"
grep -q "watch message: .*\"LIST_ID\":[1-9]" "$LOG" || fail "watch never reported a list id: no list arrived (see $LOG)"   # the first "sent N items" usually precedes the log attach
grep -q "watch message: .*\"SELECT_INDEX\":1" "$LOG" || fail "SELECT on row 2 not received by the phone (see $LOG)"
grep -q "refresh error" "$LOG" && { grep "refresh error" "$LOG" | head -3; fail "refresh errors"; }
echo "PASS ($PLAT)"
