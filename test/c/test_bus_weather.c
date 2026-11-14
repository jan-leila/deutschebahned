// Host-side tests for src/c/bus_weather.c — the weather panel model and graph layout (CONTRACTS.md §17).
#include <stdio.h>
#include <string.h>
#include "bus_weather.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, (got), (want)); } } while (0)

static void test_set_and_visible(void) {
  BusWeather w;
  bus_weather_init(&w);
  CHECK(!bus_weather_visible(&w, 0));
  uint8_t t[3] = { 0, 255, 100 }, r[2] = { 40, 250 };
  bus_weather_set(&w, 3, 1000, 12, 15, 4, t, 3, r, 2);
  CHECK_EQ(w.count, 3);
  CHECK_EQ(w.temp[1], 255);
  CHECK_EQ(w.rain[0], 40);
  CHECK_EQ(w.rain[1], 100);   // clamped
  CHECK_EQ(w.rain[2], 0);     // missing
  CHECK(bus_weather_visible(&w, 1000));
  CHECK(bus_weather_visible(&w, 1000 + 3 * 3600 - 1));
  CHECK(!bus_weather_visible(&w, 1000 + 3 * 3600));
  bus_weather_set(&w, 40, 0, 0, 0, 0, NULL, 0, NULL, 0);
  CHECK_EQ(w.count, BUS_WEATHER_MAX);
  CHECK_EQ(w.temp[5], 128);
  bus_weather_set(&w, 0, 0, 0, 0, 0, t, 3, r, 2);
  CHECK(!bus_weather_visible(&w, 0));
}

static void test_format(void) {
  BusWeather w;
  bus_weather_set(&w, 1, 0, -3, 15, -4, NULL, 0, NULL, 0);
  char a[12], b[28];
  bus_weather_format(&w, a, sizeof a, b, sizeof b);
  CHECK_STR(a, "-3\xC2\xB0");
  CHECK_STR(b, "H 15\xC2\xB0 L -4\xC2\xB0");
}

static void test_graph(void) {
  BusWeather w;
  uint8_t t[4] = { 0, 255, 128, 64 }, r[4] = { 0, 100, 50, 25 };
  bus_weather_set(&w, 4, 0, 0, 0, 0, t, 4, r, 4);
  BusWeatherHour h[BUS_WEATHER_MAX];
  CHECK_EQ(bus_weather_graph(&w, 10, 20, 40, 30, h, BUS_WEATHER_MAX), 4);
  // columns of 10 px, bars 9 px wide
  CHECK_EQ(h[0].x0, 10); CHECK_EQ(h[0].x1, 19); CHECK_EQ(h[0].x, 15);
  CHECK_EQ(h[3].x0, 40); CHECK_EQ(h[3].x1, 49); CHECK_EQ(h[3].x, 45);
  // rain: 0 % → top at the bottom (empty), 100 % → full height, 50 % → half
  CHECK_EQ(h[0].top, 50); CHECK_EQ(h[1].top, 20); CHECK_EQ(h[2].top, 35);
  // temperature: 0 at the bottom row, 255 at the top row
  CHECK_EQ(h[0].y, 49); CHECK_EQ(h[1].y, 20); CHECK_EQ(h[2].y, 34);
  // narrow columns keep no gap
  CHECK_EQ(bus_weather_graph(&w, 0, 0, 8, 10, h, BUS_WEATHER_MAX), 4);
  CHECK_EQ(h[0].x1, 2);
  CHECK_EQ(bus_weather_graph(&w, 0, 0, 0, 10, h, BUS_WEATHER_MAX), 0);
  CHECK_EQ(bus_weather_graph(&w, 0, 0, 40, 10, h, 2), 2);
}

int main(void) {
  test_set_and_visible();
  test_format();
  test_graph();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
