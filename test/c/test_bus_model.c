// Host-side tests for src/c/bus_model.c (no Pebble SDK needed). Built and run by test/c-model.test.js.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "bus_model.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: got \"%s\" want \"%s\"\n", __FILE__, __LINE__, (got), (want)); } } while (0)

// epoch for 2025-11-12 HH:MM:00 UTC (tests run with TZ=UTC)
static int32_t at(int h, int m) { return (int32_t)(1762905600 + h * 3600 + m * 60); }

static int valid_utf8(const char *s) {
  const unsigned char *p = (const unsigned char *)s;
  while (*p) {
    int n = (*p < 0x80) ? 0 : ((*p & 0xE0) == 0xC0) ? 1 : ((*p & 0xF0) == 0xE0) ? 2 : ((*p & 0xF8) == 0xF0) ? 3 : -1;
    if (n < 0) return 0;
    p++;
    for (int i = 0; i < n; i++, p++) if ((*p & 0xC0) != 0x80) return 0;
  }
  return 1;
}

static void test_model(void) {
  BusModel m;
  bus_model_init(&m);
  CHECK(m.list_id == -1);
  CHECK(m.count == 0);
  CHECK_STR(m.status, "Waiting for phone");
  CHECK(bus_model_row_count(&m) == 1);
  CHECK(bus_model_item(&m, 0) == NULL);

  bus_model_begin_list(&m, 7, 3);
  CHECK(m.list_id == 7 && m.count == 3);
  CHECK(bus_model_row_count(&m) == 3);
  CHECK(bus_model_item(&m, 0) == NULL);  // not received yet
  CHECK(bus_model_set_item(&m, 7, 1, BUS_KIND_DROPOFF, "44", "Home", 0x771473, 10, 20, 30));
  const BusItem *it = bus_model_item(&m, 1);
  CHECK(it != NULL);
  CHECK(it && it->kind == BUS_KIND_DROPOFF && it->t[0] == 10 && it->t[1] == 20 && it->t[2] == 30);
  CHECK_STR(it ? it->title : "", "Home");
  CHECK_STR(it ? it->badge : "", "44");
  CHECK(it && it->color == 0x771473);
  CHECK(!bus_model_set_item(&m, 6, 0, 0, "b", "stale", -1, 1, 2, 3));   // wrong list
  CHECK(!bus_model_set_item(&m, 7, 3, 0, "b", "oob", -1, 1, 2, 3));     // index >= count
  CHECK(!bus_model_set_item(&m, 7, -1, 0, "b", "neg", -1, 1, 2, 3));
  CHECK(bus_model_item(&m, 0) == NULL);
  CHECK(bus_model_item(&m, 3) == NULL && bus_model_item(&m, -1) == NULL);

  bus_model_begin_list(&m, 8, 99);
  CHECK(m.count == BUS_MAX_ITEMS);
  CHECK(bus_model_item(&m, 1) == NULL);  // cleared
  bus_model_begin_list(&m, 9, -4);
  CHECK(m.count == 0 && bus_model_row_count(&m) == 1);

  bus_model_begin_list(&m, 10, 4);
  CHECK(bus_model_clamp_selection(&m, 2) == 2);
  CHECK(bus_model_clamp_selection(&m, 9) == 3);
  CHECK(bus_model_clamp_selection(&m, -2) == 0);
  bus_model_begin_list(&m, 11, 0);
  CHECK(bus_model_clamp_selection(&m, 3) == 0);
}

static void test_truncation(void) {
  BusModel m;
  bus_model_init(&m);
  bus_model_begin_list(&m, 1, 1);
  char long_title[100];
  memset(long_title, 'x', sizeof long_title - 1);
  long_title[99] = 0;
  CHECK(bus_model_set_item(&m, 1, 0, 0, "LongBadge", long_title, -1, 0, 0, 0));
  CHECK(strlen(bus_model_item(&m, 0)->badge) == BUS_BADGE_LEN - 1);
  CHECK(bus_model_item(&m, 0)->color == -1);
  CHECK(strlen(bus_model_item(&m, 0)->title) == BUS_TITLE_LEN - 1);
  // 62 ASCII bytes + a 3-byte char would straddle the 63-byte limit: the char must be dropped whole
  char t2[96];
  memset(t2, 'a', 62);
  strcpy(t2 + 62, "\xE2\x82\xAC tail");
  bus_model_set_item(&m, 1, 0, 0, NULL, t2, -1, 0, 0, 0);
  CHECK_STR(bus_model_item(&m, 0)->badge, "");  // NULL badge -> empty
  CHECK(strlen(bus_model_item(&m, 0)->title) == 62);
  CHECK(valid_utf8(bus_model_item(&m, 0)->title));
  char s[100];
  memset(s, 0, sizeof s);
  for (int i = 0; i < 30; i++) memcpy(s + i * 2, "\xC3\xA9", 2);  // 60 bytes of é
  bus_model_set_status(&m, s);
  CHECK(strlen(m.status) == 46);
  CHECK(valid_utf8(m.status));
  bus_model_set_status(&m, "Updated 12:00");
  CHECK_STR(m.status, "Updated 12:00");
}

