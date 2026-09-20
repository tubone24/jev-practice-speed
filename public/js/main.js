// JEV SPEED — 統合レイヤー。
// ゲームループ、人間の入力、Jev(CPU) の駆動、演出のトリガをここで束ねる。

import * as rules from './rules.js';
import { createTable } from './render3d.js';
import { createVFX } from './vfx.js';
import { createHUD } from './hud.js';
import { createSFX } from './sfx.js';
import { createJevPlayer } from './ai.js';
import { jevHealth } from './jev-client.js';

const CONFIG = {
  handSize: 5,
  /**
   * お手付きの基本ペナルティ(ms)。この間そのプレイヤーは手を出せない。
   * Jev は 100〜300ms で判断してくるので、人間が勝てる余地を作るには
   * 1 回のミスジャッジが「Jev の数十手ぶん」の重さになる必要がある。
   */
  FOUL_LOCKOUT_MS: 10_000,
  /** 連続お手付きで 1.5 倍ずつ重くする (10 → 15 → 22.5 → 30秒で頭打ち)。成功プレイ 1 回でリセット */
  FOUL_LOCKOUT_STEP: 1.5,
  FOUL_LOCKOUT_MAX_MS: 30_000,
  /** お手付きルール OFF のとき、違反操作をただ拒否するだけの軽い待ち(ms) */
  REFUSE_LOCKOUT_MS: 120,
  /** 「スピード！」宣言から札が台に着くまで(ms)。着弾の演出をここに合わせる */
  FLIP_IMPACT_MS: 360,
  /** CPU が次の思考に入るまでの最小待ち(ms)。0 で Jev の素の速度 */
  CPU_EXTRA_DELAY_MS: 0,
  /** フィニッシュ演出を見せてから結果画面を出すまでの待ち(ms) */
  FINISH_SHOW_MS: 3200,
};

/**
 * コンボの段階。`at` 連続で発火し、tier が vfx.comboSurge の強さに対応する。
 * 0=火花 / 1=水 / 2=炎 / 3=雷 / 4=全部乗せ
 */
const COMBO_TIERS = [
  { at: 2, tier: 0, label: 'COMBO', color: 0xfbbf24, rage: 0.14, css: 'spark' },
  { at: 3, tier: 1, label: 'SPLASH', color: 0x4fd4ff, rage: 0.30, css: 'aqua' },
  { at: 5, tier: 2, label: 'BURNING', color: 0xff8a2b, rage: 0.52, css: 'flame' },
  { at: 7, tier: 3, label: 'THUNDER', color: 0xbfe6ff, rage: 0.74, css: 'storm' },
  { at: 10, tier: 4, label: 'OVERDRIVE', color: 0xffffff, rage: 1.00, css: 'god' },
];

/** 段階到達時の煽り文句。自分のコンボは称賛、Jev のコンボは挑発。 */
const TAUNTS = {
  human: [
    ['ナイス連打', 'いい入りかた'],
    ['SPLASH!! 流れが来た', '水も止まらない'],
    ['BURNING!! 手が熱い', '燃えてきた'],
    ['THUNDER!! 雷速', 'Jev が置いていかれてる'],
    ['OVERDRIVE!!! 手が付けられない', '人間の限界を超えた'],
  ],
  cpu: [
    ['Jev、手が止まらない', 'JEV 連打中'],
    ['Jev「まだ余裕?」', 'Jev「水も漏らさぬ」'],
    ['Jev「手、止まってるよ」', 'Jev「そろそろ熱くなる」'],
    ['Jev「追いつける?」', 'Jev「もう見えてないでしょ」'],
    ['Jev「……終わりだね」', 'Jev「人間、遅すぎ」'],
  ],
};

/**
 * お手付きルールの適用対象。ゲーム開始時に画面の設定から読み込む。
 * スピードには公式のお手付き規定が無いため、本アプリでは
 * 「違反した札は台札に乗らず、そのプレイヤーが一定時間出せなくなる」方式を採る。
 */
const foulRule = { human: true, cpu: true };

