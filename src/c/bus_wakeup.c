#include "bus_wakeup.h"
#include <string.h>

void bus_wakeup_init(BusWakeupList *w) {
  memset(w, 0, sizeof *w);
}

void bus_wakeup_begin(BusWakeupList *w, int n) {
  if (n < 0) n = 0;
  if (n > BUS_WAKEUP_MAX) n = BUS_WAKEUP_MAX;
  memset(w, 0, sizeof *w);
  w->active = true;
  w->count = (uint8_t)n;
}

bool bus_wakeup_set(BusWakeupList *w, int i, int32_t time, int32_t cookie) {
  if (!w->active || i < 0 || i >= w->count) return false;
  w->items[i].time = time;
  w->items[i].cookie = cookie;
  w->received |= (uint8_t)(1u << i);
  return true;
}

bool bus_wakeup_complete(const BusWakeupList *w) {
  if (!w->active) return false;
  uint8_t all = (uint8_t)((1u << w->count) - 1u);
  return (w->received & all) == all;
}

int bus_wakeup_plan(const BusWakeupList *w, int32_t now, BusWakeup *out, int max) {
  if (max > BUS_WAKEUP_MAX) max = BUS_WAKEUP_MAX;
  BusWakeup tmp[BUS_WAKEUP_MAX];
  int n = 0;
  for (int i = 0; i < w->count; i++) {
    if (!(w->received & (1u << i)) || w->items[i].time <= now) continue;
    // insertion sort by time (stable)
    int j = n++;
    while (j > 0 && tmp[j - 1].time > w->items[i].time) {
      tmp[j] = tmp[j - 1];
      j--;
    }
    tmp[j] = w->items[i];
  }
  for (int i = 1; i < n; i++) {
    if (tmp[i].time < tmp[i - 1].time + BUS_WAKEUP_GAP) tmp[i].time = tmp[i - 1].time + BUS_WAKEUP_GAP;
  }
  if (n > max) n = max < 0 ? 0 : max;
  for (int i = 0; i < n; i++) out[i] = tmp[i];
  return n;
}
