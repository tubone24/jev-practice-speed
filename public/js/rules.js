/**
 * スピード(Speed) のルールエンジン。
 * 純粋な ES Module。DOM / three / fetch に一切依存しないので、
 * ブラウザからも Node からもそのまま import できる。
 *
 * リアルタイム同時プレイ前提: ターンの概念は持たず、applyMove は
 * どちらのプレイヤーからでも随時呼ばれ、先着順で台札が更新される。
 */

/** @typedef {'spades'|'hearts'|'diamonds'|'clubs'} Suit */
/** @typedef {'A'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'} Rank */
/** @typedef {'red'|'black'} CardColor */
/** @typedef {{ id:string, rank:Rank, suit:Suit, color:CardColor, value:number }} Card */
/** @typedef {'human'|'cpu'} PlayerId */
/** @typedef {{ handIndex:number, pileIndex:0|1 }} Move */
/** @typedef {{ hand: Array<Card|null>, stock: Card[], color: CardColor }} PlayerState */
/** @typedef {'ready'|'playing'|'stuck'|'finished'} Phase */
/** @typedef {{ type:'play'|'refill'|'flip'|'win'|'draw' } & Record<string, any>} GameEvent */
/** @typedef {{ ok:boolean, error?:string, state:GameState, events:GameEvent[] }} MoveResult */
/**
 * @typedef {{
 *   config: { handSize:number, seed:number },
 *   piles: [Card, Card],
 *   buried: [Card[], Card[]],
 *   players: { human: PlayerState, cpu: PlayerState },
 *   phase: Phase,
 *   winner: PlayerId|'draw'|null,
 *   moveCount: number,
 *   startedAt: number|null,
 *   log: Array<{t:number, by:PlayerId, card:Card, pileIndex:number}>
 * }} GameState
 */

/** @type {Suit[]} */
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

/** @type {Rank[]} */
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** @type {Record<Rank, number>} A=1 .. K=13 */
export const RANK_VALUE = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};

/** @type {Record<Suit, CardColor>} */
export const SUIT_COLOR = {
  spades: 'black',
  hearts: 'red',
  diamonds: 'red',
  clubs: 'black',
};

/** カード id の接頭辞 (例: 'S-A', 'H-10') @type {Record<Suit, string>} */
const SUIT_CODE = { spades: 'S', hearts: 'H', diamonds: 'D', clubs: 'C' };

/** プレイヤー id の並び @type {PlayerId[]} */
const PLAYER_IDS = /** @type {PlayerId[]} */ (['human', 'cpu']);

/** 各プレイヤーに割り当てる色 @type {Record<PlayerId, CardColor>} */
const PLAYER_COLOR = { human: 'red', cpu: 'black' };

/**
 * 決定論的 PRNG (mulberry32)。同じ seed からは必ず同じ数列が得られる。
 * @param {number} seed 任意の整数シード
 * @returns {() => number} [0, 1) の浮動小数を返す関数
 */