const dom = {
  canvas: document.getElementById('table-canvas'),
  hud: document.getElementById('hud'),
  status: document.getElementById('status-line'),
  combo: document.getElementById('combo'),
  taunt: document.getElementById('taunt'),
  humanCount: document.getElementById('human-count'),
  cpuCount: document.getElementById('cpu-count'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  startBtn: document.getElementById('start-btn'),
  revealToggle: document.getElementById('reveal-toggle'),
  soundToggle: document.getElementById('sound-toggle'),
  foulSelect: document.getElementById('foul-select'),
  foulBanner: document.getElementById('foul-banner'),
  speedCall: document.getElementById('speed-call'),
  speedBtn: document.getElementById('speed-btn'),
  finish: document.getElementById('finish'),
  finishWord: document.getElementById('finish-word'),
  finishSub: document.getElementById('finish-sub'),
  stage: document.getElementById('stage'),
  loading: document.getElementById('loading'),
};

let table = null;
let vfx = null;
let hud = null;
let sfx = null;
let ai = null;
let state = null;
let selectedSlot = null;

/** コンボは「同じプレイヤーが連続で出したときだけ」伸びる。相手が 1 手でも挟んだら切れる。 */
let comboOwner = null;
let combo = 0;
let comboTier = -1;
const bestCombo = { human: 0, cpu: 0 };

/** プレイヤーごとのロックアウト解除時刻(performance.now() 基準) */
const lockUntil = { human: 0, cpu: 0 };
const foulCount = { human: 0, cpu: 0 };
/** 連続お手付き数。成功プレイでリセットされ、ペナルティの重さに効く */
const foulStreak = { human: 0, cpu: 0 };
let flipTimer = null;
let finishTimer = null;
let cancelFinishFx = null;
let tauntTimer = null;
let running = false;
/** 「スピード！」の宣言待ちか。true の間は盤面の操作を受け付けない */
let awaitingSpeed = false;
/** 最後にカードが置かれた台札。フィニッシュ演出の中心に使う */
let lastPile = 0;

const isLocked = (id) => performance.now() < lockUntil[id];

// ---------------------------------------------------------------- ビューモデル

function toView(s) {
  const pack = (p, faceDown) => ({
    hand: p.hand.map((c) => (c ? { rank: c.rank, suit: c.suit } : null)),
    stockCount: p.stock.length,
    faceDown,
  });
  return {
    piles: s.piles.map((c) => (c ? { rank: c.rank, suit: c.suit } : null)),
    human: pack(s.players.human, false),
    // スピードの場札は両者とも表向きが公式ルール。伏せるのはデモ用の任意設定。
    cpu: pack(s.players.cpu, !dom.revealToggle.checked),
    phase: s.phase,
    combo,
  };
}

function sync() {
  table.syncState(toView(state));
  const hr = remaining(state.players.human);
  const cr = remaining(state.players.cpu);
  dom.humanCount.textContent = String(hr);
  dom.cpuCount.textContent = String(cr);
  updateTension(hr, cr);
}

function remaining(p) {
  return p.hand.filter(Boolean).length + p.stock.length;
}

function setStatus(text) {
  dom.status.textContent = text;
}

// ------------------------------------------------------------------- コンボ

/** n 連鎖で到達している段階。2 未満は段階なし */
function tierIndexOf(n) {
  let idx = -1;
  for (let i = 0; i < COMBO_TIERS.length; i++) {
    if (n >= COMBO_TIERS[i].at) idx = i;
  }
  return idx;
}

/** 0xRRGGBB を t で混ぜる */
function blend(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const ch = (v, s) => (v >> s) & 0xff;
  const mix = (s) => Math.round(ch(a, s) * (1 - k) + ch(b, s) * k);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * 残り枚数の緊張。Jev が出し切りそうなら「ピンチ」、自分が近ければ「チャンス」。
 * TENSION_FROM 枚から効き始め、0 枚に近いほど心拍が速く、視界が締まる。
 */
const TENSION_FROM = 7;
const tension = { kind: '', level: 0, band: 0 };

function updateTension(hr, cr) {
  const near = (n) => (n >= TENSION_FROM ? 0 : Math.min(1, (TENSION_FROM - n) / TENSION_FROM));
  const danger = near(cr);   // Jev が出し切りそう
  const chance = near(hr);   // 自分が出し切りそう
  const level = Math.max(danger, chance);
  const kind = level <= 0 ? '' : (danger >= chance ? 'danger' : 'chance');

  // 帯（1=リーチ 2=あと僅か 3=王手）が上がった瞬間だけ音を出す
  const lead = kind === 'danger' ? cr : hr;
  const band = level <= 0 ? 0 : lead <= 1 ? 3 : lead <= 3 ? 2 : 1;
  if (kind && (band > tension.band || kind !== tension.kind)) {
    if (kind === 'danger') sfx.danger(); else sfx.chance();
    if (band >= 2) table.cameraShake(0.14 + band * 0.05);
  }
  tension.kind = kind;
  tension.level = level;
  tension.band = band;

  dom.stage.dataset.tension = kind ? `${kind}-${band}` : '';
  dom.cpuCount.parentElement.classList.toggle('low', cr <= 5);
  dom.humanCount.parentElement.classList.toggle('low', hr <= 5);
  applyScreen();
}

/**
 * 画面全体の演出。コンボの「熱」と残り枚数の「緊張」を両方 VFX に渡し、
 * 強い方の色で盤面のライトと縁を染める。
 */
function applyScreen() {
  const idx = comboTier;
  const t = idx >= 0 && comboOwner ? COMBO_TIERS[idx] : null;
  const rageLevel = t ? t.rage : 0;
  const rageTint = t
    ? blend(t.color, comboOwner === 'human' ? 0x2ee6b8 : 0xff2f6a, 0.42)
    : 0x000000;
  vfx.setRage(rageLevel, rageTint);
  dom.stage.dataset.rage = t ? (comboOwner === 'human' ? t.css : `${t.css}-cpu`) : '';

  const tenTint = tension.kind === 'danger' ? 0xff2436 : 0x36f0c4;
  // 残りが減るほど心拍が速くなる (0.75Hz → 2.6Hz)
  vfx.setTension(tension.level, tenTint, 0.75 + tension.level * 1.85);

  const lv = Math.max(rageLevel, tension.level);
  table.setMood?.(lv * 0.9, rageLevel >= tension.level ? rageTint : tenTint);
}

function showComboBanner(owner) {
  const idx = comboTier;
  dom.combo.dataset.owner = owner;
  dom.combo.dataset.tier = idx >= 0 ? COMBO_TIERS[idx].css : '';
  const label = idx >= 0 ? COMBO_TIERS[idx].label : 'COMBO';
  const who = owner === 'cpu' ? 'JEV ' : '';
  dom.combo.textContent = `${who}${combo} ${label}`;
  dom.combo.classList.remove('pop');
  void dom.combo.offsetWidth;
  dom.combo.classList.add('pop');
}

function showTaunt(owner, idx) {
  const lines = TAUNTS[owner]?.[idx];
  if (!lines) return;
  dom.taunt.textContent = lines[Math.floor(Math.random() * lines.length)];
  dom.taunt.dataset.owner = owner;
  dom.taunt.classList.remove('pop');
  void dom.taunt.offsetWidth;
  dom.taunt.classList.add('pop');
  clearTimeout(tauntTimer);
  tauntTimer = setTimeout(() => { dom.taunt.textContent = ''; }, 2200);
}

function clearCombo({ quiet } = {}) {
  const had = combo;
  const owner = comboOwner;
  combo = 0;
  comboOwner = null;
  comboTier = -1;
  dom.combo.textContent = '';
  dom.combo.dataset.tier = '';
  applyScreen();
  return { had, owner, quiet };
}

/** 相手に割り込まれてコンボが切れた合図 */
function comboBreak(victim, had) {
  if (had < 3) return;
  dom.combo.dataset.owner = victim;
  dom.combo.dataset.tier = 'break';
  dom.combo.textContent = victim === 'human' ? `COMBO BREAK ${had}` : `JEV BREAK ${had}`;
  dom.combo.classList.remove('pop');
  void dom.combo.offsetWidth;
  dom.combo.classList.add('pop');
  sfx.break();
  if (victim === 'human') showTaunt('cpu', 0);
}

// ------------------------------------------------------------------- 演出

function celebrate(by, pileIndex) {
  // render3d が台札の実座標を教えてくれるならそれを使う
  const pos = table.pilePosition?.(pileIndex) ?? { x: pileIndex === 0 ? -1.3 : 1.3, y: 0.35, z: 0 };
  const color = by === 'human' ? 0x5eead4 : 0xf472b6;

  // --- コンボの継承判定: 相手が挟まったら連鎖は切れて 1 から数え直し
  const broken = comboOwner && comboOwner !== by ? { owner: comboOwner, had: combo } : null;
  if (broken) {
    clearCombo();
    comboBreak(broken.owner, broken.had);
  }
  comboOwner = by;
  combo += 1;
  bestCombo[by] = Math.max(bestCombo[by], combo);

  const prevTier = comboTier;
  comboTier = tierIndexOf(combo);

  vfx.hitStop(by === 'human' ? 80 : 55);
  vfx.burst(pos, color, 90 + Math.min(combo, 14) * 10);
  vfx.shockwave(pos, color);
  vfx.chromaticPulse(0.4 + Math.min(combo, 10) * 0.05);
  table.cameraShake(0.18 + Math.min(combo, 12) * 0.025);
  sfx[by === 'human' ? 'place' : 'placeEnemy'](combo);

  if (combo >= 2) showComboBanner(by);

  // --- 段階が上がった瞬間だけ、属性エフェクトを撃つ
  if (comboTier > prevTier && comboTier >= 0) {
    const t = COMBO_TIERS[comboTier];
    vfx.comboSurge(t.tier, pos, t.color);
    table.cameraShake(0.3 + t.tier * 0.16);
    if (t.tier >= 2) table.cameraPunch?.(0.10 + t.tier * 0.035, 520);
    sfx.surge(t.tier + 1, by === 'human');
    showTaunt(by, comboTier);
  } else if (comboTier >= 0) {
    // 段階内の連打でも属性を薄く残す（煽りを途切れさせない）
    const t = COMBO_TIERS[comboTier];
    if (t.tier === 1) vfx.water(pos, 60, { color: t.color, power: 0.8 });
    else if (t.tier === 2) vfx.flame(pos, 90, { color: t.color, radius: 0.34, rise: 2.4 });
    else if (t.tier === 3) { vfx.flame(pos, 70, { color: 0xffe08a, radius: 0.3, rise: 2.2 }); vfx.lightning(pos, t.color, { sparks: 40, dur: 0.22 }); }
    else if (t.tier === 4) { vfx.lightning(pos, 0xffffff, { sparks: 70 }); vfx.flame(pos, 120, { color: 0xfff0a0, radius: 0.5, rise: 3.4 }); vfx.vortex(pos, t.color, 90, { spin: 8 }); }
  }

  applyScreen();
}

/**
 * お手付き。違反した札は台札に乗らず、そのプレイヤーが一定時間出せなくなる。
 * @param {'human'|'cpu'} playerId
 * @param {number} pileIndex 出そうとした台札
 */
function commitFoul(playerId, pileIndex) {
  foulCount[playerId]++;
  const ms = Math.min(
    CONFIG.FOUL_LOCKOUT_MAX_MS,
    CONFIG.FOUL_LOCKOUT_MS * CONFIG.FOUL_LOCKOUT_STEP ** foulStreak[playerId],
  );
  foulStreak[playerId]++;
  lockUntil[playerId] = performance.now() + ms;

  const pos = table.pilePosition?.(pileIndex) ?? { x: 0, y: 0.35, z: 0 };
  vfx.hitStop(110);
  vfx.screenFlash(0xf87171, 180);
  vfx.burst(pos, 0xf87171, 70);
  vfx.chromaticPulse(0.9);
  table.cameraShake(0.42);
  sfx.foul();

  // 自分のコンボは自分のお手付きで途切れる
  if (comboOwner === playerId) {
    const had = combo;
    clearCombo();
    if (had >= 3) showTaunt(playerId === 'human' ? 'cpu' : 'human', 0);
  }

  if (playerId === 'human') {
    selectedSlot = null;
    table.setSelected(null);
    table.highlightPiles([]);
    dom.canvas.classList.remove('miss');
    void dom.canvas.offsetWidth;
    dom.canvas.classList.add('miss');
  }

  showFoulBanner(playerId);
  hud.setFouls(foulCount);
  setStatus(playerId === 'human'
    ? `お手付き！ ${Math.round(ms / 1000)} 秒のペナルティ`
    : `Jev がお手付き — ${Math.round(ms / 1000)} 秒停止`);
}

/** バナーを出している対象。ロックアウトが明けるまで残り秒を出し続ける */
let foulBannerFor = null;

function showFoulBanner(playerId) {
  foulBannerFor = playerId;
  dom.foulBanner.dataset.by = playerId;
  dom.foulBanner.hidden = false;
  dom.foulBanner.classList.remove('pop');
  void dom.foulBanner.offsetWidth;
  dom.foulBanner.classList.add('pop');
  updateFoulBanner();
}

function updateFoulBanner() {
  if (!foulBannerFor) return;
  const left = lockUntil[foulBannerFor] - performance.now();
  if (left <= 0) {
    dom.foulBanner.hidden = true;
    foulBannerFor = null;
    if (running) setStatus('');
    return;
  }
  const who = foulBannerFor === 'human' ? 'お手付き！' : 'JEV お手付き！';
  dom.foulBanner.textContent = `${who} ${(left / 1000).toFixed(1)}s`;
}

function clearFoulBanner() {
  foulBannerFor = null;
  dom.foulBanner.hidden = true;
}

/** お手付きルール OFF のときの「ただ置けないだけ」の反応 */
function refuse(playerId) {
  if (playerId !== 'human') return;
  lockUntil.human = performance.now() + CONFIG.REFUSE_LOCKOUT_MS;
  table.cameraShake(0.12);
  dom.canvas.classList.remove('miss');
  void dom.canvas.offsetWidth;
  dom.canvas.classList.add('miss');
}

// --------------------------------------------------------------- 手を打つ

function tryPlay(playerId, move) {
  const card = state.players[playerId].hand[move.handIndex];
  const res = rules.applyMove(state, playerId, move);

  if (!res.ok) {
    // ルール違反かどうかの判定は常に rules.js が機械的に行う。
    // お手付きルールが ON のプレイヤーだけ、それをペナルティとして受ける。
    if (res.error === 'ILLEGAL_STACK' && foulRule[playerId]) {
      commitFoul(playerId, move.pileIndex);
    } else if (playerId === 'human') {
      refuse(playerId);
      setStatus(res.error === 'ILLEGAL_STACK' ? 'そこには置けません' : 'その操作はできません');
    }
    return false;
  }

  state = res.state;
  lastPile = move.pileIndex;
  foulStreak[playerId] = 0; // 成功プレイで連続お手付きをリセット
  table.animatePlay({ by: playerId, fromSlot: move.handIndex, toPile: move.pileIndex, card });
  celebrate(playerId, move.pileIndex);
  sync();

  if (playerId === 'human') {
    selectedSlot = null;
    table.setSelected(null);
    table.highlightPiles([]);
  }

  if (state.phase === 'finished') finish(playerId);
  return true;
}

// ------------------------------------------------------------ フィニッシュ

/** 「バチコーン」。止める → 白飛ばす → 引き裂く → 降らせる → 結果 */
function finish(by) {
  running = false;
  ai.cancel();
  clearTimeout(flipTimer);
  flipTimer = null;
  awaitingSpeed = false;
  dom.speedCall.hidden = true;
  table.setDeckGlow?.(0);
  const won = state.winner === 'human';
  const draw = state.winner === 'draw';
  const color = draw ? 0xfbbf24 : won ? 0x5eead4 : 0xf472b6;

  const pos = table.pilePosition?.(lastPile) ?? table.centerPosition?.() ?? { x: 0, y: 0.5, z: 0 };

  cancelFinishFx = vfx.finishBlast(pos, color);
  table.cameraPunch?.(0.42, 2400);
  table.cameraShake(1.1);
  vfx.setRage(1, color);
  vfx.setTension(0, 0x000000, 1);
  table.setMood?.(1, color);
  tension.kind = ''; tension.level = 0; tension.band = 0;
  dom.stage.dataset.tension = '';
  sfx.finish(won);

  // 決着で連鎖は終わり。画面の熱はフィニッシュ演出が引き継ぐ
  combo = 0;
  comboOwner = null;
  comboTier = -1;
  dom.combo.textContent = '';
  dom.taunt.textContent = '';
  dom.stage.dataset.rage = draw ? 'god' : won ? 'god' : 'god-cpu';

  // 画面いっぱいの「バチコーン!!」
  dom.finishWord.textContent = 'バチコーン!!';
  dom.finishSub.textContent = draw ? 'DRAW' : won ? 'YOU WIN' : 'JEV WINS';
  dom.finish.dataset.result = draw ? 'draw' : won ? 'win' : 'lose';
  dom.finish.hidden = false;
  dom.finish.classList.remove('go');
  void dom.finish.offsetWidth;
  dom.finish.classList.add('go');

  // 追い打ちのシェイク
  [180, 420, 760, 1100].forEach((ms, i) => setTimeout(() => table.cameraShake(0.7 - i * 0.14), ms));

  const s = ai.summary();
  const foulLine = (foulRule.human || foulRule.cpu)
    ? `お手付き あなた ${foulCount.human} 回 · Jev ${foulCount.cpu} 回<br>`
    : '';

  clearTimeout(finishTimer);
  finishTimer = setTimeout(() => {
    dom.finish.hidden = true;
    dom.finish.classList.remove('go');
    dom.stage.dataset.rage = '';
    vfx.setRage(0, 0x000000);
    vfx.setTension(0, 0x000000, 1);
    table.setMood?.(0, 0x000000);
    showOverlay(
      draw ? 'DRAW' : won ? 'YOU WIN' : 'JEV WINS',
      `最大コンボ あなた ${bestCombo.human} · Jev ${bestCombo.cpu}<br>` +
      foulLine +
      `Jev の判断 ${s.judgements} 件 / 正答率 ${(s.accuracy * 100).toFixed(1)}%<br>` +
      `誤検知 ${s.falsePositives} 件 · 見落し ${s.falseNegatives} 件<br>` +
      `入力トークン ${s.inputTokens.toLocaleString()} / $${s.costUsd.toFixed(6)}` +
      (s.mock ? '<br><em>※ モックモードでの結果です</em>' : ''),
      'もう一度',
    );
  }, CONFIG.FINISH_SHOW_MS);
  void by;
}

// ------------------------------------------------------------ 人間の入力

function selectSlot(slot) {
  if (!running || isLocked('human')) return;
  const card = state.players.human.hand[slot];
  if (!card) return;

  selectedSlot = selectedSlot === slot ? null : slot;
  table.setSelected(selectedSlot);

  if (selectedSlot == null) {
    table.highlightPiles([]);
    return;
  }
  const piles = [0, 1].filter((i) => state.piles[i] && rules.isStackable(card, state.piles[i]));
  table.highlightPiles(piles);
  setStatus(piles.length ? '置ける台札が光っています' : 'この札は今どちらにも置けません');
}

function playOnPile(pileIndex) {
  if (!running || selectedSlot == null || isLocked('human')) return;
  tryPlay('human', { handIndex: selectedSlot, pileIndex });
}

function onPointerDown(ev) {
  if (!running || awaitingSpeed) return;
  const slot = table.pickHandSlot(ev.clientX, ev.clientY);
  if (slot != null) { selectSlot(slot); return; }
  const pile = table.pickPile(ev.clientX, ev.clientY);
  if (pile != null) playOnPile(pile);
}

function onKeyDown(ev) {
  if (!running) return;
  if (awaitingSpeed) {
    // 宣言待ちの間は Space / Enter だけを受ける
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      callSpeed();
    }
    return;
  }
  if (ev.key >= '1' && ev.key <= '9') {
    selectSlot(Number(ev.key) - 1);
  } else if (ev.key === 'ArrowLeft' || ev.key.toLowerCase() === 'f') {
    playOnPile(0);
  } else if (ev.key === 'ArrowRight' || ev.key.toLowerCase() === 'j') {
    playOnPile(1);
  } else if (ev.key === 'Escape') {
    selectedSlot = null;
    table.setSelected(null);
    table.highlightPiles([]);
  }
}

// ------------------------------------------------------------------ CPU

async function driveCPU() {
  if (!running || state.phase !== 'playing' || ai.busy) return;
  if (isLocked('cpu')) return; // お手付きのペナルティ中

  const { move, skipped } = await ai.think(state);
  if (skipped) return; // 局面が変わっていないので問い合わせていない
  hud.setSummary(ai.summary());
  if (!running || state.phase !== 'playing') return;

  if (move) {
    if (CONFIG.CPU_EXTRA_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.CPU_EXTRA_DELAY_MS));
      if (!running || state.phase !== 'playing') return;
    }
    tryPlay('cpu', move);
  }
}

