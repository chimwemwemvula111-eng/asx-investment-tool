# Putting it in the cloud — the phone version

Right now the extension is a **desk toy**: it runs only while Chrome is open on
that machine, and the rows live in that browser's own storage. Nothing else can
see them.

After this, it runs on a schedule with no computer of yours involved, and you
sign in from your phone to see the same rows.

---

## First, the thing you were worried about

> *"I hope the existing browser data conflicts with the tool."*

It does not, and it never did. An extension's `chrome.storage` is walled off
from cookies, `localStorage`, history and every other site's data. Chrome gives
each extension its own private area; nothing you browse can read it and it
cannot corrupt you. The old build was not fighting your browser.

The real problem you're describing is different and it is real: **the data was
trapped in one browser on one machine.** That is what this fixes.

---

## What runs where

```
                    ┌───────────────────────────┐
                    │   Supabase (Postgres)     │
                    │   settings · journal      │
                    │   dedupe · lane state     │
                    │   row level security ON   │
                    └───▲────────▲────────▲─────┘
                        │        │        │
        reads + writes  │        │        │  writes the rows,
        (signed in)     │        │        │  sends the messages
                        │        │        │
              ┌─────────┴──┐  ┌──┴─────┐  └──────────────┐
              │  phone /   │  │ laptop │  │ sweep job     │
              │  any web   │  │ browser│  │ (every 5 min, │
              │  browser   │  │        │  │ no browser)   │
              └────────────┘  └────────┘  └───────────────┘

              ┌────────────────────────────┐
              │ Chrome extension (optional)│  ← still works, still local-only
              └────────────────────────────┘
```

There are three ways to run the same tool, and they share every line of lane
logic:

| Where | Runs the lanes? | Sees the data? | Needs your computer on? |
|---|---|---|---|
| **Web app** (phone/laptop) | no | yes, live | yes | 
| **Sweep job** (GitHub Actions) | **yes** | writes it | **no** |
| **Chrome extension** | yes | its own local copy | yes |

The web app can't fetch Binance itself (browsers block it) and it certainly
can't run while the tab is closed. That is what the sweep job is for. Press
**Run now** in the web app and it writes a request to the database; the sweep
job picks the request up and answers within five minutes.

---

## Step 1 — Make a Supabase project (free, ~2 minutes)

1. <https://supabase.com> → **Start your project** → sign in with GitHub.
2. **New project.** Name it `asx`. Pick the region closest to you
   (for Zambia: **Europe (Frankfurt)** or **South Africa** if it is offered).
3. Save the database password somewhere; you will not need it for this, but
   losing it is annoying.
4. Wait for the project to finish provisioning (about a minute).

Free tier: 500 MB of database, 50k monthly active users, pauses after a week of
total inactivity. This app writes about 500 rows a day — that is a few MB a
month. You will not notice it.

## Step 2 — Create the tables

1. In the dashboard: **SQL Editor → New query**.
2. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql).
3. **Run.** It says "Success. No rows returned" — that is correct.

That created four tables, switched on row level security on all of them, and
added the policies that make each row visible only to its owner. Also two
housekeeping functions: one trims the journal to 5,000 rows, one trims the
dedupe book after 14 days.

> You do not have to take the SQL on trust. `npm run test:schema` starts a
> throwaway Postgres, applies the same file, and checks that one user cannot
> read, write or trim another user's rows. It needs a local `postgres` install
> and nothing else — no Supabase project, no keys.

## Step 3 — Make yourself an account

**Authentication → Users → Add user → Create new user.**

- Email: your address.
- Password: something long.
- **Tick "Auto Confirm User"** — otherwise Supabase emails a confirmation link
  and you will wonder why signing in fails.

Write down the **User UID** that appears in the users table. You will need it in
Step 5. It looks like `a1b2c3d4-…`.

> There is no public sign-up button in the app on purpose. This is a tool for
> one person; a login page that anyone can register on is a login page that
> anyone can register on.

## Step 4 — Point the web app at your project

**Settings → API** (or **Project Settings → API**). Copy two values:

- **Project URL** — `https://abcdefgh.supabase.co`
- **anon / public** key — the long `eyJ…` one under *Project API keys*

Paste them into [`site/config.js`](site/config.js):

```js
export const CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…'
};
```

The anon key is designed to be public: it carries no privileges of its own. Row
level security is what stops it reading anybody else's rows.

**Never paste the `service_role` key into that file.** It bypasses RLS, and
anything in a static site is readable by whoever opens the page.

## Step 5 — Put the site online (free, ~5 minutes)

Any static host will do, because the site is static. GitHub Pages is the least
friction since the code already lives in a repo.

**GitHub Pages**

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder: `/ (root)`**.
3. Save. In a minute your site is at
   `https://YOUR-NAME.github.io/YOUR-REPO/site/`

Note the `/site/` on the end — the repository root is the extension, the site
lives one folder down.

**Netlify / Cloudflare Pages** work the same way: publish directory `site`, no
build command, no environment variables. But then the paths `../src/…` that the
site imports must be preserved — deploy the repository root and use `/site/` as
the entry, exactly as with Pages.

