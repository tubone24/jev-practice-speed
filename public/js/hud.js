// Jev の判断を可視化する HUD。
// このデモの主目的は「Jev がどれだけ速く・正しく判断したか」を見せることなので、
// レイテンシ・noul 確率・機械的検証との一致率をリアルタイムに出す。
// あわせて pressure(score) から「いま Jev が余裕か苦しいか」をキャラクターの顔で見せる。

import { classifyPressure, pickLine, MOOD_IDLE } from './mood.js';

const RANK_LABEL = { A: 'A', J: 'J', Q: 'Q', K: 'K' };
const SUIT_GLYPH = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

function cardLabel(card) {
  if (!card) return '--';
  return `${RANK_LABEL[card.rank] ?? card.rank}${SUIT_GLYPH[card.suit] ?? ''}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** 汗のしずく。苦しいときに顔の横へ出す */
const SWEAT = (x, y, cls = '') =>
  `<path class="f-sweat ${cls}" d="M${x} ${y} q6 9 0 14 q-6 -5 0 -14"/>`;

/**
 * 気分ごとの顔(SVG の中身)。輪郭は共通で、目・口・小物だけ差し替える。
 * viewBox は 0 0 100 100。線色は CSS 側で currentColor から取る。
 */
const FACES = {
  idle: `
    <path class="f-line" d="M31 49 h12"/><path class="f-line" d="M57 49 h12"/>
    <path class="f-line" d="M44 66 h12"/>`,
  thinking: `
    <circle class="f-eye" cx="40" cy="45" r="3.4"/><circle class="f-eye" cx="64" cy="45" r="3.4"/>
    <path class="f-line" d="M42 66 q4 -3 8 0 q4 3 8 0"/>`,
  relaxed: `
    <path class="f-line" d="M30 50 q7 -9 14 0"/><path class="f-line" d="M56 50 q7 -9 14 0"/>
    <path class="f-line f-mouth" d="M36 61 q14 15 28 0"/>
    <path class="f-spark" d="M82 22 l2.2 5.8 5.8 2.2 -5.8 2.2 -2.2 5.8 -2.2 -5.8 -5.8 -2.2 5.8 -2.2z"/>`,
  steady: `
    <circle class="f-eye" cx="37" cy="48" r="4"/><circle class="f-eye" cx="63" cy="48" r="4"/>
    <path class="f-line" d="M40 64 q10 7 20 0"/>`,
  strained: `
    <path class="f-line" d="M29 38 l14 4"/><path class="f-line" d="M71 38 l-14 4"/>
    <path class="f-line" d="M31 51 h12"/><path class="f-line" d="M57 51 h12"/>
    <path class="f-line" d="M38 67 q6 -6 12 0 q6 6 12 0"/>
    ${SWEAT(80, 30)}`,
  cornered: `
    <path class="f-line" d="M28 35 l14 -3"/><path class="f-line" d="M72 35 l-14 -3"/>
    <circle class="f-eye-ring" cx="37" cy="48" r="6.5"/><circle class="f-eye-ring" cx="63" cy="48" r="6.5"/>
    <circle class="f-eye" cx="38" cy="49" r="1.8"/><circle class="f-eye" cx="62" cy="49" r="1.8"/>
    <ellipse class="f-line f-open" cx="50" cy="68" rx="6" ry="5"/>
    ${SWEAT(80, 28)}${SWEAT(16, 40, 'late')}`,
  checkmate: `
    <path class="f-line" d="M31 42 l12 12 M43 42 l-12 12"/>
    <path class="f-line" d="M57 42 l12 12 M69 42 l-12 12"/>
    <path class="f-line" d="M38 67 h24 M44 64 v6 M50 64 v6 M56 64 v6"/>`,
};

/** ゲージの目盛り。ai.js の PRESSURE_LEVELS(0..3) を日本語に置いたもの */
const GAUGE_TICKS = ['多い', '少ない', '一手', '無し'];

/**
 * @param {HTMLElement} root  HUD を描画するコンテナ
 */
export function createHUD(root) {
  root.innerHTML = '';

  // ---- 気分パネル: Jev が今どれくらい余裕か / 苦しいか ----
  const moodPanel = el('section', 'hud-panel hud-mood');
  moodPanel.dataset.mood = 'idle';
  moodPanel.append(el('h2', 'hud-title', 'JEV MOOD'));
  moodPanel.append(el('p', 'hud-hint', 'pressure = Jev 自身が答えた「いま選べる手の少なさ」'));

  const moodBody = el('div', 'mood-body');
  const face = el('div', 'mood-face');
  face.innerHTML =
    '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    '<circle class="f-head" cx="50" cy="52" r="40"/>' +
    `<g class="f-features">${FACES.idle}</g>` +
    '</svg>';
  const features = face.querySelector('.f-features');
  moodBody.append(face);

  const moodSide = el('div', 'mood-side');
  const moodLabel = el('div', 'mood-label', MOOD_IDLE.label);
  const moodBubble = el('div', 'mood-bubble', '対局前');
  moodSide.append(moodLabel, moodBubble);
  moodBody.append(moodSide);
  moodPanel.append(moodBody);

  const gauge = el('div', 'mood-gauge');
  const track = el('div', 'mood-track');
  const fill = el('div', 'mood-fill');
  const marker = el('div', 'mood-marker');
  track.append(fill, marker);
  gauge.append(track);
  const ticks = el('div', 'mood-ticks');
  for (const t of GAUGE_TICKS) ticks.append(el('span', null, t));
  gauge.append(ticks);
  moodPanel.append(gauge);

  const moodFoot = el('div', 'mood-foot', 'pressure -- / -- · conf --');
  moodPanel.append(moodFoot);

  // ---- ヘッダ: レイテンシ ----
  const latPanel = el('section', 'hud-panel hud-latency');
  latPanel.append(el('h2', 'hud-title', 'JEV LATENCY'));
  const latBig = el('div', 'lat-big', '--');
  const latUnit = el('span', 'lat-unit', 'ms');
  latBig.append(latUnit);
  latPanel.append(latBig);

  const spark = document.createElement('canvas');
  spark.className = 'lat-spark';
  spark.width = 320;
  spark.height = 56;
  latPanel.append(spark);

  const latStats = el('div', 'lat-stats');
  const statNodes = {};
  for (const k of ['p50', 'p95', 'min', 'max']) {
    const cell = el('div', 'lat-stat');
    cell.append(el('span', 'lat-stat-k', k));
    const v = el('span', 'lat-stat-v', '--');
    statNodes[k] = v;
    cell.append(v);
    latStats.append(cell);
  }
  latPanel.append(latStats);

  const mockBadge = el('div', 'mock-badge', 'MOCK MODE');
  mockBadge.hidden = true;
  latPanel.append(mockBadge);

  // ---- 判定パネル ----
  const judgePanel = el('section', 'hud-panel hud-judge');
  judgePanel.append(el('h2', 'hud-title', 'JEV JUDGEMENT'));
  const judgeHint = el('p', 'hud-hint', 'noul = 「この札はこの台札に積めるか?」の確信度');
  judgePanel.append(judgeHint);
  const judgeList = el('div', 'judge-list');
  judgePanel.append(judgeList);
  const judgeFoot = el('div', 'judge-foot', '待機中');
  judgePanel.append(judgeFoot);

  // ---- 検証パネル ----
  const verifyPanel = el('section', 'hud-panel hud-verify');
  verifyPanel.append(el('h2', 'hud-title', 'RULE VALIDATOR'));
  verifyPanel.append(el('p', 'hud-hint', 'Jev の判断 vs プログラムによる機械的検証'));
  const accWrap = el('div', 'acc-wrap');
  const accBig = el('div', 'acc-big', '--');
  accWrap.append(accBig);
  accWrap.append(el('span', 'acc-label', 'ACCURACY'));
  verifyPanel.append(accWrap);

  const counters = el('div', 'verify-counters');
  const counterNodes = {};
  for (const [k, label] of [
    ['judgements', '判定数'],
    ['falsePositives', '誤検知'],
    ['falseNegatives', '見落し'],
    ['rejected', '検証で拒否'],
  ]) {
    const cell = el('div', 'verify-counter');
    cell.append(el('span', 'vc-k', label));
    const v = el('span', 'vc-v', '0');
    counterNodes[k] = v;
    cell.append(v);
    counters.append(cell);
  }
  verifyPanel.append(counters);

  const usage = el('div', 'usage-line', 'tokens 0 / $0.000000');
  verifyPanel.append(usage);

  // ---- お手付きパネル ----
  const foulPanel = el('section', 'hud-panel hud-foul');
  foulPanel.append(el('h2', 'hud-title', 'FOUL / お手付き'));
  const foulHint = el('p', 'hud-hint', '');
  foulPanel.append(foulHint);
  const foulRow = el('div', 'foul-row');
  const foulNodes = {};
  for (const [k, label] of [['human', 'YOU'], ['cpu', 'JEV']]) {
    const cell = el('div', `foul-cell foul-${k}`);
    cell.append(el('span', 'foul-k', label));
    const v = el('span', 'foul-v', '0');
    foulNodes[k] = v;
    cell.append(v);
    foulRow.append(cell);
  }
  foulPanel.append(foulRow);

  root.append(moodPanel, latPanel, judgePanel, verifyPanel, foulPanel);

  // ---- 状態 ----
  const samples = [];
  let rejectedTotal = 0;
  let thinking = false;

  function drawSpark() {
    const ctx = spark.getContext('2d');
    const w = spark.width;
    const h = spark.height;
    ctx.clearRect(0, 0, w, h);
    if (samples.length < 2) return;

    const view = samples.slice(-64);
    const max = Math.max(200, ...view);
    const step = w / (view.length - 1);

    // 塗り
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(94, 234, 212, 0.45)');
    grad.addColorStop(1, 'rgba(94, 234, 212, 0)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    view.forEach((v, i) => ctx.lineTo(i * step, h - (v / max) * (h - 4) - 2));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 線
    ctx.beginPath();
    view.forEach((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 500ms ライン(Jev の公称上限)
    const y500 = h - (500 / max) * (h - 4) - 2;
    if (y500 > 0 && y500 < h) {
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(0, y500);
      ctx.lineTo(w, y500);
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** 直前の気分。段階が変わった瞬間だけ顔を弾ませ、セリフの連発を避ける */
  let mood = MOOD_IDLE;
  let lastLine = null;

  function setFace(id) {
    features.innerHTML = FACES[id] ?? FACES.idle;
  }

  /**
   * pressure(score) の回答から気分を更新する。
   * @param {{score:number, max:number, confidence:number}|null} detail  Telemetry.pressureDetail
   */
  function setPressure(detail) {
    const next = detail
      ? classifyPressure(detail.score, { max: detail.max, confidence: detail.confidence })
      : MOOD_IDLE;
    const changed = next.id !== mood.id;
    mood = next;

    moodPanel.dataset.mood = next.id;
    moodPanel.classList.remove('is-thinking');
    setFace(next.id);
    moodLabel.textContent = next.label;

    if (next.id === 'idle') {
      moodBubble.textContent = '…';
      fill.style.width = '0%';
      marker.style.left = '0%';
      moodFoot.textContent = 'pressure -- / -- · conf --';
      return;
    }

    // セリフは段階が変わったときだけ差し替える(毎手ちらつかせない)
    if (changed || !moodBubble.textContent) {
      lastLine = pickLine(next, { avoid: lastLine });
      moodBubble.textContent = `「${lastLine}」`;
    }

    const pct = Math.round(next.level * 100);
    fill.style.width = `${pct}%`;
    marker.style.left = `${pct}%`;
    moodFoot.textContent =
      `pressure ${next.score.toFixed(2)} / ${next.max} · conf ${Math.round(next.confidence * 100)}%`;

    if (changed) {
      face.classList.remove('pop');
      void face.offsetWidth;
      face.classList.add('pop');
    }
  }

  /** Jev へのリクエスト開始 */
  function onThinkStart() {
    thinking = true;
    judgeFoot.textContent = 'Jev 思考中…';
    judgePanel.classList.add('is-thinking');
    // 考えている間だけ目が泳ぐ。答えが返れば setPressure が顔を戻す
    moodPanel.classList.add('is-thinking');
    setFace('thinking');
  }

  /**
   * Jev の回答が返ったとき。
   * @param {import('./ai.js').Telemetry} t
   */
  function onDecision(t) {
    thinking = false;
    judgePanel.classList.remove('is-thinking');

    // レイテンシ
    const ms = t.latencyMs || t.roundTripMs || 0;
    samples.push(ms);
    if (samples.length > 400) samples.shift();
    latBig.firstChild.nodeValue = String(Math.round(ms));
    latBig.classList.toggle('is-fast', ms < 250);
    latBig.classList.toggle('is-slow', ms > 600);
    latPanel.classList.remove('pulse');
    void latPanel.offsetWidth;
    latPanel.classList.add('pulse');

    const sorted = [...samples].sort((a, b) => a - b);
    statNodes.p50.textContent = Math.round(percentile(sorted, 50)) + 'ms';
    statNodes.p95.textContent = Math.round(percentile(sorted, 95)) + 'ms';
    statNodes.min.textContent = Math.round(sorted[0]) + 'ms';
    statNodes.max.textContent = Math.round(sorted.at(-1)) + 'ms';
    drawSpark();

    mockBadge.hidden = !t.mock;

    // 局面の圧力 → 気分
    setPressure(t.pressureDetail ?? null);

    // 候補ごとの noul
    judgeList.innerHTML = '';
    const sortedCands = [...t.candidates].sort((a, b) => b.noul - a.noul);
    for (const c of sortedCands) {
      const row = el('div', 'judge-row');
      if (c.correct) row.classList.add('ok');
      else row.classList.add('ng');
      if (t.chosen && c.handIndex === t.chosen.handIndex && c.pileIndex === t.chosen.pileIndex) {
        row.classList.add('picked');
      }

      const label = el('span', 'jr-label');
      label.append(el('span', `jr-card ${c.card.color}`, cardLabel(c.card)));
      label.append(el('span', 'jr-arrow', '→'));
      label.append(el('span', `jr-card ${c.pileTop.color}`, cardLabel(c.pileTop)));
      row.append(label);

      const bar = el('div', 'jr-bar');
      const fill = el('div', 'jr-fill');
      fill.style.width = `${Math.round(c.noul * 100)}%`;
      bar.append(fill);
      row.append(bar);

      row.append(el('span', 'jr-noul', c.noul.toFixed(2)));
      row.append(el('span', 'jr-mark', c.correct ? '✓' : '✗'));
      judgeList.append(row);
    }

    const acc = t.accuracy.total ? (t.accuracy.correct / t.accuracy.total) * 100 : 100;
    judgeFoot.textContent =
      `${t.accuracy.correct}/${t.accuracy.total} 一致 (${acc.toFixed(0)}%) · 選択: ${t.reason}` +
      (t.chosenCard ? ` · ${cardLabel(t.chosenCard)}` : '');

    rejectedTotal += t.rejectedByValidator;
    counterNodes.rejected.textContent = String(rejectedTotal);
  }

  /** ai.js の summary() を反映 */
  function setSummary(s) {
    accBig.textContent = s.judgements ? `${(s.accuracy * 100).toFixed(1)}%` : '--';
    accBig.classList.toggle('is-perfect', s.judgements > 0 && s.accuracy === 1);
    counterNodes.judgements.textContent = String(s.judgements);
    counterNodes.falsePositives.textContent = String(s.falsePositives);
    counterNodes.falseNegatives.textContent = String(s.falseNegatives);
    usage.textContent = `tokens ${s.inputTokens.toLocaleString()} / $${s.costUsd.toFixed(6)}`;
  }

  /** お手付き回数を反映 @param {{human:number, cpu:number}} counts */
  function setFouls(counts) {
    for (const k of ['human', 'cpu']) {
      const prev = foulNodes[k].textContent;
      foulNodes[k].textContent = String(counts[k] ?? 0);
      if (prev !== foulNodes[k].textContent) {
        foulNodes[k].classList.remove('bump');
        void foulNodes[k].offsetWidth;
        foulNodes[k].classList.add('bump');
      }
    }
  }

  /** どちらにお手付きルールを適用しているかを表示 @param {{human:boolean, cpu:boolean}} rule */
  function setFoulRule(rule) {
    const on = [rule.human && 'あなた', rule.cpu && 'Jev'].filter(Boolean);
    foulPanel.classList.toggle('is-off', on.length === 0);
    foulHint.textContent = on.length
      ? `適用: ${on.join(' / ')} — 違反すると一定時間出せなくなります`
      : 'お手付きルールなし（違反手は場に出ません）';
    foulPanel.querySelector('.foul-human').classList.toggle('is-off', !rule.human);
    foulPanel.querySelector('.foul-cpu').classList.toggle('is-off', !rule.cpu);
  }

  function setError(msg) {
    thinking = false;
    judgePanel.classList.remove('is-thinking');
    judgeFoot.textContent = `⚠ ${msg}`;
    // 答えが来なかったので、思考中の顔を直前の気分に戻す
    moodPanel.classList.remove('is-thinking');
    setFace(mood.id);
  }

  function reset() {
    samples.length = 0;
    rejectedTotal = 0;
    judgeList.innerHTML = '';
    judgeFoot.textContent = '待機中';
    latBig.firstChild.nodeValue = '--';
    accBig.textContent = '--';
    for (const v of Object.values(counterNodes)) v.textContent = '0';
    for (const v of Object.values(statNodes)) v.textContent = '--';
    usage.textContent = 'tokens 0 / $0.000000';
    mockBadge.hidden = true;
    setFouls({ human: 0, cpu: 0 });
    lastLine = null;
    setPressure(null);
    moodBubble.textContent = '対局前';
    drawSpark();
  }

  return {
    onThinkStart, onDecision, setSummary, setFouls, setFoulRule, setPressure, setError, reset,
    get thinking() { return thinking; },
    get mood() { return mood; },
  };
}
