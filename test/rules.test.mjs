// rules.js の単体テスト。実行: node --test test/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUITS,
  RANKS,
  RANK_VALUE,
  SUIT_COLOR,
  makeRNG,
  shuffle,
  buildColorDeck,
  isStackable,
  legalMoves,
  createGame,
  startGame,
  applyMove,
  isStuck,
  canFlip,
  applyFlip,
  describeStateForJev,
  serialize,
  hydrate,
} from '../public/js/rules.js';

const PLAYERS = ['human', 'cpu'];

/**
 * 指定色のデッキから id 指定で 台札/手札 を抜き、残りを返す。
 * @param {'red'|'black'} color
 * @param {string} pileId
 * @param {Array<string|null>} handIds
 */
function partition(color, pileId, handIds) {
  const map = new Map(buildColorDeck(color).map((c) => [c.id, c]));
  const pile = map.get(pileId);
  assert.ok(pile, `unknown pile card ${pileId}`);
  map.delete(pileId);
  const hand = handIds.map((id) => {
    if (id === null) return null;
    const card = map.get(id);
    assert.ok(card, `unknown hand card ${id}`);
    map.delete(id);
    return card;
  });
  return { pile, hand, rest: [...map.values()] };
}

/**
 * 52 枚の総数を保ったまま、任意の盤面を人工的に組み立てる。
 * 山札に入れなかった残りは buried (台札の下敷き) に回すので総数保存が壊れない。
 */
function craft({ humanPile, humanHand, humanStock, cpuPile, cpuHand, cpuStock }) {
  const h = partition('red', humanPile, humanHand);
  const c = partition('black', cpuPile, cpuHand);
  const hn = humanStock === undefined ? h.rest.length : humanStock;
  const cn = cpuStock === undefined ? c.rest.length : cpuStock;
  return {
    config: { handSize: humanHand.length, seed: 0 },
    piles: [h.pile, c.pile],
    buried: [h.rest.slice(hn), c.rest.slice(cn)],
    players: {
      human: { hand: h.hand, stock: h.rest.slice(0, hn), color: 'red' },
      cpu: { hand: c.hand, stock: c.rest.slice(0, cn), color: 'black' },
    },
    phase: 'playing',
    winner: null,
    moveCount: 0,
    startedAt: Date.now(),
    log: [],
  };
}

/** 場に存在する全カード id を集める */
function allCardIds(state) {
  const ids = [];
  for (const p of PLAYERS) {
    for (const card of state.players[p].hand) if (card) ids.push(card.id);
    for (const card of state.players[p].stock) ids.push(card.id);
  }
  for (const card of state.piles) ids.push(card.id);
  for (const stack of state.buried) for (const card of stack) ids.push(card.id);
  return ids;
}

/** カード総数 52 / 重複なし の不変条件 */
function assertConservation(state, label = '') {
  const ids = allCardIds(state);
  assert.equal(ids.length, 52, `card count must stay 52 ${label}`);
  assert.equal(new Set(ids).size, 52, `card ids must stay unique ${label}`);
}

/** 深いオブジェクトの全キーを列挙 */
function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 定数

test('constants match the contract', () => {
  assert.deepEqual(SUITS, ['spades', 'hearts', 'diamonds', 'clubs']);
  assert.equal(RANKS.length, 13);
  assert.equal(RANK_VALUE.A, 1);
  assert.equal(RANK_VALUE.K, 13);
  assert.equal(RANK_VALUE['10'], 10);
  assert.deepEqual(SUIT_COLOR, {
    spades: 'black', hearts: 'red', diamonds: 'red', clubs: 'black',
  });
});

// ---------------------------------------------------------------- isStackable

