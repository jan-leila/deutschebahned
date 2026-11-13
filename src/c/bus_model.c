#include "bus_model.h"
#include <stdio.h>
#include <string.h>
#if defined(PBL_RECT) || defined(PBL_ROUND)
// The Pebble SDK builds with -D_TIME_H_ (newlib <time.h> disabled); struct tm and localtime() come from pebble.h.
#include <pebble.h>
#else
#include <time.h>
#endif

// Copy src into dst (capacity cap), NUL-terminated, never splitting a UTF-8 code point.
static void copy_utf8(char *dst, size_t cap, const char *src) {
  if (cap == 0) return;
  if (!src) src = "";
  size_t n = 0;
  while (n < cap - 1 && src[n]) n++;
  if (src[n]) {  // cut happened: back off to the start of a straddling code point
    while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
  }
  memcpy(dst, src, n);
  dst[n] = 0;
}

// Phase-3 defaults: no bearing, one lane, empty strings, no lane-2 times.
static void clear_geo(BusItem *it) {
  it->bearing = -1;
  it->lanes = 1;
  it->route[0] = 0;
  it->dist[0] = it->dir[0] = it->dir2[0] = 0;
  it->u[0] = it->u[1] = it->u[2] = 0;
}

void bus_model_init(BusModel *m) {
  memset(m, 0, sizeof *m);
  m->list_id = -1;
  copy_utf8(m->status, sizeof m->status, "Waiting for phone");
}

void bus_model_begin_list(BusModel *m, int32_t list_id, int count) {
  if (count < 0) count = 0;
  if (count > BUS_MAX_ITEMS) count = BUS_MAX_ITEMS;
  m->list_id = list_id;
  m->count = (uint8_t)count;
  memset(m->items, 0, sizeof m->items);
  for (int i = 0; i < BUS_MAX_ITEMS; i++) clear_geo(&m->items[i]);
}

bool bus_model_set_item(BusModel *m, int32_t list_id, int index, int kind, const char *badge,
                        const char *title, int32_t color, int32_t t0, int32_t t1, int32_t t2) {
  if (list_id != m->list_id || index < 0 || index >= m->count) return false;
  BusItem *it = &m->items[index];
  it->present = true;
  it->kind = (uint8_t)kind;
  copy_utf8(it->badge, sizeof it->badge, badge);
  copy_utf8(it->title, sizeof it->title, title);
  it->color = color;
  it->t[0] = t0;
  it->t[1] = t1;
  it->t[2] = t2;
  clear_geo(it);
  return true;
}

bool bus_model_set_route(BusModel *m, int32_t list_id, int index, const char *route) {
  if (list_id != m->list_id || index < 0 || index >= m->count) return false;
  copy_utf8(m->items[index].route, sizeof m->items[index].route, route);
  return true;
}

bool bus_model_set_geo(BusModel *m, int32_t list_id, int index, int32_t bearing, const char *dist, const char *dir,
                       int lanes, const char *dir2, int32_t u0, int32_t u1, int32_t u2) {
  if (list_id != m->list_id || index < 0 || index >= m->count) return false;
  BusItem *it = &m->items[index];
  it->bearing = (int16_t)(bearing >= 0 && bearing < 360 ? bearing : -1);
  copy_utf8(it->dist, sizeof it->dist, dist);
  copy_utf8(it->dir, sizeof it->dir, dir);
  if (lanes == 2) {
    it->lanes = 2;
    copy_utf8(it->dir2, sizeof it->dir2, dir2);
    it->u[0] = u0;
    it->u[1] = u1;
    it->u[2] = u2;
  } else {
    it->lanes = 1;
    it->dir2[0] = 0;
    it->u[0] = it->u[1] = it->u[2] = 0;
  }
  return true;
}

void bus_model_set_status(BusModel *m, const char *status) {
  copy_utf8(m->status, sizeof m->status, status);
}

int bus_model_row_count(const BusModel *m) {
  return m->count ? m->count : 1;
}

const BusItem *bus_model_item(const BusModel *m, int index) {
  if (index < 0 || index >= m->count || !m->items[index].present) return NULL;
  return &m->items[index];
}

int bus_model_clamp_selection(const BusModel *m, int sel) {
  int rows = bus_model_row_count(m);
  if (sel >= rows) sel = rows - 1;
  if (sel < 0) sel = 0;
  return sel;
}

