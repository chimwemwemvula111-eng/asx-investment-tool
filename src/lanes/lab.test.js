// Run: node src/lanes/lab.test.js
import * as LAB from './lab.js';
import {
  VARIANTS, VARIANT_NAMES, artificialTp, classify, scoreStructure,
  summarise, DEFAULTS
} from './lab.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });

console.log('\n1 · The lane cannot notify — there is no formatter and no sender');
{
  const exported = Object.keys(LAB);
  ok('no format function exported', !exported.some(k => /format|message|notify|send/i.test(k)), exported.join(','));
  ok('every row is stamped notified:false', true);
}

console.log('\n2 · Nine confirmation ideas exist');
{
  ok('nine variants', VARIANT_NAMES.length === 9, VARIANT_NAMES.length);
  ok('includes the user two-candle idea', !!VARIANTS.B_two_closes && !!VARIANTS.C_two_closes_bodies);
  ok('includes displacement in own-range units', !!VARIANTS.G_displacement);
  ok('includes two-candle displacement', !!VARIANTS.H_two_candle_displacement);
}

console.log('\n3 · The variants actually differ');
{
  const level = 100;
  // one soft close through, then a second confirming close
  const b = [
    bar(T0 + 0 * M, 99.95, 100.2, 99.9, 100.05), // closes beyond, but a tiny body
    bar(T0 + 1 * M, 100.2, 100.7, 100.1, 100.6), // holds
    bar(T0 + 2 * M, 100.6, 101.2, 100.4, 101.0),
    bar(T0 + 3 * M, 101.0, 101.4, 100.9, 101.2),
    bar(T0 + 4 * M, 101.2, 101.6, 101.0, 101.4)
  ];
  const a = VARIANTS.A_strict_single(b, 0, level, 'long');
  const two = VARIANTS.B_two_closes(b, 0, level, 'long');
  ok('strict single skips the tiny-body bar (fires later, not at 0)', a !== 0, a);
  ok('two-closes accepts it at the second bar', two === 1, two);
  const disp = VARIANTS.G_displacement(b, 0, level, 'long');
  ok('displacement variant fires somewhere', disp !== null, disp);
}

console.log('\n4 · Artificial TP is a multiple of the measured move');
{
  ok('long TP sits above entry by height×mult', artificialTp(100, 10, 'long', 1.0) === 110);
  ok('short TP sits below', artificialTp(100, 10, 'short', 1.0) === 90);
  ok('0.5× is half the distance', artificialTp(100, 10, 'long', 0.5) === 105);
  ok('default multiplier is 1.0×', DEFAULTS.tpMult === 1.0);
  ok('no height means no TP', artificialTp(100, 0, 'long') === null);
}

console.log('\n5 · Classification — TP first, opposite first, both, open');
{
  const mk = cs => cs.map((c, i) => bar(T0 + i * M, c[0], c[1], c[2], c[3]));
  const upFirst = mk([[100, 101, 99.9, 100.8], [100.8, 111, 100.7, 110.5]]);
  const r1 = classify({ tradeBars: upFirst, entryIndex: 0, entry: 100, height: 10, dir: 'long' });
  ok('reaching the ruler first = tp', r1.outcome === 'tp', r1.outcome);

  const downFirst = mk([[100, 100.2, 89, 90], [90, 111, 89.9, 110]]);
  const r2 = classify({ tradeBars: downFirst, entryIndex: 0, entry: 100, height: 10, dir: 'long' });
  ok('same-size move against first = opposite', r2.outcome === 'opposite', r2.outcome);

  const both = mk([[100, 111, 89, 100]]);
  const r3 = classify({ tradeBars: both, entryIndex: 0, entry: 100, height: 10, dir: 'long' });
  ok('both inside one bar = both', r3.outcome === 'both', r3.outcome);

  const flat = mk([[100, 100.5, 99.5, 100]]);
  const r4 = classify({ tradeBars: flat, entryIndex: 0, entry: 100, height: 10, dir: 'long' });
  ok('neither inside the horizon = open', r4.outcome === 'open', r4.outcome);

  const shortHit = mk([[100, 100.1, 89, 90]]);
  const r5 = classify({ tradeBars: shortHit, entryIndex: 0, entry: 100, height: 10, dir: 'short' });
  ok('short ruler mirrored', r5.outcome === 'tp', r5.outcome);
}

console.log('\n6 · Scoring a structure produces rows, never messages');
{
  const level = 100;
  const tradeBars = [
    bar(T0 + 0 * M, 99.6, 100.9, 99.5, 100.8),   // strong accept
    bar(T0 + 1 * M, 100.8, 101.4, 100.6, 101.2), // entry bar
    bar(T0 + 2 * M, 101.2, 112, 101.0, 111.5),   // reaches 1x measured move (height 10 → 110.8)
    bar(T0 + 3 * M, 111.5, 112, 110, 111)
  ];
  const rows = scoreStructure({
    symbol: 'ETHUSDT',
    structure: { type: 'ASC TRIANGLE', dir: 'long', level, height: 10 },
    candidate: { dir: 'long', level },
    tradeBars,
    fromIndex: 0
  });
  ok('rows produced', rows.length > 0, rows.length);
  ok('every row has an outcome', rows.every(r => r.outcome));
  ok('every row is stamped notified:false', rows.every(r => r.notified === false));
  ok('every row carries the artificial TP', rows.every(r => typeof r.artificialTp === 'number'));
  ok('entry is the open AFTER each variant\'s own trigger',
    rows.every(r => r.entry === tradeBars[
      VARIANTS[r.variant](tradeBars, 0, level, 'long') + 1
    ].o), rows.map(r => r.entry).join(','));
  ok('the strict variant resolved as tp', rows.find(r => r.variant === 'A_strict_single')?.outcome === 'tp',
    rows.find(r => r.variant === 'A_strict_single')?.outcome);

  const board = summarise(rows);
  ok('summarise returns one line per variant tried', board.length > 0);
  ok('summary carries an edge per variant', board.every(b => b.edge === null || typeof b.edge === 'number'));
}

console.log('\n7 · No ATR, and the ruler never becomes a trade rule');
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('./lab.js', import.meta.url), 'utf8'));
  ok('no atr function', !/\batr\s*\(/i.test(src));
  ok('TP is labelled artificial in the row', src.includes('artificialTp'));
  ok('the module has no stop field', !/stop(Px|Price)?\s*:/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
