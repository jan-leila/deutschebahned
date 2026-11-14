// Pure-C weather panel model (no pebble.h, no floating point; host-tested). See CONTRACTS.md §17.
// The phone sends the next hours' temperatures already scaled to the panel's range (lo → 0 … hi → 255) and the
// chance of rain (0..100) per hour; this module keeps them and lays out the graph.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define BUS_WEATHER_MAX 24

typedef struct {
  uint8_t count;                 // hours, 0 = no weather (panel hidden)
  int32_t start;                 // epoch s of the first hour
  int16_t now, hi, lo;           // whole degrees in the watch's units
  uint8_t temp[BUS_WEATHER_MAX]; // scaled lo 0 … hi 255
  uint8_t rain[BUS_WEATHER_MAX]; // chance of rain, %
} BusWeather;

// One hour of the graph: its rain bar [x0, x1) × [top, bottom of the graph) and the temperature point (x, y).
typedef struct { int16_t x0, x1, top, x, y; } BusWeatherHour;

void bus_weather_init(BusWeather *w);
// count is clamped to BUS_WEATHER_MAX; hours missing from temps / rain (ntemps, nrain shorter) → 128 / 0; rain > 100 → 100.
void bus_weather_set(BusWeather *w, int count, int32_t start, int now, int hi, int lo,
                     const uint8_t *temps, int ntemps, const uint8_t *rain, int nrain);
// Shown while there is a forecast whose last hour hasn't ended yet.
bool bus_weather_visible(const BusWeather *w, int32_t now);
// "12°" and "H 15° L 4°" (UTF-8 degree sign).
void bus_weather_format(const BusWeather *w, char *now_buf, size_t now_n, char *hilo_buf, size_t hilo_n);
// Lays out the graph in the box (x, y, width, height): hour i gets the columns [x + i·width/n, x + (i+1)·width/n)
// minus a 1 px gap on the right when a column is ≥ 3 px wide; its rain bar rises rain% of the height from the
// bottom (y + height); its point sits at the column's middle, temp 255 at y, 0 at y + height - 1.
// Returns the number of hours written (≤ max_out; 0 when the box is empty).
int bus_weather_graph(const BusWeather *w, int16_t x, int16_t y, int16_t width, int16_t height,
                      BusWeatherHour *out, int max_out);
