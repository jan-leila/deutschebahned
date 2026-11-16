// Host-side tests for src/c/bus_menu.c — the side menu's contents.
#include <stdio.h>
#include <string.h>
#include "bus_menu.h"

static int failures = 0, checks = 0;
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, (got), (want)); } } while (0)

static void check_acts(const BusMenu *m, const int *want, int n, int line) {
  checks++;
  int ok = m->count == n;
  for (int i = 0; ok && i < n; i++) ok = m->acts[i] == want[i];
  if (!ok) {
    failures++;
    printf("FAIL %s:%d: menu items differ (%d items)\n", __FILE__, line, m->count);
  }
}
#define CHECK_ACTS(m, ...) do { int w_[] = { __VA_ARGS__ }; check_acts((m), w_, (int)(sizeof w_ / sizeof w_[0]), __LINE__); } while (0)

int main(void) {
  BusMenu m;
  bus_menu_home(&m, true, false, true);
  CHECK_ACTS(&m, BUS_ACT_SELECT, BUS_ACT_START_TRIP, BUS_ACT_UNDO, BUS_ACT_CLOSE);
  bus_menu_home(&m, true, true, true);
  CHECK_ACTS(&m, BUS_ACT_SHOW_TRIP, BUS_ACT_SELECT, BUS_ACT_REPLACE_TRIP, BUS_ACT_CLEAR_TRIP, BUS_ACT_UNDO, BUS_ACT_CLOSE);
  bus_menu_home(&m, true, true, false);   // nothing selected (an empty list)
  CHECK_ACTS(&m, BUS_ACT_SHOW_TRIP, BUS_ACT_CLEAR_TRIP, BUS_ACT_UNDO, BUS_ACT_CLOSE);
  bus_menu_home(&m, false, false, true);  // aplite: no trips
  CHECK_ACTS(&m, BUS_ACT_SELECT, BUS_ACT_UNDO, BUS_ACT_CLOSE);
  bus_menu_trip(&m, false, true);
  CHECK_ACTS(&m, BUS_ACT_HOME, BUS_ACT_CURRENT, BUS_ACT_CANCEL_TRIP, BUS_ACT_CLOSE);
  bus_menu_trip(&m, false, false);
  CHECK_ACTS(&m, BUS_ACT_HOME, BUS_ACT_CANCEL_TRIP, BUS_ACT_CLOSE);
  bus_menu_trip(&m, true, true);
  CHECK_ACTS(&m, BUS_ACT_GO, BUS_ACT_DISMISS, BUS_ACT_CLOSE);
  CHECK_EQ(bus_menu_action(&m), BUS_ACT_GO);
  bus_menu_move(&m, -1);
  CHECK_EQ(m.sel, 0);
  bus_menu_move(&m, 5);
  CHECK_EQ(m.sel, 2);
  CHECK_EQ(bus_menu_action(&m), BUS_ACT_CLOSE);
  m.count = 0;
  CHECK_EQ(bus_menu_action(&m), -1);
  CHECK_STR(bus_menu_label(BUS_ACT_SHOW_TRIP), "Show trip");
  CHECK_STR(bus_menu_label(BUS_ACT_UNDO), "Undo selection");
  CHECK_STR(bus_menu_label(BUS_ACT_CURRENT), "Go to current");
  CHECK_STR(bus_menu_label(99), "");
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
