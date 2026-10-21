// ============================================================================
// lab — the silent measurement lane.
// SPEC v1.0.0 — FROZEN.
//
// ISOLATION CONTRACT
//   • Imports nothing. Reads candles; writes rows.
//   • NOTHING IMPORTS THIS FILE, AND NOTHING HERE CAN SEND A MESSAGE.
//     There is deliberately no formatter and no notify function in this module.
//
// WHAT IT DOES
//   Every armed structure is evaluated against every confirmation idea. Each
//   idea is scored against an ARTIFICIAL take profit equal to a multiple of the
//   pattern's own measured move — 1.0× by default, because measured, 0.5× is
//   reached less often than the opposite move of the same size, and 1.5× is
//   reached only 8% of the time.
//
// THE ARTIFICIAL TP IS A RULER, NOT A TRADE
//   It exists so nine ideas can be compared on a fixed finish line. It must
//   never appear in a notification, an exit decision, or a live lane. If it
//   ever does, it has become a target — which is forbidden.
// ============================================================================

export const SPEC_VERSION = '1.0.0';

export const DEFAULTS = {
  tpMult: 1.0,               // × the pattern's own measured move
  horizonBars: 96,           // 24 hours of 15m bars
  windowBars: 16,            // 4 hours to produce a trigger
  bodyRealMin: 0.30,
  dispMult: 0.25,            // displacement in units of the median 15m range
  disp2Mult: 0.35,
  rangeMedLookback: 20
};

const ok = v => typeof v === 'number' && isFinite(v);

