// Deutschebahned — watch UI: a custom-drawn "rotating drum" list of the items the phone sends (see CONTRACTS.md §11).
// Layout math lives in bus_wheel.c; this file only draws slots, handles buttons, animation and AppMessage.
#include <pebble.h>
#include "bus_model.h"
#include "bus_wheel.h"
#include "bus_arrow.h"
#include "bus_wakeup.h"
#include "bus_marquee.h"
#include "bus_weather.h"
#include "bus_nav.h"
#include "bus_menu.h"

// Navigation (the nav window, CONTRACTS.md §18) needs RAM that Pebble Classic / Steel (aplite) does not have.
#if defined(PBL_PLATFORM_APLITE)
#define HAS_NAV 0
#else
#define HAS_NAV 1
#endif

#define STATUS_H 16
#define ROUND_STATUS_Y 4
#define ROUND_WHEEL_Y 20
#define BAR_H 3
#define REPEAT_MS 120
#define ANIM_MS 180
#define FRAME_MS 30
#define ARROW_COL_W 34   // level-0 arrow-over-distance column
#define ARROW_R_MAX 10
#define WAKEUP_RETRY_MS 2000
#define WAKEUP_RETRIES 15
#define ROUTE_BAND_H 15  // level-0 top band carrying the route full name (BAR_H when there is none)
#define BADGE_GAP 2      // min. white rows between the level-0 band and the route badge
#define TEST_MARQUEE_END 1000000000  // test hook value: marquee frozen at the end of its scroll
#define WEATHER_MIN_H 28 // the weather panel needs at least this much room above the first row

static Window *s_window;
static TextLayer *s_status_layer;
static Layer *s_wheel_layer;
static BusModel s_model;
static BusPlaces s_places;   // saved locations: unfolded into the wheel above the first row (UP from the top)
static bool s_places_open;   // they are: wheel rows 0..count-1 are the places, the list follows (s_sel / s_pos count them)
static BusItem s_place_tile; // the place being drawn, as a tile (bus_place_as_item)
static Layer *s_hud_layer;   // over the status line: the trip blip, the "places above" hint
static BusWeather s_weather;
#if HAS_NAV
static BusNav s_nav;
static Layer *s_nav_layer;
static AppTimer *s_nav_anim_timer;
#endif
static WheelGeometry s_geom;

static int s_sel;            // selected row
static int32_t s_pos;        // drawn position, milli-rows
static int32_t s_anim_from;  // animation start position
static uint32_t s_anim_start;
static AppTimer *s_anim_timer;

static GFont s_f14, s_f14b, s_f18, s_f18b, s_f24b;

static int s_heading = -1;  // clockwise compass heading in degrees, -1 = unknown (arrows north-up)
static GPoint s_arrow_points[4];
static GPathInfo s_arrow_info = { 4, s_arrow_points };
static GPath *s_arrow_path;

static BusWakeupList s_wakeups;
static bool s_wakeup_pending;     // a fired wakeup not yet reported to the phone
static int32_t s_wakeup_cookie;
static int s_wakeup_tries;
static AppTimer *s_wakeup_timer;

static uint32_t s_marquee_start;   // now_ms() when the selected row's marquee (re)starts
static AppTimer *s_marquee_timer;
static uint32_t s_marquee_wait;    // during a redraw: ms until some marquee changes (0 = none moving)
static bool s_focused = true;
// Test hook ({REFRESH: v} from the phone, used by tools/screenshots.sh): -1 = live clocks; >= 0 = marquee frozen at
// v ms (TEST_MARQUEE_END = at the end of its scroll) and moves jump without animating; <= -1000 = wheel frozen at
// (selection + (-v - 1000)/1000) rows, i.e. a mid-animation frame.
static int32_t s_test_marquee = -1;
// Test clock ({TEST_NOW: unix seconds} from the UI fixture): the "now" the rows' times are shown against, 0 = the
// real clock. The emulator ignores `pebble emu-set-time` while an app is running, so screenshots can't pin it there.
static int32_t s_test_now;

// ---- Animation --------------------------------------------------------------

static void fold_places_if_hidden(void);

static uint32_t now_ms(void) {
  time_t sec;
  uint16_t ms;
  time_ms(&sec, &ms);
  return (uint32_t)sec * 1000u + ms;
}

static void anim_step(void *data) {
  s_anim_timer = NULL;
  int32_t target = (int32_t)s_sel * 1000;
  uint32_t t = now_ms() - s_anim_start;
  if (t >= ANIM_MS) {
    s_pos = target;
    fold_places_if_hidden();
  } else {
    int32_t p = (int32_t)(t * 1000u / ANIM_MS);                  // linear progress 0..1000
    int32_t e = 1000 - (1000 - p) * (1000 - p) / 1000;           // quadratic ease-out
    s_pos = s_anim_from + (target - s_anim_from) * e / 1000;
    s_anim_timer = app_timer_register(FRAME_MS, anim_step, NULL);
  }
  if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
}

// Animate from the current (possibly mid-animation) position to the selected row.
static void animate_to_selection(void) {
  if (s_anim_timer) {
    app_timer_cancel(s_anim_timer);
    s_anim_timer = NULL;
  }
  s_anim_from = s_pos;
  s_anim_start = now_ms();
  s_marquee_start = s_anim_start + ANIM_MS;  // the new row's marquee starts once it has arrived
  anim_step(NULL);
}

static void jump_to_selection(void) {
  if (s_anim_timer) {
    app_timer_cancel(s_anim_timer);
    s_anim_timer = NULL;
  }
  s_pos = (int32_t)s_sel * 1000;
}

// ---- Drawing ----------------------------------------------------------------

static GColor route_color(int32_t rgb) {
#if defined(PBL_COLOR)
  return rgb < 0 ? GColorCobaltBlue : GColorFromHEX((uint32_t)rgb);
#else
  (void)rgb;
  return GColorBlack;
#endif
}

static GColor badge_text_color(int32_t rgb) {
#if defined(PBL_COLOR)
  return bus_color_prefers_dark_text(rgb) ? GColorBlack : GColorWhite;
#else
  (void)rgb;
  return GColorWhite;
#endif
}

// Gothic fonts leave blank space above the glyphs; these approximate it so text can be centred visually.
typedef struct { GFont font; int16_t top, cap, line; } FontMetrics;

static FontMetrics font_info(GFont f) {
  if (f == s_f24b) return (FontMetrics){ f, 8, 16, 28 };
  if (f == s_f18 || f == s_f18b) return (FontMetrics){ f, 6, 12, 22 };
  return (FontMetrics){ f, 4, 10, 18 };
}

// Draws text in a single line whose glyph middle is at cy.
static void draw_line(GContext *ctx, const char *text, GFont font, int16_t x, int16_t w, int16_t cy,
                      GTextAlignment align) {
  FontMetrics fi = font_info(font);
  GRect r = GRect(x, cy - fi.cap / 2 - fi.top, w, fi.line);
  graphics_draw_text(ctx, text, font, r, GTextOverflowModeTrailingEllipsis, align, NULL);
}

static int16_t text_width(const char *text, GFont font) {
  FontMetrics fi = font_info(font);
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, 1200, fi.line),
                                               GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft).w;
}

static int16_t badge_text_width(const char *badge, GFont font, int16_t max_w) {
  if (!badge[0]) return 0;
  FontMetrics fi = font_info(font);
  int16_t pad = fi.cap >= 12 ? 5 : 3;
  int16_t w = text_width(badge, font) + 2 * pad, h = fi.cap + 2 * pad + 1;
  if (w < h) w = h;
  return w > max_w ? max_w : w;
}

static int16_t badge_width(const BusItem *it, GFont font, int16_t max_w) {
  return badge_text_width(it->badge, font, max_w);
}

// Route badge: rounded rect in the route color centred on cy; returns its width (0 when there is no badge).
// The badge never reaches above min_y: when the room above cy is short it shrinks vertically (still centred on cy,
// never below the glyph height) so it cannot run into the level-0 route band / top bar.
static int16_t draw_badge_text(GContext *ctx, const char *badge, int32_t color, GFont font, int16_t x, int16_t cy,
                               int16_t max_w, int16_t min_y) {
  int16_t w = badge_text_width(badge, font, max_w);
  if (!w) return 0;
  FontMetrics fi = font_info(font);
  int16_t pad = fi.cap >= 12 ? 5 : 3;
  int16_t h = fi.cap + 2 * pad + 1;
  int32_t room = 2 * ((int32_t)cy - min_y);
  if (h > room) h = room < fi.cap + 3 ? fi.cap + 3 : (int16_t)room;
  graphics_context_set_fill_color(ctx, route_color(color));
  graphics_fill_rect(ctx, GRect(x, cy - h / 2, w, h), 4, GCornersAll);
  graphics_context_set_text_color(ctx, badge_text_color(color));
  draw_line(ctx, badge, font, x, w, cy, GTextAlignmentCenter);
  return w;
}

static int16_t draw_badge(GContext *ctx, const BusItem *it, GFont font, int16_t x, int16_t cy, int16_t max_w,
                          int16_t min_y) {
  return draw_badge_text(ctx, it->badge, it->color, font, x, cy, max_w, min_y);
}

static uint32_t marquee_elapsed(void) {
  if (s_test_marquee >= 0) return (uint32_t)s_test_marquee;
  uint32_t now = now_ms();
  return (int32_t)(now - s_marquee_start) > 0 ? now - s_marquee_start : 0;
}

static void fill_span(GContext *ctx, GColor c, int16_t x0, int16_t x1, int16_t y0, int16_t y1) {
  if (x1 <= x0 || y1 <= y0) return;
  graphics_context_set_fill_color(ctx, c);
  graphics_fill_rect(ctx, GRect(x0, y0, x1 - x0, y1 - y0), 0, GCornerNone);
}

// One line of text in the box [bx, bx + bw), glyph middle at cy (text colour already set). Text wider than the box
// scrolls (bus_marquee); the overflow is clipped by repainting rows [y0, y1) outside the box: `inner` over the
// tile [mx0, mx1), white beyond it. Anything else on those rows (badge...) must be drawn afterwards.
static void draw_marquee(GContext *ctx, const char *text, GFont font, int16_t bx, int16_t bw, int16_t cy,
                         int16_t y0, int16_t y1, int16_t mx0, int16_t mx1, GColor inner, int16_t layer_w) {
  int16_t tw = text_width(text, font);
  if (tw <= bw) {
    draw_line(ctx, text, font, bx, bw, cy, GTextAlignmentLeft);
    return;
  }
  uint32_t wait = 0;
  int off;
  if (s_test_marquee >= TEST_MARQUEE_END) off = tw - bw;
  else off = bus_marquee_offset(tw, bw, marquee_elapsed(), &wait);
  if (s_test_marquee >= 0) wait = 0;
  if (wait && (!s_marquee_wait || wait < s_marquee_wait)) s_marquee_wait = wait;
  draw_line(ctx, text, font, bx - off, tw + 4, cy, GTextAlignmentLeft);
  // the loop's next copy, following the text after a gap (bus_marquee): it comes round to where the text started
  int16_t x2 = bx - off + tw + BUS_MARQUEE_GAP;
  if (x2 < bx + bw) draw_line(ctx, text, font, x2, tw + 4, cy, GTextAlignmentLeft);
  fill_span(ctx, inner, mx0, bx, y0, y1);
  fill_span(ctx, inner, bx + bw, mx1, y0, y1);
  fill_span(ctx, GColorWhite, 0, mx0, y0, y1);
  fill_span(ctx, GColorWhite, mx1, layer_w, y0, y1);
}

// A pickup time sooner than the walk to the stop plus the dead zone (it->lead): the bus can't be caught.
static bool time_hurried(const BusItem *it, int32_t t, int32_t now) {
  return it->kind == BUS_KIND_PICKUP && it->lanes != 2 && it->lead >= 0 && t && t - now < it->lead;
}