test('isStackable: exhaustive over all value pairs', () => {
  const card = (value) => ({ id: `x-${value}`, rank: RANKS[value - 1], suit: 'clubs', color: 'black', value });
  for (let a = 1; a <= 13; a++) {
    for (let b = 1; b <= 13; b++) {
      const d = Math.abs(a - b);
      const expected = d === 1 || d === 12;
      assert.equal(isStackable(card(a), card(b)), expected, `${a} on ${b}`);
    }
  }
});

test('isStackable: A-K wrap-around and equal-rank rejection', () => {
  const c = (value) => ({ id: `x-${value}`, rank: 'X', suit: 'clubs', color: 'black', value });
  assert.equal(isStackable(c(1), c(2)), true, 'A on 2');
  assert.equal(isStackable(c(2), c(1)), true, '2 on A');
  assert.equal(isStackable(c(13), c(1)), true, 'K on A');
  assert.equal(isStackable(c(1), c(13)), true, 'A on K');
  assert.equal(isStackable(c(7), c(7)), false, 'same value');
  assert.equal(isStackable(c(1), c(1)), false, 'A on A');
  assert.equal(isStackable(c(13), c(13)), false, 'K on K');
  assert.equal(isStackable(c(5), c(7)), false, 'diff 2');
  assert.equal(isStackable(c(1), c(3)), false, 'diff 2 near wrap');
  assert.equal(isStackable(c(13), c(2)), false, 'K on 2 is not adjacent');
  assert.equal(isStackable(null, c(5)), false);
  assert.equal(isStackable(c(5), null), false);
});

// ---------------------------------------------------------------- deck / rng

test('buildColorDeck: 26 unique cards per color', () => {
  for (const color of ['red', 'black']) {
    const deck = buildColorDeck(color);
    assert.equal(deck.length, 26);
    assert.equal(new Set(deck.map((c) => c.id)).size, 26, 'no duplicate ids');
    assert.ok(deck.every((c) => c.color === color));
    assert.ok(deck.every((c) => c.value === RANK_VALUE[c.rank]));
    const bySuit = {};
    for (const c of deck) bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
    if (color === 'red') assert.deepEqual(bySuit, { hearts: 13, diamonds: 13 });
    else assert.deepEqual(bySuit, { spades: 13, clubs: 13 });
  }
  assert.ok(buildColorDeck('red').some((c) => c.id === 'H-10'));
  assert.ok(buildColorDeck('black').some((c) => c.id === 'S-A'));
});

test('makeRNG is deterministic and in range; shuffle is in-place', () => {
  const a = makeRNG(1234);
  const b = makeRNG(1234);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const same = shuffle(arr, makeRNG(7));
  assert.equal(same, arr, 'shuffle returns the same array object');
  assert.deepEqual([...arr].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ---------------------------------------------------------------- createGame

test('createGame: 26 = pile(1) + hand + stock for each player', () => {
  for (const handSize of [1, 3, 5, 10, 25]) {
    const state = createGame({ handSize, seed: 99 });
    assert.equal(state.phase, 'ready');
    assert.equal(state.winner, null);
    assert.equal(state.moveCount, 0);
    assert.equal(state.startedAt, null);
    for (const p of PLAYERS) {
      const player = state.players[p];
      assert.equal(player.hand.length, handSize);
      assert.equal(player.stock.length, 25 - handSize);
      assert.equal(1 + player.hand.length + player.stock.length, 26);
      assert.ok(player.hand.every((c) => c !== null));
    }
    assert.equal(state.players.human.color, 'red');
    assert.equal(state.players.cpu.color, 'black');
    assert.equal(state.piles[0].color, 'red');
    assert.equal(state.piles[1].color, 'black');
    assertConservation(state, `handSize=${handSize}`);
  }
});

test('createGame: same seed reproduces the exact same layout', () => {
  const a = createGame({ handSize: 5, seed: 20260919 });
  const b = createGame({ handSize: 5, seed: 20260919 });
  assert.deepEqual(serialize(a), serialize(b));
  const c = createGame({ handSize: 5, seed: 20260920 });
  assert.notDeepEqual(serialize(a), serialize(c));
});

test('startGame flips the phase to playing', () => {
  const state = startGame(createGame({ seed: 5 }));
  assert.equal(state.phase, 'playing');
  assert.equal(typeof state.startedAt, 'number');
});

test('serialize / hydrate round-trip', () => {
  const state = startGame(createGame({ seed: 11 }));
  assert.deepEqual(serialize(hydrate(serialize(state))), serialize(state));
});

// ---------------------------------------------------------------- applyMove

test('applyMove: legal move replaces the pile top and refills the hand slot', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-9', 'H-J', 'H-Q', 'H-K'],
    cpuPile: 'S-8', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'],
  });
  const stockTop = state.players.human.stock[0];
  const before = state.players.human.stock.length;

  const res = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);
  assert.equal(state.piles[0].id, 'H-5', 'pile top replaced');
  assert.equal(state.buried[0].at(-1).id, 'H-4', 'old top buried');
  assert.equal(state.players.human.hand[0].id, stockTop.id, 'slot refilled from stock');
  assert.equal(state.players.human.stock.length, before - 1);
  assert.equal(state.moveCount, 1);
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].by, 'human');
  assert.equal(state.log[0].card.id, 'H-5');
  assert.equal(state.log[0].pileIndex, 0);
  assert.deepEqual(res.events.map((e) => e.type), ['play', 'refill']);
  assertConservation(state);
});

