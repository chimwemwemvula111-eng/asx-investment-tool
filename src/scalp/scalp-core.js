// ============================================================================
// scalp-core — the S1 / S2 two-frame scalp rule.
// SPEC v1.0.0 — FROZEN. See ./SPEC.md before changing anything here.
//
// ISOLATION CONTRACT
//   • This file imports nothing. No dependency on ../core/*.
//   • Nothing in the existing engine imports this file.
//   • Editing lanes.js, engine.js, setup.js, strategies2.js or any other lane
//     cannot change behaviour here, and vice versa.
//
// THE RULE, IN ONE PARAGRAPH
//   Two frames only. The READING frame names one level (a prior swing) and says
//   which side was taken. After the unlock point (60% through the reading
//   candle) the TRADE frame supplies one trigger candle, which either held the
//   break (ACCEPT → trade with it) or failed it (REJECT → trade against it).
//   Entry is the open of the next trade candle. There is no target and no stop:
//   the level is the invalidation reference and the exit is manual.
//   Nothing scores, nothing votes, nothing stacks.
// ============================================================================

export const SPEC_VERSION = '1.0.0';

// --- presets: the only two numbers that differ between bots -----------------
// unlockFraction is 3/5 of a 5m candle and 9/15 of a 15m candle — the same 60%.
export const PRESETS = {
  S1: {
    id: 'S1', label: 'S1 · 5m → 1m',
    reading: '5m', trade: '1m',
    readingMs: 5 * 60_000, tradeMs: 60_000,
    unlockFraction: 0.6
  },
  S2: {
    id: 'S2', label: 'S2 · 15m → 5m',
    reading: '15m', trade: '5m',
    readingMs: 15 * 60_000, tradeMs: 5 * 60_000,
    unlockFraction: 0.6
  }
};

// --- every tunable in one place --------------------------------------------
export const DEFAULTS = {
  // structure
  swingK: 2,                 // bars either side needed to call a pivot
  swingLookback: 40,         // how far back to hunt for the level
  atLevelTolRange: 0.25,     // trigger must come within 25% of the reading candle's range

  // continuation patterns
  bodyMin: 0.50,             // pattern 1 · hold close
  momentumBody: 0.80,        // pattern 2 · momentum bar
  momentumClosePos: 0.85,    // pattern 2 · close in the last 15% of the range

  // reversal patterns
  wickMult: 2.0,             // pattern 5 · wick at least 2× the body
  closePosExtreme: 0.33,     // patterns 5 & 7 · close in the far third

  // strength (a TAG by default — switch strengthMode to 'gate' to enforce)
  //
  // FOUR checks, not five. The first draft had five and one of them was a
  // duplicate: adverseWick is exactly 1 − CLV on any single bar, so
  // "adverseWick ≤ 0.25" is just "CLV ≥ 0.75" wearing a different name. Two
  // slots measuring one thing would weight closeness-to-extreme at 2/5 of the
  // grade — the same compensation-between-dimensions failure the Intention
  // Score died of. A fifth candidate, "closed in the trade's direction", turned
  // out to be implied: body ≥ 0.5 with CLV ≥ 0.65 is arithmetically impossible
  // on a bar that closed against you. So: four independent measurements.
  strengthMode: 'tag',       // 'tag' | 'gate'
  strength: {
    clvMin: 0.65,            // close location within the range, in trade direction
    bodyMin: 0.50,           // conviction vs noise
    rangeMinRatio: 0.80,     // size vs the median of the last 20 trade ranges
    penetrationMin: 0.10     // close distance past the level, in bar units
  },
  rangeMedLookback: 20,
  minGradeToPrint: 2,        // A 4/4 · B 3/4 · C 2/4 · D ≤1. Gate floor = C

  // volume — a TAG by default (the only filter with published evidence behind
  // it, but tags first: flip requireVolume to true to enforce)
  requireVolume: false,
  volumeRatioMin: 1.4,
  volLookback: 20,

  // data validity — the only hard gate in the file
  maxBarAgeBars: 2,          // newest trade bar must be ≤ 2 of its own bars old

  // duplicate suppression — OFF by default. Print everything.
  // The user's instruction is unambiguous: every signal, no suppression, the
  // journal is external. 0 = the raw firehose. Raise it only if you later
  // decide repeats are noise; it never changes WHAT is detected, only how often
  // one level may be re-reported. Measured (synthetic tape, frequency only):
  //   0  → S1 ~85/symbol/day  S2 ~31/symbol/day
  //   6  → S1 ~18/symbol/day  S2 ~10/symbol/day
  cooldownReadingBars: 0
};

