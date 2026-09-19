/**
 * cards-svg.js
 *
 * Self-contained playing-card SVG generator.
 *
 *  - No external assets, no external fonts, no external libraries.
 *  - Every glyph (A, 2..10, J, Q, K) is drawn with <path> data defined in this
 *    file, so rendering never depends on a font being installed.
 *  - Every SVG string is self-contained: all <defs> ids carry a card specific
 *    prefix so several cards can live in the same DOM without id collisions.
 *  - viewBox is always "0 0 500 700" (5:7) and no width/height attribute is
 *    emitted, so the consumer (e.g. a Three.js CanvasTexture) can rasterise at
 *    any resolution it likes.
 *
 * Public API:
 *   SUITS, RANKS, cardSVG(rank, suit, opts), cardBackSVG(opts), svgToDataURL(svg)
 */

export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/* ------------------------------------------------------------------ *
 * Geometry / palette constants
 * ------------------------------------------------------------------ */

const VB_W = 500;
const VB_H = 700;
const CENTER_X = VB_W / 2; // 250
const CENTER_Y = VB_H / 2; // 350

const DEFAULTS = {
  cornerRadius: 34,
  bleed: 0,
  margin: 7,
};

/** Shared colour palette. */
const PAL = {
  paper: '#ffffff',
  panel: '#fdfaf2',
  panelEdge: '#e6ddc6',
  border: '#c8ced8',
  innerFrame: '#e4e8ef',
  ink: '#1a1a2e',
  suitRed: '#d1283a',
  suitBlack: '#151821',

  gold: '#d4a017',
  goldDark: '#9a7409',
  goldLight: '#f2dc9a',

  red: '#c0392b',
  redDark: '#8e2620',
  redLight: '#e0685a',

  blue: '#2c5aa0',
  blueDark: '#1d3c6e',
  blueLight: '#5b86c9',

  green: '#2e7d5b',
  greenDark: '#1d5640',
  greenLight: '#5aa885',

  skin: '#f2d0b4',
  skinShade: '#d6a880',
  skinDeep: '#b9825c',

  hairWhite: '#eceaf0',
  hairWhiteShade: '#bcb9c6',
  hairGold: '#e3b94f',
  hairGoldShade: '#ab8526',
  hairBrown: '#8b5a2b',
  hairBrownShade: '#60391a',

  steel: '#dfe4ec',
  steelDark: '#98a1b3',
  wood: '#6b4226',
  woodDark: '#48290f',
};

/** Suit -> ink colour used for pips and corner indices. */
const SUIT_COLOR = {
  spades: PAL.suitBlack,
  clubs: PAL.suitBlack,
  hearts: PAL.suitRed,
  diamonds: PAL.suitRed,
};

/**
 * Suit silhouettes, each a single path drawn in a 0..100 / 0..100 box and
 * roughly centred on (50, 50).  They are emitted once into <defs> and reused
 * through <use>, so the fill colour is inherited from the <use> element.
 */
const SUIT_PATHS = {
  spades:
    'M 50 4 C 47 12 33 30 22 42 C 11 54 5 64 5 75 C 5 87 14 95 26 95 ' +
    'C 35 95 42 90 46 82 C 46 88 44 94 40 98 C 37 101 34 102 31 103 ' +
    'L 69 103 C 66 102 63 101 60 98 C 56 94 54 88 54 82 C 58 90 65 95 74 95 ' +
    'C 86 95 95 87 95 75 C 95 64 89 54 78 42 C 67 30 53 12 50 4 Z',
  hearts:
    'M 50 96 C 44 88 32 77 21 66 C 10 55 4 45 4 33 C 4 18 15 6 30 6 ' +
    'C 39 6 46 11 50 19 C 54 11 61 6 70 6 C 85 6 96 18 96 33 ' +
    'C 96 45 90 55 79 66 C 68 77 56 88 50 96 Z',
  diamonds:
    'M 50 3 C 57 19 70 36 88 50 C 70 64 57 81 50 97 ' +
    'C 43 81 30 64 12 50 C 30 36 43 19 50 3 Z',
  clubs:
    'M 50 4 C 37 4 27 14 27 27 C 27 32 28 37 31 41 C 27 38 22 36 17 36 ' +
    'C 6 36 -2 45 -2 57 C -2 69 6 78 18 78 C 29 78 38 71 41 62 ' +
    'C 41 74 38 89 30 97 C 28 99 26 101 23 102 L 77 102 ' +
    'C 74 101 72 99 70 97 C 62 89 59 74 59 62 C 62 71 71 78 82 78 ' +
    'C 94 78 102 69 102 57 C 102 45 94 36 83 36 C 78 36 73 38 69 41 ' +
    'C 72 37 73 32 73 27 C 73 14 63 4 50 4 Z',
};

/**
 * Glyphs for the rank indices.  Each glyph is a *stroked* path inside a
 * 0..w / 0..140 box (y = 0 cap line, y = 140 baseline).  Drawing them as
 * strokes with round caps/joins gives a clean condensed-sans look with far
 * less path data than outlined letterforms, and keeps them crisp at any
 * rasterisation size.
 */
const GLYPH_BOX_H = 140;
const GLYPH_STROKE = 18;
const GLYPHS = {
  '1': { w: 52, d: 'M 10 42 L 33 8 L 33 132' },
  '2': { w: 80, d: 'M 12 38 C 12 19 25 8 41 8 C 58 8 70 20 70 38 C 70 58 54 73 12 132 L 71 132' },
  '3': {
    w: 80,
    d:
      'M 12 30 C 18 14 30 8 42 8 C 57 8 67 18 67 32 C 67 47 56 57 41 57 ' +
      'C 58 57 70 69 70 89 C 70 113 55 132 38 132 C 24 132 13 125 8 112',
  },
  '4': { w: 82, d: 'M 55 132 L 55 8 L 8 95 L 76 95' },
  '5': {
    w: 80,
    d:
      'M 66 8 L 23 8 L 17 62 C 27 54 36 51 45 51 C 62 51 72 68 72 89 ' +
      'C 72 113 56 132 38 132 C 24 132 13 125 8 112',
  },
  '6': {
    w: 80,
    d:
      'M 62 14 C 55 9 47 8 41 8 C 23 8 11 31 11 72 C 11 106 23 132 42 132 ' +
      'C 58 132 70 119 70 101 C 70 83 58 71 42 71 C 26 71 13 82 12 98',
  },
  '7': { w: 80, d: 'M 10 8 L 71 8 L 36 132' },
  '8': {
    w: 80,
    d:
      'M 40 64 C 25 64 13 52 13 38 C 13 21 25 8 40 8 C 55 8 67 21 67 38 ' +
      'C 67 52 55 64 40 64 C 57 64 71 78 71 98 C 71 117 57 132 40 132 ' +
      'C 23 132 9 117 9 98 C 9 78 23 64 40 64 Z',
  },
  '9': {
    w: 80,
    d:
      'M 18 126 C 25 131 33 132 39 132 C 57 132 69 109 69 68 C 69 34 57 8 38 8 ' +
      'C 22 8 10 21 10 39 C 10 57 22 69 38 69 C 54 69 67 58 68 42',
  },
  '0': {
    w: 80,
    d:
      'M 40 8 C 58 8 70 34 70 70 C 70 106 58 132 40 132 ' +
      'C 22 132 10 106 10 70 C 10 34 22 8 40 8 Z',
  },
  A: { w: 88, d: 'M 6 132 L 44 8 L 82 132 M 21 94 L 67 94' },
  J: { w: 76, d: 'M 34 8 L 68 8 M 59 8 L 59 98 C 59 120 46 132 30 132 C 16 132 7 123 4 108' },
  Q: {
    w: 86,
    d:
      'M 43 8 C 61 8 73 34 73 70 C 73 106 61 132 43 132 C 25 132 13 106 13 70 ' +
      'C 13 34 25 8 43 8 Z M 49 100 L 79 138',
  },
  K: { w: 82, d: 'M 12 8 L 12 132 M 13 78 L 67 8 M 31 54 L 72 132' },
};