test('applyMove: A on K and K on A are accepted (wrap-around)', () => {
  const s1 = craft({
    humanPile: 'H-K', humanHand: ['H-A', 'H-5', 'H-6', 'H-7', 'H-8'],
    cpuPile: 'S-7', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-9'],
  });
  assert.equal(applyMove(s1, 'human', { handIndex: 0, pileIndex: 0 }).ok, true);
  assert.equal(s1.piles[0].id, 'H-A');

  const s2 = craft({
    humanPile: 'H-A', humanHand: ['H-K', 'H-5', 'H-6', 'H-7', 'H-8'],
    cpuPile: 'S-7', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-9'],
  });
  assert.equal(applyMove(s2, 'human', { handIndex: 0, pileIndex: 0 }).ok, true);
  assert.equal(s2.piles[0].id, 'H-K');
});

test('applyMove: real-time — either player may move at any time, first come first served', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-9', 'H-J', 'H-Q', 'H-K'],
    cpuPile: 'S-8', cpuHand: ['S-5', 'S-3', 'S-2', 'S-6', 'S-9'],
  });
  // cpu が先に pile0 を取る (手番制ではないので human の直後でも連続で動ける)
  assert.equal(applyMove(state, 'cpu', { handIndex: 0, pileIndex: 0 }).ok, true, 'cpu plays S-5 on H-4');
  assert.equal(state.piles[0].id, 'S-5');
  // 先着で台札が変わったため human の H-5 は同値になり出せない
  const late = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'ILLEGAL_STACK');
  // 連続で cpu が動くのも自由
  assert.equal(applyMove(state, 'cpu', { handIndex: 3, pileIndex: 0 }).ok, true, 'cpu plays S-6 on S-5');
  assertConservation(state);
});

