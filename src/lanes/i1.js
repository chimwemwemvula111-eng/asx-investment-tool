// ============================================================================
// i1 — the intraday two-frame lane. 1h reading → 15m trade.
// SPEC v1.0.0 — FROZEN. See ./I1-SPEC.md.
//
// ISOLATION CONTRACT
//   • This file imports nothing. No dependency on ../core/* or ../scalp/*.
//   • Nothing in the existing engine imports this file.
//   • Reading another lane's state is forbidden. Same candles in, different
//     expression out.
//
// THE RULE, IN ONE PARAGRAPH
//   The READING frame (1h) finds a structure and yields exactly two things:
//   a DIRECTION and a LEVEL. It never decides whether to trade. The TRADE
//   frame (15m) supplies the trigger: one candle that closes beyond the level,
//   closes in the far third of its own range, and has a body at least half that
//   range. Entry is the open of the next 15m candle. There is no stop, no
//   target and no expiry — the level is the invalidation reference and the exit
//   is manual. Strength is computed and printed as a TAG; it never blocks.
//
// NO ATR ANYWHERE. Every "is this big" question is answered against the
// instrument's own recent median range or its own percentile history.
// ============================================================================

export const SPEC_VERSION = '1.0.0';

export const PRESETS = {
  I1: {
    id: 'I1', label: 'I1 · 1h → 15m',
    reading: '1h', trade: '15m',
    readingMs: 60 * 60_000, tradeMs: 15 * 60_000
  }
};

export const DEFAULTS = {
  // --- arming -------------------------------------------------------------
  armGapPct: 1.20,      // structure is watched once price is within 1.20% of the level
  imminentGapPct: 0.30, // and "imminent" inside 0.30%
  confirmWindowBars: 16, // 4 hours of 15m bars to produce the trigger

  // --- trade-frame confirmation (the ONLY thing that creates a signal) -----
  clvMin: 0.65,
  bodyMin: 0.50,

  // --- structure geometry (all self-referential, no ATR) -------------------
  squeezeWin: 24, squeezeLook: 240, squeezePctMax: 10,
  triangleWin: 60, triangleConvergence: 0.70,
  flagLeg: 18, flagCons: 10, flagPoleMinRanges: 4, flagMaxConsRatio: 0.45,

  // --- duplicate suppression ---------------------------------------------
  // One signal per level band. 0.5% — measured: at 0.2% the same break fired
  // twice on SOL at 105.13 and 105.03.
  levelBandPct: 0.005,
  lockReadingBars: 50,

  // --- strength (a TAG, never a gate) -------------------------------------
  strengthMode: 'tag',
  strength: { clvMin: 0.65, bodyMin: 0.50, rangeMinRatio: 0.80, penetrationMin: 0.10 },
  rangeMedLookback: 20,
  minGradeToPrint: 2,   // A 4/4 · B 3/4 · C 2/4 · D ≤1

  // --- data validity: the only hard gate ----------------------------------
  maxBarAgeBars: 2
};

// --- helpers ---------------------------------------------------------------
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const ok = v => num(v) !== null;