static void test_relative(void) {
  char b[16];
  bus_format_relative(-100, b, sizeof b); CHECK_STR(b, "now");
  bus_format_relative(30, b, sizeof b);   CHECK_STR(b, "now");
  bus_format_relative(31, b, sizeof b);   CHECK_STR(b, "1m");
  bus_format_relative(119, b, sizeof b);  CHECK_STR(b, "1m");
  bus_format_relative(720, b, sizeof b);  CHECK_STR(b, "12m");
  bus_format_relative(3599, b, sizeof b); CHECK_STR(b, "59m");
  bus_format_relative(3600, b, sizeof b); CHECK_STR(b, "1h00");
  bus_format_relative(3720, b, sizeof b); CHECK_STR(b, "1h02");
  bus_format_relative(7380, b, sizeof b); CHECK_STR(b, "2h03");
  char tiny[3];
  bus_format_relative(720, tiny, sizeof tiny); CHECK(strlen(tiny) <= 2);  // never overflows
}

static void test_clock(void) {
  char b[16];
  bus_format_clock(at(12, 43), true, b, sizeof b);  CHECK_STR(b, "12:43");
  bus_format_clock(at(7, 5), true, b, sizeof b);    CHECK_STR(b, "07:05");
  bus_format_clock(at(0, 9), true, b, sizeof b);    CHECK_STR(b, "00:09");
  bus_format_clock(at(7, 5), false, b, sizeof b);   CHECK_STR(b, "7:05");
  bus_format_clock(at(13, 30), false, b, sizeof b); CHECK_STR(b, "1:30");
  bus_format_clock(at(0, 9), false, b, sizeof b);   CHECK_STR(b, "12:09");
  bus_format_clock(at(12, 0), false, b, sizeof b);  CHECK_STR(b, "12:00");
}

static void test_color(void) {
  CHECK(bus_color_prefers_dark_text(0xFFFFFF));
  CHECK(bus_color_prefers_dark_text(0xFFFF00));
  CHECK(bus_color_prefers_dark_text(0x55FF55));
  CHECK(!bus_color_prefers_dark_text(0x000000));
  CHECK(!bus_color_prefers_dark_text(0x771473));
  CHECK(!bus_color_prefers_dark_text(0x0055AA));
  CHECK(!bus_color_prefers_dark_text(0xAA0000));
  CHECK(!bus_color_prefers_dark_text(-1));  // no color -> default dark badge, light text
}

static void test_walk(void) {
  char b[16];
  bus_format_walk(-1, b, sizeof b);   CHECK_STR(b, "");
  bus_format_walk(0, b, sizeof b);    CHECK_STR(b, "<1m walk");
  bus_format_walk(59, b, sizeof b);   CHECK_STR(b, "<1m walk");
  bus_format_walk(60, b, sizeof b);   CHECK_STR(b, "1m walk");
  bus_format_walk(61, b, sizeof b);   CHECK_STR(b, "2m walk");
  bus_format_walk(3599, b, sizeof b); CHECK_STR(b, "1h00 walk");
  bus_format_walk(3725, b, sizeof b); CHECK_STR(b, "1h03 walk");
  BusModel m;
  bus_model_init(&m);
  bus_model_begin_list(&m, 3, 1);
  CHECK(bus_model_set_item(&m, 3, 0, BUS_KIND_PICKUP, "2", "A", -1, 1, 0, 0));
  CHECK(bus_model_item(&m, 0)->walk == -1);
  CHECK(bus_model_set_walk(&m, 3, 0, 240));
  CHECK(bus_model_item(&m, 0)->walk == 240);
  CHECK(bus_model_set_walk(&m, 3, 0, -7));
  CHECK(bus_model_item(&m, 0)->walk == -1);
  CHECK(!bus_model_set_walk(&m, 4, 0, 10));
  CHECK(!bus_model_set_walk(&m, 3, 1, 10));
  bus_model_set_walk(&m, 3, 0, 99);
  CHECK(bus_model_set_item(&m, 3, 0, BUS_KIND_PICKUP, "2", "A", -1, 1, 0, 0));
  CHECK(bus_model_item(&m, 0)->walk == -1);   // a new item starts without one
}

