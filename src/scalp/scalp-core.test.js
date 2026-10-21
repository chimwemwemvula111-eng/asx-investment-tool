// Run: node src/scalp/scalp-core.test.js
import { buildSignal, PRESETS, describeTime, gradeStrength, DEFAULTS } from './scalp-core.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);   // a 5m boundary
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });

// A reading history with a clean pivot high at 100 and a pivot low at 90.
const history = [
  bar(T0 - 6 * 5 * M, 92, 95, 91, 94),
  bar(T0 - 5 * 5 * M, 94, 97, 93, 96),
  bar(T0 - 4 * 5 * M, 96, 100, 95, 99),   // pivot high = 100 (index 2)
  bar(T0 - 3 * 5 * M, 99, 99, 96, 97),
  bar(T0 - 2 * 5 * M, 97, 98, 95, 96),
  bar(T0 - 1 * 5 * M, 96, 98, 94, 95)
];
// pivot low = 90 needs neighbours higher; insert far enough back
history.unshift(bar(T0 - 7 * 5 * M, 89, 92, 88, 91));
history[1] = bar(T0 - 6 * 5 * M, 91, 94, 90, 93);

const readingUp = bar(T0, 98, 105, 97, 102);       // takes 100 by wick, closes above
const now = T0 + 5 * M + 5_000;                      // just after the 5m candle closes

// trade bars inside the 5m candle; unlock is at T0 + 3m
const tradeUp = [
  bar(T0 + 0 * M, 98.0, 99.0, 97.5, 98.6),
  bar(T0 + 1 * M, 98.6, 100.5, 98.4, 100.2),
  bar(T0 + 2 * M, 100.2, 101.0, 99.9, 100.8, 120),
  bar(T0 + 3 * M, 101.2, 103.0, 101.0, 102.6, 180),   // ← trigger: hold close, 55% body
  bar(T0 + 4 * M, 102.6, 103.2, 102.0, 102.8)
];

console.log('\n1 · ACCEPT — break held, trade with it');
{
  const { signal, silent } = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp, tradeBars: tradeUp, now
  });
  ok('fires', !!signal, `silent=${silent}`);
  if (signal) {
    ok('direction BUY', signal.direction === 'BUY');
    ok('basis held', signal.basis === 'held');
    ok('pattern is hold close or momentum', ['hold_close', 'momentum_bar'].includes(signal.pattern.id), signal.pattern.id);
    ok('level = prior swing high 100', Math.abs(signal.level - 100) < 1e-9, signal.level);
    ok('entry = open of bar AFTER trigger', signal.entry.ms === T0 + 4 * M, new Date(signal.entry.ms).toISOString());
    ok('entry not before unlock', signal.entry.ms >= T0 + 3 * M);
    ok('timezone carries UTC and CAT', /UTC \d\d:\d\d:\d\d · CAT/.test(signal.entry.line), signal.entry.line);
    ok('CAT is UTC+2', signal.entry.cat.slice(4, 9) !== signal.entry.utc.slice(4, 9));
    ok('kill = the level for a held break', Math.abs(signal.kill - 100) < 1e-9);
    ok('strength graded', !!signal.tags.strength.grade);
    ok('no target, no stop', !('target' in signal) && !('stop' in signal));
  }
}

console.log('\n2 · REJECT — break failed, trade against it');
{
  const tradeReject = [
    bar(T0 + 0 * M, 98.0, 99.0, 97.5, 98.6),
    bar(T0 + 1 * M, 98.6, 100.5, 98.4, 100.2),
    bar(T0 + 2 * M, 100.2, 101.0, 99.9, 100.8),
    bar(T0 + 3 * M, 100.5, 102.0, 99.7, 99.8, 210),     // ← rejection wick, closes below 100
    bar(T0 + 4 * M, 99.8, 100.1, 99.0, 99.2)
  ];
  const { signal, silent } = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp, tradeBars: tradeReject, now
  });
  ok('fires', !!signal, `silent=${silent}`);
  if (signal) {
    ok('direction SELL', signal.direction === 'SELL');
    ok('basis failed', signal.basis === 'failed');
    ok('mode reversal', signal.mode === 'reversal');
    ok('pattern rejection_wick', signal.pattern.id === 'rejection_wick', signal.pattern.id);
    ok('kill above the trigger high', signal.kill === 102);
  }
}

console.log('\n3 · Silence comes only from the market or the feed');
{
  const noBreak = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: bar(T0, 96, 98, 95, 97), tradeBars: tradeUp, now
  });
  ok('no break → silent "no-break"', noBreak.silent === 'no-break', noBreak.silent);

  const stale = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp, tradeBars: tradeUp,
    now: T0 + 5 * M + 30 * M
  });
  ok('stale feed → silent "stale-feed"', stale.silent === 'stale-feed', stale.silent);

  const flat = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp,
    tradeBars: [
      bar(T0 + 0 * M, 98, 99, 97.5, 98.6),
      bar(T0 + 3 * M, 100.5, 100.6, 100.4, 100.5)
    ],
    now
  });
  ok('break but no pattern → "no-pattern-in-window"', flat.silent === 'no-pattern-in-window', flat.silent);
}

