# JEV SPEED

トランプの **スピード** を、CPU 側の頭脳に [TypeSafe AI の Jev](https://typesafe.ai/) を使って対戦する
WebGL デモアプリ。**Jev の判断速度と判断精度をリアルタイムに計測して見せる**ことが目的。

```
あなた (赤札 26枚)  vs  Jev (黒札 26枚)
```

---

## これは何を見せるデモか

Jev は **System One モデル** — テキストを生成せず、事前に定義した型付きの決定を
確率つきで 1 パスで返す。公称 70〜500ms。このアプリはその特性をゲームの文脈で可視化する。

毎ターン、CPU は自分の手札 × 台札 2 枚の全組み合わせ（最大 10 通り）について

> 「この札はこの台札に積めるか?」

という **noul**（0〜1 の確率）を **1 リクエストで並列に**問い合わせ、さらに
「今どの手を打つべきか」を **choice** で選ばせる。

そして **ルール違反かどうかの最終判定は Jev に任せず、`public/js/rules.js` が機械的に行う**。
Jev が「積める」と言った手でも、場に出す前に必ず `isStackable()` を通し、違反なら拒否する。

この二重構造によって HUD には次が出る:

| パネル | 内容 |
|---|---|
| **JEV LATENCY** | 直近のレイテンシ、スパークライン、p50 / p95 / min / max |
| **JEV JUDGEMENT** | 候補手ごとの noul バー、Jev が選んだ手、機械的検証との一致 ✓/✗ |
| **RULE VALIDATOR** | 累積正答率、誤検知 / 見落とし件数、検証器が拒否した回数、トークン消費と概算コスト |

---

## セットアップ

Node.js 20 以上。**依存パッケージはゼロ**（`npm install` 不要）。

```bash
# 1. API キーを設定（下記「.env について」を参照）
echo 'TYPESAFE_API_KEY=sk-...' > .env

# 2. 起動
npm start
# → http://localhost:5173
```

ブラウザ実行時に Three.js を CDN (`cdn.jsdelivr.net`) から読み込むため、初回はネットワークが必要。

### .env について

| 変数 | 既定 | 説明 |
|---|---|---|
| `TYPESAFE_API_KEY` | （なし） | TypeSafe のキー。`console.typesafe.ai/settings/keys` で発行 |
| `PORT` | `5173` | 開発サーバーのポート |

キーは **サーバープロセスだけが読む**。ブラウザには一切渡らず、
`GET /api/health` も `hasKey: true/false` しか返さない。

**キーを設定しなくても動く**: `TYPESAFE_API_KEY` が空ならサーバーは **モックモード**に入り、
上流 API を呼ばずにローカルでそれらしい `answers`（80〜250ms の遅延つき、3% ほど誤答を混入）を返す。
HUD に `MOCK MODE` バッジが出るので本番と取り違えることはない。

---

## 遊び方

| 操作 | 内容 |
|---|---|
| カードをクリック / `1`–`5` | 手札を選択（置ける台札が光る） |
| 台札をクリック / `←` `→` | 選んだ札をその台札に置く |
| `Esc` | 選択解除 |

- **ルール**: 台札の 1 つ上か 1 つ下の数字だけ置ける。A と K は隣接（K→A→2）。同じ数字は置けない。
- **配分**: 1 人 26 枚 = 台札 1 枚 + 場札 5 枚 + 山札 20 枚。
- 両者とも置けなくなったら、各自 **山札から 1 枚ずつ**台札にめくって再開。
  **山札が尽きていたら場札から 1 枚出す**（任天堂公式ルールに準拠）。
- 場札と山札を先に使い切った方の勝ち。
  手詰まりのめくりで最後の 1 枚を出し切った場合もその時点で勝ち。
  両者が同時に出し切ったときだけ引き分け。
- **場札は両者とも表向き**（スピードの標準。開始画面のチェックで Jev 側を伏せることもできる）。

### お手付きルール

置けない札を台札に出そうとすると **お手付き**。その札は台札に乗らず、
**そのプレイヤーだけ 10 秒間どの札も出せなくなる**（連続すると 15 → 22 → 最大 30 秒まで重くなり、
1 回成功すると 10 秒に戻る）。開始画面で適用対象を選べる。

| 設定 | 動き |
|---|---|
| **両方に適用**（既定） | あなたと Jev の双方がお手付きの対象 |
| **Jev のみ** | Jev の誤判定だけがお手付きになる。あなたは違反手を弾かれるだけ |
| **あなたのみ** | Jev は違反手を出さない（検証器が事前に弾く）。あなただけが罰を受ける |
| **なし** | 双方とも違反手は場に出ないだけ。罰則なし |

**Jev に適用すると、Jev の判断をそのまま場に出すようになる。**
つまりルール検証器の役割が「事前フィルタ」から「審判」に変わり、
Jev の誤判定がそのまま 10 秒のロックアウトとして跳ね返る。
Jev は 100〜300ms で 1 手を打ってくるので、1 回のお手付きは Jev の数十手ぶんに相当する。

> **出典について**: スピードにお手付きの罰則規定は公式ルールに存在しない。
> [任天堂](https://www.nintendo.com/jp/others/playing_cards/howtoplay/speed/index.html)、
> [Wikibooks](https://ja.wikibooks.org/wiki/%E3%83%88%E3%83%A9%E3%83%B3%E3%83%97/%E3%82%B9%E3%83%94%E3%83%BC%E3%83%89)、
> [Pagat](https://www.pagat.com/patience/spit.html) のいずれにも罰則の記述はなく、
> Pagat には「出したカードは撤回できない」という確定規定があるのみ。
> 本アプリのロックアウト方式は、同系のリアルタイムゲーム
> [Egyptian Ratscrew](https://en.wikipedia.org/wiki/Egyptian_Ratscrew) の
> 誤スラップ罰則（カードを失う／一時的にスラップ権を失う）を参考にした独自ルール。
> 枚数を奪う方式（競技かるたの送り札型）は、リアルタイムかつ相手が Jev だと
> 1 回のミスから不可逆の連鎖敗北になりやすいため採らなかった。

演出はヒットストップ、カメラシェイク、パーティクル、衝撃波、色収差パルス、
5 コンボごとのスローモーションなど。

---

## アーキテクチャ

```
server.js                 静的配信 + POST /api/jev プロキシ（キーを隠す層）+ モックモード
public/
  index.html / css/style.css
  js/
    rules.js        スピードのルールエンジン（純粋関数・DOM非依存・Nodeでテスト可能）
    jev-client.js   /api/jev のクライアント。リトライ、abort、レイテンシ統計
    ai.js           Jev 駆動の CPU。質問の組み立て → 回答 → 機械的検証 → 手の決定
    cards-svg.js    トランプ 52 枚 + 裏面の SVG 生成（絵札は path で作り込み）
    card-texture.js SVG → THREE.Texture（キャッシュ・先読み）
    render3d.js     Three.js のテーブル、カード、ライティング、レイキャスト
    vfx.js          ヒットストップ / スロー / パーティクル / 衝撃波 / ポストプロセス
    hud.js          Jev 計測 HUD
    main.js         ゲームループ・入力・統合
test/
  rules.test.mjs        ルールエンジン単体（網羅 + 200 ゲームのファズ）
  integration.test.mjs  サーバー(モック) + Jev クライアント + CPU の通し
docs/CONTRACTS.md       モジュール間の公開 API 契約
```

モジュール間の契約は `docs/CONTRACTS.md` が唯一の正。変更するときはまずそこを直す。

### Jev に投げるリクエストの形

```jsonc
POST /api/jev
{
  "state": {
    "game": "Speed (Japanese card game)",
    "rule": "A card may be stacked on a pile only if ...",
    "piles": [{ "index": 0, "top": "7 of hearts", "value": 7 }, ...],
    "hand":  [{ "slot": 0, "card": "8 of clubs", "value": 8 }, ...],
    "candidates": [{ "key": "m0", "hand_slot": 0, "card": "8 of clubs", "pile": 0, "pile_top": "7 of hearts" }, ...]
  },
  "questions": {
    "m0": { "type": "noul",   "instructions": "... can the 8 of clubs be legally stacked onto pile 0 ...",
            "criteria": { "true": "...", "false": "..." } },
    // m1..m9 も同様
    "best":     { "type": "choice", "instructions": "Pick the single best move ...", "criteria": { "m0": "...", "pass": "..." } },
    "pressure": { "type": "score",  "instructions": "How tight is this position ...",
                  "criteria": ["Many good options", "A few options", "Only one option", "No legal move at all"] }
  }
}
```

**`state` には答えに相当する情報（合法フラグ等）を一切含めない。**
`rules.test.mjs` がこれをテストで強制している。

### チューニング

`public/js/ai.js` の `TUNING` に集約:

| 定数 | 既定 | 意味 |
|---|---|---|
| `NOUL_THRESHOLD` | `0.5` | これ以上なら Jev は「積める」と判断したとみなす |
| `CHOICE_CONFIDENCE_FLOOR` | `0.35` | choice をこの確信度未満なら noul 最大値にフォールバック |
| `MAX_CANDIDATES` | `10` | 1 リクエストで判定する候補手の上限 |
| `MIN_THINK_INTERVAL_MS` | `40` | 思考リクエストの最小間隔 |

`public/js/main.js` の `CONFIG`:

| 定数 | 既定 | 意味 |
|---|---|---|
| `FOUL_LOCKOUT_MS` | `10000` | お手付きの基本ペナルティ(ms) |
| `FOUL_LOCKOUT_STEP` | `1.5` | 連続お手付きの倍率 |
| `FOUL_LOCKOUT_MAX_MS` | `30000` | ペナルティの上限(ms) |
| `CPU_EXTRA_DELAY_MS` | `0` | Jev の思考後に挟む追加ディレイ(ms) |

CPU が強すぎる場合は `public/js/main.js` の `CONFIG.CPU_EXTRA_DELAY_MS` に
思考ディレイ（ms）を入れると難易度を下げられる。既定は `0`（Jev の素の速度）。

### API 呼び出しの節約

ゲームループは毎フレーム回るが、**Jev は局面が変わったときにしか呼ばれない**。
`ai.js` が「台札 2 枚 + CPU の手札」のシグネチャを保持し、前回問い合わせたときと
同じならリクエストを飛ばさずに `{ skipped: true }` を返す。
Jev が「出せる手なし（pass）」と答えた局面をポーリングし続けて課金する、という事故を防いでいる。
（リクエストが失敗した局面はシグネチャを破棄するので、次のフレームで再試行される）

### デバッグ

起動後、ブラウザのコンソールから `window.JEVSPEED` でゲーム内部に触れる。

```js
JEVSPEED.state                       // 現在の GameState
JEVSPEED.ai.summary()                // Jev の累計成績
JEVSPEED.vfx.burst(JEVSPEED.table.pilePosition(0), 0x5eead4, 240)
JEVSPEED.vfx.slowMotion(2000, 0.1)
JEVSPEED.newGame()
```

---

## テスト

```bash
npm test    # node --test "test/*.test.mjs"
```

- `rules.test.mjs` — 13×13 の全ランクペア、A↔K 循環、同値拒否、不変条件（常に 52 枚）、
  非合法手で state が変化しないこと、200 ゲームのファズ、Jev への state に答えが漏れないこと
- `integration.test.mjs` — サーバーを**必ずモックモードで**起動し（`.env` に本物のキーがあっても
  子プロセスの環境変数で上書きされる）、Jev-CPU が 1 ゲーム完走すること、
  Jev の提案にルール違反が 1 件も適用されないことを検証

---

## コスト

Jev は入力 $0.042 / 1M トークン、出力は無料。1 手あたりの入力はおよそ 1〜2k トークンなので、
1 ゲーム（数十手）でも **0.01 セント未満**。HUD 右下に実測の累計を表示している。
