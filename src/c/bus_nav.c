#include "bus_nav.h"
#include <string.h>

static void copy(char *dst, size_t n, const char *src) {
  if (!src) src = "";
  size_t k = strlen(src);
  if (k > n - 1) {
    k = n - 1;
    while (k > 0 && ((unsigned char)src[k] & 0xC0) == 0x80) k--;
  }
  memcpy(dst, src, k);
  dst[k] = 0;
}

void bus_nav_init(BusNav *n) {
  memset(n, 0, sizeof *n);
  n->bearing = -1;
}

static void clear_step(BusNavStep *s) {
  memset(s, 0, sizeof *s);
  s->color = -1;
  s->kind = BUS_NAV_INFO;
}

void bus_nav_begin(BusNav *n, int count) {
  if (count < 0) count = 0;
  if (count > BUS_NAV_MAX) count = BUS_NAV_MAX;
  n->count = (uint8_t)count;
  for (int i = 0; i < BUS_NAV_MAX; i++) clear_step(&n->steps[i]);
  if (n->current >= count) n->current = count > 0 ? count - 1 : 0;
}

bool bus_nav_set_step(BusNav *n, int index, int kind, const char *text, const char *sub, const char *dist,
                      const char *dir, int32_t color) {
  if (index < 0 || index >= n->count) return false;
  BusNavStep *s = &n->steps[index];
  s->present = true;
  s->kind = (kind >= BUS_NAV_WALK && kind <= BUS_NAV_TURN) ? (uint8_t)kind : BUS_NAV_INFO;
  copy(s->text, sizeof s->text, text);
  copy(s->sub, sizeof s->sub, sub);
  copy(s->dist, sizeof s->dist, dist);
  copy(s->dir, sizeof s->dir, dir);
  s->color = color;
  return true;
}

bool bus_nav_set_live(BusNav *n, int state, int current, const char *live_sub, const char *live_dist, int bearing) {
  if (state != BUS_NAV_GUIDING && state != BUS_NAV_ARRIVED) {
    bus_nav_init(n);
    return false;
  }
  bool was_open = n->state != BUS_NAV_CLOSED;
  int old = n->current;
  if (current >= n->count) current = n->count - 1;
  if (current < 0) current = 0;
  n->state = (uint8_t)state;
  n->current = current;
  copy(n->live_sub, sizeof n->live_sub, live_sub);
  copy(n->live_dist, sizeof n->live_dist, live_dist);
  n->bearing = (bearing >= 0 && bearing < 360) ? (int16_t)bearing : -1;
  return !was_open || old != current;
}

const BusNavStep *bus_nav_step(const BusNav *n, int index) {
  if (index < 0 || index >= n->count || !n->steps[index].present) return NULL;
  return &n->steps[index];
}

int bus_nav_row_count(const BusNav *n) {
  return n->count ? n->count : 1;
}

const char *bus_nav_kind_name(int kind) {
  switch (kind) {
    case BUS_NAV_WALK: return "WALK";
    case BUS_NAV_BOARD: return "BOARD";
    case BUS_NAV_RIDE: return "RIDE";
    case BUS_NAV_WAIT: return "WAIT";
    case BUS_NAV_ARRIVE: return "ARRIVE";
    case BUS_NAV_TURN: return "TURN";
    default: return "";
  }
}
