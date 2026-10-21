# Lanes spec — I1 · WATCH · LAB

**SPEC v1.0.0 — FROZEN.** Do not change thresholds or logic without a written decision.
Each module is the only place its numbers live.

---

## Isolation contract (all three modules)

1. **Zero imports.** No dependency on `../core/*`, `../scalp/*` or each other.
2. **Nothing imports them.** They are leaves. Editing `lanes.js`, `engine.js`,
   `setup.js` or `strategies2.js` cannot change their behaviour, and vice versa.
3. **No lane reads another lane's state, levels or output.** Same candles in,
   different expression out. If a cross-lane view is ever wanted, it must be a
   separate digest produced *outside* all three lanes.

---

## Forbidden everywhere

| Forbidden | Why |
|---|---|
| **ATR** | Removed by instruction. Every "is this big" question is answered against the instrument's own median range or its own percentile history. |
| **Stop / target / expiry / R-multiple** | No exit rules. The level is an invalidation reference; the exit is the reader's. |
| **Indicator gates** | No indicator may block a message. |
| **Spread / session / volume gates** | Never gates. Volume may be a tag. |
| **Strength as a gate** | Computed and printed as a TAG. `strengthMode: 'tag'` is the default; flipping it to `'gate'` is opt-in and visible. |
| **Reading another lane** | See isolation contract. |

The **only** things that can stop a message: the structure does not exist, the
price is not near the level, no confirmation arrived, you were already told
about that break, or the data is stale.

---

## I1 — intraday, `1h → 15m`

**Rule.** The reading frame yields exactly two things: a **direction** and a
**level**. The trade frame supplies the trigger — one candle that closes beyond
the level, closes in the far third of its own range, and has a body at least
half that range. Entry is the open of the next 15m candle.

**Structures (reading frame).**

| Structure | Direction | Level |
|---|---|---|
| Squeeze | *both* — decided at the trade frame | box top and box bottom |
| Ascending triangle | long | flat ceiling |
| Descending triangle | short | flat floor |
| Bull flag | long | highest **close** of the consolidation |
| Bear flag | short | lowest **close** of the consolidation |

**Flag trigger is a close, not a high.** Measured: with a high-based trigger
only **9%** of armed bull flags ever had their level crossed; with a close-based
trigger **28%** did. A high is a wick — the price point the market is least
obliged to revisit.

**Arming.** Watched within **1.20%** of the level; **imminent** within **0.30%**.
Both are journalled; neither is a message.

**Duplicate suppression.** One signal per **0.5%** level band, then locked for
50 reading bars. Measured: at 0.2% the same break fired twice on SOL at 105.13
and 105.03.

**Message — exactly seven fields.**

```
SOLUSDT · 1h → 15m · ASC TRIANGLE
ACCEPT — 15m closed above 106.22
Direction  LONG
Level      106.22
Entry      107.79 (open of the next 15m)
Strength   A 4/4  (tag)
When       CAT 16:15
No stop, no target. Exit is yours.
```

**Measured volume:** 1.82 signals/day across BTC/ETH/SOL over 52 days
(≈1.40 distinct moments — correlated pairs arrive together). Structures watched
silently: 22.3/day.

---

## WATCH — Bot 3, `4h` or `1h`, no trade frame

**Rule.** When a structure's geometry completes and price approaches its
trigger, send a **WAKE-UP**. Never wait for confirmation: a structure that is
about to break cannot be mechanically confirmed without arriving too late to
act on. If it then breaks, send a **BREAK**. If it dies — geometry gone, or a
**12-bar** backstop — send a **CLOSE-OUT**.

**Structures.** Head & shoulders · inverse head & shoulders · Wyckoff accumulation.

**Cup & handle is deliberately absent.** Three one-bar instances in 208 days on
three symbols; never resolved. Do not add it back without data.

**Guards.**
- Right shoulder must be within **14 bars** of now.
- Price must be within **8%** of the trigger.
- Wyckoff's spring is searched **only in the last 25%** of the window. Building
  the range from the whole window and then asking whether a bar went below that
  window's own minimum is unsatisfiable by construction.

**Each structure produces at most one WAKE-UP, one BREAK, one CLOSE-OUT.**

**Measured volume:** 1h → 1.19 messages/day; 4h → 0.38/day, across three symbols.

---

## LAB — silent measurement, no notifications

**Rule.** Every armed structure is scored against **all nine** confirmation
ideas. Rows are written; nothing is ever sent.

**There is no formatter and no notify function in this module.** That is
deliberate and is asserted by the tests.

**Artificial take profit.** `1.0 × the pattern's own measured move`. It is a
**ruler**, not a trade: it gives nine ideas a fixed finish line so they can be
compared. Measured justification:

| TP | Reached first | Opposite move first | Still open at 24h |
|---|---|---|---|
| 0.5× | 30% | **40%** | 30% |
| **1.0×** | **28%** | **18%** | 55% |
| 1.5× | 8% | 12% | 80% |
| 2.0× | 5% | 8% | 88% |

At 0.5× the market's own breathing stops you more often than the target is hit.

**If the artificial TP ever appears in a notification, an exit decision or a live
lane, it has become a target — which is forbidden.**

---

## Tests

```
node src/lanes/i1.test.js      44 passed
node src/lanes/watch.test.js   29 passed
node src/lanes/lab.test.js     30 passed
```

Plus the sealed scalp module, unchanged: `scalp-core.test.js` 39,
`scalp-scanner.test.js` 20.

---

## Open decisions (recorded, not yet applied)

1. Watch lane frame: **1h (1.19/day)** vs **4h (0.38/day)**. Note I1 also reads
   1h — two 1h lanes will wake on the same structures.
2. Whether the watch CLOSE-OUT also reports max favourable / max adverse.
3. Whether the `coiled` state ever becomes a message (currently silent).
4. Symbol count: every lane scales linearly with symbols.
