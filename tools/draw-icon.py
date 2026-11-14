#!/usr/bin/env python3
"""Draws resources/icon.png and resources/icon~bw.png: a 25x25 miniature of
the watch screen at Alexanderplatz (U2 selected, U8 next). Run from the repo root."""
from PIL import Image

W = 25
O = (255, 85, 0, 255)    # U2, VBB DA421E as GColorFromHEX truncates it
B = (0, 85, 170, 255)    # U8, VBB 224F86
K = (0, 0, 0, 255)
Wh = (255, 255, 255, 255)
S = (85, 85, 85, 255)
L = (170, 170, 170, 255)
T = (0, 0, 0, 0)


def build(bw=False):
    im = Image.new('RGBA', (W, W), Wh)

    def px(x, y, col):
        if bw and col in (O, S, B, L):
            col = K
        im.putpixel((x, y), col)

    def rect(x0, y0, x1, y1, col):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                px(x, y, col)

    def glyph(x0, y0, rows, col):
        for dy, r in enumerate(rows):
            for dx, ch in enumerate(r):
                if ch == '#':
                    px(x0 + dx, y0 + dy, col)

    # header bar in the route colour, with the route's long name
    rect(1, 1, 23, 3, O)
    rect(3, 2, 9, 2, Wh)
    rect(11, 2, 12, 2, Wh)
    rect(14, 2, 20, 2, Wh)
    # rounded U2 badge
    rect(2, 5, 10, 11, O)
    for p in [(2, 5), (10, 5), (2, 11), (10, 11)]:
        px(*p, Wh)
    glyph(3, 6, ["#.#", "#.#", "#.#", "#.#", "###"], Wh)
    glyph(7, 6, ["###", "..#", "###", "#..", "###"], Wh)
    # stop name "Ale" (Alexanderplatz, cut short), clear of the badge and the edge
    glyph(13, 6, [".#.", "#.#", "###", "#.#", "#.#"], K)
    glyph(17, 6, ["#", "#", "#", "#", "#"], K)
    glyph(19, 6, ["...", "###", "#.#", "##.", "###"], K)
    # first times line and the arrow to the stop
    for a, b in [(2, 3), (5, 5), (7, 9), (11, 12), (14, 15)]:
        rect(a, 13, b, 14, S)
    glyph(18, 12, ["..###", "...##", "..#.#", ".#..."], K)
    # second times line and the distance under the arrow
    for a, b in [(2, 3), (5, 5), (7, 9)]:
        rect(a, 17, b, 18, S)
    rect(19, 17, 22, 18, S)
    # bar under the selected row
    rect(1, 20, 23, 20, O)
    # next row (U8), cut off by the bezel like the drum continuing
    rect(2, 22, 7, 23, B)
    px(2, 22, Wh)
    px(7, 22, Wh)
    rect(9, 22, 10, 23, L)
    rect(12, 22, 19, 23, K)
    # bezel with rounded corners
    for i in range(W):
        px(i, 0, K)
        px(i, W - 1, K)
        px(0, i, K)
        px(W - 1, i, K)
    for p in [(0, 0), (W - 1, 0), (0, W - 1), (W - 1, W - 1)]:
        im.putpixel(p, T)
    return im


build().save('resources/icon.png')
build(True).save('resources/icon~bw.png')
