// Host-side tests for src/c/bus_wakeup.c — the wakeup list sent by the phone (CONTRACTS.md §11).
#include <stdio.h>
#include <stdlib.h>
#include "bus_wakeup.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)

static void test_accumulate(void) {
  BusWakeupList w;
  bus_wakeup_init(&w);
  CHECK(!bus_wakeup_complete(&w));
  CHECK(!bus_wakeup_set(&w, 0, 1000, 1));  // no header yet
  bus_wakeup_begin(&w, 3);
  CHECK(!bus_wakeup_complete(&w));
  CHECK(bus_wakeup_set(&w, 2, 3000, 3));
  CHECK(bus_wakeup_set(&w, 0, 1000, 1));
  CHECK(!bus_wakeup_complete(&w));
  CHECK(!bus_wakeup_set(&w, 3, 1, 1));
  CHECK(!bus_wakeup_set(&w, -1, 1, 1));
  CHECK(bus_wakeup_set(&w, 1, 2000, 2));
  CHECK(bus_wakeup_complete(&w));
  CHECK(bus_wakeup_set(&w, 1, 2000, 2));  // duplicate is harmless
  CHECK(bus_wakeup_complete(&w));
  // a new header restarts
  bus_wakeup_begin(&w, 2);
  CHECK(!bus_wakeup_complete(&w));
  // count 0 = cancel all: complete at once, empty plan
  bus_wakeup_begin(&w, 0);
  CHECK(bus_wakeup_complete(&w));
  BusWakeup out[BUS_WAKEUP_MAX];
  CHECK_EQ(bus_wakeup_plan(&w, 0, out, BUS_WAKEUP_MAX), 0);
  bus_wakeup_begin(&w, 99);
  CHECK_EQ(w.count, BUS_WAKEUP_MAX);
  bus_wakeup_begin(&w, -3);
  CHECK_EQ(w.count, 0);
}

static void test_plan(void) {
  BusWakeupList w;
  BusWakeup out[BUS_WAKEUP_MAX];
  bus_wakeup_begin(&w, 5);
  bus_wakeup_set(&w, 0, 5000, 10);
  bus_wakeup_set(&w, 1, 1000, 11);   // past (== now) -> dropped
  bus_wakeup_set(&w, 2, 2000, 12);
  bus_wakeup_set(&w, 3, 2030, 13);   // within a minute of the previous -> pushed to 2060
  bus_wakeup_set(&w, 4, 2070, 14);   // then pushed after that -> 2120
  int n = bus_wakeup_plan(&w, 1000, out, BUS_WAKEUP_MAX);
  CHECK_EQ(n, 4);
  CHECK_EQ(out[0].time, 2000); CHECK_EQ(out[0].cookie, 12);
  CHECK_EQ(out[1].time, 2060); CHECK_EQ(out[1].cookie, 13);
  CHECK_EQ(out[2].time, 2120); CHECK_EQ(out[2].cookie, 14);
  CHECK_EQ(out[3].time, 5000); CHECK_EQ(out[3].cookie, 10);
  CHECK_EQ(bus_wakeup_plan(&w, 1000, out, 2), 2);  // max respected
  CHECK_EQ(out[1].cookie, 13);
  CHECK_EQ(bus_wakeup_plan(&w, 9999, out, BUS_WAKEUP_MAX), 0);
  // an incomplete list plans only what arrived
  bus_wakeup_begin(&w, 3);
  bus_wakeup_set(&w, 1, 4000, 7);
  n = bus_wakeup_plan(&w, 0, out, BUS_WAKEUP_MAX);
  CHECK_EQ(n, 1); CHECK_EQ(out[0].cookie, 7);
  // full list of 8, all at the same time -> spread a minute apart
  bus_wakeup_begin(&w, 8);
  for (int i = 0; i < 8; i++) bus_wakeup_set(&w, i, 100, i + 1);
  n = bus_wakeup_plan(&w, 0, out, BUS_WAKEUP_MAX);
  CHECK_EQ(n, 8);
  for (int i = 0; i < n; i++) { CHECK_EQ(out[i].time, 100 + 60 * i); CHECK_EQ(out[i].cookie, i + 1); }
}

int main(void) {
  test_accumulate();
  test_plan();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
