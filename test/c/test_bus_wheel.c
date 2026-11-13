// Host-side tests for src/c/bus_wheel.c — the "rotating drum" list layout (CONTRACTS.md §11).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bus_wheel.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)

static const WheelSlot *find(const WheelSlot *s, int n, int index) {
  for (int i = 0; i < n; i++) if (s[i].index == index) return &s[i];
  return NULL;
}

static void test_geometry(void) {
  WheelGeometry g;
  bus_wheel_geometry(&g, 144, 152, false);
  CHECK_EQ(g.width, 144); CHECK_EQ(g.height, 152); CHECK(!g.round);
  CHECK_EQ(g.row_h[0], 70); CHECK_EQ(g.row_h[1], 34); CHECK_EQ(g.row_h[2], 24);
  CHECK_EQ(g.inset[0], 0); CHECK_EQ(g.inset[1], 4); CHECK_EQ(g.inset[2], 10);
  bus_wheel_geometry(&g, 200, 210, false);  // emery-sized
  CHECK_EQ(g.row_h[0], 84); CHECK_EQ(g.row_h[1], 42); CHECK_EQ(g.row_h[2], 28);
  bus_wheel_geometry(&g, 180, 180, true);
  CHECK(g.round);
}

static void test_static_layout(void) {
  WheelGeometry g;
  bus_wheel_geometry(&g, 144, 152, false);
  WheelSlot s[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(&g, 10, 4000, s, WHEEL_MAX_SLOTS);
  CHECK(n >= 5 && n <= WHEEL_MAX_SLOTS);
  const WheelSlot *sel = find(s, n, 4);
  CHECK(sel != NULL);
  if (!sel) return;
  // selected row centred, full size, level 0
  CHECK_EQ(sel->h, 70);
  CHECK_EQ(sel->y, 76 - 35);
  CHECK_EQ(sel->level, 0);
  CHECK_EQ(sel->inset, 0);
  // neighbours: level 1, row_h[1]; fringe: level 2, row_h[2]; stacked without gaps
  const WheelSlot *up1 = find(s, n, 3), *dn1 = find(s, n, 5), *up2 = find(s, n, 2), *dn2 = find(s, n, 6);
  CHECK(up1 && dn1 && up2 && dn2);
  if (!(up1 && dn1 && up2 && dn2)) return;
  CHECK_EQ(up1->level, 1); CHECK_EQ(dn1->level, 1); CHECK_EQ(up2->level, 2); CHECK_EQ(dn2->level, 2);
  CHECK_EQ(up1->h, 34); CHECK_EQ(dn2->h, 24);
  CHECK_EQ(up1->y + up1->h, sel->y);
  CHECK_EQ(dn1->y, sel->y + sel->h);
  CHECK_EQ(up2->y + up2->h, up1->y);
  CHECK_EQ(dn2->y, dn1->y + dn1->h);
  CHECK_EQ(up1->inset, 4); CHECK_EQ(dn2->inset, 10);
  // symmetric around the centre
  CHECK_EQ((sel->y - up1->y), (dn1->y + dn1->h) - (sel->y + sel->h));
  // ordered by index, every slot intersects the screen, no off-screen rows
  for (int i = 0; i < n; i++) {
    if (i) CHECK_EQ(s[i].index, s[i - 1].index + 1);
    CHECK(s[i].y < g.height && s[i].y + s[i].h > 0);
  }
  CHECK(find(s, n, 0) == NULL);  // far above the screen
}

static void test_edges(void) {
  WheelGeometry g;
  bus_wheel_geometry(&g, 144, 152, false);
  WheelSlot s[WHEEL_MAX_SLOTS];
  CHECK_EQ(bus_wheel_layout(&g, 0, 0, s, WHEEL_MAX_SLOTS), 0);
  int n = bus_wheel_layout(&g, 1, 0, s, WHEEL_MAX_SLOTS);
  CHECK_EQ(n, 1);
  CHECK_EQ(s[0].index, 0); CHECK_EQ(s[0].y, 41);
  // first row selected: nothing above it, still centred
  n = bus_wheel_layout(&g, 5, 0, s, WHEEL_MAX_SLOTS);
  CHECK_EQ(s[0].index, 0); CHECK_EQ(s[0].y, 41);
  // position is clamped into [0, (count-1)*1000]
  n = bus_wheel_layout(&g, 5, 99000, s, WHEEL_MAX_SLOTS);
  const WheelSlot *last = find(s, n, 4);
  CHECK(last && last->y == 41 && last->level == 0);
  n = bus_wheel_layout(&g, 5, -5000, s, WHEEL_MAX_SLOTS);
  CHECK(find(s, n, 0) && find(s, n, 0)->y == 41);
  // max_out respected
  CHECK(bus_wheel_layout(&g, 20, 10000, s, 2) <= 2);
}

static void test_animation(void) {
  WheelGeometry g;
  bus_wheel_geometry(&g, 144, 152, false);
  WheelSlot a[WHEEL_MAX_SLOTS], b[WHEEL_MAX_SLOTS];
  // halfway between rows 3 and 4: both are between level-0 and level-1 size, the two straddle the centre
  int n = bus_wheel_layout(&g, 10, 3500, a, WHEEL_MAX_SLOTS);
  const WheelSlot *r3 = find(a, n, 3), *r4 = find(a, n, 4);
  CHECK(r3 && r4);
  if (!(r3 && r4)) return;
  CHECK(r3->h > 34 && r3->h < 70);
  CHECK_EQ(r3->h, r4->h);
  CHECK_EQ(r3->y + r3->h, 76);  // boundary between them is exactly in the middle
  CHECK_EQ(r4->y, 76);
  // continuity: tiny steps move rows by at most a couple of pixels
  int prev_y = -1000;
  for (int p = 3000; p <= 4000; p += 25) {
    n = bus_wheel_layout(&g, 10, p, b, WHEEL_MAX_SLOTS);
    const WheelSlot *r = find(b, n, 4);
    CHECK(r != NULL);
    if (!r) return;
    if (prev_y != -1000) CHECK(abs(r->y - prev_y) <= 3);
    prev_y = r->y;
  }
  // heights shrink monotonically with distance from the (fractional) centre
  n = bus_wheel_layout(&g, 10, 4300, b, WHEEL_MAX_SLOTS);
  const WheelSlot *c4 = find(b, n, 4), *c5 = find(b, n, 5), *c6 = find(b, n, 6), *c3 = find(b, n, 3);
  CHECK(c3 && c4 && c5 && c6);
  if (c3 && c4 && c5 && c6) {
    CHECK(c4->h >= c5->h); CHECK(c5->h >= c3->h); CHECK(c3->h >= c6->h);
    CHECK_EQ(c4->level, 0); CHECK_EQ(c5->level, 1);
  }
}

static void test_round(void) {
  WheelGeometry g;
  bus_wheel_geometry(&g, 180, 180, true);
  WheelSlot s[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(&g, 10, 5000, s, WHEEL_MAX_SLOTS);
  const WheelSlot *sel = find(s, n, 5), *fr = find(s, n, 7);
  CHECK(sel && fr);
  if (!(sel && fr)) return;
  // on a round screen rows near the top/bottom edge are inset by the circle, more than on a rectangle
  CHECK(fr->inset > 10);
  CHECK(sel->inset < fr->inset);
  CHECK(sel->inset <= 8);  // only the chord of a 70 px row at the centre
}

int main(void) {
  test_geometry();
  test_static_layout();
  test_edges();
  test_animation();
  test_round();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
