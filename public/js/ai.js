// Jev 駆動の CPU プレイヤー。
//
// 役割分担:
//   - Jev  : 「この手札はこの台札に積めるか?」という判断そのもの(noul)と、
//            どの手を打つべきかの選択(choice)。
//   - 本体 : ルール違反かどうかの機械的検証。Jev が「積める」と言っても、
//            最終的に場に出す前に必ず rules.js で検証し、違反なら拒否する。
//
// この二重構造が、Jev の判断速度と正答率をそのまま計測できるデモの核になる。

import { askJev, JevError } from './jev-client.js';
import { describeStateForJev, isStackable, legalMoves } from './rules.js';

// ---- チューニング定数（レビューしやすいように 1 箇所に集約）-------------------
export const TUNING = {
  /** noul がこの値以上なら Jev は「積める」と判断したとみなす */
  NOUL_THRESHOLD: 0.5,
  /** choice の confidence がこの値未満なら noul 最大値での選択にフォールバック */
  CHOICE_CONFIDENCE_FLOOR: 0.35,
  /** 1 リクエストで判定する候補手の上限 */
  MAX_CANDIDATES: 10,
  /** 思考リクエストの最小間隔(ms)。連打で API を溢れさせないための下限 */
  MIN_THINK_INTERVAL_MS: 40,
  /** Jev 呼び出しのリトライ回数 */
  RETRIES: 1,
};

const RULE_TEXT =
  'In the card game Speed, a card may be stacked onto a pile only if its rank is ' +
  'exactly one step away from the rank of the pile\'s top card. ' +
  'Ace and King are adjacent (King -> Ace -> 2 wraps around). ' +
  'Two cards of the same rank can NEVER be stacked.';

/**
 * @typedef {{ key:string, handIndex:number, pileIndex:0|1, card:Card,
 *             pileTop:Card, noul:number, jevSays:boolean, truth:boolean,
 *             correct:boolean }} CandidateReport
 */

/**
 * @typedef {{
 *   latencyMs:number, roundTripMs:number, usage:object, mock:boolean,
 *   candidates:CandidateReport[], accuracy:{correct:number,total:number},
 *   choice:{key:string, confidence:number, probabilities:object}|null,
 *   chosen:{handIndex:number, pileIndex:number}|null,
 *   falsePositives:number, falseNegatives:number,
 *   rejectedByValidator:number, reason:string
 * }} Telemetry
 */

/**
 * Jev に投げる質問セットを組み立てる。
 * @param {object} payload describeStateForJev の出力
 */
function buildQuestions(payload) {
  const questions = {};
  const criteria = {};

  for (const c of payload.candidates) {
    questions[c.key] = {
      type: 'noul',
      instructions:
        `${RULE_TEXT}\n\n` +
        `Question: can the ${c.card} be legally stacked onto pile ${c.pile}, ` +
        `whose top card is currently the ${c.pile_top}?`,
      criteria: {
        true: `Yes — the two ranks are exactly one step apart (including the King/Ace wrap-around).`,
        false: `No — the ranks are the same, or they are two or more steps apart.`,
      },
    };
    criteria[c.key] = `Play the ${c.card} onto pile ${c.pile} (top card: ${c.pile_top}).`;
  }

  criteria.pass = 'Play nothing — no card in hand can legally be stacked on either pile.';

  questions.best = {
    type: 'choice',
    instructions:
      `${RULE_TEXT}\n\n` +
      'You are playing Speed against a human opponent in real time. ' +
      'Pick the single best move to play right now. Only pick a move that is legal. ' +
      'If no move is legal, pick "pass".',
    criteria,
  };

  questions.pressure = {
    type: 'score',
    instructions: 'How tight is this position for the player — how few options do they have?',
    criteria: ['Many good options', 'A few options', 'Only one option', 'No legal move at all'],
  };

  return questions;
}

/**
 * Jev を頭脳に持つプレイヤーを作る。
 * @param {object} opts
 * @param {'human'|'cpu'} [opts.playerId]
 * @param {(payload:object)=>void} [opts.onThinkStart]
 * @param {(t:Telemetry)=>void} [opts.onDecision]
 * @param {(e:Error)=>void} [opts.onError]
 */