/* ------------------------------------------------------------------ *
 * Small string helpers
 * ------------------------------------------------------------------ */

const n = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};

/** Build an element from a tag name and an attribute map. */
function el(tag, attrs, children) {
  let s = '<' + tag;
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    s += ' ' + k + '="' + v + '"';
  }
  if (children === undefined || children === null || children === '') return s + '/>';
  return s + '>' + children + '</' + tag + '>';
}

const path = (d, attrs) => el('path', Object.assign({ d }, attrs || {}));

/** A stroked (not filled) path - used constantly for line work. */
const line = (d, stroke, width, extra) =>
  el(
    'path',
    Object.assign(
      {
        d,
        fill: 'none',
        stroke,
        'stroke-width': n(width),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      extra || {}
    )
  );

/** A filled path with an optional outline. */
const shape = (d, fill, stroke, width, extra) =>
  el(
    'path',
    Object.assign(
      {
        d,
        fill,
        stroke: stroke || undefined,
        'stroke-width': stroke ? n(width === undefined ? 2 : width) : undefined,
        'stroke-linejoin': stroke ? 'round' : undefined,
        'stroke-linecap': stroke ? 'round' : undefined,
      },
      extra || {}
    )
  );

const circle = (cx, cy, r, fill, stroke, width) =>
  el('circle', {
    cx: n(cx),
    cy: n(cy),
    r: n(r),
    fill,
    stroke: stroke || undefined,
    'stroke-width': stroke ? n(width === undefined ? 2 : width) : undefined,
  });

const ellipse = (cx, cy, rx, ry, fill, stroke, width, extra) =>
  el(
    'ellipse',
    Object.assign(
      {
        cx: n(cx),
        cy: n(cy),
        rx: n(rx),
        ry: n(ry),
        fill,
        stroke: stroke || undefined,
        'stroke-width': stroke ? n(width === undefined ? 2 : width) : undefined,
      },
      extra || {}
    )
  );

const group = (transform, children, extra) =>
  el('g', Object.assign({ transform: transform || undefined }, extra || {}), children);

/** Mirror a chunk of art about the vertical centre line of the card. */
const mirrorX = (children, axis) =>
  group('translate(' + n(2 * (axis === undefined ? CENTER_X : axis)) + ',0) scale(-1,1)', children);

/* ------------------------------------------------------------------ *
 * Reusable primitives: suit marks and rank glyphs
 * ------------------------------------------------------------------ */

/** Reference the card's suit symbol, centred on (cx, cy) at the given size. */
function suitMark(defId, cx, cy, size, color, opts) {
  const o = opts || {};
  const s = size / 100;
  const rot = o.flip ? ' rotate(180)' : '';
  const t =
    'translate(' + n(cx) + ',' + n(cy) + ')' + rot + ' scale(' + n(s) + ') translate(-50,-50)';
  return el('use', {
    href: '#' + defId,
    'xlink:href': '#' + defId,
    transform: t,
    fill: color,
    stroke: o.stroke || undefined,
    'stroke-width': o.stroke ? n((o.strokeWidth || 2) / s) : undefined,
    opacity: o.opacity === undefined ? undefined : n(o.opacity),
  });
}

/**
 * Draw a rank string ("A", "10", "K", ...) with self-defined path glyphs.
 * The glyph block is horizontally centred on cx, its cap line sits on topY,
 * and its total height is `height`.
 */
function rankGlyph(rank, cx, topY, height, color, opts) {
  const o = opts || {};
  const chars = rank.split('');
  const gap = o.gap === undefined ? 6 : o.gap;
  let total = 0;
  for (let i = 0; i < chars.length; i++) {
    total += (GLYPHS[chars[i]] || GLYPHS['0']).w;
    if (i < chars.length - 1) total += gap;
  }
  const s = height / GLYPH_BOX_H;
  let x = 0;
  let body = '';
  for (let i = 0; i < chars.length; i++) {
    const g = GLYPHS[chars[i]] || GLYPHS['0'];
    body += group('translate(' + n(x) + ',0)', line(g.d, color, o.weight || GLYPH_STROKE));
    x += g.w + gap;
  }
  return group(
    'translate(' + n(cx - (total * s) / 2) + ',' + n(topY) + ') scale(' + n(s) + ')',
    body
  );
}

/* ------------------------------------------------------------------ *
 * Card shell (rounded white card, borders, corner indices)
 * ------------------------------------------------------------------ */

function cardShell(opts) {
  const m = opts.margin;
  const b = opts.bleed;
  const r = opts.cornerRadius;
  let s = '';
  // Bleed layer: a slightly larger solid card so that a texture with a tiny
  // sampling offset never reveals a transparent seam.
  if (b > 0) {
    s += el('rect', {
      x: n(m - b),
      y: n(m - b),
      width: n(VB_W - 2 * m + 2 * b),
      height: n(VB_H - 2 * m + 2 * b),
      rx: n(r + b),
      ry: n(r + b),
      fill: PAL.paper,
    });
  }
  s += el('rect', {
    x: n(m),
    y: n(m),
    width: n(VB_W - 2 * m),
    height: n(VB_H - 2 * m),
    rx: n(r),
    ry: n(r),
    fill: PAL.paper,
    stroke: PAL.border,
    'stroke-width': '2.5',
  });
  // Inner hairline frame.
  s += el('rect', {
    x: n(m + 9),
    y: n(m + 9),
    width: n(VB_W - 2 * m - 18),
    height: n(VB_H - 2 * m - 18),
    rx: n(Math.max(4, r - 9)),
    ry: n(Math.max(4, r - 9)),
    fill: 'none',
    stroke: PAL.innerFrame,
    'stroke-width': '1.6',
  });
  return s;
}

/** Top-left index block plus its 180-degree rotated twin. */
function cornerIndices(rank, suit, defId, color) {
  const glyphH = rank === '10' ? 58 : 62;
  const one =
    rankGlyph(rank, 52, 38, glyphH, color, { weight: 17 }) +
    suitMark(defId, 52, 128, 42, color);
  return one + group('rotate(180 ' + CENTER_X + ' ' + CENTER_Y + ')', one);
}

/* ------------------------------------------------------------------ *
 * Number / ace pip layouts
 * ------------------------------------------------------------------ */

const COL = { L: 168, C: CENTER_X, R: 332 };
// Row bands for the 2..8 family (3 rows per column) and the 9/10 family
// (4 rows per column).  All rows are symmetric about y = 350.
const R3 = { top: 178, mid: 350, bot: 522 };
const R4 = { a: 178, b: 292.667, c: 407.333, d: 522 };

const PIP_LAYOUTS = {
  '2': [[COL.C, R3.top], [COL.C, R3.bot]],
  '3': [[COL.C, R3.top], [COL.C, R3.mid], [COL.C, R3.bot]],
  '4': [[COL.L, R3.top], [COL.R, R3.top], [COL.L, R3.bot], [COL.R, R3.bot]],
  '5': [
    [COL.L, R3.top],
    [COL.R, R3.top],
    [COL.C, R3.mid],
    [COL.L, R3.bot],
    [COL.R, R3.bot],
  ],
  '6': [
    [COL.L, R3.top],
    [COL.R, R3.top],
    [COL.L, R3.mid],
    [COL.R, R3.mid],
    [COL.L, R3.bot],
    [COL.R, R3.bot],
  ],
  '7': [
    [COL.L, R3.top],
    [COL.R, R3.top],
    [COL.C, (R3.top + R3.mid) / 2],
    [COL.L, R3.mid],
    [COL.R, R3.mid],
    [COL.L, R3.bot],
    [COL.R, R3.bot],
  ],
  '8': [
    [COL.L, R3.top],
    [COL.R, R3.top],
    [COL.C, (R3.top + R3.mid) / 2],
    [COL.L, R3.mid],
    [COL.R, R3.mid],
    [COL.C, (R3.mid + R3.bot) / 2],
    [COL.L, R3.bot],
    [COL.R, R3.bot],
  ],
  '9': [
    [COL.L, R4.a],
    [COL.R, R4.a],
    [COL.L, R4.b],
    [COL.R, R4.b],
    [COL.C, 350],
    [COL.L, R4.c],
    [COL.R, R4.c],
    [COL.L, R4.d],
    [COL.R, R4.d],
  ],
  '10': [
    [COL.L, R4.a],
    [COL.R, R4.a],
    [COL.C, (R4.a + R4.b) / 2],
    [COL.L, R4.b],
    [COL.R, R4.b],
    [COL.L, R4.c],
    [COL.R, R4.c],
    [COL.C, (R4.c + R4.d) / 2],
    [COL.L, R4.d],
    [COL.R, R4.d],
  ],
};

const PIP_SIZE = 78;

function pipFace(rank, defId, color) {
  const layout = PIP_LAYOUTS[rank];
  let s = '';
  for (let i = 0; i < layout.length; i++) {
    const cx = layout[i][0];
    const cy = layout[i][1];
    // Everything in the lower half of the card is printed upside down, exactly
    // as on a real deck.
    s += suitMark(defId, cx, cy, PIP_SIZE, color, { flip: cy > CENTER_Y + 0.5 });
  }
  return s;
}

function aceFace(suit, defId, color) {
  const big = suit === 'spades' ? 210 : 176;
  let s = '';
  // Understated ornament ring behind the central pip.
  s += circle(CENTER_X, CENTER_Y, 132, 'none', PAL.innerFrame, 1.4);
  s += circle(CENTER_X, CENTER_Y, 124, 'none', PAL.innerFrame, 0.9);
  s += suitMark(defId, CENTER_X, CENTER_Y - 4, big, color);
  return s;
}

/* ------------------------------------------------------------------ *
 * Court cards (J / Q / K)
 *
 * The picture is built as a single *top half*, drawn inside the panel and
 * clipped to y <= 350.  The bottom half is the very same markup wrapped in
 * <g transform="rotate(180 250 350)"> and clipped to y >= 350 - which is how
 * real court cards are printed.
 * ------------------------------------------------------------------ */

const PANEL = { x: 96, y: 68, w: 308, h: 564 }; // 68 .. 632 vertically

/** Per-suit court colour scheme (red cards vs black cards). */
function courtPalette(suit) {
  if (suit === 'spades') {
    return {
      primary: PAL.blue,
      primaryDark: PAL.blueDark,
      primaryLight: PAL.blueLight,
      secondary: PAL.red,
      secondaryDark: PAL.redDark,
      secondaryLight: PAL.redLight,
      cloth: '#33406b',
    };
  }
  if (suit === 'clubs') {
    return {
      primary: PAL.green,
      primaryDark: PAL.greenDark,
      primaryLight: PAL.greenLight,
      secondary: PAL.red,
      secondaryDark: PAL.redDark,
      secondaryLight: PAL.redLight,
      cloth: '#2f5f7d',
    };
  }
  if (suit === 'hearts') {
    return {
      primary: PAL.red,
      primaryDark: PAL.redDark,
      primaryLight: PAL.redLight,
      secondary: PAL.blue,
      secondaryDark: PAL.blueDark,
      secondaryLight: PAL.blueLight,
      cloth: '#a33228',
    };
  }
  return {
    // diamonds
    primary: '#cf4b2c',
    primaryDark: '#93331c',
    primaryLight: '#ea7a5c',
    secondary: PAL.blue,
    secondaryDark: PAL.blueDark,
    secondaryLight: PAL.blueLight,
    cloth: '#b8452a',
  };
}

/* ---- shared anatomy -------------------------------------------- */

/** The neck, drawn behind the collar and the head. */
function neck() {
  return (
    shape('M 227 196 L 273 196 L 276 254 L 224 254 Z', PAL.skin, PAL.skinShade, 2) +
    shape('M 227 196 L 273 196 L 272 214 C 262 226 238 226 228 214 Z', PAL.skinShade, null, 0, {
      opacity: '0.55',
    })
  );
}

/**
 * Face: oval, ears, brows, eyes (white / iris / pupil / highlight), nose,
 * mouth and cheek colour.  Roughly 20 separate paths.
 */
function face(opts) {
  const o = opts || {};
  const iris = o.iris || PAL.blue;
  const brow = o.brow === undefined ? 4.6 : o.brow;
  let s = '';
  // ears
  s += shape(
    'M 207 158 C 197 153 189 161 192 173 C 195 185 203 191 210 189 Z',
    PAL.skin,
    PAL.skinShade,
    2
  );
  s += shape(
    'M 293 158 C 303 153 311 161 308 173 C 305 185 297 191 290 189 Z',
    PAL.skin,
    PAL.skinShade,
    2
  );
  s += line('M 199 164 C 203 168 204 176 201 181', PAL.skinDeep, 2);
  s += line('M 301 164 C 297 168 296 176 299 181', PAL.skinDeep, 2);
  // face oval
  s += shape(
    'M 250 110 C 283 110 296 134 296 165 C 296 177 294 188 290 197 ' +
      'C 283 214 268 227 250 227 C 232 227 217 214 210 197 ' +
      'C 206 188 204 177 204 165 C 204 134 217 110 250 110 Z',
    PAL.skin,
    PAL.skinShade,
    2.4
  );
  // temple / cheek shading
  s += shape(
    'M 210 150 C 206 166 208 186 214 198 C 208 190 204 176 204 164 C 204 158 206 153 210 150 Z',
    PAL.skinShade,
    null,
    0,
    { opacity: '0.5' }
  );
  s += shape(
    'M 290 150 C 294 166 292 186 286 198 C 292 190 296 176 296 164 C 296 158 294 153 290 150 Z',
    PAL.skinShade,
    null,
    0,
    { opacity: '0.5' }
  );
  // brows
  const browY = o.browLift ? 142 : 146;
  s += line(
    'M 215 ' + n(browY) + ' C 223 ' + n(browY - 9) + ' 240 ' + n(browY - 9) + ' 247 ' + n(browY - 1),
    o.browColor || PAL.ink,
    brow,
    { opacity: '0.9' }
  );
  s += line(
    'M 285 ' + n(browY) + ' C 277 ' + n(browY - 9) + ' 260 ' + n(browY - 9) + ' 253 ' + n(browY - 1),
    o.browColor || PAL.ink,
    brow,
    { opacity: '0.9' }
  );
  // eyes
  s += ellipse(231, 166, 13.5, 8.5, '#ffffff', PAL.ink, 2.2);
  s += ellipse(269, 166, 13.5, 8.5, '#ffffff', PAL.ink, 2.2);
  s += circle(232, 167, 6, iris);
  s += circle(268, 167, 6, iris);
  s += circle(232, 167, 2.8, PAL.ink);
  s += circle(268, 167, 2.8, PAL.ink);
  s += circle(229.8, 164.6, 1.9, '#ffffff');
  s += circle(265.8, 164.6, 1.9, '#ffffff');
  s += line('M 218 162 C 224 154 239 154 244 161', PAL.ink, 3);
  s += line('M 282 162 C 276 154 261 154 256 161', PAL.ink, 3);
  // nose
  s += line('M 250 154 C 248 168 246 178 243 185 C 241 190 246 193 252 190', PAL.skinDeep, 3.2);
  s += circle(241, 187, 1.8, PAL.skinDeep);
  // mouth
  if (o.mouth !== false) {
    s += shape(
      'M 236 200 C 242 196 258 196 264 200 C 258 208 242 208 236 200 Z',
      o.lips || '#b4544a',
      PAL.skinDeep,
      1.6
    );
    s += line('M 236 200 C 244 202 256 202 264 200', PAL.skinDeep, 1.6);
  }
  // cheeks
  s += ellipse(221, 188, 8, 5.5, o.blush || PAL.redLight, null, 0, { opacity: '0.35' });
  s += ellipse(279, 188, 8, 5.5, o.blush || PAL.redLight, null, 0, { opacity: '0.35' });
  return s;
}

/** Gold-trimmed medallion carrying the suit symbol, worn on the chest. */
function medallion(defId, cx, cy, r, suitColor) {
  return (
    circle(cx, cy, r, PAL.gold, PAL.goldDark, 2.5) +
    circle(cx, cy, r - 5, PAL.panel, PAL.goldDark, 1.4) +
    suitMark(defId, cx, cy, r * 1.35, suitColor)
  );
}

/** A jewel: coloured stone in a gold bezel. */
function jewel(cx, cy, r, color) {
  return (
    circle(cx, cy, r, PAL.gold, PAL.goldDark, 1.6) +
    circle(cx, cy, r - 2, color) +
    circle(cx - r * 0.3, cy - r * 0.3, r * 0.26, '#ffffff', null, 0)
  );
}

/* ---- king ------------------------------------------------------- */

function kingCrown(cp) {
  let s = '';
  // velvet cap peeking through the crown
  s += shape('M 203 112 C 218 98 282 98 297 112 L 297 122 L 203 122 Z', cp.secondary, cp.secondaryDark, 2);
  // crown points
  s += shape(
    'M 197 110 L 188 84 L 210 100 L 228 78 L 250 96 L 272 78 L 290 100 L 312 84 L 303 110 Z',
    PAL.gold,
    PAL.goldDark,
    3
  );
  // inner highlight on the points
  s += line('M 197 104 L 191 88', PAL.goldLight, 3.2);
  s += line('M 228 86 L 228 96', PAL.goldLight, 3.2);
  s += line('M 272 86 L 272 96', PAL.goldLight, 3.2);
  s += line('M 303 104 L 309 88', PAL.goldLight, 3.2);
  // crown band
  s += shape(
    'M 196 108 C 220 118 280 118 304 108 L 304 128 C 280 138 220 138 196 128 Z',
    PAL.gold,
    PAL.goldDark,
    2.6
  );
  s += line('M 197 118 C 220 127 280 127 303 118', PAL.goldLight, 2.4);
  // finial jewels
  s += jewel(188, 84, 6, cp.secondary);
  s += jewel(228, 78, 6.5, cp.primaryLight);
  s += jewel(272, 78, 6.5, cp.primaryLight);
  s += jewel(312, 84, 6, cp.secondary);
  s += circle(250, 96, 4, PAL.goldLight);
  // band jewels
  s += jewel(216, 118, 6.5, cp.secondary);
  s += jewel(250, 122, 7, PAL.greenLight);
  s += jewel(284, 118, 6.5, cp.secondary);
  return s;
}

function kingHair() {
  let s = '';
  // side locks tumbling from under the crown
  s += shape(
    'M 206 126 C 190 134 182 156 186 180 C 189 198 196 212 204 220 ' +
      'C 198 200 197 172 204 150 C 206 142 206 134 206 126 Z',
    PAL.hairWhite,
    PAL.hairWhiteShade,
    2
  );
  s += shape(
    'M 294 126 C 310 134 318 156 314 180 C 311 198 304 212 296 220 ' +
      'C 302 200 303 172 296 150 C 294 142 294 134 294 126 Z',
    PAL.hairWhite,
    PAL.hairWhiteShade,
    2
  );
  s += line('M 196 148 C 192 166 194 188 200 204', PAL.hairWhiteShade, 2);
  s += line('M 304 148 C 308 166 306 188 300 204', PAL.hairWhiteShade, 2);
  return s;
}

function kingBeard() {
  let s = '';
  s += shape(
    'M 206 170 C 198 204 204 244 218 268 C 228 285 239 294 250 298 ' +
      'C 261 294 272 285 282 268 C 296 244 302 204 294 170 ' +
      'C 291 198 281 214 265 220 C 263 228 258 233 250 233 ' +
      'C 242 233 237 228 235 220 C 219 214 209 198 206 170 Z',
    PAL.hairWhite,
    PAL.hairWhiteShade,
    2.4
  );
  // hair strands inside the beard
  s += line('M 222 206 C 226 236 234 262 246 280', PAL.hairWhiteShade, 2.2, { opacity: '0.8' });
  s += line('M 236 216 C 238 244 242 266 250 284', PAL.hairWhiteShade, 2.2, { opacity: '0.8' });
  s += line('M 278 206 C 274 236 266 262 254 280', PAL.hairWhiteShade, 2.2, { opacity: '0.8' });
  s += line('M 264 216 C 262 244 258 266 250 284', PAL.hairWhiteShade, 2.2, { opacity: '0.8' });
  s += line('M 212 190 C 212 214 216 238 224 256', PAL.hairWhiteShade, 2, { opacity: '0.6' });
  s += line('M 288 190 C 288 214 284 238 276 256', PAL.hairWhiteShade, 2, { opacity: '0.6' });
  // moustache, two mirrored curls
  const m =
    shape(
      'M 250 194 C 240 187 224 188 216 198 C 211 205 214 213 222 213 ' +
        'C 233 213 244 205 250 197 Z',
      PAL.hairWhite,
      PAL.hairWhiteShade,
      2
    ) + line('M 222 198 C 230 200 240 199 248 195', PAL.hairWhiteShade, 1.8);
  s += m + mirrorX(m);
  return s;
}

function kingRobe(cp) {
  let s = '';
  // mantle behind the shoulders
  const mantle = shape(
    'M 104 350 L 112 316 C 126 276 158 250 200 242 L 232 266 L 218 350 Z',
    cp.secondary,
    cp.secondaryDark,
    2.4
  );
  s += mantle + mirrorX(mantle);
  // narrow ermine band running along the outer edge of the mantle
  const ermine =
    shape(
      'M 104 350 L 112 316 C 126 276 158 250 200 242 L 203 254 ' +
        'C 165 263 136 288 124 324 L 118 350 Z',
      '#f6f4ef',
      PAL.hairWhiteShade,
      1.8
    ) +
    circle(129, 310, 2.4, PAL.ink) +
    circle(116, 338, 2.4, PAL.ink) +
    circle(148, 281, 2.2, PAL.ink) +
    circle(176, 259, 2.2, PAL.ink);
  s += ermine + mirrorX(ermine);
  // fold lines on the mantle
  const mfold =
    line('M 148 346 C 154 310 172 278 202 258', cp.secondaryDark, 2.4, { opacity: '0.6' }) +
    line('M 176 348 C 180 318 192 292 212 272', cp.secondaryDark, 2, { opacity: '0.4' });
  s += mfold + mirrorX(mfold);
  // robe body
  s += shape(
    'M 250 236 C 268 236 282 242 294 249 C 332 264 356 298 360 334 L 361 350 ' +
      'L 139 350 L 140 334 C 144 298 168 264 206 249 C 218 242 232 236 250 236 Z',
    cp.primary,
    cp.primaryDark,
    2.6
  );
  // drapery folds
  s += line('M 176 350 C 180 316 190 292 206 274', cp.primaryDark, 3, { opacity: '0.75' });
  s += line('M 324 350 C 320 316 310 292 294 274', cp.primaryDark, 3, { opacity: '0.75' });
  s += line('M 200 350 C 202 322 208 302 218 288', cp.primaryDark, 2.2, { opacity: '0.5' });
  s += line('M 300 350 C 298 322 292 302 282 288', cp.primaryDark, 2.2, { opacity: '0.5' });
  s += line('M 160 348 C 164 320 172 300 184 284', cp.primaryLight, 2.2, { opacity: '0.45' });
  s += line('M 340 348 C 336 320 328 300 316 284', cp.primaryLight, 2.2, { opacity: '0.45' });
  // gold placket down the centre
  s += shape('M 232 262 L 268 262 L 272 350 L 228 350 Z', cp.secondary, cp.secondaryDark, 2);
  s += line('M 234 264 L 230 350', PAL.gold, 3);
  s += line('M 266 264 L 270 350', PAL.gold, 3);
  s += circle(250, 284, 4.4, PAL.gold);
  s += circle(250, 306, 4.4, PAL.gold);
  s += circle(250, 328, 4.4, PAL.gold);
  // gold collar trim over the shoulders
  s += line('M 206 250 C 222 272 278 272 294 250', PAL.gold, 7);
  s += line('M 206 250 C 222 272 278 272 294 250', PAL.goldLight, 2.4);
  return s;
}

function kingRuff() {
  let s = '';
  s += shape(
    'M 196 246 C 200 228 220 218 250 218 C 280 218 300 228 304 246 ' +
      'C 296 262 274 270 250 270 C 226 270 204 262 196 246 Z',
    '#f8f6f0',
    PAL.hairWhiteShade,
    2.2
  );
  for (let i = 0; i < 7; i++) {
    const t = -1 + (2 * i) / 6;
    const x = 250 + t * 48;
    s += line('M ' + n(x) + ' 224 C ' + n(x - 4) + ' 242 ' + n(x - 2) + ' 258 ' + n(x) + ' 268', PAL.hairWhiteShade, 1.8, {
      opacity: '0.85',
    });
  }
  return s;
}

function kingSword(cp) {
  let s = '';
  s += shape('M 146 288 L 149 106 L 155 92 L 161 106 L 164 288 Z', PAL.steel, PAL.steelDark, 2.2);
  s += line('M 155 102 L 155 284', PAL.steelDark, 1.6, { opacity: '0.7' });
  s += line('M 150 112 L 151 280', '#ffffff', 1.6, { opacity: '0.8' });
  // cross guard
  s += shape(
    'M 122 290 C 122 284 126 281 132 281 L 178 281 C 184 281 188 284 188 290 ' +
      'C 188 296 184 299 178 299 L 132 299 C 126 299 122 296 122 290 Z',
    PAL.gold,
    PAL.goldDark,
    2.2
  );
  s += circle(128, 290, 3.2, PAL.goldLight);
  s += circle(182, 290, 3.2, PAL.goldLight);
  // grip
  s += shape('M 147 299 L 163 299 L 165 334 L 145 334 Z', PAL.wood, PAL.woodDark, 2);
  s += line('M 147 307 L 164 307', PAL.gold, 2);
  s += line('M 146 317 L 165 317', PAL.gold, 2);
  s += line('M 146 327 L 165 327', PAL.gold, 2);
  // pommel
  s += circle(155, 342, 9.5, PAL.gold, PAL.goldDark, 2.2);
  s += circle(152.5, 339.5, 3, PAL.goldLight);
  // gauntleted hand around the grip
  s += shape(
    'M 138 304 C 133 314 136 330 149 333 C 162 336 173 328 173 315 ' +
      'C 173 305 165 298 155 300 C 147 302 141 300 138 304 Z',
    PAL.skin,
    PAL.skinShade,
    2.2
  );
  s += line('M 142 311 C 152 313 163 312 170 308', PAL.skinDeep, 2);
  s += line('M 142 320 C 152 322 163 321 171 317', PAL.skinDeep, 2);
  s += line('M 144 329 C 153 331 162 330 169 326', PAL.skinDeep, 2);
  // cuff
  s += shape('M 133 330 C 142 340 168 340 176 330 L 180 350 L 130 350 Z', cp.primaryLight, cp.primaryDark, 2);
  return s;
}

/* ---- queen ------------------------------------------------------ */

function queenTiara(cp) {
  let s = '';
  s += shape(
    'M 205 118 C 214 124 286 124 295 118 L 293 102 L 280 88 L 268 104 ' +
      'L 250 80 L 232 104 L 220 88 L 207 102 Z',
    PAL.gold,
    PAL.goldDark,
    2.6
  );
  s += line('M 208 110 C 226 118 274 118 292 110', PAL.goldLight, 2.4);
  s += jewel(250, 82, 6.5, cp.primaryLight);
  s += jewel(220, 90, 5, cp.secondaryLight || cp.secondary);
  s += jewel(280, 90, 5, cp.secondaryLight || cp.secondary);
  s += circle(234, 112, 3.4, PAL.goldLight);
  s += circle(266, 112, 3.4, PAL.goldLight);
  s += circle(250, 112, 4, '#ffffff');
  return s;
}

function queenHairBack() {
  return (
    shape(
      'M 250 100 C 212 100 192 126 192 162 C 192 188 186 214 176 238 ' +
        'C 168 258 164 280 166 300 L 206 296 C 200 262 206 226 214 202 ' +
        'C 208 172 214 142 228 130 C 240 120 260 120 272 130 ' +
        'C 286 142 292 172 286 202 C 294 226 300 262 294 296 L 334 300 ' +
        'C 336 280 332 258 324 238 C 314 214 308 188 308 162 ' +
        'C 308 126 288 100 250 100 Z',
      PAL.hairGold,
      PAL.hairGoldShade,
      2.4
    ) +
    line('M 200 172 C 194 206 192 250 196 288', PAL.hairGoldShade, 2.2, { opacity: '0.8' }) +
    line('M 186 200 C 180 232 176 266 178 292', PAL.hairGoldShade, 2.2, { opacity: '0.6' }) +
    line('M 300 172 C 306 206 308 250 304 288', PAL.hairGoldShade, 2.2, { opacity: '0.8' }) +
    line('M 314 200 C 320 232 324 266 322 292', PAL.hairGoldShade, 2.2, { opacity: '0.6' })
  );
}

function queenHairFront() {
  // Locks falling in front of the shoulders, drawn after the dress.
  const lock =
    shape(
      'M 200 268 C 190 292 184 320 186 344 L 214 344 C 210 318 210 292 216 270 Z',
      PAL.hairGold,
      PAL.hairGoldShade,
      2.2
    ) +
    line('M 202 280 C 196 304 194 326 196 342', PAL.hairGoldShade, 2, { opacity: '0.8' }) +
    line('M 210 276 C 206 300 205 324 207 342', PAL.hairGoldShade, 1.8, { opacity: '0.6' });
  return lock + mirrorX(lock);
}

function queenDress(cp) {
  let s = '';
  // bodice + skirt
  s += shape(
    'M 250 234 C 270 234 284 240 298 250 C 334 272 356 306 358 340 L 359 350 ' +
      'L 141 350 L 142 340 C 144 306 166 272 202 250 C 216 240 230 234 250 234 Z',
    cp.primary,
    cp.primaryDark,
    2.6
  );
  // puffed sleeves
  const sleeve =
    shape(
      'M 190 262 C 164 272 150 296 152 322 C 154 340 164 350 176 350 ' +
        'L 208 350 C 198 326 194 292 196 268 Z',
      cp.primaryLight,
      cp.primaryDark,
      2.4
    ) +
    line('M 172 284 C 164 302 162 326 168 346', cp.primaryDark, 2.2, { opacity: '0.6' }) +
    line('M 186 278 C 180 300 180 326 186 346', cp.primaryDark, 2.2, { opacity: '0.6' });
  s += sleeve + mirrorX(sleeve);
  // stomacher panel
  s += shape(
    'M 250 266 L 286 282 L 280 350 L 220 350 L 214 282 Z',
    PAL.panel,
    PAL.goldDark,
    2.2
  );
  // lattice embroidery on the stomacher
  s += line('M 224 292 L 276 292', PAL.gold, 1.8);
  s += line('M 222 312 L 278 312', PAL.gold, 1.8);
  s += line('M 221 332 L 279 332', PAL.gold, 1.8);
  s += line('M 236 280 L 232 350', PAL.gold, 1.6, { opacity: '0.8' });
  s += line('M 264 280 L 268 350', PAL.gold, 1.6, { opacity: '0.8' });
  s += circle(250, 302, 4, cp.secondary);
  s += circle(250, 324, 4, cp.secondary);
  // gold hem along the neckline
  s += line('M 206 252 C 224 276 276 276 294 252', PAL.gold, 6);
  s += line('M 206 252 C 224 276 276 276 294 252', PAL.goldLight, 2.2);
  return s;
}

function queenCollar() {
  // Lace collar: a scalloped fan around the neck.
  let s = shape(
    'M 198 244 C 204 226 224 216 250 216 C 276 216 296 226 302 244 ' +
      'C 292 262 272 270 250 270 C 228 270 208 262 198 244 Z',
    '#fbfaf6',
    PAL.hairWhiteShade,
    2
  );
  for (let i = 0; i < 6; i++) {
    const a = -1 + (2 * i) / 5;
    const x = 250 + a * 44;
    s += circle(x, 262 - Math.abs(a) * 10, 6.5, '#fbfaf6', PAL.hairWhiteShade, 1.6);
  }
  s += line('M 206 238 C 226 254 274 254 294 238', PAL.hairWhiteShade, 1.6, { opacity: '0.8' });
  return s;
}

function queenFlower(cp) {
  let s = '';
  // stem and leaves
  s += line('M 292 348 C 306 326 318 306 332 288', PAL.green, 6);
  s += shape(
    'M 308 318 C 296 312 284 316 278 326 C 290 332 302 330 308 318 Z',
    PAL.greenLight,
    PAL.greenDark,
    1.8
  );
  s += shape(
    'M 320 300 C 332 292 346 294 352 304 C 340 312 328 310 320 300 Z',
    PAL.greenLight,
    PAL.greenDark,
    1.8
  );
  // blossom: six petals around a gold heart
  const cx = 338;
  const cy = 276;
  for (let i = 0; i < 6; i++) {
    const ang = (i * 60).toFixed(0);
    s += group(
      'rotate(' + ang + ' ' + cx + ' ' + cy + ')',
      ellipse(cx, cy - 20, 11, 19, i % 2 ? cp.secondaryLight || PAL.redLight : '#ffffff', cp.secondaryDark, 1.8)
    );
  }
  s += circle(cx, cy, 10, PAL.gold, PAL.goldDark, 2);
  s += circle(cx - 3, cy - 3, 3, PAL.goldLight);
  // hand gripping the stem
  s += shape(
    'M 278 330 C 272 340 276 352 288 354 C 300 356 310 348 309 336 ' +
      'C 308 327 300 321 291 324 C 284 326 280 326 278 330 Z',
    PAL.skin,
    PAL.skinShade,
    2.2
  );
  s += line('M 282 336 C 291 339 301 338 307 333', PAL.skinDeep, 2);
  s += line('M 282 345 C 291 348 300 347 307 342', PAL.skinDeep, 2);
  return s;
}

/* ---- jack ------------------------------------------------------- */

function jackHat(cp) {
  let s = '';
  // soft cap
  s += shape(
    'M 200 124 C 194 102 212 82 246 80 C 280 78 306 92 306 112 ' +
      'C 306 121 300 126 292 129 C 268 136 226 136 208 130 C 203 128 201 127 200 124 Z',
    cp.primary,
    cp.primaryDark,
    2.6
  );
  s += line('M 214 118 C 222 100 250 91 278 96', cp.primaryLight, 3.4, { opacity: '0.8' });
  s += line('M 226 126 C 234 108 258 99 284 104', cp.primaryLight, 2.4, { opacity: '0.5' });
  // hat band
  s += shape(
    'M 199 122 C 222 136 278 136 301 122 L 302 134 C 278 148 222 148 198 134 Z',
    PAL.gold,
    PAL.goldDark,
    2.2
  );
  s += jewel(250, 134, 6.5, cp.secondary);
  s += circle(222, 131, 3, PAL.goldLight);
  s += circle(278, 131, 3, PAL.goldLight);
  // plume: soft leaf silhouette plus a quill and barbs
  s += shape(
    'M 300 114 C 310 98 326 86 348 82 C 340 92 334 104 330 116 ' +
      'C 326 130 320 142 312 149 C 306 154 300 154 297 150 ' +
      'C 302 140 302 126 300 114 Z',
    cp.secondaryLight || PAL.redLight,
    cp.secondaryDark,
    2.2
  );
  s += line('M 300 150 C 310 134 324 112 346 84', cp.secondaryDark, 1.8, { opacity: '0.85' });
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const qx = 300 + t * 44;
    const qy = 150 - t * 64;
    s += line(
      'M ' + n(qx) + ' ' + n(qy) + ' L ' + n(qx - 4 - t * 4) + ' ' + n(qy - 8 - t * 3),
      '#ffffff',
      1.5,
      { opacity: '0.7' }
    );
  }
  return s;
}

