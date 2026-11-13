// Host-side tests for src/c/bus_arrow.c — direction arrow geometry (CONTRACTS.md §11).
#include <stdio.h>
#include <stdlib.h>
#include "bus_arrow.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)

static void test_angle(void) {
  CHECK_EQ(bus_arrow_angle(90, -1), 90);     // no heading: north-up
  CHECK_EQ(bus_arrow_angle(0, -1), 0);
  CHECK_EQ(bus_arrow_angle(90, 90), 0);      // facing the stop: straight up
  CHECK_EQ(bus_arrow_angle(0, 90), 270);     // stop to the north while facing east: left
  CHECK_EQ(bus_arrow_angle(10, 350), 20);
  CHECK_EQ(bus_arrow_angle(350, 10), 340);
  CHECK_EQ(bus_arrow_angle(720, 0), 0);
  CHECK_EQ(bus_arrow_angle(-90, -1), 270);
}

static void test_sin(void) {
  CHECK_EQ(bus_arrow_sin1024(0), 0);
  CHECK_EQ(bus_arrow_sin1024(90), 1024);
  CHECK_EQ(bus_arrow_sin1024(180), 0);
  CHECK_EQ(bus_arrow_sin1024(270), -1024);
  CHECK_EQ(bus_arrow_sin1024(30), 512);
  CHECK_EQ(bus_arrow_sin1024(-30), -512);
  CHECK_EQ(bus_arrow_sin1024(150), 512);
  CHECK_EQ(bus_arrow_sin1024(210), -512);
  CHECK_EQ(bus_arrow_sin1024(390), 512);
  // odd symmetry and sin(a + 180) = -sin(a) everywhere
  for (int a = 0; a < 360; a++) {
    CHECK_EQ(bus_arrow_sin1024(-a), -bus_arrow_sin1024(a));
    CHECK_EQ(bus_arrow_sin1024(a + 180), -bus_arrow_sin1024(a));
  }
}

static void test_points(void) {
  BusPoint p[4];
  bus_arrow_points(0, 50, 50, 10, p);  // up
  CHECK_EQ(p[0].x, 50); CHECK_EQ(p[0].y, 40);
  CHECK(p[1].x > 50 && p[1].y > 50);   // right wing below-right
  CHECK(p[3].x < 50 && p[3].y > 50);   // left wing below-left
  CHECK_EQ(p[1].x - 50, 50 - p[3].x);  // symmetric
  CHECK_EQ(p[1].y, p[3].y);
  CHECK_EQ(p[2].x, 50); CHECK_EQ(p[2].y, 54);  // notch behind the centre
  bus_arrow_points(90, 50, 50, 10, p);  // right
  CHECK_EQ(p[0].x, 60); CHECK_EQ(p[0].y, 50);
  bus_arrow_points(180, 50, 50, 10, p);  // down
  CHECK_EQ(p[0].x, 50); CHECK_EQ(p[0].y, 60);
  bus_arrow_points(270, 0, 0, 10, p);  // left
  CHECK_EQ(p[0].x, -10); CHECK_EQ(p[0].y, 0);
  // every point within r (+1) of the centre, any angle and size
  for (int r = 3; r <= 20; r += 1) {
    for (int a = 0; a < 360; a += 7) {
      bus_arrow_points(a, 100, 80, r, p);
      for (int i = 0; i < 4; i++) {
        int dx = p[i].x - 100, dy = p[i].y - 80;
        CHECK(dx * dx + dy * dy <= (r + 1) * (r + 1));
      }
    }
  }
}

int main(void) {
  test_angle();
  test_sin();
  test_points();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
