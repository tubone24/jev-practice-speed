// Turnstile ゲート。ブラウザ側で扱うのは「人間だと確認済み」を示す短命セッションだけで、
// TypeSafe の APIキーはここにも Turnstile の秘密鍵にも一切登場しない。
//
// Turnstile のトークンは使い捨て (一度 siteverify に通すと再利用できない) なので、
// ゲームのたびに何十回も投げる /api/jev では直接使わず、サーバーで署名付きセッションに
// 引き換えてもらい、以降はそれを Authorization ヘッダーに載せる。

import { setSessionToken, setSessionRefresher } from './jev-client.js';

// 動的に挿入した <script> は既定で async 扱いになり、その場合 turnstile.ready() は使えない
// (「Remove async/defer ...」と警告される)。公式の onload コールバックで準備完了を受け取る。
const CALLBACK_NAME = '__jevTurnstileReady';
const SCRIPT_URL = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${CALLBACK_NAME}`;

let readyPromise = null;
let widgetId = null;

function loadTurnstile() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    window[CALLBACK_NAME] = () => resolve(window.turnstile);

    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.async = true;
    el.defer = true;
    el.onerror = () => {
      readyPromise = null; // 次回やり直せるようにする
      reject(new Error('Turnstile の読み込みに失敗しました（ネットワークまたは拡張機能の影響）'));
    };
    document.head.appendChild(el);
  });
  return readyPromise;
}

/** ウィジェットを描き直してトークンを 1 つ受け取る。 */
async function solveChallenge(siteKey, container) {
  const turnstile = await loadTurnstile();

  return new Promise((resolve, reject) => {
    try {
      // トークンは使い捨てなので毎回作り直す。前回のウィジェットは必ず片付ける。
      if (widgetId !== null) {
        turnstile.remove(widgetId);
        widgetId = null;
      }
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token) => resolve(token),
        'error-callback': () => reject(new Error('Turnstile の検証に失敗しました')),
        'timeout-callback': () => reject(new Error('Turnstile の検証がタイムアウトしました')),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** トークンをサーバーでセッションに引き換える。 */
async function exchangeForSession(token) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) {
    throw new Error((data && data.error) || `セッションの発行に失敗しました (${res.status})`);
  }
  return data.session || '';
}

/**
 * 必要ならゲートを表示してセッションを確保する。
 * Turnstile 未設定の環境 (ローカルの `npm start` など) では何もせず素通しする。
 *
 * @param {{requiresSession:boolean, turnstileSiteKey:string}} health /api/health の結果
 * @param {{gate:HTMLElement, widget:HTMLElement, error:HTMLElement}} dom
 * @returns {Promise<{required:boolean}>}
 */
export async function ensureSession(health, dom) {
  if (!health || !health.requiresSession || !health.turnstileSiteKey) {
    setSessionToken('');
    setSessionRefresher(null);
    return { required: false };
  }

  const runGate = async () => {
    dom.gate.hidden = false;
    dom.error.hidden = true;
    try {
      const token = await solveChallenge(health.turnstileSiteKey, dom.widget);
      setSessionToken(await exchangeForSession(token));
    } finally {
      dom.gate.hidden = true;
    }
  };

  // 期限切れ (401) で呼び戻されたときも同じ流れでゲートを出し直す。
  setSessionRefresher(async () => {
    setSessionToken('');
    await runGate();
  });

  try {
    await runGate();
  } catch (err) {
    // ゲートを通れなくてもゲーム自体は遊べる (サーバー側がモックに落ちる) ので、
    // 起動を止めずに理由だけ出す。
    dom.gate.hidden = false;
    dom.error.hidden = false;
    dom.error.textContent = `${err && err.message ? err.message : err} — 再読み込みするとやり直せます`;
    throw err;
  }

  return { required: true };
}
