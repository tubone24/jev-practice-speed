// Jev の判断を可視化する HUD。
// このデモの主目的は「Jev がどれだけ速く・正しく判断したか」を見せることなので、
// レイテンシ・noul 確率・機械的検証との一致率をリアルタイムに出す。

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

/**
 * @param {HTMLElement} root  HUD を描画するコンテナ
 */
export function createHUD(root) {
  root.innerHTML = '';

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

  root.append(latPanel, judgePanel, verifyPanel, foulPanel);

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

  /** Jev へのリクエスト開始 */
  function onThinkStart() {
    thinking = true;
    judgeFoot.textContent = 'Jev 思考中…';
    judgePanel.classList.add('is-thinking');
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
    drawSpark();
  }

  return {
    onThinkStart, onDecision, setSummary, setFouls, setFoulRule, setError, reset,
    get thinking() { return thinking; },
  };
}
