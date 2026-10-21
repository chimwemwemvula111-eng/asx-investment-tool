# scalp-core — S1 / S2

**SPEC v1.0.0 · FROZEN.** Three modules, no external dependencies, **59 passing tests**.
Every distinct signal prints; repeats of the same break do not.

```
src/scalp/scalp-core.js          the rule (stateless)
src/scalp/scalp-scanner.js       cadence + repeat handling (stateful)
src/scalp/scalp-format.js        Telegram message · extension card · journal row
src/scalp/scalp-core.test.js     node src/scalp/scalp-core.test.js      → 39 passed
src/scalp/scalp-scanner.test.js  node src/scalp/scalp-scanner.test.js   → 20 passed
```

---

## The isolation contract

- `scalp-core.js` **imports nothing.** Not `../core/indicators.js`, not anything.
- Nothing in the existing engine imports it. `grep -r scalp src/core/` returns nothing.
- Editing `lanes.js`, `engine.js`, `setup.js`, `strategies2.js`, `swing.js` or any other lane
  **cannot change behaviour here**, and editing this cannot change any existing lane.
- It is not wired to the live signal path. Nothing fires until you connect it.
- `package.json` and the other 21 core files are byte-identical to before this module existed.

That is what "store it so the next lanes can't tamper with it" means in practice: a sealed
directory with a one-way door.

---

## What it does

| Step | Rule |
|---|---|
| 0 | **Repeat check** — the same break (symbol + side + price) is reported once per TTL window |
| 1 | **Data gate** — newest trade bar ≤ 2 of its own bars old, else silence |
| 2 | **Reading frame** — find the last pivot high/low; did the reading candle take it? |
| 3 | **Level + side** locked. Nothing else may vote |
| 4 | **Unlock** at 60% of the reading candle (S1: 3 of 5 minutes · S2: 9 of 15) |
| 5 | **Trade frame** — first candle closing at or after unlock that forms a pattern **at the level** |
| 6 | **ACCEPT** (break held → trade with it) or **REJECT** (break failed → trade against it) |
| 7 | **Signal** — entry at the next trade candle's open. No target, no stop |