test('applyMove: illegal attempts return an error code and leave the state untouched', () => {
  const fresh = createGame({ handSize: 5, seed: 3 });
  const snapshotReady = JSON.stringify(serialize(fresh));
  const notPlaying = applyMove(fresh, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(notPlaying.ok, false);
  assert.equal(notPlaying.error, 'NOT_PLAYING');
  assert.deepEqual(notPlaying.events, []);
  assert.equal(JSON.stringify(serialize(fresh)), snapshotReady);

  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-9', null, 'H-Q', 'H-K'],
    cpuPile: 'S-8', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'],
  });
  const snapshot = JSON.stringify(serialize(state));

  const cases = [
    ['ILLEGAL_STACK', 'human', { handIndex: 1, pileIndex: 0 }],
    ['EMPTY_SLOT', 'human', { handIndex: 2, pileIndex: 0 }],
    ['BAD_INDEX', 'human', { handIndex: 99, pileIndex: 0 }],
    ['BAD_INDEX', 'human', { handIndex: -1, pileIndex: 0 }],
    ['BAD_INDEX', 'human', { handIndex: 1.5, pileIndex: 0 }],
    ['BAD_INDEX', 'human', { handIndex: 0, pileIndex: 2 }],
    ['BAD_INDEX', 'human', { handIndex: 0, pileIndex: -1 }],
    ['BAD_INDEX', 'nobody', { handIndex: 0, pileIndex: 0 }],
  ];
  for (const [expected, who, move] of cases) {
    const res = applyMove(state, who, move);
    assert.equal(res.ok, false, `${expected} must fail`);
    assert.equal(res.error, expected, JSON.stringify(move));
    assert.deepEqual(res.events, []);
    assert.equal(res.state, state, 'state object is returned as-is');
    assert.equal(JSON.stringify(serialize(state)), snapshot, `state must not change on ${expected}`);
  }
  // 終局後も NOT_PLAYING
  state.phase = 'finished';
  const after = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(after.error, 'NOT_PLAYING');
});

test('applyMove: the hand slot becomes null once the stock is exhausted', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-9', null, null, null], humanStock: 0,
    cpuPile: 'S-8', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'],
  });
  const res = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(res.ok, true);
  assert.equal(state.players.human.hand[0], null, 'empty stock -> null slot');
  assert.equal(res.events[1].type, 'refill');
  assert.equal(res.events[1].card, null);
  assert.equal(state.phase, 'playing', 'still holds H-9, so not finished');
  assert.equal(state.winner, null);
  assertConservation(state);
});

test('applyMove: winning when the hand is all null and the stock is empty', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', null, null, null, null], humanStock: 0,
    cpuPile: 'S-8', cpuHand: ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'],
  });
  const res = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(res.ok, true);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'human');
  assert.ok(state.players.human.hand.every((c) => c === null));
  assert.equal(state.players.human.stock.length, 0);
  const win = res.events.find((e) => e.type === 'win');
  assert.ok(win);
  assert.equal(win.winner, 'human');
  assertConservation(state);
});

test('applyMove: cpu can win too', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-9', 'H-J', 'H-Q', 'H-K', 'H-7'],
    cpuPile: 'S-8', cpuHand: [null, null, 'S-9', null, null], cpuStock: 0,
  });
  const res = applyMove(state, 'cpu', { handIndex: 2, pileIndex: 1 });
  assert.equal(res.ok, true);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'cpu');
});

// ---------------------------------------------------------------- legalMoves

test('legalMoves enumerates hand slots x 2 piles and skips null slots', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-3', null, 'H-9', 'H-K'],
    cpuPile: 'S-4', cpuHand: ['S-7', 'S-7', 'S-7', 'S-7', 'S-7'].map((x, i) => ['S-7', 'S-J', 'S-Q', 'S-9', 'S-2'][i]),
  });
  const moves = legalMoves(state, 'human');
  // H-5 と H-3 はどちらの台札(4,4)にも置ける = 4 手
  assert.equal(moves.length, 4);
  assert.ok(moves.every((m) => m.handIndex === 0 || m.handIndex === 1));
  assert.ok(moves.every((m) => m.pileIndex === 0 || m.pileIndex === 1));
  assert.ok(!moves.some((m) => m.handIndex === 2), 'null slot excluded');
});

// ---------------------------------------------------------------- stuck / flip

/** A(1) の台札に 5..9 の手札 = 完全な手詰まり */
function stuckState(humanStock, cpuStock) {
  return craft({
    humanPile: 'H-A', humanHand: ['H-5', 'H-6', 'H-7', 'H-8', 'H-9'], humanStock,
    cpuPile: 'S-A', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'], cpuStock,
  });
}

