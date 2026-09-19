# JEV SPEED — モジュール間契約 (Single Source of Truth)

このファイルは全モジュールの**公開API契約**を定義する。各モジュールはこの契約だけに依存し、
他モジュールの内部実装を参照しない。契約を変更したい場合は、必ずこのファイルを先に更新する。

## 0. 全体像

ブラウザ (ES Modules, バンドラなし, importmap で three を CDN 読み込み)
```
public/index.html
public/css/style.css
public/js/
  cards-svg.js    … トランプの SVG 生成          [担当A]
  rules.js        … スピードのルールエンジン(純粋)  [担当B]
  jev-client.js   … Jev API クライアント(ブラウザ側) [担当C]
  card-texture.js … SVG -> THREE.Texture 変換      [担当D]
  render3d.js     … Three.js 3D テーブル描画        [担当D]
  vfx.js          … ヒットストップ/シェイク/粒子     [担当D]
  hud.js          … Jev計測HUD                     [統合担当]
  ai.js           … Jev駆動CPUプレイヤー            [統合担当]
  main.js         … ゲームループ/入力/統合          [統合担当]
server.js         … 静的配信 + /api/jev プロキシ     [担当C]
```

## 1. ドメインモデル (rules.js が所有)

```js
/** @typedef {'spades'|'hearts'|'diamonds'|'clubs'} Suit */
/** @typedef {'A'|'2'|..|'10'|'J'|'Q'|'K'} Rank */
/** @typedef {'red'|'black'} CardColor */
/** @typedef {{ id:string, rank:Rank, suit:Suit, color:CardColor, value:number }} Card */
// id は 'S-A' 'H-10' のような一意文字列。value は A=1 .. K=13。
/** @typedef {'human'|'cpu'} PlayerId */
/** @typedef {{ handIndex:number, pileIndex:0|1 }} Move */
```

GameState (すべてプレーンオブジェクト。ミューテーションせず新オブジェクトを返す必要はない=
in-place 更新で構わないが、`applyMove` は必ず `{ok, error, state, events}` を返す)

```js
/** @typedef {{
 *   config: { handSize:number, seed:number },
 *   piles: [Card, Card],
 *   players: { human: PlayerState, cpu: PlayerState },
 *   phase: 'ready'|'playing'|'stuck'|'finished',
 *   winner: PlayerId|'draw'|null,
 *   moveCount: number,
 *   startedAt: number|null,
 *   log: Array<{t:number, by:PlayerId, card:Card, pileIndex:number}>
 * }} GameState */
/** @typedef {{ hand: Array<Card|null>, stock: Card[], color: CardColor }} PlayerState */
// hand は常に length === config.handSize。カードが尽きた枠は null。
// stock は山札(補充元)。
```

## 2. rules.js 公開API (純粋・DOM非依存・Node で単体テスト可能)