// --- small helpers ---------------------------------------------------------
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

export function median(arr) {
  const a = arr.filter(v => typeof v === 'number' && isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Everything measurable about one candle, in trade direction terms. */
export function candleMetrics(c) {
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o);
  const safe = range > 0 ? range : 0;
  return {
    range,
    body,
    bodyRatio: safe ? body / safe : 0,
    upperWick: c.h - Math.max(c.c, c.o),
    lowerWick: Math.min(c.c, c.o) - c.l,
    // where the close sits, measured in the direction of the trade
    closePosBull: safe ? (c.c - c.l) / safe : 0.5,
    closePosBear: safe ? (c.h - c.c) / safe : 0.5
  };
}

const bull = c => c.c > c.o;
const bear = c => c.c < c.o;

// --- levels ---------------------------------------------------------------
/** Pivot highs and lows. k bars either side must be lower / higher. */
export function findSwings(candles, k = DEFAULTS.swingK) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].h });
    if (isLow) lows.push({ index: i, price: candles[i].l });
  }
  return { highs, lows };
}

/**
 * Did the reading candle take a prior swing, and on which side?
 * Returns the break context, or a reason it found none.
 */
export function detectReadingBreak(readingHistory, readingCurrent, cfg = DEFAULTS) {
  const hist = readingHistory.slice(-cfg.swingLookback);
  if (hist.length < cfg.swingK * 2 + 2) return { ok: false, reason: 'insufficient-history' };

  const { highs, lows } = findSwings(hist, cfg.swingK);
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  if (!lastHigh && !lastLow) return { ok: false, reason: 'no-pivot' };

  const cur = readingCurrent;
  const tookHigh = lastHigh ? cur.h > lastHigh.price : false;
  const tookLow = lastLow ? cur.l < lastLow.price : false;
  if (!tookHigh && !tookLow) return { ok: false, reason: 'no-break' };

  // If it took both sides, the close decides which break we are reading.
  let side;
  if (tookHigh && tookLow) side = cur.c >= (lastHigh.price + lastLow.price) / 2 ? 'up' : 'down';
  else side = tookHigh ? 'up' : 'down';

  const level = side === 'up' ? lastHigh.price : lastLow.price;
  return {
    ok: true,
    side,
    level,
    levelKind: side === 'up' ? 'swing high' : 'swing low',
    breakCandle: { o: cur.o, h: cur.h, l: cur.l, c: cur.c, t: cur.t },
    readingRange: cur.h - cur.l
  };
}

// --- the eight patterns ---------------------------------------------------
const CONTINUATION_ORDER = [
  'engulf_continuation:engulf',
  'engulf_continuation:reclaim',
  'momentum_bar',
  'hold_close',
  'follow_through'
];
const REVERSAL_ORDER = [
  'recovery_engulfing',
  'outside_reversal',
  'rejection_wick',
  'indecision_close'
];

export const PATTERN_NAMES = {
  hold_close: 'Hold close',
  momentum_bar: 'Momentum bar',
  engulf_continuation: 'Engulfing continuation',
  follow_through: 'Follow-through',
  rejection_wick: 'Rejection wick',
  recovery_engulfing: 'Recovery engulfing',
  outside_reversal: 'Outside reversal',
  indecision_close: 'Indecision close'
};

