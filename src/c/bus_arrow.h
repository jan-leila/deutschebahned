// Pure-C direction arrow geometry (no pebble.h, no floating point; host-tested). See CONTRACTS.md §11.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

typedef struct { int16_t x, y; } BusPoint;  // same layout as Pebble's GPoint

// Screen angle of the arrow: (bearing - heading) normalized to [0, 360); heading -1 (unknown) -> bearing (north-up).
int bus_arrow_angle(int bearing, int heading);
// sin(deg) * 1024, rounded (any integer degrees).
int bus_arrow_sin1024(int deg);
// A notched arrow head pointing at angle_deg (0 = up, clockwise) centred on (cx, cy), every point within r (+1):
// out[0] tip, out[1] right wing, out[2] notch, out[3] left wing.
void bus_arrow_points(int angle_deg, int cx, int cy, int r, BusPoint out[4]);
