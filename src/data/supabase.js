// ============================================================================
// supabase — a tiny client. No SDK, no build step, just fetch.
//
// Two jobs:
//   1. AUTH   — email + password against Supabase Auth (GoTrue).
//   2. REST   — read and write the tables in supabase/schema.sql (PostgREST).
//
// Everything is injectable (fetch, session storage) so the whole thing runs in
// Node tests against a mock server, not just in a browser.
// ============================================================================

const enc = s => encodeURIComponent(s);

/** A session store that survives a reload in the browser and works in Node. */
export function memorySessionStore() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? { [k]: m.get(k) } : {}),
    set: async o => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
    remove: async k => { m.delete(k); }
  };
}

export function localSessionStore(prefix = 'asx:') {
  /* localStorage is not merely absent in some places — in a sandboxed iframe,
     or with site data blocked, the property itself throws on access, and in
     Safari's private mode setItem does. Probe it once and fall back to memory
     rather than dying at the login gate. */
  if (!storageWorks()) return memorySessionStore();
  return {
    get: async k => {
      const v = localStorage.getItem(prefix + k);
      return v ? { [k]: JSON.parse(v) } : {};
    },
    set: async o => {
      for (const [k, v] of Object.entries(o)) localStorage.setItem(prefix + k, JSON.stringify(v));
    },
    remove: async k => { localStorage.removeItem(prefix + k); }
  };
}

function storageWorks() {
  try {
    const probe = '__asx_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function createClient({
  url,
  anonKey,
  fetchImpl = fetch,
  sessionStore = memorySessionStore(),
  storageKey = 'session'
} = {}) {
  if (!url) throw new Error('supabase: url is required');
  if (!anonKey) throw new Error('supabase: anonKey is required');

  const base = url.replace(/\/+$/, '');
  const session = { current: null };
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(session.current); } catch { /* ignore */ } } };

  async function load() {
    if (session.current) return session.current;
    const r = await sessionStore.get(storageKey);
    session.current = r?.[storageKey] || null;
    return session.current;
  }

  async function store(s) {
    session.current = s;
    if (s) await sessionStore.set({ [storageKey]: s });
    else await sessionStore.remove(storageKey);
    emit();
    return s;
  }

  function authHeaders(extra = {}) {
    const h = { apikey: anonKey, ...extra };
    const token = session.current?.access_token;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async function parse(res) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  }

  function fail(what, r) {
    const msg = r.body?.msg || r.body?.message || r.body?.error_description ||
                r.body?.error || (typeof r.body === 'string' ? r.body : '') || `HTTP ${r.status}`;
    return new Error(`${what}: ${msg}`);
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  async function signIn(email, password) {
    const res = await fetchImpl(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const r = await parse(res);
    if (!r.ok || !r.body?.access_token) throw fail('sign in', r);
    return store(normaliseSession(r.body));
  }

  async function signUp(email, password) {
    const res = await fetchImpl(`${base}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const r = await parse(res);
    if (!r.ok) throw fail('sign up', r);
    // Depending on the project settings, signup either returns a session or
    // asks the user to confirm their email first.
    if (r.body?.access_token) return store(normaliseSession(r.body));
    return { needsConfirmation: true, email };
  }

  async function refresh() {
    const s = await load();
    if (!s?.refresh_token) return null;
    const res = await fetchImpl(`${base}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    const r = await parse(res);
    if (!r.ok || !r.body?.access_token) return null;
    return store(normaliseSession(r.body));
  }

  async function signOut() {
    const s = await load();
    if (s?.access_token) {
      await fetchImpl(`${base}/auth/v1/logout`, {
        method: 'POST',
        headers: authHeaders()
      }).catch(() => {});
    }
    return store(null);
  }

  /** A valid session, refreshed if it is within a minute of expiring. */
  async function validSession() {
    const s = await load();
    if (!s) return null;
    const soon = !s.expires_at || (s.expires_at - Date.now()) < 60_000;
    if (!soon) return s;
    return (await refresh()) || s;
  }

  // ── rest ─────────────────────────────────────────────────────────────────
  async function request(path, { method = 'GET', body, headers = {}, prefer } = {}) {
    await validSession();
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method,
      headers: authHeaders({
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers
      }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const r = await parse(res);
    if (!r.ok) throw fail(`rest ${method} ${path.split('?')[0]}`, r);
    return r.body;
  }

  return {
    url: base,
    onAuthChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getSession: async () => validSession(),
    getCurrentSession: () => session.current,
    userId: async () => (await validSession())?.user?.id || null,
    signIn, signUp, signOut, refresh,
    request,

    // small helpers so the backend reads like the tables
    select: (table, query = '') => request(`${table}${query ? '?' + query : ''}`),
    insert: (table, rows) => request(table, { method: 'POST', body: rows, prefer: 'return=representation' }),
    upsert: (table, rows, onConflict) => request(
      `${table}${onConflict ? '?on_conflict=' + enc(onConflict) : ''}`,
      { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' }),
    remove: (table, query) => request(`${table}?${query}`, { method: 'DELETE', prefer: 'return=minimal' })
  };
}

function normaliseSession(body) {
  const expiresIn = Number(body.expires_in) || 3600;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    user: body.user || { id: body.user_id, email: body.email }
  };
}
