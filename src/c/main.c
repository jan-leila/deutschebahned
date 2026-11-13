// Bus Watch — watch UI: a custom-drawn "rotating drum" list of the items the phone sends (see CONTRACTS.md §11).
// Layout math lives in bus_wheel.c; this file only draws slots, handles buttons, animation and AppMessage.
#include <pebble.h>
#include "bus_model.h"
#include "bus_wheel.h"
#include "bus_arrow.h"
#include "bus_wakeup.h"
#include "bus_marquee.h"

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

static Window *s_window;
static TextLayer *s_status_layer;
static Layer *s_wheel_layer;
static BusModel s_model;
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

static int16_t badge_width(const BusItem *it, GFont font, int16_t max_w) {
  if (!it->badge[0]) return 0;
  FontMetrics fi = font_info(font);
  int16_t pad = fi.cap >= 12 ? 5 : 3;
  int16_t w = text_width(it->badge, font) + 2 * pad, h = fi.cap + 2 * pad + 1;
  if (w < h) w = h;
  return w > max_w ? max_w : w;
}

// Route badge: rounded rect in the route color centred on cy; returns its width (0 when there is no badge).
// The badge never reaches above min_y: when the room above cy is short it shrinks vertically (still centred on cy,
// never below the glyph height) so it cannot run into the level-0 route band / top bar.
static int16_t draw_badge(GContext *ctx, const BusItem *it, GFont font, int16_t x, int16_t cy, int16_t max_w,
                          int16_t min_y) {
  int16_t w = badge_width(it, font, max_w);
  if (!w) return 0;
  FontMetrics fi = font_info(font);
  int16_t pad = fi.cap >= 12 ? 5 : 3;
  int16_t h = fi.cap + 2 * pad + 1;
  int32_t room = 2 * ((int32_t)cy - min_y);
  if (h > room) h = room < fi.cap + 3 ? fi.cap + 3 : (int16_t)room;
  graphics_context_set_fill_color(ctx, route_color(it->color));
  graphics_fill_rect(ctx, GRect(x, cy - h / 2, w, h), 4, GCornersAll);
  graphics_context_set_text_color(ctx, badge_text_color(it->color));
  draw_line(ctx, it->badge, font, x, w, cy, GTextAlignmentCenter);
  return w;
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
  fill_span(ctx, inner, mx0, bx, y0, y1);
  fill_span(ctx, inner, bx + bw, mx1, y0, y1);
  fill_span(ctx, GColorWhite, 0, mx0, y0, y1);
  fill_span(ctx, GColorWhite, mx1, layer_w, y0, y1);
}

// Arrow pointing at a stop, filled with the route color (black on B&W), outlined when the color is light.
static void draw_arrow(GContext *ctx, const BusItem *it, int16_t cx, int16_t cy, int16_t r) {
  BusPoint p[4];
  bus_arrow_points(bus_arrow_angle(it->bearing, s_heading), cx, cy, r, p);
  for (int i = 0; i < 4; i++) s_arrow_points[i] = GPoint(p[i].x, p[i].y);
  graphics_context_set_fill_color(ctx, route_color(it->color));
  gpath_draw_filled(ctx, s_arrow_path);
#if defined(PBL_COLOR)
  if (bus_color_prefers_dark_text(it->color)) {
    graphics_context_set_stroke_color(ctx, GColorBlack);
    gpath_draw_outline(ctx, s_arrow_path);
  }
#endif
}

// Small direction label ("NB") right of the badge; returns the width used (incl. spacing), 0 when none.
static int16_t draw_dir(GContext *ctx, const char *dir, GFont font, int16_t x, int16_t cy, GColor color) {
  if (!dir[0]) return 0;
  int16_t w = text_width(dir, font);
  graphics_context_set_text_color(ctx, color);
  draw_line(ctx, dir, font, x, w + 2, cy, GTextAlignmentLeft);
  return w + 4;
}