// The pickup times line ("now, 12m, 1h05"), each hurried time in a route-color pill like the badge. Pills don't
// scroll: returns false (nothing drawn) when no time is hurried or the line is wider than w.
static bool draw_times(GContext *ctx, const BusItem *it, int32_t now, GFont font, int16_t x, int16_t w, int16_t cy,
                       GColor fg) {
  FontMetrics fi = font_info(font);
  const int16_t pad = 2;
  char s[3][12];
  bool hurried[3], any_hurried = false, any = false;
  int16_t total = 0;
  for (int i = 0; i < 3; i++) {
    s[i][0] = 0;
    hurried[i] = false;
    if (!it->t[i]) continue;
    bus_format_relative(it->t[i] - now, s[i], sizeof s[i]);
    hurried[i] = time_hurried(it, it->t[i], now);
    any_hurried |= hurried[i];
    total += text_width(s[i], font) + (hurried[i] ? 2 * pad : 0) + (any ? text_width(", ", font) : 0);
    any = true;
  }
  if (!any_hurried || total > w) return false;
  int16_t cx = x;
  bool first = true;
  for (int i = 0; i < 3; i++) {
    if (!s[i][0]) continue;
    if (!first) {
      graphics_context_set_text_color(ctx, fg);
      int16_t sw = text_width(", ", font);
      draw_line(ctx, ", ", font, cx, sw + 2, cy, GTextAlignmentLeft);
      cx += sw;
    }
    first = false;
    int16_t tw = text_width(s[i], font);
    if (hurried[i]) {
      graphics_context_set_fill_color(ctx, route_color(it->color));
      graphics_fill_rect(ctx, GRect(cx, cy - (fi.cap + 5) / 2, tw + 2 * pad, fi.cap + 5), 3, GCornersAll);
      graphics_context_set_text_color(ctx, badge_text_color(it->color));
      draw_line(ctx, s[i], font, cx + pad, tw + 2, cy, GTextAlignmentLeft);
      cx += tw + 2 * pad;
    } else {
      graphics_context_set_text_color(ctx, fg);
      draw_line(ctx, s[i], font, cx, tw + 2, cy, GTextAlignmentLeft);
      cx += tw;
    }
  }
  return true;
}

// Arrow pointing at a stop, filled with the route color (black on B&W), outlined when the color is light.
static void draw_arrow_at(GContext *ctx, int bearing, int32_t color, int16_t cx, int16_t cy, int16_t r) {
  BusPoint p[4];
  bus_arrow_points(bus_arrow_angle(bearing, s_heading), cx, cy, r, p);
  for (int i = 0; i < 4; i++) s_arrow_points[i] = GPoint(p[i].x, p[i].y);
  graphics_context_set_fill_color(ctx, route_color(color));
  gpath_draw_filled(ctx, s_arrow_path);
#if defined(PBL_COLOR)
  if (bus_color_prefers_dark_text(color)) {
    graphics_context_set_stroke_color(ctx, GColorBlack);
    gpath_draw_outline(ctx, s_arrow_path);
  }
#endif
}

static void draw_arrow(GContext *ctx, const BusItem *it, int16_t cx, int16_t cy, int16_t r) {
  draw_arrow_at(ctx, it->bearing, it->color, cx, cy, r);
}

// Small direction label ("North") right of the badge; returns the width used (incl. spacing), 0 when none.
static int16_t draw_dir(GContext *ctx, const char *code, GFont font, int16_t x, int16_t cy, GColor color) {
  const char *dir = bus_dir_name(code);
  if (!dir[0]) return 0;
  int16_t w = text_width(dir, font);
  graphics_context_set_text_color(ctx, color);
  draw_line(ctx, dir, font, x, w + 2, cy, GTextAlignmentLeft);
  return w + 4;
}

// What wheel row `row` shows: a saved location (as a tile) while they are unfolded, else a list tile.
static int places_rows(void) {
  return s_places_open ? s_places.count : 0;
}

static int view_rows(void) {
  return places_rows() + s_model.count;
}

static bool row_is_place(int row) {
  return row >= 0 && row < places_rows();
}

static const BusItem *row_item(int row) {
  if (!row_is_place(row)) return bus_model_item(&s_model, row - places_rows());
  const BusPlace *pl = bus_places_at_row(&s_places, row);
  if (!pl) return NULL;
  bus_place_as_item(pl, &s_place_tile);
  return &s_place_tile;
}

static void draw_slot(GContext *ctx, const WheelSlot *s, int16_t width) {
  const BusItem *it = row_item(s->index);
  int16_t x = s->inset, w = width - 2 * s->inset;
  if (w <= 8) return;

  int16_t pad = s->level == 0 ? 4 : 3;
  int16_t ix = x + pad, iw = w - 2 * pad;
  // Level 0: a route-color band on top (holding the route's full name when there is one) and a bar below.
  // (A place's address goes on its detail line instead.)
  int16_t band_h = s->level == 0 ? (it && it->route[0] && it->kind != BUS_KIND_PLACE ? ROUTE_BAND_H : BAR_H) : 0;
  if (s->level == 0) {
    GColor rc = route_color(it ? it->color : -1);
    fill_span(ctx, rc, x, x + w, s->y, s->y + band_h);
    fill_span(ctx, rc, x, x + w, s->y + s->h - BAR_H, s->y + s->h);
    if (band_h > BAR_H) {
      graphics_context_set_text_color(ctx, badge_text_color(it->color));
      draw_marquee(ctx, it->route, s_f14, ix, iw, s->y + band_h / 2, s->y, s->y + band_h, x, x + w, rc, width);
      // descenders that slipped below the band, outside the box
      fill_span(ctx, GColorWhite, 0, ix, s->y + band_h, s->y + band_h + 3);
      fill_span(ctx, GColorWhite, ix + iw, width, s->y + band_h, s->y + band_h + 3);
    }
  }
  int16_t top = s->y + band_h, bottom = s->y + s->h - (s->level == 0 ? BAR_H : 0);
  int16_t ih = bottom - top;

  GColor fg = GColorBlack, dim = GColorBlack;
#if defined(PBL_COLOR)
  dim = GColorDarkGray;
  if (s->level == 2) fg = GColorDarkGray;
#endif

  if (!it) {
    graphics_context_set_text_color(ctx, fg);
    draw_line(ctx, "...", s->level == 0 ? s_f18b : s_f14, ix, iw, top + ih / 2, GTextAlignmentLeft);
    return;
  }

  GFont badge_font = s->level == 0 ? s_f18b : s_f14b;
  GFont title_font = s->level == 0 ? s_f24b : s->level == 1 ? s_f18b : s_f14;
  GFont detail_font = s->level == 0 ? s_f18 : s_f14;
  FontMetrics tfi = font_info(title_font), dfi = font_info(detail_font), sfi = font_info(s_f14);
  bool two = it->kind == BUS_KIND_PICKUP && it->lanes == 2;
  bool has_arrow = it->bearing >= 0, has_dist = it->dist[0] != 0;
  // Layout mode (rows shrink continuously while animating, so pick by the space actually there):
  //   'A' level 0: title, then two lines (lanes, or the detail centred) beside an arrow-over-distance column
  //   'B' title + one detail line, arrow and distance inline at its right end
  //   'C' title only
  char mode = 'C';
  if (s->level == 0 && ih >= tfi.cap + 2 * dfi.cap + 12) mode = 'A';
  else if (s->level < 2 && ih >= tfi.cap + dfi.cap + 8) mode = 'B';

  int16_t title_cy, line1_cy = 0, line2_cy = 0, lower_top = 0;
  if (mode == 'A') {
    int16_t gap = (ih - tfi.cap - 2 * dfi.cap) / 4;
    title_cy = top + gap + tfi.cap / 2;
    lower_top = top + gap + tfi.cap;
    line1_cy = lower_top + gap + dfi.cap / 2;
    line2_cy = line1_cy + dfi.cap + gap;
  } else if (mode == 'B') {
    int16_t gap = (ih - tfi.cap - dfi.cap) / 3;
    title_cy = top + gap + tfi.cap / 2;
    line1_cy = bottom - gap - dfi.cap / 2;
  } else {
    title_cy = top + ih / 2;
  }

  // Title line: badge, direction label (not on a level-0 two-lane tile: its lane lines carry the labels), title.
  // The selected row's title scrolls when it is too wide; the others are cut with an ellipsis.
  GFont dir_font = s->level == 0 ? s_f18b : s_f14b;
  bool show_dir = s->level < 2 && !(mode == 'A' && two) && it->dir[0];
  // Planned-trip legs: an inverted "TRIP" pill before the badge on every level, and a route-colour frame.
  bool trip = it->kind == BUS_KIND_TRIP;
  int16_t pill_w = trip ? text_width("TRIP", s_f14b) + 6 : 0, bx = ix + (pill_w ? pill_w + 3 : 0);
  int16_t bw = badge_width(it, badge_font, iw / 2);
  int16_t tx = bx + (bw ? bw + 4 : 0) + (show_dir ? text_width(bus_dir_name(it->dir), dir_font) + 4 : 0);
  int16_t tw = ix + iw - tx;
  graphics_context_set_text_color(ctx, fg);
  if (s->level == 0) {
    int16_t y0 = title_cy - tfi.cap / 2 - tfi.top, y1 = mode == 'C' ? bottom : line1_cy - dfi.cap / 2 - 1;
    if (y0 < top) y0 = top;
    draw_marquee(ctx, it->title, title_font, tx, tw, title_cy, y0, y1, x, x + w, GColorWhite, width);
    // Descenders (the 'y' of "Lyndale") reach below y1; clear them beside the box down to the title's line bottom.
    // Safe: the badge, direction label, details and arrow are all drawn after this.
    int16_t ly1 = title_cy - tfi.cap / 2 - tfi.top + tfi.line;
    if (ly1 > bottom) ly1 = bottom;
    fill_span(ctx, GColorWhite, 0, tx, y1, ly1);
    fill_span(ctx, GColorWhite, tx + tw, width, y1, ly1);
  } else {
    draw_line(ctx, it->title, title_font, tx, tw, title_cy, GTextAlignmentLeft);
  }
  if (trip) {
    fill_span(ctx, GColorWhite, ix, bx, title_cy - 8, title_cy + 8);
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, GRect(ix, title_cy - 7, pill_w, 15), 3, GCornersAll);
    graphics_context_set_text_color(ctx, GColorWhite);
    draw_line(ctx, "TRIP", s_f14b, ix, pill_w, title_cy, GTextAlignmentCenter);
    GColor rc = route_color(it->color);
    if (s->level == 0) {
      fill_span(ctx, rc, x, x + 2, s->y, s->y + s->h);
      fill_span(ctx, rc, x + w - 2, x + w, s->y, s->y + s->h);
    } else {
      graphics_context_set_stroke_color(ctx, rc);
      graphics_draw_rect(ctx, GRect(x, s->y + 1, w, s->h - 2));
    }
  }
  // Keep the selected row's badge BADGE_GAP px clear of its route band / top bar.
  draw_badge(ctx, it, badge_font, bx, title_cy, iw / 2, s->level == 0 ? top + BADGE_GAP : INT16_MIN);
  if (show_dir) draw_dir(ctx, it->dir, dir_font, bx + (bw ? bw + 4 : 0), title_cy, s->level == 0 ? fg : dim);
  if (mode == 'C') return;

  int32_t now = s_test_now ? s_test_now : (int32_t)time(NULL);
  char buf[48];
  GColor detail_color = s->level == 0 ? GColorBlack : dim;
  // Walking time to the stop ("4m walk"), right-aligned in the times line just left of the arrow column.
  char walk[16];
  bus_format_walk(it->walk, walk, sizeof walk);
  int16_t walk_w = walk[0] ? text_width(walk, s_f14) : 0;
  if (mode == 'A') {
    int16_t colw = (has_arrow || has_dist) ? ARROW_COL_W : 0, lw = iw - colw;
    int16_t walk_cy = two ? line1_cy : (line1_cy + line2_cy) / 2;   // lane 0 is the stop the time is for
    int16_t lw1 = walk_w ? lw - walk_w - 6 : lw;   // the times line that carries the walking time
    // Times lines that don't fit scroll in a loop like the title (level 0 is the selected row). The marquee repaints
    // its rows outside the box, so the walking time and the arrow column are drawn after them.
    int16_t half = dfi.cap / 2 + 4;
#define CLIP0(cy) ((cy) - half < lower_top ? lower_top : (cy) - half)
#define CLIP1(cy) ((cy) + half > bottom ? bottom : (cy) + half)
    graphics_context_set_text_color(ctx, detail_color);
    if (two) {
      char lane[40];
      bus_format_lane(it->t, now, lane, sizeof lane);
      snprintf(buf, sizeof buf, "%s%s%s", bus_dir_name(it->dir), it->dir[0] ? " " : "", lane);
      draw_marquee(ctx, buf, detail_font, ix, lw1, line1_cy, CLIP0(line1_cy), CLIP1(line1_cy), x, x + w, GColorWhite, width);
      bus_format_lane(it->u, now, lane, sizeof lane);
      snprintf(buf, sizeof buf, "%s%s%s", bus_dir_name(it->dir2), it->dir2[0] ? " " : "", lane);
      draw_marquee(ctx, buf, detail_font, ix, lw, line2_cy, CLIP0(line2_cy), CLIP1(line2_cy), x, x + w, GColorWhite, width);
    } else {
      if (!draw_times(ctx, it, now, detail_font, ix, lw1, walk_cy, detail_color)) {
        bus_format_detail(it, now, clock_is_24h_style(), buf, sizeof buf);
        draw_marquee(ctx, buf, detail_font, ix, lw1, walk_cy, CLIP0(walk_cy), CLIP1(walk_cy), x, x + w, GColorWhite, width);
      }
    }
#undef CLIP0
#undef CLIP1
    if (walk_w) {
      graphics_context_set_text_color(ctx, detail_color);
      draw_line(ctx, walk, s_f14, ix + lw - walk_w - 2, walk_w + 2, walk_cy, GTextAlignmentRight);
    }
    if (colw) {
      int16_t cx = ix + iw - colw / 2, dist_cy = line2_cy + 1;
      int16_t atop = lower_top + 1, abot = has_dist ? dist_cy - sfi.cap / 2 - 2 : bottom - 2;
      if (has_arrow) {
        int16_t r = (abot - atop) / 2;
        if (r > ARROW_R_MAX) r = ARROW_R_MAX;
        if (r >= 3) draw_arrow(ctx, it, cx, (atop + abot) / 2, r);
      }
      if (has_dist) {
        if (!has_arrow) dist_cy = (line1_cy + line2_cy) / 2;
        graphics_context_set_text_color(ctx, GColorBlack);
        draw_line(ctx, it->dist, s_f14, ix + iw - colw - 4, colw + 8, dist_cy, GTextAlignmentCenter);
      }
    }
  } else {  // 'B': detail with [arrow][distance] at its right end
    int16_t right = ix + iw;
    if (has_dist) {
      int16_t dw = text_width(it->dist, s_f14);
      graphics_context_set_text_color(ctx, detail_color);
      draw_line(ctx, it->dist, s_f14, right - dw, dw + 2, line1_cy, GTextAlignmentLeft);
      right -= dw + 2;
    }
    if (has_arrow) {
      int16_t r = dfi.cap / 2 + 1;
      draw_arrow(ctx, it, right - r - 1, line1_cy, r);
      right -= 2 * r + 4;
    }
    if (walk_w && right - walk_w - 4 > ix + 24) {
      graphics_context_set_text_color(ctx, detail_color);
      draw_line(ctx, walk, s_f14, right - walk_w - 2, walk_w + 2, line1_cy, GTextAlignmentRight);
      right -= walk_w + 6;
    }
    if (!draw_times(ctx, it, now, detail_font, ix, right - ix, line1_cy, detail_color)) {
      bus_format_detail(it, now, clock_is_24h_style(), buf, sizeof buf);
      graphics_context_set_text_color(ctx, detail_color);
      draw_line(ctx, buf, detail_font, ix, right - ix, line1_cy, GTextAlignmentLeft);
    }
  }
}