export function makeRNG(seed) {
  let a = (Number(seed) >>> 0) || 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates シャッフル (in-place)。
 * @template T
 * @param {T[]} arr シャッフル対象 (破壊的に並べ替える)
 * @param {() => number} rng [0,1) を返す乱数関数
 * @returns {T[]} arr 自身
 */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * 指定色の 26 枚 (赤=ハート+ダイヤ / 黒=スペード+クラブ) を生成する。
 * @param {CardColor} color 'red' | 'black'
 * @returns {Card[]} 26 枚の新規カード配列
 */
export function buildColorDeck(color) {
  if (color !== 'red' && color !== 'black') {
    throw new TypeError(`buildColorDeck: unknown color "${color}"`);
  }
  /** @type {Card[]} */
  const deck = [];
  for (const suit of SUITS) {
    if (SUIT_COLOR[suit] !== color) continue;
    for (const rank of RANKS) {
      deck.push({
        id: `${SUIT_CODE[suit]}-${rank}`,
        rank,
        suit,
        color,
        value: RANK_VALUE[rank],
      });
    }
  }
  return deck;
}

/**
 * card を pileCard の上に重ねられるか判定する。
 * 値の差がちょうど 1、または A(1) と K(13) の組み合わせ (循環隣接) なら true。
 * 同値は不可。
 * @param {Card|null|undefined} card 出そうとしている手札
 * @param {Card|null|undefined} pileCard 台札の一番上
 * @returns {boolean}
 */
export function isStackable(card, pileCard) {
  if (!card || !pileCard) return false;
  const d = Math.abs(card.value - pileCard.value);
  return d === 1 || d === 12;
}

/**
 * 指定プレイヤーの全合法手 (手札スロット x 台札2) を列挙する。
 * 空スロット(null)は除外。phase は見ない (純粋に盤面だけで判定)。
 * @param {GameState} state
 * @param {PlayerId} playerId
 * @returns {Move[]}
 */
export function legalMoves(state, playerId) {
  const player = state.players[playerId];
  /** @type {Move[]} */
  const moves = [];
  if (!player) return moves;
  for (let handIndex = 0; handIndex < player.hand.length; handIndex++) {
    const card = player.hand[handIndex];
    if (!card) continue;
    for (let pileIndex = 0; pileIndex < 2; pileIndex++) {
      if (isStackable(card, state.piles[pileIndex])) {
        moves.push({ handIndex, pileIndex: /** @type {0|1} */ (pileIndex) });
      }
    }
  }
  return moves;
}

/**
 * 新しいゲームを生成する。
 * 1人 26 枚 = 台札1 + 手札 handSize + 山札 (25 - handSize)。
 * 同じ seed からは完全に同じ配置が再現される。
 * @param {{ handSize?:number, seed?:number }} [opts]
 * @returns {GameState} phase='ready' の初期状態
 */
export function createGame({ handSize = 5, seed = Date.now() } = {}) {
  if (!Number.isInteger(handSize) || handSize < 1 || handSize > 25) {
    throw new RangeError(`createGame: handSize must be an integer in 1..25 (got ${handSize})`);
  }
  const rng = makeRNG(seed);

  /** @type {Record<PlayerId, PlayerState>} */
  const players = /** @type {any} */ ({});
  /** @type {Card[]} */
  const pileCards = [];

  for (const playerId of PLAYER_IDS) {
    const color = PLAYER_COLOR[playerId];
    const deck = shuffle(buildColorDeck(color), rng);
    pileCards.push(/** @type {Card} */ (deck.shift()));
    players[playerId] = {
      hand: deck.splice(0, handSize),
      stock: deck,
      color,
    };
  }

  return {
    config: { handSize, seed },
    piles: /** @type {[Card, Card]} */ ([pileCards[0], pileCards[1]]),
    buried: /** @type {[Card[], Card[]]} */ ([[], []]),
    players: { human: players.human, cpu: players.cpu },
    phase: 'ready',
    winner: null,
    moveCount: 0,
    startedAt: null,
    log: [],
  };
}

/**
 * ゲームを開始する (phase='playing', startedAt を設定)。既に開始済みなら何もしない。
 * @param {GameState} state
 * @returns {GameState} 同じ state オブジェクト (in-place 更新)
 */
export function startGame(state) {
  if (state.phase === 'ready') {
    state.phase = 'playing';
    state.startedAt = Date.now();
  }
  return state;
}

/**
 * 手を適用する。リアルタイム同時プレイなので手番チェックは行わず、先着順で処理する。
 * 非合法な場合は state を一切変更せず ok:false を返す。
 * @param {GameState} state
 * @param {PlayerId} playerId
 * @param {Move} move
 * @returns {MoveResult} error: 'NOT_PLAYING'|'EMPTY_SLOT'|'ILLEGAL_STACK'|'BAD_INDEX'
 */
export function applyMove(state, playerId, move) {
  if (state.phase !== 'playing') {
    return { ok: false, error: 'NOT_PLAYING', state, events: [] };
  }
  const player = state.players[playerId];
  if (!player || !move) {
    return { ok: false, error: 'BAD_INDEX', state, events: [] };
  }
  const { handIndex, pileIndex } = move;
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
    return { ok: false, error: 'BAD_INDEX', state, events: [] };
  }
  if (pileIndex !== 0 && pileIndex !== 1) {
    return { ok: false, error: 'BAD_INDEX', state, events: [] };
  }
  const card = player.hand[handIndex];
  if (!card) {
    return { ok: false, error: 'EMPTY_SLOT', state, events: [] };
  }
  const top = state.piles[pileIndex];
  if (!isStackable(card, top)) {
    return { ok: false, error: 'ILLEGAL_STACK', state, events: [] };
  }

  // --- ここから確定。台札を差し替え、古い台札は下敷き(buried)に送る ---
  state.buried[pileIndex].push(top);
  state.piles[pileIndex] = card;

  /** @type {GameEvent[]} */
  const events = [{ type: 'play', by: playerId, card, handIndex, pileIndex, replaced: top }];

  // 山札から補充。尽きていれば null。
  const refill = player.stock.length > 0 ? /** @type {Card} */ (player.stock.shift()) : null;
  player.hand[handIndex] = refill;
  events.push({ type: 'refill', by: playerId, handIndex, card: refill, stockLeft: player.stock.length });

  state.moveCount += 1;
  state.log.push({ t: Date.now(), by: playerId, card, pileIndex });

  // 勝利判定: 手札が全て null かつ 山札 0
  if (player.stock.length === 0 && player.hand.every((c) => c === null)) {
    state.phase = 'finished';
    state.winner = playerId;
    events.push({ type: 'win', winner: playerId, moveCount: state.moveCount });
  } else if (isStuck(state)) {
    state.phase = 'stuck';
  }

  return { ok: true, state, events };
}

