# ASX Investment Tool — v2.0.1

> **2.0.1** — four fixes, all found by running this against a real Postgres
> instead of a mock.
>
> - **History was empty in cloud mode.** A row's `at` is a number of
>   milliseconds locally, but Supabase returns a timestamp as text. Comparing
>   text to a number is always false, so every period filter matched nothing.
>   Fixed in `store.filterByRange`, with tests that use the cloud shape.
> - **The housekeeping functions trusted their caller.** `asx_trim_journal`
>   and `asx_trim_sent` run with `SECURITY DEFINER`, which bypasses row level
>   security, and took the user id as an argument. Any signed-in user could
>   have trimmed anyone's rows by passing their id. Both are now guarded.
> - **Table grants are explicit**, so `schema.sql` also applies cleanly to a
>   bare Postgres and `anon` is provably locked out.
> - **The Lab board answers in English.** Plain labels instead of
>   `I_body_plus_displacement`, and an honest `1/1` rather than a `100%` built
>   on a single row. Rows list newest first, and a row on a phone is about a
>   third shorter.
>
> `npm run test:schema` starts a throwaway Postgres and proves all of it.

It watches three crypto pairs, reads structure on two timeframes, and sends you
a Telegram message when something happens. It does not place trades, size
positions, draw charts, or tell you where to get out.

**It runs three ways, from one codebase:**

| Where | What it is | Runs the lanes? |
|---|---|---|
| **Web app** | a static site you sign in to from your phone | no — it reads |
| **Sweep job** | a 5-minute cron on a server | **yes** |
| **Chrome extension** | the same UI, offline, local only | yes |

To run it from your phone you need a database and one server job.
**[SETUP-CLOUD.md](SETUP-CLOUD.md) walks through it — about fifteen minutes,
and it is all free.**

---

## What it does

| Lane | Reads | Confirms on | What you get |
|---|---|---|---|
| **Scalp** | 5m and 15m | 1m and 5m | Every break that closes beyond a level, back to back |
| **Intraday** | 1h | 15m | A level armed by the 1h shape, fired only when 15m confirms |
| **Watch** | 1h or 4h | nothing | A message the moment price *arrives* at a level — before any break |
| **Lab** | 1h | 15m | Nothing. It records. It never sends. |

Each lane view shows **today only**. Everything older is in **History**, where
it can be filtered by month and lane and taken out as JSON or Excel.

**No charts anywhere.** No sparklines, no candles, no indicators. A level, a
direction, and a time.

---

## Install the extension (desk only)

1. Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder (the one with `manifest.json` in it)
4. Click the toolbar icon. The app opens in a tab.

## First run