/** Does a candidate trade candle satisfy one pattern? Returns {id,tier} or null. */
export function matchPattern(candle, prev, ctx, cfg = DEFAULTS) {
  const m = candleMetrics(candle);
  const { side, breakCandle: b } = ctx;

  // ---------- the break held → trade WITH it ----------
  if (side === 'up') {
    // 3 · engulf: body wraps the break candle.  Reclaim: closes above its high.
    if (candle.o <= b.o && candle.c > b.h) return { id: 'engulf_continuation', tier: 'engulf' };
    if (candle.c > b.h) return { id: 'engulf_continuation', tier: 'reclaim' };
    // 2 · momentum bar
    if (m.bodyRatio >= cfg.momentumBody && m.closePosBull >= cfg.momentumClosePos)
      return { id: 'momentum_bar', tier: null };
    // 1 · hold close
    if (bull(candle) && candle.c > ctx.level && m.bodyRatio >= cfg.bodyMin)
      return { id: 'hold_close', tier: null };
    // 4 · follow-through
    if (prev && prev.c > ctx.level && candle.c > ctx.level)
      return { id: 'follow_through', tier: null };
  } else {
    if (candle.o >= b.o && candle.c < b.l) return { id: 'engulf_continuation', tier: 'engulf' };
    if (candle.c < b.l) return { id: 'engulf_continuation', tier: 'reclaim' };
    if (m.bodyRatio >= cfg.momentumBody && m.closePosBear >= cfg.momentumClosePos)
      return { id: 'momentum_bar', tier: null };
    if (bear(candle) && candle.c < ctx.level && m.bodyRatio >= cfg.bodyMin)
      return { id: 'hold_close', tier: null };
    if (prev && prev.c < ctx.level && candle.c < ctx.level)
      return { id: 'follow_through', tier: null };
  }

  // ---------- the break failed → trade AGAINST it ----------
  // A failed UP break is shorted; a failed DOWN break is bought.
  if (side === 'up') {
    if (candle.h >= b.h && candle.c <= b.o) return { id: 'recovery_engulfing', tier: null };
    if (candle.h > b.h && candle.l < b.l && m.closePosBull <= cfg.closePosExtreme)
      return { id: 'outside_reversal', tier: null };
    if (m.upperWick >= cfg.wickMult * m.body && m.closePosBull <= cfg.closePosExtreme && candle.c < ctx.level)
      return { id: 'rejection_wick', tier: null };
    if (m.bodyRatio <= 0.20 && candle.c < ctx.level) return { id: 'indecision_close', tier: null };
  } else {
    if (candle.l <= b.l && candle.c >= b.o) return { id: 'recovery_engulfing', tier: null };
    if (candle.l < b.l && candle.h > b.h && m.closePosBear <= cfg.closePosExtreme)
      return { id: 'outside_reversal', tier: null };
    if (m.lowerWick >= cfg.wickMult * m.body && m.closePosBear <= cfg.closePosExtreme && candle.c > ctx.level)
      return { id: 'rejection_wick', tier: null };
    if (m.bodyRatio <= 0.20 && candle.c > ctx.level) return { id: 'indecision_close', tier: null };
  }
  return null;
}

/** Distance from the level to the candle's range. 0 if the level is inside it. */
export function distanceToLevel(candle, level) {
  if (level >= candle.l && level <= candle.h) return 0;
  return Math.min(Math.abs(candle.h - level), Math.abs(candle.l - level));
}

// --- strength: five pass/fail checks, graded, never summed -----------------
export function gradeStrength(candle, tradeDir, level, recentRanges, cfg = DEFAULTS) {
  const m = candleMetrics(candle);
  const s = cfg.strength;
  const clv = tradeDir === 'up' ? m.closePosBull : m.closePosBear;
  // recorded, not scored: this is 1 − clv by definition
  const adverse = tradeDir === 'up'
    ? (m.range ? (candle.h - candle.c) / m.range : 1)
    : (m.range ? (candle.c - candle.l) / m.range : 1);
  const medRange = median(recentRanges.slice(-cfg.rangeMedLookback)) || m.range || 0;
  const rangeRatio = medRange > 0 ? m.range / medRange : 1;
  const penetration = m.range > 0 ? Math.abs(candle.c - level) / m.range : 0;

  const checks = {
    clv: clv >= s.clvMin,
    body: m.bodyRatio >= s.bodyMin,
    range: rangeRatio >= s.rangeMinRatio,
    penetration: penetration >= s.penetrationMin
  };
  const passes = Object.values(checks).filter(Boolean).length;
  const grade = passes >= 4 ? 'A' : passes === 3 ? 'B' : passes === 2 ? 'C' : 'D';
  return { passes, grade, checks, values: { clv, bodyRatio: m.bodyRatio, rangeRatio, adverse, penetration } };
}

