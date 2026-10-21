// ============================================================================
// site.js — the web app's front door.
//
// Order of operations, because it matters:
//   1. read the config
//   2. get a session (or show the sign-in card)
//   3. point the ONE store at Supabase
//   4. only then import app.js, which boots against that store
//
// app.js is imported dynamically on purpose: it boots on import, so it must not
// be evaluated before the backend is in place.
// ============================================================================

import * as store from '../src/store/store.js';
import { createClient, localSessionStore } from '../src/data/supabase.js';
import { createSupabaseBackend } from '../src/store/supabase-backend.js';
import { CONFIG, isConfigured } from './config.js';

const $ = s => document.querySelector(s);

const gate = $('#gate');
const gateForm = $('#gateForm');
const gateError = $('#gateError');
const gateGo = $('#gateGo');
const gateNote = $('#gateNote');
const siteBar = $('#siteBar');
const siteWho = $('#siteWho');

let client = null;

function fail(message) {
  gateError.textContent = message;
  gateError.classList.add('on');
}
function clearError() {
  gateError.textContent = '';
  gateError.classList.remove('on');
}
function busy(on) {
  gateGo.disabled = on;
  gateGo.textContent = on ? 'Signing in…' : 'Sign in';
}

async function boot() {
  if (!isConfigured()) {
    $('#gateTitle').textContent = 'Not configured yet';
    $('#gateSub').textContent = 'Edit site/config.js and paste your Supabase URL and anon key.';
    gateForm.querySelectorAll('input, button').forEach(el => (el.disabled = true));
    gateNote.textContent = 'SETUP-CLOUD.md walks through it — it takes about five minutes.';
    return;
  }

  client = createClient({
    url: CONFIG.supabaseUrl,
    anonKey: CONFIG.supabaseAnonKey,
    sessionStore: localSessionStore()
  });

  let session = null;
  try {
    session = await client.getSession();
  } catch {
    session = null;
  }

  if (!session) {
    showGate('Sign in');
    return;
  }
  await enterApp(session);
}

function showGate(title = 'Sign in') {
  $('#gateTitle').textContent = title;
  gate.classList.remove('gone');
  siteBar.classList.add('hidden');
  setTimeout(() => $('#gateEmail').focus(), 50);
}

async function enterApp(session) {
  store.useBackend(createSupabaseBackend(client));

  siteWho.textContent = session.user?.email || 'signed in';
  siteBar.classList.remove('hidden');
  gate.classList.add('gone');

  // the app boots the moment it is evaluated
  await import('../src/app/app.js');
}

// ── signing in ─────────────────────────────────────────────────────────────
gateForm.addEventListener('submit', async e => {
  e.preventDefault();
  clearError();
  const email = $('#gateEmail').value.trim();
  const password = $('#gatePassword').value;
  if (!email || !password) return fail('Email and password, please.');

  busy(true);
  try {
    const session = await client.signIn(email, password);
    await enterApp(session);
  } catch (err) {
    const msg = String(err.message || err);
    fail(/invalid/i.test(msg) ? 'Wrong email or password.' : msg);
  } finally {
    busy(false);
  }
});

$('#siteOut').addEventListener('click', async () => {
  await client.signOut();
  location.reload();
});

// ── "Run now" from a phone ─────────────────────────────────────────────────
// The browser cannot fetch Binance candles itself (CORS) and the sweep needs a
// server anyway. So the app writes a run request to the database and watches
// the status key until the sweep job answers.
globalThis.__ASX_RUN_NOW__ = async () => {
  const backend = createSupabaseBackend(client);
  const before = (await backend.getStatus())?.lastRun || 0;

  await backend.requestRun('web');

  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const s = await backend.getStatus();
    if ((s?.lastRun || 0) > before) {
      const journal = await store.getJournal();
      globalThis.__ASX_REFRESH__?.(journal, s);
      return { ok: true, summary: { messages: 0, rows: 0, requested: true } };
    }
  }
  return {
    ok: false,
    error: 'the sweep job did not answer in 100s — it will pick the request up on its next tick'
  };
};

// ── test message from the web app ──────────────────────────────────────────
// Telegram's Bot API answers CORS, so the browser can post directly.
globalThis.__ASX_TEST_TELEGRAM__ = async ({ token, chatId, text }) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    const body = await res.json().catch(() => ({}));
    return body.ok ? { ok: true } : { ok: false, error: body.description || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

boot();
