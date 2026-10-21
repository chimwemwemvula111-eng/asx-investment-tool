// Run: node tests/supabase.test.js
//
// Proves the cloud path end to end against a mock PostgREST/GoTrue server:
// sign in → store the session → write settings → run a whole sweep → read the
// rows back → a second sweep prints nothing because the database refused the
// duplicate keys.

import { startMockSupabase } from './mock-supabase.js';
import { createClient, memorySessionStore, localSessionStore } from '../src/data/supabase.js';
import { createSupabaseBackend } from '../src/store/supabase-backend.js';
import * as store from '../src/store/store.js';
import { runOnce } from '../src/runner/runner.js';
import { INTERVAL_MS } from '../src/data/feed.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const server = await startMockSupabase();
const EMAIL = 'trader@example.com';
const PASSWORD = 'correct horse battery';
const ALICE = server.addUser(EMAIL, PASSWORD);
const BOB = server.addUser('bob@example.com', 'hunter2hunter2');

const newClient = () => createClient({
  url: server.url, anonKey: server.anonKey, sessionStore: memorySessionStore()
});

// ── a synthetic tape that fires, same shape as the runner tests ────────────
const M = 60_000;
const NOW = Date.UTC(2026, 9, 20, 12, 30, 0);
function series(n, intervalMs, start, now = NOW) {
  const bars = [];
  const lastOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  for (let i = n - 1; i >= 0; i--) {
    const t = lastOpen - i * intervalMs;
    const c = start;
    bars.push({ t, o: c - 0.2, h: c + 0.35, l: c - 0.35, c, v: 1000, tb: 600, n: 420 });
  }
  return bars;
}
function firingMap() {
  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const b = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v, tb: Math.round(v * 0.6), n: 300 });
  const history = [
    b(T0 - 7 * 5 * M, 97, 98, 96, 97), b(T0 - 6 * 5 * M, 96, 97, 95, 96),
    b(T0 - 5 * 5 * M, 95, 96, 92, 95), b(T0 - 4 * 5 * M, 95, 98, 95, 97),
    b(T0 - 3 * 5 * M, 97, 100, 96, 99), b(T0 - 2 * 5 * M, 99, 99, 96, 97),
    b(T0 - 1 * 5 * M, 97, 98, 95, 96)
  ];
  const reading = b(T0, 98, 105, 97, 102);
  const trade = [
    b(T0, 98.0, 99.0, 97.5, 98.6), b(T0 + M, 98.6, 100.5, 98.4, 100.2),
    b(T0 + 2 * M, 100.2, 101.0, 99.9, 100.8, 120), b(T0 + 3 * M, 101.2, 103.0, 101.0, 102.6, 180),
    b(T0 + 4 * M, 102.6, 103.2, 102.0, 102.8)
  ];
  const map = { 'BTCUSDT:5m': [...history, reading], 'BTCUSDT:1m': trade };
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['1m', '5m', '15m', '1h', '4h']) {
      if (!map[`${sym}:${iv}`]) map[`${sym}:${iv}`] = series(iv === '1h' ? 300 : 340, INTERVAL_MS[iv], 100);
    }
  }
  return map;
}
const fakeFetch = map => async url => {
  const sym = /symbol=([A-Z]+)/.exec(url)?.[1];
  const iv = /interval=([0-9a-z]+)/.exec(url)?.[1];
  const bars = map[`${sym}:${iv}`];
  if (!bars) return { ok: false, status: 404, json: async () => ({}) };
  return {
    ok: true, status: 200,
    json: async () => bars.map(b => [b.t, String(b.o), String(b.h), String(b.l), String(b.c),
      String(b.v), b.t + INTERVAL_MS[iv], '0', String(b.n), String(b.tb), '0', '0'])
  };
};