static void draw_slot(GContext *ctx, const WheelSlot *s, int16_t width) {
  const BusItem *it = bus_model_item(&s_model, s->index);
  int16_t x = s->inset, w = width - 2 * s->inset;
  if (w <= 8) return;

  int16_t pad = s->level == 0 ? 4 : 3;
  int16_t ix = x + pad, iw = w - 2 * pad;
  // Level 0: a route-color band on top (holding the route's full name when there is one) and a bar below.
  int16_t band_h = s->level == 0 ? (it && it->route[0] ? ROUTE_BAND_H : BAR_H) : 0;
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
  int16_t tx = bx + (bw ? bw + 4 : 0) + (show_dir ? text_width(it->dir, dir_font) + 4 : 0);
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
  if (mode == 'A') {
    int16_t colw = (has_arrow || has_dist) ? ARROW_COL_W : 0, lw = iw - colw;
    graphics_context_set_text_color(ctx, detail_color);
    if (two) {
      char lane[40];
      bus_format_lane(it->t, now, lane, sizeof lane);
      snprintf(buf, sizeof buf, "%s%s%s", it->dir, it->dir[0] ? " " : "", lane);
      draw_line(ctx, buf, detail_font, ix, lw, line1_cy, GTextAlignmentLeft);
      bus_format_lane(it->u, now, lane, sizeof lane);
      snprintf(buf, sizeof buf, "%s%s%s", it->dir2, it->dir2[0] ? " " : "", lane);
      draw_line(ctx, buf, detail_font, ix, lw, line2_cy, GTextAlignmentLeft);
    } else {
      bus_format_detail(it, now, clock_is_24h_style(), buf, sizeof buf);
      draw_line(ctx, buf, detail_font, ix, lw, (line1_cy + line2_cy) / 2, GTextAlignmentLeft);
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
    bus_format_detail(it, now, clock_is_24h_style(), buf, sizeof buf);
    graphics_context_set_text_color(ctx, detail_color);
    draw_line(ctx, buf, detail_font, ix, right - ix, line1_cy, GTextAlignmentLeft);
  }
}

static void marquee_tick(void *data) {
  s_marquee_timer = NULL;
  if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
}

// After a redraw: wake up when a marquee next moves; no timer while nothing scrolls, while the scroll animation
// redraws anyway, or while the app is not in the foreground.
static void schedule_marquee(void) {
  if (s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
  if (s_marquee_wait && s_focused && !s_anim_timer) s_marquee_timer = app_timer_register(s_marquee_wait, marquee_tick, NULL);
}

static void wheel_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  s_marquee_wait = 0;
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  if (s_model.count == 0) {
    graphics_context_set_text_color(ctx, GColorBlack);
    int16_t inset = PBL_IF_ROUND_ELSE(14, 4);
    GRect r = GRect(inset, b.size.h / 2 - 34, b.size.w - 2 * inset, 50);
    graphics_draw_text(ctx, s_model.status, s_f18b, r, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    r = GRect(inset, b.size.h / 2 + 16, b.size.w - 2 * inset, 20);
    graphics_draw_text(ctx, "Hold SELECT to refresh", s_f14, r, GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentCenter, NULL);
    schedule_marquee();
    return;
  }

  WheelSlot slots[WHEEL_MAX_SLOTS];
  int n = bus_wheel_layout(&s_geom, s_model.count, s_pos, slots, WHEEL_MAX_SLOTS);
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
    text_layer_set_text(s_status_layer, s_model.status);
    layer_set_hidden(text_layer_get_layer(s_status_layer), s_model.count == 0);
  }
  if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
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
    int32_t p = (int32_t)s_sel * 1000 + (-v - 1000), max = (int32_t)(bus_model_row_count(&s_model) - 1) * 1000;
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
// Flags: bit 0 = 24 h clock, bit 1 = metric, bit 2 = measurement system known.
static bool s_prefs_sent = false;

static int32_t watch_prefs(void) {
  int32_t flags = clock_is_24h_style() ? 1 : 0;
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
    s_marquee_start = now_ms();
    int sel = bus_model_clamp_selection(&s_model, s_sel);
    if (sel != s_sel) {
      s_sel = sel;
      jump_to_selection();
    }
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
  }
  if (status) {
    bus_model_set_status(&s_model, tuple_str(status));
  }
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

static void send_select(int index) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, MESSAGE_KEY_SELECT_INDEX, index);
  dict_write_int32(out, MESSAGE_KEY_LIST_ID, s_model.list_id);
  app_message_outbox_send();
}

static void send_refresh(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, MESSAGE_KEY_REFRESH, 1);
  app_message_outbox_send();
}

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
  }
}

// ---- Buttons ----------------------------------------------------------------

static void move(int delta) {
  int sel = bus_model_clamp_selection(&s_model, s_sel + delta);
  if (sel == s_sel) return;
  s_sel = sel;
  if (s_test_marquee >= 0) {
    jump_to_selection();  // test hook: deterministic frames, no animation
    if (s_wheel_layer) layer_mark_dirty(s_wheel_layer);
  } else {
    animate_to_selection();
  }
}

static void up_click(ClickRecognizerRef rec, void *ctx) { move(-1); }
static void down_click(ClickRecognizerRef rec, void *ctx) { move(1); }

static void select_click(ClickRecognizerRef rec, void *ctx) {
  if (!bus_model_item(&s_model, s_sel)) return;
  send_select(s_sel);
  vibes_short_pulse();
}

static void select_long_click(ClickRecognizerRef rec, void *ctx) {
  send_refresh();
}

static void click_config(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_MS, up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_MS, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, select_long_click, NULL);
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
  redraw();
}

static void window_unload(Window *window) {
  if (s_anim_timer) {
    app_timer_cancel(s_anim_timer);
    s_anim_timer = NULL;
  }
  layer_destroy(s_wheel_layer);
  s_wheel_layer = NULL;
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
  bus_wakeup_init(&s_wakeups);

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
  app_message_open(768, 64);

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
  window_destroy(s_window);
  gpath_destroy(s_arrow_path);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
