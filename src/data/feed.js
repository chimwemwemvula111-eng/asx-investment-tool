// ============================================================================
// feed — candles in, nothing else.
// Reads the public Binance vision endpoint. No API key, no account, no OAuth.
// Returns plain bars: { t, o, h, l, c, v, tb, n }
//   t   open time (ms)
//   tb  taker buy base volume  → order-flow tag, free with the same request
//   n   trade count            → activity tag, free with the same request
// ============================================================================

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com'
];

let preferred = 0;

export const INTERVAL_MS = {
  '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '1h': 60 * 60_000, '4h': 4 * 60 * 60_000
};

/** Drop the still-forming candle. Every lane reasons about closed bars only. */
export function closedOnly(bars, intervalMs, nowMs = Date.now()) {
  return bars.filter(b => b.t + intervalMs <= nowMs);
}

function normalise(rows) {
  return rows.map(r => ({
    t: r[0],
    o: +r[1], h: +r[2], l: +r[3], c: +r[4],
    v: +r[5],
    tb: +r[9],
    n: +r[8]
  }));
}

/**
 * Fetch closed candles.
 * Falls back to the second host on 451/403/network error.
 */
export async function fetchKlines(symbol, interval, limit = 500, fetchImpl = fetch) {
  let lastErr = null;
  for (let attempt = 0; attempt < HOSTS.length; attempt++) {
    const host = HOSTS[(preferred + attempt) % HOSTS.length];
    const url = `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${host}`); continue; }
      const rows = await res.json();
      preferred = (preferred + attempt) % HOSTS.length;
      return closedOnly(normalise(rows), INTERVAL_MS[interval]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('feed unavailable');
}

/** Fetch several intervals for one symbol, in parallel. */
export async function fetchFrames(symbol, intervals, limits = {}, fetchImpl = fetch) {
  const out = {};
  await Promise.all(intervals.map(async tf => {
    out[tf] = await fetchKlines(symbol, tf, limits[tf] || 500, fetchImpl);
  }));
  return out;
}

/** Taker-buy ratio for a bar: where the aggression sat. A tag, never a gate. */
export function takerBuyRatio(bar) {
  if (!bar || !(bar.v > 0) || typeof bar.tb !== 'number') return null;
  return bar.tb / bar.v;
}