```js
export const SUITS, RANKS, RANK_VALUE            // RANK_VALUE: {A:1,...,K:13}
export const SUIT_COLOR                          // {spades:'black', hearts:'red', ...}
export function makeRNG(seed): () => number      // 決定論的 PRNG (mulberry32)
export function shuffle(arr, rng): arr           // in-place Fisher-Yates、arr を返す
export function buildColorDeck(color): Card[]    // 赤 or 黒の 26 枚
export function isStackable(card, pileCard): boolean
   // 値の差が ±1 (循環: A(1)とK(13) は隣接)。同値は不可。
export function legalMoves(state, playerId): Move[]   // 手札 x 台札2 の全合法手
export function createGame({ handSize=5, seed=Date.now() } = {}): GameState
   // 26 = 台札1 + 手札 handSize + 山札(25-handSize)
export function startGame(state): GameState      // phase を 'playing' に、startedAt 設定
export function applyMove(state, playerId, move): { ok:boolean, error?:string, state:GameState, events:GameEvent[] }
   // 非合法なら ok:false + error コード ('NOT_PLAYING'|'EMPTY_SLOT'|'ILLEGAL_STACK'|'BAD_INDEX')
   // 合法なら台札を差し替え、手札を山札から補充(無ければ null)、log に追記、
   // 勝利条件(手札全 null かつ 山札0)を満たせば phase='finished', winner 設定
export function isStuck(state): boolean          // 両プレイヤーとも legalMoves が 0
export function canFlip(state): boolean          // isStuck かつ 両者に1枚以上(山札 or 場札)が残る
export function applyFlip(state): { state:GameState, events:GameEvent[] }
   // 手詰まり解消: 各プレイヤーが1枚ずつ自分側の台札に置く(表向き)。
   // 山札が残っていれば山札から、尽きていれば場札から出す(任天堂公式ルール)。
   // このめくりで出し切ったプレイヤーがいればその時点で勝ち。
   // 両者が同時に出し切ったときのみ winner='draw'。
export function describeStateForJev(state, playerId): object
   // Jev に渡す state オブジェクト(§4参照)を生成
export function serialize(state): object / export function hydrate(obj): GameState  // 任意
```
`GameEvent`: `{type:'play'|'refill'|'flip'|'win'|'draw', ...payload}` (VFX トリガ用)

**テスト必須**: `test/rules.test.mjs` を `node --test` で実行できる形で作成。
A-K の循環隣接、同値不可、補充、勝利判定、手詰まり/フリップ、26枚の総数保存(不変条件)を網羅。

## 3. cards-svg.js 公開API [担当A / 作成済みまたは作成中]

```js
export const SUITS, RANKS
export function cardSVG(rank, suit, opts?): string      // viewBox "0 0 500 700"
export function cardBackSVG(opts?): string              // opts.color: 'red'|'black'
export function svgToDataURL(svg): string
```

## 4. Jev 連携契約

### 4.1 サーバー `POST /api/jev`
リクエスト: `{ "state": <any JSON>, "questions": <Questions> }`
サーバーは `model:"jev-latest"` を付与し `POST https://api.typesafe.ai/v1/systemone` へ
`Authorization: Bearer $TYPESAFE_API_KEY` で転送。
レスポンス: `{ ok:true, model, answers, usage, latencyMs, mock:boolean }`
エラー: HTTP そのまま + `{ ok:false, error, status }`

`TYPESAFE_API_KEY` が無い場合は **モックモード**: ルールを知らない振りをせず、
`state` 内の `candidates[].legal` を見て確率を返す簡易スタブ + 80-250ms のランダム遅延。
(デモがキー無しでも動くようにするため。レスポンスに `mock:true` を必ず含める)

### 4.2 Jev に渡す state (describeStateForJev の出力)
```json
{
  "game": "Speed (Japanese card game)",
  "rule": "A card may be stacked on a pile only if its rank is exactly one higher or one lower than the pile's top card. Ace(1) and King(13) are adjacent (wrap-around). Equal ranks may NOT be stacked.",
  "piles": [{ "index": 0, "top": "7 of hearts", "value": 7 }, { "index": 1, "top": "Q of spades", "value": 12 }],
  "hand": [{ "slot": 0, "card": "8 of clubs", "value": 8 }, ...],
  "candidates": [{ "key": "m0", "hand_slot": 0, "card": "8 of clubs", "pile": 0, "pile_top": "7 of hearts" }, ...]
}
```
※ `candidates[].legal` は **本番では絶対に含めない**(答えを教えることになるため)。モックモード用にサーバー側で
別途 `_mockLegal` を受け取る設計にはせず、モックはサーバー側で state から自力計算する。

