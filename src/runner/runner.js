// ============================================================================
// runner — the only place the lanes are wired to the feed, the store and
// Telegram. The lanes themselves stay frozen and know nothing about any of it.
//
// One entry point: runOnce(). Give it a storage adapter and a fetch, get back
// a summary. That makes the whole thing testable without a browser.
// ============================================================================

import * as I1 from '../lanes/i1.js';
import * as WATCH from '../lanes/watch.js';
import * as LAB from '../lanes/lab.js';
import { Scanner, makeScanners } from '../scalp/scalp-scanner.js';
import { formatTelegram } from '../scalp/scalp-format.js';
import { fetchKlines, takerBuyRatio, INTERVAL_MS } from '../data/feed.js';
import { sendTelegram, tagLine } from '../data/telegram.js';
import * as store from '../store/store.js';

const LIMITS = { '1m': 40, '5m': 60, '15m': 320, '1h': 320, '4h': 320 };

// ---------------------------------------------------------------------------
// serialisation of the watch tracker (Map + Set → JSON and back)
// ---------------------------------------------------------------------------
export function dumpWatchTracker(t) {
  return {
    live: [...t.live.entries()].map(([k, v]) => [k, v]),
    done: [...t.done]
  };
}

export function loadWatchTracker(state, cfg) {
  const t = WATCH.createTracker(cfg);
  if (!state) return t;
  for (const [k, v] of state.live || []) t.live.set(k, v);
  for (const k of state.done || []) t.done.add(k);
  return t;
}

