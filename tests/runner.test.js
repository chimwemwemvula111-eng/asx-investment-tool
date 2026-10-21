// Run: node tests/runner.test.js
import { runOnce, runI1, runWatch, runLab, dumpWatchTracker, loadWatchTracker } from '../src/runner/runner.js';
import * as store from '../src/store/store.js';
import { closedOnly, takerBuyRatio, INTERVAL_MS } from '../src/data/feed.js';
import { tagLine } from '../src/data/telegram.js';
import { buildXlsx } from '../src/app/xlsx.js';
import { createTracker, step, DEFAULTS as WATCH_DEFAULTS } from '../src/lanes/watch.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

// ── an in-memory storage adapter ───────────────────────────────────────────
function memStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? { [k]: m.get(k) } : {}),
    set: async o => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
    remove: async k => { m.delete(k); },
    _dump: () => Object.fromEntries(m)
  };
}

// ── a synthetic market ─────────────────────────────────────────────────────
const M = 60_000;
function series(n, intervalMs, start = 100, drift = 0.05, now = Date.now()) {
  const bars = [];
  // align so the last bar is closed
  const lastOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  for (let i = n - 1; i >= 0; i--) {
    const t = lastOpen - i * intervalMs;
    const c = start + (n - i) * drift;
    bars.push({ t, o: c - 0.2, h: c + 0.35, l: c - 0.35, c, v: 1000, tb: 600, n: 420 });
  }
  return bars;
}

function fakeFetch(map) {
  return async url => {
    const sym = /symbol=([A-Z]+)/.exec(url)?.[1];
    const iv = /interval=([0-9a-z]+)/.exec(url)?.[1];
    const key = `${sym}:${iv}`;
    const bars = map[key];
    if (!bars) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => bars.map(b => [
        b.t, String(b.o), String(b.h), String(b.l), String(b.c), String(b.v),
        b.t + INTERVAL_MS[iv], '0', String(b.n), String(b.tb), '0', '0'
      ])
    };
  };
}

const NOW = Date.UTC(2026, 9, 20, 12, 30, 0);

// ── a tape that actually fires ─────────────────────────────────────────────
// Lifted from the scalp scanner's own fixture: a 5m range with a pivot low at
// 92 and a pivot high at 100, then a reading candle that closes at 102, then a
// 1m trigger that holds above 100. S1 has to print on this.
function firingMap() {
  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const b = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v, tb: Math.round(v * 0.6), n: 300 });
  const history = [
    b(T0 - 7 * 5 * M, 97, 98, 96, 97),
    b(T0 - 6 * 5 * M, 96, 97, 95, 96),
    b(T0 - 5 * 5 * M, 95, 96, 92, 95),     // pivot low 92
    b(T0 - 4 * 5 * M, 95, 98, 95, 97),
    b(T0 - 3 * 5 * M, 97, 100, 96, 99),    // pivot high 100
    b(T0 - 2 * 5 * M, 99, 99, 96, 97),
    b(T0 - 1 * 5 * M, 97, 98, 95, 96)
  ];
  const readingUp = b(T0, 98, 105, 97, 102);
  const trade = [
    b(T0 + 0 * M, 98.0, 99.0, 97.5, 98.6),
    b(T0 + 1 * M, 98.6, 100.5, 98.4, 100.2),
    b(T0 + 2 * M, 100.2, 101.0, 99.9, 100.8, 120),
    b(T0 + 3 * M, 101.2, 103.0, 101.0, 102.6, 180),
    b(T0 + 4 * M, 102.6, 103.2, 102.0, 102.8)
  ];

  const map = { 'BTCUSDT:5m': [...history, readingUp], 'BTCUSDT:1m': trade };
  // quiet ramps everywhere else, so only the fixture can fire
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['1m', '5m', '15m', '1h', '4h']) {
      if (map[`${sym}:${iv}`]) continue;
      map[`${sym}:${iv}`] = series(iv === '1h' ? 300 : 340, INTERVAL_MS[iv], 100, 0, NOW);
    }
  }
  return map;
}