// ------------------------------------------------------------ 手詰まり処理

/**
 * 手詰まり（両者とも台札に重ねられない）。
 * 勝手にめくらず、プレイヤーが「スピード！」を宣言してから 1 枚ずつめくる。
 * 実際のスピードでも両者が声を合わせてめくるので、ルールとしても自然。
 */
function checkStuck() {
  // rules.js は手詰まりを検出すると phase を 'stuck' にするので、両方を見る
  if (!running || awaitingSpeed) return;
  if (state.phase !== 'playing' && state.phase !== 'stuck') return;
  if (!rules.isStuck(state)) return;
  enterSpeedCall();
}

/** 宣言待ちに入る。盤面を止めて、山札に注目させる */
function enterSpeedCall() {
  awaitingSpeed = true;
  // 仕切り直しなので連鎖もここで終わる
  clearCombo();
  selectedSlot = null;
  table.setSelected(null);
  table.highlightPiles([]);
  dom.speedCall.hidden = false;
  dom.speedBtn.focus({ preventScroll: true });
  setStatus('');
  table.setDeckGlow?.(1);
}

/** 「スピード！」— 宣言の一撃と、めくりの着弾を分けて見せる */
function callSpeed() {
  if (!awaitingSpeed || !running) return;
  awaitingSpeed = false;
  dom.speedCall.hidden = true;
  table.setDeckGlow?.(0);
  sfx.speedCall();

  // --- 宣言の瞬間
  vfx.hitStop(80);
  vfx.screenFlash(0xfff1b8, 180);
  vfx.radialBlast(0.6);
  vfx.chromaticPulse(0.6);
  table.cameraPunch?.(0.18, 950);
  table.cameraShake(0.34);
  // めくりをゆっくり見せる（一気に進んで分からない、を防ぐ）
  vfx.slowMotion(900, 0.40);

  const res = rules.applyFlip(state);
  state = res.state;
  table.animateFlip(state.piles);
  sync();

  // --- 札が台に着いた瞬間（animateFlip の落下に合わせる）
  clearTimeout(flipTimer);
  flipTimer = setTimeout(() => {
    flipTimer = null;
    sfx.flip();
    table.cameraShake(0.3);
    for (const i of [0, 1]) {
      const p = table.pilePosition?.(i);
      if (!p) continue;
      vfx.burst(p, i === 0 ? 0x5eead4 : 0xf472b6, 90);
      vfx.spawnRing(p, 0xfbbf24, { dur: 0.8, from: 0.2, to: 5.2 });
      vfx.pillar(p, 0xffd76a, { dur: 0.55, height: 0.45, scale: 0.7, opacity: 0.5 });
    }
    if (state.phase === 'finished') finish(null);
    else setStatus('再開！');
  }, CONFIG.FLIP_IMPACT_MS);
}

