#!/usr/bin/env node
// ============================================================================
// import-journal.mjs — move the rows you already have into Supabase.
//
//   1. In the extension: History → Export period → JSON
//   2. Then:
//        SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ASX_USER_ID=... \
//        node scripts/import-journal.mjs asx-history-2026-10.json
//
// Rows already present (same time, lane, kind, symbol and level) are skipped,
// so you can run it twice, or import month after month.
// ============================================================================

import { readFileSync } from 'node:fs';
import { createClient } from '../src/data/supabase.js';
import { createSupabaseBackend } from '../src/store/supabase-backend.js';

const keyOf = r => `${r.at}|${r.lane}|${r.kind}|${r.symbol || ''}|${r.level ?? ''}`;

export async function importJournal(file, {
  env = process.env,
  fetchImpl = fetch,
  log = () => {}
} = {}) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;
  const userId = env.ASX_USER_ID;
  if (!url || !key || !userId) {
    throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_KEY / ASX_USER_ID');
  }

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const incoming = Array.isArray(raw) ? raw : raw.rows;
  if (!Array.isArray(incoming)) throw new Error('that file does not look like an export');

  const client = createClient({ url, anonKey: key, fetchImpl });
  const backend = createSupabaseBackend(client, { userId });

  const existing = new Set((await backend.getJournal()).map(keyOf));
  const fresh = [];
  let skipped = 0, bad = 0;

  for (const r of incoming) {
    if (!r || typeof r.at !== 'number' || !r.lane) { bad++; continue; }
    if (existing.has(keyOf(r))) { skipped++; continue; }
    existing.add(keyOf(r));
    fresh.push(r);
  }

  if (fresh.length) await backend.appendJournal(fresh);
  log(`imported ${fresh.length} · already there ${skipped} · unusable ${bad}`);
  return { imported: fresh.length, skipped, bad };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('import-journal.mjs');
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/import-journal.mjs <export.json>');
    process.exit(1);
  }
  importJournal(file, { log: m => console.log(m) })
    .catch(e => { console.error('[asx] import failed:', e.message); process.exit(1); });
}
