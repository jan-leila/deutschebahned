// Pure-C list model and text formatting for the Deutschebahned UI (no pebble.h; host-tested).
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

enum { BUS_KIND_PICKUP = 0, BUS_KIND_DROPOFF = 1, BUS_KIND_TRIP = 2, BUS_KIND_PLACE = 3 };  // TRIP: a planned trip leg (pinned
                                                                                          // first); PLACE: a saved location

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
  int32_t walk;               // seconds to walk to the stop (ITEM_WALK), -1 = none / not shown
  int32_t lead;               // pickup times sooner than this many seconds from now are highlighted (ITEM_LEAD), -1 = none
} BusItem;

typedef struct {
  int32_t list_id;
  uint8_t count;
  BusItem items[BUS_MAX_ITEMS];
  char status[BUS_STATUS_LEN];
} BusModel;

// Saved locations (PLACE_* messages): their own small list, shown above the first row. Aplite has the RAM for fewer.
#if defined(PBL_PLATFORM_APLITE)
#define BUS_MAX_PLACES 4
#else
#define BUS_MAX_PLACES 8
#endif
#define BUS_PLACE_LEN 48

typedef struct {
  bool present;
  char name[BUS_PLACE_LEN];
  char address[BUS_PLACE_LEN];  // "" = none
  int32_t color;                // 0xRRGGBB, -1 = none
  int16_t bearing;              // degrees 0..359, -1 = none
  char dist[BUS_DIST_LEN];
  int32_t walk;                 // seconds, -1 = none
} BusPlace;

typedef struct {
  int32_t list_id;
  uint8_t count;
  BusPlace items[BUS_MAX_PLACES];
} BusPlaces;

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
// Walking time (s) of an item already set (set_item resets it to -1); negative -> -1. Same list/index rules.
bool bus_model_set_walk(BusModel *m, int32_t list_id, int index, int32_t walk);
// Highlight threshold (s from now: walk + dead zone) of an item already set (set_item resets it to -1); negative -> -1.
bool bus_model_set_lead(BusModel *m, int32_t list_id, int index, int32_t lead);
void bus_model_set_status(BusModel *m, const char *status);
int bus_model_row_count(const BusModel *m);
const BusItem *bus_model_item(const BusModel *m, int index);
int bus_model_clamp_selection(const BusModel *m, int sel);
// True when text on this route color should be dark (0.299R + 0.587G + 0.114B > 150); -1 (none) -> false.
bool bus_color_prefers_dark_text(int32_t rgb);
// What the screen shows for a direction code: "NB" -> "North", "SB" -> "South", "EB" -> "East", "WB" -> "West";
// anything else (incl. "") is returned as it is. Never NULL (NULL -> "").
const char *bus_dir_name(const char *code);

void bus_places_init(BusPlaces *p);                                   // list_id -1, count 0
void bus_places_begin(BusPlaces *p, int32_t list_id, int count);      // count clamped 0..BUS_MAX_PLACES; all cleared
// false (no change) on list mismatch / bad index; strings cut at a UTF-8 boundary (NULL → ""); bearing outside 0..359 → -1;
// negative walk → -1
bool bus_places_set(BusPlaces *p, int32_t list_id, int index, const char *name, const char *address, int32_t color,
                    int32_t bearing, const char *dist, int32_t walk);
// The place shown on wheel row `row`: rows run from the last place down to the best one (index 0) at the bottom, next
// to the main list's first row. NULL unless the row exists and that place has arrived.
const BusPlace *bus_places_at_row(const BusPlaces *p, int row);
// A place as a tile for the row drawing: kind PLACE, title = name, route = address, no badge / times / lanes, lead -1.
void bus_place_as_item(const BusPlace *p, BusItem *out);

void bus_format_relative(int32_t seconds, char *buf, size_t n);
void bus_format_clock(int32_t epoch, bool clock24, char *buf, size_t n);
// One pickup lane: non-zero times relative to now joined ", " ("now, 12m, 1h05"); none -> "no times".
void bus_format_lane(const int32_t times[3], int32_t now, char *buf, size_t n);
void bus_format_detail(const BusItem *it, int32_t now, bool clock24, char *buf, size_t n);
// Walking time: < 60 s -> "<1m walk"; else minutes rounded up "4m walk"; >= 1 h "1h05 walk"; negative -> "".
void bus_format_walk(int32_t seconds, char *buf, size_t n);