// -------------------------------------------------------------- ループ

let lastT = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  const realDt = Math.min(64, now - lastT);
  lastT = now;

  vfx.update(realDt);
  table.render(realDt * vfx.timeScale());
  updateFoulBanner();

  if (running) {
    checkStuck();
    driveCPU();
  }
}

// -------------------------------------------------------------- 画面遷移

function showOverlay(title, bodyHTML, btnLabel) {
  dom.overlayTitle.textContent = title;
  dom.overlayBody.innerHTML = bodyHTML;
  dom.startBtn.textContent = btnLabel;
  dom.overlay.hidden = false;
}

/** 開始画面の設定から お手付きルールの適用対象を読み込む */
function readFoulSetting() {
  const v = dom.foulSelect?.value ?? 'both';
  foulRule.human = v === 'both' || v === 'human';
  foulRule.cpu = v === 'both' || v === 'cpu';
  // Jev 側: ON なら Jev の判断をそのまま場に出す（誤判定がお手付きになる）
  ai.setFoulMode(foulRule.cpu);
}

function newGame() {
  sfx.unlock();
  dom.overlay.hidden = true;
  clearTimeout(flipTimer);
  clearTimeout(finishTimer);
  clearTimeout(tauntTimer);
  if (cancelFinishFx) { cancelFinishFx(); cancelFinishFx = null; }
  clearFoulBanner();
  awaitingSpeed = false;
  dom.speedCall.hidden = true;
  table.setDeckGlow?.(0);
  dom.finish.hidden = true;
  dom.finish.classList.remove('go');
  dom.taunt.textContent = '';
  flipTimer = null;
  finishTimer = null;
  clearCombo();
  tension.kind = ''; tension.level = 0; tension.band = 0;
  dom.stage.dataset.tension = '';
  vfx.setTension(0, 0x000000, 1);
  bestCombo.human = 0;
  bestCombo.cpu = 0;
  selectedSlot = null;
  lastPile = 0;
  lockUntil.human = 0;
  lockUntil.cpu = 0;
  foulCount.human = 0;
  foulCount.cpu = 0;
  foulStreak.human = 0;
  foulStreak.cpu = 0;
  hud.reset();
  ai.reset();
  readFoulSetting();
  hud.setFouls(foulCount);
  hud.setFoulRule(foulRule);

  state = rules.startGame(rules.createGame({ handSize: CONFIG.handSize }));
  table.setSelected(null);
  table.highlightPiles([]);
  sync();
  running = true;
  setStatus('カードを選んで台札に置いてください（キー 1〜5 / ← →）');
}