// ---- Weather panel ----------------------------------------------------------
// In the room above the first row (bus_wheel_space_above), bottom edge at `bottom` (the first row's top), so it
// scrolls away with that row: the temperature now over "H 15° L 4°", and beside them the next hours' temperature
// as a line over their chance of rain as bars (0..100 % of the graph's height).

static void draw_weather(GContext *ctx, int16_t bottom, int16_t width) {
  int32_t now = s_test_now ? s_test_now : (int32_t)time(NULL);
  int16_t h = bus_wheel_space_above(&s_geom);
  if (h < WEATHER_MIN_H || bottom <= 0 || !bus_weather_visible(&s_weather, now)) return;
  int16_t top = bottom - h;
  int16_t x = bus_wheel_round_inset(&s_geom, 0, h) + 4, w = width - 2 * x;  // inset as when row 0 is selected
  if (w < 60) return;

  char now_t[12], hilo[28];
  bus_weather_format(&s_weather, now_t, sizeof now_t, hilo, sizeof hilo);
  GFont small = h >= 56 ? s_f18 : s_f14;
  FontMetrics big = font_info(s_f24b), sm = font_info(small);
  int16_t nw = text_width(now_t, s_f24b), hw = text_width(hilo, small), colw = nw > hw ? nw : hw;
  int16_t gap = (h - big.cap - sm.cap) / 3;
  if (gap > 6) gap = 6;
  int16_t cy0 = top + (h - big.cap - gap - sm.cap) / 2 + big.cap / 2, cy1 = cy0 + big.cap / 2 + gap + sm.cap / 2;
  graphics_context_set_text_color(ctx, GColorBlack);
  draw_line(ctx, now_t, s_f24b, x, colw + 2, cy0, GTextAlignmentLeft);
  draw_line(ctx, hilo, small, x, colw + 2, cy1, GTextAlignmentLeft);

  int16_t gx = x + colw + 6, gw = x + w - gx, gy = top + 4, gh = h - 9;
  if (gw < 24 || gh < 12) return;
  BusWeatherHour hr[BUS_WEATHER_MAX];
  int n = bus_weather_graph(&s_weather, gx, gy, gw, gh, hr, BUS_WEATHER_MAX);
  int16_t gb = gy + gh;  // bottom of the graph (exclusive)
  for (int i = 0; i < n; i++) {
    if (hr[i].top >= gb) continue;
#if defined(PBL_COLOR)
    fill_span(ctx, GColorPictonBlue, hr[i].x0, hr[i].x1, hr[i].top, gb);
#else
    graphics_context_set_stroke_color(ctx, GColorBlack);   // B&W: every other column, reads as grey
    for (int16_t xx = hr[i].x0; xx < hr[i].x1; xx++) {
      if (!(xx & 1)) graphics_draw_line(ctx, GPoint(xx, hr[i].top), GPoint(xx, gb - 1));
    }
#endif
  }
  fill_span(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack), gx, gx + gw, gb, gb + 1);
  if (n == 0) return;
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  graphics_context_set_stroke_width(ctx, 2);
  GPoint prev = GPoint(gx, hr[0].y);
  for (int i = 0; i <= n; i++) {
    GPoint p = i < n ? GPoint(hr[i].x, hr[i].y) : GPoint(gx + gw - 1, hr[n - 1].y);
    graphics_draw_line(ctx, prev, p);
    prev = p;
  }
  graphics_context_set_stroke_width(ctx, 1);
}

static void marquee_tick(void *data) {
  s_marquee_timer = NULL;
  if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
#if HAS_NAV
  if (s_nav_layer) layer_mark_dirty(s_nav_layer);
#endif
}

// After a redraw: wake up when a marquee next moves; no timer while nothing scrolls, while the scroll animation
// redraws anyway, or while the app is not in the foreground.
static void schedule_marquee(void) {
  if (s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
  bool nav_animating = false;
#if HAS_NAV
  nav_animating = s_nav_anim_timer != NULL;
#endif
  if (s_marquee_wait && s_focused && !s_anim_timer && !nav_animating) s_marquee_timer = app_timer_register(s_marquee_wait, marquee_tick, NULL);
}

static void wheel_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  s_marquee_wait = 0;
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  if (view_rows() == 0) {
    draw_weather(ctx, bus_wheel_space_above(&s_geom), b.size.w);
    graphics_context_set_text_color(ctx, GColorBlack);
    int16_t inset = PBL_IF_ROUND_ELSE(14, 4);
    GRect r = GRect(inset, b.size.h / 2 - 34, b.size.w - 2 * inset, 50);
    graphics_draw_text(ctx, s_model.status, s_f18b, r, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    schedule_marquee();
    return;
  }

  WheelSlot slots[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(&s_geom, view_rows(), s_pos, slots, WHEEL_MAX_SLOTS);
  if (n > 0 && slots[0].index == 0) draw_weather(ctx, slots[0].y, b.size.w);   // above the places when they are open
  // Draw the selected row last so its bars sit on top of its neighbours.
  int sel = -1;
  for (int i = 0; i < n; i++) {
    if (slots[i].level == 0 && sel < 0) { sel = i; continue; }
    draw_slot(ctx, &slots[i], b.size.w);
  }
  if (sel >= 0) draw_slot(ctx, &slots[sel], b.size.w);
  schedule_marquee();
}

static void redraw(void) {
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, row_is_place(s_sel) ? "Saved places" : s_model.status);
    layer_set_hidden(text_layer_get_layer(s_status_layer), view_rows() == 0);
  }
  if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
  if (s_hud_layer) layer_mark_dirty(s_hud_layer);
}

// ---- Notification window ----------------------------------------------------

#define NOTIFY_TITLE_LEN 32
#define NOTIFY_BODY_LEN 160

static Window *s_notify_window;
static Layer *s_notify_header;
static ScrollLayer *s_notify_scroll;
static TextLayer *s_notify_body_layer;
static char s_notify_title[NOTIFY_TITLE_LEN];
static char s_notify_body[NOTIFY_BODY_LEN];
static int32_t s_notify_color = -1;
static GFont s_notify_title_font;

static GRect notify_title_rect(GRect bounds) {
  int16_t inset = PBL_IF_ROUND_ELSE(22, 6), y = PBL_IF_ROUND_ELSE(16, 4);
  return GRect(inset, y, bounds.size.w - 2 * inset, 60);
}

// Header height for the current title (wraps to at most two lines).
static int16_t notify_header_h(GRect bounds) {
  GRect r = notify_title_rect(bounds);
  s_notify_title_font = s_f24b;
  GSize sz = graphics_text_layout_get_content_size(s_notify_title, s_f24b, r, GTextOverflowModeWordWrap,
                                                   GTextAlignmentCenter);
  if (sz.h > 2 * 26) {
    s_notify_title_font = s_f18b;
    sz = graphics_text_layout_get_content_size(s_notify_title, s_f18b, r, GTextOverflowModeWordWrap,
                                               GTextAlignmentCenter);
  }
  int16_t h = r.origin.y + sz.h + 8;
  return h > r.origin.y + 60 ? r.origin.y + 60 : h;
}

static void notify_header_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, route_color(s_notify_color));
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_text_color(ctx, badge_text_color(s_notify_color));
  GRect r = notify_title_rect(b);
  r.size.h = b.size.h - r.origin.y;
  graphics_draw_text(ctx, s_notify_title, s_notify_title_font, r, GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);
}

