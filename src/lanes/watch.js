// ============================================================================
// watch — the watch + swing lane (Bot 3). 4h or 1h reading, no trade frame.
// SPEC v1.0.0 — FROZEN.
//
// ISOLATION CONTRACT
//   • Imports nothing. Never reads another lane's state or levels.
//   • Nothing in the engine imports this file.
//
// THE RULE, IN ONE PARAGRAPH
//   Three structural patterns are watched: head & shoulders, inverse head &
//   shoulders, and Wyckoff accumulation. When a shape's geometry completes and
//   price approaches its trigger, the lane sends a WAKE-UP. It never waits for
//   confirmation — a structure that is "about to break" cannot be confirmed by
//   mechanics without arriving too late to act on. If the structure later
//   breaks, a BREAK is sent. If it dies — geometry gone, or a backstop of 12
//   bars elapsed — a CLOSE-OUT is sent. That is three message kinds, and the
//   entry is the reader's.
//
// CUP & HANDLE IS DELIBERATELY ABSENT. It produced 3 one-bar instances in 208
// days on three symbols and never resolved. Do not add it back without data.
//
// NO ATR. Proximity is measured in units of the instrument's own median range.
// ============================================================================

export const SPEC_VERSION = '1.0.0';

export const PRESETS = {
  W1H: { id: 'W1H', label: 'Watch · 1h', tf: '1h', ms: 60 * 60_000 },
  W4H: { id: 'W4H', label: 'Watch · 4h', tf: '4h', ms: 4 * 60 * 60_000 }
};

export const DEFAULTS = {
  swingK: 5,
  hsWindow: 90,
  hsFreshBars: 14,          // right shoulder must be within this many bars of now
  hsMaxDistancePct: 0.08,   // and price must be within 8% of the trigger
  hsMinProminence: 0.004,   // head must clear the higher shoulder by 0.4%
  hsShoulderSymmetry: 0.05,

  wyWindows: [60, 90, 120],
  wyMaxWidthPct: 0.14,
  wyMinHeightRanges: 4,
  wySpringTol: 0.998,       // a spring undercuts the range low by 0.2%
  wyMaxDistancePct: 0.08,

  // proximity in median-range units
  imminentRanges: 1.5,
  coiledRanges: 4.0,

  // lifecycle
  closeOutBars: 12,         // backstop: 12 bars after the wake-up
  rangeMedLookback: 40
};

// --- helpers ---------------------------------------------------------------
const ok = v => typeof v === 'number' && isFinite(v);

export function median(arr) {
  const a = arr.filter(ok).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function medianRange(bars, n = DEFAULTS.rangeMedLookback) {
  if (!bars || !bars.length) return null;
  return median(bars.slice(-n).map(b => b.h - b.l));
}

/** Fractal pivots. A pivot at index i needs k bars either side. */
export function pivots(bars, k = DEFAULTS.swingK) {
  const highs = [], lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h > bars[i].h) isHigh = false;
      if (bars[j].l < bars[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, p: bars[i].h });
    if (isLow) lows.push({ i, p: bars[i].l });
  }
  return { highs, lows };
}

