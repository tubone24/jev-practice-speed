// Workers エントリのテスト。src/worker.js は Web 標準 API しか使わないので、
// wrangler を起動しなくても Node 20+ からそのまま import して叩ける。
//
// 見張りたいのは「APIキーを使う権利が漏れないこと」:
//   - セッション無し / 偽造 / 期限切れでは /api/jev が通らない
//   - Turnstile を通らないとセッションが出ない
//   - レート制限に当たっても対戦は続く (モックへ降格)
//   - どのレスポンスにもキーが載らない

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';

const SECRET = 'test-session-secret';
const API_KEY = 'sk-test-DO-NOT-LEAK-0123456789';

const BASE_ENV = {
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  SESSION_SECRET: SECRET,
  TYPESAFE_API_KEY: '', // 既定はモックモード (上流を叩かない)
};

const STATE = {
  piles: [{ index: 0, top: '7 of clubs' }],
  candidates: [{ key: 'h0p0', card: '8 of hearts', pile: 0 }],
};
const QUESTIONS = { h0p0: { type: 'noul', instructions: 'can it stack?' } };

function jevRequest(session) {
  return new Request('https://example.com/api/jev', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify({ state: STATE, questions: QUESTIONS }),
  });
}

// worker 内部と同じ方式でトークンを組み立てる (署名検証を外から確かめるため)
const encoder = new TextEncoder();

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

async function mintSession(secret, expiresAt) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ exp: expiresAt, n: 'test' })));
  return `${payload}.${await sign(secret, payload)}`;
}

/** Turnstile の siteverify だけ差し替える。 */
function withStubbedSiteverify(success, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/turnstile/v0/siteverify')) {
      return new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`予期しない外部リクエスト: ${url}`);
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------- health

test('/api/health はキーの有無だけ伝え、キー本体は返さない', async () => {
  const res = await worker.fetch(new Request('https://example.com/api/health'), { ...BASE_ENV, TYPESAFE_API_KEY: API_KEY });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.hasKey, true);
  assert.equal(data.mock, false);
  assert.equal(data.requiresSession, true);
  // サイトキーは公開前提なので出てよい
  assert.equal(data.turnstileSiteKey, BASE_ENV.TURNSTILE_SITE_KEY);
  // 秘密情報は一切含まれない
  const body = JSON.stringify(data);
  assert.ok(!body.includes(API_KEY), 'APIキーが health に載っている');
  assert.ok(!body.includes(SECRET), 'セッション鍵が health に載っている');
  assert.ok(!body.includes(BASE_ENV.TURNSTILE_SECRET_KEY), 'Turnstile 秘密鍵が health に載っている');
});

test('Turnstile 未設定なら認証は要求されない (ローカル開発と同じ挙動)', async () => {
  const res = await worker.fetch(new Request('https://example.com/api/health'), { TYPESAFE_API_KEY: '' });
  const data = await res.json();
  assert.equal(data.requiresSession, false);
  assert.equal(data.turnstileSiteKey, '');
});

// ---------------------------------------------------------------- セッション

test('/api/jev はセッション無しでは 401 を返す', async () => {
  const res = await worker.fetch(jevRequest(null), BASE_ENV);
  const data = await res.json();
  assert.equal(res.status, 401);
  assert.equal(data.code, 'session_required');
});

test('/api/jev は署名が違うセッションを拒む', async () => {
  const forged = await mintSession('wrong-secret', Date.now() + 60_000);
  const res = await worker.fetch(jevRequest(forged), BASE_ENV);
  assert.equal(res.status, 401);
});

test('/api/jev は期限切れセッションを拒む', async () => {
  // 署名は正しいが exp が過去
  const expired = await mintSession(SECRET, Date.now() - 1000);
  const res = await worker.fetch(jevRequest(expired), BASE_ENV);
  assert.equal(res.status, 401);
});

test('/api/jev はペイロードだけ差し替えた改竄を拒む', async () => {
  const valid = await mintSession(SECRET, Date.now() + 60_000);
  const signature = valid.slice(valid.lastIndexOf('.') + 1);
  // 期限を 100 年後に伸ばした payload に、元の署名をそのまま貼る
  const tampered = toBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + 3.15e12, n: 'test' })));
  const res = await worker.fetch(jevRequest(`${tampered}.${signature}`), BASE_ENV);
  assert.equal(res.status, 401);
});