static void notify_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  window_set_background_color(window, GColorWhite);
  int16_t hh = notify_header_h(b);
  s_notify_header = layer_create(GRect(0, 0, b.size.w, hh));
  layer_set_update_proc(s_notify_header, notify_header_update);
  layer_add_child(root, s_notify_header);

  GRect sr = GRect(0, hh, b.size.w, b.size.h - hh);
  s_notify_scroll = scroll_layer_create(sr);
  scroll_layer_set_click_config_onto_window(s_notify_scroll, window);
  scroll_layer_set_shadow_hidden(s_notify_scroll, true);
  int16_t inset = PBL_IF_ROUND_ELSE(18, 6);
  GRect tr = GRect(inset, 4, sr.size.w - 2 * inset, 2000);
  s_notify_body_layer = text_layer_create(tr);
  text_layer_set_text(s_notify_body_layer, s_notify_body);
  text_layer_set_font(s_notify_body_layer, s_f18);
  text_layer_set_text_alignment(s_notify_body_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_background_color(s_notify_body_layer, GColorClear);
  GSize sz = text_layer_get_content_size(s_notify_body_layer);
  text_layer_set_size(s_notify_body_layer, GSize(tr.size.w, sz.h + 8));
  scroll_layer_set_content_size(s_notify_scroll, GSize(sr.size.w, sz.h + PBL_IF_ROUND_ELSE(40, 16)));
  scroll_layer_add_child(s_notify_scroll, text_layer_get_layer(s_notify_body_layer));
  layer_add_child(root, scroll_layer_get_layer(s_notify_scroll));
}

static void notify_window_unload(Window *window) {
  text_layer_destroy(s_notify_body_layer);
  scroll_layer_destroy(s_notify_scroll);
  layer_destroy(s_notify_header);
  s_notify_body_layer = NULL;
  s_notify_scroll = NULL;
  s_notify_header = NULL;
}

static void notify_show(const char *title, const char *body, int32_t color) {
  snprintf(s_notify_title, sizeof s_notify_title, "%s", title);
  snprintf(s_notify_body, sizeof s_notify_body, "%s", body);
  s_notify_color = color;
  if (!s_notify_window) {
    s_notify_window = window_create();
    window_set_window_handlers(s_notify_window, (WindowHandlers){
      .load = notify_window_load,
      .unload = notify_window_unload,
    });
  }
  bool shown = window_stack_contains_window(s_notify_window);
  if (shown) window_stack_remove(s_notify_window, false);  // rebuild the layout for the new text
  window_stack_push(s_notify_window, !shown);
  vibes_double_pulse();
  light_enable_interaction();
}

// the side menu and plain messages to the phone (below)
static BusMenu s_menu;
static void menu_open(Window *window, ClickConfigProvider own, void (*fn)(int act));
static void menu_close(void);
static void send_flag(uint32_t key, int32_t value);

#if HAS_NAV
// ---- Trip view ------------------------------------------------------------------
// Opened by the phone (NAV_SHOW) when a trip starts ("Start trip" in the menu) or a scheduled one is due (a preview,
// NAV_STATE 3): the legs as a wheel like the main list, each a header (its route in the band like a home tile, where it
// goes, direction, length, arrival, the stops / turns left) with its steps under it while it is open; the current step
// open (kind and direction in the band, the step's length, instruction, time left, an arrow to its target with the
// distance). While you look at the rows of the open leg you are on, its header stays at the top. UP / DOWN look ahead or
// back, a long SELECT opens / closes the leg (or shows the hidden rows) under the selection, a short SELECT opens the
// menu (home, back to the current step, cancel; a preview: start, dismiss). BACK goes home: the trip goes on (a dot on
// the home screen; "Show trip" brings it back); a preview is dismissed. The phone follows the GPS and moves through the
// steps; the wheel follows it.

#define PIN_H 54          // the pinned leg header

static Window *s_nav_window;
static TextLayer *s_nav_status_layer;
static WheelGeometry s_nav_geom, s_nav_geom_pin;
static int s_nav_sel;            // selected step
static int32_t s_nav_pos;        // drawn position, milli-rows
static int32_t s_nav_anim_from;
static uint32_t s_nav_anim_start;
static char s_nav_status[BUS_NAV_TEXT_LEN];

// Rows near the selection that the watch does not have: ask the phone for the window around it. If the outbox is
// busy nothing is marked as on its way, so the next redraw asks again.
static void nav_fetch_near(int sel) {
  int idx = bus_nav_fetch_for(&s_nav, sel);
  if (idx < 0) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    s_nav.cover_hi = s_nav.cover_lo;
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_NAV_FETCH, idx);
  app_message_outbox_send();
}

static void nav_redraw(void) {
  nav_fetch_near(s_nav_sel);
  if (s_nav_status_layer) {
    if (s_nav.state == BUS_NAV_PREVIEW) snprintf(s_nav_status, sizeof s_nav_status, "%s", s_nav.title);
    else snprintf(s_nav_status, sizeof s_nav_status, "Step %d of %d", s_nav_sel + 1, s_nav.count ? (int)s_nav.count : 1);
    text_layer_set_text(s_nav_status_layer, s_nav_status);
  }
  if (s_nav_layer) layer_mark_dirty(s_nav_layer);
  if (s_hud_layer) layer_mark_dirty(s_hud_layer);
}

static void nav_anim_step(void *data) {
  s_nav_anim_timer = NULL;
  int32_t target = (int32_t)s_nav_sel * 1000;
  uint32_t t = now_ms() - s_nav_anim_start;
  if (t >= ANIM_MS) {
    s_nav_pos = target;
  } else {
    int32_t p = (int32_t)(t * 1000u / ANIM_MS);
    int32_t e = 1000 - (1000 - p) * (1000 - p) / 1000;
    s_nav_pos = s_nav_anim_from + (target - s_nav_anim_from) * e / 1000;
    s_nav_anim_timer = app_timer_register(FRAME_MS, nav_anim_step, NULL);
  }
  if (s_nav_layer) layer_mark_dirty(s_nav_layer);
}

static void nav_select_step(int sel, bool animate) {
  int max = bus_nav_row_count(&s_nav) - 1;
  if (sel > max) sel = max;
  if (sel < 0) sel = 0;
  if (s_nav_anim_timer) {
    app_timer_cancel(s_nav_anim_timer);
    s_nav_anim_timer = NULL;
  }
  s_marquee_start = now_ms() + (animate ? ANIM_MS : 0);
  if (sel == s_nav_sel && !animate) {
    s_nav_pos = (int32_t)sel * 1000;
  } else if (animate && (sel != s_nav_sel || s_nav_pos != (int32_t)sel * 1000)) {
    s_nav_sel = sel;
    s_nav_anim_from = s_nav_pos;
    s_nav_anim_start = now_ms();
    nav_anim_step(NULL);
  } else {
    s_nav_sel = sel;
    s_nav_pos = (int32_t)sel * 1000;
  }
  nav_redraw();
}

// The rail beside the rows: one x for every row on rectangular screens (a straight line through the wheel), inside each
// row's own inset on round ones.
#define RAIL_X 9          // rectangular screens
#define RAIL_TEXT_GAP 9   // from the rail to the row's text
#define RAIL_DASH 7       // walking: a dash every 7 px...
#define RAIL_DASH_ON 4    // ... 4 px long (phase from the wheel's own y, so the dashes line up across rows)

static int16_t rail_x(const WheelSlot *s) {
  return PBL_IF_ROUND_ELSE(s->inset + 9, RAIL_X);
}

static void draw_rail_segment(GContext *ctx, int style, GColor c, int16_t cx, int16_t y0, int16_t y1) {
  if (y1 <= y0 || style == BUS_RAIL_NO_LINE) return;
  if (style == BUS_RAIL_LINE) {
    fill_span(ctx, c, cx - 1, cx + 2, y0, y1);
    return;
  }
  GColor g = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
  for (int16_t d = y0 - (int16_t)(((y0 % RAIL_DASH) + RAIL_DASH) % RAIL_DASH); d < y1; d += RAIL_DASH) {
    fill_span(ctx, g, cx - 1, cx + 2, d < y0 ? y0 : d, d + RAIL_DASH_ON > y1 ? y1 : d + RAIL_DASH_ON);
  }
}

// A stop: a circle in the route's colour (hollow; filled at the stop you are at), the lines to the rows above and below
// meeting its edge. Elsewhere the lines run through the row.
static void draw_rail(GContext *ctx, const BusNavStep *st, const WheelSlot *s, int16_t cx, int16_t cy) {
  GColor c = route_color(st->color);
  int marker = BUS_RAIL_MARKER(st->rail);
  int16_t r = marker ? (s->level == 0 ? 6 : s->level == 1 ? 5 : 4) : 0;
  draw_rail_segment(ctx, BUS_RAIL_TOP(st->rail), c, cx, s->y, cy - r);
  draw_rail_segment(ctx, BUS_RAIL_BOTTOM(st->rail), c, cx, cy + r, s->y + s->h);
  if (!marker) return;
  graphics_context_set_fill_color(ctx, c);
  graphics_fill_circle(ctx, GPoint(cx, cy), r);
  if (marker == BUS_RAIL_STOP) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, GPoint(cx, cy), r - 2);
  }
}

// A small triangle at (cx, cy): pointing right (a closed leg: a long SELECT opens it) or down (open).
static void draw_fold_mark(GContext *ctx, int16_t cx, int16_t cy, bool open, GColor c) {
  for (int16_t r = 0; r < 4; r++) {
    if (open) fill_span(ctx, c, cx - 3 + r, cx + 4 - r, cy - 2 + r, cy - 1 + r);
    else fill_span(ctx, c, cx - 2 + r, cx - 1 + r, cy - 3 + r, cy + 4 - r);
  }
}

// A leg's header in the box (x, y, w, h): selected (level 0) or pinned like a home tile: its route in a band in the
// route's colour (the length at the right), the badge, direction and where it goes, then "arr 8:24 · 6 stops"; a
// neighbour: the badge and where it goes. The fold mark at the right end of its title.
static void draw_head(GContext *ctx, const BusNavStep *st, int16_t x, int16_t y, int16_t w, int16_t h, int level,
                      int16_t width) {
  GColor rc = route_color(st->color);
  int16_t pad = level == 0 ? 4 : 3, ix = x + pad, iw = w - 2 * pad;
  bool tall = level == 0 && h >= 60;
  GFont title_font = level == 0 ? (tall ? s_f24b : s_f18b) : level == 1 ? s_f18b : s_f14;
  GFont badge_font = level == 0 ? s_f18b : s_f14b, detail_font = tall ? s_f18 : s_f14;
  FontMetrics tfi = font_info(title_font), dfi = font_info(detail_font);
  int16_t top = y, bottom = y + h;
  GColor fg = level == 2 ? PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack) : GColorBlack;
  fill_span(ctx, GColorWhite, x, x + w, y, y + h);
  if (level == 0) {
    fill_span(ctx, rc, x, x + w, y, y + ROUTE_BAND_H);
    fill_span(ctx, rc, x, x + w, y + h - BAR_H, y + h);
    graphics_context_set_text_color(ctx, badge_text_color(st->color));
    int16_t dw = st->dist[0] ? text_width(st->dist, s_f14) : 0;
    draw_line(ctx, st->route, s_f14, ix, iw - (dw ? dw + 6 : 0), y + ROUTE_BAND_H / 2, GTextAlignmentLeft);
    if (dw) draw_line(ctx, st->dist, s_f14, ix + iw - dw - 2, dw + 2, y + ROUTE_BAND_H / 2, GTextAlignmentRight);
    top += ROUTE_BAND_H;
    bottom -= BAR_H;
  } else {
    fill_span(ctx, rc, x, x + 3, y + 2, y + h - 2);   // the leg's colour down its left edge
    ix += 3;
    iw -= 3;
  }
  int16_t ih = bottom - top, title_cy, detail_cy = 0;
  bool detail = st->sub[0] && level < 2 && ih >= tfi.cap + dfi.cap + 8;
  if (detail) {
    int16_t gap = (ih - tfi.cap - dfi.cap) / 3;
    title_cy = top + gap + tfi.cap / 2;
    detail_cy = bottom - gap - dfi.cap / 2;
  } else {
    title_cy = top + ih / 2;
  }
  bool foldable = (st->rail & (BUS_RAIL_FOLDED | BUS_RAIL_OPEN)) != 0;
  int16_t mark_w = foldable ? 10 : 0;
  int16_t bw = draw_badge_text(ctx, st->badge, st->color, badge_font, ix, title_cy, iw / 2,
                               level == 0 ? top + BADGE_GAP : INT16_MIN);
  int16_t tx = ix + (bw ? bw + 4 : 0);   // (a ride's direction is in its detail: beside the title it reads as the name)
  graphics_context_set_text_color(ctx, fg);
  draw_line(ctx, st->text, title_font, tx, ix + iw - tx - mark_w, title_cy, GTextAlignmentLeft);
  if (foldable) draw_fold_mark(ctx, ix + iw - 4, title_cy, (st->rail & BUS_RAIL_OPEN) != 0, fg);
  if (detail) {
    graphics_context_set_text_color(ctx, level == 0 ? GColorBlack : PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    draw_line(ctx, st->sub, detail_font, ix, iw, detail_cy, GTextAlignmentLeft);
  }
  (void)width;
}

