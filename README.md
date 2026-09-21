# JEV SPEED

A WebGL demo where you play the card game **Speed** against a CPU whose brain is
[TypeSafe AI's Jev](https://typesafe.ai/). The whole point of the app is to **measure and show
Jev's decision speed and decision accuracy in real time**.

![demo](./docs/images/demo.gif)

```
You (26 red cards)  vs  Jev (26 black cards)
```

---

## What this demo shows

Jev is a **System One model** — it generates no text, and instead returns pre-defined typed
decisions with probabilities in a single pass. Officially 70–500ms. This app makes that
characteristic visible in the context of a game.

Every turn, the CPU takes every combination of its hand × the 2 piles (up to 10 of them) and asks

> "Can this card be stacked on this pile?"

as a **noul** (a probability between 0 and 1), **all in parallel within a single request**. It then
has Jev pick "which move should I play right now?" with a **choice**.

And crucially, **the final verdict on whether a move breaks the rules is not left to Jev** —
`public/js/rules.js` decides it mechanically. Even a move Jev called legal is always run through
`isStackable()` before it reaches the table, and rejected if it is a violation.

This double structure is what feeds the HUD:

| Panel | Contents |
|---|---|
| **JEV MOOD** | Jev's face. Each request also asks Jev a `score` question (`pressure`: "how few options do you have?", 0–3). The score is classified into 余裕 / 平常 / 苦しい / 窮地 / 手なし and shown as an expression, a one-liner and a gauge — so you can see at a glance whether Jev is comfortable or cornered in the current position |
| **JEV LATENCY** | Latest latency, sparkline, p50 / p95 / min / max |
| **JEV JUDGEMENT** | noul bar per candidate move, the move Jev picked, agreement with the mechanical check ✓/✗ |
| **RULE VALIDATOR** | Cumulative accuracy, false positive / false negative counts, how often the validator rejected a move, token usage and estimated cost |

---

## Setup

Node.js 20 or later. **Zero runtime dependencies** — running and testing locally needs no
`npm install`. (Deploying does, for wrangler alone. See [Deploying](#deploying-cloudflare-workers).)

```bash
# 1. Set your API key (see "About .env" below)
echo 'TYPESAFE_API_KEY=sk-...' > .env

# 2. Start
npm start
# → http://localhost:5173
```

The browser loads Three.js from a CDN (`cdn.jsdelivr.net`), so the first run needs network access.

### About .env

| Variable | Default | Description |
|---|---|---|
| `TYPESAFE_API_KEY` | (none) | Your TypeSafe key. Issue one at `console.typesafe.ai/settings/keys` |
| `PORT` | `5173` | Port of the dev server |

The key is **read by the server process only**. It never reaches the browser, and
`GET /api/health` only ever returns `hasKey: true/false`.

**It works without a key too**: if `TYPESAFE_API_KEY` is empty the server enters **mock mode** and
returns plausible-looking `answers` locally without calling the upstream API (with an 80–250ms
delay, and roughly 3% wrong answers mixed in). A `MOCK MODE` badge appears in the HUD, so there is
no mistaking it for the real thing.

---

## Deploying (Cloudflare Workers)

The public build runs on Cloudflare Workers. `public/` is served as static assets, and the Worker
only handles `/api/*`.

```
Browser                       Cloudflare Workers              TypeSafe AI
  three.js (jsdelivr)          static assets = public/
  session-gate.js  ──①──▶      /api/session  ──verify token──▶ challenges.cloudflare.com
  jev-client.js    ──②──▶      /api/jev      ──Bearer key────▶ api.typesafe.ai
                                 ↑ the API key exists only here
```

① Pass the human check once and receive a signed, short-lived session (2 hours)
② Every later Jev call is sent with that session attached

### What this protects

Putting the API key on the server side only gets you **half way**. Even if the key itself never
leaks, an `/api/jev` that anyone can hit leaks the *right to use* the key — and the bill grows
regardless. Hence four layers:

| Layer | Mechanism | Effect |
|---|---|---|
| Key isolation | Workers Secrets | Never in the browser, the repository, or the build output |
| Human check | Turnstile → signed session | Blocks direct calls from scripts |
| Per-IP limit | `JEV_LIMITER` 150 req/60s | One person cannot eat the whole quota |
| Global cap | `GLOBAL_LIMITER` 1200 req/60s | Puts a ceiling on the bill even under distributed access |

When a limit is hit, the request is **downgraded to a mock response** rather than turned away with
a 429. The game stays playable to the end; only the billing stops.

### Where the secrets live

| Name | Kind | Location |
|---|---|---|
| `TYPESAFE_API_KEY` | secret | Workers Secrets |
| `TURNSTILE_SECRET_KEY` | secret | Workers Secrets |
| `SESSION_SECRET` | secret | Workers Secrets (for signing sessions) |
| `TURNSTILE_SITE_KEY` | public | `vars` in `wrangler.jsonc` (a value meant to reach the browser) |

Only the site key is a public value, so it belongs in the config file. Do not confuse it with the
secret key.

### Steps

```bash
# 0. Dependencies (wrangler only. Runtime dependencies are still 0)
npm install

# 1. Create a Turnstile widget
#    dash.cloudflare.com → Turnstile → Add widget
#    Mode: Managed. Register your public domain, and note the site key and secret key

# 2. Write the site key (a public value) into vars.TURNSTILE_SITE_KEY in wrangler.jsonc

# 3. Register the secrets (entered interactively; never lands in your shell history or the repo)
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SESSION_SECRET   # paste the output of openssl rand -base64 32

# 4. Deploy
npm run deploy
```

Replacing `SESSION_SECRET` invalidates every issued session at once (i.e. everyone passes the gate
again). Rotate it whenever you suspect a leak.

### Running it locally

```bash
npm start     # node server.js  — no gate. Faster for working on the game itself
npm run dev   # wrangler dev    — reproduces the production path (Turnstile gate included)
```

`npm run dev` reads `.dev.vars`. Copy `.dev.vars.example` to create it. By default it holds
Turnstile's official test keys (the always-pass combination) and an empty `TYPESAFE_API_KEY`
(= mock mode), so you can check the gate and rate-limiting behavior **without a real key and
without spending API quota**.

### Ops notes

- **Adjusting the limits** — edit `ratelimits` in `wrangler.jsonc` and run `npm run deploy`.
  `period` only accepts `10` or `60`.
- **Logs** — `npx wrangler tail` follows production requests.
  The key is only ever touched via Secrets, so it never shows up in the logs.
- **Users who cannot pass Turnstile** — some extensions or network setups prevent the widget from
  loading, leaving them stuck at the gate. The gate shows an error in that case.
  For an internal-only distribution, dropping Turnstile for Cloudflare Access is more reliable.
- **The last line of defense for billing** — limits on the Workers side can only restrain calls
  *through this app*. Set usage limits and alerts on the TypeSafe side as well.

---

## How to play

| Input | Action |
|---|---|
| Click a card / `1`–`5` | Select a card from your hand (playable piles light up) |
| Click a pile / `←` `→` | Play the selected card onto that pile |
| `Esc` | Deselect |
| `Space` / **SPEED!** button | When neither side can play, flip one card from each stock onto the piles |

- **Rule**: you may only play a card one rank above or below the pile's top card. A and K are
  adjacent (K→A→2). The same rank cannot be played.
- **Deal**: 26 cards each = 1 pile card + 5 cards in hand + 20 in the stock.
- When neither side can play, the board freezes and a **"SPEED!"** button appears on screen.
  Pressing it flips **one card from each stock** onto the piles and resumes play
  (**if the stock is empty, a card from the hand is used instead** — per Nintendo's official rules).
  In real Speed both players call it out and flip together, so this app makes you declare before
  proceeding. Because nothing flips on its own, you can follow what actually happened.
- The first player to use up both hand and stock wins.
  Playing your last card during a deadlock flip also wins on the spot.
  It is a draw only if both players run out simultaneously.
- **Both players' hands are face up** (the Speed standard; a checkbox on the start screen can hide
  Jev's side).

### Foul rule

Trying to play an illegal card onto a pile is a **foul**. The card does not land on the pile, and
**that player alone cannot play any card for 10 seconds** (repeat fouls get heavier: 15 → 22 → up
to 30 seconds, resetting to 10 after one successful play). You choose who it applies to on the
start screen.

| Setting | Behavior |
|---|---|
| **Both** (default) | Fouls apply to you and to Jev |
| **Jev only** | Only Jev's misjudgements become fouls. Your illegal moves are simply rejected |
| **You only** | Jev never plays an illegal move (the validator filters it in advance). Only you get punished |
| **None** | Illegal moves from either side just never reach the table. No penalty |

**Applying fouls to Jev means Jev's decisions go straight onto the table.**
The rule validator's role shifts from "pre-filter" to "referee", and a wrong call from Jev comes
straight back as a 10-second lockout. Jev plays a move in 100–300ms, so a single foul costs it the
equivalent of dozens of moves.

> **On sources**: Speed has no official foul penalty.
> Neither [Nintendo](https://www.nintendo.com/jp/others/playing_cards/howtoplay/speed/index.html),
> [Wikibooks](https://ja.wikibooks.org/wiki/%E3%83%88%E3%83%A9%E3%83%B3%E3%83%97/%E3%82%B9%E3%83%94%E3%83%BC%E3%83%89),
> nor [Pagat](https://www.pagat.com/patience/spit.html) describes a penalty; Pagat only fixes the
> rule that a card once played may not be taken back.
> The lockout scheme here is an original rule, inspired by the wrong-slap penalties (losing cards /
> temporarily losing the right to slap) of the similarly real-time
> [Egyptian Ratscrew](https://en.wikipedia.org/wiki/Egyptian_Ratscrew).
> A card-stealing penalty (like the "sent card" of competitive karuta) was rejected: in a real-time
> game against Jev, one mistake would too easily cascade into an irreversible loss.

### Combos

A combo only grows **while the same player keeps playing consecutively**. A single interleaved move
from the opponent breaks it and the count restarts from 1 (a `COMBO BREAK` shows when a chain of 3
or more is broken). A foul also breaks your own combo. A deadlock flip is a fresh start, so it
breaks the combo too.

Both you and Jev have combos. Each new tier brings an elemental effect and a taunt.

| Chain | Tier | Effect |
|---|---|---|
| 2 | COMBO | Sparks, the screen edges tint slightly |
| 3 | SPLASH | **Water** — spray and ripples |
| 5 | BURNING | **Fire** — a rising pillar of flame, hitstop |
| 7 | THUNDER | **Lightning** — a strike, a vortex, slow motion |
| 10 | OVERDRIVE | 3 bolts + fire + water + a pillar of light + speed lines. The text flows in rainbow |

Jev's combos are tinted magenta, and its taunts come at you ("You can't even see it any more, can you").

### Pinch and chance

Once either side drops below **7 cards** remaining, the screen starts pulsing like a heartbeat. The
fewer cards remain, the faster the beat (0.75Hz → 2.6Hz), and the view tightens with every pulse.
Red if Jev is about to run out (pinch), teal if you are closer (chance).

Making the card faces unreadable would defeat the purpose, so this effect is applied only to the
**screen edges and the lighting**, with the cards' own glow kept minimal.

### Finish

The deciding moment is a **"BATSU-KOOON!!"**.
Time stops dead for 260ms → the screen blows out white → lightning tears it apart → the camera
pushes in → fire, water and a vortex pile on over one second → the result appears with speed lines.

Other effects include hitstop, camera shake, camera punch, particles, shockwaves, chromatic
aberration pulses, radial blur and slow motion.

### Sound effects

`public/audio/*.mp3`. Every source sample is **CC0 (public domain equivalent)**, cut and layered
with `ffmpeg` (316KB in total). The "SFX" checkbox at the bottom right toggles them, and the
setting persists in localStorage.

The finish sounds `finish-win.mp3` / `finish-lose.mp3` layer 7 sounds with staggered timing —
whoosh → heavy impact + slam + explosion → gong + thunder → closing bell — to build the
"batsu… kooon". The impact lands 0.18 seconds after playback starts.

Everything from fetching the samples to generating the files is written out in
`scripts/build-audio.sh` (requires `ffmpeg`):

```bash
bash scripts/build-audio.sh
```

| Samples | Source | License |
|---|---|---|
| 37 impacts | [37 hits/punches](https://opengameart.org/content/37-hitspunches) | CC0 |
| 100 ambient / gong / bell / paper sounds | [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | CC0 |
| 100 thunder / metal / wood sounds | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | CC0 |
| 75 breaking / falling / hit sounds | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | CC0 |
| 40 water / splash sounds | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | CC0 |
| 50 explosion / rocket sounds | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | CC0 |

CC0 requires no attribution, but the sources are kept out of respect for their authors.
Where the mp3s cannot be loaded, `sfx.js` automatically falls back to sounds synthesized with WebAudio.

---

## Architecture

```
server.js                 Local dev server. Static serving + /api/jev (a thin node:http layer)
wrangler.jsonc            Production (Cloudflare Workers) config. Assets, rate limits, public vars
src/
  worker.js         Production entry point. Handles /api/health, /api/session, /api/jev
  core/jev-core.js  Runtime-agnostic core. Mock generation, legality computation, upstream calls
                    (server.js and worker.js use the same thing = their behavior cannot drift)
public/
  _headers          Serving headers for static assets (CSP etc. Not itself served)
  index.html / css/style.css
  js/
    rules.js        Speed rule engine (pure functions, DOM-free, testable under Node)
    jev-client.js   Client for /api/jev. Retries, abort, latency statistics, session attachment
    session-gate.js The Turnstile gate. Exchanges a token for a short-lived session
    ai.js           The Jev-driven CPU. Build questions → answers → mechanical validation → pick a move
    cards-svg.js    SVG generation for all 52 cards + the back (face cards drawn with paths)
    card-texture.js SVG → THREE.Texture (caching, prefetch)
    render3d.js     Three.js table, cards, lighting and raycasting
    vfx.js          Hitstop / slow motion / particles / fire, water, lightning / heartbeat / post-processing
    sfx.js          Sound effects. Plays mp3s via WebAudio (falls back to synthesis on failure)
    mood.js         Pure classifier: Jev's `pressure` score → how comfortable / cornered Jev is
    hud.js          The Jev measurement HUD (latency, judgements, validator, fouls, and Jev's mood)
    main.js         Game loop, input, combos, tension, integration
  audio/            Sound effect mp3s (built from CC0 samples)
scripts/
  build-audio.sh    Rebuilds public/audio/*.mp3 from the source samples (requires ffmpeg)
test/
  rules.test.mjs        Rule engine unit tests (exhaustive + a 200-game fuzz)
  integration.test.mjs  End-to-end: server (mock) + Jev client + CPU
  worker.test.mjs       Production Worker: auth, rate limiting, and that the key never leaks
docs/CONTRACTS.md       The public API contract between modules
```

`docs/CONTRACTS.md` is the single source of truth for the contracts between modules. When changing
them, change that file first.

### Shape of the request sent to Jev

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
    // m1..m9 likewise
    "best":     { "type": "choice", "instructions": "Pick the single best move ...", "criteria": { "m0": "...", "pass": "..." } },
    "pressure": { "type": "score",  "instructions": "How tight is this position ...",
                  "criteria": ["Many good options", "A few options", "Only one option", "No legal move at all"] }
  }
}
```

**`state` contains nothing that amounts to the answer (no legality flags or the like).**
`rules.test.mjs` enforces this with a test.

### Tuning

Collected in `TUNING` in `public/js/ai.js`:

| Constant | Default | Meaning |
|---|---|---|
| `NOUL_THRESHOLD` | `0.5` | At or above this, Jev is taken to have judged the move legal |
| `CHOICE_CONFIDENCE_FLOOR` | `0.35` | Below this confidence, fall back from choice to the highest noul |
| `MAX_CANDIDATES` | `10` | Max candidate moves judged in one request |
| `MIN_THINK_INTERVAL_MS` | `40` | Minimum interval between think requests |

`CONFIG` in `public/js/main.js`:

| Constant | Default | Meaning |
|---|---|---|
| `FOUL_LOCKOUT_MS` | `10000` | Base foul penalty (ms) |
| `FOUL_LOCKOUT_STEP` | `1.5` | Multiplier for consecutive fouls |
| `FOUL_LOCKOUT_MAX_MS` | `30000` | Penalty ceiling (ms) |
| `CPU_EXTRA_DELAY_MS` | `0` | Extra delay inserted after Jev has thought (ms) |

If the CPU is too strong, put a thinking delay (in ms) into `CONFIG.CPU_EXTRA_DELAY_MS` in
`public/js/main.js` to lower the difficulty. The default is `0` (Jev's raw speed).

### Saving API calls

The game loop runs every frame, but **Jev is only called when the position changes**.
`ai.js` keeps a signature of "the 2 pile tops + the CPU's hand" and, if it matches the one from the
previous query, returns `{ skipped: true }` without sending a request.
This prevents the accident of polling — and paying for — a position where Jev already answered
"no legal move (pass)".
(A position whose request failed has its signature discarded, so it is retried on the next frame.)

### Debugging

Once running, `window.JEVSPEED` in the browser console exposes the game internals.

```js
JEVSPEED.state                       // The current GameState
JEVSPEED.ai.summary()                // Jev's cumulative record
JEVSPEED.vfx.burst(JEVSPEED.table.pilePosition(0), 0x5eead4, 240)
JEVSPEED.vfx.slowMotion(2000, 0.1)
JEVSPEED.newGame()
```

---

## Tests

```bash
npm test    # node --test "test/*.test.mjs"
```

- `mood.test.mjs` — the pressure → mood classifier: thresholds, clamping, monotonicity, idle when
  there is no score
- `rules.test.mjs` — all 13×13 rank pairs, the A↔K wrap, same-rank rejection, invariants (always 52
  cards), that illegal moves leave the state unchanged, a 200-game fuzz, and that no answer leaks
  into the state sent to Jev
- `integration.test.mjs` — starts the server **always in mock mode** (a real key in `.env` is
  overridden by the child process's environment), and verifies that the Jev CPU plays one game to
  completion and that not a single rule-violating move from Jev's suggestions is ever applied
- `worker.test.mjs` — the production Worker. `src/worker.js` only uses web-standard APIs, so it is
  imported directly under Node without starting wrangler. Covers: `/api/jev` rejecting a missing,
  forged, tampered or expired session; `/api/session` issuing nothing unless Turnstile passes;
  rate limits downgrading to a mock instead of returning 429 (and never reaching upstream); and
  that no response — including upstream errors — ever contains the API key

---

## Cost

Jev costs $0.042 / 1M input tokens, with output free. One move is roughly 1–2k input tokens, so
even a full game (dozens of moves) stays **under 0.01 cents**. The measured running total is shown
at the bottom right of the HUD.
