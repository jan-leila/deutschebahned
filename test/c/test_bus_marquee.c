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

static void test_loop(void) {
  // 170 px of text in a 100 px box: hold 1 s, then 170 + 24 = 194 px at 35 px/s (5543 ms, rounded up)
  uint32_t w;
  uint32_t cycle = bus_marquee_cycle_ms(170, 100);
  CHECK_EQ(cycle, 1000 + 5543);
  CHECK_EQ(bus_marquee_offset(170, 100, 0, &w), 0);    CHECK_EQ(w, 1000);
  CHECK_EQ(bus_marquee_offset(170, 100, 600, &w), 0);  CHECK_EQ(w, 400);
  CHECK_EQ(bus_marquee_offset(170, 100, 1000, &w), 0); CHECK(w >= 1 && w <= 29);
  CHECK_EQ(bus_marquee_offset(170, 100, 2000, &w), 35);
  CHECK_EQ(bus_marquee_offset(170, 100, 3000, &w), 70);
  // it doesn't stop at the end of the text: it keeps going through the gap until the copy is where the text began
  CHECK_EQ(bus_marquee_offset(170, 100, 1000 + 5000, &w), 175);
  CHECK(bus_marquee_offset(170, 100, cycle - 30, &w) >= 192);
  CHECK(w > 0);
  // ...then holds at the start and loops again, forever
  CHECK_EQ(bus_marquee_offset(170, 100, cycle, &w), 0);         CHECK_EQ(w, 1000);
  CHECK_EQ(bus_marquee_offset(170, 100, cycle + 2000, &w), 35);
  CHECK_EQ(bus_marquee_offset(170, 100, 50 * cycle + 3000, &w), 70);  CHECK(w > 0);
  CHECK_EQ(bus_marquee_offset(170, 100, 1000 * cycle, &w), 0);  CHECK_EQ(w, 1000);
}

static void test_smooth(void) {
  // over two loops: offsets step by at most 1 px, stay in [0, text + gap), each wait points at the next change
  int text = 153, box = 100, travel = text + BUS_MARQUEE_GAP;
  uint32_t cycle = bus_marquee_cycle_ms(text, box), t = 0, w;
  int prev = 0, steps = 0, wraps = 0, max = 0;
  while (t <= 2 * cycle) {   // the second wrap is at exactly 2 * cycle
    int off = bus_marquee_offset(text, box, t, &w);
    CHECK(off >= 0 && off < travel);
    if (off < prev) { wraps++; CHECK_EQ(off, 0); CHECK(prev >= travel - 2); }   // only the seamless wrap goes back
    else CHECK(off - prev <= 1);
    if (off > max) max = off;
    CHECK(w > 0);
    if (w == 0) break;
    CHECK(bus_marquee_offset(text, box, t + w - 1, NULL) == off);  // unchanged until then
    prev = off;
    t += w;
    steps++;
  }
  CHECK_EQ(wraps, 2);
  CHECK(max >= travel - 1);
  CHECK(steps >= 2 * (travel - 1));
}

int main(void) {
  test_fits();
  test_loop();
  test_smooth();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
