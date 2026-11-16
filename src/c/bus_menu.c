#include "bus_menu.h"

static void add(BusMenu *m, int act) {
  if (m->count < BUS_MENU_MAX) m->acts[m->count++] = (uint8_t)act;
}

void bus_menu_home(BusMenu *m, bool has_nav, bool trip, bool row) {
  m->count = 0;
  m->sel = 0;
  if (has_nav && trip) add(m, BUS_ACT_SHOW_TRIP);
  if (row) add(m, BUS_ACT_SELECT);
  if (has_nav && row) add(m, trip ? BUS_ACT_REPLACE_TRIP : BUS_ACT_START_TRIP);
  if (has_nav && trip) add(m, BUS_ACT_CLEAR_TRIP);
  add(m, BUS_ACT_UNDO);
  add(m, BUS_ACT_CLOSE);
}

void bus_menu_trip(BusMenu *m, bool preview, bool off_current) {
  m->count = 0;
  m->sel = 0;
  if (preview) {
    add(m, BUS_ACT_GO);
    add(m, BUS_ACT_DISMISS);
  } else {
    add(m, BUS_ACT_HOME);
    if (off_current) add(m, BUS_ACT_CURRENT);
    add(m, BUS_ACT_CANCEL_TRIP);
  }
  add(m, BUS_ACT_CLOSE);
}

void bus_menu_move(BusMenu *m, int delta) {
  int s = (int)m->sel + delta;
  if (s > (int)m->count - 1) s = (int)m->count - 1;
  if (s < 0) s = 0;
  m->sel = (uint8_t)s;
}

int bus_menu_action(const BusMenu *m) {
  return m->count ? m->acts[m->sel] : -1;
}

const char *bus_menu_label(int act) {
  switch (act) {
    case BUS_ACT_SHOW_TRIP: return "Show trip";
    case BUS_ACT_SELECT: return "Select";
    case BUS_ACT_START_TRIP: return "Start trip";
    case BUS_ACT_REPLACE_TRIP: return "Replace trip";
    case BUS_ACT_CLEAR_TRIP: return "Clear trip";
    case BUS_ACT_UNDO: return "Undo selection";
    case BUS_ACT_CLOSE: return "Close";
    case BUS_ACT_HOME: return "Home";
    case BUS_ACT_CURRENT: return "Go to current";
    case BUS_ACT_CANCEL_TRIP: return "Cancel trip";
    case BUS_ACT_GO: return "Start trip";
    case BUS_ACT_DISMISS: return "Dismiss";
    default: return "";
  }
}