Open that URL on your phone, sign in with the account from Step 3, and you are
looking at your own lanes. **Add it to your home screen** — it behaves like an
app and remembers the session.

## Step 6 — Make it run when you are away

**The sweep job.** GitHub Actions, free for a private repo on the free plan.

1. Repository → **Settings → Secrets and variables → Actions → New repository secret.**
   Add all three:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | the **service_role** key (Settings → API) |
   | `ASX_USER_ID` | the User UID from Step 3 |

2. **Actions** tab → `sweep` → **Enable workflow**.
3. Press **Run workflow** once to test it. It should go green in about 30
   seconds, and the run log prints what each lane did.

From then on it runs every five minutes. **The service key never goes near your
browser** — it exists only inside that secret store and inside the runner.

> **The one GitHub gotcha:** scheduled workflows are disabled automatically in
> a repository that has had no activity for 60 days. If messages stop, open the
> Actions tab and click *Enable workflow*. If that bothers you, move the same
> script to a Cloudflare Worker cron — see the last section.

## Step 7 — Set up the channels, from your phone

Open the site on your phone → **Settings**. Paste the bot tokens and chat IDs
for Scalp, Intraday and Watch, press each **Send a test message**, then **Save**.

Those settings live in Postgres, so the sweep job reads exactly what you typed
on your phone. Nothing to copy between machines.

Press **Run now** on the history page and watch the status line under the rail:
it turns over as soon as the job answers.

---

## Moving the rows you already have

Your extension has a journal full of history and it is not going to walk over
by itself.

1. In the extension: **History → Period: A month → Export format: JSON →
   Export period.** Do that for each month you care about.
2. Then, once, on any machine with Node:

   ```bash
   SUPABASE_URL=https://abcdefgh.supabase.co \
   SUPABASE_SERVICE_KEY=eyJ…service… \
   ASX_USER_ID=a1b2c3d4-… \
   node scripts/import-journal.mjs asx-history-2026-10.json
   ```

   It prints `imported 412 · already there 0 · unusable 0`. Running it twice is
   harmless — rows already present are skipped.

3. **Settings** do not travel in that file. Re-enter the three tokens on the
   phone; it takes a minute.

---

## What it costs

| Piece | Free tier | What you will use |
|---|---|---|
| Supabase | 500 MB, pauses after 7 idle days | ~5 MB/month, and the sweep job means it is never idle |
| GitHub Actions | 2,000 minutes/month private, unlimited public | ~30 s × 288 runs/day ≈ 145 min/month |
| GitHub Pages | free for public repos | nothing |
| Binance data | public, no key | nothing |
| Telegram | free | nothing |

The whole thing is £0. The one real limit is the Actions minutes: at 5-minute
sweeps you are using about 145 of your 2,000. If you want to sweep every minute,
that is 1,440 min/month — still inside the budget, but change the cron to
`*/1 * * * *` only if you actually need it.

---

## Troubleshooting

**"Not configured yet"** — `site/config.js` still has the placeholders. Step 4.

**"Wrong email or password"** — either the password is wrong or the user was
created *without* "Auto Confirm User". Delete and re-create the user with it
ticked.

**Signed in, but every view is empty** — the tables exist but there are no rows
yet. Either press Run now (Step 7) or import your history.

**The sweep job is red** — open the run log. `missing SUPABASE_URL /
SUPABASE_SERVICE_KEY / ASX_USER_ID` means a secret is missing or misnamed.
`401` means the service key is not the service key.

**Messages arrive twice** — two sweepers are running (for example the GitHub
job *and* an old Cloudflare cron). The dedupe book stops two runs printing the
same break, so what you are seeing means the two are running more than a few
minutes apart with new candles in between. Turn one off.

**No messages at all, job is green** — check the lane is switched on in Settings,
that the channel has both a token and a chat ID, and that the bot is an admin in
that channel. The run log prints `unsent` when a lane had no channel.

---

## If you ever want a faster clock than GitHub's five minutes

The sweep script is a plain Node program with no dependencies. A Cloudflare
Worker cron (`*/1 * * * *`) can import it if you bundle it:

```
wrangler.toml
  [triggers]
  crons = ["* * * * *"]
  [vars]
  SUPABASE_URL = "https://…"
```

and in the worker:

```js
import { sweep } from './scripts/sweep.mjs';
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep({ env }));
  }
};
```

Secrets go in `wrangler secret put` rather than in the toml. Same functions, same
runner, one more deploy target. Not required — five minutes is inside every
lane's own candle interval anyway.

---

## One honest limitation

The **Chrome extension and the cloud are two separate books.** The extension
still writes to its own local storage; the web app and the sweep job write to
Postgres. If you point both at the market at once you will get two messages for
the same break, because each has its own dedupe book.

Use one or the other:

- **Away from your desk?** The web app + sweep job. This is the version that
  keeps working when the laptop is shut.
- **At your desk, want it offline?** The extension, as it always was.

Making the extension write to Postgres too is a small change — the store
already takes a backend, and the extension's page could call `useBackend()` the
same way the site does. Say the word and I'll wire it; I left it out because it
needs another sign-in inside the extension, and you asked for the phone.