test('正しいセッションなら /api/jev が通る', async () => {
  const session = await mintSession(SECRET, Date.now() + 60_000);
  const res = await worker.fetch(jevRequest(session), BASE_ENV);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.mock, true); // キー未設定なのでモック
  assert.ok(data.answers.h0p0, '回答が返っていない');
});

// ---------------------------------------------------------------- Turnstile

test('/api/session は Turnstile を通れば使えるセッションを発行する', async () => {
  const session = await withStubbedSiteverify(true, async () => {
    const res = await worker.fetch(
      new Request('https://example.com/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'XXXX.DUMMY.TOKEN.XXXX' }),
      }),
      BASE_ENV,
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.required, true);
    assert.ok(typeof data.session === 'string' && data.session.length > 0);
    return data.session;
  });

  // 発行されたセッションが実際に /api/jev を通ること
  const res = await worker.fetch(jevRequest(session), BASE_ENV);
  assert.equal(res.status, 200);
});

test('/api/session は Turnstile に落ちたら 403 でセッションを出さない', async () => {
  await withStubbedSiteverify(false, async () => {
    const res = await worker.fetch(
      new Request('https://example.com/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'bogus' }),
      }),
      BASE_ENV,
    );
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.equal(data.ok, false);
    assert.ok(!('session' in data));
  });
});

// ---------------------------------------------------------------- レート制限

test('レート制限に当たっても 429 で突き放さずモックで対戦を続けられる', async () => {
  const session = await mintSession(SECRET, Date.now() + 60_000);
  const env = {
    ...BASE_ENV,
    TYPESAFE_API_KEY: API_KEY, // キーはあるが…
    JEV_LIMITER: { limit: async () => ({ success: false }) }, // 上限に当たっている
  };
  // 上流を叩いてしまったら失敗とわかるよう fetch を封じる
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`上流を呼んではいけない: ${url}`); };
  try {
    const res = await worker.fetch(jevRequest(session), env);
    const data = await res.json();
    assert.equal(res.status, 200, 'ゲームが続けられていない');
    assert.equal(data.ok, true);
    assert.equal(data.mock, true, '上流に流れている (課金が止まっていない)');
    assert.equal(data.degraded, true, '降格が申告されていない');
  } finally {
    globalThis.fetch = original;
  }
});

test('全体レート制限でも同じく降格する', async () => {
  const session = await mintSession(SECRET, Date.now() + 60_000);
  const env = {
    ...BASE_ENV,
    TYPESAFE_API_KEY: API_KEY,
    GLOBAL_LIMITER: { limit: async () => ({ success: false }) },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`上流を呼んではいけない: ${url}`); };
  try {
    const data = await (await worker.fetch(jevRequest(session), env)).json();
    assert.equal(data.mock, true);
    assert.equal(data.degraded, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('/api/session はレート制限を超えたら 429 を返す', async () => {
  const env = { ...BASE_ENV, SESSION_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(
    new Request('https://example.com/api/session', { method: 'POST', body: '{}' }),
    env,
  );
  assert.equal(res.status, 429);
});

// ---------------------------------------------------------------- その他

test('GET では /api/jev を呼べない', async () => {
  const res = await worker.fetch(new Request('https://example.com/api/jev'), BASE_ENV);
  assert.equal(res.status, 405);
});

test('未知の /api/* は 404', async () => {
  const res = await worker.fetch(new Request('https://example.com/api/secrets'), BASE_ENV);
  assert.equal(res.status, 404);
});

test('壊れた JSON は 400 で、上流には流れない', async () => {
  const session = await mintSession(SECRET, Date.now() + 60_000);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`上流を呼んではいけない: ${url}`); };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/jev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
        body: '{ not json',
      }),
      { ...BASE_ENV, TYPESAFE_API_KEY: API_KEY },
    );
    assert.equal(res.status, 400);
  } finally {
    globalThis.fetch = original;
  }
});

test('上流エラーの文面に APIキーが混ざらない', async () => {
  const session = await mintSession(SECRET, Date.now() + 60_000);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const res = await worker.fetch(jevRequest(session), { ...BASE_ENV, TYPESAFE_API_KEY: API_KEY });
    const text = await res.text();
    assert.equal(res.status, 401);
    assert.ok(!text.includes(API_KEY), 'エラー応答に APIキーが載っている');
  } finally {
    globalThis.fetch = original;
  }
});
