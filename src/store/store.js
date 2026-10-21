// ============================================================================
// store — settings, journal, dedupe, lane state.
//
// The API never changes. Where the data LIVES is a backend:
//
//   • local     — chrome.storage.local (the extension) or memory (tests)
//   • supabase  — Postgres, so a phone, a laptop and the sweep job all read
//                 the same rows (src/store/supabase-backend.js)
//
// Call `useBackend()` once and every caller — the app, the runner, the tests —
// keeps using the same functions.
// ============================================================================

export const STORE_VERSION = 1;

// One channel per lane that talks. Lab is absent on purpose — it never sends.
export const LANE_CHANNELS = ['scalp', 'i1', 'watch'];

const emptyChannel = () => ({ token: '', chatId: '' });

export const DEFAULT_SETTINGS = {
  version: STORE_VERSION,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  telegram: {
    scalp: emptyChannel(),
    i1: emptyChannel(),
    watch: emptyChannel()
  },
  lanes: { scalp: true, i1: true, watch: true, lab: true },
  watchFrame: '1h',            // '1h' | '4h'
  watchCloseOutBars: 12,
  sendCloseOuts: true,
  scalpPresets: ['S1', 'S2'],
  paused: false,
  maxJournal: 5000
};

const KEY_SETTINGS = 'settings';
const KEY_JOURNAL = 'journal';
const KEY_SENT = 'sent';
const KEY_STATE = 'laneState';
const KEY_STATUS = 'status';

// --- the fallback area ------------------------------------------------------
// Module scope on purpose: a fresh Map per call would silently drop everything
// between two reads.
const MEM = new Map();
const MEMORY_STORE = {
  get: async k => (MEM.has(k) ? { [k]: MEM.get(k) } : {}),
  set: async o => { for (const [k, v] of Object.entries(o)) MEM.set(k, v); },
  remove: async k => { MEM.delete(k); }
};

function defaultArea() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  return MEMORY_STORE;
}

// ---------------------------------------------------------------------------
// the local backend — a few keys in a web storage area
// ---------------------------------------------------------------------------
export function createLocalBackend(area = null) {
  const a = area || defaultArea();

  const read = async key => (await a.get(key))?.[key];
  const write = async (key, value) => a.set({ [key]: value });

  return {
    kind: 'local',

    async getSettings() { return mergeSettings(await read(KEY_SETTINGS)); },

    async saveSettings(patch) {
      const cur = await this.getSettings();
      const next = mergeSettings({
        ...cur,
        ...patch,
        telegram: mergeTelegram(cur.telegram, patch.telegram),
        lanes: { ...cur.lanes, ...(patch.lanes || {}) }
      });
      await write(KEY_SETTINGS, next);
      return next;
    },

    async getJournal() { return (await read(KEY_JOURNAL)) || []; },

    async appendJournal(rows, max = DEFAULT_SETTINGS.maxJournal) {
      if (!rows || !rows.length) return;
      const cur = await this.getJournal();
      await write(KEY_JOURNAL, rows.concat(cur).slice(0, max));
    },

    async clearJournal() { await write(KEY_JOURNAL, []); },

    async claim(keys, nowMs = Date.now()) {
      if (!keys || !keys.length) return [];
      const sent = (await read(KEY_SENT)) || {};
      const fresh = keys.filter(k => !sent[k]);
      for (const k of fresh) sent[k] = nowMs;
      const cutoff = nowMs - 14 * 24 * 60 * 60_000;
      for (const [k, ts] of Object.entries(sent)) if (ts < cutoff) delete sent[k];
      await write(KEY_SENT, sent);
      return fresh;
    },

    async release(keys) {
      if (!keys || !keys.length) return;
      const sent = (await read(KEY_SENT)) || {};
      for (const k of keys) delete sent[k];
      await write(KEY_SENT, sent);
    },

    async clearSent() { await write(KEY_SENT, {}); },

    async getLaneState() { return (await read(KEY_STATE)) || {}; },
    async saveLaneState(state) { await write(KEY_STATE, state); },

    async getStatus() {
      return (await read(KEY_STATUS)) || { lastRun: null, lastError: null, counts: {}, lanes: {} };
    },
    async saveStatus(status) { await write(KEY_STATUS, status); }
  };
}

// ---------------------------------------------------------------------------
// which backend answers this call
// ---------------------------------------------------------------------------
let active = null;

/** Point the store at a backend (the supabase one, once the user is signed in). */
export function useBackend(backend) { active = backend; return backend; }
export function activeBackend() { return active; }
export function resetBackend() { active = null; }

function backendFor(storage) {
  if (storage) return createLocalBackend(storage);   // tests hand in their own area
  return active || createLocalBackend();
}

// ---------------------------------------------------------------------------
// the public API — unchanged, so nothing else had to move
// ---------------------------------------------------------------------------
export async function getSettings(storage) { return backendFor(storage).getSettings(); }
export async function saveSettings(patch, storage) { return backendFor(storage).saveSettings(patch); }

export async function getJournal(storage) { return backendFor(storage).getJournal(); }
export async function appendJournal(rows, storage, max) { return backendFor(storage).appendJournal(rows, max); }
export async function clearJournal(storage) { return backendFor(storage).clearJournal(); }