function jackHair() {
  let s = '';
  const side =
    shape(
      'M 208 132 C 194 142 188 166 192 190 C 195 208 202 222 210 230 ' +
        'C 203 210 202 178 209 156 C 211 148 210 140 208 132 Z',
      PAL.hairBrown,
      PAL.hairBrownShade,
      2.2
    ) +
    line('M 200 152 C 195 172 196 196 202 214', PAL.hairBrownShade, 2, { opacity: '0.8' });
  s += side + mirrorX(side);
  // fringe under the cap
  s += shape(
    'M 212 130 C 224 140 276 140 288 130 C 284 144 268 150 250 150 C 232 150 216 144 212 130 Z',
    PAL.hairBrown,
    PAL.hairBrownShade,
    2
  );
  return s;
}

function jackDoublet(cp) {
  let s = '';
  s += shape(
    'M 250 236 C 268 236 282 242 294 249 C 332 264 356 298 360 334 L 361 350 ' +
      'L 139 350 L 140 334 C 144 298 168 264 206 249 C 218 242 232 236 250 236 Z',
    cp.primary,
    cp.primaryDark,
    2.6
  );
  // striped left panel, plain right - typical of harlequin jack costumes
  s += shape(
    'M 206 249 C 168 264 144 298 140 334 L 139 350 L 250 350 L 250 240 ' +
      'C 232 236 218 242 206 249 Z',
    cp.secondary,
    cp.secondaryDark,
    2.2,
    { opacity: '0.92' }
  );
  for (let i = 0; i < 5; i++) {
    const y = 278 + i * 16;
    s += line('M ' + n(146 + i * 2) + ' ' + n(y) + ' L 248 ' + n(y - 14), PAL.goldLight, 2.4, {
      opacity: '0.55',
    });
  }
  // shoulder rolls
  const roll = shape(
    'M 200 252 C 180 262 168 280 166 300 L 200 306 C 200 286 204 266 212 254 Z',
    cp.primaryLight,
    cp.primaryDark,
    2.2
  );
  s += roll + mirrorX(roll);
  // centre lacing
  s += shape('M 234 264 L 266 264 L 270 350 L 230 350 Z', PAL.panel, PAL.goldDark, 2);
  for (let i = 0; i < 5; i++) {
    const y = 276 + i * 16;
    s += line('M 236 ' + n(y) + ' L 264 ' + n(y + 8), cp.secondaryDark, 2);
    s += line('M 264 ' + n(y) + ' L 236 ' + n(y + 8), cp.secondaryDark, 2);
  }
  // gold neckline trim
  s += line('M 206 250 C 222 272 278 272 294 250', PAL.gold, 6);
  s += line('M 206 250 C 222 272 278 272 294 250', PAL.goldLight, 2.2);
  return s;
}

