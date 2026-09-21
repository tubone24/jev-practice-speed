// Jev 推論コア: node:http / Workers のどちらからも使える実行環境非依存のロジック。
// fetch / AbortSignal.timeout / performance.now しか使わないため Node 20+ と Workers 双方で動く。
// APIキーは引数で受け取るだけで、このモジュールは保存もログ出力もしない。

export const UPSTREAM_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [250, 750];
const RETRYABLE = new Set([429, 529]);

// ---------------------------------------------------------------- モック

const RANK_VALUE = {
  a: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, j: 11, q: 12, k: 13,
  ace: 1, jack: 11, queen: 12, king: 13,
};

/** "8 of clubs" / "10 of hearts" のような文字列から値を推定 */
function valueFromCardString(s) {
  if (typeof s !== 'string') return null;
  const rank = s.trim().split(/\s+/)[0].toLowerCase();
  const v = RANK_VALUE[rank];
  return typeof v === 'number' ? v : null;
}

function cardValue(explicit, cardString) {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return valueFromCardString(cardString);
}

/** スピードのルール: 差が ±1、または A(1) と K(13) の循環隣接。同値は不可。 */
function isStackableValue(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  const d = Math.abs(a - b);
  return d === 1 || d === 12;
}

function parseState(state) {
  if (typeof state === 'string') {
    try {
      return JSON.parse(state);
    } catch {
      return {};
    }
  }
  return state && typeof state === 'object' ? state : {};
}

/** state から候補ごとの合法性を自力計算する (正解フラグは state に含まれない前提) */
function computeLegality(state) {
  const parsed = parseState(state);
  const map = new Map();
  const piles = Array.isArray(parsed.piles) ? parsed.piles : [];
  const pileValueByIndex = new Map();
  for (const p of piles) {
    if (p && typeof p === 'object') {
      pileValueByIndex.set(String(p.index), cardValue(p.value, p.top));
    }
  }
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !c.key) continue;
    const handValue = cardValue(c.value, c.card);
    let pileValue = cardValue(c.pile_value, c.pile_top);
    if (pileValue == null) pileValue = pileValueByIndex.get(String(c.pile)) ?? null;
    map.set(String(c.key), isStackableValue(handValue, pileValue));
  }
  return map;
}

function round(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mockNoul(legal) {
  // 3% 程度は誤答を混ぜてリアルさを出す
  const flip = Math.random() < 0.03;
  const effective = flip ? !legal : legal;
  return effective
    ? round(0.88 + Math.random() * 0.11)
    : round(0.01 + Math.random() * 0.11);
}

function mockChoice(criteria, legalMap) {
  const keys = Object.keys(criteria && typeof criteria === 'object' && !Array.isArray(criteria) ? criteria : {});
  if (keys.length === 0) return { type: 'choice', choice: null, confidence: 0, probabilities: {} };

  // 合法手を優先。無ければ pass 相当、それも無ければ全候補から。
  const legalKeys = keys.filter((k) => legalMap.get(k) === true);
  let pool = legalKeys;
  if (pool.length === 0) {
    const passKey = keys.find((k) => /^(pass|none|skip|no_move)$/i.test(k));
    pool = passKey ? [passKey] : keys;
  }
  const picked = pool[Math.floor(Math.random() * pool.length)];

  // 選ばれた手に重みを寄せた確率分布を作る
  const weights = {};
  let total = 0;
  for (const k of keys) {
    let w = 0.02;
    if (k === picked) w = 3 + Math.random() * 2;
    else if (legalKeys.includes(k)) w = 0.3 + Math.random() * 0.5;
    weights[k] = w;
    total += w;
  }
  const probabilities = {};
  for (const k of keys) probabilities[k] = round(weights[k] / total);
  return {
    type: 'choice',
    choice: picked,
    confidence: round(Math.max(0.5, probabilities[picked])),
    probabilities,
  };
}

function mockScore(criteria, legalMap) {
  const list = Array.isArray(criteria) ? criteria : [];
  const n = list.length >= 2 ? list.length : 2;
  const legalCount = [...legalMap.values()].filter(Boolean).length;
  // 合法手が多いほど低スコア寄り (落ち着いている) になるよう軽く連動させる
  const bias = legalCount > 0 ? 0.25 : 0.75;
  const center = bias * (n - 1);
  const score = round(Math.min(n - 1, Math.max(0, center + (Math.random() - 0.5) * 0.9)), 2);

  const probabilities = {};
  const legend = {};
  let total = 0;
  const raw = [];
  for (let i = 0; i < n; i += 1) {
    legend[String(i)] = list[i] ?? `level ${i}`;
    const w = Math.exp(-((i - score) ** 2) / 0.6) + 0.01;
    raw.push(w);
    total += w;
  }
  for (let i = 0; i < n; i += 1) probabilities[String(i)] = round(raw[i] / total);
  return { type: 'score', score, confidence: round(0.7 + Math.random() * 0.28), legend, probabilities };
}

async function mockAnswer(state, questions) {
  const delay = 80 + Math.random() * 170; // 80-250ms
  await new Promise((r) => setTimeout(r, delay));

  const legalMap = computeLegality(state);
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const type = q && typeof q === 'object' ? q.type : 'noul';
    if (type === 'choice') {
      answers[key] = mockChoice(q.criteria, legalMap);
    } else if (type === 'score') {
      answers[key] = mockScore(q.criteria, legalMap);
    } else {
      answers[key] = { type: 'noul', noul: mockNoul(legalMap.get(key) === true) };
    }
  }

  const stateSize = JSON.stringify(state ?? '').length;
  return {
    model: 'jev-mock-1.0.0',
    answers,
    usage: {
      input_tokens: Math.max(1, Math.round(stateSize / 4)),
      output_tokens: Object.keys(questions).length * 12,
    },
  };
}