test('isStuck / canFlip detect a deadlock', () => {
  const state = stuckState();
  assert.deepEqual(legalMoves(state, 'human'), []);
  assert.deepEqual(legalMoves(state, 'cpu'), []);
  assert.equal(isStuck(state), true);
  assert.equal(canFlip(state), true);

  const live = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-6', 'H-7', 'H-8', 'H-9'],
    cpuPile: 'S-A', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'],
  });
  assert.equal(isStuck(live), false);
  assert.equal(canFlip(live), false);

  const done = stuckState();
  done.phase = 'finished';
  assert.equal(isStuck(done), false, 'a finished game is never stuck');
  assert.equal(canFlip(done), false);
});

test('applyFlip: each player turns one stock card onto their own pile', () => {
  const state = stuckState();
  const humanNext = state.players.human.stock[0];
  const cpuNext = state.players.cpu.stock[0];
  const humanStockBefore = state.players.human.stock.length;

  const { events } = applyFlip(state);
  assert.equal(state.piles[0].id, humanNext.id);
  assert.equal(state.piles[1].id, cpuNext.id);
  assert.equal(state.buried[0].at(-1).id, 'H-A');
  assert.equal(state.buried[1].at(-1).id, 'S-A');
  assert.equal(state.players.human.stock.length, humanStockBefore - 1);
  assert.equal(state.phase, 'playing');
  const flip = events.find((e) => e.type === 'flip');
  assert.ok(flip);
  assert.equal(flip.cards.length, 2);
  assert.deepEqual(flip.cards.map((c) => c.by), ['human', 'cpu']);
  assertConservation(state, 'after flip');
});

test('applyFlip: repeated flips never break the 52-card invariant', () => {
  const state = stuckState();
  for (let i = 0; i < 5 && isStuck(state) && canFlip(state); i++) {
    applyFlip(state);
    assertConservation(state, `flip #${i}`);
  }
  assertConservation(state, 'final');
});

test('applyFlip: 山札が尽きていたら場札から1枚出してゲームを続ける（引き分けにしない）', () => {
  // 公式ルール:「手札(=山札)がなくなっていた場合は、場札の中から1枚出します」
  const state = stuckState(0, 0);
  assert.equal(isStuck(state), true);
  assert.equal(canFlip(state), true, '山札が0でも場札が残っていればフリップできる');

  const { events } = applyFlip(state);
  const flip = events.find((e) => e.type === 'flip');
  assert.ok(flip, 'flip イベントが出ること');
  assert.deepEqual(flip.cards.map((c) => c.from), ['hand', 'hand'], '場札から出したこと');

  // 台札は各自の場札の先頭 (H-5 / S-5) に置き換わり、手札から1枚ずつ減る
  assert.equal(state.piles[0].id, 'H-5');
  assert.equal(state.piles[1].id, 'S-5');
  assert.equal(state.players.human.hand.filter(Boolean).length, 4);
  assert.equal(state.players.cpu.hand.filter(Boolean).length, 4);

  // 台札が 5/5 になったので 4 か 6 が置ける → ゲーム続行
  assert.equal(state.phase, 'playing');
  assert.equal(state.winner, null);
  assert.ok(!events.some((e) => e.type === 'draw'), '引き分けで終わらせないこと');
  assertConservation(state);
});

test('applyFlip: 最後の1枚をフリップで出し切ったプレイヤーが勝つ', () => {
  // human は場札1枚のみ、cpu は場札2枚。どちらも山札0で手詰まり。
  const state = craft({
    humanPile: 'H-A', humanHand: ['H-5'], humanStock: 0,
    cpuPile: 'S-A', cpuHand: ['S-8', 'S-Q'], cpuStock: 0,
  });
  assert.equal(isStuck(state), true);

  const { events } = applyFlip(state);
  assert.equal(state.players.human.hand.filter(Boolean).length, 0);
  assert.equal(state.players.human.stock.length, 0);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'human');
  assert.ok(events.some((e) => e.type === 'win' && e.winner === 'human'));
  assertConservation(state);
});

