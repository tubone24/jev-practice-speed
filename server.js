// JEV SPEED ローカル開発サーバー: 静的配信 + /api/jev プロキシ (依存パッケージ 0)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const UPSTREAM_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [250, 750];
const RETRYABLE = new Set([429, 529]);
const RATE_LIMIT_PER_SEC = 20;

// ---------------------------------------------------------------- .env パース

/** `KEY=VALUE` 形式を自前パース。# コメント / 前後空白 / 引用符に対応。値はログに出さない。 */
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #'); // 引用符なしの場合のみ行末コメントを落とす
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const file = path.resolve(__dirname, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0; // .env が無いのは正常
  }
  const parsed = parseEnvFile(text);
  let applied = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied += 1;
    }
  }
  return applied; // 件数のみ。値は絶対にログしない
}

// ---------------------------------------------------------------- 静的配信

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** URL パスを public 配下の実パスへ解決。範囲外なら null (パストラバーサル防止)。 */
function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  let rel = decoded.replace(/\\/g, '/');
  if (rel === '/' || rel === '') rel = '/index.html';
  // 正規化してから public 配下であることを必ず検証する
  const normalized = path.posix.normalize(rel);
  if (normalized.split('/').includes('..')) return null;
  const full = path.resolve(PUBLIC_DIR, '.' + normalized);
  const rootWithSep = PUBLIC_DIR + path.sep;
  if (full !== PUBLIC_DIR && !full.startsWith(rootWithSep)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  const full = resolveStaticPath(urlPath);
  if (!full) return sendText(res, 403, 'Forbidden');

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not Found');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res).on('error', () => res.destroy());
  });
}

// ---------------------------------------------------------------- レート制限

let windowStart = 0;
let windowCount = 0;

function rateLimited() {
  const now = Date.now();
  if (now - windowStart >= 1000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount > RATE_LIMIT_PER_SEC;
}

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

// ---------------------------------------------------------------- /api/jev

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error('Payload too large');
        e.code = 'TOO_LARGE';
        req.destroy();
        reject(e);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleJev(req, res, apiKey) {
  if (rateLimited()) {
    return sendJSON(res, 429, { ok: false, error: 'Too many requests (local rate limit)', status: 429 });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) {
    return sendJSON(res, 413, { ok: false, error: 'Request body too large (max 1MB)', status: 413 });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err && err.code === 'TOO_LARGE') {
      return sendJSON(res, 413, { ok: false, error: 'Request body too large (max 1MB)', status: 413 });
    }
    return sendJSON(res, 400, { ok: false, error: 'Failed to read request body', status: 400 });
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'Invalid JSON body', status: 400 });
  }

  const questions = body && body.questions;
  const validQuestions =
    questions && typeof questions === 'object' && !Array.isArray(questions) && Object.keys(questions).length > 0;
  if (!validQuestions) {
    return sendJSON(res, 400, { ok: false, error: 'questions is required and must be a non-empty object', status: 400 });
  }
  if (body.state === undefined || body.state === null) {
    return sendJSON(res, 400, { ok: false, error: 'state is required', status: 400 });
  }

  const started = performance.now();

  if (!apiKey) {
    const result = await mockAnswer(body.state, questions);
    return sendJSON(res, 200, {
      ok: true,
      model: result.model,
      answers: result.answers,
      usage: result.usage,
      latencyMs: Math.round(performance.now() - started),
      mock: true,
    });
  }

  const result = await callUpstream(apiKey, { state: body.state, model: MODEL, questions });
  const latencyMs = Math.round(performance.now() - started);

  if (!result.ok) {
    return sendJSON(res, result.status, { ok: false, error: result.error, status: result.status, latencyMs });
  }
  return sendJSON(res, 200, {
    ok: true,
    model: result.data.model,
    answers: result.data.answers,
    usage: result.data.usage,
    latencyMs,
    mock: false,
  });
}

// ---------------------------------------------------------------- サーバー

const appliedEnvCount = loadEnv();
const API_KEY = (process.env.TYPESAFE_API_KEY || '').trim();
const MOCK_MODE = API_KEY === '';
const PORT = Number(process.env.PORT || 5173);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { ok: false, error: 'Method not allowed', status: 405 });
    }
    return sendJSON(res, 200, { ok: true, hasKey: !MOCK_MODE, mock: MOCK_MODE, model: MODEL });
  }

  if (pathname === '/api/jev') {
    if (req.method !== 'POST') {
      return sendJSON(res, 405, { ok: false, error: 'Method not allowed (use POST)', status: 405 });
    }
    return handleJev(req, res, API_KEY).catch((err) => {
      sendJSON(res, 500, { ok: false, error: `Internal error: ${err && err.message}`, status: 500 });
    });
  }

  if (pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { ok: false, error: 'Unknown API endpoint', status: 404 });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const line = '─'.repeat(52);
  console.log(line);
  console.log('  JEV SPEED dev server');
  console.log(`  URL       : http://localhost:${PORT}`);
  console.log(`  static    : ${PUBLIC_DIR}`);
  console.log(`  .env      : ${appliedEnvCount} variable(s) loaded`);
  if (MOCK_MODE) {
    console.log('  Jev mode  : MOCK  (TYPESAFE_API_KEY is not set)');
    console.log('              → set it in .env to call the real API');
  } else {
    console.log(`  Jev mode  : LIVE  (TYPESAFE_API_KEY detected, model=${MODEL})`);
  }
  console.log(line);
});
