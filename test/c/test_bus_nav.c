// Host-side tests for src/c/bus_nav.c — the navigation model (CONTRACTS.md §18).
#include <stdio.h>
#include <string.h>
#include "bus_nav.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, (got), (want)); } } while (0)

static void test_list(void) {
  BusNav n;
  bus_nav_init(&n);
  CHECK_EQ(n.state, BUS_NAV_CLOSED);
  CHECK_EQ(bus_nav_row_count(&n), 1);
  bus_nav_begin(&n, 3, 0, -1, -1);
  CHECK_EQ(n.count, 3);
  CHECK(bus_nav_step(&n, 0) == NULL);   // not set yet
  CHECK(bus_nav_set_step(&n, 0, BUS_NAV_WALK, "Walk to First Ave", "4 min walk", "350m", "EB", 0xff0000, 2 << 4, NULL, NULL));
  CHECK(bus_nav_set_step(&n, 2, BUS_NAV_ARRIVE, "Arrive at Work", NULL, NULL, NULL, -1, BUS_RAIL_STOP | 2 << 2, NULL, NULL));
  CHECK(!bus_nav_set_step(&n, 3, BUS_NAV_WALK, "x", "", "", "", -1, 0, NULL, NULL));
  CHECK(!bus_nav_set_step(&n, -1, BUS_NAV_WALK, "x", "", "", "", -1, 0, NULL, NULL));
  const BusNavStep *s = bus_nav_step(&n, 0);
  CHECK(s != NULL);
  CHECK_STR(s->text, "Walk to First Ave");
  CHECK_STR(s->sub, "4 min walk");
  CHECK_STR(s->dist, "350m");
  CHECK_STR(s->dir, "EB");
  CHECK_EQ(s->color, 0xff0000);
  CHECK_EQ(BUS_RAIL_MARKER(s->rail), BUS_RAIL_NO_MARKER);
  CHECK_EQ(BUS_RAIL_TOP(s->rail), BUS_RAIL_NO_LINE);
  CHECK_EQ(BUS_RAIL_BOTTOM(s->rail), BUS_RAIL_DASH);
  CHECK_EQ(BUS_RAIL_MARKER(bus_nav_step(&n, 2)->rail), BUS_RAIL_STOP);
  CHECK_EQ(BUS_RAIL_TOP(bus_nav_step(&n, 2)->rail), BUS_RAIL_DASH);
  CHECK(bus_nav_step(&n, 1) == NULL);
  CHECK_STR(bus_nav_step(&n, 2)->sub, "");
  CHECK_EQ(bus_nav_row_count(&n), 3);
  bus_nav_begin(&n, 2, 0, -1, -1);              // a new list: rows kept (stale) until re-sent, rows past its end dropped
  CHECK(bus_nav_step(&n, 0) != NULL);
  CHECK(!bus_nav_step(&n, 0)->fresh);
  CHECK(bus_nav_step(&n, 2) == NULL);
  bus_nav_begin(&n, 5000, 0, -1, -1);
  CHECK_EQ(n.count, BUS_NAV_MAX_ROWS);
  bus_nav_begin(&n, -4, 0, -1, -1);
  CHECK_EQ(n.count, 0);
}

// Longer lists than the cache: row i lives in slot i % BUS_NAV_CACHE; rows near the selection that are missing are
// fetched once (their window is then on its way).
static void test_window_and_fetch(void) {
  int lo, hi;
  bus_nav_window(20, 40, &lo, &hi);
  CHECK_EQ(lo, 15); CHECK_EQ(hi, 31);
  bus_nav_window(2, 40, &lo, &hi);
  CHECK_EQ(lo, 0); CHECK_EQ(hi, 16);
  bus_nav_window(38, 40, &lo, &hi);
  CHECK_EQ(lo, 24); CHECK_EQ(hi, 40);
  bus_nav_window(3, 5, &lo, &hi);
  CHECK_EQ(lo, 0); CHECK_EQ(hi, 5);

  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 40, 0, -1, -1);              // the phone is sending rows 0..15
  for (int i = 0; i < 16; i++) bus_nav_set_step(&n, i, BUS_NAV_STOP, "s", "", "", "", -1, 0, NULL, NULL);
  CHECK_EQ(bus_nav_fetch_for(&n, 5), -1);   // all there
  CHECK_EQ(bus_nav_fetch_for(&n, 12), -1);  // rows 9..15 are there
  CHECK_EQ(bus_nav_fetch_for(&n, 13), 13);  // row 16 is missing: ask for the window around 13
  CHECK_EQ(n.cover_lo, 8); CHECK_EQ(n.cover_hi, 24);
  CHECK_EQ(bus_nav_fetch_for(&n, 14), -1);  // already on its way
  bus_nav_set_step(&n, 16, BUS_NAV_STOP, "row 16", "", "", "", -1, 0, NULL, NULL);
  CHECK(bus_nav_step(&n, 0) == NULL);       // slot 0 now holds row 16
  CHECK_STR(bus_nav_step(&n, 16)->text, "row 16");
  CHECK_EQ(bus_nav_fetch_for(&n, 2), 2);    // back up: row 0 is gone, fetch again
  CHECK_EQ(bus_nav_fetch_for(&n, 99), 39);  // clamped to the last row
  CHECK_EQ(n.cover_lo, 24); CHECK_EQ(n.cover_hi, 40);
}