test('applyFlip: 双方が同時に出し切ったときだけ引き分け', () => {
  const state = craft({
    humanPile: 'H-A', humanHand: ['H-5'], humanStock: 0,
    cpuPile: 'S-A', cpuHand: ['S-8'], cpuStock: 0,
  });
  assert.equal(isStuck(state), true);
  const { events } = applyFlip(state);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'draw');
  assert.ok(events.some((e) => e.type === 'draw'));
  assertConservation(state);
});

test('applyFlip: no-op when the board is not stuck', () => {
  const state = craft({
    humanPile: 'H-4', humanHand: ['H-5', 'H-6', 'H-7', 'H-8', 'H-9'],
    cpuPile: 'S-A', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'],
  });
  const snapshot = JSON.stringify(serialize(state));
  const { events } = applyFlip(state);
  assert.deepEqual(events, []);
  assert.equal(JSON.stringify(serialize(state)), snapshot);
});

test('applyMove marks the phase as stuck when no one can move afterwards', () => {
  // human が H-A を出した瞬間、両台札が A になり 5..9 しか無い手札は手詰まり
  const state = craft({
    humanPile: 'H-2', humanHand: ['H-A', 'H-5', 'H-6', 'H-7', 'H-8'], humanStock: 0,
    cpuPile: 'S-A', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'], cpuStock: 0,
  });
  const res = applyMove(state, 'human', { handIndex: 0, pileIndex: 0 });
  assert.equal(res.ok, true);
  assert.equal(state.players.human.hand[0], null);
  assert.equal(state.phase, 'stuck');
  assert.equal(isStuck(state), true);
  // 山札は両者 0 だが場札が残っているのでフリップできる
  assert.equal(canFlip(state), true);
  applyFlip(state);
  assert.equal(state.phase, 'playing', '場札からのフリップでゲームが再開すること');
  assert.equal(state.winner, null);
});

// ---------------------------------------------------------------- describeStateForJev

test('describeStateForJev matches the contract shape', () => {
  const state = craft({
    humanPile: 'H-7', humanHand: ['H-8', null, 'H-Q', 'H-2', 'H-K'],
    cpuPile: 'S-Q', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'],
  });
  const view = describeStateForJev(state, 'human');

  assert.deepEqual(Object.keys(view).sort(), ['candidates', 'game', 'hand', 'piles', 'rule']);
  assert.equal(view.game, 'Speed (Japanese card game)');
  assert.match(view.rule, /one higher or one lower/);
  assert.deepEqual(view.piles, [
    { index: 0, top: '7 of hearts', value: 7 },
    { index: 1, top: 'Q of spades', value: 12 },
  ]);
  // null スロットは除外され、slot 番号は元の位置を保持する
  assert.deepEqual(view.hand, [
    { slot: 0, card: '8 of hearts', value: 8 },
    { slot: 2, card: 'Q of hearts', value: 12 },
    { slot: 3, card: '2 of hearts', value: 2 },
    { slot: 4, card: 'K of hearts', value: 13 },
  ]);
  // 手札(非null) 4 枚 x 台札 2 = 8 候補、key は m0..m7 の連番
  assert.equal(view.candidates.length, 8);
  assert.deepEqual(view.candidates.map((c) => c.key), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  assert.deepEqual(view.candidates[0], {
    key: 'm0', hand_slot: 0, card: '8 of hearts', pile: 0, pile_top: '7 of hearts',
  });
  assert.deepEqual(view.candidates[1], {
    key: 'm1', hand_slot: 0, card: '8 of hearts', pile: 1, pile_top: 'Q of spades',
  });
  for (const c of view.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['card', 'hand_slot', 'key', 'pile', 'pile_top']);
  }
  // 視点を変えれば cpu の手札が出る
  const cpuView = describeStateForJev(state, 'cpu');
  assert.equal(cpuView.hand.length, 5);
  assert.equal(cpuView.candidates.length, 10);
});