function jackCollar() {
  // Pointed "van Dyck" collar.
  let s = shape(
    'M 202 238 C 212 224 228 216 250 216 C 272 216 288 224 298 238 ' +
      'L 282 268 L 268 246 L 250 272 L 232 246 L 218 268 Z',
    '#fbfaf6',
    PAL.hairWhiteShade,
    2.2
  );
  s += line('M 214 238 C 228 250 272 250 286 238', PAL.hairWhiteShade, 1.6, { opacity: '0.8' });
  s += circle(232, 246, 2.6, PAL.hairWhiteShade);
  s += circle(268, 246, 2.6, PAL.hairWhiteShade);
  return s;
}

function jackHalberd(cp) {
  let s = '';
  // shaft
  s += shape('M 152 92 L 166 92 L 170 350 L 148 350 Z', PAL.wood, PAL.woodDark, 2.2);
  s += line('M 158 96 L 162 344', PAL.woodDark, 1.6, { opacity: '0.6' });
  // top spike
  s += shape('M 154 104 L 150 76 L 164 74 L 166 104 Z', PAL.steel, PAL.steelDark, 2);
  // axe blade
  s += shape(
    'M 154 112 L 120 120 C 106 132 104 158 116 172 L 156 180 Z',
    PAL.steel,
    PAL.steelDark,
    2.4
  );
  s += line('M 126 126 C 116 142 117 160 128 170', '#ffffff', 2.2, { opacity: '0.85' });
  s += line('M 140 116 L 142 178', PAL.steelDark, 1.6, { opacity: '0.6' });
  // rear hook
  s += shape('M 166 124 L 190 132 L 186 146 L 166 142 Z', PAL.steel, PAL.steelDark, 2);
  // shaft ferrules
  s += shape('M 151 184 L 168 184 L 169 196 L 150 196 Z', PAL.gold, PAL.goldDark, 1.8);
  s += shape('M 154 246 L 170 246 L 171 258 L 153 258 Z', PAL.gold, PAL.goldDark, 1.8);
  // hand
  s += shape(
    'M 146 300 C 140 310 143 326 156 329 C 169 332 180 324 180 311 ' +
      'C 180 301 172 294 162 296 C 154 298 149 296 146 300 Z',
    PAL.skin,
    PAL.skinShade,
    2.2
  );
  s += line('M 150 307 C 160 309 171 308 178 304', PAL.skinDeep, 2);
  s += line('M 150 316 C 160 318 171 317 179 313', PAL.skinDeep, 2);
  s += line('M 152 325 C 161 327 170 326 177 322', PAL.skinDeep, 2);
  s += shape('M 141 326 C 150 336 176 336 184 326 L 188 350 L 138 350 Z', cp.primaryLight, cp.primaryDark, 2);
  return s;
}