static void draw_nav_slot(GContext *ctx, const WheelSlot *s, int16_t width) {
  const BusNavStep *st = bus_nav_step(&s_nav, s->index);
  int16_t x = s->inset, w = width - 2 * s->inset;
  if (w <= 8) return;
  if (st && st->kind == BUS_NAV_HEAD) {
    draw_head(ctx, st, x, s->y, w, s->h, s->level, width);
    return;
  }
  bool preview = s_nav.state == BUS_NAV_PREVIEW;
  bool current = !preview && s->index == s_nav.current, past = !preview && s->index < s_nav.current;
  int32_t color = st ? st->color : -1;

  int16_t pad = s->level == 0 ? 4 : 3;
  int16_t ix = x + pad, iw = w - 2 * pad;
  int16_t rx = rail_x(s);
  if (rx + RAIL_TEXT_GAP > ix) {   // the text starts right of the rail
    iw -= rx + RAIL_TEXT_GAP - ix;
    ix = rx + RAIL_TEXT_GAP;
  }
  // Level 0: a route-color band on top (kind, direction and the step's length) and a bar below.
  int16_t band_h = s->level == 0 ? ROUTE_BAND_H : 0;
  if (s->level == 0) {
    GColor rc = route_color(color);
    fill_span(ctx, rc, x, x + w, s->y, s->y + band_h);
    fill_span(ctx, rc, x, x + w, s->y + s->h - BAR_H, s->y + s->h);
    if (st) {
      char label[24];
      snprintf(label, sizeof label, "%s%s%s", bus_nav_kind_name(st->kind), st->dir[0] && st->kind != BUS_NAV_WAIT ? " " : "",
               st->kind == BUS_NAV_WAIT ? "" : bus_dir_name(st->dir));
      graphics_context_set_text_color(ctx, badge_text_color(color));
      int16_t dw = st->dist[0] ? text_width(st->dist, s_f14) : 0;
      draw_line(ctx, label, s_f14, ix, iw - dw - 2, s->y + band_h / 2, GTextAlignmentLeft);
      if (dw) draw_line(ctx, st->dist, s_f14, ix + iw - dw - 2, dw + 2, s->y + band_h / 2, GTextAlignmentRight);
    }
  } else if (current) {
    fill_span(ctx, route_color(color), x, x + 3, s->y + 2, s->y + s->h - 2);   // marks the step you are on
  }
  int16_t top = s->y + band_h, bottom = s->y + s->h - (s->level == 0 ? BAR_H : 0);
  int16_t ih = bottom - top;

  GColor fg = GColorBlack, dim = GColorBlack;
#if defined(PBL_COLOR)
  dim = GColorDarkGray;
  if (s->level == 2 || past) fg = GColorDarkGray;
#endif
  graphics_context_set_text_color(ctx, fg);
  if (!st) {
    draw_line(ctx, "...", s->level == 0 ? s_f18b : s_f14, ix, iw, top + ih / 2, GTextAlignmentLeft);
    return;
  }

  GFont title_font = s->level == 0 ? s_f24b : s->level == 1 ? s_f18b : s_f14;
  GFont detail_font = s->level == 0 ? s_f18 : s_f14;
  FontMetrics tfi = font_info(title_font), dfi = font_info(detail_font);
  char mode = 'C';
  if (s->level == 0 && ih >= tfi.cap + 2 * dfi.cap + 12) mode = 'A';
  else if (s->level < 2 && ih >= tfi.cap + dfi.cap + 8) mode = 'B';

  int16_t title_cy, line1_cy = 0, line2_cy = 0, lower_top = 0;
  if (mode == 'A') {
    int16_t gap = (ih - tfi.cap - 2 * dfi.cap) / 4;
    title_cy = top + gap + tfi.cap / 2;
    lower_top = top + gap + tfi.cap;
    line1_cy = lower_top + gap + dfi.cap / 2;
    line2_cy = line1_cy + dfi.cap + gap;
  } else if (mode == 'B') {
    int16_t gap = (ih - tfi.cap - dfi.cap) / 3;
    title_cy = top + gap + tfi.cap / 2;
    line1_cy = bottom - gap - dfi.cap / 2;
  } else {
    title_cy = top + ih / 2;
  }
  // Title: the instruction; at level 1 behind a small kind pill (not for the stops along a ride or a fold, which the
  // rail already marks). The selected step's title scrolls when too wide.
  int16_t tx = ix, tw = iw;
  if (s->level == 1 && st->kind != BUS_NAV_INFO && st->kind != BUS_NAV_STOP && st->kind != BUS_NAV_FOLD) {
    FontMetrics pf = font_info(s_f14b);
    int16_t pw = text_width(bus_nav_kind_name(st->kind), s_f14b) + 6, ph = pf.cap + 5;
    graphics_context_set_fill_color(ctx, route_color(color));
    graphics_fill_rect(ctx, GRect(ix, title_cy - ph / 2, pw, ph), 3, GCornersAll);
    graphics_context_set_text_color(ctx, badge_text_color(color));
    draw_line(ctx, bus_nav_kind_name(st->kind), s_f14b, ix, pw, title_cy, GTextAlignmentCenter);
    graphics_context_set_text_color(ctx, fg);
    tx = ix + pw + 4;
    tw = ix + iw - tx;
  }
  if (s->level == 0) {
    int16_t y0 = title_cy - tfi.cap / 2 - tfi.top, y1 = mode == 'C' ? bottom : line1_cy - dfi.cap / 2 - 1;
    if (y0 < top) y0 = top;
    draw_marquee(ctx, st->text, title_font, tx, tw, title_cy, y0, y1, x, x + w, GColorWhite, width);
    int16_t ly1 = title_cy - tfi.cap / 2 - tfi.top + tfi.line;
    if (ly1 > bottom) ly1 = bottom;
    fill_span(ctx, GColorWhite, 0, tx, y1, ly1);
    fill_span(ctx, GColorWhite, tx + tw, width, y1, ly1);
  } else {
    draw_line(ctx, st->text, title_font, tx, tw, title_cy, GTextAlignmentLeft);
  }
  draw_rail(ctx, st, s, rx, title_cy);   // after the title: the marquee clears the margin left of it
  if (mode == 'C') return;

  GColor detail_color = s->level == 0 ? (past ? dim : GColorBlack) : dim;
  graphics_context_set_text_color(ctx, detail_color);
  if (mode == 'A') {
    bool live = current && (s_nav.live_sub[0] || s_nav.live_dist[0] || s_nav.bearing >= 0);
    int16_t colw = current && (s_nav.bearing >= 0 || s_nav.live_dist[0]) ? ARROW_COL_W : 0, lw = iw - colw;
    const char *first = current ? s_nav.live_sub : st->sub, *second = current ? st->sub : "";
    if (first[0] && second[0]) {
      draw_line(ctx, first, detail_font, ix, lw, line1_cy, GTextAlignmentLeft);
      draw_line(ctx, second, detail_font, ix, lw, line2_cy, GTextAlignmentLeft);
    } else if (first[0] || second[0]) {
      draw_line(ctx, first[0] ? first : second, detail_font, ix, lw, (line1_cy + line2_cy) / 2, GTextAlignmentLeft);
    }
    if (live && colw) {
      FontMetrics sfi = font_info(s_f14);
      int16_t cx = ix + iw - colw / 2, dist_cy = line2_cy + 1;
      bool has_dist = s_nav.live_dist[0] != 0, has_arrow = s_nav.bearing >= 0;
      int16_t atop = lower_top + 1, abot = has_dist ? dist_cy - sfi.cap / 2 - 2 : bottom - 2;
      if (has_arrow) {
        int16_t r = (abot - atop) / 2;
        if (r > ARROW_R_MAX) r = ARROW_R_MAX;
        if (r >= 3) draw_arrow_at(ctx, s_nav.bearing, color, cx, (atop + abot) / 2, r);
      }
      if (has_dist) {
        if (!has_arrow) dist_cy = (line1_cy + line2_cy) / 2;
        graphics_context_set_text_color(ctx, GColorBlack);
        draw_line(ctx, s_nav.live_dist, s_f14, ix + iw - colw - 4, colw + 8, dist_cy, GTextAlignmentCenter);
      }
    }
  } else {  // 'B': the step's detail, its length at the right end
    int16_t right = ix + iw;
    if (st->dist[0]) {
      int16_t dw = text_width(st->dist, s_f14);
      draw_line(ctx, st->dist, s_f14, right - dw, dw + 2, line1_cy, GTextAlignmentLeft);
      right -= dw + 6;
    }
    const char *d = current && s_nav.live_sub[0] ? s_nav.live_sub : st->sub;
    if (d[0] && right - ix > 20) draw_line(ctx, d, detail_font, ix, right - ix, line1_cy, GTextAlignmentLeft);
  }
}

// While the selection is on a row of the open leg you are on (below its header), the header is pinned at the top and
// the wheel turns in the room under it; the rows up to the header pass under it.
static void nav_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  s_marquee_wait = 0;
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  bool pin = bus_nav_pinned(&s_nav, s_nav_sel);
  int16_t top = pin ? PIN_H : 0;
  WheelSlot slots[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(pin ? &s_nav_geom_pin : &s_nav_geom, bus_nav_row_count(&s_nav), s_nav_pos, slots, WHEEL_MAX_SLOTS);
  if (pin) {
    // the rows that pass under the header would leave a gap above the first one shown: the wheel moves up by it (laid
    // out twice as tall below, so the room it leaves at the bottom has rows too)
    int16_t gap = 0;
    for (int i = 0; i < n && !gap; i++) if (slots[i].index > s_nav.head) gap = slots[i].y > 0 ? slots[i].y : -1;
    if (gap > 0) {
      WheelGeometry g = s_nav_geom_pin;
      g.height += 2 * gap;
      n = bus_wheel_layout(&g, bus_nav_row_count(&s_nav), s_nav_pos, slots, WHEEL_MAX_SLOTS);
      for (int i = 0; i < n; i++) slots[i].y -= 2 * gap;
    }
  }
  int sel = -1;
  for (int i = 0; i < n; i++) {
    slots[i].y += top;
    if (pin && slots[i].index <= s_nav.head) continue;
    if (slots[i].level == 0 && sel < 0) { sel = i; continue; }
    draw_nav_slot(ctx, &slots[i], b.size.w);
  }
  if (sel >= 0) draw_nav_slot(ctx, &slots[sel], b.size.w);
  if (pin) {
    int16_t inset = bus_wheel_round_inset(&s_nav_geom, 0, PIN_H);
    fill_span(ctx, GColorWhite, 0, b.size.w, 0, PIN_H);
    draw_head(ctx, &s_nav.head_row, inset, 0, b.size.w - 2 * inset, PIN_H - 1, 0, b.size.w);
  }
  schedule_marquee();
}