test('describeStateForJev leaks no answer: no legal/answer/correct keys', () => {
  const state = startGame(createGame({ handSize: 5, seed: 77 }));
  for (const playerId of PLAYERS) {
    const view = describeStateForJev(state, playerId);
    const keys = collectKeys(view);
    for (const key of keys) {
      assert.ok(!/legal|answer|correct/i.test(key), `forbidden key found: ${key}`);
    }
    // JSON 化しても真偽フラグの塊が紛れ込んでいないこと
    assert.equal(JSON.stringify(view).includes('true'), false);
    assert.equal(JSON.stringify(view).includes('false'), false);
  }
});

test('describeStateForJev tolerates a fully empty hand', () => {
  const state = craft({
    humanPile: 'H-7', humanHand: [null, null, null, null, null], humanStock: 0,
    cpuPile: 'S-Q', cpuHand: ['S-5', 'S-6', 'S-7', 'S-8', 'S-9'],
  });
  const view = describeStateForJev(state, 'human');
  assert.deepEqual(view.hand, []);
  assert.deepEqual(view.candidates, []);
});

// ---------------------------------------------------------------- fuzz

test('fuzz: 200 random games always finish and keep the invariants', () => {
  const MAX_STEPS = 400;
  const outcomes = { human: 0, cpu: 0, draw: 0 };
  let totalFlips = 0;

  for (let g = 0; g < 200; g++) {
    const seed = 1000 + g;
    const state = startGame(createGame({ handSize: 5, seed }));
    const pick = makeRNG(seed ^ 0x5bf03635);
    let steps = 0;

    while (state.phase !== 'finished') {
      assert.ok(steps++ < MAX_STEPS, `game ${seed} did not terminate`);
      assertConservation(state, `seed=${seed} step=${steps}`);
      assert.ok(['playing', 'stuck'].includes(state.phase), `unexpected phase ${state.phase}`);

      const options = [];
      for (const p of PLAYERS) for (const m of legalMoves(state, p)) options.push([p, m]);

      if (options.length === 0) {
        assert.equal(isStuck(state), true, 'no options must imply isStuck');
        // フリップは山札から、山札が尽きていれば場札から出す。
        // どちらにせよ双方の持ち札が 1 枚ずつ減るので必ず進行する。
        const left = (s) => PLAYERS.reduce(
          (n, p) => n + s.players[p].stock.length + s.players[p].hand.filter(Boolean).length, 0,
        );
        const before = left(state);
        applyFlip(state);
        totalFlips++;
        assert.ok(left(state) < before, 'a flip must consume cards (guarantees progress)');
        continue;
      }

      const [who, move] = options[Math.floor(pick() * options.length)];
      const res = applyMove(state, who, move);
      assert.equal(res.ok, true, `legal move rejected: ${JSON.stringify(move)}`);
    }

    assertConservation(state, `seed=${seed} final`);
    assert.equal(state.phase, 'finished');
    assert.ok(['human', 'cpu', 'draw'].includes(state.winner), `bad winner ${state.winner}`);
    outcomes[state.winner]++;
    if (state.winner !== 'draw') {
      const w = state.players[state.winner];
      assert.equal(w.stock.length, 0);
      assert.ok(w.hand.every((c) => c === null));
    }
    // log と moveCount の整合
    assert.equal(state.log.length, state.moveCount);
  }

  assert.equal(outcomes.human + outcomes.cpu + outcomes.draw, 200);
  assert.ok(outcomes.human + outcomes.cpu > 0, 'some games must be won outright');
  assert.ok(totalFlips >= 0);
});
