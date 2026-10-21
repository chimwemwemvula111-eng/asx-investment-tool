// ============================================================================
// scalp-scanner — the piece that decides HOW OFTEN the rule looks, and makes
// sure one break is reported once.
//
// SPEC v1.0.0. imports only ./scalp-core.js
//
// TWO SEPARATE JOBS, deliberately kept apart:
//   1. CADENCE — when to evaluate. Candle-driven, not timer-driven.
//   2. DEDUPE  — one report per break. Same level + same side = same event,
//                so it is suppressed if it is already in the book.
//
// Neither of these judges signal quality. A suppressed signal is not a bad
// signal — it is the SAME signal you were already told about.
// ============================================================================

import { buildSignal, PRESETS, DEFAULTS } from './scalp-core.js';

/**
 * How often to look. The rule can only answer after a candle closes, so
 * evaluating faster than one trade candle achieves nothing but CPU.
 */
export function scanIntervalMs(presetId) {
  const p = PRESETS[presetId];
  if (!p) throw new Error(`unknown preset: ${presetId}`);
  return p.tradeMs;              // S1 = 60s · S2 = 300s
}

export const DEDUPE_DEFAULTS = {
  // A break stays "already reported" for this many reading bars. 24 × 5m = 2h
  // on S1, 24 × 15m = 6h on S2. After that the same price is a new event again.
  ttlReadingBars: 24,
  enabled: true
};

export class Scanner {
  /**
   * @param {object} o
   * @param {string} o.presetId   'S1' | 'S2'
   * @param {string[]} [o.symbols]
   * @param {object} [o.config]        passed through to buildSignal
   * @param {object} [o.dedupe]        { enabled, ttlReadingBars }
   */
  constructor({ presetId, frames, symbols = [], config = {}, dedupe = {} } = {}) {
    this.presetId = presetId;
    this.frames = frames || null;
    this.preset = frames || PRESETS[presetId];
    if (!this.preset) throw new Error(`unknown preset: ${presetId}`);
    this.symbols = symbols;
    this.config = config;
    this.dedupe = { ...DEDUPE_DEFAULTS, ...dedupe };
    this.book = new Map();          // key → { firstMs, hits }
    this.stats = { evaluated: 0, printed: 0, suppressed: 0, silent: {} };
  }

  /**
   * The dedupe key. Same symbol, same side, same price = same break.
   * Note it does NOT include the pattern: a second trigger candle on an
   * already-reported break is the same event wearing a different shape.
   */
  static keyFor(symbol, side, level) {
    return `${symbol}|${side}|${Number(level).toFixed(8)}`;
  }

  _expire(now) {
    if (!this.dedupe.enabled) return;
    const ttl = this.dedupe.ttlReadingBars * this.preset.readingMs;
    for (const [k, v] of this.book) if (now - v.firstMs > ttl) this.book.delete(k);
  }

  /** Evaluate one symbol at one moment. */
  scan({ symbol, readingHistory, readingCurrent, tradeBars, now, lastSignalMs, spreadPct }) {
    this.stats.evaluated++;
    this._expire(now);

    const res = buildSignal({
      presetId: this.presetId, frames: this.frames, symbol,
      readingHistory, readingCurrent, tradeBars, now,
      config: this.config, lastSignalMs, spreadPct
    });

    if (!res.signal) {
      this.stats.silent[res.silent] = (this.stats.silent[res.silent] || 0) + 1;
      return res;
    }

    const { direction, level } = res.signal;
    const key = Scanner.keyFor(symbol, direction, level);

    if (this.dedupe.enabled && this.book.has(key)) {
      const entry = this.book.get(key);
      entry.hits++;
      this.stats.suppressed++;
      return { signal: null, silent: 'repeat-of-already-reported-break', trace: res.trace, dedupeKey: key };
    }

    if (this.dedupe.enabled) this.book.set(key, { firstMs: now, hits: 1 });
    this.stats.printed++;
    return { ...res, dedupeKey: key };
  }

  /** Call when the watchlist changes so an old level can't silence a new symbol. */
  forget(symbol) {
    for (const k of [...this.book.keys()]) if (k.startsWith(`${symbol}|`)) this.book.delete(k);
  }

  reset() { this.book.clear(); this.stats = { evaluated: 0, printed: 0, suppressed: 0, silent: {} }; }
}

/** Convenience: the two bots, side by side. */
export function makeScanners(symbols, config = {}) {
  const dd = (config.dedupe) || {};
  const cfg = { ...config }; delete cfg.dedupe;
  return {
    S1: new Scanner({ presetId: 'S1', symbols, config: cfg, dedupe: dd }),
    S2: new Scanner({ presetId: 'S2', symbols, config: cfg, dedupe: dd })
  };
}
