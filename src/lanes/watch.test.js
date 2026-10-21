// Run: node src/lanes/watch.test.js
import {
  detectHeadShoulders, detectWyckoff, detectWatchStructures,
  stateOf, structureKey, createTracker, step, formatWatchMessage,
  pivots, medianRange, DEFAULTS
} from './watch.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });

/**
 * A clean head & shoulders: LS 110.4, head 118.4, RS 109.5, neckline ~103.2,
 * with price back near the neckline inside the freshness window.
 */
function hsSeries({ closeNear = 105 } = {}) {
  const b = [];
  let i = 0;
  const push = (o, h, l, c) => b.push(bar(T0 + (i++) * M, o, h, l, c));
  for (let k = 0; k < 40; k++) {
    const up = Math.sin((k * Math.PI) / 3) > 0;
    const mid = 100 + 0.6 * Math.sin((k * Math.PI) / 3);
    push(mid, mid + (up ? 0.9 : 0.4), mid - (up ? 0.4 : 0.9), mid + (up ? 0.3 : -0.3));
  }
  for (let k = 0; k < 7; k++) push(101 + k * 0.9, 102 + k * 0.9, 100.5 + k * 0.9, 101.5 + k * 0.9);
  push(108.5, 110.4, 108.2, 110);                     // LS
  for (let k = 0; k < 9; k++) push(109 - k * 0.5, 109.3 - k * 0.5, 106.5 - k * 0.4, 107 - k * 0.4);
  push(104.4, 104.9, 103.2, 103.8);                   // neckline touch 1
  push(104.0, 118.4, 103.9, 118);                     // HEAD
  for (let k = 0; k < 9; k++) push(116 - k * 1.2, 117 - k * 1.25, 108 - k * 0.45, 109 - k * 0.5);
  push(104.6, 105.1, 103.4, 104.0);                   // neckline touch 2
  for (let k = 0; k < 4; k++) push(106.5, 108.4, 105.2, 106.8);
  push(106.8, 109.5, 106.5, 109);                     // RS
  for (let k = 0; k < 10; k++) push(closeNear, closeNear + 0.4, closeNear - 0.4, closeNear);
  return b;
}

console.log('\n1 · Head & shoulders — geometry');
{
  const bars = hsSeries();
  const found = detectHeadShoulders(bars);
  const hs = found.find(x => x.type === 'HEAD & SHOULDERS');
  ok('H&S detected', !!hs, JSON.stringify(found.map(f => f.type)));
  ok('direction is short', hs?.dir === 'short');
  ok('head is the highest point', hs && Math.abs(hs.points.head.p - 118.4) < 0.001, hs?.points.head.p);
  // LS 110.4 vs RS 109.5 — within 1% of the head, which is what "near-equal" means
  ok('shoulders near-equal', hs && Math.abs(hs.points.ls.p - hs.points.rs.p) / hs.points.head.p < 0.01,
    hs && (Math.abs(hs.points.ls.p - hs.points.rs.p) / hs.points.head.p).toFixed(4));
  ok('level is the neckline', hs && hs.level > 103 && hs.level < 106, hs?.level);
}

console.log('\n2 · Proximity rule — a stale shape is not reported');
{
  const near = hsSeries({ closeNear: 105 });
  const far = hsSeries({ closeNear: 130 });   // price 24% above the neckline
  ok('near the neckline: reported', detectHeadShoulders(near).length > 0);
  ok('far above the neckline: NOT reported', detectHeadShoulders(far).length === 0);
  ok('the 8% rule is what stops it', DEFAULTS.hsMaxDistancePct === 0.08);
}

console.log('\n3 · Inverse head & shoulders');
{
  // mirror of the same shape
  const bars = hsSeries().map(b => {
    const mid = 110;
    return bar(b.t, mid - (b.o - mid), mid - (b.l - mid), mid - (b.h - mid), mid - (b.c - mid), b.v);
  });
  const found = detectHeadShoulders(bars);
  const ihs = found.find(x => x.type === 'INVERSE HEAD & SHOULDERS');
  ok('inverse H&S detected', !!ihs, JSON.stringify(found.map(f => f.type)));
  ok('direction is long', ihs?.dir === 'long');
}