static void test_dir_name(void) {
  CHECK_STR(bus_dir_name("NB"), "North");
  CHECK_STR(bus_dir_name("SB"), "South");
  CHECK_STR(bus_dir_name("EB"), "East");
  CHECK_STR(bus_dir_name("WB"), "West");
  CHECK_STR(bus_dir_name(""), "");
  CHECK_STR(bus_dir_name("XB"), "XB");
  CHECK_STR(bus_dir_name("N"), "N");
  CHECK_STR(bus_dir_name("NBX"), "NBX");
  CHECK_STR(bus_dir_name(NULL), "");
}

static void test_detail(void) {
  char b[64];
  int32_t now = at(12, 0);
  BusItem p = { .present = true, .kind = BUS_KIND_PICKUP, .title = "44 @ Pine", .t = { now + 10, now + 720, now + 3900 } };
  bus_format_detail(&p, now, true, b, sizeof b); CHECK_STR(b, "now, 12m, 1h05");
  BusItem p1 = { .present = true, .kind = BUS_KIND_PICKUP, .t = { now + 300, 0, 0 } };
  bus_format_detail(&p1, now, true, b, sizeof b); CHECK_STR(b, "5m");
  BusItem p0 = { .present = true, .kind = BUS_KIND_PICKUP, .t = { 0, 0, 0 } };
  bus_format_detail(&p0, now, true, b, sizeof b); CHECK_STR(b, "no times");

  BusItem d = { .present = true, .kind = BUS_KIND_DROPOFF, .t = { at(12, 43), at(12, 58), now + 240 } };
  bus_format_detail(&d, now, true, b, sizeof b); CHECK_STR(b, "off 12:43 \xC2\xB7 43m");  // ETA + time left to ride
  d.t[1] = 0;
  bus_format_detail(&d, now, true, b, sizeof b); CHECK_STR(b, "off 12:43 \xC2\xB7 43m");
  BusItem soon = { .present = true, .kind = BUS_KIND_DROPOFF, .t = { now + 20, 0, 0 } };
  bus_format_detail(&soon, now, true, b, sizeof b); CHECK_STR(b, "off 12:00 \xC2\xB7 now");
  BusItem n = { .present = true, .kind = BUS_KIND_DROPOFF, .t = { 0, at(12, 58), now + 720 } };
  bus_format_detail(&n, now, true, b, sizeof b); CHECK_STR(b, "12m, off 12:58");
  n.t[2] = 0;
  bus_format_detail(&n, now, true, b, sizeof b); CHECK_STR(b, "next off 12:58");
  BusItem pm = { .present = true, .kind = BUS_KIND_DROPOFF, .t = { at(13, 5), 0, 0 } };
  bus_format_detail(&pm, now, false, b, sizeof b); CHECK_STR(b, "off 1:05 \xC2\xB7 1h05");
  BusItem none = { .present = true, .kind = BUS_KIND_DROPOFF, .t = { 0, 0, 0 } };
  bus_format_detail(&none, now, true, b, sizeof b); CHECK_STR(b, "no buses");
  char tiny[6];
  bus_format_detail(&d, now, true, tiny, sizeof tiny); CHECK(strlen(tiny) <= 5);
  // planned trip leg: before departure board time, once riding the alighting time
  BusItem tr = { .present = true, .kind = BUS_KIND_TRIP, .t = { at(12, 4), at(12, 31), 0 } };
  bus_format_detail(&tr, now, true, b, sizeof b); CHECK_STR(b, "board 12:04 \xC2\xB7 4m");
  bus_format_detail(&tr, now, false, b, sizeof b); CHECK_STR(b, "board 12:04 \xC2\xB7 4m");
  tr.t[2] = 1;
  bus_format_detail(&tr, now, true, b, sizeof b); CHECK_STR(b, "off 12:31 \xC2\xB7 31m");
  tr.t[0] = now - 600;  // boarded in the past: irrelevant while riding
  bus_format_detail(&tr, now, true, b, sizeof b); CHECK_STR(b, "off 12:31 \xC2\xB7 31m");
  BusItem tb = { .present = true, .kind = BUS_KIND_TRIP, .t = { now + 10, at(13, 5), 0 } };
  bus_format_detail(&tb, now, false, b, sizeof b); CHECK_STR(b, "board 12:00 \xC2\xB7 now");
  tb.t[0] = 0;
  bus_format_detail(&tb, now, true, b, sizeof b); CHECK_STR(b, "no times");
  char cut[12];  // "off 12:43 \xC2\xB7" would split the middle dot at 11 bytes: dropped whole
  bus_format_detail(&d, now, true, cut, sizeof cut); CHECK(valid_utf8(cut)); CHECK(strlen(cut) <= 11);
}

