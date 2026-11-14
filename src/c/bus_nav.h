// Pure-C navigation model (no pebble.h; host-tested). See CONTRACTS.md §18.
// The phone follows the GPS and sends the list of steps once, then the live guidance of the current step; the watch
// shows the list as a wheel with the current step open.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_NAV_MAX 16
#define BUS_NAV_TEXT_LEN 48
#define BUS_NAV_DIST_LEN 8
#define BUS_NAV_DIR_LEN 4

#define BUS_NAV_CLOSED 0   // no navigation
#define BUS_NAV_GUIDING 1  // walking / riding towards the current step's target
#define BUS_NAV_ARRIVED 2  // at the target of the last step (waiting for the bus, getting off, ...)

enum { BUS_NAV_WALK = 0, BUS_NAV_BOARD, BUS_NAV_RIDE, BUS_NAV_WAIT, BUS_NAV_ARRIVE, BUS_NAV_INFO, BUS_NAV_TURN };

typedef struct {
  bool present;
  uint8_t kind;                  // BUS_NAV_WALK ...
  char text[BUS_NAV_TEXT_LEN];   // "Walk to First Ave"
  char sub[BUS_NAV_TEXT_LEN];    // detail: "4 min walk · 44 at 8:10"
  char dist[BUS_NAV_DIST_LEN];   // the step's length ("350m"), "" = unknown
  char dir[BUS_NAV_DIR_LEN];     // "NB" / "EB" / "SB" / "WB" / ""
  int32_t color;                 // 0xRRGGBB, -1 = none
} BusNavStep;

typedef struct {
  uint8_t state;                      // BUS_NAV_*
  uint8_t count;
  BusNavStep steps[BUS_NAV_MAX];
  int current;                        // index of the step being followed
  char live_sub[BUS_NAV_TEXT_LEN];    // the current step's time left ("4 min left")
  char live_dist[BUS_NAV_DIST_LEN];   // distance to its target ("320ft"), "" = none
  int16_t bearing;                    // degrees 0..359 from the user to the target, -1 = no arrow
} BusNav;

void bus_nav_init(BusNav *n);
// Starts a new step list: count clamped to 0..BUS_NAV_MAX, every step cleared; the current step is kept (clamped).
void bus_nav_begin(BusNav *n, int count);
// One step; false (no change) for a bad index. kind outside 0..6 -> BUS_NAV_INFO; strings copied, NUL-terminated, cut
// at a UTF-8 boundary (NULL -> "").
bool bus_nav_set_step(BusNav *n, int index, int kind, const char *text, const char *sub, const char *dist,
                      const char *dir, int32_t color);
// Live guidance. state outside 1..2 -> everything cleared (closed). current is clamped to the list. bearing outside
// 0..359 -> -1. Returns true when the current step changed (or navigation just opened): the watch scrolls to it.
bool bus_nav_set_live(BusNav *n, int state, int current, const char *live_sub, const char *live_dist, int bearing);
const BusNavStep *bus_nav_step(const BusNav *n, int index);   // NULL unless 0 <= index < count and present
int bus_nav_row_count(const BusNav *n);                       // count, or 1 when there are no steps
// Label of a kind for the band / pill: "WALK" "BOARD" "RIDE" "WAIT" "ARRIVE" "" (info) "TURN".
const char *bus_nav_kind_name(int kind);