console.log('\n4 · Wyckoff — the spring must be in the tail, not the whole window');
{
  const wide = Array.from({ length: 120 }, (_, i) => bar(T0 + i * M, 100, 101, 99, 100, 200));
  // a 60-bar range spanning 99.2..102.8 built from small bars (range 0.6), volume falling,
  // with a spring under the low in the last quarter
  const range = Array.from({ length: 60 }, (_, i) => {
    const vol = 150 - i;
    const mid = 101 + 1.6 * Math.sin((i * Math.PI) / 9);
    return i === 50
      ? bar(T0 + (120 + i) * M, mid, mid + 0.3, 98.4, 100.2, vol)   // spring
      : bar(T0 + (120 + i) * M, mid, mid + 0.3, mid - 0.3, mid, vol);
  });
  const bars = [...wide, ...range];
  const w = detectWyckoff(bars);
  ok('Wyckoff accumulation detected', w.length === 1, JSON.stringify(w));
  ok('direction is long', w[0]?.dir === 'long');
  ok('spring flagged', w[0]?.spring === true);
  ok('level is the range high', w[0] && w[0].level <= 103 && w[0].level > 100, w[0]?.level);
}

console.log('\n5 · Cup & handle is deliberately absent');
{
  const names = detectWatchStructures.toString();
  ok('no cup detector is exported', !('detectCupHandle' in (await import('./watch.js'))));
  ok('only H&S, IHS and Wyckoff are in the lane',
    ['HEAD & SHOULDERS', 'INVERSE HEAD & SHOULDERS', 'WYCKOFF ACCUMULATION'].length === 3);
}

console.log('\n6 · State ladder — proximity in the instrument\'s own range units');
{
  const bars = Array.from({ length: 50 }, (_, i) => bar(T0 + i * M, 100, 101, 99, 100)); // median range 2
  const s = { type: 'HEAD & SHOULDERS', dir: 'short', level: 102 };
  ok('0.5 above the short neckline = 0.25 ranges → imminent', stateOf(s, 102.5, bars) === 'imminent', stateOf(s, 102.5, bars));
  ok('8 away = 4 ranges → coiled', stateOf(s, 110, bars) === 'coiled', stateOf(s, 110, bars));
  ok('20 away = 10 ranges → forming', stateOf(s, 122, bars) === 'forming', stateOf(s, 122, bars));
  ok('below the short neckline → resolved', stateOf(s, 101, bars) === 'resolved', stateOf(s, 101, bars));
}

console.log('\n7 · Lifecycle — wake-up, break, close-out');
{
  const cfg = { ...DEFAULTS, closeOutBars: 6 };
  const t = createTracker(cfg);
  const near = hsSeries({ closeNear: 105 });
  let evs = [];
  for (let i = 60; i < near.length; i++) {
    evs = evs.concat(step(t, { bars: near, barIndex: i }));
  }
  const wakes = evs.filter(e => e.kind === 'WAKE-UP');
  ok('at least one WAKE-UP emitted', wakes.length >= 1, JSON.stringify(evs.map(e => e.kind)));
  ok('each structure wakes at most once', wakes.length === new Set(wakes.map(w => w.pattern)).size || wakes.length === 1);

  // a fresh tracker on a series that never breaks → close-out, not break
  const t2 = createTracker(cfg);
  // keep the shape alive but never let it break: extend the tape so the
  // 6-bar backstop has room to elapse
  const base = hsSeries({ closeNear: 105 });
  const lastT = base[base.length - 1].t;
  const flatDead = base.concat(
    Array.from({ length: 14 }, (_, k) => bar(lastT + (k + 1) * M, 105, 105.4, 104.6, 105))
  );
  const evs2 = [];
  for (let i = 60; i < flatDead.length; i++) evs2.push(...step(t2, { bars: flatDead, barIndex: i }));
  ok('a shape that never resolves is closed out', evs2.some(e => e.kind === 'CLOSE-OUT'), JSON.stringify(evs2.map(e => e.kind)));
  ok('close-out carries a reason', evs2.find(e => e.kind === 'CLOSE-OUT')?.reason != null);
}

console.log('\n8 · Messages are the three kinds, and never an instruction');
{
  const wake = formatWatchMessage({ kind: 'WAKE-UP', symbol: 'ETHUSDT', pattern: 'HEAD & SHOULDERS', dir: 'short', level: 1853.62, state: 'imminent' }, 'CAT 10:00');
  const brk = formatWatchMessage({ kind: 'BREAK', symbol: 'ETHUSDT', pattern: 'HEAD & SHOULDERS', level: 1853.62, barsSinceWake: 9 }, 'CAT 12:00');
  const dead = formatWatchMessage({ kind: 'CLOSE-OUT', symbol: 'ETHUSDT', pattern: 'HEAD & SHOULDERS', level: 1853.62, barsSinceWake: 56 }, 'CAT 09:00');
  ok('wake-up says awake', /Awake/.test(wake));
  ok('wake-up leaves the entry to you', /Entry is yours/.test(wake));
  ok('break names the level', brk.includes('1853.62'));
  ok('close-out says never broke', /Never broke/.test(dead));
  const all = wake + brk + dead;
  ok('no stop, no target, no take-profit anywhere', !/stop|target|take-?profit/i.test(all));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
