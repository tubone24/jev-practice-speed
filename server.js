// JEV SPEED ローカル開発サーバー: 静的配信 + /api/jev プロキシ (依存パッケージ 0)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');

import { MAX_BODY_BYTES, MODEL, answerJev } from './src/core/jev-core.js';

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
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
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

  const result = await answerJev({ body, apiKey });
  return sendJSON(res, result.status, result.body);
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
    // ローカルでは Turnstile ゲートを張らない。本番 (Workers) との契約を揃えるため
    // フィールドだけは同じ形で返す。
    return sendJSON(res, 200, {
      ok: true,
      hasKey: !MOCK_MODE,
      mock: MOCK_MODE,
      model: MODEL,
      turnstileSiteKey: '',
      requiresSession: false,
    });
  }

  // 本番と同じ呼び出し順序をローカルでも試せるようにしておく (ゲートは常に不要と答える)。
  if (pathname === '/api/session') {
    if (req.method !== 'POST') {
      return sendJSON(res, 405, { ok: false, error: 'Method not allowed (use POST)', status: 405 });
    }
    return sendJSON(res, 200, { ok: true, required: false });
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