// --- head & shoulders ------------------------------------------------------
export function detectHeadShoulders(bars, cfg = DEFAULTS) {
  if (!bars || bars.length < 40) return [];   // enough for a 5-bar fractal either side
  const w = bars.slice(-cfg.hsWindow);
  const price = w[w.length - 1].c;
  const { highs, lows } = pivots(w, cfg.swingK);
  const out = [];

  // classic: middle high is the highest, neckline through the intervening lows
  if (highs.length >= 3) {
    const [a, b, c] = highs.slice(-3);
    if (b.p > a.p && b.p > c.p) {
      const head = b.p, sh = Math.max(a.p, c.p);
      const prominence = (head - sh) / head;
      const symmetry = Math.abs(a.p - c.p) / head;
      const neckPivots = lows.filter(p => a.i < p.i && p.i < c.i);
      const fresh = c.i >= w.length - cfg.hsFreshBars;
      if (prominence >= cfg.hsMinProminence &&
          symmetry <= cfg.hsShoulderSymmetry * prominence / cfg.hsMinProminence + cfg.hsShoulderSymmetry &&
          neckPivots.length >= 1 && fresh) {
        const neck = Math.min(...neckPivots.map(p => p.p));
        if (neck < head && Math.abs(price - neck) / price <= cfg.hsMaxDistancePct) {
          out.push({
            type: 'HEAD & SHOULDERS', dir: 'short', level: neck,
            height: head - neck,
            points: { ls: a, head: b, rs: c },
            neckPivots,
            fresh, prominence: +prominence.toFixed(4),
            note: 'left shoulder, head, right shoulder — neckline broken downward'
          });
        }
      }
    }
  }

  // inverse: middle low is the lowest, neckline through the intervening highs
  if (lows.length >= 3) {
    const [a, b, c] = lows.slice(-3);
    if (b.p < a.p && b.p < c.p) {
      const head = b.p, sh = Math.min(a.p, c.p);
      const prominence = (sh - head) / head;
      const symmetry = Math.abs(a.p - c.p) / head;
      const neckPivots = highs.filter(p => a.i < p.i && p.i < c.i);
      const fresh = c.i >= w.length - cfg.hsFreshBars;
      if (prominence >= cfg.hsMinProminence &&
          symmetry <= cfg.hsShoulderSymmetry * prominence / cfg.hsMinProminence + cfg.hsShoulderSymmetry &&
          neckPivots.length >= 1 && fresh) {
        const neck = Math.max(...neckPivots.map(p => p.p));
        if (neck > head && Math.abs(price - neck) / price <= cfg.hsMaxDistancePct) {
          out.push({
            type: 'INVERSE HEAD & SHOULDERS', dir: 'long', level: neck,
            height: neck - head,
            points: { ls: a, head: b, rs: c },
            neckPivots, fresh, prominence: +prominence.toFixed(4),
            note: 'inverted shoulders — neckline broken upward'
          });
        }
      }
    }
  }
  return out;
}

// --- Wyckoff accumulation --------------------------------------------------
/**
 * A wide range with declining volume and a spring under the lows.
 *
 * HONEST LIMITATION: this is a mechanical proxy for accumulation, not the full
 * Wyckoff phase A→E method — that method's own source material says it cannot
 * be automated objectively. It detects: range width, volume drying up, a
 * spring, and price still under the range high.
 *
 * The spring is searched only in the LAST 25% of the window. Building the range
 * from the whole window and then asking whether some bar went below the
 * window's own minimum is unsatisfiable by construction — that bug cost a full
 * measurement cycle once.
 */
export function detectWyckoff(bars, cfg = DEFAULTS) {
  if (!bars || bars.length < 150) return [];
  const R = medianRange(bars);
  if (!R) return [];
  const price = bars[bars.length - 1].c;

  for (const n of cfg.wyWindows) {
    const w = bars.slice(-n);
    const cut = Math.floor(n * 0.75);
    const base = w.slice(0, cut);
    const tail = w.slice(cut);
    const hi = Math.max(...base.map(b => b.h));
    const lo = Math.min(...base.map(b => b.l));
    if (!(lo > 0)) continue;
    if ((hi - lo) < cfg.wyMinHeightRanges * R) continue;
    if ((hi - lo) / lo > cfg.wyMaxWidthPct) continue;

    const prev = bars.slice(-(n + 60), -n);
    if (prev.length) {
      const vNow = w.reduce((s, b) => s + b.v, 0) / w.length;
      const vPrev = prev.reduce((s, b) => s + b.v, 0) / prev.length;
      if (vNow >= vPrev) continue;   // volume must be drying up
    }

    const spring = tail.some(b => b.l < lo * cfg.wySpringTol && b.c > lo);
    if (!spring) continue;
    if (price > hi * 1.002) continue;                     // already broken out
    if (Math.abs(hi - price) / price > cfg.wyMaxDistancePct) continue;

    return [{
      type: 'WYCKOFF ACCUMULATION', dir: 'long', level: hi,
      height: hi - lo, box: { hi, lo }, window: n, spring: true,
      note: `${n}-bar range, volume drying, spring taken`
    }];
  }
  return [];
}

export function detectWatchStructures(bars, cfg = DEFAULTS) {
  if (!bars || bars.length < 60) return [];
  return [...detectHeadShoulders(bars, cfg), ...detectWyckoff(bars, cfg)];
}

