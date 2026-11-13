// Pure-C accumulation and planning of the wakeup list the phone sends (no pebble.h; host-tested). See CONTRACTS.md §11.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_WAKEUP_MAX 8    // Pebble allows 8 scheduled wakeups per app
#define BUS_WAKEUP_GAP 60   // Pebble refuses wakeups within a minute of each other

typedef struct { int32_t time; int32_t cookie; } BusWakeup;
typedef struct {
  bool active;        // a WAKEUP_COUNT header arrived and the list is not yet applied
  uint8_t count;      // expected entries (clamped 0..BUS_WAKEUP_MAX)
  uint8_t received;   // bit i set once entry i arrived
  BusWakeup items[BUS_WAKEUP_MAX];
} BusWakeupList;

void bus_wakeup_init(BusWakeupList *w);                 // inactive, empty
void bus_wakeup_begin(BusWakeupList *w, int n);         // WAKEUP_COUNT: starts a new list (n clamped 0..MAX)
bool bus_wakeup_set(BusWakeupList *w, int i, int32_t time, int32_t cookie);  // false when inactive / bad index
bool bus_wakeup_complete(const BusWakeupList *w);       // active and all n entries arrived (n = 0 -> at once)
// The received entries with time > now, sorted by time, each >= BUS_WAKEUP_GAP s after the previous one (later ones
// pushed back), at most min(max, BUS_WAKEUP_MAX). Returns how many were written.
int bus_wakeup_plan(const BusWakeupList *w, int32_t now, BusWakeup *out, int max);
