// Jev API クライアント (ブラウザ側)。契約 §4.4 準拠。
// サーバーの /api/jev / /api/health のみに依存し、APIキーには一切触れない。

/** Jev 呼び出し失敗を表すエラー。status は HTTP ステータス (ネットワーク失敗時は 0)。 */
export class JevError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'JevError';
    this.status = typeof status === 'number' ? status : 0;
  }
}

const RETRYABLE = new Set([429, 529]);
const RETRY_DELAYS_MS = [250, 750];
const LATENCY_WINDOW = 200;

// ---------------------------------------------------------------- セッション

// Turnstile を通すと発行される短命セッション。APIキーではなく、
// 「このブラウザは人間だと確認済み」であることだけを示す署名付きトークン。
let sessionToken = '';
let sessionRefresher = null;

/** ゲート通過後にトークンを預ける。空文字で破棄。 */
export function setSessionToken(token) {
  sessionToken = typeof token === 'string' ? token : '';
}

/** セッション期限切れ (401) のときに呼ばれる再取得関数を登録する。 */
export function setSessionRefresher(fn) {
  sessionRefresher = typeof fn === 'function' ? fn : null;
}

/** 直近 LATENCY_WINDOW 件の上流レイテンシ (ms) */
const latencies = [];

function recordLatency(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
  latencies.push(ms);
  if (latencies.length > LATENCY_WINDOW) latencies.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 直近200件のレイテンシ統計を返す。 */
export function latencyStats() {
  const n = latencies.length;
  if (n === 0) return { count: 0, last: 0, mean: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    count: n,
    last: latencies[n - 1],
    mean: Math.round((sum / n) * 100) / 100,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

/** 統計をリセット (デバッグ/計測セッション切り替え用)。 */
export function resetLatencyStats() {
  latencies.length = 0;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new JevError('Aborted', 0));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new JevError('Aborted', 0));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

async function parseJSON(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Jev に質問を投げる。
 * @param {any} state 契約 §4.2 の state オブジェクト (文字列/配列も可)
 * @param {Record<string, {type:'noul'|'choice'|'score', instructions:string, criteria?:any}>} questions
 * @param {{retries?:number, signal?:AbortSignal, baseUrl?:string}} [opts]
 * @returns {Promise<{ok:boolean, model:string, answers:object, usage:object, latencyMs:number, roundTripMs:number, mock:boolean}>}
 */
export async function askJev(state, questions, opts = {}) {
  const { retries = 2, signal, baseUrl = '' } = opts;

  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new JevError('questions must be a non-empty object', 0);
  }

  const url = `${baseUrl}/api/jev`;
  const body = JSON.stringify({ state, questions });
  const started = performance.now();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body,
        signal,
      });
    } catch (err) {
      if (signal && signal.aborted) throw new JevError('Aborted', 0);
      lastError = new JevError(`Network error: ${err && err.message ? err.message : err}`, 0);
      if (attempt < retries) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] * (1 + Math.random() * 0.3), signal);
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      const data = await parseJSON(res);
      if (!data || data.ok !== true) {
        throw new JevError((data && data.error) || 'Malformed response from /api/jev', res.status);
      }
      const roundTripMs = Math.round(performance.now() - started);
      recordLatency(typeof data.latencyMs === 'number' ? data.latencyMs : roundTripMs);
      return {
        ok: true,
        model: data.model,
        answers: data.answers || {},
        usage: data.usage || {},
        latencyMs: data.latencyMs,
        roundTripMs,
        mock: data.mock === true,
      };
    }

    const errData = await parseJSON(res);
    const message = (errData && errData.error) || `Jev request failed (${res.status})`;
    lastError = new JevError(message, res.status);

    // セッション切れは取り直して 1 度だけやり直す (対戦中に締め出さない)
    if (res.status === 401 && errData && errData.code === 'session_required' && sessionRefresher && attempt < retries) {
      try {
        await sessionRefresher();
        continue;
      } catch (err) {
        throw new JevError(`Session refresh failed: ${err && err.message ? err.message : err}`, 401);
      }
    }

    // 429 / 529 のみ指数バックオフでリトライ
    if (RETRYABLE.has(res.status) && attempt < retries) {
      const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      await sleep(base + Math.random() * base * 0.3, signal);
      continue;
    }
    throw lastError;
  }

  throw lastError || new JevError('Jev request failed', 0);
}

/**
 * サーバーの状態を取得。キーそのものは返らない。
 * @param {{baseUrl?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<{ok:boolean, hasKey:boolean, mock:boolean, model?:string}>}
 */
export async function jevHealth(opts = {}) {
  const { baseUrl = '', signal } = opts;
  let res;
  try {
    res = await fetch(`${baseUrl}/api/health`, { signal });
  } catch (err) {
    throw new JevError(`Network error: ${err && err.message ? err.message : err}`, 0);
  }
  if (!res.ok) {
    const data = await parseJSON(res);
    throw new JevError((data && data.error) || `Health check failed (${res.status})`, res.status);
  }
  const data = await parseJSON(res);
  if (!data) throw new JevError('Malformed health response', res.status);
  return {
    ok: data.ok === true,
    hasKey: data.hasKey === true,
    mock: data.mock === true,
    model: data.model,
    // 公開値。サイトキーはブラウザに出る前提のもので、秘密鍵ではない。
    turnstileSiteKey: typeof data.turnstileSiteKey === 'string' ? data.turnstileSiteKey : '',
    requiresSession: data.requiresSession === true,
  };
}
