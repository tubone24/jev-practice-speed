// Cloudflare Workers エントリ。静的アセットは assets バインディングが先に処理するので、
// ここが受け持つのは /api/* だけ。
//
// APIキーの扱い:
//   TYPESAFE_API_KEY は Secrets にだけ存在し、レスポンスにもログにも一切出さない。
//   ブラウザは /api/jev を叩くだけで、上流 (api.typesafe.ai) には直接届かない。
//
// キーが漏れなくても「キーを使う権利」は漏れるため、多層で守る:
//   1. Turnstile  — 人間であることを一度だけ確認し、短命セッションに引き換える
//   2. セッション  — HMAC 署名付き。改竄も期限切れも検出する
//   3. レート制限  — IP 単位 + 全体。超過時はエラーではなくモック応答へ降格する

import { MAX_BODY_BYTES, MODEL, answerJev } from './core/jev-core.js';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2時間
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const encoder = new TextEncoder();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------------------------------------------------------------- セッション署名

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padding = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  return atob(text.replace(/-/g, '+').replace(/_/g, '/') + padding);
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toBase64Url(new Uint8Array(signature));
}

/** 長さが一致する文字列同士を定数時間で比較する。 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueSession(secret) {
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, n: crypto.randomUUID() })),
  );
  return `${payload}.${await hmacSign(secret, payload)}`;
}

async function verifySession(secret, token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const expected = await hmacSign(secret, payload);
  if (!timingSafeEqual(token.slice(dot + 1), expected)) return false;
  try {
    const data = JSON.parse(fromBase64Url(payload));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch {
    return false;
  }
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// ---------------------------------------------------------------- Turnstile

async function verifyTurnstile(secret, token, ip) {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing-input-response' };

  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);

  let res;
  try {
    res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `siteverify-unreachable (${err && err.name})` };
  }
  if (!res.ok) return { ok: false, reason: `siteverify-http-${res.status}` };

  const data = await res.json().catch(() => null);
  if (data && data.success === true) return { ok: true };
  const codes = data && Array.isArray(data['error-codes']) ? data['error-codes'].join(',') : 'unknown';
  return { ok: false, reason: codes };
}

// ---------------------------------------------------------------- レート制限

/**
 * レート制限バインディングを引く。バインディング未設定 (ローカルの wrangler dev など) は素通し。
 * 制限器自体が落ちたときはゲームを止めないよう素通しする — 上限の最後の砦は
 * wrangler.jsonc の limits.cpu_ms と TypeSafe 側のクォータ設定に任せる。
 */
async function withinLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- 設定の見立て

/** Turnstile とセッション署名が揃っているときだけ認証を要求する (未設定なら開発モード扱い)。 */
function sessionRequired(env) {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.SESSION_SECRET);
}

// ---------------------------------------------------------------- 各ハンドラ

function handleHealth(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { ok: false, error: 'Method not allowed', status: 405 });
  }
  const hasKey = Boolean((env.TYPESAFE_API_KEY || '').trim());
  return json(200, {
    ok: true,
    hasKey,
    mock: !hasKey,
    model: MODEL,
    // 公開してよい値のみ。サイトキーはブラウザに出す前提のもので、秘密鍵とは別物。
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    requiresSession: sessionRequired(env),
  });
}

async function handleSession(request, env, ip) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed (use POST)', status: 405 });
  }
  if (!(await withinLimit(env.SESSION_LIMITER, ip))) {
    return json(429, { ok: false, error: 'Too many session requests', status: 429 });
  }
  if (!sessionRequired(env)) {
    // Turnstile 未設定の環境ではゲートそのものが無い。
    return json(200, { ok: true, required: false });
  }

  const body = await request.json().catch(() => null);
  const result = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body && body.token, ip);
  if (!result.ok) {
    return json(403, { ok: false, error: `Turnstile verification failed (${result.reason})`, status: 403 });
  }

  return json(200, {
    ok: true,
    required: true,
    session: await issueSession(env.SESSION_SECRET),
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  });
}

async function handleJev(request, env, ip) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed (use POST)', status: 405 });
  }

  if (sessionRequired(env) && !(await verifySession(env.SESSION_SECRET, bearerToken(request)))) {
    // code を見てフロントが Turnstile ゲートを出し直す。
    return json(401, { ok: false, error: 'Session required or expired', status: 401, code: 'session_required' });
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'Request body too large (max 1MB)', status: 413 });
  }

  const raw = await request.text();
  if (encoder.encode(raw).length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'Request body too large (max 1MB)', status: 413 });
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body', status: 400 });
  }

  // 上限に当たったら 429 で突き放さずモックに降格する。
  // 対戦は最後まで遊べて、課金だけが止まる。
  const allowed =
    (await withinLimit(env.GLOBAL_LIMITER, 'all')) && (await withinLimit(env.JEV_LIMITER, ip));

  const result = await answerJev({
    body,
    apiKey: (env.TYPESAFE_API_KEY || '').trim(),
    forceMock: !allowed,
    degraded: !allowed,
  });
  return json(result.status, result.body);
}

// ---------------------------------------------------------------- エントリ

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    try {
      if (pathname === '/api/health') return handleHealth(request, env);
      if (pathname === '/api/session') return await handleSession(request, env, ip);
      if (pathname === '/api/jev') return await handleJev(request, env, ip);
      if (pathname.startsWith('/api/')) {
        return json(404, { ok: false, error: 'Unknown API endpoint', status: 404 });
      }
    } catch (err) {
      // 例外メッセージに上流の詳細が混ざりうるので、外に出すのは一般化した文言だけ。
      console.error('worker error', pathname, err && err.stack);
      return json(500, { ok: false, error: 'Internal error', status: 500 });
    }

    // assets バインディングが先に当たるので通常ここには来ない (not_found_handling の保険)。
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  },
};