console.log('\n4 · The clock — nothing before unlock');
{
  // A perfect trigger at T0+1m must be ignored: unlock is T0+3m.
  const early = [
    bar(T0 + 0 * M, 98.0, 99.0, 97.5, 98.6),
    bar(T0 + 1 * M, 101.2, 103.0, 101.0, 102.6, 180),
    bar(T0 + 2 * M, 102.6, 103.2, 102.0, 102.8),
    bar(T0 + 3 * M, 102.8, 103.5, 102.4, 103.1),
    bar(T0 + 4 * M, 103.1, 103.6, 102.8, 103.3)
  ];
  const { signal, silent } = buildSignal({
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp, tradeBars: early, now
  });
  ok('early trigger rejected', !signal || signal.trigger.ms > T0 + 3 * M, signal ? signal.trigger.iso : silent);
}

console.log('\n5 · Strength — four independent checks, graded, never summed');
{
  const clean = bar(T0, 100, 114, 98, 112);          // body 12/16, clv .875
  const g = gradeStrength(clean, 'up', 100, [16, 16, 16, 16], DEFAULTS);
  ok('clean bar grades A', g.grade === 'A', JSON.stringify(g.checks));

  // closed high in the range but gave most of it back from the top — the trap
  const trap = bar(T0, 100, 114, 96, 104);
  const t = gradeStrength(trap, 'up', 100, [16, 16, 16, 16], DEFAULTS);
  ok('trap bar is docked', t.passes <= 2, `${t.grade} ${JSON.stringify(t.checks)}`);

  const sliver = bar(T0, 100, 101.2, 98, 100.3);
  const s = gradeStrength(sliver, 'up', 100, [16, 16, 16, 16], DEFAULTS);
  ok('sliver grades C or worse', ['C', 'D'].includes(s.grade), s.grade);

  // the duplicate that was removed: adverse wick is exactly 1 − clv
  const v = gradeStrength(clean, 'up', 100, [16], DEFAULTS).values;
  ok('adverse wick is the complement of CLV', Math.abs(v.adverse + v.clv - 1) < 1e-12);
  ok('exactly four checks are scored', Object.keys(g.checks).length === 4, Object.keys(g.checks).join(','));
}

console.log('\n6 · Both bots, same code');
{
  const up15 = bar(T0, 98, 105, 97, 102);
  const tradeS2 = [
    bar(T0 + 0 * M, 98, 99, 97, 98.5),
    bar(T0 + 5 * M, 98.5, 101, 98.4, 100.8),
    bar(T0 + 9 * M, 101.2, 103, 101.0, 102.6, 180),
    bar(T0 + 10 * M, 102.6, 103.2, 102.0, 102.8),
    bar(T0 + 14 * M, 102.8, 103.5, 102.4, 103.1)
  ];
  const r = buildSignal({
    presetId: 'S2', symbol: 'ETHUSDT',
    readingHistory: history, readingCurrent: up15, tradeBars: tradeS2,
    now: T0 + 15 * M + 5_000
  });
  ok('S2 fires with the same code path', !!r.signal, r.silent);
  if (r.signal) {
    ok('S2 labels 15m → 5m', r.signal.candle.label.includes('15M') || r.signal.preset === 'S2');
    ok('S2 unlock is 60% of 15m (9m)', r.signal.trigger.ms >= T0 + 9 * M);
  }
  ok('presets differ only in the two numbers',
    PRESETS.S1.reading === '5m' && PRESETS.S2.reading === '15m' &&
    PRESETS.S1.unlockFraction === PRESETS.S2.unlockFraction);
}

console.log('\n7 · Everything is printed — no suppression by default');
{
  const base = {
    presetId: 'S1', symbol: 'BTCUSDT',
    readingHistory: history, readingCurrent: readingUp, tradeBars: tradeUp, now
  };
  ok('cooldown default is 0 (off)', DEFAULTS.cooldownReadingBars === 0, DEFAULTS.cooldownReadingBars);
  const a = buildSignal({ ...base });
  ok('first fire allowed', !!a.signal, a.silent);
  // the same level, one candle later — must still print
  const b = buildSignal({ ...base, lastSignalMs: T0 + 4 * M });
  ok('immediate re-fire still prints', !!b.signal, b.silent);
  const c = buildSignal({ ...base, lastSignalMs: T0 + 4 * M, config: { cooldownReadingBars: 6 } });
  ok('cooldown works if you opt in later', c.silent === 'cooldown', c.silent);
  ok('strength is a tag, not a gate', DEFAULTS.strengthMode === 'tag');
  ok('volume is a tag, not a gate', DEFAULTS.requireVolume === false);
}

console.log('\n8 · Time zone is never a bare time');
{
  const d = describeTime(Date.UTC(2026, 9, 20, 14, 26, 0));
  ok('UTC printed', d.utc === 'UTC 14:26:00', d.utc);
  ok('CAT printed (+2)', d.cat === 'CAT 16:26:00', d.cat);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