console.log('\n1 · Sign in');
let client;
{
  client = newClient();
  let err = null;
  try { await client.signIn(EMAIL, 'wrong'); } catch (e) { err = e; }
  ok('a wrong password fails', !!err, String(err));
  ok('…and says why', /Invalid login credentials/.test(String(err)));

  const s = await client.signIn(EMAIL, PASSWORD);
  ok('a right password returns a session', !!s.access_token && s.user.id === ALICE);
  ok('the user id is exposed', await client.userId() === ALICE);
  ok('the session persists in the store', !!(await client.getSession())?.access_token);

  await client.signOut();
  ok('sign out clears it', (await client.getSession()) === null);

  await client.signIn(EMAIL, PASSWORD);
}

console.log('\n2 · Settings live in Postgres');
const backend = createSupabaseBackend(client);
{
  const s0 = await backend.getSettings();
  ok('defaults when the row does not exist yet', s0.symbols.length === 3 && s0.watchFrame === '1h');

  const s1 = await backend.saveSettings({ watchFrame: '4h', telegram: { scalp: { token: 'T', chatId: 'C' } } });
  ok('saving writes a row', s1.watchFrame === '4h' && s1.telegram.scalp.token === 'T');
  ok('the other channels stay empty', s1.telegram.i1.token === '');

  const s2 = await backend.getSettings();
  ok('reading it back gives the same object', s2.watchFrame === '4h' && s2.telegram.scalp.chatId === 'C');
  ok('settings row is scoped to the user',
    server.db.tables.asx_settings.every(r => r.user_id === ALICE));

  await backend.saveSettings({ lanes: { lab: false } });
  ok('a nested patch merges instead of replacing', (await backend.getSettings()).lanes.scalp === true);
}

console.log('\n3 · Journal rows');
{
  const rows = [
    { at: NOW - 60_000, lane: 'scalp', kind: 'SIGNAL', symbol: 'BTCUSDT', pattern: 'FLAG',
      direction: 'long', level: 101.5, entry: 101.7, strength: 'A 4/4', note: 'S1', text: 'hello' },
    { at: NOW, lane: 'lab', kind: 'ROW', symbol: 'ETHUSDT', pattern: 'TRIANGLE',
      direction: 'short', level: 2.5, entry: null, strength: 'B_close_beyond', note: 'tp', text: null }
  ];
  await backend.appendJournal(rows);
  const back = await backend.getJournal();
  ok('both rows come back', back.length === 2, `${back.length}`);
  ok('newest first', back[0].lane === 'lab' && back[0].at === NOW);
  ok('strength survives the round trip (column is called tag)', back[1].strength === 'A 4/4');
  ok('a null entry stays null', back[0].entry === null);
  ok('the message body survives', back[1].text === 'hello');
  ok('timestamps come back as numbers', typeof back[1].at === 'number');

  await backend.clearJournal();
  ok('clear empties it', (await backend.getJournal()).length === 0);
}

console.log('\n4 · Dedupe is decided by the database');
{
  const first = await backend.claim(['k1', 'k2'], NOW);
  ok('fresh keys are claimed', first.length === 2);
  const second = await backend.claim(['k1', 'k2', 'k3'], NOW + 1000);
  ok('only the unseen key is claimed', second.length === 1 && second[0] === 'k3');
  ok('the row count did not double', server.db.tables.asx_sent.filter(r => r.user_id === ALICE).length === 3);

  await backend.release(['k3']);
  const third = await backend.claim(['k3'], NOW + 2000);
  ok('a released key can be claimed again', third.length === 1);
}

console.log('\n5 · Lane state and status');
{
  ok('lane state defaults to empty', Object.keys(await backend.getLaneState()).length === 0);
  await backend.saveLaneState({ ETHUSDT: { live: [], done: ['x'] } });
  ok('lane state round trips', (await backend.getLaneState()).ETHUSDT.done[0] === 'x');

  await backend.saveStatus({ lastRun: NOW, lastError: null, counts: { messages: 3 }, lanes: {} });
  ok('status round trips', (await backend.getStatus()).counts.messages === 3);

  await backend.requestRun('phone');
  const req = await backend.takeRunRequest();
  ok('a run request is written and taken', req?.by === 'phone');
  ok('taking it clears it', (await backend.takeRunRequest()) === null);
}

