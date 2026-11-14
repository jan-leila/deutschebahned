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
  bus_nav_begin(&n, 3);
  CHECK_EQ(n.count, 3);
  CHECK(bus_nav_step(&n, 0) == NULL);   // not set yet
  CHECK(bus_nav_set_step(&n, 0, BUS_NAV_WALK, "Walk to First Ave", "4 min walk", "350m", "EB", 0xff0000));
  CHECK(bus_nav_set_step(&n, 2, BUS_NAV_ARRIVE, "Arrive at Work", NULL, NULL, NULL, -1));
  CHECK(!bus_nav_set_step(&n, 3, BUS_NAV_WALK, "x", "", "", "", -1));
  CHECK(!bus_nav_set_step(&n, -1, BUS_NAV_WALK, "x", "", "", "", -1));
  const BusNavStep *s = bus_nav_step(&n, 0);
  CHECK(s != NULL);
  CHECK_STR(s->text, "Walk to First Ave");
  CHECK_STR(s->sub, "4 min walk");
  CHECK_STR(s->dist, "350m");
  CHECK_STR(s->dir, "EB");
  CHECK_EQ(s->color, 0xff0000);
  CHECK(bus_nav_step(&n, 1) == NULL);
  CHECK_STR(bus_nav_step(&n, 2)->sub, "");
  CHECK_EQ(bus_nav_row_count(&n), 3);
  bus_nav_begin(&n, 99);
  CHECK_EQ(n.count, BUS_NAV_MAX);
  CHECK(bus_nav_step(&n, 0) == NULL);   // cleared
  bus_nav_begin(&n, -4);
  CHECK_EQ(n.count, 0);
}

static void test_live(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 3);
  CHECK(bus_nav_set_live(&n, BUS_NAV_GUIDING, 0, "4 min left", "320ft", 90));   // opens
  CHECK_EQ(n.state, BUS_NAV_GUIDING);
  CHECK_STR(n.live_sub, "4 min left");
  CHECK_STR(n.live_dist, "320ft");
  CHECK_EQ(n.bearing, 90);
  CHECK(!bus_nav_set_live(&n, BUS_NAV_GUIDING, 0, "3 min left", "250ft", 100));  // same step
  CHECK_STR(n.live_dist, "250ft");
  CHECK(bus_nav_set_live(&n, BUS_NAV_ARRIVED, 1, "", "", -1));                   // next step
  CHECK_EQ(n.current, 1);
  CHECK_EQ(n.state, BUS_NAV_ARRIVED);
  CHECK_EQ(n.bearing, -1);
  CHECK(bus_nav_set_live(&n, BUS_NAV_GUIDING, 9, "", "", 360));                  // clamped to the last step: 1 -> 2
  CHECK_EQ(n.current, 2);
  CHECK_EQ(n.bearing, -1);
  CHECK(!bus_nav_set_live(&n, 0, 1, "x", "y", 5));                               // closes
  CHECK_EQ(n.state, BUS_NAV_CLOSED);
  CHECK_EQ(n.count, 0);
}

static void test_begin_keeps_current(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 5);
  bus_nav_set_live(&n, BUS_NAV_GUIDING, 3, "", "", -1);
  bus_nav_begin(&n, 6);          // a longer list (turns were added)
  CHECK_EQ(n.current, 3);
  bus_nav_begin(&n, 2);          // a shorter one
  CHECK_EQ(n.current, 1);
}

static void test_truncation_and_names(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_begin(&n, 1);
  char big[200];
  memset(big, 'a', sizeof big - 1);
  big[sizeof big - 1] = 0;
  bus_nav_set_step(&n, 0, 99, big, big, "123456789", "NBX", -1);
  const BusNavStep *s = bus_nav_step(&n, 0);
  CHECK_EQ(s->kind, BUS_NAV_INFO);
  CHECK_EQ((long)strlen(s->text), BUS_NAV_TEXT_LEN - 1);
  CHECK_EQ((long)strlen(s->dist), BUS_NAV_DIST_LEN - 1);
  CHECK_EQ((long)strlen(s->dir), BUS_NAV_DIR_LEN - 1);
  char u[80];
  memset(u, 'a', BUS_NAV_TEXT_LEN - 2);
  strcpy(u + BUS_NAV_TEXT_LEN - 2, "\xC3\xA9");   // a 2-byte character straddling the limit is dropped whole
  bus_nav_set_step(&n, 0, BUS_NAV_WALK, u, "", "", "", -1);
  CHECK_EQ((long)strlen(bus_nav_step(&n, 0)->text), BUS_NAV_TEXT_LEN - 2);
  CHECK_STR(bus_nav_kind_name(BUS_NAV_WALK), "WALK");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_BOARD), "BOARD");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_RIDE), "RIDE");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_WAIT), "WAIT");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_ARRIVE), "ARRIVE");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_TURN), "TURN");
  CHECK_STR(bus_nav_kind_name(BUS_NAV_INFO), "");
}

int main(void) {
  test_list();
  test_live();
  test_begin_keeps_current();
  test_truncation_and_names();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