bool bus_color_prefers_dark_text(int32_t rgb) {
  if (rgb < 0) return false;
  int32_t r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
  return 299 * r + 587 * g + 114 * b > 150 * 1000;
}

void bus_format_relative(int32_t seconds, char *buf, size_t n) {
  if (n == 0) return;
  if (seconds <= 30) {
    snprintf(buf, n, "now");
  } else if (seconds < 3600) {
    int mins = (int)(seconds / 60);
    if (mins < 1) mins = 1;
    snprintf(buf, n, "%dm", mins);
  } else {
    snprintf(buf, n, "%dh%02d", (int)(seconds / 3600), (int)((seconds % 3600) / 60));
  }
}

void bus_format_clock(int32_t epoch, bool clock24, char *buf, size_t n) {
  if (n == 0) return;
  time_t tt = (time_t)epoch;
  struct tm *tm = localtime(&tt);
  if (!tm) { snprintf(buf, n, "--:--"); return; }
  if (clock24) {
    snprintf(buf, n, "%02d:%02d", tm->tm_hour, tm->tm_min);
  } else {
    int h = tm->tm_hour % 12;
    snprintf(buf, n, "%d:%02d", h ? h : 12, tm->tm_min);
  }
}

// Append src to buf (capacity n) at *len, keeping NUL termination and never overflowing.
static void append(char *buf, size_t n, size_t *len, const char *src) {
  if (*len + 1 >= n) return;
  size_t room = n - 1 - *len, k = strlen(src);
  if (k > room) {  // cut, never inside a UTF-8 code point
    k = room;
    while (k > 0 && ((unsigned char)src[k] & 0xC0) == 0x80) k--;
  }
  memcpy(buf + *len, src, k);
  *len += k;
  buf[*len] = 0;
}

void bus_format_lane(const int32_t times[3], int32_t now, char *buf, size_t n) {
  if (n == 0) return;
  buf[0] = 0;
  size_t len = 0;
  char a[12];
  bool any = false;
  for (int i = 0; i < 3; i++) {
    if (!times[i]) continue;
    bus_format_relative(times[i] - now, a, sizeof a);
    if (any) append(buf, n, &len, ", ");
    append(buf, n, &len, a);
    any = true;
  }
  if (!any) append(buf, n, &len, "no times");
}

void bus_format_detail(const BusItem *it, int32_t now, bool clock24, char *buf, size_t n) {
  if (n == 0) return;
  if (it->kind == BUS_KIND_TRIP) {  // t0 board, t1 alight, t2 = 1 once riding
    char a[12], b[12];
    size_t len = 0;
    bool riding = it->t[2] != 0;
    int32_t t = riding ? it->t[1] : it->t[0];
    buf[0] = 0;
    if (!t) {
      append(buf, n, &len, riding ? "riding" : "no times");
      return;
    }
    bus_format_clock(t, clock24, a, sizeof a);
    bus_format_relative(t - now, b, sizeof b);
    append(buf, n, &len, riding ? "off " : "board ");
    append(buf, n, &len, a);
    append(buf, n, &len, " \xC2\xB7 ");
    append(buf, n, &len, b);
    return;
  }
  if (it->kind != BUS_KIND_DROPOFF) {
    bus_format_lane(it->t, now, buf, n);
    return;
  }
  buf[0] = 0;
  size_t len = 0;
  char a[12], b[12];
  int32_t t0 = it->t[0], t1 = it->t[1], t2 = it->t[2];
  if (t0) {  // on the bus: drop-off ETA and the time left to ride
    bus_format_clock(t0, clock24, a, sizeof a);
    bus_format_relative(t0 - now, b, sizeof b);
    append(buf, n, &len, "off ");
    append(buf, n, &len, a);
    append(buf, n, &len, " \xC2\xB7 ");  // middle dot
    append(buf, n, &len, b);
  } else if (t1) {
    bus_format_clock(t1, clock24, b, sizeof b);
    if (t2) {
      bus_format_relative(t2 - now, a, sizeof a);
      append(buf, n, &len, a);
      append(buf, n, &len, ", off ");
    } else {
      append(buf, n, &len, "next off ");
    }
    append(buf, n, &len, b);
  } else {
    append(buf, n, &len, "no buses");
  }
}
