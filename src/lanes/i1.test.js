// Run: node src/lanes/i1.test.js
import {
  detectSqueeze, detectTriangle, detectFlag, detectStructures,
  candidates, structureState, levelBand, accepts,
  findConfirmation, entryAfter, buildSignal, gradeStrength,
  formatMessage, medianRange, DEFAULTS, PRESETS
} from './i1.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });
const flat = (n, mid, spread, T = T0, step = 60 * M) =>
  Array.from({ length: n }, (_, i) => bar(T + i * step, mid, mid + spread, mid - spread, mid));

// ---------------------------------------------------------------- 1 squeeze
console.log('\n1 · Squeeze — compression measured against its own history');
{
  // 240 bars of wide, noisy range, then 24 bars of tight box
  const wide = Array.from({ length: 260 }, (_, i) =>
    bar(T0 + i * 60 * M, 100, 100 + (i % 5 === 0 ? 6 : 4.5), 100 - (i % 7 === 0 ? 6 : 4.5), 100 + (i % 3 - 1) * 0.5));
  const tight = Array.from({ length: 26 }, (_, i) =>
    bar(T0 + (260 + i) * 60 * M, 100, 100.8, 99.4, 100.1));
  const bars = [...wide, ...tight];
  const s = detectSqueeze(bars);
  ok('squeeze detected', s.length === 1, JSON.stringify(s));
  ok('squeeze has no direction (both edges are triggers)', s[0]?.dir === 'both');
  ok('squeeze reports a percentile', typeof s[0]?.pct === 'number' && s[0].pct <= 10, s[0]?.pct);
  ok('squeeze box spans the tight range', s[0] && Math.abs((s[0].box.hi - s[0].box.lo) - 1.4) < 0.001);
  const wideOnly = detectSqueeze(wide);
  ok('wide tape is NOT a squeeze', wideOnly.length === 0);
}

// --------------------------------------------------------------- 2 triangle
console.log('\n2 · Triangle — flat ceiling, rising floor, converging gap');
{
  const bars = [];
  // ceiling pinned at 110; floor rising 96 → 106
  for (let i = 0; i < 60; i++) {
    const floor = 96 + (i / 59) * 10;
    bars.push(bar(T0 + i * 60 * M, floor + 1, i % 6 === 0 ? 110 : 109.6, floor, floor + 1.2));
  }
  const t = detectTriangle(bars);
  const asc = t.find(x => x.type === 'ASC TRIANGLE');
  ok('ascending triangle detected', !!asc, JSON.stringify(t.map(x => x.type)));
  ok('direction is long, from the shape', asc?.dir === 'long');
  ok('level is the flat ceiling', asc && Math.abs(asc.level - 110) < 0.001, asc?.level);
  ok('ceiling touches counted', asc && asc.touches >= 2, asc?.touches);
}

// ------------------------------------------------------------------- 3 flag
console.log('\n3 · Flag — trigger is the extreme CLOSE, not the extreme high');
{
  const legBars = Array.from({ length: 18 }, (_, i) => {
    const p = 100 + i * 0.8;
    return bar(T0 + i * 60 * M, p, p + 0.9, p - 0.4, p + 0.7);
  });
  // consolidation holds near the highs, with ONE spike wick to 121
  const cons = Array.from({ length: 10 }, (_, i) =>
    bar(T0 + (18 + i) * 60 * M, 114, i === 4 ? 121 : 115.2, 113.6, 114.8));
  const bars = [...flat(40, 100, 1), ...legBars, ...cons];
  const f = detectFlag(bars);
  const bull = f.find(x => x.type === 'BULL FLAG');
  ok('bull flag detected', !!bull, JSON.stringify(f));
  ok('trigger is a close (<=115.2), not the 121 wick', bull && bull.level <= 115.2, bull?.level);
  ok('trigger is NOT the consolidation high', bull && bull.level < 121);
}

// -------------------------------------------------- 4 arming / states / band
console.log('\n4 · Arming — distance to the level, and level identity');
{
  ok('far away is forming', structureState(5) === 'forming', structureState(5));
  ok('1% away is coiled', structureState(1.0) === 'coiled');
  ok('0.2% away is imminent', structureState(0.2) === 'imminent');
  ok('at or through the level is resolved', structureState(0) === 'resolved');

  const sq = { type: 'SQUEEZE', dir: 'both', box: { hi: 110, lo: 100 }, height: 10 };
  const c = candidates(sq, 109.5);
  ok('squeeze yields two candidate triggers', c.length === 2, c.length);
  ok('long candidate is the box top', c.find(x => x.dir === 'long')?.level === 110);
  ok('short candidate is the box bottom', c.find(x => x.dir === 'short')?.level === 100);

  // the measured duplicate problem: SOL fired at 105.13 and 105.03
  ok('105.13 and 105.03 are the SAME break (0.5% band)',
    levelBand(105.13) === levelBand(105.03), `${levelBand(105.13)} vs ${levelBand(105.03)}`);
  ok('a genuinely different level is a different band',
    levelBand(105.13) !== levelBand(110.4));
}