### 4.3 質問セット (ai.js が組み立てる。担当Cはこの形が通ることだけ担保)
`candidates` 1件につき noul を1つ、最大10件をワンリクエストで並列判定:
```js
{
  m0: { type:'noul', instructions:'Can "8 of clubs" be stacked onto pile 0 whose top card is "7 of hearts"? ...' },
  m1: { ... },
  best: { type:'choice', instructions:'Which move is the best to play right now?', criteria:{ m0:'...', m1:'...', pass:'No legal move exists' } }
}
```

### 4.4 jev-client.js (ブラウザ)
```js
export async function askJev(state, questions, opts?): Promise<JevResult>
  // JevResult: { ok, answers, usage, latencyMs, roundTripMs, mock }
  // roundTripMs は performance.now() でブラウザ側実測
export async function jevHealth(): Promise<{ ok, hasKey, mock }>
export class JevError extends Error { status }
```
- 429/529 は指数バックオフで最大2回リトライ(`opts.retries`)。
- `opts.signal` で AbortController 対応。

## 5. 3D 描画契約 [担当D]

### 5.1 card-texture.js
```js
export function getCardTexture(rank, suit): THREE.Texture   // キャッシュ付き
export function getBackTexture(color): THREE.Texture
export function preloadAll(): Promise<void>                 // 52枚+裏2枚を事前ラスタライズ
```
SVG を `new Image()` + `canvas` で 512x716 にラスタライズして `THREE.CanvasTexture` 化。

### 5.2 render3d.js
```js
export async function createTable(canvas): Promise<Table3D>
```
`Table3D` インターフェース:
```js
{
  syncState(view: ViewModel): void      // 毎フレーム呼ばれても安い(差分のみ反映)
  render(dtMs: number): void            // main.js の rAF から呼ばれる。内部で時間停止を考慮
  resize(w, h): void
  pickHandSlot(clientX, clientY): number|null   // レイキャストで人間の手札スロットを特定
  pickPile(clientX, clientY): 0|1|null
  animatePlay({ by, fromSlot, toPile, card }): void   // カードが飛ぶアニメ
  animateFlip(cards): void
  setSelected(slot: number|null): void
  highlightPiles(pileIndexes: number[]): void   // 出せる台札を光らせる
  cameraShake(magnitude: number): void
  dispose(): void
}
```
`ViewModel` (main.js が rules.js の GameState から生成して渡す):
```js
{
  piles: [{ rank, suit } | null, { rank, suit } | null],
  human: { hand: Array<{rank,suit}|null>, stockCount: number },
  cpu:   { hand: Array<{rank,suit}|null>, stockCount: number, faceDown: true },
  phase, combo: number
}
```
※ cpu の手札は裏向き表示だが、Jev の思考可視化のため `revealCpuHand:boolean` で表向きにもできること。

### 5.3 vfx.js
```js
export function createVFX(table3D): VFX
{
  hitStop(ms: number): void          // 全体の時間を止める
  timeScale(): number                // 現在の時間倍率。main.js が dt に掛ける
  update(realDtMs): void
  burst({ x, y, z }, color, count): void       // 3D パーティクル
  shockwave(pos, color): void
  slowMotion(ms, scale): void
  screenFlash(color, ms): void
  chromaticPulse(strength): void
}
```
ヒットストップ・スローモーション・画面フラッシュ・衝撃波・パーティクルは
成功時/コンボ時/勝利時に main.js から呼ばれる。

## 6. スタイル規約
- ES Modules。セミコロンあり。`const`/`let`。クラスは必要な箇所のみ。
- 外部依存は three のみ(importmap 経由の CDN)。それ以外は追加しない。
- コメントは日本語で簡潔に。過剰なコメントは避ける。
- Node は 20+ を前提。server.js は依存パッケージ 0。

---

## 7. 実装で確定した契約の補足（実装 > 上記ドラフト）

1. **`GameState.phase` に `'stuck'` を追加**。`applyMove` 成功後に両者とも合法手が無くなると
   `'stuck'` に遷移し、`applyFlip` で `'playing'` に戻る。`'stuck'` 中の `applyMove` は `NOT_PLAYING`。
   呼び出し側は `phase === 'playing' || phase === 'stuck'` を「進行中」と扱うこと。