export function createJevPlayer({
  playerId = 'cpu',
  baseUrl = '',
  foulMode = false,
  onThinkStart,
  onDecision,
  onError,
} = {}) {
  let inFlight = null;
  let lastThinkAt = 0;
  let aborter = null;
  let lastSignature = null;
  const history = [];

  /**
   * 局面の同一性を表す文字列。台札と自分の手札が変わらない限り同じ値になる。
   * 同じ局面を何度も Jev に問い合わせて API 料金を無駄にしないためのキー。
   */
  function signature(state) {
    const piles = state.piles.map((c) => (c ? c.id : '-')).join(',');
    const hand = state.players[playerId].hand.map((c) => (c ? c.id : '-')).join(',');
    return `${state.phase}|${piles}|${hand}`;
  }

  /**
   * 現在の局面について Jev に判断させ、打つ手を返す。
   * 同時に 1 リクエストしか飛ばさない(既に思考中なら同じ Promise を返す)。
   * @param {GameState} state
   * @returns {Promise<{move:{handIndex:number,pileIndex:number}|null, telemetry:Telemetry|null}>}
   */
  async function think(state) {
    if (inFlight) return inFlight;

    // 場も自分の手札も前回の問い合わせから変わっていないなら、答えは同じなので呼ばない。
    // (Jev が「出せる手なし」と答えた直後にポーリングし続けて課金するのを防ぐ)
    const sig = signature(state);
    if (sig === lastSignature) return { move: null, telemetry: null, skipped: true };

    const now = performance.now();
    const wait = Math.max(0, TUNING.MIN_THINK_INTERVAL_MS - (now - lastThinkAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastThinkAt = performance.now();

    inFlight = (async () => {
      lastSignature = sig;
      const payload = describeStateForJev(state, playerId);
      if (!payload.candidates || payload.candidates.length === 0) {
        return { move: null, telemetry: null };
      }
      payload.candidates = payload.candidates.slice(0, TUNING.MAX_CANDIDATES);

      onThinkStart?.(payload);

      aborter = new AbortController();
      let res;
      try {
        res = await askJev(payload, buildQuestions(payload), {
          retries: TUNING.RETRIES,
          signal: aborter.signal,
          baseUrl,
        });
      } catch (err) {
        const aborted = err?.name === 'AbortError' || aborter?.signal.aborted || /abort/i.test(err?.message ?? '');
        if (!aborted) onError?.(err instanceof JevError ? err : new JevError(String(err), 0));
        lastSignature = null; // 失敗した局面は再試行できるようにする
        return { move: null, telemetry: null };
      } finally {
        aborter = null;
      }

      const telemetry = evaluate(state, payload, res);
      history.push(telemetry);
      if (history.length > 200) history.shift();
      onDecision?.(telemetry);
      return { move: telemetry.chosen, telemetry };
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /**
   * Jev の回答を「機械的な正解」と突き合わせ、打つ手を決める。
   * ここが本要件の肝: Jev が積めると言った手でも、必ず isStackable で再検証してから採用する。
   */
  function evaluate(state, payload, res) {
    const answers = res.answers || {};
    const me = state.players[playerId];
    const legalSet = new Set(legalMoves(state, playerId).map((m) => `${m.handIndex}:${m.pileIndex}`));

    /** @type {CandidateReport[]} */
    const candidates = [];
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const c of payload.candidates) {
      const handIndex = c.hand_slot;
      const pileIndex = c.pile;
      const card = me.hand[handIndex];
      const pileTop = state.piles[pileIndex];
      if (!card || !pileTop) continue;

      // ---- 機械的な正解（Jev の回答は一切参照しない）----
      const truth = isStackable(card, pileTop) && legalSet.has(`${handIndex}:${pileIndex}`);

      const a = answers[c.key];
      const noul = typeof a?.noul === 'number' ? a.noul : 0;
      const jevSays = noul >= TUNING.NOUL_THRESHOLD;

      if (jevSays && !truth) falsePositives++;
      if (!jevSays && truth) falseNegatives++;

      candidates.push({
        key: c.key, handIndex, pileIndex, card, pileTop,
        noul, jevSays, truth, correct: jevSays === truth,
      });
    }

    const correct = candidates.filter((c) => c.correct).length;

    // ---- 手の決定 ----
    // 1) Jev の choice を第一候補にする（confidence が十分なら）
    // 2) だめなら noul が最大の候補
    //
    // 機械的検証(truth)の使い方は お手付きルール の有無で変わる:
    //   foulMode = false … 検証器を「事前フィルタ」として使い、違反手は出さない（安全側）
    //   foulMode = true  … Jev の判断をそのまま場に出す。検証器は「審判」として働き、
    //                      違反していたら呼び出し側が お手付き として罰する
    // どちらのモードでも検証自体は必ず行い、テレメトリに記録する。
    const choiceAns = answers.best;
    const choiceKey = choiceAns?.choice ?? null;
    const confidence = choiceAns?.confidence ?? 0;

    const byKey = new Map(candidates.map((c) => [c.key, c]));
    const ranked = candidates
      .filter((c) => c.jevSays)
      .sort((a, b) => b.noul - a.noul);

    let picked = null;
    let reason = '';
    let rejectedByValidator = 0;

    if (choiceKey && choiceKey !== 'pass' && confidence >= TUNING.CHOICE_CONFIDENCE_FLOOR) {
      const c = byKey.get(choiceKey);
      if (c && (foulMode || c.truth)) {
        picked = c;
        reason = `choice(${(confidence * 100).toFixed(0)}%)`;
      } else if (c) {
        rejectedByValidator++; // Jev の推す手がルール違反 → 検証器が弾いた
      }
    }

    if (!picked) {
      for (const c of ranked) {
        if (foulMode || c.truth) {
          picked = c;
          reason = `noul(${(c.noul * 100).toFixed(0)}%)`;
          break;
        }
        rejectedByValidator++;
      }
    }

    if (!picked) reason = ranked.length ? 'all rejected by validator' : 'pass';
    // お手付きルール ON のとき、Jev が違反手を選んでしまった
    const willFoul = !!picked && !picked.truth;
    if (willFoul) reason += ' → お手付き';

    return {
      latencyMs: res.latencyMs ?? 0,
      roundTripMs: res.roundTripMs ?? 0,
      usage: res.usage ?? {},
      mock: !!res.mock,
      candidates,
      accuracy: { correct, total: candidates.length },
      choice: choiceAns ? { key: choiceKey, confidence, probabilities: choiceAns.probabilities ?? {} } : null,
      pressure: answers.pressure?.score ?? null,
      chosen: picked ? { handIndex: picked.handIndex, pileIndex: picked.pileIndex } : null,
      chosenCard: picked?.card ?? null,
      falsePositives,
      falseNegatives,
      rejectedByValidator,
      willFoul,
      reason,
    };
  }

  /** 進行中のリクエストを中断する(ゲームリセット時など)。 */
  function cancel() {
    aborter?.abort();
    aborter = null;
  }

  /** これまでの判定の集計。 */
  function summary() {
    const total = history.reduce((s, t) => s + t.accuracy.total, 0);
    const correct = history.reduce((s, t) => s + t.accuracy.correct, 0);
    const fp = history.reduce((s, t) => s + t.falsePositives, 0);
    const fn = history.reduce((s, t) => s + t.falseNegatives, 0);
    const inTok = history.reduce((s, t) => s + (t.usage?.input_tokens || 0), 0);
    return {
      decisions: history.length,
      judgements: total,
      correct,
      accuracy: total ? correct / total : 0,
      falsePositives: fp,
      falseNegatives: fn,
      fouls: history.filter((t) => t.willFoul).length,
      inputTokens: inTok,
      // $0.042 / 1M input tokens、出力は無料
      costUsd: (inTok / 1_000_000) * 0.042,
      mock: history.at(-1)?.mock ?? false,
      foulMode,
    };
  }

  function reset() {
    cancel();
    lastSignature = null;
    history.length = 0;
  }

  /**
   * お手付きルールの ON/OFF。
   * true にすると Jev の判断をそのまま場に出すので、誤判定がお手付きになる。
   * ゲーム開始時に設定すること（進行中に変えると局面キャッシュと噛み合わない）。
   * @param {boolean} enabled
   */
  function setFoulMode(enabled) {
    foulMode = !!enabled;
    lastSignature = null;
  }

  return {
    think, cancel, reset, summary, setFoulMode,
    get busy() { return !!inFlight; },
    get foulMode() { return foulMode; },
  };
}