// --- the decision path ----------------------------------------------------
/**
 * Run the whole path for one reading candle.
 *
 * @param {object}   p
 * @param {string}   p.presetId      'S1' | 'S2'
 * @param {string}   p.symbol        e.g. 'BTCUSDT'
 * @param {Array}    p.readingHistory  CLOSED reading candles before the current one
 * @param {object}   p.readingCurrent  the reading candle being evaluated
 * @param {Array}    p.tradeBars       CLOSED trade candles, oldest first
 * @param {number}   p.now             epoch ms
 * @param {object}   [p.config]        override DEFAULTS keys
 * @param {number}   [p.spreadPct]     optional, recorded as a tag only
 * @returns {{signal: object|null, silent: string|null, trace: object}}
 */
export function buildSignal(p) {
  // A lane may pass its own clock spec (`frames`) instead of a canned preset.
  // Additive only: S1/S2 behaviour is byte-identical, proven by the test suite.
  const preset = p.frames || PRESETS[p.presetId];
  if (!preset) throw new Error(`unknown preset: ${p.presetId}`);
  const cfg = { ...DEFAULTS, ...(p.config || {}), strength: { ...DEFAULTS.strength, ...((p.config || {}).strength || {}) } };
  const trace = { preset: preset.id || 'custom', steps: [] };

  // 0 · COOLDOWN — duplicate suppression, not a quality filter
  const cooldownMs = (cfg.cooldownReadingBars || 0) * preset.readingMs;

  // 1 · DATA GATE — the only hard gate
  const lastBar = p.tradeBars[p.tradeBars.length - 1];
  if (!lastBar) return { signal: null, silent: 'no-data', trace };
  const ageMs = p.now - (lastBar.t + preset.tradeMs);
  if (ageMs > cfg.maxBarAgeBars * preset.tradeMs) {
    trace.steps.push({ step: 'data', ok: false, ageMs });
    return { signal: null, silent: 'stale-feed', trace };
  }
  trace.steps.push({ step: 'data', ok: true, ageMs });

  // 2-4 · READING FRAME — level, side, unlock
  const br = detectReadingBreak(p.readingHistory, p.readingCurrent, cfg);
  if (!br.ok) {
    trace.steps.push({ step: 'reading', ok: false, reason: br.reason });
    return { signal: null, silent: br.reason, trace };
  }
  const unlockTime = p.readingCurrent.t + preset.unlockFraction * preset.readingMs;
  trace.steps.push({ step: 'reading', ok: true, side: br.side, level: br.level, unlockTime });

  // 5-6 · TRADE FRAME — first trigger at or after unlock, one per reading candle
  const tol = cfg.atLevelTolRange * br.readingRange;
  const ctx = { side: br.side, level: br.level, breakCandle: br.breakCandle };

  for (let i = 0; i < p.tradeBars.length; i++) {
    const bar = p.tradeBars[i];
    const barClose = bar.t + preset.tradeMs;
    if (barClose <= unlockTime) continue;          // too early — the clock has not run
    if (barClose > p.now) break;                   // not closed yet
    if (bar.t < p.readingCurrent.t) continue;       // belongs to an earlier reading candle
    if (cooldownMs && p.lastSignalMs != null && barClose - p.lastSignalMs < cooldownMs) {
      trace.steps.push({ step: 'cooldown', ok: false });
      return { signal: null, silent: 'cooldown', trace };
    }
    if (distanceToLevel(bar, br.level) > tol) continue; // not AT the level

    const hit = matchPattern(bar, p.tradeBars[i - 1], ctx, cfg);
    if (!hit) continue;

    const role = CONTINUATION_ORDER.includes(hit.tier ? `${hit.id}:${hit.tier}` : hit.id)
      ? 'continuation' : 'reversal';
    const tradeDir = role === 'continuation' ? br.side : (br.side === 'up' ? 'down' : 'up');
    const strength = gradeStrength(bar, tradeDir, br.level, p.tradeBars.slice(Math.max(0, i - 25), i).map(c => c.h - c.l), cfg);

    if (cfg.strengthMode === 'gate' && strength.passes < cfg.minGradeToPrint) {
      trace.steps.push({ step: 'strength', ok: false, grade: strength.grade });
      return { signal: null, silent: 'below-grade', trace };
    }

    const volAvg = p.tradeBars.slice(Math.max(0, i - cfg.volLookback), i)
      .reduce((s, c) => s + (num(c.v) || 0), 0) / Math.max(1, Math.min(i, cfg.volLookback));
    const volumeRatio = volAvg > 0 && num(bar.v) != null ? bar.v / volAvg : null;
    if (cfg.requireVolume && volumeRatio != null && volumeRatio < cfg.volumeRatioMin) {
      trace.steps.push({ step: 'volume', ok: false, volumeRatio });
      return { signal: null, silent: 'thin-volume', trace };
    }

    const entryMs = barClose;                       // open of the next trade candle
    const signal = {
      spec: `scalp-core/${SPEC_VERSION}`,
      preset: preset.id || 'custom',
      presetLabel: preset.label,
      symbol: p.symbol,
      asset: p.symbol,

      candle: {
        reading: preset.reading,
        trade: preset.trade,
        label: `${preset.reading.toUpperCase()} read → ${preset.trade.toUpperCase()} confirm`
      },
      direction: tradeDir === 'up' ? 'BUY' : 'SELL',
      basis: role === 'continuation' ? 'held' : 'failed',
      mode: role,

      pattern: {
        id: hit.id,
        name: PATTERN_NAMES[hit.id],
        role,
        tier: hit.tier || null
      },
      level: br.level,
      levelKind: br.levelKind,
      kill: role === 'continuation' ? br.level
        : (br.side === 'up' ? bar.h : bar.l),   // failed break → its own extreme voids the idea

      entry: describeTime(entryMs),
      trigger: describeTime(barClose),

      tags: {
        strength,                                    // {passes, grade, checks, values}
        volumeRatio,
        overshootPct: br.level ? +(((br.side === 'up' ? bar.c - br.level : br.level - bar.c) / br.level) * 100).toFixed(4) : null,
        atLevelDistance: +distanceToLevel(bar, br.level).toFixed(8),
        sessionHourUtc: new Date(barClose).getUTCHours(),
        spreadPct: p.spreadPct ?? null,
        geometryRatio: br.readingRange ? +((Math.abs(bar.c - (role === 'continuation' ? br.level : (br.side === 'up' ? bar.h : bar.l))) / br.readingRange)).toFixed(4) : null
      },

      // filled in later, never at fire time
      journal: { repaintInFavour: null, exitPrice: null, exitTimeMs: null, mfe: null, mae: null }
    };

    trace.steps.push({ step: 'trigger', ok: true, pattern: hit.id, tier: hit.tier, entryMs });
    return { signal, silent: null, trace };
  }

  trace.steps.push({ step: 'trigger', ok: false, reason: 'no-pattern-in-window' });
  return { signal: null, silent: 'no-pattern-in-window', trace };
}

// --- time, in UTC and in the user's zone --------------------------------
const pad = n => String(n).padStart(2, '0');
const hhmmss = d => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** Africa/Lusaka is UTC+2 year round — no DST, so no library needed. */
export function describeTime(ms) {
  const d = new Date(ms);
  const cat = new Date(ms + 2 * 3600_000);
  return {
    ms,
    iso: d.toISOString(),
    hhmmss: hhmmss(d),
    utc: `UTC ${hhmmss(d)}`,
    cat: `CAT ${hhmmss(cat)}`,
    line: `UTC ${hhmmss(d)} · CAT ${hhmmss(cat)}`
  };
}
