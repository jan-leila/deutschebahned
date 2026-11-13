#include "bus_marquee.h"

static uint32_t scroll_ms(int px) {
  return ((uint32_t)px * 1000u + BUS_MARQUEE_SPEED - 1) / BUS_MARQUEE_SPEED;  // ceil
}

uint32_t bus_marquee_cycle_ms(int text_w, int box_w) {
  return text_w > box_w ? BUS_MARQUEE_HOLD_MS + scroll_ms(text_w + BUS_MARQUEE_GAP) : 0;
}

int bus_marquee_offset(int text_w, int box_w, uint32_t elapsed_ms, uint32_t *wait_ms) {
  uint32_t wait = 0;
  int off = 0;
  uint32_t cycle = bus_marquee_cycle_ms(text_w, box_w);
  if (cycle) {
    int travel = text_w + BUS_MARQUEE_GAP;
    uint32_t t = elapsed_ms % cycle;
    if (t < BUS_MARQUEE_HOLD_MS) {
      wait = BUS_MARQUEE_HOLD_MS - t;
    } else {
      uint32_t st = t - BUS_MARQUEE_HOLD_MS;
      off = (int)(st * BUS_MARQUEE_SPEED / 1000u);
      if (off >= travel) {
        // (only in the last ms of a loop) the copy is back where the text started: same picture as offset 0
        off = 0;
        wait = cycle - t;
      } else {
        uint32_t next = ((uint32_t)(off + 1) * 1000u + BUS_MARQUEE_SPEED - 1) / BUS_MARQUEE_SPEED;  // next px
        wait = next - st;
        if (t + wait > cycle) wait = cycle - t;   // the loop ends (and holds again) first
      }
    }
  }
  if (wait_ms) *wait_ms = wait;
  return off;
}