static void nav_up(ClickRecognizerRef rec, void *ctx) { nav_select_step(s_nav_sel - 1, true); }
static void nav_down(ClickRecognizerRef rec, void *ctx) { nav_select_step(s_nav_sel + 1, true); }

static void nav_click_config(void *ctx);

// the trip is over (cancelled, a preview dismissed): the phone stops following it, the view closes
static void nav_clear(void) {
  send_flag(MESSAGE_KEY_NAV_STOP, 1);
  bus_nav_init(&s_nav);
  if (s_nav_window && window_stack_contains_window(s_nav_window)) window_stack_remove(s_nav_window, true);
  redraw();
}

static void nav_action(int act) {
  switch (act) {
    case BUS_ACT_HOME: window_stack_remove(s_nav_window, true); break;
    case BUS_ACT_CURRENT: nav_select_step(s_nav.current, true); break;
    case BUS_ACT_GO: send_flag(MESSAGE_KEY_NAV_GO, 1); break;
    case BUS_ACT_CANCEL_TRIP:
    case BUS_ACT_DISMISS: nav_clear(); break;
    default: break;
  }
}

static void nav_menu(ClickRecognizerRef rec, void *ctx) {
  bus_menu_trip(&s_menu, s_nav.state == BUS_NAV_PREVIEW, s_nav_sel != s_nav.current);
  menu_open(s_nav_window, nav_click_config, nav_action);
}

// a long SELECT on a leg's header or on hidden rows: the phone opens / closes them and sends the rows again
static void nav_unfold(ClickRecognizerRef rec, void *ctx) {
  const BusNavStep *st = bus_nav_step(&s_nav, s_nav_sel);
  if (!st || !(st->rail & (BUS_RAIL_FOLDED | BUS_RAIL_OPEN))) return;
  send_flag(MESSAGE_KEY_NAV_UNFOLD, s_nav_sel);
  vibes_short_pulse();
}

static void nav_back(ClickRecognizerRef rec, void *ctx) {
  if (s_nav.state == BUS_NAV_PREVIEW) nav_clear();
  else window_stack_pop(true);
}

static void nav_click_config(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_MS, nav_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_MS, nav_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, nav_menu);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, nav_unfold, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, nav_back);
}

static void nav_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  window_set_background_color(window, GColorWhite);
#if defined(PBL_ROUND)
  GRect status = GRect(30, ROUND_STATUS_Y - 3, b.size.w - 60, STATUS_H + 2);
  GRect wheel = GRect(0, ROUND_WHEEL_Y, b.size.w, b.size.h - 2 * ROUND_WHEEL_Y);
#else
  GRect status = GRect(2, -2, b.size.w - 4, STATUS_H + 2);
  GRect wheel = GRect(0, STATUS_H, b.size.w, b.size.h - STATUS_H);
#endif
  s_nav_status_layer = text_layer_create(status);
  text_layer_set_font(s_nav_status_layer, s_f14);
  text_layer_set_text_alignment(s_nav_status_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_nav_status_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_background_color(s_nav_status_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_nav_status_layer));
  bus_wheel_geometry(&s_nav_geom, wheel.size.w, wheel.size.h, PBL_IF_ROUND_ELSE(true, false));
  bus_wheel_geometry(&s_nav_geom_pin, wheel.size.w, wheel.size.h - PIN_H, PBL_IF_ROUND_ELSE(true, false));
  s_nav_geom_pin.row_h[0] = s_nav_geom.row_h[0];   // (the same rows as without the header, just fewer of them)
  s_nav_geom_pin.row_h[1] = s_nav_geom.row_h[1];
  s_nav_geom_pin.row_h[2] = s_nav_geom.row_h[2];
  s_nav_layer = layer_create(wheel);
  layer_set_update_proc(s_nav_layer, nav_update);
  layer_add_child(root, s_nav_layer);
  s_nav_sel = s_nav.current;
  s_nav_pos = (int32_t)s_nav_sel * 1000;
  s_marquee_start = now_ms();
  nav_redraw();
}

static void nav_window_unload(Window *window) {
  menu_close();
  if (s_nav_anim_timer) {
    app_timer_cancel(s_nav_anim_timer);
    s_nav_anim_timer = NULL;
  }
  layer_destroy(s_nav_layer);
  s_nav_layer = NULL;
  text_layer_destroy(s_nav_status_layer);
  s_nav_status_layer = NULL;
  if (s_nav.state == BUS_NAV_PREVIEW) {   // a preview goes with its view (a trip goes on)
    send_flag(MESSAGE_KEY_NAV_STOP, 1);
    bus_nav_init(&s_nav);
  }
  redraw();
}

// "Show trip": the trip view again, at the current step
static void nav_show(void) {
  if (s_nav.state == BUS_NAV_CLOSED) return;
  if (!s_nav_window) {
    s_nav_window = window_create();
    window_set_click_config_provider(s_nav_window, nav_click_config);
    window_set_window_handlers(s_nav_window, (WindowHandlers){ .load = nav_window_load, .unload = nav_window_unload });
  }
  if (!window_stack_contains_window(s_nav_window)) window_stack_push(s_nav_window, true);
}

// NAV_STATE from the phone: the trip (or preview) as it is now; `show` (a trip just started / a preview) opens the trip
// view. A new current step scrolls to it and buzzes the wrist, also while the view is closed.
static void nav_live(int state, int current, const char *sub, const char *dist, int bearing, const char *title, bool show) {
  bool shown = s_nav_window && window_stack_contains_window(s_nav_window);
  if (state != BUS_NAV_GUIDING && state != BUS_NAV_ARRIVED && state != BUS_NAV_PREVIEW) {
    bus_nav_init(&s_nav);
    if (shown) window_stack_remove(s_nav_window, true);
    redraw();
    return;
  }
  bool new_step = bus_nav_set_live(&s_nav, state, current, sub, dist, bearing, title);
  if (!shown) {
    if (show) {
      nav_show();
      if (state == BUS_NAV_PREVIEW) vibes_double_pulse();
      else vibes_short_pulse();
      light_enable_interaction();
    } else if (new_step) {
      vibes_short_pulse();
    }
    redraw();
    return;
  }
  if (new_step || show) {
    nav_select_step(s_nav.current, true);
    vibes_short_pulse();
    light_enable_interaction();
  } else {
    nav_redraw();
  }
}
#endif  // HAS_NAV

// ---- AppMessage -------------------------------------------------------------

static int32_t tuple_int(const Tuple *t) {
  if (!t) return 0;
  if (t->type == TUPLE_CSTRING) return (int32_t)atoi(t->value->cstring);
  switch (t->length) {
    case 1: return t->type == TUPLE_INT ? t->value->int8 : t->value->uint8;
    case 2: return t->type == TUPLE_INT ? t->value->int16 : t->value->uint16;
    default: return t->value->int32;
  }
}

static int32_t tuple_int_or(const Tuple *t, int32_t fallback) {
  return t ? tuple_int(t) : fallback;
}

static const char *tuple_str(const Tuple *t) {
  return (t && t->type == TUPLE_CSTRING) ? t->value->cstring : "";
}

static const uint8_t *tuple_bytes(const Tuple *t) {
  return (t && t->type == TUPLE_BYTE_ARRAY) ? t->value->data : NULL;
}

static int tuple_bytes_len(const Tuple *t) {
  return (t && t->type == TUPLE_BYTE_ARRAY) ? (int)t->length : 0;
}

static void try_send_wakeup_fired(void);

static void wakeup_retry(void *data) {
  s_wakeup_timer = NULL;
  try_send_wakeup_fired();
}

static void schedule_wakeup_retry(void) {
  if (!s_wakeup_pending || s_wakeup_timer) return;
  if (++s_wakeup_tries > WAKEUP_RETRIES) {
    s_wakeup_pending = false;
    APP_LOG(APP_LOG_LEVEL_WARNING, "wakeup %d not reported", (int)s_wakeup_cookie);
    return;
  }
  s_wakeup_timer = app_timer_register(WAKEUP_RETRY_MS, wakeup_retry, NULL);
}

// Sends {WAKEUP_FIRED: cookie}; on a busy outbox / not-yet-connected phone it retries a few times.
static void try_send_wakeup_fired(void) {
  if (!s_wakeup_pending) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    schedule_wakeup_retry();
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_WAKEUP_FIRED, s_wakeup_cookie);
  if (app_message_outbox_send() != APP_MSG_OK) schedule_wakeup_retry();
}

static void report_wakeup(int32_t cookie) {
  APP_LOG(APP_LOG_LEVEL_INFO, "wakeup fired: cookie %d", (int)cookie);
  s_wakeup_cookie = cookie;
  s_wakeup_pending = true;
  s_wakeup_tries = 0;
  try_send_wakeup_fired();
}

static void wakeup_handler(WakeupId id, int32_t cookie) {
  report_wakeup(cookie);
}

// The complete WAKEUP_* list replaces every wakeup this app has scheduled.
static void apply_wakeups(void) {
  BusWakeup plan[BUS_WAKEUP_MAX];
  int n = bus_wakeup_plan(&s_wakeups, (int32_t)time(NULL), plan, BUS_WAKEUP_MAX);
  bus_wakeup_init(&s_wakeups);
  wakeup_cancel_all();
  for (int i = 0; i < n; i++) {
    time_t t = (time_t)plan[i].time;
    WakeupId id = E_RANGE;
    for (int tries = 0; tries < 5 && id == E_RANGE; tries++, t += BUS_WAKEUP_GAP) {
      id = wakeup_schedule(t, plan[i].cookie, true);  // E_RANGE: another app's wakeup is within a minute
    }
    APP_LOG(APP_LOG_LEVEL_INFO, "wakeup scheduled: cookie %d in %ds -> %d", (int)plan[i].cookie,
            (int)(plan[i].time - time(NULL)), (int)id);
  }
  if (n == 0) APP_LOG(APP_LOG_LEVEL_INFO, "wakeups cancelled");
}

static void apply_test_hook(int32_t v) {
  APP_LOG(APP_LOG_LEVEL_INFO, "test hook %d", (int)v);
  if (v <= -1000) {
    int32_t p = (int32_t)s_sel * 1000 + (-v - 1000), max = (int32_t)(view_rows() - 1) * 1000;
    jump_to_selection();
    s_pos = p > max ? max : p;
    if (s_test_marquee < 0) s_test_marquee = 0;
    return;
  }
  s_test_marquee = v < 0 ? -1 : v;
  jump_to_selection();
  s_marquee_start = now_ms();
}

// ---- Display preferences -> phone ---------------------------------------------
// The phone formats distances and notification times; it follows the watch's own settings: the 24 h clock style
// and (where Pebble Health exists) the measurement system. Sent once the phone talks to us, retried until delivered.
// Flags: bit 0 = 24 h clock, bit 1 = metric, bit 2 = measurement system known, bit 3 = the trip view (not aplite).
static bool s_prefs_sent = false;

static int32_t watch_prefs(void) {
  int32_t flags = clock_is_24h_style() ? 1 : 0;
#if HAS_NAV
  flags |= 8;   // the trip view: the phone shows a scheduled trip as its steps (else as a notification)
#endif
#if defined(PBL_HEALTH)
  MeasurementSystem ms = health_service_get_measurement_system_for_display(HealthMetricWalkedDistanceMeters);
  if (ms == MeasurementSystemMetric) flags |= 2 | 4;
  else if (ms == MeasurementSystemImperial) flags |= 4;
#endif
  return flags;
}