// --- state ladder ----------------------------------------------------------
export function stateOf(structure, price, bars, cfg = DEFAULTS) {
  const R = medianRange(bars, cfg.rangeMedLookback);
  if (!R || !ok(price)) return 'forming';
  const reach = structure.dir === 'long' ? structure.level - price : price - structure.level;
  if (reach <= 0) return 'resolved';
  const inRanges = reach / R;
  if (inRanges <= cfg.imminentRanges) return 'imminent';
  if (inRanges <= cfg.coiledRanges) return 'coiled';
  return 'forming';
}

export function structureKey(s) {
  return `${s.type}:${s.dir}:${Math.round(Math.log(s.level) / Math.log(1.005))}`;
}

// --- lifecycle tracker -----------------------------------------------------
export function createTracker(cfg = DEFAULTS) {
  return { cfg, live: new Map(), done: new Set() };
}

/**
 * Advance the tracker by one bar. Returns the events this bar produced.
 * Each structure yields at most ONE wake-up and ONE break, and at most one
 * close-out if it dies. That is the "don't repeat the same signal" rule.
 */
export function step(tracker, { bars, barIndex, cfg }) {
  const c = { ...tracker.cfg, ...(cfg || {}) };
  const price = bars[barIndex].c;
  const events = [];
  const structures = detectWatchStructures(bars.slice(0, barIndex + 1), c);
  const now = new Set();

  for (const s of structures) {
    const key = structureKey(s);
    now.add(key);
    if (tracker.done.has(key)) continue;

    let st = tracker.live.get(key);
    if (!st) {
      st = { s, wakeAt: null, brokeAt: null, announcedWake: false, announcedBreak: false };
      tracker.live.set(key, st);
    }
    const state = stateOf(s, price, bars.slice(0, barIndex + 1), c);

    if ((state === 'coiled' || state === 'imminent') && !st.announcedWake) {
      st.wakeAt = barIndex;
      st.announcedWake = true;
      events.push({
        kind: 'WAKE-UP', symbol: s.symbol, pattern: s.type, dir: s.dir,
        level: s.level, state, barIndex, note: s.note
      });
    }
    if (state === 'resolved' && st.announcedWake && !st.announcedBreak) {
      st.brokeAt = barIndex;
      st.announcedBreak = true;
      tracker.done.add(key);
      events.push({
        kind: 'BREAK', symbol: s.symbol, pattern: s.type, dir: s.dir,
        level: s.level, barIndex, barsSinceWake: barIndex - (st.wakeAt ?? barIndex)
      });
    }
  }

  // close-outs: geometry gone, or the bar backstop elapsed
  for (const [key, st] of tracker.live) {
    if (tracker.done.has(key) || !st.announcedWake) continue;
    const gone = !now.has(key);
    const stale = barIndex - (st.wakeAt ?? barIndex) >= c.closeOutBars;
    if (gone || stale) {
      st.announcedBreak = true;
      tracker.done.add(key);
      events.push({
        kind: 'CLOSE-OUT', symbol: st.s.symbol, pattern: st.s.type, dir: st.s.dir,
        level: st.s.level, barIndex, barsSinceWake: barIndex - (st.wakeAt ?? barIndex),
        reason: gone ? 'geometry gone' : 'backstop'
      });
    }
  }

  for (const key of [...tracker.live.keys()]) {
    if (tracker.done.has(key)) tracker.live.delete(key);
  }
  return events;
}

export function formatWatchMessage(ev, when) {
  if (!ev) return null;
  const L = ev.level;
  if (ev.kind === 'WAKE-UP') {
    return [
      `${ev.symbol} · ${ev.pattern}`,
      `Awake — price is at the trigger.`,
      `Level   ${L}`,
      `If it breaks   ${ev.dir === 'long' ? 'LONG' : 'SHORT'} bias`,
      `When    ${when || ''}`,
      'Entry is yours. Watch it.'
    ].join('\n');
  }
  if (ev.kind === 'BREAK') {
    return [
      `${ev.symbol} · ${ev.pattern}`,
      `Broke ${L}`,
      `Awoke   ${ev.barsSinceWake} bars earlier`,
      `When    ${when || ''}`,
      'The wait turned into a move.'
    ].join('\n');
  }
  return [
    `${ev.symbol} · ${ev.pattern}`,
    `Never broke. Structure gone.`,
    `Was alive   ${ev.barsSinceWake} bars`,
    `When        ${when || ''}`,
    'Removed from the watch list.'
  ].join('\n');
}
