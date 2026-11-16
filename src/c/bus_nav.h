// Pure-C trip model (no pebble.h; host-tested). See CONTRACTS.md §18.
// The phone follows the GPS and sends the rows of the trip (any number of them: each leg a header row with its steps
// under it), then the live guidance of the current row; the watch shows them as a wheel with the current row open. It
// keeps BUS_NAV_CACHE rows (row i in slot i % BUS_NAV_CACHE) and asks the phone for the window around a row it scrolls to
// and does not have. The header of the open leg you are on is also kept on its own: it stays at the top of the trip view
// while you look at that leg's rows.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_NAV_CACHE 16          // rows kept; the phone's NAV_WINDOW
#define BUS_NAV_WINDOW_BEFORE 5   // rows before the centre of a window; the phone's NAV_WINDOW_BEFORE
#define BUS_NAV_MAX_ROWS 1000
#define BUS_NAV_FETCH_NEAR 3      // rows either side of the selection that must be there (else they are fetched)
#define BUS_NAV_TEXT_LEN 48
#define BUS_NAV_DIST_LEN 8
#define BUS_NAV_DIR_LEN 4
#define BUS_NAV_BADGE_LEN 8
#define BUS_NAV_ROUTE_LEN 40

#define BUS_NAV_CLOSED 0   // no navigation
#define BUS_NAV_GUIDING 1  // walking / riding towards the current row's target
#define BUS_NAV_ARRIVED 2  // at the target of the last step (waiting for the bus, getting off, ...)
#define BUS_NAV_PREVIEW 3  // a scheduled trip's steps before it is started: nothing followed, no current row

enum { BUS_NAV_WALK = 0, BUS_NAV_BOARD, BUS_NAV_RIDE, BUS_NAV_WAIT, BUS_NAV_ARRIVE, BUS_NAV_INFO, BUS_NAV_TURN,
       BUS_NAV_STOP, BUS_NAV_FOLD, BUS_NAV_HEAD };

// The rail beside a row (NAV_RAIL = marker | top << 2 | bottom << 4): a stop's circle, and the line above / below it.
enum { BUS_RAIL_NO_MARKER = 0, BUS_RAIL_STOP, BUS_RAIL_HERE };   // HERE: the stop you are at (filled)
enum { BUS_RAIL_NO_LINE = 0, BUS_RAIL_LINE, BUS_RAIL_DASH };     // LINE: a ride, in its colour; DASH: walking, grey
#define BUS_RAIL_MARKER(r) ((r) & 3)
#define BUS_RAIL_TOP(r) (((r) >> 2) & 3)
#define BUS_RAIL_BOTTOM(r) (((r) >> 4) & 3)
// ... and what a long SELECT on the row does (NAV_UNFOLD): FOLDED opens it (a closed leg, hidden rows), OPEN closes it
#define BUS_RAIL_FOLDED 64
#define BUS_RAIL_OPEN 128

typedef struct {
  bool present;                  // the slot holds row `index`
  bool fresh;                    // ... of the current list (false: kept from the one before until it is re-sent)
  int16_t index;
  uint8_t kind;                  // BUS_NAV_WALK ...
  uint8_t rail;                  // NAV_RAIL
  char text[BUS_NAV_TEXT_LEN];   // "Walk to First Ave"
  char sub[BUS_NAV_TEXT_LEN];    // detail: "4 min walk · 44 at 8:10"
  char dist[BUS_NAV_DIST_LEN];   // the row's length ("350m"), "" = unknown
  char dir[BUS_NAV_DIR_LEN];     // "NB" / "EB" / "SB" / "WB" / ""
  int32_t color;                 // 0xRRGGBB, -1 = none
  char badge[BUS_NAV_BADGE_LEN]; // a leg header: its route's badge ("2"), "" = none
  char route[BUS_NAV_ROUTE_LEN]; // ... and its band ("Franklin Av", "Walk · 2 at 8:09")
} BusNavStep;

typedef struct {
  uint8_t state;                      // BUS_NAV_*
  uint16_t count;                     // rows in the list
  BusNavStep steps[BUS_NAV_CACHE];
  int current;                        // index of the row being followed
  char live_sub[BUS_NAV_TEXT_LEN];    // the current row's time left ("4 min left")
  char live_dist[BUS_NAV_DIST_LEN];   // distance to its target ("320ft"), "" = none
  int16_t bearing;                    // degrees 0..359 from the user to the target, -1 = no arrow
  int16_t cover_lo, cover_hi;         // rows [lo, hi) on their way from the phone (the last window sent or asked for)
  int16_t head, head_end;             // the open leg you are on: its header row and last row (-1: none)
  BusNavStep head_row;                // that header (present once it has come)
  char title[BUS_NAV_TEXT_LEN];       // a preview's top line ("Work: leave 8:05 AM")
} BusNav;

void bus_nav_init(BusNav *n);
// Rows [lo, hi) the phone sends around row `center` of a list of `count`.
void bus_nav_window(int center, int count, int *lo, int *hi);
// A new list of `count` rows (clamped to 0..BUS_NAV_MAX_ROWS); the phone sends the window around row `center`. Rows
// kept are still drawn until re-sent, rows past the end are dropped; the current row is kept (clamped). head / head_end:
// the open leg you are on (NAV_HEAD / NAV_HEAD_END; -1 or out of the list: none); its header is kept when it is the same
// row, else it is dropped until it comes.
void bus_nav_begin(BusNav *n, int count, int center, int head, int head_end);
// One row; false (no change) for a bad index. kind outside 0..9 -> BUS_NAV_INFO; strings copied, NUL-terminated, cut
// at a UTF-8 boundary (NULL -> ""). The row that is the open leg's header is also kept as head_row.
bool bus_nav_set_step(BusNav *n, int index, int kind, const char *text, const char *sub, const char *dist,
                      const char *dir, int32_t color, int rail, const char *badge, const char *route);
// Live guidance. state outside 1..3 -> everything cleared (closed). current is clamped to the list. bearing outside
// 0..359 -> -1. title: a preview's top line (NULL -> ""). Returns true when the current row changed (or the trip just
// opened): the watch scrolls to it.
bool bus_nav_set_live(BusNav *n, int state, int current, const char *live_sub, const char *live_dist, int bearing,
                      const char *title);
// A trip is running (guiding or arrived; not a preview).
bool bus_nav_running(const BusNav *n);
// The open leg's header stays at the top while the selection is on one of that leg's other rows.
bool bus_nav_pinned(const BusNav *n, int sel);
const BusNavStep *bus_nav_step(const BusNav *n, int index);   // NULL unless row `index` is held
int bus_nav_row_count(const BusNav *n);                       // count, or 1 when there are no rows
// The selection moved to `sel`: when a row within BUS_NAV_FETCH_NEAR of it is missing (or stale) and not on its way,
// the row to ask the phone for (NAV_FETCH; its window is then on its way), else -1.
int bus_nav_fetch_for(BusNav *n, int sel);
// Label of a kind for the band / pill: "WALK" "BOARD" "RIDE" "WAIT" "ARRIVE" "" (info) "TURN" "STOP" "" (fold, head).
const char *bus_nav_kind_name(int kind);
