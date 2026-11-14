#include "bus_wheel.h"

void bus_wheel_geometry(WheelGeometry *g, int16_t width, int16_t height, bool round) {
  g->width = width;
  g->height = height;
  g->round = round;
  bool big = height >= 200;
  g->row_h[0] = big ? 84 : 70;  // level 0: route band + title + two lane lines beside the arrow column
  g->row_h[1] = big ? 42 : 34;
  g->row_h[2] = big ? 28 : 24;
  g->inset[0] = 0;
  g->inset[1] = 4;
  g->inset[2] = 10;
}

// num / den rounded to nearest (halves away from zero); den > 0.
static int32_t div_round(int32_t num, int32_t den) {
  return num >= 0 ? (num + den / 2) / den : -((-num + den / 2) / den);
}

// v[0] at d = 0, v[1] at d = 1000, v[2] at d >= 2000, linear in between, rounded to nearest.
static int16_t interp3(const int16_t v[3], int32_t d) {
  if (d <= 0) return v[0];
  if (d >= 2000) return v[2];
  if (d <= 1000) return (int16_t)(v[0] + div_round((v[1] - v[0]) * d, 1000));
  return (int16_t)(v[1] + div_round((v[2] - v[1]) * (d - 1000), 1000));
}

static uint32_t isqrt(uint32_t x) {
  uint32_t r = 0, bit = 1u << 30;
  while (bit > x) bit >>= 2;
  while (bit) {
    if (x >= r + bit) {
      x -= r + bit;
      r = (r >> 1) + bit;
    } else {
      r >>= 1;
    }
    bit >>= 2;
  }
  return r;
}

static int32_t dist(int i, int32_t pos) {
  int32_t d = (int32_t)i * 1000 - pos;
  return d < 0 ? -d : d;
}

static int16_t row_height(const WheelGeometry *g, int i, int32_t pos) {
  return interp3(g->row_h, dist(i, pos));
}

// Circle chord inset for a row spanning [y, y+h) on a round screen.
static int16_t chord_inset(const WheelGeometry *g, int32_t y, int32_t h) {
  int32_t r = g->width / 2, c = g->height / 2;
  int32_t a = y - c, b = y + h - c;
  if (a < 0) a = -a;
  if (b < 0) b = -b;
  int32_t dy = a > b ? a : b;
  if (dy > r) dy = r;
  return (int16_t)(r - (int32_t)isqrt((uint32_t)(r * r - dy * dy)));
}

int bus_wheel_layout(const WheelGeometry *g, int count, int32_t pos_milli, WheelSlot *out, int max_out) {
  if (count <= 0 || max_out <= 0) return 0;
  int32_t pos = pos_milli, max_pos = (int32_t)(count - 1) * 1000;
  if (pos < 0) pos = 0;
  if (pos > max_pos) pos = max_pos;
  int k = (int)(pos / 1000);
  int32_t f = pos - (int32_t)k * 1000;
  int32_t c = g->height / 2;
  int32_t hk = row_height(g, k, pos);
  int32_t hk1 = k + 1 < count ? row_height(g, k + 1, pos) : hk;
  int32_t yk = c - div_round(hk * 1000 + f * (hk + hk1), 2000);

  // Visible range [lo, hi] around k.
  int lo = k, hi = k;
  int32_t ylo = yk;
  while (lo > 0 && ylo > 0) {
    lo--;
    ylo -= row_height(g, lo, pos);
  }
  if (ylo + row_height(g, lo, pos) <= 0) {  // row lo ends above the screen
    ylo += row_height(g, lo, pos);
    lo++;
  }
  int32_t yhi_end = yk + hk;
  while (hi + 1 < count && yhi_end < g->height) {
    hi++;
    yhi_end += row_height(g, hi, pos);
  }
  // Keep at most max_out rows, trimming the side farther from the selection.
  while (hi - lo + 1 > max_out) {
    if (k - lo > hi - k) {
      ylo += row_height(g, lo, pos);
      lo++;
    } else {
      hi--;
    }
  }

  int n = 0;
  int32_t y = ylo;
  for (int i = lo; i <= hi; i++) {
    int32_t d = dist(i, pos);
    int16_t h = row_height(g, i, pos);
    int16_t inset = interp3(g->inset, d);
    if (g->round) {
      int16_t ci = chord_inset(g, y, h);
      if (ci > inset) inset = ci;
    }
    WheelSlot *s = &out[n++];
    s->index = (int16_t)i;
    s->y = (int16_t)y;
    s->h = h;
    s->inset = inset;
    s->level = (uint8_t)(d < 500 ? 0 : d < 1500 ? 1 : 2);
    y += h;
  }
  return n;
}

int16_t bus_wheel_space_above(const WheelGeometry *g) {
  int32_t top = g->height / 2 - div_round(g->row_h[0], 2);
  return (int16_t)(top > 0 ? top : 0);
}

int16_t bus_wheel_round_inset(const WheelGeometry *g, int32_t y, int32_t h) {
  return g->round ? chord_inset(g, y, h) : 0;
}
