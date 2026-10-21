#!/usr/bin/env node
// ============================================================================
// sweep.mjs — one sweep, on a server, writing to Supabase.
//
// This is the piece that makes the tool stop being tied to your desk: it runs
// on a schedule with no browser anywhere, sends the Telegram messages, and
// writes the rows the phone reads.
//
// It uses the SAME runner as the extension. There is no second implementation.
//
//   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...  ASX_USER_ID=...  node scripts/sweep.mjs
//
// Env:
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role key  (server only, never in a browser)
//   ASX_USER_ID           your user id (Supabase → Authentication → Users)
//   ASX_DRY_RUN=1         run everything, send nothing, print what would go out
// ============================================================================

import { pathToFileURL } from 'node:url';
import { runOnce } from '../src/runner/runner.js';
import * as store from '../src/store/store.js';
import { createClient } from '../src/data/supabase.js';
import { createSupabaseBackend } from '../src/store/supabase-backend.js';

const LOCK_MS = 4 * 60_000;   // a run holding the lock this long is assumed dead
const MIN_GAP_MS = 60_000;    // never sweep twice inside a minute

export async function sweep({
  env = process.env,
  fetchImpl = fetch,
  sender,
  now = Date.now(),
  log = () => {}
} = {}) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;
  const userId = env.ASX_USER_ID;
  const dryRun = env.ASX_DRY_RUN === '1' || env.ASX_DRY_RUN === 'true';

  if (!url || !key || !userId) {
    // Nothing set at all means the repository has not been wired up yet, which
    // is the state a fresh clone is in. Say so and stop, rather than leaving a
    // red X on every scheduled run until the secrets are added.
    if (!url && !key && !userId) return { skipped: true, reason: 'not configured' };
    throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_KEY / ASX_USER_ID');
  }

  const client = createClient({ url, anonKey: key, fetchImpl });
  const backend = createSupabaseBackend(client, { userId });

  // ── two guards, both in the database so they survive a restart ──────────
  const lock = await backend._getKv('sweep_lock');
  if (lock?.until && now < lock.until) {
    log(`skipped: a sweep is already running (locked for ${Math.round((lock.until - now) / 1000)}s)`);
    return { skipped: true, reason: 'locked' };
  }
  const last = await backend._getKv('last_sweep');
  if (last?.at && now - last.at < MIN_GAP_MS) {
    log(`skipped: the last sweep finished ${Math.round((now - last.at) / 1000)}s ago`);
    return { skipped: true, reason: 'too soon' };
  }
  await backend._setKv('sweep_lock', { at: now, until: now + LOCK_MS });

  // ── did a phone ask for this run? ────────────────────────────────────────
  const requested = await backend.takeRunRequest().catch(() => null);
  if (requested) log(`run requested by ${requested.by} at ${new Date(requested.at).toISOString()}`);

  store.useBackend(backend);

  let summary;
  try {
    summary = await runOnce({ fetchImpl, now, sender, dryRun });
  } finally {
    await backend._setKv('sweep_lock', null).catch(() => {});
    await backend._setKv('last_sweep', { at: now }).catch(() => {});
    store.resetBackend();
  }

  log(JSON.stringify({
    at: new Date(summary.at).toISOString(),
    messages: summary.messages,
    labRows: summary.rows,
    unsent: summary.unsent || 0,
    errors: summary.errors,
    lanes: Object.fromEntries(Object.entries(summary.lanes).map(([k, v]) => [k, v.printed ?? v.rows ?? v.error ?? 0]))
  }, null, 2));

  if (dryRun) log(`dry run — ${summary.sent.length} messages would have gone out`);
  return summary;
}

// ── run it when invoked from the command line ──────────────────────────────
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  sweep({ log: m => console.log(m) })
    .then(r => {
      if (r?.reason === 'not configured') {
        console.log('[asx] no secrets yet — the repository is not wired up. See SETUP-CLOUD.md step 6.');
      }
      if (r?.skipped) process.exit(0);
      // A lane-level error is reported, not fatal: the other lanes still ran.
      process.exit(0);
    })
    .catch(e => {
      console.error('[asx] sweep failed:', e.message);
      process.exit(1);
    });
}