Silence now has exactly three causes, all about the market or the feed: **`no-break`**
(price stayed inside its range), **`no-pattern-in-window`** (the break happened, no trigger
confirmed), **`stale-feed`** (the data isn't live). Nothing about the system can suppress a signal.

## Cadence and repeats (`scalp-scanner.js`)

**Cadence** is candle-driven: `scanIntervalMs('S1') = 60_000`, `scanIntervalMs('S2') = 300_000`. The rule
cannot answer before a candle closes, so a faster timer finds nothing new. Ticks (a websocket) are for the
live price display, not for signals.

**Repeats** are keyed on `symbol | direction | level` — the same break reported twice is suppressed, with a
TTL of `dedupe.ttlReadingBars` (24 bars = 2h on S1, 6h on S2). A *different* level, or the opposite
direction, prints immediately. This replaced the crude time-based cooldown, which was silencing genuinely
different breaks: S1 went 53 → 133 signals/day and S2 29 → 45 purely by suppressing the right thing.

`cooldownReadingBars` remains as a blunt fallback at **0**.

---

## The eight patterns

Continuation (break held): `engulf_continuation` (engulf tier, then reclaim tier) → `momentum_bar`
→ `hold_close` → `follow_through`.
Reversal (break failed): `recovery_engulfing` → `outside_reversal` → `rejection_wick` →
`indecision_close`.

All defined on closed trade-frame candles. The candle must come within **25% of the reading
candle's range** of the level, or it is a candle in the middle of nowhere, not a trigger.

---

## Strength — four checks, not five

`A 4/4 · B 3/4 · C 2/4 · D ≤1`. **Tag by default** (`strengthMode: 'tag'`); set `'gate'` to enforce
a floor.

The first draft had five checks. Two were found to be duplicates by the fixtures:

- **`adverseWick` is exactly `1 − CLV`** on any single bar, so `adverseWick ≤ 0.25` *is* `CLV ≥ 0.75`
  under another name. Two slots measuring one thing would have weighted close-location at 2/5 of
  the grade — the same compensation-between-dimensions failure the Intention Score died of.
- **"Closed in the trade's direction"** turned out to be implied: `body ≥ 0.5` together with
  `CLV ≥ 0.65` is arithmetically impossible on a bar that closed against you.

What remains: `CLV ≥ 0.65` · `body ≥ 0.50` · `range ≥ 0.80 × median(20)` · `penetration ≥ 0.10`.
Four independent measurements. `adverseWick` is still recorded, just not scored.

---

## Signal shape

```js
{
  spec, preset, presetLabel, symbol, asset,
  candle: { reading:'5m', trade:'1m', label:'5M read → 1M confirm' },
  direction: 'BUY' | 'SELL',
  basis: 'held' | 'failed',
  mode: 'continuation' | 'reversal',
  pattern: { id, name, role, tier },
  level, levelKind,      // the swing that was taken
  kill,                  // price at which the idea is void — journal reference, not a stop
  entry: { ms, iso, hhmmss, utc, cat, line },   // open of the candle AFTER the trigger
  trigger: { ... },
  tags: { strength, volumeRatio, overshootPct, atLevelDistance, sessionHourUtc, spreadPct, geometryRatio },
  journal: { repaintInFavour: null, exitPrice: null, exitTimeMs: null, mfe: null, mae: null }
}
```

`journal` fields are **always null at fire time** — they are for you to fill in on exit.

---

## Tunables (all in `DEFAULTS`)

| Key | Default | Note |
|---|---|---|
| `swingK` | 2 | pivot definition |
| `atLevelTolRange` | 0.25 | how close the trigger must come to the level |
| `bodyMin` | 0.50 | pattern 1 |
| `momentumBody` / `momentumClosePos` | 0.80 / 0.85 | pattern 2 |
| `wickMult` / `closePosExtreme` | 2.0 / 0.33 | patterns 5 & 7 |
| `strengthMode` | `'tag'` | flip to `'gate'` after the journal speaks |
| `minGradeToPrint` | 2 | only used in gate mode |
| `requireVolume` / `volumeRatioMin` | `false` / 1.4 | tag until you decide otherwise |
| `maxBarAgeBars` | 2 | the freshness gate |
| `cooldownReadingBars` | **0** | off. Raise only if you later decide repeats are noise |

---

## Measured volume (synthetic tape — frequency only, **not edge**)

10 days × 3 symbols, random-walk 1m bars. This measures how often the machinery fires, nothing
about profitability.

| Config | per symbol/day | 3 symbols/day |
|---|---|---|
| No repeat handling at all | ~83 | 249 |
| **Repeats removed (default)** | **~44** | **133** |
| S2, no repeat handling | ~27 | 82 |
| **S2, repeats removed (default)** | **~15** | **45** |
| **Both bots, repeats removed** | — | **≈ 179 / day** |
| Old blanket 60-min cooldown (wrong tool) | ~18 | 82 across both |

**179 messages/day** across BTC/ETH/SOL on both bots — ~75% S1, ~25% S2, about one every 8 minutes.
Every *distinct* event prints; only true repeats are held back. Synthetic tape under-represents real
crypto volatility, so treat this as a floor.

Two caveats on the synthetic run: the **volume filter looked catastrophic (~2/day)** only because
synthetic volume is unrelated to synthetic price — on real tape volume spikes cluster with big
bars, so that number should be ignored. The **strength gate barely moved the count (17.1 → 17.0)**
for the same reason: random-walk bars have decent bodies. Both must be re-measured on real candles.

---

## What is deliberately NOT here

No ATR. No regime grid. No intention score. No posture. No confluence. No target. No stop.
No R multiple. No spread gate. No session gate. No DeMarker. No four-frame lanes.

## What filters a signal — the complete list

| Gate | State | Note |
|---|---|---|
| Feed freshness | **on** | data validity only — the only quality-independent veto |
| Repeat of the same break | **suppressed** | not a judgement — it's the same event |
| Cooldown | **off** | dedupe does this better |
| Strength | **tag** | graded, never blocks |
| Volume | **tag** | recorded, never blocks |
| Spread | **tag** | recorded, never blocks |
| Session | **tag** | recorded, never blocks |

## Open, and still yours to decide

1. The compression range edge as an alternative *level source* (only swing pivots are implemented).
2. Whether `atLevelTolRange` should tighten to 0.15 once real tape is available.
3. When — if ever — to switch `strengthMode` to `'gate'`.