export async function getSent(storage) { return backendFor(storage).getSent?.() ?? {}; }
export async function claim(keys, storage, nowMs) { return backendFor(storage).claim(keys, nowMs); }
export async function release(keys, storage) { return backendFor(storage).release(keys); }
export async function clearSent(storage) { return backendFor(storage).clearSent(); }

export async function getLaneState(storage) { return backendFor(storage).getLaneState(); }
export async function saveLaneState(state, storage) { return backendFor(storage).saveLaneState(state); }

export async function getStatus(storage) { return backendFor(storage).getStatus(); }
export async function saveStatus(status, storage) { return backendFor(storage).saveStatus(status); }

// ---------------------------------------------------------------------------
// pure helpers — no storage involved
// ---------------------------------------------------------------------------
export function mergeSettings(saved) {
  if (!saved) return clone(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    telegram: migrateTelegram(saved.telegram),
    lanes: { ...DEFAULT_SETTINGS.lanes, ...(saved.lanes || {}) }
  };
}

/**
 * v1.0.0 stored one { token, chatId } for the whole product. Later versions
 * store one per lane. A flat pair is copied into every lane so nobody loses a
 * channel they had already configured.
 */
function migrateTelegram(tg) {
  const flat = (tg && typeof tg.token === 'string' && (tg.token || tg.chatId))
    ? { token: tg.token, chatId: tg.chatId || '' }
    : null;

  const out = {};
  for (const lane of LANE_CHANNELS) {
    const c = tg && tg[lane];
    if (c && typeof c === 'object') {
      out[lane] = { token: c.token || '', chatId: c.chatId || '' };
    } else {
      out[lane] = flat ? { ...flat } : emptyChannel();
    }
  }
  return out;
}

function mergeTelegram(cur, patch) {
  const out = { ...cur };
  for (const lane of LANE_CHANNELS) {
    if (patch?.[lane]) {
      out[lane] = {
        token: patch[lane].token ?? cur[lane].token,
        chatId: patch[lane].chatId ?? cur[lane].chatId
      };
    }
  }
  return out;
}

/**
 * The credentials for one lane, or null when that channel is not set up.
 * Lab is refused by name — it never sends, so it can never be handed a channel.
 */
export function channelFor(settings, lane) {
  if (!LANE_CHANNELS.includes(lane)) return null;
  const c = settings?.telegram?.[lane];
  if (!c || !c.token || !c.chatId) return null;
  return c;
}

/** 'YYYY-MM' in the user's own timezone, which is what a month picker means. */
export function monthKey(atMs) {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(atMs) {
  const d = new Date(atMs);
  return `${monthKey(atMs)}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every month that has rows, newest first. */
export function monthsIn(rows) {
  const set = new Set(rows.map(r => monthKey(r.at)));
  return [...set].sort().reverse();
}

/** The export periods, plus the month picker. Values match the <select>. */
export const RANGES = ['month', 'day', 'd3', 'd7', 'd14'];

const startOfDay = ms => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (ms, n) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

/**
 * Turn a period into a half-open window [from, to) in the user's own timezone.
 * "Last 3 days" means today and the two days before it, not 72 hours.
 */
export function rangeWindow({ range = 'month', month, day, now = Date.now() } = {}) {
  if (range === 'month') {
    const key = month || monthKey(now);
    const [y, m] = key.split('-').map(Number);
    return {
      from: new Date(y, m - 1, 1).getTime(),
      to: new Date(y, m, 1).getTime(),
      label: key
    };
  }
  if (range === 'day') {
    const from = day ? startOfDay(new Date(`${day}T00:00:00`).getTime()) : startOfDay(now);
    return { from, to: addDays(from, 1), label: dayKey(from) };
  }
  const n = range === 'd3' ? 3 : range === 'd7' ? 7 : range === 'd14' ? 14 : 1;
  const from = addDays(startOfDay(now), -(n - 1));
  return { from, to: addDays(startOfDay(now), 1), label: `last-${n}-days` };
}

/** Rows inside a period, optionally narrowed to one lane. */
// A row's `at` is a number of milliseconds in the local store, but Supabase
// hands back a timestamptz, which arrives as a string like
// '2026-10-21T09:14:00+00:00'. Comparing a string to a number is silently
// always false, so every period filter would come back empty in cloud mode.
// Coerce once, here, and let everything downstream stay numeric.
export function atMs(at) {
  if (typeof at === 'number') return at;
  const t = Date.parse(at);
  return Number.isNaN(t) ? NaN : t;
}

export function filterByRange(rows, opts = {}) {
  const { from, to } = rangeWindow(opts);
  const lane = opts.lane;
  return rows.filter(r => {
    const t = atMs(r.at);
    return t >= from && t < to &&
      (!lane || lane === 'all' || r.lane === lane);
  });
}

/** Newest first — the order every list in the UI is read in. */
export function byNewest(rows) {
  return [...rows].sort((a, b) => atMs(b.at) - atMs(a.at));
}

export function filterJournal(rows, { month, lane } = {}) {
  return rows.filter(r =>
    (!month || monthKey(r.at) === month) &&
    (!lane || lane === 'all' || r.lane === lane)
  );
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