/* ---- court assembly --------------------------------------------- */

/** Ornamental scrollwork in the top corners of the picture panel. */
function panelFiligree() {
  const one =
    line('M 104 110 C 108 90 122 78 142 76', PAL.gold, 2.2, { opacity: '0.7' }) +
    line('M 104 124 C 110 100 126 86 148 84', PAL.gold, 1.4, { opacity: '0.45' }) +
    circle(143, 76, 3, PAL.gold, null, 0);
  return one + mirrorX(one);
}

/**
 * Builds the upper half of a court card.  The same markup is reused (rotated)
 * for the lower half.
 */
function courtTopHalf(rank, suit, defId, cp, suitColor) {
  let s = '';
  s += panelFiligree();
  // small rank + suit index inside the picture frame, left and right
  s += rankGlyph(rank, 116, 82, 34, suitColor, { weight: 19, gap: 4 });
  s += suitMark(defId, 116, 134, 24, suitColor);
  s += rankGlyph(rank, 384, 82, 34, suitColor, { weight: 19, gap: 4 });
  s += suitMark(defId, 384, 134, 24, suitColor);

  if (rank === 'K') {
    s += kingRobe(cp);
    s += kingHair();
    s += neck();
    s += kingRuff();
    s += face({ iris: PAL.blue, mouth: false });
    s += kingBeard();
    s += kingCrown(cp);
    s += kingSword(cp);
  } else if (rank === 'Q') {
    s += queenHairBack();
    s += queenDress(cp);
    s += neck();
    s += queenCollar();
    s += face({ iris: PAL.green, lips: '#c2504c', brow: 3.4, browLift: true, browColor: PAL.hairGoldShade });
    s += queenTiara(cp);
    s += queenHairFront();
    s += queenFlower(cp);
  } else {
    s += jackHair();
    s += jackDoublet(cp);
    s += neck();
    s += jackCollar();
    s += face({ iris: PAL.hairBrown, lips: '#b4544a', brow: 4, browColor: PAL.hairBrownShade });
    s += jackHat(cp);
    s += jackHalberd(cp);
  }
  return s;
}