static void test_live(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 3, 0, -1, -1);
  CHECK(bus_nav_set_live(&n, BUS_NAV_GUIDING, 0, "4 min left", "320ft", 90, NULL));   // opens
  CHECK_EQ(n.state, BUS_NAV_GUIDING);
  CHECK_STR(n.live_sub, "4 min left");
  CHECK_STR(n.live_dist, "320ft");
  CHECK_EQ(n.bearing, 90);
  CHECK(!bus_nav_set_live(&n, BUS_NAV_GUIDING, 0, "3 min left", "250ft", 100, NULL));  // same step
  CHECK_STR(n.live_dist, "250ft");
  CHECK(bus_nav_set_live(&n, BUS_NAV_ARRIVED, 1, "", "", -1, NULL));                   // next step
  CHECK_EQ(n.current, 1);
  CHECK_EQ(n.state, BUS_NAV_ARRIVED);
  CHECK_EQ(n.bearing, -1);
  CHECK(bus_nav_set_live(&n, BUS_NAV_GUIDING, 9, "", "", 360, NULL));                  // clamped to the last step: 1 -> 2
  CHECK_EQ(n.current, 2);
  CHECK_EQ(n.bearing, -1);
  CHECK(!bus_nav_set_live(&n, 0, 1, "x", "y", 5, NULL));                               // closes
  CHECK_EQ(n.state, BUS_NAV_CLOSED);
  CHECK_EQ(n.count, 0);
}

static void test_begin_keeps_current(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 5, 0, -1, -1);
  bus_nav_set_live(&n, BUS_NAV_GUIDING, 3, "", "", -1, NULL);
  bus_nav_begin(&n, 6, 0, -1, -1);          // a longer list (turns were added)
  CHECK_EQ(n.current, 3);
  bus_nav_begin(&n, 2, 0, -1, -1);       // a shorter one
  CHECK_EQ(n.current, 1);
}

static void test_truncation_and_names(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 1, 0, -1, -1);
  char big[200];
  memset(big, 'a', sizeof big - 1);
  big[sizeof big - 1] = 0;
  bus_nav_set_step(&n, 0, 99, big, big, "123456789", "NBX", -1, 0, NULL, NULL);
  const BusNavStep *s = bus_nav_step(&n, 0);
  CHECK_EQ(s->kind, BUS_NAV_INFO);
  CHECK_EQ((long)strlen(s->text), BUS_NAV_TEXT_LEN - 1);
  CHECK_EQ((long)strlen(s->dist), BUS_NAV_DIST_LEN - 1);
  CHECK_EQ((long)strlen(s->dir), BUS_NAV_DIR_LEN - 1);
  char u[80];
  memset(u, 'a', BUS_NAV_TEXT_LEN - 2);
  strcpy(u + BUS_NAV_TEXT_LEN - 2, "\xC3\xA9");   // a 2-byte character straddling the limit is dropped whole
  bus_nav_set_step(&n, 0, BUS_NAV_WALK, u, "", "", "", -1, 0, NULL, NULL);
  CHECK_EQ((long)strlen(bus_nav_step(&n, 0)->text), BUS_NAV_TEXT_LEN - 2);
  CHECK_STR(bus_nav_kind_name(BUS_NAV_WALK), "WALK");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_BOARD), "BOARD");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_RIDE), "RIDE");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_WAIT), "WAIT");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_ARRIVE), "ARRIVE");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_TURN), "TURN");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_INFO), "");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_STOP), "STOP");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_FOLD), "");
}

// The open leg you are on: its header (kept on its own) stays at the top while the selection is on its other rows.
static void test_head_and_preview(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 6, 2, 1, 4);
  CHECK_EQ(n.head, 1);
  CHECK_EQ(n.head_end, 4);
  CHECK(!bus_nav_pinned(&n, 2));                   // the header has not come yet
  bus_nav_set_step(&n, 1, BUS_NAV_HEAD, "Franklin Station", "arr 8:24 \xC2\xB7 6 stops", "2.1km", "EB", 0xff0000,
                   BUS_RAIL_OPEN, "2", "Franklin Av");
  CHECK_STR(n.head_row.badge, "2");
  CHECK_STR(n.head_row.route, "Franklin Av");
  CHECK_EQ(n.head_row.rail & BUS_RAIL_OPEN, BUS_RAIL_OPEN);
  CHECK(!bus_nav_pinned(&n, 1));                   // on the header itself: it is in the list
  CHECK(bus_nav_pinned(&n, 2));
  CHECK(bus_nav_pinned(&n, 4));
  CHECK(!bus_nav_pinned(&n, 5));                   // the next leg
  CHECK(!bus_nav_pinned(&n, 0));
  bus_nav_begin(&n, 6, 2, 1, 5);                   // the same header: kept
  CHECK(n.head_row.present);
  bus_nav_begin(&n, 6, 2, 3, 5);                   // another one: dropped until it comes
  CHECK(!n.head_row.present);
  bus_nav_begin(&n, 6, 2, 7, 9);                   // out of the list: none
  CHECK_EQ(n.head, -1);
  CHECK(!bus_nav_pinned(&n, 2));
  CHECK(bus_nav_set_live(&n, BUS_NAV_PREVIEW, 0, "", "", -1, "Work: leave 8:05 AM"));
  CHECK_EQ(n.state, BUS_NAV_PREVIEW);
  CHECK_STR(n.title, "Work: leave 8:05 AM");
  CHECK(!bus_nav_running(&n));
  bus_nav_set_live(&n, BUS_NAV_GUIDING, 0, "", "", -1, NULL);
  CHECK(bus_nav_running(&n));
  CHECK_STR(n.title, "");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_HEAD), "");
}

int main(void) {
  test_head_and_preview();
  test_list();
  test_window_and_fetch();
  test_live();
  test_begin_keeps_current();
  test_truncation_and_names();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