2. **`GameState.buried: [Card[], Card[]]`**。台札の下敷きになったカードを保持する（総数保存の検証用）。
   描画側は無視してよい。
3. **色の割当**: `human = 'red'`(hearts/diamonds)、`cpu = 'black'`(spades/clubs)。
   `piles[0]` が human 側、`piles[1]` が cpu 側の台札。裏面テクスチャもこれに合わせる。
4. **`describeStateForJev().candidates[]` は 5 キー固定** `{key, hand_slot, card, pile, pile_top}`。
   ランク値は `piles[].value` / `hand[].value` にのみ載る。サーバーのモックはカード名文字列から
   ランクを逆算するフォールバックを持つ。
5. **Jev 呼び出しの節約（必須）**: `ai.js` は「台札 2 枚 + 自分の手札」のシグネチャを保持し、
   前回問い合わせた局面と同一なら **リクエストを送らずに** `{move:null, telemetry:null, skipped:true}`
   を返す。リクエストが失敗した局面はシグネチャを破棄して再試行可能にする。
6. `render3d.js` は契約 §5.2 に加えて `pilePosition(i)` / `handPosition(who, slot)` /
   `centerPosition()` と、VFX 連携用の `_registerPass(pass)` / `_scene` / `_camera` /
   `_renderer` / `_composer` を公開する（追加のみ、既存シグネチャは不変）。
7. `main.js` は `window.JEVSPEED = { table, vfx, hud, ai, rules, state, newGame }` を公開する。

8. **手詰まり(フリップ)の正式ルール**: 任天堂公式および Wikibooks に準拠する。
   - 両者とも台札に重ねられない → **各自1枚を同時に台札へ**。
   - **山札(手札)が尽きていたら場札から1枚出す**。山札が無いことは引き分けの理由にならない。
   - 「先に手持ちのカード(場札と山札)がなくなったプレイヤーが勝ち」なので、
     このめくりで出し切った場合も勝ち。両者同時に出し切ったときだけ引き分け。
   - `flip` イベントの各要素は `{by, pileIndex, card, from:'stock'|'hand'}`。
9. **お手付き(FOUL)ルール**: スピードに公式の罰則規定は無い（任天堂 / Wikibooks / Pagat のいずれにも
   記述なし。Pagat は「出したカードは撤回不可」のみ規定）。本アプリは独自ルールとして次を採る。
   - 置けない札を台札に出そうとしたら **お手付き**。その札は台札に乗らず(`applyMove` が `ILLEGAL_STACK`
     を返して state を変えない)、**そのプレイヤーだけ一定時間どの札も出せない**。
   - ペナルティは `CONFIG.FOUL_LOCKOUT_MS`(既定 10 秒) から始まり、連続お手付きで
     `FOUL_LOCKOUT_STEP`(1.5) 倍ずつ `FOUL_LOCKOUT_MAX_MS`(30 秒) まで重くなる。成功プレイ 1 回でリセット。
   - 適用対象は開始画面で選ぶ (`#foul-select`: both / cpu / human / none) → `main.js` の `foulRule`。
   - `ai.js` の `foulMode` が **検証器の使い方を切り替える**:
     - `false` … 事前フィルタ。合法な手だけを返す（違反手は出さない）
     - `true`  … Jev の判断をそのまま返す。違反していれば `telemetry.willFoul === true` で、
                 呼び出し側が `applyMove` の失敗を受けて お手付き として罰する
     どちらのモードでも `isStackable` による機械的検証は必ず実行し、テレメトリに記録する。
10. **場札は両者とも表向き**が標準（公式ルール）。`ViewModel.cpu.faceDown` の既定は `false`
    （`#reveal-toggle` は既定でチェック済み）。伏せるのはデモ用の任意設定。
