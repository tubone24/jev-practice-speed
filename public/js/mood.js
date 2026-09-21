// Jev の「気分」。pressure(score 型の回答) から、いまの局面が Jev にとって
// どれくらい余裕か / 苦しいかを 5 段階に分類する。
// DOM に依存しない純粋関数だけを置き、Node で単体テストできるようにしている。

/**
 * @typedef {{
 *   id: 'relaxed'|'steady'|'strained'|'cornered'|'checkmate',
 *   label: string, from: number, lines: string[]
 * }} MoodDef
 */

/**
 * 段階の定義。`from` は正規化した圧力(0=選択肢が多い … 1=出せる手が無い)の下限。
 * 上から順に評価し、level >= from を満たす最後のものが採用される。
 * @type {MoodDef[]}
 */
export const MOODS = [
  {
    id: 'relaxed', label: '余裕', from: 0,
    lines: ['余裕。どこにでも置ける', '選択肢が多すぎて困る', 'まだ本気じゃない'],
  },
  {
    id: 'steady', label: '平常', from: 0.18,
    lines: ['まあ、順当', '悪くない手がある', '淡々といこう'],
  },
  {
    id: 'strained', label: '苦しい', from: 0.42,
    lines: ['ちょっと狭いな…', '選べる手が少ない', '……集中'],
  },
  {
    id: 'cornered', label: '窮地', from: 0.62,
    lines: ['一手しかない…！', 'ここを外したら終わる', 'キツい、キツい'],
  },
  {
    id: 'checkmate', label: '手なし', from: 0.85,
    lines: ['……出せる札が無い', '手が止まった', 'スピード宣言、待ってる'],
  },
];

/** pressure が無いとき(未問い合わせ / 回答欠落) の状態 */
export const MOOD_IDLE = Object.freeze({
  id: 'idle', label: '待機', index: -1, level: 0, score: null, max: null, confidence: 0,
});

/**
 * @typedef {{
 *   id: string, label: string, index: number,
 *   level: number, score: number|null, max: number|null, confidence: number
 * }} Mood
 */

/**
 * pressure(score) を気分に分類する。
 * @param {number|null|undefined} score  Jev の score 回答。0 .. max
 * @param {{ max?: number, confidence?: number }} [opts]
 *   max は score の上限(= criteria の数 - 1)。既定 3。
 * @returns {Mood}
 */
export function classifyPressure(score, { max = 3, confidence = 0 } = {}) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return MOOD_IDLE;
  const top = typeof max === 'number' && max > 0 ? max : 3;
  const level = Math.min(1, Math.max(0, score / top));

  let index = 0;
  for (let i = 0; i < MOODS.length; i++) {
    if (level >= MOODS[i].from) index = i;
  }
  const def = MOODS[index];
  return {
    id: def.id,
    label: def.label,
    index,
    level,
    score,
    max: top,
    confidence: typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : 0,
  };
}

/**
 * 気分に合ったセリフを 1 つ選ぶ。同じセリフの連発を避けるため `avoid` を渡せる。
 * @param {Mood} mood
 * @param {{ rng?: () => number, avoid?: string|null }} [opts]
 */
export function pickLine(mood, { rng = Math.random, avoid = null } = {}) {
  const def = MOODS[mood.index];
  if (!def) return '…';
  const pool = def.lines.length > 1 ? def.lines.filter((l) => l !== avoid) : def.lines;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}