// ---------------------------------------------------------------- 上流呼び出し

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callUpstream(apiKey, payload) {
  let lastStatus = 0;
  let lastText = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (upstream.ok) {
        return { ok: true, status: upstream.status, data: await upstream.json() };
      }

      lastStatus = upstream.status;
      lastText = await upstream.text().catch(() => '');

      if (RETRYABLE.has(upstream.status) && attempt < MAX_RETRIES) {
        const base = RETRY_DELAYS_MS[attempt];
        await sleep(base + Math.random() * base * 0.3); // 指数バックオフ + ジッタ
        continue;
      }
      return { ok: false, status: upstream.status, error: upstreamError(upstream.status, lastText) };
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      lastStatus = timeout ? 504 : 502;
      lastText = err && err.message ? err.message : String(err);
      if (!timeout && attempt < MAX_RETRIES) {
        const base = RETRY_DELAYS_MS[attempt];
        await sleep(base + Math.random() * base * 0.3);
        continue;
      }
      return {
        ok: false,
        status: lastStatus,
        error: timeout ? 'Upstream timeout (10s)' : `Upstream request failed: ${lastText}`,
      };
    }
  }
  return { ok: false, status: lastStatus || 502, error: upstreamError(lastStatus, lastText) };
}

function upstreamError(status, text) {
  const detail = (text || '').slice(0, 500);
  if (status === 401) return 'Invalid TYPESAFE_API_KEY (401)';
  if (status === 422) return `Invalid request body (422) ${detail}`;
  if (status === 429) return 'Rate limited by upstream (429)';
  if (status === 529) return 'Upstream overloaded (529)';
  return `Upstream error ${status} ${detail}`;
}

// ---------------------------------------------------------------- リクエスト処理

/** /api/jev のボディ検証。問題があれば {status, body} を返し、正常なら null。 */
export function validateJevBody(body) {
  const questions = body && body.questions;
  const validQuestions =
    questions && typeof questions === 'object' && !Array.isArray(questions) && Object.keys(questions).length > 0;
  if (!validQuestions) {
    return { status: 400, body: { ok: false, error: 'questions is required and must be a non-empty object', status: 400 } };
  }
  if (body.state === undefined || body.state === null) {
    return { status: 400, body: { ok: false, error: 'state is required', status: 400 } };
  }
  return null;
}

/**
 * 検証済みボディから Jev の回答を得る。
 * apiKey が空、または forceMock が真ならモックで応答する (レート制限時の降格に使う)。
 * 戻り値は {status, body} で、呼び出し側が各ランタイムの流儀で書き出す。
 */
export async function answerJev({ body, apiKey, forceMock = false, degraded = false }) {
  const invalid = validateJevBody(body);
  if (invalid) return invalid;

  const started = performance.now();

  if (!apiKey || forceMock) {
    const result = await mockAnswer(body.state, body.questions);
    return {
      status: 200,
      body: {
        ok: true,
        model: result.model,
        answers: result.answers,
        usage: result.usage,
        latencyMs: Math.round(performance.now() - started),
        mock: true,
        ...(degraded ? { degraded: true } : {}),
      },
    };
  }

  const result = await callUpstream(apiKey, { state: body.state, model: MODEL, questions: body.questions });
  const latencyMs = Math.round(performance.now() - started);

  if (!result.ok) {
    return { status: result.status, body: { ok: false, error: result.error, status: result.status, latencyMs } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      model: result.data.model,
      answers: result.data.answers,
      usage: result.data.usage,
      latencyMs,
      mock: false,
    },
  };
}