static void test_geo(void) {
  BusModel m;
  bus_model_init(&m);
  bus_model_begin_list(&m, 3, 2);
  // defaults after begin_list / set_item: no bearing, one lane, empty strings
  CHECK(m.items[0].bearing == -1 && m.items[0].lanes == 1);
  CHECK(bus_model_set_item(&m, 3, 0, BUS_KIND_PICKUP, "2", "Franklin", 0x771473, 100, 200, 0));
  const BusItem *it = bus_model_item(&m, 0);
  CHECK(it->bearing == -1 && it->lanes == 1 && it->dist[0] == 0 && it->dir[0] == 0 && it->dir2[0] == 0);
  CHECK(it->u[0] == 0 && it->u[1] == 0 && it->u[2] == 0);

  CHECK(bus_model_set_geo(&m, 3, 0, 275, "350ft", "NB", 2, "SB", 11, 22, 33));
  CHECK(it->bearing == 275 && it->lanes == 2);
  CHECK_STR(it->dist, "350ft"); CHECK_STR(it->dir, "NB"); CHECK_STR(it->dir2, "SB");
  CHECK(it->u[0] == 11 && it->u[1] == 22 && it->u[2] == 33);
  // set_item resets the phase-3 fields
  CHECK(bus_model_set_item(&m, 3, 0, BUS_KIND_PICKUP, "2", "Franklin", 0x771473, 100, 200, 0));
  CHECK(it->bearing == -1 && it->lanes == 1 && it->dist[0] == 0 && it->u[0] == 0);

  // one lane: dir2 / u ignored; bad bearings -> -1; long strings cut
  CHECK(bus_model_set_geo(&m, 3, 0, 360, "1234567890", "EBXX", 1, "WB", 1, 2, 3));
  CHECK(it->bearing == -1 && it->lanes == 1 && it->dir2[0] == 0 && it->u[0] == 0);
  CHECK(strlen(it->dist) == BUS_DIST_LEN - 1); CHECK(strlen(it->dir) == BUS_DIR_LEN - 1);
  CHECK(bus_model_set_geo(&m, 3, 0, -1, NULL, NULL, 0, NULL, 0, 0, 0));
  CHECK(it->bearing == -1 && it->lanes == 1 && it->dist[0] == 0 && it->dir[0] == 0);
  CHECK(bus_model_set_geo(&m, 3, 0, 0, "", "", 3, "", 0, 0, 0));
  CHECK(it->bearing == 0 && it->lanes == 1);

  // route full name: set, cut at 63 bytes, reset by set_item
  CHECK(bus_model_set_route(&m, 3, 0, "Blue Line - Mpls - Airport - MOA"));
  CHECK_STR(it->route, "Blue Line - Mpls - Airport - MOA");
  char lr[100];
  memset(lr, 'r', 99); lr[99] = 0;
  CHECK(bus_model_set_route(&m, 3, 0, lr)); CHECK(strlen(it->route) == BUS_ROUTE_LEN - 1);
  CHECK(bus_model_set_route(&m, 3, 0, NULL)); CHECK_STR(it->route, "");
  bus_model_set_route(&m, 3, 0, "x");
  bus_model_set_item(&m, 3, 0, BUS_KIND_PICKUP, "2", "F", -1, 1, 0, 0); CHECK_STR(it->route, "");
  CHECK(!bus_model_set_route(&m, 4, 0, "x")); CHECK(!bus_model_set_route(&m, 3, 9, "x"));
  CHECK(!bus_model_set_geo(&m, 4, 0, 10, "x", "NB", 1, "", 0, 0, 0));  // wrong list
  CHECK(!bus_model_set_geo(&m, 3, 2, 10, "x", "NB", 1, "", 0, 0, 0));  // index >= count
  CHECK(!bus_model_set_geo(&m, 3, -1, 10, "x", "NB", 1, "", 0, 0, 0));
  bus_model_begin_list(&m, 5, 1);
  CHECK(m.items[0].bearing == -1 && m.items[0].lanes == 1 && m.items[0].dist[0] == 0);
}

static void test_lane(void) {
  char b[32];
  int32_t now = at(12, 0);
  int32_t a[3] = { now + 180, now + 720, 0 };
  bus_format_lane(a, now, b, sizeof b); CHECK_STR(b, "3m, 12m");
  int32_t c[3] = { 0, 0, now + 300 };
  bus_format_lane(c, now, b, sizeof b); CHECK_STR(b, "5m");
  int32_t z[3] = { 0, 0, 0 };
  bus_format_lane(z, now, b, sizeof b); CHECK_STR(b, "no times");
  // pickup detail is lane 0
  BusItem p = { .present = true, .kind = BUS_KIND_PICKUP, .t = { now + 180, now + 720, 0 }, .lanes = 2, .u = { now + 300, 0, 0 } };
  bus_format_detail(&p, now, true, b, sizeof b); CHECK_STR(b, "3m, 12m");
}

int main(void) {
  setenv("TZ", "UTC", 1);
  tzset();
  test_model();
  test_truncation();
  test_relative();
  test_clock();
  test_detail();
  test_dir_name();
  test_walk();
  test_color();
  test_geo();
  test_lane();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
