// Pure-C list model and text formatting for the Bus Watch UI (no pebble.h; host-tested).
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_MAX_ITEMS 12
#define BUS_TITLE_LEN 64   // full stop names (scrolled on the watch when too wide)
#define BUS_ROUTE_LEN 64   // route full name
#define BUS_BADGE_LEN 8
#define BUS_STATUS_LEN 48
#define BUS_DIST_LEN 8
#define BUS_DIR_LEN 4

enum { BUS_KIND_PICKUP = 0, BUS_KIND_DROPOFF = 1, BUS_KIND_TRIP = 2 };  // TRIP: a planned trip leg (pinned first)

typedef struct {
  bool present;
  uint8_t kind;
  char badge[BUS_BADGE_LEN];  // short route label, e.g. "44"
  char title[BUS_TITLE_LEN];
  int32_t color;              // route color 0xRRGGBB, -1 = none
  int32_t t[3];
  // phase 3 (ITEM_BEARING ... ITEM_U2)
  int16_t bearing;            // degrees 0..359 from the user to the stop, -1 = none
  uint8_t lanes;              // 1, or 2 for a merged opposite-side pickup tile
  char route[BUS_ROUTE_LEN];  // route full name ("Blue Line - Mpls - Airport - MOA"), "" = none
  char dist[BUS_DIST_LEN];    // preformatted distance ("350ft"), "" = none
  char dir[BUS_DIR_LEN];      // "NB" / "SB" / "EB" / "WB" / ""
  char dir2[BUS_DIR_LEN];     // lane 2 direction (lanes == 2)
  int32_t u[3];               // lane 2 times (lanes == 2)
} BusItem;

typedef struct {
  int32_t list_id;
  uint8_t count;
  BusItem items[BUS_MAX_ITEMS];
  char status[BUS_STATUS_LEN];
} BusModel;

void bus_model_init(BusModel *m);
void bus_model_begin_list(BusModel *m, int32_t list_id, int count);
bool bus_model_set_item(BusModel *m, int32_t list_id, int index, int kind, const char *badge,
                        const char *title, int32_t color, int32_t t0, int32_t t1, int32_t t2);
// Phase-3 fields of an item already set with bus_model_set_item (which resets them to bearing -1, lanes 1, "" / 0).
// Same list/index rules; bearing outside 0..359 -> -1; lanes != 2 -> 1 (and dir2/u cleared); strings cut like titles.
bool bus_model_set_geo(BusModel *m, int32_t list_id, int index, int32_t bearing, const char *dist, const char *dir,
                       int lanes, const char *dir2, int32_t u0, int32_t u1, int32_t u2);
// Route full name of an item already set (set_item resets it to ""); same list/index rules and truncation.
bool bus_model_set_route(BusModel *m, int32_t list_id, int index, const char *route);
void bus_model_set_status(BusModel *m, const char *status);
int bus_model_row_count(const BusModel *m);
const BusItem *bus_model_item(const BusModel *m, int index);
int bus_model_clamp_selection(const BusModel *m, int sel);
// True when text on this route color should be dark (0.299R + 0.587G + 0.114B > 150); -1 (none) -> false.
bool bus_color_prefers_dark_text(int32_t rgb);

void bus_format_relative(int32_t seconds, char *buf, size_t n);
void bus_format_clock(int32_t epoch, bool clock24, char *buf, size_t n);
// One pickup lane: non-zero times relative to now joined ", " ("now, 12m, 1h05"); none -> "no times".
void bus_format_lane(const int32_t times[3], int32_t now, char *buf, size_t n);
void bus_format_detail(const BusItem *it, int32_t now, bool clock24, char *buf, size_t n);
