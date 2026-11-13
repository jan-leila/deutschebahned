#include "bus_arrow.h"

// sin(0..90 degrees) * 1024, rounded.
static const int16_t SIN_TABLE[91] = {
  0, 18, 36, 54, 71, 89, 107, 125, 143, 160, 178, 195, 213, 230, 248, 265, 282, 299, 316, 333, 350, 367, 384,
  400, 416, 433, 449, 465, 481, 496, 512, 527, 543, 558, 573, 587, 602, 616, 630, 644, 658, 672, 685, 698,
  711, 724, 737, 749, 761, 773, 784, 796, 807, 818, 828, 839, 849, 859, 868, 878, 887, 896, 904, 912, 920,
  928, 935, 943, 949, 956, 962, 968, 974, 979, 984, 989, 994, 998, 1002, 1005, 1008, 1011, 1014, 1016, 1018,
  1020, 1022, 1023, 1023, 1024, 1024
};

static int norm360(int a) {
  a %= 360;
  return a < 0 ? a + 360 : a;
}

int bus_arrow_angle(int bearing, int heading) {
  if (heading < 0) return norm360(bearing);
  return norm360(bearing - heading);
}

int bus_arrow_sin1024(int deg) {
  int a = norm360(deg);
  if (a <= 90) return SIN_TABLE[a];
  if (a <= 180) return SIN_TABLE[180 - a];
  if (a <= 270) return -SIN_TABLE[a - 180];
  return -SIN_TABLE[360 - a];
}

// num / 1024 rounded to nearest (halves away from zero).
static int div1024(int num) {
  return num >= 0 ? (num + 512) / 1024 : -((-num + 512) / 1024);
}

static BusPoint polar(int deg, int len, int cx, int cy) {
  BusPoint p;
  p.x = (int16_t)(cx + div1024(bus_arrow_sin1024(deg) * len));
  p.y = (int16_t)(cy - div1024(bus_arrow_sin1024(deg + 90) * len));
  return p;
}

void bus_arrow_points(int angle_deg, int cx, int cy, int r, BusPoint out[4]) {
  out[0] = polar(angle_deg, r, cx, cy);
  out[1] = polar(angle_deg + 140, r, cx, cy);
  out[2] = polar(angle_deg + 180, r * 2 / 5, cx, cy);
  out[3] = polar(angle_deg - 140, r, cx, cy);
}
