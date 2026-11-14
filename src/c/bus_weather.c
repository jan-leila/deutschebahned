#include "bus_weather.h"
#include <stdio.h>
#include <string.h>

void bus_weather_init(BusWeather *w) {
  memset(w, 0, sizeof *w);
}

void bus_weather_set(BusWeather *w, int count, int32_t start, int now, int hi, int lo,
                     const uint8_t *temps, int ntemps, const uint8_t *rain, int nrain) {
  bus_weather_init(w);
  if (count < 0) count = 0;
  if (count > BUS_WEATHER_MAX) count = BUS_WEATHER_MAX;
  w->count = (uint8_t)count;
  w->start = start;
  w->now = (int16_t)now;
  w->hi = (int16_t)hi;
  w->lo = (int16_t)lo;
  for (int i = 0; i < count; i++) {
    w->temp[i] = (temps && i < ntemps) ? temps[i] : 128;
    uint8_t r = (rain && i < nrain) ? rain[i] : 0;
    w->rain[i] = r > 100 ? 100 : r;
  }
}

bool bus_weather_visible(const BusWeather *w, int32_t now) {
  return w->count > 0 && now < w->start + (int32_t)w->count * 3600;
}

void bus_weather_format(const BusWeather *w, char *now_buf, size_t now_n, char *hilo_buf, size_t hilo_n) {
  if (now_buf && now_n) snprintf(now_buf, now_n, "%d\xC2\xB0", (int)w->now);
  if (hilo_buf && hilo_n) snprintf(hilo_buf, hilo_n, "H %d\xC2\xB0 L %d\xC2\xB0", (int)w->hi, (int)w->lo);
}

int bus_weather_graph(const BusWeather *w, int16_t x, int16_t y, int16_t width, int16_t height,
                      BusWeatherHour *out, int max_out) {
  int n = w->count;
  if (n > max_out) n = max_out;
  if (n <= 0 || width <= 0 || height <= 0) return 0;
  int32_t bottom = (int32_t)y + height;
  for (int i = 0; i < n; i++) {
    int32_t x0 = x + (int32_t)i * width / w->count, x1 = x + (int32_t)(i + 1) * width / w->count;
    int32_t bar_x1 = x1 - x0 >= 3 ? x1 - 1 : x1;
    out[i].x0 = (int16_t)x0;
    out[i].x1 = (int16_t)bar_x1;
    out[i].top = (int16_t)(bottom - ((int32_t)w->rain[i] * height + 50) / 100);
    out[i].x = (int16_t)((x0 + x1) / 2);
    out[i].y = (int16_t)(y + ((int32_t)(255 - w->temp[i]) * (height - 1) + 127) / 255);
  }
  return n;
}
