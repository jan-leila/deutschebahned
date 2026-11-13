// Pure-C horizontal "marquee" timing for text wider than its box (no pebble.h, no floating point; host-tested).
// One cycle: hold at the start, scroll left at BUS_MARQUEE_SPEED px/s until the end is visible, hold, jump back.
// After BUS_MARQUEE_CYCLES cycles the text rests at the start (no timer needed any more). See CONTRACTS.md §11.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_MARQUEE_HOLD_MS 1000
#define BUS_MARQUEE_SPEED 35    // px per second
#define BUS_MARQUEE_CYCLES 3

// Offset in px (>= 0, how far the text is shifted left) elapsed_ms after the marquee (re)started.
// *wait_ms (may be NULL) = ms until the offset next changes; 0 when it never will (text fits / cycles over).
int bus_marquee_offset(int text_w, int box_w, uint32_t elapsed_ms, uint32_t *wait_ms);
// ms one cycle takes (0 when the text fits).
uint32_t bus_marquee_cycle_ms(int text_w, int box_w);