console.log('\n1 · Store — defaults, merge, journal, dedupe');
{
  const s = memStorage();
  const st = await store.getSettings(s);
  ok('defaults load', st.symbols.length === 3 && st.watchFrame === '1h');
  ok('three channels by default, all empty',
    Object.keys(st.telegram).sort().join(',') === 'i1,scalp,watch' &&
    ['scalp', 'i1', 'watch'].every(k => st.telegram[k].token === ''));

  const upd = await store.saveSettings({ watchFrame: '4h', telegram: { scalp: { token: 'abc' } } }, s);
  ok('settings persist', upd.watchFrame === '4h');
  ok('one lane channel set, the others untouched',
    upd.telegram.scalp.token === 'abc' && upd.telegram.scalp.chatId === '' &&
    upd.telegram.i1.token === '' && upd.telegram.watch.token === '');

  await store.appendJournal([{ at: 1, lane: 'lab', kind: 'ROW' }], s);
  await store.appendJournal([{ at: 2, lane: 'lab', kind: 'ROW' }], s);
  const j = await store.getJournal(s);
  ok('journal prepends newest', j[0].at === 2 && j.length === 2);

  const a = await store.claim(['k1', 'k2'], s, 1000);
  ok('fresh keys claimed', a.length === 2);
  const b = await store.claim(['k1', 'k3'], s, 2000);
  ok('only unseen keys come back', b.length === 1 && b[0] === 'k3', JSON.stringify(b));
  await store.release(['k1'], s);
  const c = await store.claim(['k1'], s, 3000);
  ok('released keys can be re-claimed', c.length === 1);
}

console.log('\n1b · Channels — three lanes, three bots');
{
  // a v1.0.0 settings object with one flat pair migrates into all three lanes
  const old = store.mergeSettings({ telegram: { token: 'T', chatId: 'C' } });
  ok('flat v1.0.0 token copies into every lane',
    ['scalp', 'i1', 'watch'].every(k => old.telegram[k].token === 'T' && old.telegram[k].chatId === 'C'));

  const mixed = store.mergeSettings({
    telegram: { token: 'OLD', chatId: 'OLD', scalp: { token: 'NEW', chatId: 'NEW' } }
  });
  ok('an explicit lane wins over the flat fallback',
    mixed.telegram.scalp.token === 'NEW' && mixed.telegram.i1.token === 'OLD');

  ok('no channel until both fields are set',
    store.channelFor({ telegram: { scalp: { token: 'T', chatId: '' } } }, 'scalp') === null);
  ok('a full pair is a channel',
    store.channelFor({ telegram: { watch: { token: 'T', chatId: 'C' } } }, 'watch')?.chatId === 'C');
  ok('lab has no channel at all',
    store.channelFor({ telegram: { lab: { token: 'T', chatId: 'C' } } }, 'lab') === null);
}

console.log('\n2 · Feed — closed bars only, tags read from the same payload');
{
  const now = 1_700_000_030_000; // 30s into the current minute
  const bars = [
    { t: now - 2 * M, h: 1, l: 0, c: 1, o: 1, v: 10, tb: 6, n: 5 }, // closed
    { t: now - 30_000, h: 1, l: 0, c: 1, o: 1, v: 10, tb: 6, n: 5 }, // still forming
  ];
  ok('forming candle dropped', closedOnly(bars, M, now).length === 1);
  ok('taker ratio computed', Math.abs(takerBuyRatio(bars[0]) - 0.6) < 1e-9);
  ok('taker ratio null on zero volume', takerBuyRatio({ v: 0, tb: 0 }) === null);
  ok('tag line renders', tagLine({ takerRatio: 0.62, trades: 410 }).includes('taker 62%'));
}

