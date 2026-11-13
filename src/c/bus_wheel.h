// Pure-C layout of the "rotating drum" list (no pebble.h, no floating point; host-tested). See CONTRACTS.md §11.
// Rows shrink and indent with distance from the (fractional) selected position, like the face of a turning drum.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define WHEEL_MAX_SLOTS 9

typedef struct {
  int16_t width, height;  // the wheel's drawing area
  bool round;             // round screen: rows are also inset by the circle
  int16_t row_h[3];       // row height at distance 0, 1, >=2 rows from the selection
  int16_t inset[3];       // horizontal inset (each side) at distance 0, 1, >=2
} WheelGeometry;

typedef struct {
  int16_t index;  // item index
  int16_t y;      // top, relative to the wheel area (may be negative for a partly visible row)
  int16_t h;      // height
  int16_t inset;  // horizontal inset on both sides
  uint8_t level;  // 0 selected, 1 neighbour, 2 fringe
} WheelSlot;

void bus_wheel_geometry(WheelGeometry *g, int16_t width, int16_t height, bool round);
// Lays out the rows visible at position pos_milli (selected index * 1000, fractional while animating).
// Writes at most max_out slots ordered by index; returns how many.
int bus_wheel_layout(const WheelGeometry *g, int count, int32_t pos_milli, WheelSlot *out, int max_out);