export function median(arr) {
  const a = arr.filter(ok).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const beyond = (c, level, dir) => (dir === 'long' ? c.c > level : c.c < level);

const dirBody = (c, dir, min = DEFAULTS.bodyRealMin) => {
  const r = c.h - c.l;
  if (r <= 0) return false;
  const b = ((c.c - c.o) / r) * (dir === 'long' ? 1 : -1);
  return b >= min;
};

const strongCandle = (c, level, dir) => {
  const r = c.h - c.l;
  if (r <= 0) return false;
  const clv = dir === 'long' ? (c.c - c.l) / r : (c.h - c.c) / r;
  const body = Math.abs(c.c - c.o) / r;
  return beyond(c, level, dir) && clv >= 0.65 && body >= 0.5;
};

const medRangeAt = (bars, i, n = DEFAULTS.rangeMedLookback) =>
  median(bars.slice(Math.max(0, i - n), i).map(b => b.h - b.l)) || 1e-9;

// --- the nine confirmation ideas -------------------------------------------
// Each takes (tradeBars, fromIndex, level, dir) and returns the index of the
// confirming candle, or null. They are pure functions of the trade frame.
export const VARIANTS = {
  A_strict_single: (b, j, l, d) => {
    for (let i = j; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (strongCandle(b[i], l, d)) return i;
    }
    return null;
  },
  B_two_closes: (b, j, l, d) => {
    for (let i = j + 1; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (beyond(b[i], l, d) && beyond(b[i - 1], l, d)) return i;
    }
    return null;
  },
  C_two_closes_bodies: (b, j, l, d) => {
    for (let i = j + 1; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (beyond(b[i], l, d) && beyond(b[i - 1], l, d) && dirBody(b[i], d) && dirBody(b[i - 1], d)) return i;
    }
    return null;
  },
  D_two_of_three: (b, j, l, d) => {
    for (let i = j + 2; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      const n = [0, 1, 2].filter(k => beyond(b[i - k], l, d)).length;
      if (n >= 2 && beyond(b[i], l, d)) return i;
    }
    return null;
  },
  E_hold_after: (b, j, l, d) => {
    for (let i = j; i < Math.min(j + DEFAULTS.windowBars - 1, b.length - 1); i++) {
      if (beyond(b[i], l, d) && beyond(b[i + 1], l, d)) return i + 1;
    }
    return null;
  },
  F_softer_single: (b, j, l, d) => {
    for (let i = j; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (strongCandle(b[i], l, d) || (beyond(b[i], l, d) && dirBody(b[i], d))) return i;
    }
    return null;
  },
  G_displacement: (b, j, l, d) => {
    for (let i = j; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (beyond(b[i], l, d) && Math.abs(b[i].c - l) >= DEFAULTS.dispMult * medRangeAt(b, i)) return i;
    }
    return null;
  },
  H_two_candle_displacement: (b, j, l, d) => {
    for (let i = j + 1; i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (beyond(b[i], l, d) && Math.abs(b[i].c - l) >= DEFAULTS.disp2Mult * medRangeAt(b, i)) return i;
    }
    return null;
  },
  I_body_plus_displacement: (b, j, l, d) => {
    // needs a previous bar to measure displacement from
    for (let i = Math.max(1, j); i < Math.min(j + DEFAULTS.windowBars, b.length - 1); i++) {
      if (beyond(b[i], l, d) && dirBody(b[i], d) &&
          Math.abs(b[i].c - b[i - 1].c) >= 0.5 * medRangeAt(b, i)) return i;
    }
    return null;
  }
};

export const VARIANT_NAMES = Object.keys(VARIANTS);

// --- artificial take profit ------------------------------------------------
export function artificialTp(entry, height, dir, tpMult = DEFAULTS.tpMult) {
  if (!ok(entry) || !ok(height) || height <= 0) return null;
  const dist = height * tpMult;
  return dir === 'long' ? entry + dist : entry - dist;
}

/**
 * Walk forward and classify the outcome against the artificial ruler.
 *   'tp'       the ruler was reached first
 *   'opposite' the same-size move against us came first
 *   'both'     both inside one bar — unresolvable, counted as a half
 *   'open'     neither inside the horizon
 */
export function classify({ tradeBars, entryIndex, entry, height, dir, tpMult = DEFAULTS.tpMult, horizonBars = DEFAULTS.horizonBars }) {
  const tp = artificialTp(entry, height, dir, tpMult);
  if (tp == null) return { outcome: 'invalid', tp: null };
  const dist = height * tpMult;
  const opp = dir === 'long' ? entry - dist : entry + dist;
  const end = Math.min(entryIndex + horizonBars, tradeBars.length);
  for (let i = entryIndex; i < end; i++) {
    const c = tradeBars[i];
    const hitTp = dir === 'long' ? c.h >= tp : c.l <= tp;
    const hitOpp = dir === 'long' ? c.l <= opp : c.h >= opp;
    if (hitTp && hitOpp) return { outcome: 'both', tp, bars: i - entryIndex + 1 };
    if (hitTp) return { outcome: 'tp', tp, bars: i - entryIndex + 1 };
    if (hitOpp) return { outcome: 'opposite', tp, bars: i - entryIndex + 1 };
  }
  return { outcome: 'open', tp, bars: null };
}

/**
 * Score one structure against every variant. Returns an array of rows, one per
 * variant that produced a trigger. Rows are journal entries — never messages.
 */
export function scoreStructure({ symbol, structure, candidate, tradeBars, fromIndex, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  const rows = [];
  const height = structure && structure.height;
  if (!structure || !candidate || !ok(height) || height <= 0) return rows;
  for (const name of VARIANT_NAMES) {
    const idx = VARIANTS[name](tradeBars, fromIndex, candidate.level, candidate.dir);
    if (idx == null) continue;
    const entryBar = tradeBars[idx + 1];
    if (!entryBar) continue;
    const res = classify({
      tradeBars, entryIndex: idx + 1, entry: entryBar.o,
      height, dir: candidate.dir, tpMult: c.tpMult, horizonBars: c.horizonBars
    });
    rows.push({
      lane: 'lab',
      symbol,
      pattern: structure.type,
      direction: candidate.dir,
      level: candidate.level,
      variant: name,
      confirmedMs: tradeBars[idx].t,
      entry: entryBar.o,
      artificialTp: res.tp,
      tpMult: c.tpMult,
      measuredMove: height,
      outcome: res.outcome,
      bars: res.bars ?? null,
      notified: false            // this lane never notifies — recorded for audit
    });
  }
  return rows;
}

/** Aggregate rows into a variant scoreboard. */
export function summarise(rows) {
  const byVariant = {};
  for (const r of rows) {
    const v = (byVariant[r.variant] ||= { variant: r.variant, n: 0, tp: 0, opposite: 0, both: 0, open: 0 });
    v.n++;
    v[r.outcome] = (v[r.outcome] || 0) + 1;
  }
  return Object.values(byVariant).map(v => {
    const decided = v.tp + v.opposite + v.both;
    const wins = v.tp + v.both * 0.5;
    return {
      ...v,
      decided,
      winRate: decided ? wins / decided : null,
      edge: decided ? (2 * (wins / decided) - 1) : null
    };
  });
}
