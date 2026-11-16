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

static void clear_step(BusNavStep *s) {
  memset(s, 0, sizeof *s);
  s->color = -1;
  s->kind = BUS_NAV_INFO;
  s->index = -1;
}

void bus_nav_init(BusNav *n) {
  memset(n, 0, sizeof *n);
  for (int i = 0; i < BUS_NAV_CACHE; i++) clear_step(&n->steps[i]);
  n->bearing = -1;
}

void bus_nav_window(int center, int count, int *lo, int *hi) {
  if (count < 0) count = 0;
  if (count > BUS_NAV_MAX_ROWS) count = BUS_NAV_MAX_ROWS;
  int l = center - BUS_NAV_WINDOW_BEFORE;
  if (l > count - BUS_NAV_CACHE) l = count - BUS_NAV_CACHE;
  if (l < 0) l = 0;
  *lo = l;
  *hi = l + BUS_NAV_CACHE < count ? l + BUS_NAV_CACHE : count;
}

void bus_nav_begin(BusNav *n, int count, int center) {
  if (count < 0) count = 0;
  if (count > BUS_NAV_MAX_ROWS) count = BUS_NAV_MAX_ROWS;
  n->count = (uint16_t)count;
  for (int i = 0; i < BUS_NAV_CACHE; i++) {
    BusNavStep *s = &n->steps[i];
    if (s->present && s->index >= count) clear_step(s);
    s->fresh = false;
  }
  if (n->current >= count) n->current = count > 0 ? count - 1 : 0;
  int lo, hi;
  bus_nav_window(center, count, &lo, &hi);
  n->cover_lo = (int16_t)lo;
  n->cover_hi = (int16_t)hi;
}

bool bus_nav_set_step(BusNav *n, int index, int kind, const char *text, const char *sub, const char *dist,
                      const char *dir, int32_t color, int rail) {
  if (index < 0 || index >= n->count) return false;
  BusNavStep *s = &n->steps[index % BUS_NAV_CACHE];
  s->present = true;
  s->fresh = true;
  s->index = (int16_t)index;
  s->kind = (kind >= BUS_NAV_WALK && kind <= BUS_NAV_FOLD) ? (uint8_t)kind : BUS_NAV_INFO;
  s->rail = (uint8_t)(rail & 0x3F);
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

static const BusNavStep *held(const BusNav *n, int index) {
  if (index < 0 || index >= n->count) return NULL;
  const BusNavStep *s = &n->steps[index % BUS_NAV_CACHE];
  return s->present && s->index == index ? s : NULL;
}

const BusNavStep *bus_nav_step(const BusNav *n, int index) {
  return held(n, index);
}

int bus_nav_row_count(const BusNav *n) {
  return n->count ? n->count : 1;
}

int bus_nav_fetch_for(BusNav *n, int sel) {
  if (n->count == 0) return -1;
  if (sel < 0) sel = 0;
  if (sel >= n->count) sel = n->count - 1;
  for (int r = sel - BUS_NAV_FETCH_NEAR; r <= sel + BUS_NAV_FETCH_NEAR; r++) {
    if (r < 0 || r >= n->count) continue;
    const BusNavStep *s = held(n, r);
    if ((s && s->fresh) || (r >= n->cover_lo && r < n->cover_hi)) continue;
    int lo, hi;
    bus_nav_window(sel, n->count, &lo, &hi);
    n->cover_lo = (int16_t)lo;
    n->cover_hi = (int16_t)hi;
    return sel;
  }
  return -1;
}

const char *bus_nav_kind_name(int kind) {
  switch (kind) {
    case BUS_NAV_WALK: return "WALK";
    case BUS_NAV_BOARD: return "BOARD";
    case BUS_NAV_RIDE: return "RIDE";
    case BUS_NAV_WAIT: return "WAIT";
    case BUS_NAV_ARRIVE: return "ARRIVE";
    case BUS_NAV_TURN: return "TURN";
    case BUS_NAV_STOP: return "STOP";
    default: return "";
  }
}