export function median(arr) {
  const a = arr.filter(v => typeof v === 'number' && isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function medianRange(bars, n = 40) {
  if (!bars || !bars.length) return null;
  const seg = bars.slice(-n);
  return median(seg.map(b => b.h - b.l));
}

export function percentileRank(values, v) {
  const a = values.filter(ok);
  if (!a.length) return 100;
  return (100 * a.filter(x => x <= v).length) / a.length;
}

export function candleMetrics(c) {
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o);
  const safe = range > 0 ? range : 0;
  return {
    range,
    body,
    bodyRatio: safe ? body / safe : 0,
    closePosBull: safe ? (c.c - c.l) / safe : 0.5,
    closePosBear: safe ? (c.h - c.c) / safe : 0.5
  };
}

// --- structure detectors (READING frame, 1h) -------------------------------
// Every detector returns { type, dir, level, height, note }.
// dir is 'long' | 'short' | 'both'. 'both' is the squeeze: the shape carries
// no direction, so both edges are candidate triggers and the TRADE frame
// decides which one matters.

/**
 * Compression. Band width of the last `win` bars against the distribution of
 * every rolling `win`-bar width in the preceding `look` bars.
 */
export function detectSqueeze(bars, cfg = DEFAULTS) {
  const { squeezeWin: win, squeezeLook: look, squeezePctMax } = cfg;
  if (!bars || bars.length < look + win) return [];
  const w = bars.slice(-win);
  const hi = Math.max(...w.map(b => b.h));
  const lo = Math.min(...w.map(b => b.l));
  const cur = hi - lo;
  if (!(cur > 0)) return [];
  const widths = [];
  for (let k = bars.length - look; k < bars.length - win; k++) {
    const seg = bars.slice(k, k + win);
    widths.push(Math.max(...seg.map(b => b.h)) - Math.min(...seg.map(b => b.l)));
  }
  const pct = percentileRank(widths, cur);
  if (pct > squeezePctMax) return [];
  return [{
    type: 'SQUEEZE', dir: 'both',
    level: hi, level2: lo, height: cur,
    pct: Math.round(pct * 10) / 10,
    box: { hi, lo },
    note: `range at the ${pct.toFixed(0)}th percentile of ${look} windows`
  }];
}

/**
 * Ascending / descending triangle. A flat boundary tested twice or more, with
 * the opposite boundary travelling toward it and the gap shrinking.
 */
export function detectTriangle(bars, cfg = DEFAULTS) {
  const win = cfg.triangleWin;
  if (!bars || bars.length < win) return [];
  const w = bars.slice(-win);
  const cut = Math.floor(win * 0.66);
  const early = Math.floor(win * 0.33);
  const out = [];

  const ceiling = Math.max(...w.slice(0, cut).map(b => b.h));
  const floorFirst = Math.min(...w.slice(0, early).map(b => b.l));
  const floorLast = Math.min(...w.slice(cut).map(b => b.l));
  const ceilTol = ceiling * 0.0025;
  const ceilTouches = w.filter(b => Math.abs(b.h - ceiling) <= ceilTol).length;
  if (ceilTouches >= 2 && floorLast > floorFirst &&
      (ceiling - floorLast) <= (ceiling - floorFirst) * cfg.triangleConvergence) {
    out.push({
      type: 'ASC TRIANGLE', dir: 'long', level: ceiling,
      height: ceiling - Math.min(...w.map(b => b.l)),
      touches: ceilTouches,
      note: `flat ceiling, ${ceilTouches} touches, floor rising`
    });
  }

  const floor = Math.min(...w.map(b => b.l));
  const ceilFirst = Math.max(...w.slice(0, early).map(b => b.h));
  const ceilLast = Math.max(...w.slice(cut).map(b => b.h));
  const floorTol = floor * 0.0025;
  const floorTouches = w.filter(b => Math.abs(b.l - floor) <= floorTol).length;
  if (floorTouches >= 2 && ceilLast < ceilFirst &&
      (ceilLast - floor) <= (ceilFirst - floor) * cfg.triangleConvergence) {
    out.push({
      type: 'DESC TRIANGLE', dir: 'short', level: floor,
      height: Math.max(...w.map(b => b.h)) - floor,
      touches: floorTouches,
      note: `flat floor, ${floorTouches} touches, ceiling falling`
    });
  }
  return out;
}

/**
 * Flag: an impulse leg, then a tight consolidation holding in the direction of
 * the leg.
 *
 * THE TRIGGER IS THE CONSOLIDATION'S EXTREME *CLOSE*, NOT ITS EXTREME HIGH.
 * A high is a wick — the price point the market is least obliged to revisit.
 * Measured on 52 days of BTC/ETH/SOL: with a high-based trigger only 9% of
 * armed bull flags ever had their level crossed; with a close-based trigger
 * 28% did. The mechanical break was being defined against a rejected spike.
 */
const maxClose = bs => Math.max(...bs.map(b => b.c));
const minClose = bs => Math.min(...bs.map(b => b.c));

export function detectFlag(bars, cfg = DEFAULTS) {
  const { flagLeg: leg, flagCons: cons } = cfg;
  if (!bars || bars.length < leg + cons + 5) return [];
  const R = medianRange(bars);
  if (!R) return [];
  const legBars = bars.slice(-(leg + cons), -cons);
  const consBars = bars.slice(-cons);
  const lh = Math.max(...legBars.map(b => b.h));
  const ll = Math.min(...legBars.map(b => b.l));
  if ((lh - ll) < cfg.flagPoleMinRanges * R) return [];

  // The consolidation is measured on CLOSES. A single rejection wick must not
  // disqualify an otherwise tight flag — the closes are where the market agreed.
  const ch = Math.max(...consBars.map(b => b.c));
  const cl = Math.min(...consBars.map(b => b.c));
  if ((ch - cl) > (lh - ll) * cfg.flagMaxConsRatio) return [];

  const trigUp = maxClose(consBars);   // CLOSE, not high
  const trigDown = minClose(consBars); // CLOSE, not low
  const move = consBars[consBars.length - 1].c - legBars[0].c;   // + = up leg

  if (move > 0 && cl >= ll + (lh - ll) * 0.4) {
    return [{
      type: 'BULL FLAG', dir: 'long', level: trigUp, height: lh - ll,
      note: 'impulse, then a tight hold near the highs'
    }];
  }
  if (move < 0 && ch <= ll + (lh - ll) * 0.6) {
    return [{
      type: 'BEAR FLAG', dir: 'short', level: trigDown, height: lh - ll,
      note: 'drop, then a tight hold near the lows'
    }];
  }
  return [];
}

export function detectStructures(bars, cfg = DEFAULTS) {
  if (!bars || bars.length < 60) return [];
  return [
    ...detectSqueeze(bars, cfg),
    ...detectTriangle(bars, cfg),
    ...detectFlag(bars, cfg)
  ];
}

// --- arming: turn a structure into candidate (direction, level) pairs ------
export function candidates(structure, price) {
  if (!structure || !ok(price) || price <= 0) return [];
  const dirs = structure.dir === 'both' ? ['long', 'short'] : [structure.dir];
  const out = [];
  for (const d of dirs) {
    let level;
    if (structure.dir === 'both') level = d === 'long' ? structure.box.hi : structure.box.lo;
    else level = structure.level;
    if (!ok(level) || level <= 0) continue;
    const gapPct = d === 'long'
      ? ((level - price) / price) * 100
      : ((price - level) / price) * 100;
    out.push({
      dir: d, level,
      gapPct: Math.max(0, gapPct),
      band: levelBand(level),
      state: structureState(Math.max(0, gapPct))
    });
  }
  return out;
}

export function structureState(gapPct, cfg = DEFAULTS) {
  if (gapPct <= 0) return 'resolved';
  if (gapPct <= cfg.imminentGapPct) return 'imminent';
  if (gapPct <= cfg.armGapPct) return 'coiled';
  return 'forming';
}

/** Level identity: 0.5% bands. Two levels in the same band are the same break. */
export function levelBand(level, bandPct = DEFAULTS.levelBandPct) {
  if (!ok(level) || level <= 0) return 0;
  return Math.round(Math.log(level) / Math.log(1 + bandPct));
}

export function structureKey(structure, dir, level, cfg = DEFAULTS) {
  return `${structure.type}:${dir}:${levelBand(level, cfg.levelBandPct)}`;
}

// --- the trade-frame trigger ----------------------------------------------
/**
 * Does this 15m candle accept the level? Three conditions on the SAME candle:
 *   • it closes beyond the level
 *   • it closes in the far third of its own range (in the trade's direction)
 *   • its body is at least half that range
 */
export function accepts(candle, level, dir, cfg = DEFAULTS) {
  if (!candle) return false;
  const m = candleMetrics(candle);
  if (m.range <= 0) return false;
  if (dir === 'long') {
    return candle.c > level && m.closePosBull >= cfg.clvMin && m.bodyRatio >= cfg.bodyMin;
  }
  return candle.c < level && m.closePosBear >= cfg.clvMin && m.bodyRatio >= cfg.bodyMin;
}

/**
 * Search the trade frame for the first accepting candle.
 * Starts at `fromIndex` (the first 15m bar opening after the reading candle
 * closed) and looks at most `confirmWindowBars` bars ahead.
 */
export function findConfirmation(tradeBars, fromIndex, level, dir, cfg = DEFAULTS) {
  if (!tradeBars || fromIndex == null || fromIndex < 0) return null;
  const end = Math.min(fromIndex + cfg.confirmWindowBars, tradeBars.length - 1);
  for (let i = fromIndex; i < end; i++) {
    if (accepts(tradeBars[i], level, dir, cfg)) {
      return {
        index: i,
        candle: tradeBars[i],
        metrics: candleMetrics(tradeBars[i]),
        barsWaited: i - fromIndex + 1
      };
    }
  }
  return null;
}

/** Entry is the open of the candle AFTER the trigger. */
export function entryAfter(tradeBars, confirmIndex) {
  const next = tradeBars[confirmIndex + 1];
  return next ? { price: next.o, ms: next.t } : null;
}

// --- strength: four independent checks, a TAG ------------------------------
export function gradeStrength(confirm, level, dir, tradeBars, cfg = DEFAULTS) {
  const s = cfg.strength;
  const m = confirm.metrics;
  const closesInDir = dir === 'long' ? m.closePosBull : m.closePosBear;
  const ranges = (tradeBars || []).slice(-cfg.rangeMedLookback - 1, -1).map(b => b.h - b.l);
  const medR = median(ranges) || m.range;
  const penetration = m.range > 0
    ? Math.abs(confirm.candle.c - level) / m.range
    : 0;
  const checks = {
    clv: closesInDir >= s.clvMin,
    body: m.bodyRatio >= s.bodyMin,
    range: medR > 0 ? m.range / medR >= s.rangeMinRatio : false,
    penetration: penetration >= s.penetrationMin
  };
  const score = Object.values(checks).filter(Boolean).length;
  const letter = score >= 4 ? 'A' : score >= 3 ? 'B' : score >= 2 ? 'C' : 'D';
  return { score, letter, checks, penetration };
}

// --- the 7-field signal ----------------------------------------------------
export const SIGNAL_FIELDS = [
  'symbol', 'frames', 'pattern', 'direction', 'level',
  'entry', 'strength'
];

/**
 * Build the signal object. Returns { signal } or { silent: reason }.
 * Nothing here can suppress a valid break — the only silences are: no
 * structure, price too far from the level, no confirmation, duplicate band.
 */
export function buildSignal({
  symbol,
  structure,
  candidate,
  confirm,
  entry,
  tradeBars,
  nowMs,
  config = {}
}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!structure) return { silent: 'no structure' };
  if (!candidate) return { silent: 'no candidate' };
  if (candidate.gapPct > cfg.armGapPct) return { silent: 'level too far' };
  if (!confirm) return { silent: 'no confirmation' };
  if (!entry) return { silent: 'no entry bar' };
  if (nowMs != null && confirm.candle.t != null) {
    const age = (nowMs - confirm.candle.t) / PRESETS.I1.tradeMs;
    if (age > cfg.maxBarAgeBars) return { silent: 'stale trigger' };
  }

  const strength = gradeStrength(confirm, candidate.level, candidate.dir, tradeBars, cfg);
  // Strength is a tag. If someone flips it to 'gate' the floor is C.
  if (cfg.strengthMode === 'gate' && strength.score < cfg.minGradeToPrint) {
    return { silent: 'strength floor' };
  }

  return {
    signal: {
      symbol,
      frames: `${PRESETS.I1.reading} → ${PRESETS.I1.trade}`,
      pattern: structure.type,
      direction: candidate.dir,
      level: candidate.level,
      entry: entry.price,
      strength: `${strength.letter} ${strength.score}/4`,
      // journal-only extras — not part of the 7 fields printed to you
      _meta: {
        key: structureKey(structure, candidate.dir, candidate.level, cfg),
        gapPct: candidate.gapPct,
        state: candidate.state,
        note: structure.note,
        confirmedMs: confirm.candle.t + PRESETS.I1.tradeMs,
        entryMs: entry.ms,
        barsWaited: confirm.barsWaited,
        metrics: confirm.metrics,
        strengthChecks: strength.checks,
        height: structure.height
      }
    }
  };
}

export function formatMessage(sig, when) {
  if (!sig) return null;
  const d = sig.direction === 'long' ? 'LONG' : 'SHORT';
  return [
    `${sig.symbol} · ${sig.frames} · ${sig.pattern}`,
    `ACCEPT — ${PRESETS.I1.trade} closed ${sig.direction === 'long' ? 'above' : 'below'} ${sig.level}`,
    `Direction  ${d}`,
    `Level      ${sig.level}`,
    `Entry      ${sig.entry} (open of the next ${PRESETS.I1.trade})`,
    `Strength   ${sig.strength}  (tag)`,
    `When       ${when || ''}`,
    'No stop, no target. Exit is yours.'
  ].join('\n');
}