console.log('\n2b · History — months, days, filters');
{
  const at = new Date(2026, 8, 14, 10, 0, 0).getTime();   // 14 Sep 2026, local
  ok('month key', store.monthKey(at) === '2026-09');
  ok('day key', store.dayKey(at) === '2026-09-14');

  const rows = [
    { at: new Date(2026, 8, 14, 10, 0).getTime(), lane: 'scalp' },
    { at: new Date(2026, 8, 2, 10, 0).getTime(), lane: 'lab' },
    { at: new Date(2026, 9, 1, 10, 0).getTime(), lane: 'scalp' }
  ];
  ok('months newest first', store.monthsIn(rows).join(',') === '2026-10,2026-09');
  ok('filter by month', store.filterJournal(rows, { month: '2026-09' }).length === 2);
  ok('filter by month + lane', store.filterJournal(rows, { month: '2026-09', lane: 'lab' }).length === 1);
  ok('lane "all" means all', store.filterJournal(rows, { month: '2026-09', lane: 'all' }).length === 2);
  ok('no filters means everything', store.filterJournal(rows, {}).length === 3);

  // ── the export periods ───────────────────────────────────────────────────
  const now = new Date(2026, 9, 21, 14, 30).getTime();   // 21 Oct 2026, 14:30 local
  const day = n => new Date(2026, 9, 21, n, 0).getTime();

  const wMonth = store.rangeWindow({ range: 'month', month: '2026-09', now });
  ok('month window is a calendar month',
    new Date(wMonth.from).getDate() === 1 && new Date(wMonth.from).getMonth() === 8 &&
    new Date(wMonth.to).getMonth() === 9 && wMonth.label === '2026-09');

  const wDay = store.rangeWindow({ range: 'day', day: '2026-10-14', now });
  ok('a day window is 24 hours from local midnight',
    wDay.to - wDay.from === 24 * 3600_000 &&
    new Date(wDay.from).getDate() === 14 && wDay.label === '2026-10-14');

  const w3 = store.rangeWindow({ range: 'd3', now });
  const w7 = store.rangeWindow({ range: 'd7', now });
  const w14 = store.rangeWindow({ range: 'd14', now });
  ok('last 3 days is today plus the two before', new Date(w3.from).getDate() === 19 && w3.label === 'last-3-days');
  ok('last 7 days starts a week back', new Date(w7.from).getDate() === 15);
  ok('last 14 days starts a fortnight back', new Date(w14.from).getDate() === 8);
  ok('every rolling window ends at tomorrow midnight',
    [w3, w7, w14].every(w => new Date(w.to).getDate() === 22 && new Date(w.to).getHours() === 0));
  ok('rolling windows are 3, 7 and 14 days',
    [w3, w7, w14].map(w => Math.round((w.to - w.from) / 86400_000)).join(',') === '3,7,14');

  const sample = [
    { at: new Date(2026, 9, 21, 9, 0).getTime(), lane: 'scalp' },   // today
    { at: new Date(2026, 9, 19, 9, 0).getTime(), lane: 'lab' },     // 2 days back
    { at: new Date(2026, 9, 15, 9, 0).getTime(), lane: 'scalp' },   // 6 days back
    { at: new Date(2026, 9, 10, 9, 0).getTime(), lane: 'watch' }    // 11 days back
  ];
  ok('one day picks only that day', store.filterByRange(sample, { range: 'day', day: '2026-10-21', now }).length === 1);
  ok('last 3 days', store.filterByRange(sample, { range: 'd3', now }).length === 2);
  ok('last 7 days', store.filterByRange(sample, { range: 'd7', now }).length === 3);
  ok('last 14 days catches everything', store.filterByRange(sample, { range: 'd14', now }).length === 4);
  ok('a period still respects the lane filter',
    store.filterByRange(sample, { range: 'd7', now, lane: 'lab' }).length === 1);
  ok('lane "all" is not a lane', store.filterByRange(sample, { range: 'd7', now, lane: 'all' }).length === 3);

  /* Supabase hands `at` back as a timestamptz — a string, not a number.
     Comparing that to the numeric window used to be silently false, which
     emptied History in cloud mode while the local extension looked fine. */
  const fromCloud = [
    { at: new Date(2026, 9, 21, 9, 0).toISOString(), lane: 'scalp' },
    { at: new Date(2026, 9, 19, 9, 0).toISOString(), lane: 'lab' },
    { at: new Date(2026, 9, 10, 9, 0).toISOString(), lane: 'watch' }
  ];
  ok('a row stamped as text still lands in its day',
    store.filterByRange(fromCloud, { range: 'day', day: '2026-10-21', now }).length === 1);
  ok('a row stamped as text still lands in last 7 days',
    store.filterByRange(fromCloud, { range: 'd7', now }).length === 2);
  ok('atMs reads both shapes the same',
    store.atMs(fromCloud[0].at) === store.atMs(now - (now - new Date(2026, 9, 21, 9, 0).getTime())));
  ok('atMs survives rubbish without throwing', Number.isNaN(store.atMs('not a date')));
  ok('byNewest puts the most recent first',
    store.byNewest(fromCloud).map(r => r.lane).join() === 'scalp,lab,watch');
  ok('byNewest does not mutate what it was given',
    fromCloud[0].lane === 'scalp' && store.byNewest(fromCloud) !== fromCloud);
}

