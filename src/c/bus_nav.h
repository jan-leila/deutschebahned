// Pure-C navigation guidance model (no pebble.h; host-tested). See CONTRACTS.md §18.
// The phone follows the GPS and sends the current guidance; the watch only shows it.
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define BUS_NAV_TEXT_LEN 48
#define BUS_NAV_DIST_LEN 8

#define BUS_NAV_CLOSED 0   // no navigation
#define BUS_NAV_GUIDING 1  // walking / riding towards the target
#define BUS_NAV_ARRIVED 2  // at the target of the last step (waiting for the bus, getting off, ...)

typedef struct {
  uint8_t state;                 // BUS_NAV_*
  char text[BUS_NAV_TEXT_LEN];   // instruction: "Walk to First Ave"
  char sub[BUS_NAV_TEXT_LEN];    // detail: "6 min walk · 44 at 8:10"
  char dist[BUS_NAV_DIST_LEN];   // "350m" / "0.2mi", "" = none
  int16_t bearing;               // degrees 0..359 from the user to the target, -1 = no arrow
  int32_t color;                 // 0xRRGGBB, -1 = none
} BusNav;

void bus_nav_init(BusNav *n);
// Replaces the guidance. state outside 0..2 -> closed; strings copied, NUL-terminated, cut at a UTF-8 boundary
// (NULL -> ""); bearing outside 0..359 -> -1; closed clears everything. Returns true when the instruction text changed
// (the watch vibrates for a new step) while guiding / arrived.
bool bus_nav_set(BusNav *n, int state, const char *text, const char *sub, const char *dist, int bearing, int32_t color);
