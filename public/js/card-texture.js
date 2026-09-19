// card-texture.js — SVG(またはフォールバック描画) -> THREE.CanvasTexture
// 契約 §5.1
import * as THREE from 'three';

const TEX_W = 512;
const TEX_H = 716;

export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const SUIT_GLYPH = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_COLOR = { spades: '#16181d', clubs: '#16181d', hearts: '#d02233', diamonds: '#d02233' };

/** @type {Map<string, {canvas:HTMLCanvasElement, texture:THREE.Texture, ready:Promise<void>}>} */
const cache = new Map();

let maxAnisotropy = 8;
let svgModPromise = null;

/** render3d から呼ばれ、実デバイスの異方性フィルタ上限を反映する（任意） */
export function setRendererCaps(renderer) {
  try {
    const a = renderer.capabilities.getMaxAnisotropy();
    if (a > 0) {
      maxAnisotropy = a;
      for (const e of cache.values()) {
        e.texture.anisotropy = maxAnisotropy;
        e.texture.needsUpdate = true;
      }
    }
  } catch (_) { /* noop */ }
}

// cards-svg.js は別担当。無ければフォールバック描画に切り替える。
function loadSvgModule() {
  if (!svgModPromise) {
    svgModPromise = import('./cards-svg.js')
      .then((m) => (m && typeof m.cardSVG === 'function' ? m : null))
      .catch(() => null);
  }
  return svgModPromise;
}

function newCanvas() {
  const c = document.createElement('canvas');
  c.width = TEX_W;
  c.height = TEX_H;
  return c;
}

function makeTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAnisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- 2D fallback

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFallbackFace(ctx, rank, suit) {
  const w = TEX_W, h = TEX_H;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 6, 6, w - 12, h - 12, 42);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#d8dce4';
  ctx.stroke();

  const col = SUIT_COLOR[suit] || '#16181d';
  const g = SUIT_GLYPH[suit] || '?';
  ctx.fillStyle = col;
  ctx.textAlign = 'center';

  // 角のランク + スート（上下反転で2箇所）
  const corner = (flip) => {
    ctx.save();
    if (flip) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    ctx.font = 'bold 96px "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(rank, 74, 40);
    ctx.font = '72px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(g, 74, 142);
    ctx.restore();
  };
  corner(false);
  corner(true);

  // 中央の大きなスート
  ctx.textBaseline = 'middle';
  const face = rank === 'J' || rank === 'Q' || rank === 'K';
  if (face) {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.font = '360px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(g, w / 2, h / 2 + 10);
    ctx.restore();
    ctx.font = 'bold 250px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(rank, w / 2, h / 2);
  } else {
    ctx.font = '300px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(g, w / 2, h / 2 + 12);
  }
}

function drawFallbackBack(ctx, color) {
  const w = TEX_W, h = TEX_H;
  const base = color === 'red' ? '#a41a2c' : '#17335e';
  const light = color === 'red' ? '#e05a6c' : '#4e86d6';
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 6, 6, w - 12, h - 12, 42);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 22, 22, w - 44, h - 44, 30);
  ctx.clip();
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = light;
  ctx.lineWidth = 3;
  const step = 46;
  for (let i = -h; i < w + h; i += step) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, h); ctx.lineTo(i + h, 0); ctx.stroke();
  }
  const rg = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, h * 0.62);
  rg.addColorStop(0, 'rgba(255,255,255,0.30)');
  rg.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 6;
  roundRect(ctx, 22, 22, w - 44, h - 44, 30);
  ctx.stroke();
}

// ---------------------------------------------------------------- raster

function rasterize(svg, ctx) {
  return new Promise((resolve) => {
    let url;
    try {
      url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch (_) { resolve(false); return; }
    const img = new Image();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    img.onload = () => {
      try {
        ctx.clearRect(0, 0, TEX_W, TEX_H);
        ctx.drawImage(img, 0, 0, TEX_W, TEX_H);
        finish(true);
      } catch (_) { finish(false); }
    };
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), 6000);
    img.src = url;
  });
}

function toDataURL(mod, svg) {
  if (mod && typeof mod.svgToDataURL === 'function') {
    try { return mod.svgToDataURL(svg); } catch (_) { /* fallthrough */ }
  }
  return null;
}

async function rasterizeVia(mod, svg, ctx) {
  const url = toDataURL(mod, svg);
  if (url) {
    const ok = await new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      img.onload = () => {
        try {
          ctx.clearRect(0, 0, TEX_W, TEX_H);
          ctx.drawImage(img, 0, 0, TEX_W, TEX_H);
          fin(true);
        } catch (_) { fin(false); }
      };
      img.onerror = () => fin(false);
      setTimeout(() => fin(false), 6000);
      img.src = url;
    });
    if (ok) return true;
  }
  return rasterize(svg, ctx);
}

function entryFor(key, drawFallback, makeSVG) {
  let e = cache.get(key);
  if (e) return e;
  const canvas = newCanvas();
  const ctx = canvas.getContext('2d');
  try { drawFallback(ctx); } catch (_) { /* noop */ }
  const texture = makeTexture(canvas);
  e = { canvas, ctx, texture, ready: null };
  cache.set(key, e);
  // 非同期で本物の SVG に差し替える
  e.ready = loadSvgModule().then(async (mod) => {
    if (!mod) return;
    let svg = null;
    try { svg = makeSVG(mod); } catch (_) { return; }
    if (typeof svg !== 'string' || svg.length < 10) return;
    const ok = await rasterizeVia(mod, svg, ctx);
    if (ok) texture.needsUpdate = true;
    else { try { drawFallback(ctx); } catch (_) {} texture.needsUpdate = true; }
  }).catch(() => { /* アプリを落とさない */ });
  return e;
}

/** 表面テクスチャ（キャッシュ付き・同じ引数は同じインスタンス） */
export function getCardTexture(rank, suit) {
  const key = 'f:' + rank + ':' + suit;
  return entryFor(
    key,
    (ctx) => drawFallbackFace(ctx, rank, suit),
    (mod) => mod.cardSVG(rank, suit)
  ).texture;
}

/** 裏面テクスチャ。color: 'red' | 'black' */
export function getBackTexture(color) {
  const c = color === 'red' ? 'red' : 'black';
  const key = 'b:' + c;
  return entryFor(
    key,
    (ctx) => drawFallbackBack(ctx, c),
    (mod) => mod.cardBackSVG({ color: c })
  ).texture;
}

/** 52枚 + 裏2種を先読みラスタライズ */
export async function preloadAll() {
  const jobs = [];
  for (const s of SUITS) for (const r of RANKS) {
    getCardTexture(r, s);
    jobs.push(cache.get('f:' + r + ':' + s).ready);
  }
  for (const c of ['red', 'black']) {
    getBackTexture(c);
    jobs.push(cache.get('b:' + c).ready);
  }
  try { await Promise.all(jobs); } catch (_) { /* noop */ }
}

/** 全テクスチャを破棄 */
export function disposeAll() {
  for (const e of cache.values()) {
    try { e.texture.dispose(); } catch (_) {}
  }
  cache.clear();
}