// ------------------------------------------------------------ 5 confirmation
console.log('\n5 · Confirmation — one strong candle, three conditions');
{
  const level = 105;
  const strong = bar(T0, 104.6, 105.9, 104.5, 105.8);   // closes above, CLV high, body big
  const weak = bar(T0, 104.6, 105.9, 104.5, 105.1);     // closes above but tiny body, low CLV
  const wickOnly = bar(T0, 104.6, 106.4, 104.5, 104.7); // pokes through, closes back under
  ok('strong candle ACCEPTS', accepts(strong, level, 'long'));
  ok('weak candle REJECTS', !accepts(weak, level, 'long'));
  ok('wick-through REJECTS', !accepts(wickOnly, level, 'long'));

  const shortStrong = bar(T0, 105.4, 105.5, 104.1, 104.2);
  ok('short direction mirrored correctly', accepts(shortStrong, level, 'short'));
}

// ------------------------------------------- 6 window, entry, build, format
console.log('\n6 · Window, entry, and the 7-field signal');
{
  const level = 105;
  const trade = [
    bar(T0 + 0 * 15 * M, 104.5, 104.9, 104.4, 104.8),            // 0 no
    bar(T0 + 1 * 15 * M, 104.8, 105.2, 104.7, 105.0),            // 1 no
    bar(T0 + 2 * 15 * M, 105.0, 105.9, 104.9, 105.8),            // 2 YES
    bar(T0 + 3 * 15 * M, 105.9, 106.2, 105.7, 106.0)             // 3 entry bar
  ];
  const conf = findConfirmation(trade, 0, level, 'long');
  ok('confirmation found at the right bar', conf && conf.index === 2, conf?.index);
  ok('bars waited counted', conf?.barsWaited === 3, conf?.barsWaited);
  const entry = entryAfter(trade, conf.index);
  ok('entry is the NEXT candle open', entry?.price === 105.9, entry?.price);

  const structure = { type: 'ASC TRIANGLE', dir: 'long', level, height: 6, note: 'x' };
  const cand = candidates(structure, 104.9).find(x => x.dir === 'long');
  const built = buildSignal({
    symbol: 'SOLUSDT', structure, candidate: cand, confirm: conf, entry,
    tradeBars: trade, nowMs: conf.candle.t + 15 * M
  });
  ok('signal built', !!built.signal, JSON.stringify(built));
  const s = built.signal;
  const fields = ['symbol', 'frames', 'pattern', 'direction', 'level', 'entry', 'strength'];
  ok('exactly the 7 fields present', fields.every(f => s[f] !== undefined), Object.keys(s).join(','));
  ok('frames read 1h → 15m', s.frames === '1h → 15m', s.frames);
  ok('direction came from the shape', s.direction === 'long');
  ok('strength is a letter+score tag', /^[A-D] [0-4]\/4$/.test(s.strength), s.strength);

  const msg = formatMessage(s, 'test');
  ok('message names the level', msg.includes('105'));
  ok('message states no stop / no target', /no stop, no target/i.test(msg));

  // duplicate band suppression is the caller's job, but the key must match
  ok('same break produces the same key',
    built.signal._meta.key === `${'ASC TRIANGLE'}:long:${levelBand(level)}`);
}

// ------------------------------------------------------- 7 gates vs tags
console.log('\n7 · Strength is a TAG — it must never suppress a signal');
{
  ok('default strengthMode is tag', DEFAULTS.strengthMode === 'tag');
  ok('no stop / target / expiry keys exist in DEFAULTS',
    !('stop' in DEFAULTS) && !('target' in DEFAULTS) && !('expiry' in DEFAULTS));
  const level = 100;
  const trade = [bar(T0, 99.5, 100.8, 99.4, 100.7), bar(T0 + 15 * M, 100.7, 101, 100.5, 100.9)];
  const conf = findConfirmation(trade, 0, level, 'long');
  const strength = gradeStrength(conf, level, 'long', trade);
  const structure = { type: 'SQUEEZE', dir: 'both', box: { hi: 100, lo: 92 }, height: 8 };
  const cand = candidates(structure, 99.9).find(x => x.dir === 'long');
  const gateAttempt = buildSignal({
    symbol: 'BTCUSDT', structure, candidate: cand, confirm: conf,
    entry: entryAfter(trade, conf.index), tradeBars: trade,
    config: { strengthMode: 'gate', minGradeToPrint: 4, strength: { ...DEFAULTS.strength, rangeMinRatio: 99 } }
  });
  ok('strength CAN gate if explicitly switched on', gateAttempt.silent === 'strength floor', gateAttempt.silent);
  ok('but it is off by default', DEFAULTS.strengthMode === 'tag');
  ok('grade computes a letter', ['A', 'B', 'C', 'D'].includes(strength.letter), strength.letter);
}

// ------------------------------------------------------------ 8 no ATR
console.log('\n8 · No ATR anywhere');
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('./i1.js', import.meta.url), 'utf8'));
  ok('the word ATR does not appear as a value', !/\batr\s*\(/i.test(src) && !/const\s+atr/i.test(src));
  ok('medianRange is the yardstick', typeof medianRange === 'function');
  ok('preset is 1h → 15m', PRESETS.I1.reading === '1h' && PRESETS.I1.trade === '15m');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
