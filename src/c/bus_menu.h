// Pure-C side menu contents (no pebble.h; host-tested). See CONTRACTS.md §11.
// A short SELECT opens a menu from the right edge of the screen: what can be done there. On the home screen: show the
// trip running, select the row (as a long SELECT does), start a trip to it or replace the running one, clear the trip,
// undo the last pick, close. In the trip view: back home (the trip goes on), go to the current step, start a previewed
// trip, cancel the trip / dismiss the preview, close.
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define BUS_MENU_MAX 8

enum { BUS_ACT_SHOW_TRIP = 0, BUS_ACT_SELECT, BUS_ACT_START_TRIP, BUS_ACT_REPLACE_TRIP, BUS_ACT_CLEAR_TRIP, BUS_ACT_UNDO,
       BUS_ACT_CLOSE, BUS_ACT_HOME, BUS_ACT_CURRENT, BUS_ACT_CANCEL_TRIP, BUS_ACT_GO, BUS_ACT_DISMISS };

typedef struct {
  uint8_t count;
  uint8_t sel;
  uint8_t acts[BUS_MENU_MAX];
} BusMenu;

// has_nav: the watch has the trip view (not aplite); trip: one is running; row: a row is selected (a tile or a place)
void bus_menu_home(BusMenu *m, bool has_nav, bool trip, bool row);
// preview: the trip view shows a preview; off_current: the selection is not on the current row
void bus_menu_trip(BusMenu *m, bool preview, bool off_current);
// moves the selection by delta, clamped to the items
void bus_menu_move(BusMenu *m, int delta);
int bus_menu_action(const BusMenu *m);   // the selected item's BUS_ACT_*, -1 when empty
const char *bus_menu_label(int act);     // "Show trip", ...; "" for an unknown action