// ---------------------------------------------------------------- 起動

async function boot() {
  table = await createTable(dom.canvas);
  vfx = createVFX(table);
  hud = createHUD(dom.hud);
  sfx = createSFX();

  ai = createJevPlayer({
    playerId: 'cpu',
    onThinkStart: () => hud.onThinkStart(),
    onDecision: (t) => hud.onDecision(t),
    onError: (e) => hud.setError(e.message || 'Jev への接続に失敗しました'),
  });

  // デバッグ/デモ用のハンドル（コンソールから盤面や演出を触れるようにする）
  window.JEVSPEED = {
    table, vfx, hud, sfx, ai, rules, newGame, foulRule, foulCount, foulStreak, commitFoul, CONFIG,
    COMBO_TIERS, callSpeed,
    get state() { return state; },
    get combo() { return { owner: comboOwner, count: combo, tier: comboTier, best: bestCombo }; },
  };

  const resize = () => table.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
  window.addEventListener('resize', resize);
  resize();

  dom.canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  dom.startBtn.addEventListener('click', newGame);
  dom.speedBtn.addEventListener('click', callSpeed);
  dom.revealToggle.addEventListener('change', () => sync());
  dom.soundToggle.checked = !sfx.isMuted();
  dom.soundToggle.addEventListener('change', () => {
    sfx.setMuted(!dom.soundToggle.checked);
    if (dom.soundToggle.checked) sfx.place(1);
  });
  dom.foulSelect.addEventListener('change', () => {
    readFoulSetting();
    hud.setFoulRule(foulRule);
  });

  readFoulSetting();
  hud.setFoulRule(foulRule);
  hud.setFouls(foulCount);

  let health = { ok: false, mock: true, hasKey: false };
  try { health = await jevHealth(); } catch { /* サーバー未起動でもUIは出す */ }

  state = rules.createGame({ handSize: CONFIG.handSize });
  sync();

  dom.loading.hidden = true;
  showOverlay(
    'JEV SPEED',
    'トランプの<strong>スピード</strong>で Jev と対戦します。<br>' +
    'Jev は毎手「この札はこの台札に積めるか」を並列判定し、<br>' +
    'その判断はプログラム側のルール検証器と突き合わせて表示されます。<br><br>' +
    '<strong>連続で置けばコンボ</strong> — 相手に 1 手でも割り込まれると切れます。<br>' +
    '3 連鎖で <span class="el-aqua">水</span>、5 で <span class="el-flame">炎</span>、' +
    '7 で <span class="el-storm">雷</span>、10 で <span class="el-god">OVERDRIVE</span>。<br>' +
    '両者とも出せなくなったら <strong>「スピード！」</strong> を押して山札をめくります。<br><br>' +
    (health.hasKey
      ? '<span class="ok-dot"></span> TypeSafe API に接続済み'
      : '<span class="warn-dot"></span> API キー未設定 — モックモードで動作します<br><small>.env に TYPESAFE_API_KEY を設定すると本物の Jev で動きます</small>'),
    'ゲーム開始',
  );

  requestAnimationFrame(loop);
}

boot().catch((e) => {
  dom.loading.hidden = true;
  showOverlay('起動に失敗しました', `<pre>${String(e && e.stack || e)}</pre>`, '再読み込み');
  dom.startBtn.onclick = () => location.reload();
});