/**
 * 両プレイヤーとも合法手が 0 の手詰まりか判定する。
 * ゲームが進行中 ('playing' または 'stuck') のときのみ true になり得る。
 * @param {GameState} state
 * @returns {boolean}
 */
export function isStuck(state) {
  if (state.phase !== 'playing' && state.phase !== 'stuck') return false;
  return PLAYER_IDS.every((id) => legalMoves(state, id).length === 0);
}

/**
 * そのプレイヤーの総手持ち枚数 (場札 + 山札)。
 * @param {PlayerState} player
 * @returns {number}
 */
function cardsLeft(player) {
  return player.hand.reduce((n, c) => n + (c ? 1 : 0), 0) + player.stock.length;
}

/**
 * デッドロック解消のためのフリップが可能か判定する。
 *
 * 公式ルール (任天堂):
 *   「台札に重ねられるカードが2人ともない場合は、手札から1枚めくり、同じタイミングで台札に重ねる。
 *     手札がなくなっていた場合は、場札の中から1枚出す」
 * したがって山札 (= 手札) が尽きていても、場札が残っていればフリップできる。
 * 両者とも 1 枚も持っていない状態は勝利判定で先に終局しているため、通常は起こらない。
 *
 * @param {GameState} state
 * @returns {boolean}
 */
export function canFlip(state) {
  if (!isStuck(state)) return false;
  return PLAYER_IDS.every((id) => cardsLeft(state.players[id]) > 0);
}

/**
 * 手詰まりを解消する。各プレイヤーが 1 枚ずつ自分側の台札に表向きで重ねる。
 * 山札が残っていれば山札の先頭から、尽きていれば場札 (先頭の空でないスロット) から出す。
 * 手詰まりでなければ何もしない。
 *
 * このフリップで持ち札を出し切ったプレイヤーはその時点で勝ち
 * (「先に手持ちのカード = 手札と場札 がなくなったプレイヤーが勝ち」)。
 *
 * @param {GameState} state
 * @returns {{ state:GameState, events:GameEvent[] }}
 */