static void try_send_prefs(void) {
  if (s_prefs_sent) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, MESSAGE_KEY_WATCH_PREFS, watch_prefs());
  app_message_outbox_send();
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *list_id = dict_find(iter, MESSAGE_KEY_LIST_ID);
  Tuple *count = dict_find(iter, MESSAGE_KEY_ITEM_COUNT);
  Tuple *index = dict_find(iter, MESSAGE_KEY_ITEM_INDEX);
  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  Tuple *wcount = dict_find(iter, MESSAGE_KEY_WAKEUP_COUNT);
  Tuple *windex = dict_find(iter, MESSAGE_KEY_WAKEUP_INDEX);
  Tuple *ntitle = dict_find(iter, MESSAGE_KEY_NOTIFY_TITLE);

  if (count) {
    bus_model_begin_list(&s_model, tuple_int(list_id), (int)tuple_int(count));
    if (!row_is_place(s_sel)) {
      s_marquee_start = now_ms();
      int p = places_rows(), sel = bus_model_clamp_selection(&s_model, s_sel - p) + p;
      if (sel != s_sel) {
        s_sel = sel;
        jump_to_selection();
      }
    }
  }
  Tuple *pcount = dict_find(iter, MESSAGE_KEY_PLACE_COUNT);
  if (pcount) {
    int before = places_rows();
    bus_places_begin(&s_places, tuple_int(list_id), (int)tuple_int(pcount));
    if (s_places_open) {
      if (s_places.count == 0) s_places_open = false;   // nothing left to show
      int after = places_rows();
      if (s_sel >= before) s_sel += after - before;        // on the list: the same row
      else if (s_sel >= after) s_sel = after > 0 ? after - 1 : 0;
      s_marquee_start = now_ms();
      jump_to_selection();
    }
  }
  Tuple *pindex = dict_find(iter, MESSAGE_KEY_PLACE_INDEX);
  if (pindex) {
    int pi = (int)tuple_int(pindex);
    bus_places_set(&s_places, tuple_int(list_id), pi,
                   tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_TITLE)), tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_ROUTE)),
                   tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_COLOR), -1),
                   tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_BEARING), -1),
                   tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_DIST)),
                   tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_WALK), -1));
    bus_places_set_eta(&s_places, tuple_int(list_id), pi, tuple_int_or(dict_find(iter, MESSAGE_KEY_PLACE_ETA), -1),
                       tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_BADGE)));
  }
  if (index) {
    int32_t lid = tuple_int(list_id);
    int i = (int)tuple_int(index);
    bus_model_set_item(&s_model, lid, i,
                       (int)tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_KIND)),
                       tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_BADGE)),
                       tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_TITLE)),
                       tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_COLOR), -1),
                       tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_T0)),
                       tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_T1)),
                       tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_T2)));
    bus_model_set_geo(&s_model, lid, i,
                      tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_BEARING), -1),
                      tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_DIST)),
                      tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_DIR)),
                      (int)tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_LANES), 1),
                      tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_DIR2)),
                      tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_U0)),
                      tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_U1)),
                      tuple_int(dict_find(iter, MESSAGE_KEY_ITEM_U2)));
    bus_model_set_route(&s_model, lid, i, tuple_str(dict_find(iter, MESSAGE_KEY_ITEM_ROUTE)));
    bus_model_set_walk(&s_model, lid, i, tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_WALK), -1));
    bus_model_set_lead(&s_model, lid, i, tuple_int_or(dict_find(iter, MESSAGE_KEY_ITEM_LEAD), -1));
  }
  if (status) {
    bus_model_set_status(&s_model, tuple_str(status));
  }
  Tuple *wx = dict_find(iter, MESSAGE_KEY_WEATHER_COUNT);
  if (wx) {
    Tuple *temps = dict_find(iter, MESSAGE_KEY_WEATHER_TEMPS), *rain = dict_find(iter, MESSAGE_KEY_WEATHER_RAIN);
    bus_weather_set(&s_weather, (int)tuple_int(wx), tuple_int(dict_find(iter, MESSAGE_KEY_WEATHER_START)),
                    (int)tuple_int(dict_find(iter, MESSAGE_KEY_WEATHER_NOW)),
                    (int)tuple_int(dict_find(iter, MESSAGE_KEY_WEATHER_HI)),
                    (int)tuple_int(dict_find(iter, MESSAGE_KEY_WEATHER_LO)),
                    tuple_bytes(temps), tuple_bytes_len(temps), tuple_bytes(rain), tuple_bytes_len(rain));
  }
#if HAS_NAV
  Tuple *nav_count = dict_find(iter, MESSAGE_KEY_NAV_COUNT);
  if (nav_count) bus_nav_begin(&s_nav, (int)tuple_int(nav_count), (int)tuple_int(dict_find(iter, MESSAGE_KEY_NAV_WINDOW)),
                               (int)tuple_int_or(dict_find(iter, MESSAGE_KEY_NAV_HEAD), -1),
                               (int)tuple_int_or(dict_find(iter, MESSAGE_KEY_NAV_HEAD_END), -1));
  Tuple *nav_index = dict_find(iter, MESSAGE_KEY_NAV_INDEX);
  if (nav_index) {
    bus_nav_set_step(&s_nav, (int)tuple_int(nav_index), (int)tuple_int(dict_find(iter, MESSAGE_KEY_NAV_KIND)),
                     tuple_str(dict_find(iter, MESSAGE_KEY_NAV_TEXT)), tuple_str(dict_find(iter, MESSAGE_KEY_NAV_SUB)),
                     tuple_str(dict_find(iter, MESSAGE_KEY_NAV_DIST)), tuple_str(dict_find(iter, MESSAGE_KEY_NAV_DIR)),
                     tuple_int_or(dict_find(iter, MESSAGE_KEY_NAV_COLOR), -1),
                     (int)tuple_int(dict_find(iter, MESSAGE_KEY_NAV_RAIL)),
                     tuple_str(dict_find(iter, MESSAGE_KEY_NAV_BADGE)), tuple_str(dict_find(iter, MESSAGE_KEY_NAV_ROUTE)));
    nav_redraw();
  }
  Tuple *nav_state = dict_find(iter, MESSAGE_KEY_NAV_STATE);
  if (nav_state) {
    nav_live((int)tuple_int(nav_state), (int)tuple_int(dict_find(iter, MESSAGE_KEY_NAV_CURRENT)),
             tuple_str(dict_find(iter, MESSAGE_KEY_NAV_LSUB)), tuple_str(dict_find(iter, MESSAGE_KEY_NAV_LDIST)),
             (int)tuple_int_or(dict_find(iter, MESSAGE_KEY_NAV_BEARING), -1), tuple_str(dict_find(iter, MESSAGE_KEY_NAV_TITLE)),
             dict_find(iter, MESSAGE_KEY_NAV_SHOW) != NULL);
  }
#endif
  Tuple *hook = dict_find(iter, MESSAGE_KEY_REFRESH);  // phone -> watch REFRESH = test hook (see s_test_marquee)
  if (hook) apply_test_hook(tuple_int(hook));
  Tuple *test_now = dict_find(iter, MESSAGE_KEY_TEST_NOW);
  if (test_now) {
    s_test_now = tuple_int(test_now);
    redraw();
  }
  if (wcount) bus_wakeup_begin(&s_wakeups, (int)tuple_int(wcount));
  if (windex) {
    bus_wakeup_set(&s_wakeups, (int)tuple_int(windex), tuple_int(dict_find(iter, MESSAGE_KEY_WAKEUP_TIME)),
                   tuple_int(dict_find(iter, MESSAGE_KEY_WAKEUP_COOKIE)));
  }
  if ((wcount || windex) && bus_wakeup_complete(&s_wakeups)) apply_wakeups();
  if (ntitle) {
    notify_show(tuple_str(ntitle), tuple_str(dict_find(iter, MESSAGE_KEY_NOTIFY_BODY)),
                tuple_int_or(dict_find(iter, MESSAGE_KEY_NOTIFY_COLOR), -1));
  }
  // The phone is talking to us: a wakeup report that failed earlier can go now, then our display preferences.
  if (s_wakeup_pending && !s_wakeup_timer) try_send_wakeup_fired();
  else try_send_prefs();
  redraw();
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
}

static void outbox_sent(DictionaryIterator *iter, void *context) {
  if (dict_find(iter, MESSAGE_KEY_WAKEUP_FIRED)) s_wakeup_pending = false;
  if (dict_find(iter, MESSAGE_KEY_WATCH_PREFS)) s_prefs_sent = true;
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "outbox failed: %d", (int)reason);
  if (dict_find(iter, MESSAGE_KEY_WAKEUP_FIRED)) schedule_wakeup_retry();
}

// SELECT on a tile (or on a saved location: its index in the phone's list)
static void send_select(int index) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, row_is_place(s_sel) ? MESSAGE_KEY_PLACE_SELECT : MESSAGE_KEY_SELECT_INDEX, index);
  dict_write_int32(out, MESSAGE_KEY_LIST_ID, row_is_place(s_sel) ? s_places.list_id : s_model.list_id);
  app_message_outbox_send();
}

// the selected row's index in its list: the main list as it is, the places from the bottom up (bus_places_at_row)
static int selected_index(void) {
  if (row_is_place(s_sel)) return bus_places_at_row(&s_places, s_sel) ? s_places.count - 1 - s_sel : -1;
  return bus_model_item(&s_model, s_sel - places_rows()) ? s_sel - places_rows() : -1;
}

static void send_flag(uint32_t key, int32_t value) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, key, value);
  app_message_outbox_send();
}

#if HAS_NAV
// "Start trip" / "Replace trip": ask the phone for a trip to the selected tile (index -1: nothing is selected).
static void send_nav_start(int index) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, row_is_place(s_sel) ? MESSAGE_KEY_PLACE_NAV : MESSAGE_KEY_NAV_START, index);
  dict_write_int32(out, MESSAGE_KEY_LIST_ID, row_is_place(s_sel) ? s_places.list_id : s_model.list_id);
  app_message_outbox_send();
}
#endif

// ---- Compass ----------------------------------------------------------------

static void compass_handler(CompassHeadingData data) {
  int heading = -1;
  if (data.compass_status != CompassStatusDataInvalid && data.compass_status != CompassStatusUnavailable) {
    // magnetic_heading grows counter-clockwise; arrows want the clockwise heading
    heading = (int)(((TRIG_MAX_ANGLE - data.magnetic_heading % TRIG_MAX_ANGLE) % TRIG_MAX_ANGLE) * 360 / TRIG_MAX_ANGLE);
  }
  if (heading != s_heading) {
    s_heading = heading;
    if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
#if HAS_NAV
    if (s_nav_layer) layer_mark_dirty(s_nav_layer);
#endif
  }
}

// ---- Side menu ----------------------------------------------------------------
// A short SELECT slides a menu in from the right edge over the window it is pressed in (bus_menu: what can be done
// there). While it is open it has the buttons: UP / DOWN choose, SELECT does it, BACK closes the menu.

#define MENU_ITEM_H 26

static Layer *s_menu_layer;
static Window *s_menu_window;
static ClickConfigProvider s_menu_restore;   // the window's own buttons, back when the menu closes
static void (*s_menu_do)(int act);
static int16_t s_menu_left;                  // the panel's left edge (slides in)
static uint32_t s_menu_start;
static AppTimer *s_menu_timer;

static int16_t menu_target(int16_t w) {
  return PBL_IF_ROUND_ELSE(w * 30 / 100, w * 28 / 100);
}

