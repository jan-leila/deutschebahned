#include "bus_marquee.h"

static uint32_t scroll_ms(int over) {
  return ((uint32_t)over * 1000u + BUS_MARQUEE_SPEED - 1) / BUS_MARQUEE_SPEED;  // ceil
}

uint32_t bus_marquee_cycle_ms(int text_w, int box_w) {
  int over = text_w - box_w;
  return over > 0 ? 2u * BUS_MARQUEE_HOLD_MS + scroll_ms(over) : 0;
}

int bus_marquee_offset(int text_w, int box_w, uint32_t elapsed_ms, uint32_t *wait_ms) {
  uint32_t wait = 0;
  int off = 0, over = text_w - box_w;
  uint32_t cycle = bus_marquee_cycle_ms(text_w, box_w);
  if (cycle && elapsed_ms / cycle < BUS_MARQUEE_CYCLES) {
    uint32_t t = elapsed_ms % cycle, s = scroll_ms(over);
    if (t < BUS_MARQUEE_HOLD_MS) {
      wait = BUS_MARQUEE_HOLD_MS - t;
    } else if (t < BUS_MARQUEE_HOLD_MS + s) {
      uint32_t st = t - BUS_MARQUEE_HOLD_MS;
      off = (int)(st * BUS_MARQUEE_SPEED / 1000u);
      if (off >= over) {
        off = over;
        wait = cycle - t;
      } else {
        uint32_t next = ((uint32_t)(off + 1) * 1000u + BUS_MARQUEE_SPEED - 1) / BUS_MARQUEE_SPEED;  // next px
        wait = next - st;
      }
    } else {
      off = over;
      wait = cycle - t;
    }
    // the last cycle ends at rest: nothing more to wait for after its final jump back
  }
  if (wait_ms) *wait_ms = wait;
  return off;
}