1. **Settings → three channels.** Scalp, Intraday and Watch each have their own
   bot token and chat ID. Make one bot per lane in [@BotFather](https://t.me/BotFather),
   drop it into the right channel, and press **Send a test message** on that
   panel. Lab has no panel because it has no channel — it never sends.
2. **Settings → Symbols.** Default is `BTCUSDT, ETHUSDT, SOLUSDT`.
3. Press **Run now** in the sidebar rail. You will see the first sweep
   land in the feeds within a few seconds.

A lane with no channel configured still records to the journal. It just does
not send, and the run summary tells you how many messages went unsent.

From then on the service worker sweeps **every 5 minutes** on its own. You do
not need the tab open.

---

## How to read a message

```
◆ SOLUSDT — SELL
Candle    5M read → 1M confirm
Pattern   follow-through · continuation
Level     106.440 · swing low
Entry     23:34:00
Basis     price held beyond the level
Strength  B (3/4)
```

- **Level** is the price the market has to cross. That is the whole trigger.
- **Entry** is *the open of the first candle after the trigger closed.* It has
  already happened by the time you read the message. You are not being told to
  buy at a price — you are being told a price was crossed.
- **Strength** is a sticky note, not a bouncer. A `C` prints exactly like an
  `A`. It never blocks anything.
- There is no stop, no target, no expiry. Those are yours.

## History

Pick a period, pick a lane (or all of them), press **Export period**.

| Period | What it covers |
|---|---|
| **A month** | any month, chosen with the month picker |
| **One day** | any single day, chosen with the date picker |
| **Last 3 days** | today and the two days before it |
| **Last 7 days** | today and the six days before it |
| **Last 14 days** | today and the thirteen days before it |

The rolling periods count **calendar days in your own timezone**, not the last
72 hours — "last 3 days" means three of your days.

- **JSON** is the raw journal rows, exactly as stored, with the period, the exact
  window and the row count in the header.
- **Excel** is a real `.xlsx` — one sheet of rows, one sheet of summary counts.
  It is written by `src/app/xlsx.js`, which builds the zip and the XML itself,
  so there is no library to install and nothing to load at runtime.

`when_local` in the export is your local time with its UTC offset, so the sheet
matches the table you were just looking at. The table shows the newest 1,500
rows; the export always contains every row in the month.

---

## The rules this build is built on

- **No gate-keeping.** Volume, spread, session, strength — none of them can
  silence a signal. They are tags that ride along on the message.
- **No ATR.** Every "is this big?" question is answered against the
  instrument's own recent median range, so the same rule works on BTC and on
  SOL without recalibration.
- **One break, one message.** The same level on the same side is reported
  once, then remembered for 24 reading bars. A second trigger candle on the
  same break is the same event wearing a different shape.
- **Lanes do not talk to each other.** They read the same candles and draw
  their own conclusions. No lane reads another lane's levels.
- **Watch notifies early, on purpose.** It fires when price *arrives*, not when
  it breaks. You get the warning, you make the call.
- **The lab never notifies.** Nine confirmation ideas, all scored silently
  against an artificial 1.0× ruler, so you can look at the board later and see
  which one is actually worth anything.

---

## The cloud version

```
Supabase (Postgres + auth + row level security)
   ▲                  ▲                     ▲
   │ sign in          │ sign in             │ service key
phone web app     laptop browser        sweep job (every 5 min)
                                        → Binance → Telegram → rows
```

- **Sign in** with email and password. Row level security means one account can
  only ever see its own rows — the tests prove this by signing in as a second
  user and getting nothing back.
- **Run now** on the phone writes a request; the sweep job picks it up and the
  page updates itself.
- **Export** works exactly as it does locally — JSON or a real `.xlsx`, by
  period and lane.
- The **service key** that lets the job write lives only in the server secret
  store. The anon key in the browser is public by design and has no privileges
  of its own.

Full instructions: [SETUP-CLOUD.md](SETUP-CLOUD.md).

## Volume, so you know what you are signing up for

Measured over the same data this lane family was built against:

| Lane | Messages per day |
|---|---|
| Scalp (S1 + S2) | ~181 |
| Intraday | ~1.8 |
| Watch (1h) | ~1.2 |
| Watch (4h) | ~0.4 |
| Lab | 0 |
| **Total** | **~184** |

Scalp is the noisy one *by design* — it is a break-detector, not a filter.
If that is too much, turn the S1/S2 presets off in Settings and keep the other
three lanes. Three channels is the intended setup: one bot token, three chat
IDs, one lane family each.

---

## What is in the folder

```
manifest.json               MV3. Two permissions: storage, alarms.
src/
  app/                      the UI — index.html, app.css, app.js
  background/               service-worker.js — opens the tab, holds the 5-minute alarm
  runner/runner.js          the ONLY wiring point. runOnce() does a whole sweep.
  data/feed.js              Binance candles in. Closed bars only.
  data/telegram.js          one function: send a message.
  data/supabase.js          auth + REST. No SDK, no build step.
  store/store.js            the API: settings, journal, dedupe, periods.
  store/supabase-backend.js the same API, backed by Postgres.
  app/xlsx.js               a real .xlsx writer — zip + XML, no dependencies.
  lanes/                    i1.js · watch.js · lab.js   (frozen logic, tests alongside)
  scalp/                    scalp-core.js · scalp-scanner.js · scalp-format.js
  assets/                   icons — logo.png is the source, icon16/48/128 the sizes
site/                       the web app: same UI, a sign-in gate, config.js
index.html                  a one-line redirect to site/ — leave it at the root
.nojekyll                   tells GitHub Pages to serve the files untouched
supabase/schema.sql         tables + row level security. Run it once.
supabase/schema.test.sql    proves the policies hold, on a throwaway Postgres
scripts/sweep.mjs           the 5-minute server job
scripts/import-journal.mjs  move existing history into Postgres
scripts/test-schema.sh      npm run test:schema — starts a temp Postgres, runs it
.github/workflows/sweep.yml the cron that runs the job for free
tests/                      end-to-end suites, including a mock Supabase
tools/build-preview.mjs     regenerates preview.html from the real app files
tools/build-site.mjs        regenerates site/index.html from the real app markup
preview.html                the UI with sample data, no extension needed
```

## Tests

```bash
npm test
```

| Suite | Assertions | What it proves |
|---|---|---|
| `tests/runner.test.js` | 67 | store, channels, periods, xlsx, full sweeps |
| `tests/supabase.test.js` | 51 | auth, RLS isolation, a sweep through Postgres, the server job, the importer |
| `tests/site.test.js` | 16 | the web app has not drifted from the extension |
| `src/lanes/*.test.js` | 103 | the frozen lane logic |
| `src/scalp/*.test.js` | 59 | the frozen scalp logic |

**296 assertions, no dependencies, no build step.** Plain `node`.

The cloud suite runs against a mock PostgREST/GoTrue server
(`tests/mock-supabase.js`) — real HTTP, real auth flow, real conflict handling —
so the sign-in path and the database path are exercised, not assumed.

## preview.html

The same CSS and the same `app.js`, inlined into one file with a seeded
journal, so you can look at the interface in any browser without installing
anything. Regenerate with `node tools/build-preview.mjs`.

## Screenshots

`docs/web-login.png`, `docs/web-desktop.png`, `docs/web-phone.png` — the web app
on a laptop and on a 390px phone.