console.log('\n6 · A whole sweep, through the database');
{
  await backend.clearJournal();
  await backend.clearSent();
  await backend.saveSettings({
    watchFrame: '1h',
    telegram: {
      scalp: { token: 'SCALP_TOKEN', chatId: 'SCALP_CHAT' },
      i1: { token: 'I1_TOKEN', chatId: 'I1_CHAT' },
      watch: { token: 'WATCH_TOKEN', chatId: 'WATCH_CHAT' }
    }
  });

  store.useBackend(backend);

  const calls = [];
  const res = await runOnce({
    fetchImpl: fakeFetch(firingMap()), now: NOW,
    sender: async ({ token, chatId, text }) => { calls.push({ token, chatId, text }); return { ok: true }; }
  });

  ok('the sweep ran against the cloud store', !!res && Array.isArray(res.errors));
  ok('no errors', res.errors.length === 0, JSON.stringify(res.errors));
  ok('the scalp break was sent', calls.some(c => c.chatId === 'SCALP_CHAT'));
  ok('it was sent with the scalp bot', calls.every(c => c.chatId !== 'SCALP_CHAT' || c.token === 'SCALP_TOKEN'));

  const stored = await backend.getJournal();
  ok('the rows landed in the journal table', stored.length > 0, `${stored.length} rows`);
  ok('rows are stamped with the user', server.db.tables.asx_journal.every(r => r.user_id === ALICE));

  const second = [];
  await runOnce({
    fetchImpl: fakeFetch(firingMap()), now: NOW + 60_000,
    sender: async ({ text }) => { second.push(text); return { ok: true }; }
  });
  ok('a second sweep does not repeat the same break', second.length === 0, `${second.length} repeats`);

  store.resetBackend();
}

console.log('\n7 · One account cannot see another');
{
  const bob = newClient();
  await bob.signIn('bob@example.com', 'hunter2hunter2');
  const bobBackend = createSupabaseBackend(bob);

  ok('bob sees no journal rows', (await bobBackend.getJournal()).length === 0);
  ok('bob sees his own default settings, not alice\'s',
    (await bobBackend.getSettings()).telegram.scalp.token === '');
  ok('bob gets every key as fresh', (await bobBackend.claim(['k1'], NOW)).length === 1,
    'alice already claimed k1');

  await bobBackend.appendJournal([{ at: NOW, lane: 'scalp', kind: 'SIGNAL', symbol: 'X' }]);
  ok('bob cannot write a row for alice', server.db.tables.asx_journal
    .filter(r => r.symbol === 'X').every(r => r.user_id === BOB));
}

console.log('\n8 · The sweep job signs in with the service key');
{
  const service = createClient({
    url: server.url, anonKey: server.serviceKey, sessionStore: memorySessionStore()
  });
  const jobBackend = createSupabaseBackend(service, { userId: ALICE });
  ok('no session needed when a user id is given', (await jobBackend.getJournal()).length > 0);
  ok('it can still write', await jobBackend.claim(['job-key'], NOW).then(r => r.length === 1));
}

