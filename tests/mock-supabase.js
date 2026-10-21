// ============================================================================
// mock-supabase — just enough of PostgREST + GoTrue to test the cloud path.
//
// It is not a database. It is a lie that behaves like one for the five things
// this app does: filter, order, limit, upsert-with-conflict-ignore, delete.
// That is enough to prove the client, the backend and a full sweep work
// against a real HTTP API instead of a hand-wave.
// ============================================================================

import { createServer } from 'node:http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer,accept,accept-profile,content-profile'
};

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    ...CORS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
};

export function startMockSupabase({ anonKey = 'anon-key', serviceKey = 'service-key', port = 0 } = {}) {
  const db = {
    users: new Map(),          // email -> { id, password }
    tokens: new Map(),         // token -> user_id
    tables: { asx_journal: [], asx_sent: [], asx_kv: [], asx_settings: [] },
    seq: 1,
    requests: []
  };

  const tokenFor = id => {
    const t = `t-${id}-${db.seq++}`;
    db.tokens.set(t, id);
    return t;
  };

  const session = (id, email) => ({
    access_token: tokenFor(id),
    refresh_token: `r-${id}`,
    expires_in: 3600,
    user: { id, email }
  });

  function filterRows(table, params, userId) {
    let rows = db.tables[table].slice();
    if (userId) rows = rows.filter(r => r.user_id === userId);   // RLS, simulated
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.')) {
        const want = v.slice(3);
        rows = rows.filter(r => String(r[k]) === want);
      } else if (v.startsWith('in.(')) {
        const list = v.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, ''));
        rows = rows.filter(r => list.includes(String(r[k])));
      }
    }
    const order = params.get('order');
    if (order) {
      const [col, dir = 'asc'] = order.split('.');
      rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const limit = Number(params.get('limit'));
    if (limit > 0) rows = rows.slice(0, limit);
    return rows;
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');
    db.requests.push({ method: req.method, path: url.pathname, query: url.search, body });

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const apikey = req.headers.apikey;

    // who is asking?
    let userId = null;
    let isService = false;
    if (bearer === serviceKey || apikey === serviceKey) isService = true;
    else if (bearer) userId = db.tokens.get(bearer) || null;
    else if (apikey === serviceKey) isService = true;

    // ── auth ───────────────────────────────────────────────────────────────
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = db.users.get(body?.email);
        if (!u || u.password !== body?.password) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        }
        return json(res, 200, session(u.id, body.email));
      }
      if (grant === 'refresh_token') {
        const id = String(body?.refresh_token || '').slice(2);
        const u = [...db.users.values()].find(x => x.id === id);
        if (!u) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, session(u.id, u.email));
      }
    }

    if (url.pathname === '/auth/v1/signup') {
      if (db.users.has(body?.email)) return json(res, 400, { msg: 'User already registered' });
      const id = `00000000-0000-4000-8000-${String(db.seq++).padStart(12, '0')}`;
      db.users.set(body.email, { id, password: body.password, email: body.email });
      return json(res, 200, session(id, body.email));
    }

    if (url.pathname === '/auth/v1/logout') {
      if (bearer) db.tokens.delete(bearer);
      return json(res, 204, null);
    }

    // ── rest ───────────────────────────────────────────────────────────────
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return json(res, 404, { message: 'not found' });
    const table = m[1];
    if (!db.tables[table]) return json(res, 404, { message: `no table ${table}` });

    if (!isService && !userId) return json(res, 401, { message: 'JWT required' });

    const params = url.searchParams;
    const scope = isService ? null : userId;

    if (req.method === 'GET') {
      return json(res, 200, filterRows(table, params, scope));
    }

    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const prefer = String(req.headers.prefer || '');
      const ignoreDupes = prefer.includes('ignore-duplicates');
      const mergeDupes = prefer.includes('merge-duplicates');
      const onConflict = params.get('on_conflict');
      const conflictCols = onConflict ? onConflict.split(',') : null;

      const out = [];
      for (const r of rows) {
        const row = { id: table === 'asx_journal' ? db.seq++ : undefined, ...r };
        if (scope && row.user_id !== scope) continue;      // RLS with check

        // A plain insert never conflicts. Only a request that names a conflict
        // target (on_conflict + a resolution) can upsert or skip.
        const dup = (ignoreDupes || mergeDupes) && conflictCols
          ? db.tables[table].find(e => conflictCols.every(c => String(e[c]) === String(row[c])))
          : null;

        if (dup) {
          if (ignoreDupes) continue;                        // the claim() path
          Object.assign(dup, row);                          // upsert
          out.push(dup);
        } else {
          db.tables[table].push(row);
          out.push(row);
        }
      }
      return json(res, 201, prefer.includes('return=representation') ? out : null);
    }

    if (req.method === 'DELETE') {
      const doomed = new Set(filterRows(table, params, scope).map(r => r));
      db.tables[table] = db.tables[table].filter(r => !doomed.has(r));
      return json(res, 204, null);
    }

    return json(res, 405, { message: 'method not allowed' });
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        anonKey,
        serviceKey,
        db,
        addUser(email, password) {
          const id = `00000000-0000-4000-8000-${String(db.seq++).padStart(12, '0')}`;
          db.users.set(email, { id, password, email });
          return id;
        },
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
