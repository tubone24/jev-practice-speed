// JEV SPEED — 統合レイヤー。
// ゲームループ、人間の入力、Jev(CPU) の駆動、演出のトリガをここで束ねる。

import * as rules from './rules.js';
import { createTable } from './render3d.js';
import { createVFX } from './vfx.js';
import { createHUD } from './hud.js';
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
  /** 手詰まり判定から台札めくりまでの待ち(ms) */
  FLIP_DELAY_MS: 900,
  /** CPU が次の思考に入るまでの最小待ち(ms)。0 で Jev の素の速度 */
  CPU_EXTRA_DELAY_MS: 0,
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
  humanCount: document.getElementById('human-count'),
  cpuCount: document.getElementById('cpu-count'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  startBtn: document.getElementById('start-btn'),
  revealToggle: document.getElementById('reveal-toggle'),
  foulSelect: document.getElementById('foul-select'),
  foulBanner: document.getElementById('foul-banner'),
  loading: document.getElementById('loading'),
};

let table = null;
let vfx = null;
let hud = null;
let ai = null;
let state = null;
let selectedSlot = null;
let combo = 0;
let bestCombo = 0;
/** プレイヤーごとのロックアウト解除時刻(performance.now() 基準) */
const lockUntil = { human: 0, cpu: 0 };
const foulCount = { human: 0, cpu: 0 };
/** 連続お手付き数。成功プレイでリセットされ、ペナルティの重さに効く */
const foulStreak = { human: 0, cpu: 0 };
let flipTimer = null;
let running = false;

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
  dom.humanCount.textContent = String(remaining(state.players.human));
  dom.cpuCount.textContent = String(remaining(state.players.cpu));
}

function remaining(p) {
  return p.hand.filter(Boolean).length + p.stock.length;
}

function setStatus(text) {
  dom.status.textContent = text;
}

// ------------------------------------------------------------------- 演出

function celebrate(by, pileIndex) {
  // render3d が台札の実座標を教えてくれるならそれを使う
  const pos = table.pilePosition?.(pileIndex) ?? { x: pileIndex === 0 ? -1.3 : 1.3, y: 0.35, z: 0 };
  const color = by === 'human' ? 0x5eead4 : 0xf472b6;

  vfx.hitStop(by === 'human' ? 80 : 55);
  vfx.burst(pos, color, 90 + combo * 8);
  vfx.shockwave(pos, color);
  vfx.chromaticPulse(0.4 + Math.min(combo, 10) * 0.05);
  table.cameraShake(0.18 + Math.min(combo, 12) * 0.02);

  if (by === 'human') {
    combo++;
    bestCombo = Math.max(bestCombo, combo);
    dom.combo.textContent = combo > 1 ? `${combo} COMBO` : '';
    dom.combo.classList.remove('pop');
    void dom.combo.offsetWidth;
    dom.combo.classList.add('pop');
    if (combo > 0 && combo % 5 === 0) {
      vfx.slowMotion(420, 0.35);
      vfx.screenFlash(0x5eead4, 140);
    }
  }
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

  if (playerId === 'human') {
    combo = 0;
    dom.combo.textContent = '';
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
  foulStreak[playerId] = 0; // 成功プレイで連続お手付きをリセット
  table.animatePlay({ by: playerId, fromSlot: move.handIndex, toPile: move.pileIndex, card });
  celebrate(playerId, move.pileIndex);
  sync();

  if (playerId === 'human') {
    selectedSlot = null;
    table.setSelected(null);
    table.highlightPiles([]);
  }

  if (state.phase === 'finished') finish();
  return true;
}

function finish() {
  running = false;
  ai.cancel();
  const won = state.winner === 'human';
  const draw = state.winner === 'draw';

  vfx.slowMotion(1400, 0.25);
  vfx.screenFlash(won ? 0x5eead4 : 0xf472b6, 300);
  for (let i = 0; i < 6; i++) {
    setTimeout(() => vfx.burst({ x: (Math.random() - 0.5) * 4, y: 0.6, z: (Math.random() - 0.5) * 2 },
      won ? 0x5eead4 : 0xf472b6, 140), i * 130);
  }

  const s = ai.summary();
  const foulLine = (foulRule.human || foulRule.cpu)
    ? `お手付き あなた ${foulCount.human} 回 · Jev ${foulCount.cpu} 回<br>`
    : '';
  showOverlay(
    draw ? 'DRAW' : won ? 'YOU WIN' : 'JEV WINS',
    `最大コンボ ${bestCombo}<br>` +
    foulLine +
    `Jev の判断 ${s.judgements} 件 / 正答率 ${(s.accuracy * 100).toFixed(1)}%<br>` +
    `誤検知 ${s.falsePositives} 件 · 見落し ${s.falseNegatives} 件<br>` +
    `入力トークン ${s.inputTokens.toLocaleString()} / $${s.costUsd.toFixed(6)}` +
    (s.mock ? '<br><em>※ モックモードでの結果です</em>' : ''),
    'もう一度',
  );
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
  if (!running) return;
  const slot = table.pickHandSlot(ev.clientX, ev.clientY);
  if (slot != null) { selectSlot(slot); return; }
  const pile = table.pickPile(ev.clientX, ev.clientY);
  if (pile != null) playOnPile(pile);
}

function onKeyDown(ev) {
  if (!running) return;
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

function checkStuck() {
  // rules.js は手詰まりを検出すると phase を 'stuck' にするので、両方を見る
  if (!running || flipTimer) return;
  if (state.phase !== 'playing' && state.phase !== 'stuck') return;
  if (!rules.isStuck(state)) return;

  setStatus('手詰まり — 台札をめくります');
  flipTimer = setTimeout(() => {
    flipTimer = null;
    if (!running) return;
    const res = rules.applyFlip(state);
    state = res.state;
    table.animateFlip(state.piles);
    vfx.screenFlash(0xfbbf24, 160);
    table.cameraShake(0.25);
    sync();
    setStatus(state.phase === 'finished' ? '' : 'ゲーム再開');
    if (state.phase === 'finished') finish();
  }, CONFIG.FLIP_DELAY_MS);
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
  dom.overlay.hidden = true;
  clearTimeout(flipTimer);
  clearFoulBanner();
  flipTimer = null;
  combo = 0;
  bestCombo = 0;
  selectedSlot = null;
  lockUntil.human = 0;
  lockUntil.cpu = 0;
  foulCount.human = 0;
  foulCount.cpu = 0;
  foulStreak.human = 0;
  foulStreak.cpu = 0;
  dom.combo.textContent = '';
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

  ai = createJevPlayer({
    playerId: 'cpu',
    onThinkStart: () => hud.onThinkStart(),
    onDecision: (t) => hud.onDecision(t),
    onError: (e) => hud.setError(e.message || 'Jev への接続に失敗しました'),
  });

  // デバッグ/デモ用のハンドル（コンソールから盤面や演出を触れるようにする）
  window.JEVSPEED = {
    table, vfx, hud, ai, rules, newGame, foulRule, foulCount, foulStreak, commitFoul, CONFIG,
    get state() { return state; },
  };

  const resize = () => table.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
  window.addEventListener('resize', resize);
  resize();

  dom.canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  dom.startBtn.addEventListener('click', newGame);
  dom.revealToggle.addEventListener('change', () => sync());
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
