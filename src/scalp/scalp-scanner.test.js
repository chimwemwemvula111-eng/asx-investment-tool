// Run: node src/scalp/scalp-scanner.test.js
import { Scanner, scanIntervalMs, DEDUPE_DEFAULTS } from './scalp-scanner.js';
import { PRESETS } from './scalp-core.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${x}`); } };

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });

// A clean pivot HIGH at 100 and a clean pivot LOW at 92 (each needs 2 lower
// highs / higher lows either side — k = 2, so both are real pivots).
// Pivots only exist from index k onward, so the pivot low must sit at index 2+.
// pivot LOW  = 92 at index 2 (all four neighbours higher)
// pivot HIGH = 100 at index 4 (all four neighbours lower)
const history = [
  bar(T0 - 7 * 5 * M, 97, 98, 96, 97),
  bar(T0 - 6 * 5 * M, 96, 97, 95, 96),
  bar(T0 - 5 * 5 * M, 95, 96, 92, 95),   // pivot low = 92
  bar(T0 - 4 * 5 * M, 95, 98, 95, 97),
  bar(T0 - 3 * 5 * M, 97, 100, 96, 99),  // pivot high = 100
  bar(T0 - 2 * 5 * M, 99, 99, 96, 97),
  bar(T0 - 1 * 5 * M, 97, 98, 95, 96)
];
const readingUp = bar(T0, 98, 105, 97, 102);
const tradeUp = [
  bar(T0 + 0 * M, 98.0, 99.0, 97.5, 98.6),
  bar(T0 + 1 * M, 98.6, 100.5, 98.4, 100.2),
  bar(T0 + 2 * M, 100.2, 101.0, 99.9, 100.8, 120),
  bar(T0 + 3 * M, 101.2, 103.0, 101.0, 102.6, 180),
  bar(T0 + 4 * M, 102.6, 103.2, 102.0, 102.8)
];
const now = T0 + 5 * M + 5000;
const scanArgs = { symbol: 'BTCUSDT', readingHistory: history, readingCurrent: readingUp, tradeBars: tradeUp, now };

console.log('\n1 · Cadence — wake on candle close, not on a timer');
{
  ok('S1 looks once a minute', scanIntervalMs('S1') === 60_000, scanIntervalMs('S1'));
  ok('S2 looks once every 5 minutes', scanIntervalMs('S2') === 300_000, scanIntervalMs('S2'));
  ok('cadence equals the trade frame', scanIntervalMs('S1') === PRESETS.S1.tradeMs);
}

console.log('\n2 · One break is reported once');
{
  const sc = new Scanner({ presetId: 'S1' });
  const a = sc.scan({ ...scanArgs });
  ok('first time prints', !!a.signal, a.silent);
  const b = sc.scan({ ...scanArgs, now: now + M });
  ok('same break again is a repeat, not a new signal', b.silent === 'repeat-of-already-reported-break', b.silent);
  ok('repeat is counted, not lost', sc.stats.suppressed === 1, JSON.stringify(sc.stats));
  ok('dedupe key is symbol|side|level', a.dedupeKey === 'BTCUSDT|BUY|100.00000000', a.dedupeKey);
}

console.log('\n3 · A DIFFERENT break still prints immediately');
{
  const sc = new Scanner({ presetId: 'S1' });
  sc.scan({ ...scanArgs });
  // next reading candle takes the pivot LOW at 92 instead
  const hist2 = [...history, readingUp];
  const readingDown = bar(T0 + 5 * M, 96, 97, 88, 89);
  const tradeDown = [
    bar(T0 + 5 * M, 96.0, 96.5, 95.0, 95.5),
    bar(T0 + 6 * M, 95.5, 96.0, 93.0, 93.5),
    bar(T0 + 7 * M, 93.5, 94.0, 91.8, 92.0, 150),
    bar(T0 + 8 * M, 92.0, 92.4, 90.5, 90.8, 200),   // closes below 92 → trigger
    bar(T0 + 9 * M, 90.8, 91.2, 90.0, 90.2)
  ];
  const r = sc.scan({
    symbol: 'BTCUSDT', readingHistory: hist2, readingCurrent: readingDown,
    tradeBars: tradeDown, now: T0 + 10 * M + 5000
  });
  ok('new break on the other side prints', !!r.signal, r.silent);
  if (r.signal) ok('it is a SELL', r.signal.direction === 'SELL', r.signal.direction);
}

console.log('\n4 · The repeat expires — it is not silenced forever');
{
  const sc = new Scanner({ presetId: 'S1', dedupe: { ttlReadingBars: 24 } });
  const first = sc.scan({ ...scanArgs });
  ok('first prints', !!first.signal, first.silent);
  ok('book holds the break', sc.book.size === 1);
  // age the entry past the TTL without moving the tape (so it can't read stale)
  sc.book.get(first.dedupeKey).firstMs = now - 25 * 5 * M;
  const laterSameBreak = sc.scan({ ...scanArgs });
  ok('after the TTL the same price can fire again', !!laterSameBreak.signal, laterSameBreak.silent);
}

console.log('\n5 · Switches behave as described');
{
  const off = new Scanner({ presetId: 'S1', dedupe: { enabled: false } });
  off.scan({ ...scanArgs });
  const second = off.scan({ ...scanArgs, now: now + M });
  ok('dedupe off → raw firehose, both print', !!second.signal, second.silent);

  ok('dedupe is ON by default', DEDUPE_DEFAULTS.enabled === true);
  ok('default TTL is 24 reading bars', DEDUPE_DEFAULTS.ttlReadingBars === 24);
}

console.log('\n6 · Silence is still only about the market');
{
  const sc = new Scanner({ presetId: 'S1' });
  const r = sc.scan({ ...scanArgs, readingCurrent: bar(T0, 96, 98, 95, 97) });
  ok('no break → no-break', r.silent === 'no-break', r.silent);
  ok('silence is counted by reason', sc.stats.silent['no-break'] === 1, JSON.stringify(sc.stats.silent));
  ok('a silent scan is not a suppressed signal', sc.stats.suppressed === 0);
}

console.log('\n7 · Forgetting a symbol clears only that symbol');
{
  const sc = new Scanner({ presetId: 'S1' });
  sc.scan({ ...scanArgs });
  sc.scan({ ...scanArgs, symbol: 'ETHUSDT' });
  ok('two symbols hold two keys', sc.book.size === 2, sc.book.size);
  sc.forget('BTCUSDT');
  ok('forget removes one', sc.book.size === 1, sc.book.size);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
