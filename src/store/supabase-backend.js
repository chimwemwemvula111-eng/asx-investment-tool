// ============================================================================
// supabase-backend — the same store API, but the data lives in Postgres.
//
// This is what makes the tool stop being tied to one browser: the extension,
// the phone site and the sweep job all talk to the same rows.
//
// Two ways in:
//   • signed in  — the client carries the user's access token and RLS decides
//                  what is visible. userId is read from the session.
//   • service    — the sweep job uses the service key and passes userId
//                  explicitly. RLS is bypassed by design; never ship this key
//                  to a browser.
// ============================================================================

import { DEFAULT_SETTINGS, mergeSettings, channelFor } from './store.js';

const CHUNK = 500;

export function createSupabaseBackend(client, { userId = null } = {}) {
  const uid = async () => {
    const id = userId || await client.userId();
    if (!id) throw new Error('supabase: not signed in');
    return id;
  };

  // ── row <-> app shapes ───────────────────────────────────────────────────
  const toRow = (r, id) => ({
    user_id: id,
    at: new Date(r.at).toISOString(),
    lane: r.lane,
    kind: r.kind,
    symbol: r.symbol ?? null,
    pattern: r.pattern ?? null,
    direction: r.direction ?? null,
    level: r.level == null || r.level === '' ? null : Number(r.level),
    entry: r.entry == null || r.entry === '' ? null : Number(r.entry),
    tag: r.strength ?? null,
    note: r.note ?? null,
    body: r.text ?? null
  });

  const fromRow = row => ({
    at: Date.parse(row.at),
    lane: row.lane,
    kind: row.kind,
    symbol: row.symbol,
    pattern: row.pattern,
    direction: row.direction,
    level: row.level,
    entry: row.entry,
    strength: row.tag || '',
    note: row.note || '',
    text: row.body || null
  });

  const q = s => encodeURIComponent(s);

  async function rpc(name, args) {
    return client.request(`rpc/${name}`, { method: 'POST', body: args });
  }

  return {
    kind: 'supabase',

    // ── settings ───────────────────────────────────────────────────────────
    async getSettings() {
      const id = await uid();
      const rows = await client.select('asx_settings', `select=data&user_id=eq.${id}`);
      return mergeSettings(rows?.[0]?.data);
    },

    async saveSettings(patch) {
      const id = await uid();
      const cur = await this.getSettings();
      const next = mergeSettings({
        ...cur,
        ...patch,
        telegram: {
          ...cur.telegram,
          ...Object.fromEntries(
            Object.entries(patch.telegram || {}).map(([lane, c]) => [lane, {
              token: c.token ?? cur.telegram[lane]?.token ?? '',
              chatId: c.chatId ?? cur.telegram[lane]?.chatId ?? ''
            }])
          )
        },
        lanes: { ...cur.lanes, ...(patch.lanes || {}) }
      });
      await client.upsert('asx_settings',
        [{ user_id: id, data: next, updated_at: new Date().toISOString() }], 'user_id');
      return next;
    },

    // ── journal ────────────────────────────────────────────────────────────
    async getJournal(limit = DEFAULT_SETTINGS.maxJournal) {
      const id = await uid();
      const rows = await client.select('asx_journal',
        `select=*&user_id=eq.${id}&order=at.desc&limit=${Number(limit) || 5000}`);
      return (rows || []).map(fromRow);
    },

    async appendJournal(rows, max = DEFAULT_SETTINGS.maxJournal) {
      if (!rows || !rows.length) return;
      const id = await uid();
      for (let i = 0; i < rows.length; i += CHUNK) {
        await client.insert('asx_journal', rows.slice(i, i + CHUNK).map(r => toRow(r, id)));
      }
      // keep the table bounded; the SQL function owns the rule
      await rpc('asx_trim_journal', { p_user: id, p_keep: max }).catch(() => {});
    },

    async clearJournal() {
      const id = await uid();
      await client.remove('asx_journal', `user_id=eq.${id}`);
    },

    // ── dedupe ─────────────────────────────────────────────────────────────
    /**
     * Insert every key; Postgres keeps the ones that were already there and
     * returns only the newly written rows. That is exactly "a break prints
     * once", decided by the database rather than by the client.
     */
    async claim(keys, nowMs = Date.now()) {
      if (!keys || !keys.length) return [];
      const id = await uid();
      const at = new Date(nowMs).toISOString();
      const fresh = [];
      for (let i = 0; i < keys.length; i += CHUNK) {
        const batch = keys.slice(i, i + CHUNK).map(k => ({ user_id: id, key: k, at }));
        const wrote = await client.request('asx_sent?on_conflict=user_id,key&select=key', {
          method: 'POST',
          body: batch,
          prefer: 'resolution=ignore-duplicates,return=representation'
        });
        for (const r of wrote || []) fresh.push(r.key);
      }
      await rpc('asx_trim_sent', { p_user: id }).catch(() => {});
      return fresh;
    },

    async release(keys) {
      if (!keys || !keys.length) return;
      const id = await uid();
      const list = keys.map(k => `"${String(k).replace(/"/g, '\\"')}"`).join(',');
      await client.remove('asx_sent', `user_id=eq.${id}&key=in.(${q(list)})`);
    },

    async clearSent() {
      const id = await uid();
      await client.remove('asx_sent', `user_id=eq.${id}`);
    },

    // ── lane state + status ────────────────────────────────────────────────
    async _getKv(key) {
      const id = await uid();
      const rows = await client.select('asx_kv', `select=value&user_id=eq.${id}&key=eq.${q(key)}`);
      return rows?.[0]?.value ?? null;
    },

    async _setKv(key, value) {
      const id = await uid();
      await client.upsert('asx_kv',
        [{ user_id: id, key, value, updated_at: new Date().toISOString() }], 'user_id,key');
    },

    async getLaneState() { return (await this._getKv('laneState')) || {}; },
    async saveLaneState(state) { await this._setKv('laneState', state); },

    async getStatus() {
      return (await this._getKv('status')) || { lastRun: null, lastError: null, counts: {}, lanes: {} };
    },
    async saveStatus(status) { await this._setKv('status', status); },

    // ── run requests (the phone asks, the sweep job answers) ───────────────
    async requestRun(who = 'app') {
      await this._setKv('run_request', { at: Date.now(), by: who });
    },
    async takeRunRequest() {
      const r = await this._getKv('run_request');
      if (!r) return null;
      await this._setKv('run_request', null);
      return r;
    }
  };
}

/** The channels a sweep is allowed to post to, for logging. */
export function channelSummary(settings) {
  return ['scalp', 'i1', 'watch'].map(l => ({ lane: l, configured: !!channelFor(settings, l) }));
}