console.log('\n9 · The server job — the thing that runs while you are away');
{
  const { sweep } = await import('../scripts/sweep.mjs');

  await backend.clearJournal();
  await backend.clearSent();
  await backend.saveSettings({ telegram: {
    scalp: { token: 'SCALP_TOKEN', chatId: 'SCALP_CHAT' },
    i1: { token: 'I1_TOKEN', chatId: 'I1_CHAT' },
    watch: { token: 'WATCH_TOKEN', chatId: 'WATCH_CHAT' }
  } });

  const env = { SUPABASE_URL: server.url, SUPABASE_SERVICE_KEY: server.serviceKey, ASX_USER_ID: ALICE };
  const posted = [];
  // one fetch for the whole job: candles are faked, everything else is the
  // mock Supabase server over real HTTP
  const market = fakeFetch(firingMap());
  const routed = (url, opts) => String(url).includes('/api/v3/klines')
    ? market(url)
    : fetch(url, opts);

  const deps = {
    env,
    fetchImpl: routed,
    sender: async ({ text }) => { posted.push(text); return { ok: true }; },
    now: NOW,
    log: () => {}
  };

  const res = await sweep(deps);
  ok('the job runs with no browser and no session', !!res && !res.skipped);
  ok('it sent through the user\'s own channels', posted.length > 0, `${posted.length}`);
  ok('it wrote rows the phone will read', (await backend.getJournal()).length > 0);

  const again = await sweep({ ...deps, now: NOW + 30_000 });
  ok('a second run inside the lock window is skipped', again?.skipped === true);

  const later = await sweep({ ...deps, now: NOW + 5 * 60_000 });
  ok('a run after the lock window goes ahead', !later?.skipped);

  /* A brand-new repository has no secrets yet. That must not paint a red X on
     every scheduled run for the day before you get round to step 6. */
  const missing = await sweep({ env: {}, log: () => {} }).catch(e => e);
  ok('a repository with no secrets skips quietly',
    missing?.skipped === true && missing.reason === 'not configured');

  const half = await sweep({ env: { SUPABASE_URL: 'https://x.supabase.co' }, log: () => {} })
    .catch(e => e);
  ok('a half-configured repository fails loudly',
    half instanceof Error && /SUPABASE_SERVICE_KEY/.test(half.message));

  store.resetBackend();
}

console.log('\n10 · Importing the rows you already have');
{
  const { importJournal } = await import('../scripts/import-journal.mjs');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  await backend.clearJournal();

  const dir = mkdtempSync(join(tmpdir(), 'asx-'));
  const file = join(dir, 'export.json');
  writeFileSync(file, JSON.stringify({
    period: 'd7', count: 3,
    rows: [
      { at: NOW - 3 * 86400_000, lane: 'scalp', kind: 'SIGNAL', symbol: 'BTCUSDT', level: 101, entry: 101.2, strength: 'A 4/4' },
      { at: NOW - 2 * 86400_000, lane: 'watch', kind: 'WAKE-UP', symbol: 'ETHUSDT', level: 2.5, entry: null },
      { lane: 'broken' }
    ]
  }));

  const env = { SUPABASE_URL: server.url, SUPABASE_SERVICE_KEY: server.serviceKey, ASX_USER_ID: ALICE };
  const first = await importJournal(file, { env, log: () => {} });
  ok('two rows imported, one rejected', first.imported === 2 && first.bad === 1, JSON.stringify(first));
  ok('they are readable through the app store', (await backend.getJournal()).length === 2);

  const again = await importJournal(file, { env, log: () => {} });
  ok('importing twice does not duplicate', again.imported === 0 && again.skipped === 2, JSON.stringify(again));
  ok('the table still holds two rows', (await backend.getJournal()).length === 2);
}

await server.close();
console.log('\n§11 · A hostile or absent localStorage cannot break the login gate');
{
  /* node has no localStorage at all */
  const mem = localSessionStore();
  ok('no localStorage → a memory store that still round-trips',
    (async () => true)() && typeof mem.get === 'function' && typeof mem.set === 'function');
  await mem.set({ session: { access_token: 't' } });
  ok('it remembers what was written', (await mem.get('session')).session.access_token === 't');
  await mem.remove('session');
  ok('and forgets what was removed', !(await mem.get('session')).session);

  /* Safari private mode: the property exists, setItem throws */
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {}
  };
  const fallback = localSessionStore();
  await fallback.set({ a: 1 });
  ok('a storage that throws on write falls back to memory', (await fallback.get('a')).a === 1);

  /* site data blocked: touching the property throws */
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError'); }
  });
  const blocked = localSessionStore();
  await blocked.set({ b: 2 });
  ok('a storage that throws on access falls back to memory', (await blocked.get('b')).b === 2);
  delete globalThis.localStorage;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