function courtFace(rank, suit, defId, suitColor, prefix) {
  const cp = courtPalette(suit);
  const topId = prefix + 'ct';
  const botId = prefix + 'cb';
  const half = courtTopHalf(rank, suit, defId, cp, suitColor);

  let defs = '';
  defs += el(
    'clipPath',
    { id: topId },
    el('rect', { x: n(PANEL.x), y: n(PANEL.y), width: n(PANEL.w), height: n(CENTER_Y - PANEL.y) })
  );
  defs += el(
    'clipPath',
    { id: botId },
    el('rect', {
      x: n(PANEL.x),
      y: n(CENTER_Y),
      width: n(PANEL.w),
      height: n(PANEL.y + PANEL.h - CENTER_Y),
    })
  );

  let s = el('defs', null, defs);
  // panel
  s += el('rect', {
    x: n(PANEL.x),
    y: n(PANEL.y),
    width: n(PANEL.w),
    height: n(PANEL.h),
    rx: '8',
    ry: '8',
    fill: PAL.panel,
    stroke: PAL.panelEdge,
    'stroke-width': '2.4',
  });
  // vertical divider, drawn under the figure so it only shows in open areas
  s += line(
    'M 250 ' + n(PANEL.y + 6) + ' L 250 ' + n(PANEL.y + PANEL.h - 6),
    PAL.panelEdge,
    1.6,
    { opacity: '0.9' }
  );
  s += el('g', { 'clip-path': 'url(#' + topId + ')' }, half);
  s += el(
    'g',
    { 'clip-path': 'url(#' + botId + ')' },
    group('rotate(180 ' + CENTER_X + ' ' + CENTER_Y + ')', half)
  );
  // horizontal centre rule
  s += line(
    'M ' + n(PANEL.x + 4) + ' 350 L ' + n(PANEL.x + PANEL.w - 4) + ' 350',
    PAL.goldDark,
    1.8,
    { opacity: '0.55' }
  );
  // single upright suit medallion straddling the seam between the two halves
  s += medallion(defId, CENTER_X, CENTER_Y, 30, suitColor);
  // panel frame on top of the artwork
  s += el('rect', {
    x: n(PANEL.x),
    y: n(PANEL.y),
    width: n(PANEL.w),
    height: n(PANEL.h),
    rx: '8',
    ry: '8',
    fill: 'none',
    stroke: PAL.panelEdge,
    'stroke-width': '2.4',
  });
  s += el('rect', {
    x: n(PANEL.x + 5),
    y: n(PANEL.y + 5),
    width: n(PANEL.w - 10),
    height: n(PANEL.h - 10),
    rx: '5',
    ry: '5',
    fill: 'none',
    stroke: PAL.gold,
    'stroke-width': '1.4',
    opacity: '0.65',
  });
  return s;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function idPrefix(rank, suit) {
  const r = rank === '10' ? 't' : rank.toLowerCase();
  return 'cs' + suit.charAt(0) + r + '-';
}

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'viewBox="0 0 ' + VB_W + ' ' + VB_H + '" preserveAspectRatio="xMidYMid meet">';

/**
 * Build the SVG string for one card face.
 *
 * @param {string} rank one of RANKS
 * @param {string} suit one of SUITS
 * @param {{cornerRadius?:number, bleed?:number, margin?:number}} [opts]
 * @returns {string} a complete, self-contained SVG document string
 */
export function cardSVG(rank, suit, opts = {}) {
  const r = String(rank).toUpperCase();
  const st = String(suit).toLowerCase();
  if (RANKS.indexOf(r) === -1) throw new Error('cardSVG: unknown rank "' + rank + '"');
  if (SUITS.indexOf(st) === -1) throw new Error('cardSVG: unknown suit "' + suit + '"');

  const o = Object.assign({}, DEFAULTS, opts || {});
  const prefix = idPrefix(r, st);
  const defId = prefix + 'suit';
  const color = SUIT_COLOR[st];

  let s = SVG_OPEN;
  s += el('defs', null, el('path', { id: defId, d: SUIT_PATHS[st] }));
  s += cardShell(o);
  s += cornerIndices(r, st, defId, color);

  if (r === 'A') {
    s += aceFace(st, defId, color);
  } else if (r === 'J' || r === 'Q' || r === 'K') {
    s += courtFace(r, st, defId, color, prefix);
  } else {
    s += pipFace(r, defId, color);
  }
  return s + '</svg>';
}

/**
 * Build the SVG string for a card back.
 *
 * @param {{color?:string, cornerRadius?:number, bleed?:number, margin?:number}} [opts]
 *        `color` accepts "red" (default) or "black"/"blue" for the dark back.
 * @returns {string}
 */
export function cardBackSVG(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const variant = String(o.color || 'red').toLowerCase();
  const dark = variant === 'black' || variant === 'blue' || variant === 'dark';
  const prefix = dark ? 'cbk-' : 'cbr-';

  const base = dark ? '#1b2340' : '#b02231';
  const deep = dark ? '#10162c' : '#7d1523';
  const lite = dark ? '#3c4d80' : '#d8546a';
  const glow = dark ? '#6f84bd' : '#f0a3ae';

  const m = o.margin;
  const r = o.cornerRadius;
  const inset = 26;

  const patId = prefix + 'pat';
  const clipId = prefix + 'clip';

  // One tile of the repeating lattice.
  let tile = '';
  tile += el('rect', { width: '40', height: '40', fill: base });
  tile += line('M 0 20 L 20 0 L 40 20 L 20 40 Z', lite, 2.2, { opacity: '0.85' });
  tile += line('M 20 0 L 20 40', deep, 1.1, { opacity: '0.6' });
  tile += line('M 0 20 L 40 20', deep, 1.1, { opacity: '0.6' });
  tile += shape('M 20 12 L 28 20 L 20 28 L 12 20 Z', deep, glow, 1.2);
  tile += circle(0, 0, 3.2, glow, null, 0);
  tile += circle(40, 0, 3.2, glow, null, 0);
  tile += circle(0, 40, 3.2, glow, null, 0);
  tile += circle(40, 40, 3.2, glow, null, 0);

  let defs = '';
  defs += el(
    'pattern',
    { id: patId, width: '40', height: '40', patternUnits: 'userSpaceOnUse' },
    tile
  );
  defs += el(
    'clipPath',
    { id: clipId },
    el('rect', {
      x: n(m + inset),
      y: n(m + inset),
      width: n(VB_W - 2 * (m + inset)),
      height: n(VB_H - 2 * (m + inset)),
      rx: n(Math.max(4, r - inset)),
      ry: n(Math.max(4, r - inset)),
    })
  );

  let s = SVG_OPEN;
  s += el('defs', null, defs);

  if (o.bleed > 0) {
    s += el('rect', {
      x: n(m - o.bleed),
      y: n(m - o.bleed),
      width: n(VB_W - 2 * m + 2 * o.bleed),
      height: n(VB_H - 2 * m + 2 * o.bleed),
      rx: n(r + o.bleed),
      ry: n(r + o.bleed),
      fill: PAL.paper,
    });
  }
  // white card body
  s += el('rect', {
    x: n(m),
    y: n(m),
    width: n(VB_W - 2 * m),
    height: n(VB_H - 2 * m),
    rx: n(r),
    ry: n(r),
    fill: PAL.paper,
    stroke: PAL.border,
    'stroke-width': '2.5',
  });
  // coloured field with the lattice pattern
  s += el('rect', {
    x: n(m + inset),
    y: n(m + inset),
    width: n(VB_W - 2 * (m + inset)),
    height: n(VB_H - 2 * (m + inset)),
    rx: n(Math.max(4, r - inset)),
    ry: n(Math.max(4, r - inset)),
    fill: base,
  });
  s += el('g', { 'clip-path': 'url(#' + clipId + ')' }, el('rect', {
    x: n(m + inset),
    y: n(m + inset),
    width: n(VB_W - 2 * (m + inset)),
    height: n(VB_H - 2 * (m + inset)),
    fill: 'url(#' + patId + ')',
  }));
  // frames
  s += el('rect', {
    x: n(m + inset),
    y: n(m + inset),
    width: n(VB_W - 2 * (m + inset)),
    height: n(VB_H - 2 * (m + inset)),
    rx: n(Math.max(4, r - inset)),
    ry: n(Math.max(4, r - inset)),
    fill: 'none',
    stroke: '#ffffff',
    'stroke-width': '7',
  });
  s += el('rect', {
    x: n(m + inset),
    y: n(m + inset),
    width: n(VB_W - 2 * (m + inset)),
    height: n(VB_H - 2 * (m + inset)),
    rx: n(Math.max(4, r - inset)),
    ry: n(Math.max(4, r - inset)),
    fill: 'none',
    stroke: deep,
    'stroke-width': '2.4',
  });
  s += el('rect', {
    x: n(m + inset + 12),
    y: n(m + inset + 12),
    width: n(VB_W - 2 * (m + inset + 12)),
    height: n(VB_H - 2 * (m + inset + 12)),
    rx: n(Math.max(2, r - inset - 10)),
    ry: n(Math.max(2, r - inset - 10)),
    fill: 'none',
    stroke: glow,
    'stroke-width': '1.6',
    opacity: '0.85',
  });

  // central emblem
  s += group(
    'translate(' + CENTER_X + ' ' + CENTER_Y + ')',
    ellipse(0, 0, 92, 128, deep, '#ffffff', 5) +
      ellipse(0, 0, 80, 116, 'none', glow, 2) +
      shape('M 0 -92 L 46 0 L 0 92 L -46 0 Z', lite, '#ffffff', 3) +
      shape('M 0 -60 L 30 0 L 0 60 L -30 0 Z', deep, glow, 2) +
      circle(0, 0, 16, glow, '#ffffff', 2.4) +
      circle(0, -74, 5, glow, null, 0) +
      circle(0, 74, 5, glow, null, 0) +
      circle(-36, 0, 5, glow, null, 0) +
      circle(36, 0, 5, glow, null, 0)
  );

  return s + '</svg>';
}

/**
 * Convert an SVG string into a data URL suitable for <img>.src / texture loading.
 * Uses encodeURIComponent (not base64) so the payload stays readable and cheap.
 *
 * @param {string} svg
 * @returns {string}
 */
export function svgToDataURL(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export default { SUITS, RANKS, cardSVG, cardBackSVG, svgToDataURL };
