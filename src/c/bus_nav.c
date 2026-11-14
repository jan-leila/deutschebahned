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
  n->color = -1;
}

bool bus_nav_set(BusNav *n, int state, const char *text, const char *sub, const char *dist, int bearing, int32_t color) {
  if (state != BUS_NAV_GUIDING && state != BUS_NAV_ARRIVED) {
    bus_nav_init(n);
    return false;
  }
  char old[BUS_NAV_TEXT_LEN];
  memcpy(old, n->text, sizeof old);
  bool was_open = n->state != BUS_NAV_CLOSED;
  n->state = (uint8_t)state;
  copy(n->text, sizeof n->text, text);
  copy(n->sub, sizeof n->sub, sub);
  copy(n->dist, sizeof n->dist, dist);
  n->bearing = (bearing >= 0 && bearing < 360) ? (int16_t)bearing : -1;
  n->color = color;
  return !was_open || strcmp(old, n->text) != 0;
}