// ---------------------------------------------------------------------------
// SCALP — the sealed two-frame module
// ---------------------------------------------------------------------------
export async function runScalp({ settings, storage, fetchImpl, now, send, journal }) {
  const scanners = makeScanners(settings.symbols, { dedupe: { enabled: true } });
  const out = { printed: 0, errors: [] };

  for (const preset of settings.scalpPresets) {
    const scan = scanners[preset];
    if (!scan) continue;
    const readingTf = preset === 'S1' ? '5m' : '15m';
    const tradeTf = preset === 'S1' ? '1m' : '5m';

    for (const symbol of settings.symbols) {
      try {
        const [reading, trade] = await Promise.all([
          fetchKlines(symbol, readingTf, LIMITS[readingTf], fetchImpl),
          fetchKlines(symbol, tradeTf, LIMITS[tradeTf], fetchImpl)
        ]);
        if (reading.length < 8 || trade.length < 4) continue;

        const readingCurrent = reading[reading.length - 1];
        const readingHistory = reading.slice(0, -1);
        const windowStart = readingCurrent.t;
        const windowEnd = windowStart + INTERVAL_MS[readingTf];
        const tradeBars = trade.filter(b => b.t >= windowStart && b.t < windowEnd);
        if (tradeBars.length < 2) continue;

        const res = scan.scan({
          symbol,
          readingHistory,
          readingCurrent,
          tradeBars,
          now: windowEnd,
          lastSignalMs: null
        });
        if (!res.signal) continue;

        const key = `${preset}|${res.dedupeKey}`;
        const fresh = await store.claim([key], storage, now);
        if (!fresh.length) continue;

        const text = formatTelegram(res.signal);
        journal.push({
          at: now, lane: 'scalp', kind: 'SIGNAL', symbol,
          pattern: res.signal.pattern?.name || '',
          direction: res.signal.direction,
          level: res.signal.level,
          entry: res.signal.entry?.price ?? null,
          strength: res.signal.tags?.strength?.grade ?? '',
          note: `${preset} ${res.signal.pattern?.role || ''}`.trim(),
          text
        });
        await send(text, 'scalp');
        out.printed++;
      } catch (e) {
        out.errors.push(`scalp ${preset} ${symbol}: ${e.message}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I1 — 1h reading, 15m trade
// ---------------------------------------------------------------------------
export async function runI1({ settings, storage, fetchImpl, now, send, journal }) {
  const out = { printed: 0, errors: [] };
  for (const symbol of settings.symbols) {
    try {
      const [h1, m15] = await Promise.all([
        fetchKlines(symbol, '1h', LIMITS['1h'], fetchImpl),
        fetchKlines(symbol, '15m', LIMITS['15m'], fetchImpl)
      ]);
      if (h1.length < 260 || m15.length < 40) continue;

      const last = h1[h1.length - 1];
      const closeMs = last.t + INTERVAL_MS['1h'];
      const from = m15.findIndex(b => b.t >= closeMs);
      if (from < 0) continue;

      const structures = I1.detectStructures(h1);
      for (const structure of structures) {
        for (const cand of I1.candidates(structure, last.c)) {
          if (cand.gapPct > I1.DEFAULTS.armGapPct) continue;
          if (cand.state !== 'coiled' && cand.state !== 'imminent') continue;

          const confirm = I1.findConfirmation(m15, from, cand.level, cand.dir);
          if (!confirm) continue;
          const entry = I1.entryAfter(m15, confirm.index);
          if (!entry) continue;

          const built = I1.buildSignal({
            symbol, structure, candidate: cand, confirm, entry,
            tradeBars: m15, nowMs: now
          });
          if (!built.signal) continue;

          const key = `i1|${built.signal._meta.key}`;
          const fresh = await store.claim([key], storage, now);
          if (!fresh.length) continue;

          const text = I1.formatMessage(built.signal, new Date(now).toISOString().slice(11, 16) + ' UTC');
          const tags = tagLine({ takerRatio: takerBuyRatio(confirm.candle), trades: confirm.candle.n });
          journal.push({
            at: now, lane: 'intraday', kind: 'SIGNAL', symbol,
            pattern: structure.type,
            direction: cand.dir,
            level: cand.level,
            entry: entry.price,
            strength: built.signal.strength,
            note: tags || structure.note,
            text
          });
          await send(tags ? `${text}\n${tags}` : text, 'i1');
          out.printed++;
        }
      }
    } catch (e) {
      out.errors.push(`i1 ${symbol}: ${e.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WATCH — wake-up / break / close-out on one frame
// ---------------------------------------------------------------------------
export async function runWatch({ settings, storage, fetchImpl, now, send, journal }) {
  const out = { printed: 0, errors: [] };
  const tf = settings.watchFrame === '4h' ? '4h' : '1h';
  const cfg = { ...WATCH.DEFAULTS, closeOutBars: settings.watchCloseOutBars };
  const state = await store.getLaneState(storage);
  const bucket = { ...(state.watch || {}) };

  for (const symbol of settings.symbols) {
    try {
      const bars = await fetchKlines(symbol, tf, LIMITS[tf], fetchImpl);
      if (bars.length < 160) continue;

      const tracker = loadWatchTracker(bucket[symbol], cfg);
      const idx = bars.length - 1;
      const events = WATCH.step(tracker, { bars, barIndex: idx, cfg });
      bucket[symbol] = dumpWatchTracker(tracker);

      for (const ev of events) {
        if (ev.kind === 'CLOSE-OUT' && !settings.sendCloseOuts) continue;
        const key = `watch|${tf}|${symbol}|${ev.kind}|${ev.pattern}|${ev.dir}|${Math.round(Math.log(ev.level) / Math.log(1.005))}`;
        const fresh = await store.claim([key], storage, now);
        if (!fresh.length) continue;

        const text = WATCH.formatWatchMessage({ ...ev, symbol }, new Date(now).toISOString().slice(11, 16) + ' UTC');
        journal.push({
          at: now, lane: 'watch', kind: ev.kind, symbol,
          pattern: ev.pattern, direction: ev.dir, level: ev.level,
          entry: null, strength: '', note: ev.reason || ev.note || '', text
        });
        await send(text, 'watch');
        out.printed++;
      }
    } catch (e) {
      out.errors.push(`watch ${symbol}: ${e.message}`);
    }
  }
  await store.saveLaneState({ ...state, watch: bucket }, storage);
  return out;
}

// ---------------------------------------------------------------------------
// LAB — records, never sends
// ---------------------------------------------------------------------------
export async function runLab({ settings, storage, fetchImpl, now, journal }) {
  const out = { rows: 0, errors: [] };
  const lookback = 3;   // how many recent reading bars to score each run

  for (const symbol of settings.symbols) {
    try {
      const [h1, m15] = await Promise.all([
        fetchKlines(symbol, '1h', LIMITS['1h'], fetchImpl),
        fetchKlines(symbol, '15m', LIMITS['15m'], fetchImpl)
      ]);
      if (h1.length < 260 || m15.length < 60) continue;

      for (let k = lookback; k >= 1; k--) {
        const idx = h1.length - k;
        const bar = h1[idx];
        if (!bar) continue;
        const closeMs = bar.t + INTERVAL_MS['1h'];
        const from = m15.findIndex(b => b.t >= closeMs);
        if (from < 0) continue;

        const history = h1.slice(0, idx + 1);
        for (const structure of I1.detectStructures(history)) {
          for (const cand of I1.candidates(structure, bar.c)) {
            if (cand.gapPct > I1.DEFAULTS.armGapPct) continue;
            const rows = LAB.scoreStructure({
              symbol, structure, candidate: cand, tradeBars: m15, fromIndex: from
            });
            for (const r of rows) {
              journal.push({
                at: now, lane: 'lab', kind: 'ROW', symbol,
                pattern: r.pattern, direction: r.direction, level: r.level,
                entry: r.entry, strength: r.variant,
                note: `${r.outcome} · TP ${r.artificialTp?.toFixed(2)} · ${r.tpMult}×`,
                text: null
              });
              out.rows++;
            }
          }
        }
      }
    } catch (e) {
      out.errors.push(`lab ${symbol}: ${e.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// runOnce — the whole sweep
// ---------------------------------------------------------------------------
export async function runOnce({
  storage, fetchImpl = fetch, now = Date.now(),
  settings: given, sender = sendTelegram, dryRun = false
} = {}) {
  const settings = given || await store.getSettings(storage);
  const journal = [];
  const sent = [];
  const errors = [];

  // Every lane has its own channel. A lane with no channel configured still
  // records to the journal — it just does not send.
  const unsent = [];
  const send = async (text, lane) => {
    // dryRun is "show me what would go out" — it does not need a channel.
    if (dryRun) { sent.push(text); return { ok: true, dryRun: true }; }
    const channel = store.channelFor(settings, lane);
    if (!channel) {
      unsent.push(lane);
      summary.unsent = unsent.length;
      return { ok: false, skipped: 'no channel' };
    }
    const r = await sender({ token: channel.token, chatId: channel.chatId, text, fetchImpl });
    sent.push(text);
    if (!r.ok && r.error) errors.push(`telegram ${lane}: ${r.error}`);
    return r;
  };

  const summary = { at: now, lanes: {}, messages: 0, rows: 0, errors };
  const ctx = { settings, storage, fetchImpl, now, send, journal };

  if (settings.paused) {
    summary.paused = true;
    await store.saveStatus({ ...(await store.getStatus(storage)), lastRun: now, paused: true }, storage);
    return summary;
  }

  const order = [
    ['scalp', settings.lanes.scalp, runScalp],
    ['i1', settings.lanes.i1, runI1],
    ['watch', settings.lanes.watch, runWatch],
    ['lab', settings.lanes.lab, runLab]
  ];

  for (const [name, enabled, fn] of order) {
    if (!enabled) continue;
    try {
      const r = await fn(ctx);
      summary.lanes[name] = r;
      summary.messages += r.printed || 0;
      summary.rows += r.rows || 0;
      errors.push(...(r.errors || []));
    } catch (e) {
      summary.lanes[name] = { error: e.message };
      errors.push(`${name}: ${e.message}`);
    }
  }

  await store.appendJournal(journal, storage, settings.maxJournal);
  const prev = await store.getStatus(storage);
  await store.saveStatus({
    lastRun: now,
    lastError: errors[0] || null,
    counts: {
      ...(prev.counts || {}),
      messages: (prev.counts?.messages || 0) + summary.messages,
      rows: (prev.counts?.rows || 0) + summary.rows
    },
    lanes: summary.lanes
  }, storage);

  summary.sent = sent;
  summary.journalRows = journal.length;
  return summary;
}
