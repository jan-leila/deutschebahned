// Host-side tests for src/c/bus_marquee.c — scrolling text timing (CONTRACTS.md §11).
#include <stdio.h>
#include <stdlib.h>
#include "bus_marquee.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)

static void test_fits(void) {
  uint32_t w = 123;
  CHECK_EQ(bus_marquee_offset(80, 100, 0, &w), 0); CHECK_EQ(w, 0);
  CHECK_EQ(bus_marquee_offset(100, 100, 5000, &w), 0); CHECK_EQ(w, 0);
  CHECK_EQ(bus_marquee_cycle_ms(100, 100), 0);
  CHECK_EQ(bus_marquee_offset(80, 100, 0, NULL), 0);
}

static void test_cycle(void) {
  // 70 px too wide at 35 px/s: hold 1 s, scroll 2 s, hold 1 s
  uint32_t w;
  CHECK_EQ(bus_marquee_cycle_ms(170, 100), 4000);
  CHECK_EQ(bus_marquee_offset(170, 100, 0, &w), 0);    CHECK_EQ(w, 1000);
  CHECK_EQ(bus_marquee_offset(170, 100, 600, &w), 0);  CHECK_EQ(w, 400);
  CHECK_EQ(bus_marquee_offset(170, 100, 1000, &w), 0); CHECK(w >= 1 && w <= 29);
  CHECK_EQ(bus_marquee_offset(170, 100, 2000, &w), 35);
  CHECK_EQ(bus_marquee_offset(170, 100, 3000, &w), 70); CHECK_EQ(w, 1000);  // end hold
  CHECK_EQ(bus_marquee_offset(170, 100, 3999, &w), 70); CHECK_EQ(w, 1);
  CHECK_EQ(bus_marquee_offset(170, 100, 4000, &w), 0);  CHECK_EQ(w, 1000);  // jump back, next cycle
  CHECK_EQ(bus_marquee_offset(170, 100, 6000, &w), 35);
  // after the last cycle: at rest, no timer
  CHECK_EQ(bus_marquee_offset(170, 100, BUS_MARQUEE_CYCLES * 4000, &w), 0); CHECK_EQ(w, 0);
  CHECK_EQ(bus_marquee_offset(170, 100, 1000000, &w), 0); CHECK_EQ(w, 0);
}

static void test_smooth(void) {
  // offset never decreases within the scroll, moves at most 1 px per wait step, and wait points at the next change
  int over = 53;
  int prev = 0;
  uint32_t t = 0, w;
  int steps = 0;
  while (t < bus_marquee_cycle_ms(100 + over, 100) - 1) {
    int off = bus_marquee_offset(100 + over, 100, t, &w);
    CHECK(off >= prev);
    CHECK(off - prev <= 1);
    CHECK(off >= 0 && off <= over);
    CHECK(w > 0);
    if (w == 0) break;
    if (t + w < bus_marquee_cycle_ms(100 + over, 100)) {
      CHECK(bus_marquee_offset(100 + over, 100, t + w - 1, NULL) == off);  // unchanged until then
    }
    prev = off;
    t += w;
    steps++;
  }
  CHECK_EQ(prev, over);
  CHECK(steps >= over);
}

int main(void) {
  test_fits();
  test_cycle();
  test_smooth();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
