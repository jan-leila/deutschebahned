// Host-side tests for src/c/bus_nav.c — the navigation guidance model (CONTRACTS.md §18).
#include <stdio.h>
#include <string.h>
#include "bus_nav.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, (got), (want)); } } while (0)

static void test_set(void) {
  BusNav n;
  bus_nav_init(&n);
  CHECK_EQ(n.state, BUS_NAV_CLOSED);
  CHECK_EQ(n.bearing, -1);
  CHECK(bus_nav_set(&n, BUS_NAV_GUIDING, "Walk to First Ave", "6 min walk", "350m", 90, 0xff0000));  // opens: changed
  CHECK_EQ(n.state, BUS_NAV_GUIDING);
  CHECK_STR(n.text, "Walk to First Ave");
  CHECK_STR(n.sub, "6 min walk");
  CHECK_STR(n.dist, "350m");
  CHECK_EQ(n.bearing, 90);
  CHECK_EQ(n.color, 0xff0000);
  CHECK(!bus_nav_set(&n, BUS_NAV_GUIDING, "Walk to First Ave", "5 min walk", "300m", 95, 0xff0000));  // same step
  CHECK_STR(n.sub, "5 min walk");
  CHECK(bus_nav_set(&n, BUS_NAV_ARRIVED, "Wait for the 44", "Next 5 min", "", -1, 0xff0000));          // new step
  CHECK_EQ(n.state, BUS_NAV_ARRIVED);
  CHECK_EQ(n.bearing, -1);
  CHECK_STR(n.dist, "");
}

static void test_clamps_and_close(void) {
  BusNav n;
  bus_nav_init(&n);
  bus_nav_set(&n, BUS_NAV_GUIDING, NULL, NULL, NULL, 360, -1);
  CHECK_STR(n.text, "");
  CHECK_EQ(n.bearing, -1);
  bus_nav_set(&n, BUS_NAV_GUIDING, "x", "y", "z", -5, -1);
  CHECK_EQ(n.bearing, -1);
  bus_nav_set(&n, BUS_NAV_GUIDING, "x", "y", "z", 359, -1);
  CHECK_EQ(n.bearing, 359);
  CHECK(!bus_nav_set(&n, 7, "x", "y", "z", 10, 5));   // unknown state = closed
  CHECK_EQ(n.state, BUS_NAV_CLOSED);
  CHECK_STR(n.text, "");
  CHECK_EQ(n.color, -1);
}

static void test_truncation(void) {
  BusNav n;
  bus_nav_init(&n);
  char big[200];
  memset(big, 'a', sizeof big - 1);
  big[sizeof big - 1] = 0;
  bus_nav_set(&n, BUS_NAV_GUIDING, big, big, "123456789", 0, -1);
  CHECK_EQ((long)strlen(n.text), BUS_NAV_TEXT_LEN - 1);
  CHECK_EQ((long)strlen(n.dist), BUS_NAV_DIST_LEN - 1);
  // a multi-byte character straddling the limit is dropped whole
  char u[80];
  memset(u, 'a', BUS_NAV_TEXT_LEN - 2);
  strcpy(u + BUS_NAV_TEXT_LEN - 2, "\xC3\xA9");
  bus_nav_set(&n, BUS_NAV_GUIDING, u, "", "", 0, -1);
  CHECK_EQ((long)strlen(n.text), BUS_NAV_TEXT_LEN - 2);
}

int main(void) {
  test_set();
  test_clamps_and_close();
  test_truncation();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