static void menu_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int16_t x0 = s_menu_left, w = b.size.w - x0;
  if (w <= 0) return;
  fill_span(ctx, GColorWhite, x0, b.size.w, 0, b.size.h);
  fill_span(ctx, GColorBlack, x0, x0 + 2, 0, b.size.h);
  int16_t ih = MENU_ITEM_H, total = ih * s_menu.count, y = (b.size.h - total) / 2;
  int16_t tx = x0 + 8, tw = b.size.w - tx - PBL_IF_ROUND_ELSE(16, 4);
  for (int i = 0; i < s_menu.count; i++, y += ih) {
    bool sel = i == s_menu.sel;
    if (sel) {
      graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
      graphics_fill_rect(ctx, GRect(x0 + 4, y + 1, b.size.w - x0 - 4, ih - 2), 4, GCornersLeft);
    }
    graphics_context_set_text_color(ctx, sel ? GColorWhite : GColorBlack);
    draw_line(ctx, bus_menu_label(s_menu.acts[i]), s_f18b, tx, tw, y + ih / 2, GTextAlignmentLeft);
  }
}

static void menu_slide(void *data) {
  s_menu_timer = NULL;
  if (!s_menu_layer) return;
  int16_t w = layer_get_bounds(s_menu_layer).size.w, target = menu_target(w);
  uint32_t t = now_ms() - s_menu_start;
  if (t >= ANIM_MS || s_test_marquee >= 0 || !HAS_NAV) {   // (aplite: no room for the slide)
    s_menu_left = target;
  } else {
    int32_t p = (int32_t)(t * 1000u / ANIM_MS), e = 1000 - (1000 - p) * (1000 - p) / 1000;
    s_menu_left = (int16_t)(w - (w - target) * e / 1000);
    s_menu_timer = app_timer_register(FRAME_MS, menu_slide, NULL);
  }
  layer_mark_dirty(s_menu_layer);
}

static void menu_close(void) {
  if (s_menu_timer) {
    app_timer_cancel(s_menu_timer);
    s_menu_timer = NULL;
  }
  if (!s_menu_layer) return;
  layer_remove_from_parent(s_menu_layer);
  layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
  if (s_menu_window) window_set_click_config_provider(s_menu_window, s_menu_restore);
  s_menu_window = NULL;
}

static void menu_up(ClickRecognizerRef rec, void *ctx) {
  bus_menu_move(&s_menu, -1);
  layer_mark_dirty(s_menu_layer);
}

static void menu_down(ClickRecognizerRef rec, void *ctx) {
  bus_menu_move(&s_menu, 1);
  layer_mark_dirty(s_menu_layer);
}

static void menu_choose(ClickRecognizerRef rec, void *ctx) {
  int act = bus_menu_action(&s_menu);
  void (*fn)(int) = s_menu_do;
  menu_close();
  if (fn && act >= 0) fn(act);
}

static void menu_back(ClickRecognizerRef rec, void *ctx) {
  menu_close();
}

static void menu_click_config(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_MS, menu_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_MS, menu_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, menu_choose);
  window_single_click_subscribe(BUTTON_ID_BACK, menu_back);
}

// Opens the menu (s_menu filled in) over `window`, whose buttons are `own`; `fn` does the chosen action.
static void menu_open(Window *window, ClickConfigProvider own, void (*fn)(int act)) {
  menu_close();
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_menu_layer = layer_create(b);
  layer_set_update_proc(s_menu_layer, menu_update);
  layer_add_child(root, s_menu_layer);
  s_menu_window = window;
  s_menu_restore = own;
  s_menu_do = fn;
  s_menu_left = b.size.w;
  s_menu_start = now_ms();
  window_set_click_config_provider(window, menu_click_config);
  menu_slide(NULL);
}

// ---- Buttons ----------------------------------------------------------------

// The saved locations unfold into the wheel between the weather and the list: UP from the first row opens them with the
// best one selected (next to the list); the rows above it are the others. Scrolling down past them folds them away
// again once none is on screen; BACK goes straight back to the first row. Only a fresh press opens them: holding UP to
// get to the top stops at the first row.
static void open_places(void) {
  int p = s_places.count;
  s_places_open = true;
  s_sel += p;                     // the same rows, now below the places
  s_pos += p * 1000;
  s_anim_from += p * 1000;
  s_sel = p - 1;
  if (s_test_marquee >= 0) {
    jump_to_selection();
  } else {
    animate_to_selection();
  }
  s_marquee_start = now_ms();
  redraw();
}

static void close_places(void) {
  if (!s_places_open) return;
  s_places_open = false;
  s_sel = 0;
  jump_to_selection();
  s_marquee_start = now_ms();
  redraw();
}

// on the list again, and no place in view: fold them (the same rows, renumbered)
static void fold_places_if_hidden(void) {
  int p = places_rows();
  if (!p || s_sel < p) return;
  WheelSlot slots[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(&s_geom, view_rows(), s_pos, slots, WHEEL_MAX_SLOTS);
  if (n > 0 && slots[0].index < p) return;
  s_places_open = false;
  s_sel -= p;
  s_pos -= p * 1000;
  s_anim_from -= p * 1000;
  redraw();
}

static void move(int delta, bool held) {
  if (!s_places_open && delta < 0 && s_sel == 0 && s_places.count > 0) {
    if (!held) open_places();
    return;
  }
  int rows = view_rows(), sel = s_sel + delta;
  if (sel > rows - 1) sel = rows - 1;
  if (sel < 0) sel = 0;
  if (sel == s_sel) return;
  s_sel = sel;
  if (s_test_marquee >= 0) {
    jump_to_selection();  // test hook: deterministic frames, no animation
    fold_places_if_hidden();
    if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
  } else {
    animate_to_selection();
  }
  redraw();
}

// a repeating click counts its repeats: more than one = the button is being held
static void up_click(ClickRecognizerRef rec, void *ctx) { move(-1, click_number_of_clicks_counted(rec) > 1); }
static void down_click(ClickRecognizerRef rec, void *ctx) { move(1, click_number_of_clicks_counted(rec) > 1); }

// "Select" (a long SELECT does it at once): the row was picked, the phone learns from it
static void select_row(void) {
  int index = selected_index();
  if (index < 0) return;
  send_select(index);
  vibes_short_pulse();
}

static void select_long_click(ClickRecognizerRef rec, void *ctx) { select_row(); }

#if HAS_NAV
static void nav_show(void);
static void nav_clear(void);
#endif

static void home_action(int act) {
  switch (act) {
    case BUS_ACT_SELECT: select_row(); break;
    case BUS_ACT_UNDO: send_flag(MESSAGE_KEY_UNDO_SELECT, 1); break;
#if HAS_NAV
    case BUS_ACT_SHOW_TRIP: nav_show(); break;
    case BUS_ACT_START_TRIP:
    case BUS_ACT_REPLACE_TRIP: send_nav_start(selected_index()); break;
    case BUS_ACT_CLEAR_TRIP: nav_clear(); break;
#endif
    default: break;
  }
}

static void click_config(void *ctx);

static void select_click(ClickRecognizerRef rec, void *ctx) {
  bool trip = false;
#if HAS_NAV
  trip = bus_nav_running(&s_nav);
#endif
  bus_menu_home(&s_menu, HAS_NAV, trip, selected_index() >= 0);
  menu_open(s_window, click_config, home_action);
}

static void back_click(ClickRecognizerRef rec, void *ctx) {
  if (s_places_open) close_places();
  else window_stack_pop(true);
}

static void click_config(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_MS, up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_MS, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, select_long_click, NULL);
}

// Over the status line: a dot in the trip's colour while a trip is running (left), and a small arrow up while the
// saved locations are folded above the first row you are on (right).
static void hud_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int16_t cy = b.size.h / 2 + 1;
#if HAS_NAV
  if (bus_nav_running(&s_nav)) {
    const BusNavStep *st = bus_nav_step(&s_nav, s_nav.current);
    graphics_context_set_fill_color(ctx, route_color(st ? st->color : -1));
    graphics_fill_circle(ctx, GPoint(PBL_IF_ROUND_ELSE(6, 7), cy), 4);
  }
#endif
  if (!s_places_open && s_places.count > 0 && s_sel == 0 && s_model.count > 0) {
    int16_t x = b.size.w - PBL_IF_ROUND_ELSE(6, 8);
    graphics_context_set_fill_color(ctx, GColorBlack);
    for (int16_t r = 0; r < 4; r++) fill_span(ctx, GColorBlack, x - r, x + r + 1, cy - 2 + r, cy - 1 + r);
  }
}

static void focus_handler(bool in_focus) {
  s_focused = in_focus;
  if (in_focus) {
    s_marquee_start = now_ms();
    if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
  } else if (s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
}

static void tick_handler(struct tm *tick_time, TimeUnits changed) {
  redraw();
}

// ---- Window -----------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

#if defined(PBL_ROUND)
  // Status top centre; the wheel is vertically symmetric about the screen centre so its circle insets are exact.
  GRect status = GRect(30, ROUND_STATUS_Y - 3, b.size.w - 60, STATUS_H + 2);
  GRect wheel = GRect(0, ROUND_WHEEL_Y, b.size.w, b.size.h - 2 * ROUND_WHEEL_Y);
#else
  GRect status = GRect(2, -2, b.size.w - 4, STATUS_H + 2);
  GRect wheel = GRect(0, STATUS_H, b.size.w, b.size.h - STATUS_H);
#endif
  s_status_layer = text_layer_create(status);
  text_layer_set_font(s_status_layer, s_f14);
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_status_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_background_color(s_status_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  bus_wheel_geometry(&s_geom, wheel.size.w, wheel.size.h, PBL_IF_ROUND_ELSE(true, false));
  s_wheel_layer = layer_create(wheel);
  layer_set_update_proc(s_wheel_layer, wheel_update);
  layer_add_child(root, s_wheel_layer);
  s_hud_layer = layer_create(status);
  layer_set_update_proc(s_hud_layer, hud_update);
  layer_add_child(root, s_hud_layer);
  redraw();
}

static void window_unload(Window *window) {
  if (s_anim_timer) {
    app_timer_cancel(s_anim_timer);
    s_anim_timer = NULL;
  }
  menu_close();
  layer_destroy(s_wheel_layer);
  s_wheel_layer = NULL;
  layer_destroy(s_hud_layer);
  s_hud_layer = NULL;
  text_layer_destroy(s_status_layer);
  s_status_layer = NULL;
}

static void init(void) {
  s_f14 = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  s_f14b = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  s_f18 = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  s_f18b = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  s_f24b = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  s_arrow_path = gpath_create(&s_arrow_info);
  bus_model_init(&s_model);
  bus_places_init(&s_places);
  bus_wakeup_init(&s_wakeups);
  bus_weather_init(&s_weather);
#if HAS_NAV
  bus_nav_init(&s_nav);
#endif

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(HAS_NAV ? 768 : 512, 64);   // a trip row is the biggest message (aplite has no trip view)

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  compass_service_set_heading_filter(DEG_TO_TRIGANGLE(5));
  compass_service_subscribe(compass_handler);
  wakeup_service_subscribe(wakeup_handler);
  app_focus_service_subscribe(focus_handler);
  if (launch_reason() == APP_LAUNCH_WAKEUP) {
    WakeupId id;
    int32_t cookie;
    if (wakeup_get_launch_event(&id, &cookie)) report_wakeup(cookie);
  }
}

static void deinit(void) {
  if (s_wakeup_timer) app_timer_cancel(s_wakeup_timer);
  compass_service_unsubscribe();
  app_focus_service_unsubscribe();
  if (s_marquee_timer) app_timer_cancel(s_marquee_timer);
  tick_timer_service_unsubscribe();
  app_message_deregister_callbacks();
  if (s_notify_window) window_destroy(s_notify_window);
#if HAS_NAV
  if (s_nav_window) window_destroy(s_nav_window);
#endif
  window_destroy(s_window);
  gpath_destroy(s_arrow_path);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