export function applyFlip(state) {
  /** @type {GameEvent[]} */
  const events = [];
  if (!isStuck(state)) return { state, events };

  if (!canFlip(state)) {
    // 双方とも 1 枚も持っていない、という理論上起こらない状態の保険
    state.phase = 'finished';
    state.winner = 'draw';
    events.push({ type: 'draw', reason: 'STUCK_NO_CARDS' });
    return { state, events };
  }

  /** @type {Array<{ by:PlayerId, pileIndex:number, card:Card, from:'stock'|'hand' }>} */
  const flipped = [];
  for (let i = 0; i < PLAYER_IDS.length; i++) {
    const playerId = PLAYER_IDS[i];
    const player = state.players[playerId];

    /** @type {Card} */
    let card;
    /** @type {'stock'|'hand'} */
    let from;
    if (player.stock.length > 0) {
      card = /** @type {Card} */ (player.stock.shift());
      from = 'stock';
    } else {
      // 山札が尽きているので場札から 1 枚出す
      const slot = player.hand.findIndex((c) => c !== null);
      card = /** @type {Card} */ (player.hand[slot]);
      player.hand[slot] = null;
      from = 'hand';
    }

    state.buried[i].push(state.piles[i]);
    state.piles[i] = card;
    flipped.push({ by: playerId, pileIndex: i, card, from });
  }
  events.push({ type: 'flip', cards: flipped });

  // フリップで出し切ったプレイヤーがいれば、その時点で終局
  const emptied = PLAYER_IDS.filter((id) => cardsLeft(state.players[id]) === 0);
  if (emptied.length === 2) {
    state.phase = 'finished';
    state.winner = 'draw';
    events.push({ type: 'draw', reason: 'BOTH_EMPTIED_ON_FLIP' });
  } else if (emptied.length === 1) {
    state.phase = 'finished';
    state.winner = emptied[0];
    events.push({ type: 'win', winner: emptied[0], moveCount: state.moveCount });
  } else {
    state.phase = 'playing';
  }
  return { state, events };
}

/**
 * カードを "8 of clubs" のような英語表記にする。
 * @param {Card|null|undefined} card
 * @returns {string|null}
 */
function cardName(card) {
  return card ? `${card.rank} of ${card.suit}` : null;
}

/**
 * Jev に渡す state オブジェクトを生成する (契約 §4.2)。
 * 合法手かどうか等「答えに相当する情報」は一切含めない。
 * @param {GameState} state
 * @param {PlayerId} playerId 視点となるプレイヤー
 * @returns {{
 *   game:string,
 *   rule:string,
 *   piles:Array<{index:number, top:string|null, value:number|null}>,
 *   hand:Array<{slot:number, card:string, value:number}>,
 *   candidates:Array<{key:string, hand_slot:number, card:string, pile:number, pile_top:string|null}>
 * }}
 */
export function describeStateForJev(state, playerId) {
  const player = state.players[playerId];
  const piles = state.piles.map((card, index) => ({
    index,
    top: cardName(card),
    value: card ? card.value : null,
  }));

  /** @type {Array<{slot:number, card:string, value:number}>} */
  const hand = [];
  for (let slot = 0; slot < player.hand.length; slot++) {
    const card = player.hand[slot];
    if (!card) continue;
    hand.push({ slot, card: /** @type {string} */ (cardName(card)), value: card.value });
  }

  /** @type {Array<{key:string, hand_slot:number, card:string, pile:number, pile_top:string|null}>} */
  const candidates = [];
  let n = 0;
  for (const entry of hand) {
    for (let pile = 0; pile < 2; pile++) {
      candidates.push({
        key: `m${n++}`,
        hand_slot: entry.slot,
        card: entry.card,
        pile,
        pile_top: piles[pile].top,
      });
    }
  }

  return {
    game: 'Speed (Japanese card game)',
    rule:
      "A card may be stacked on a pile only if its rank is exactly one higher or one lower than the pile's top card. " +
      'Ace(1) and King(13) are adjacent (wrap-around). Equal ranks may NOT be stacked.',
    piles,
    hand,
    candidates,
  };
}

/**
 * GameState を JSON 安全なプレーンオブジェクトに変換する (構造は同じ)。
 * @param {GameState} state
 * @returns {object}
 */
export function serialize(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * serialize() の出力から GameState を復元する。
 * @param {object} obj
 * @returns {GameState}
 */
export function hydrate(obj) {
  const src = /** @type {GameState} */ (JSON.parse(JSON.stringify(obj)));
  return {
    config: { handSize: src.config.handSize, seed: src.config.seed },
    piles: /** @type {[Card, Card]} */ ([src.piles[0], src.piles[1]]),
    buried: /** @type {[Card[], Card[]]} */ ([
      Array.isArray(src.buried && src.buried[0]) ? src.buried[0] : [],
      Array.isArray(src.buried && src.buried[1]) ? src.buried[1] : [],
    ]),
    players: {
      human: src.players.human,
      cpu: src.players.cpu,
    },
    phase: src.phase,
    winner: src.winner,
    moveCount: src.moveCount,
    startedAt: src.startedAt,
    log: src.log || [],
  };
}
