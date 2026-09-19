// 統合テスト: server.js(モックモード) + rules.js + jev-client.js + ai.js を通しで動かす。
// ブラウザ抜きで「Jev が判断し、検証器が弾き、ゲームが最後まで進む」ことを確認する。
//
// 注意: 子プロセスの TYPESAFE_API_KEY を空文字で明示的に定義することで、
//       .env に本物のキーがあっても上書きされず、必ずモックモードで動く。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as rules from '../public/js/rules.js';
import { createJevPlayer } from '../public/js/ai.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TYPESAFE_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* まだ起動していない */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not become healthy');
}

const remaining = (p) => p.hand.filter(Boolean).length + p.stock.length;

test('モックサーバー越しに Jev-CPU が1ゲームを完走する', { timeout: 180_000 }, async (t) => {
  const server = startServer();
  t.after(() => server.kill('SIGTERM'));

  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.mock, true, 'テストは必ずモックモードで走ること');
  assert.equal(health.hasKey, false);

  let state = rules.startGame(rules.createGame({ handSize: 5, seed: 20260919 }));

  const ai = createJevPlayer({ playerId: 'cpu', baseUrl: BASE });

  // 人間側は「合法手をランダムに選ぶ」単純な相手役
  const rng = rules.makeRNG(7);
  const humanMove = () => {
    const moves = rules.legalMoves(state, 'human');
    return moves.length ? moves[Math.floor(rng() * moves.length)] : null;
  };

  let illegalApplied = 0;
  let steps = 0;
  let flips = 0;

  while ((state.phase === 'playing' || state.phase === 'stuck') && steps < 600) {
    steps++;

    // 手詰まりなら先に台札をめくって再開する
    if (rules.isStuck(state)) {
      const res = rules.applyFlip(state);
      state = res.state;
      flips++;
      assert.ok(flips < 60, 'フリップが無限ループしていないこと');
      if (state.phase === 'finished') break;
    }

    // --- CPU (Jev) ---
    const before = remaining(state.players.cpu);
    const { move, telemetry } = await ai.think(state);
    if (move) {
      const card = state.players.cpu.hand[move.handIndex];
      // Jev が選んだ手は、適用前に必ず機械的に合法でなければならない
      if (!rules.isStackable(card, state.piles[move.pileIndex])) illegalApplied++;

      const res = rules.applyMove(state, 'cpu', move);
      assert.equal(res.ok, true, `CPU の手が拒否された: ${res.error}`);
      state = res.state;
      assert.equal(remaining(state.players.cpu), before - 1, 'CPU の残り枚数が1だけ減ること');
    }

    if (telemetry) {
      assert.ok(telemetry.latencyMs >= 0, 'レイテンシが計測されている');
      assert.equal(telemetry.mock, true);
      assert.ok(telemetry.candidates.length > 0);
    }

    if (state.phase === 'finished') break;

    // --- 人間役 ---
    const hm = state.phase === 'playing' ? humanMove() : null;
    if (hm) {
      const beforeH = remaining(state.players.human);
      const res = rules.applyMove(state, 'human', hm);
      assert.equal(res.ok, true, `人間の合法手が拒否された: ${res.error}`);
      state = res.state;
      assert.equal(remaining(state.players.human), beforeH - 1);
    }

  }

  assert.equal(state.phase, 'finished', `ゲームが終局すること (steps=${steps})`);
  assert.ok(['human', 'cpu', 'draw'].includes(state.winner), `勝者が決まること: ${state.winner}`);
  assert.equal(illegalApplied, 0, 'Jev が選んだ手にルール違反が1件も混ざらないこと');

  const s = ai.summary();
  assert.ok(s.decisions > 0, 'Jev への問い合わせが発生していること');
  assert.ok(s.judgements > 0);
  // モックは意図的に 3% 程度の誤答を混ぜるので、完全一致は求めない
  assert.ok(s.accuracy > 0.85, `Jev の判断と検証器の一致率が十分高いこと: ${s.accuracy}`);
  assert.ok(s.inputTokens >= 0);

  console.log(
    `  → 終局 winner=${state.winner} steps=${steps} flips=${flips} ` +
    `jev決定=${s.decisions} 判定=${s.judgements} 一致率=${(s.accuracy * 100).toFixed(1)}% ` +
    `検証器で拒否=${s.falsePositives}`,
  );
});

test('局面が変わらない間は Jev を呼ばない（API 料金の節約）', { timeout: 60_000 }, async (t) => {
  const server = startServer();
  t.after(() => server.kill('SIGTERM'));
  await waitForHealth();

  // /api/jev への実リクエスト数を数える
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    if (String(args[0]).includes('/api/jev')) calls++;
    return realFetch(...args);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const state = rules.startGame(rules.createGame({ handSize: 5, seed: 424242 }));
  const ai = createJevPlayer({ playerId: 'cpu', baseUrl: BASE });

  const first = await ai.think(state);
  assert.equal(calls, 1, '最初の問い合わせは1回だけ発生する');
  assert.ok(first.telemetry, 'テレメトリが返る');

  // 同じ局面で何度呼んでもネットワークに出ない
  for (let i = 0; i < 5; i++) {
    const again = await ai.think(state);
    assert.equal(again.skipped, true, '同一局面はスキップされる');
    assert.equal(again.move, null);
  }
  assert.equal(calls, 1, `同一局面では追加リクエストが発生しないこと (calls=${calls})`);

  // 局面が変われば再び問い合わせる
  const moves = rules.legalMoves(state, 'cpu');
  if (moves.length) {
    const res = rules.applyMove(state, 'cpu', moves[0]);
    assert.equal(res.ok, true);
    await ai.think(res.state);
    assert.equal(calls, 2, '局面が変わったら改めて問い合わせること');
  }
});