console.log('\n2c · Excel — a real .xlsx, no dependencies');
{
  const bytes = buildXlsx([
    { name: 'History', rows: [['when', 'lane', 'level'], ['2026-09-14 10:00', 'scalp', 108420.5]] },
    { name: 'Summary', rows: [['month', '2026-09'], ['rows', 1]] }
  ]);
  ok('produces bytes', bytes instanceof Uint8Array && bytes.length > 500);
  ok('is a zip (PK\u0003\u0004)', bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4);
  const text = new TextDecoder().decode(bytes);
  ok('contains the workbook', text.includes('xl/workbook.xml'));
  ok('contains both sheets', text.includes('worksheets/sheet1.xml') && text.includes('worksheets/sheet2.xml'));
  ok('contains the data', text.includes('108420.5') && text.includes('scalp'));
  ok('rejects an empty workbook', (() => { try { buildXlsx([]); return false; } catch { return true; } })());
  const tiny = buildXlsx([{ name: 'a/b:c', rows: [['x']] }]);
  ok('sheet names are sanitised', new TextDecoder().decode(tiny).includes('name="a b c"'));
}

console.log('\n3 · Watch tracker survives a JSON round-trip');
{
  const t = createTracker(WATCH_DEFAULTS);
  t.live.set('k', { s: { type: 'HEAD & SHOULDERS', dir: 'short', level: 100 }, wakeAt: 5, announcedWake: true });
  t.done.add('done1');
  const json = JSON.parse(JSON.stringify(dumpWatchTracker(t)));
  const back = loadWatchTracker(json, WATCH_DEFAULTS);
  ok('live map restored', back.live.size === 1 && back.live.get('k').wakeAt === 5);
  ok('done set restored', back.done.has('done1'));
  ok('empty state gives a clean tracker', loadWatchTracker(undefined, WATCH_DEFAULTS).live.size === 0);
}

console.log('\n4 · runOnce — a full sweep against a synthetic tape');
{
  const s = memStorage();
  const map = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['1m', '5m', '15m', '1h', '4h']) {
      map[`${sym}:${iv}`] = series(iv === '1h' ? 300 : 340, INTERVAL_MS[iv], 100, 0.05, NOW);
    }
  }
  const sent = [];
  const res = await runOnce({
    storage: s, fetchImpl: fakeFetch(map), now: NOW,
    sender: async ({ text }) => { sent.push(text); return { ok: true }; }
  });
  ok('sweep returns a summary', !!res && typeof res.messages === 'number');
  ok('no lane-level errors', (res.errors || []).length === 0, JSON.stringify(res.errors));
  ok('all four lanes reported', ['scalp', 'i1', 'watch', 'lab'].every(k => res.lanes[k]));
  ok('status saved', (await store.getStatus(s)).lastRun === NOW);
  ok('sent array is an array', Array.isArray(sent));
}