/**
 * Jev が「積める」と誤答する状況を決定的に作るため、/api/jev の応答をスタブする。
 * 指定した候補キーだけ noul=0.99、他は 0.01。best も同じ候補を高確信で選ばせる。
 */
function stubJev(t, pickKey) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/api/jev')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      if (key === 'best') {
        answers.best = {
          type: 'choice', choice: pickKey, confidence: 0.97,
          probabilities: { [pickKey]: 0.97 },
        };
      } else if (key === 'pressure') {
        answers.pressure = { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: {} };
      } else {
        answers[key] = { type: 'noul', noul: key === pickKey ? 0.99 : 0.01 };
      }
    }
    return new Response(JSON.stringify({
      ok: true, model: 'jev-stub', answers,
      usage: { input_tokens: 100, output_tokens: 0 }, latencyMs: 42, mock: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

/** 非合法な候補を1つ見つける */
function findIllegalCandidate(state) {
  const payload = rules.describeStateForJev(state, 'cpu');
  for (const c of payload.candidates) {
    const card = state.players.cpu.hand[c.hand_slot];
    if (card && !rules.isStackable(card, state.piles[c.pile])) return c;
  }
  return null;
}

test('お手付きルール OFF: Jev が誤答しても検証器が事前に弾き、違反手は出ない', async (t) => {
  const state = rules.startGame(rules.createGame({ handSize: 5, seed: 31337 }));
  const bad = findIllegalCandidate(state);
  assert.ok(bad, 'テスト用に非合法な候補が存在すること');
  stubJev(t, bad.key);

  const ai = createJevPlayer({ playerId: 'cpu', foulMode: false });
  const { move, telemetry } = await ai.think(state);

  assert.equal(telemetry.willFoul, false, 'お手付きにはならない');
  assert.ok(telemetry.rejectedByValidator >= 1, '検証器が Jev の推す違反手を弾くこと');
  if (move) {
    const card = state.players.cpu.hand[move.handIndex];
    assert.equal(rules.isStackable(card, state.piles[move.pileIndex]), true,
      'OFF のときに返る手は必ず合法であること');
  }
});

test('お手付きルール ON: Jev の誤答がそのまま場に出て、ルールエンジンが お手付き と判定する', async (t) => {
  const state = rules.startGame(rules.createGame({ handSize: 5, seed: 31337 }));
  const bad = findIllegalCandidate(state);
  assert.ok(bad);
  stubJev(t, bad.key);

  const ai = createJevPlayer({ playerId: 'cpu', foulMode: true });
  const { move, telemetry } = await ai.think(state);

  assert.ok(move, 'Jev の判断をそのまま採用すること');
  assert.equal(move.handIndex, bad.hand_slot);
  assert.equal(move.pileIndex, bad.pile);
  assert.equal(telemetry.willFoul, true, 'お手付きになると分かっていること');
  assert.match(telemetry.reason, /お手付き/);

  // 実際に場に出そうとすると、ルールエンジンが機械的に拒否する = お手付き
  const before = JSON.stringify(rules.serialize(state));
  const res = rules.applyMove(state, 'cpu', move);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ILLEGAL_STACK');
  assert.equal(JSON.stringify(rules.serialize(res.state)), before,
    'お手付きでは盤面が変わらないこと（札は台札に乗らない）');

  assert.equal(ai.summary().fouls, 1);
});

test('setFoulMode でモードを切り替えられる', async (t) => {
  const state = rules.startGame(rules.createGame({ handSize: 5, seed: 31337 }));
  const bad = findIllegalCandidate(state);
  stubJev(t, bad.key);

  const ai = createJevPlayer({ playerId: 'cpu' });
  assert.equal(ai.foulMode, false, '既定は OFF');
  ai.setFoulMode(true);
  assert.equal(ai.foulMode, true);
  const { telemetry } = await ai.think(state);
  assert.equal(telemetry.willFoul, true);
});

test('ルール違反の手はサーバーを介さずとも必ず拒否される', () => {
  const state = rules.startGame(rules.createGame({ handSize: 5, seed: 1 }));
  const snapshot = JSON.stringify(rules.serialize(state));

  // 台札と同じ値のカードを手札に仕込んで、同値スタックが弾かれることを確認
  const pile = state.piles[0];
  const twin = state.players.human.hand.find((c) => c && c.value === pile.value);
  if (twin) {
    const idx = state.players.human.hand.indexOf(twin);
    const res = rules.applyMove(state, 'human', { handIndex: idx, pileIndex: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ILLEGAL_STACK');
    assert.equal(JSON.stringify(rules.serialize(res.state)), snapshot, '失敗時に状態が変わらないこと');
  }

  const bad = rules.applyMove(state, 'human', { handIndex: 99, pileIndex: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'BAD_INDEX');
});