console.log('\n4b · runOnce — each lane sends to its own bot');
{
  const s = memStorage();
  await store.saveSettings({
    telegram: {
      scalp: { token: 'SCALP_TOKEN', chatId: 'SCALP_CHAT' },
      i1: { token: 'I1_TOKEN', chatId: 'I1_CHAT' },
      watch: { token: 'WATCH_TOKEN', chatId: 'WATCH_CHAT' }
    }
  }, s);

  const map = firingMap();

  const calls = [];
  const res = await runOnce({
    storage: s, fetchImpl: fakeFetch(map), now: NOW,
    sender: async ({ token, chatId, text }) => { calls.push({ token, chatId, text }); return { ok: true }; }
  });
  ok('something was sent', calls.length > 0, `${calls.length} calls`);
  ok('every message went to a configured chat',
    calls.every(c => ['SCALP_CHAT', 'I1_CHAT', 'WATCH_CHAT'].includes(c.chatId)), JSON.stringify(calls.map(c => c.chatId)));
  ok('the token always matches its chat', calls.every(c =>
    (c.chatId === 'SCALP_CHAT' && c.token === 'SCALP_TOKEN') ||
    (c.chatId === 'I1_CHAT' && c.token === 'I1_TOKEN') ||
    (c.chatId === 'WATCH_CHAT' && c.token === 'WATCH_TOKEN')));
  ok('the scalp break went to the scalp bot',
    calls.some(c => c.chatId === 'SCALP_CHAT' && /scalp/i.test(c.text)), JSON.stringify(calls.map(c => c.chatId)));
  ok('nothing was skipped when every channel is set', !res.unsent);
}

console.log('\n4c · runOnce — an unconfigured lane still journals, it just does not send');
{
  const s = memStorage();
  await store.saveSettings({ telegram: { scalp: { token: '', chatId: '' } } }, s);
  const map = firingMap();
  const calls = [];
  const res = await runOnce({
    storage: s, fetchImpl: fakeFetch(map), now: NOW,
    sender: async ({ text }) => { calls.push(text); return { ok: true }; }
  });
  const journal = await store.getJournal(s);
  ok('no channel, no send', calls.length === 0);
  ok('the rows are still recorded', journal.length > 0, `${journal.length} rows`);
  ok('the summary says how many went unsent', res.unsent > 0);
}

console.log('\n5 · runOnce — paused means nothing fires');
{
  const s = memStorage();
  await store.saveSettings({ paused: true }, s);
  const sent = [];
  const res = await runOnce({
    storage: s, fetchImpl: fakeFetch({}), now: NOW,
    sender: async ({ text }) => { sent.push(text); return { ok: true }; }
  });
  ok('paused sweep reports paused', res.paused === true);
  ok('nothing sent while paused', sent.length === 0);
}

console.log('\n6 · runOnce — a dead feed is silent, not a crash');
{
  const s = memStorage();
  const res = await runOnce({
    storage: s,
    fetchImpl: async () => ({ ok: false, status: 451, json: async () => ({}) }),
    now: NOW,
    sender: async () => ({ ok: true })
  });
  ok('sweep completes', !!res);
  ok('errors are recorded rather than thrown', (res.errors || []).length > 0);
  ok('messages is still a number', typeof res.messages === 'number');
}

console.log('\n7 · Dedupe — the same break cannot print twice');
{
  const s = memStorage();
  const map = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['1m', '5m', '15m', '1h', '4h']) {
      map[`${sym}:${iv}`] = series(iv === '1h' ? 300 : 340, INTERVAL_MS[iv], 100, 0.05, NOW);
    }
  }
  const first = [];
  await runOnce({ storage: s, fetchImpl: fakeFetch(map), now: NOW, sender: async ({ text }) => { first.push(text); return { ok: true }; } });
  const second = [];
  await runOnce({ storage: s, fetchImpl: fakeFetch(map), now: NOW + 60_000, sender: async ({ text }) => { second.push(text); return { ok: true }; } });
  ok('first sweep may print', Array.isArray(first));
  ok('second sweep prints nothing new for the same bars', second.length === 0,
    `${second.length} unexpected repeats`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
