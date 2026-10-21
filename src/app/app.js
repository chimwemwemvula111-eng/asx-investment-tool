// ============================================================================
// app — the whole UI. Vanilla, no framework, no build step.
// Reads the store directly; talks to the service worker for runs.
//
// The lane views show TODAY. Anything older lives in History, where it can be
// filtered by month and lane and taken out as JSON or a real .xlsx.
// ============================================================================

import * as store from '../store/store.js';
import { buildXlsx } from './xlsx.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const VIEWS = ['scalp', 'intraday', 'watch', 'lab', 'history', 'settings'];
const LANE_OF_VIEW = { scalp: 'scalp', intraday: 'intraday', watch: 'watch', lab: 'lab' };
const KIND_CLASS = { SIGNAL: 'long', WAKEUP: 'wake', 'WAKE-UP': 'wake', BREAK: 'break', 'CLOSE-OUT': 'dead', ROW: 'dead' };
const CHANNELS = [
  { key: 'scalp', label: 'Scalp' },
  { key: 'i1', label: 'Intraday' },
  { key: 'watch', label: 'Watch' }
];

let state = { settings: null, journal: [], status: null };

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  await reload();
  const hash = (location.hash || '#scalp').slice(1);
  show(VIEWS.includes(hash) ? hash : 'scalp');
  wire();
  renderAll();
  setInterval(refreshStatus, 8000);
}

async function reload() {
  state.settings = await store.getSettings();
  state.journal = await store.getJournal();
  state.status = await store.getStatus();
}

function wire() {
  $$('.nav-item').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v)) show(v);
  });
  $('#runNow').addEventListener('click', runNow);
  $('#saveSettings').addEventListener('click', saveSettings);
  $$('.test-tg').forEach(b => b.addEventListener('click', () => testTelegram(b.dataset.lane)));
  $('#histMonth').addEventListener('change', renderHistory);
  $('#histDay').addEventListener('change', renderHistory);
  $('#histRange').addEventListener('change', () => { syncRangeControls(); renderHistory(); });
  $('#histLane').addEventListener('change', renderHistory);
  $('#exportHistory').addEventListener('click', exportHistory);
  $('#clearHistory').addEventListener('click', clearHistory);
}

// ── routing ────────────────────────────────────────────────────────────────
function show(view) {
  VIEWS.forEach(v => $(`#view-${v}`)?.classList.toggle('on', v === view));
  $$('.nav-item').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  // A sandboxed iframe (the shared preview) refuses history writes — routing
  // still works, it just does not survive a reload.
  try { history.replaceState(null, '', `#${view}`); } catch { /* preview */ }
  if (view === 'settings') fillSettings();
  if (view === 'history') renderHistory();
  if (view === 'lab') renderLab();
}

// ── rendering ──────────────────────────────────────────────────────────────
function renderAll() {
  renderFeed('scalp');
  renderFeed('intraday');
  renderFeed('watch');
  renderLab();
  renderHistory();
  renderPulse();
}

/** Rows for one lane, TODAY only. Old rows live in History. */
function todayRows(lane) {
  const today = store.dayKey(Date.now());
  return store.byNewest(state.journal.filter(r => r.lane === lane && store.dayKey(r.at) === today));
}
function laneRows(lane) {
  return state.journal.filter(r => r.lane === lane);
}

function renderFeed(view) {
  const lane = LANE_OF_VIEW[view];
  const host = $(`#feed-${view}`);
  const stats = $(`#stats-${view}`);
  if (!host) return;

  const rows = todayRows(lane).slice(0, 200);
  if (stats) {
    stats.innerHTML = `
      <div class="stat"><b>${rows.length}</b><span>today</span></div>
      <div class="stat"><b>${laneRows(lane).length}</b><span>all time</span></div>
      <div class="stat"><b>${state.settings?.lanes?.[lane] ? 'on' : 'off'}</b><span>lane</span></div>`;
  }

  if (!rows.length) {
    host.innerHTML = `<div class="empty"><b>Nothing today.</b>
      The lane writes here the moment it sees something. Older rows are in
      <em>History</em>. Press <em>Run now</em> to sweep immediately.</div>`;
    return;
  }

  host.innerHTML = rows.map(r => {
    const cls = KIND_CLASS[r.kind] || 'dead';
    const dirCls = r.direction === 'long' || r.direction === 'BUY' ? 'long'
                 : r.direction === 'short' || r.direction === 'SELL' ? 'short' : '';
    // a dead structure has no direction any more — grey it out
    const edge = (r.kind === 'CLOSE-OUT' || r.kind === 'ROW') ? 'dead' : (dirCls || cls);
    const when = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const figs = [];
    if (r.level != null) figs.push(`<div class="fig"><em>level</em><b>${fmt(r.level)}</b></div>`);
    if (r.entry != null) figs.push(`<div class="fig"><em>entry</em><b>${fmt(r.entry)}</b></div>`);
    if (r.strength) figs.push(`<div class="fig"><em>tag</em><b class="quiet">${escapeHtml(r.strength)}</b></div>`);

    return `
      <article class="rec ${edge}">
        <span class="rec-edge"></span>
        <div class="rec-body">
          <div class="rec-id">
            <span class="sym">${r.symbol || '—'}</span>
            <span class="meta">
              ${dirCls ? `<span class="pill ${dirCls}">${r.direction.toUpperCase()}</span>` : ''}
              ${r.kind === 'SIGNAL' ? '' : `<span class="pill ${cls}">${r.kind}</span>`}
              <span class="pattern">${escapeHtml(r.pattern || '')}</span>
            </span>
          </div>
          <div class="rec-figs">${figs.join('')}</div>
          <div class="rec-end"><span class="when">${when}</span></div>
        </div>
        ${r.note ? `<div class="rec-note">${escapeHtml(r.note)}</div>` : ''}
      </article>`;
  }).join('');
}

/* The lab records nine readings of the same idea. The names in the lane are
   code identifiers (A_strict_single); nobody wants to read those on a phone,
   so the board wears plain labels and keeps the identifier underneath. */
const LAB_LABELS = {
  A_strict_single: 'One strict close',
  B_two_closes: 'Two closes beyond',
  C_two_closes_bodies: 'Two closes, real bodies',
  D_two_of_three: 'Two of three',
  E_hold_after: 'Holds after the break',
  F_softer_single: 'One softer close',
  G_displacement: 'Displacement',
  H_two_candle_displacement: 'Two-candle displacement',
  I_body_plus_displacement: 'Body plus displacement'
};

function renderLab() {
  const host = $('#lab-board');
  if (!host) return;
  const rows = todayRows('lab');
  const byVariant = new Map();
  for (const r of rows) {
    const key = r.strength || r.variant || '—';
    const v = byVariant.get(key) || { n: 0, tp: 0, other: 0, both: 0, open: 0 };
    v.n++;
    const note = (r.note || '').toLowerCase();
    if (note.startsWith('tp')) v.tp++;
    else if (note.startsWith('opposite')) v.other++;
    else if (note.startsWith('both')) v.both++;
    else v.open++;
    byVariant.set(key, v);
  }
  $('#stats-lab').innerHTML = `
    <div class="stat"><b>${rows.length}</b><span>rows today</span></div>
    <div class="stat"><b>${byVariant.size}</b><span>ideas</span></div>
    <div class="stat"><b>0</b><span>messages</span></div>`;

  if (!byVariant.size) {
    host.innerHTML = `<div class="empty"><b>The lab is silent by design.</b>
      It records every confirmation idea against an artificial ruler and never notifies.
      Today's rows appear here once the lane has run.</div>`;
    return;
  }

  /* A..I, so a variant keeps its place from one day to the next even when the
     counts shuffle. */
  const order = [...byVariant.keys()].sort((a, b) => a.localeCompare(b));
  host.innerHTML = order.map((key) => {
    const v = byVariant.get(key);
    const decided = v.tp + v.other;
    const wins = v.tp + v.both * 0.5;
    const pct = decided ? Math.round((wins / decided) * 100) : 0;
    const truth = decided ? `${v.tp}/${decided}` : '—';
    const bits = [`${v.n} ${v.n === 1 ? 'row' : 'rows'}`];
    if (v.tp) bits.push(`${v.tp} to the ruler`);
    if (v.other) bits.push(`${v.other} the other way`);
    if (v.both) bits.push(`${v.both} both at once`);
    if (v.open) bits.push(`${v.open} still open`);
    return `<div class="variant">
      <h4>${escapeHtml(LAB_LABELS[key] || key)}</h4>
      <div class="big">${truth}</div>
      <div class="meta">${bits.join(' · ')}</div>
      <div class="meter"><i style="width:${decided ? pct : 0}%"></i></div>
      <div class="code">${escapeHtml(key)}</div>
    </div>`;
  }).join('');
}

// ── history ────────────────────────────────────────────────────────────────
function historySelection() {
  return {
    range: $('#histRange').value || 'month',
    month: $('#histMonth').value || store.monthKey(Date.now()),
    day: $('#histDay').value || store.dayKey(Date.now()),
    lane: $('#histLane').value || 'all'
  };
}

function historyRows() {
  return store.byNewest(store.filterByRange(state.journal, historySelection()));
}

/** Only the picker that matters for the chosen period is visible. */
function syncRangeControls() {
  const range = $('#histRange').value;
  $('#cellMonth').classList.toggle('hidden', range !== 'month');
  $('#cellDay').classList.toggle('hidden', range !== 'day');
}

function renderHistory() {
  const body = $('#history-table tbody');
  if (!body) return;

  const monthInput = $('#histMonth');
  if (!monthInput.value) {
    // default to the newest month that has data, else this month
    const months = store.monthsIn(state.journal);
    monthInput.value = months[0] || store.monthKey(Date.now());
  }
  if (!$('#histDay').value) $('#histDay').value = store.dayKey(Date.now());

  const sel = historySelection();
  const rows = historyRows();
  const win = store.rangeWindow(sel);
  $('#histCount').textContent = rows.length;

  const months = store.monthsIn(state.journal);
  $('#stats-history').innerHTML = `
    <div class="stat"><b>${rows.length}</b><span>in view</span></div>
    <div class="stat"><b>${months.length}</b><span>months held</span></div>
    <div class="stat"><b>${state.journal.length}</b><span>all time</span></div>`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" style="color:var(--ink-3);padding:30px">
      Nothing in ${escapeHtml(win.label)}${sel.lane === 'all' ? '' : ' for ' + escapeHtml(sel.lane)}.</td></tr>`;
    return;
  }

  const CAP = 1500;
  body.innerHTML = rows.slice(0, CAP).map(r => `
    <tr>
      <td>${when(r.at)}</td>
      <td><span class="lane-tag">${r.lane}</span></td>
      <td>${r.kind}</td><td>${r.symbol || ''}</td>
      <td class="wrap">${escapeHtml(r.pattern || '')}</td>
      <td>${(r.direction || '').toUpperCase()}</td>
      <td>${fmt(r.level)}</td><td>${fmt(r.entry)}</td>
      <td class="wrap">${escapeHtml(r.strength || '')}</td>
    </tr>`).join('') + (rows.length > CAP
      ? `<tr><td colspan="9" style="color:var(--ink-3)">Showing the newest ${CAP} of ${rows.length}. The export contains every row, with the note.</td></tr>`
      : '');
}

/** '20 Oct · 23:44' — the year is in the month picker, so it does not repeat. */
function when(at) {
  const d = new Date(at);
  const day = d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time}`;
}

function renderPulse() {
  const el = $('#pulse');
  const txt = $('#pulseText');
  const s = state.status;
  el.classList.remove('live', 'err');
  if (!s?.lastRun) { txt.textContent = 'never run'; return; }
  if (s.lastError) { el.classList.add('err'); txt.textContent = 'error'; return; }
  el.classList.add('live');
  txt.textContent = 'last ' + new Date(s.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function refreshStatus() {
  state.status = await store.getStatus();
  renderPulse();
}

// ── actions ────────────────────────────────────────────────────────────────
async function runNow() {
  const btn = $('#runNow');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    // Three places this can run: the extension's service worker (localhost),
    // the web app (asks the server), or a test harness.
    const res = await runSweep();
    if (!res?.ok) throw new Error(res?.error || 'run failed');
    await reload();
    renderAll();
    const s = res.summary || {};
    if (s.requested) toast('Run requested — the sweeper picks it up on its next tick.');
    else {
      const unsent = s.unsent ? ` · ${s.unsent} unsent (no channel)` : '';
      toast(`Run complete · ${s.messages || 0} messages · ${s.rows || 0} lab rows${unsent}`);
    }
  } catch (e) {
    toast('Run failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run now';
  }
}

async function runSweep() {
  if (typeof globalThis.__ASX_RUN_NOW__ === 'function') return globalThis.__ASX_RUN_NOW__();
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    return chrome.runtime.sendMessage({ type: 'run-now' });
  }
  throw new Error('no runner in this window');
}

async function saveSettings() {
  const symbols = $('#symbols').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const telegram = {};
  for (const c of CHANNELS) {
    telegram[c.key] = {
      token: $(`#tgToken-${c.key}`).value.trim(),
      chatId: $(`#tgChat-${c.key}`).value.trim()
    };
  }
  const patch = {
    symbols: symbols.length ? symbols : state.settings.symbols,
    telegram,
    lanes: {
      scalp: $('#lane-scalp').checked,
      i1: $('#lane-i1').checked,
      watch: $('#lane-watch').checked,
      lab: $('#lane-lab').checked
    },
    watchFrame: $('#watchFrame').value,
    watchCloseOutBars: Number($('#closeOutBars').value) || 12,
    sendCloseOuts: $('#sendCloseOuts').checked
  };
  state.settings = await store.saveSettings(patch);
  $('#saveNote').textContent = 'Saved.';
  setTimeout(() => ($('#saveNote').textContent = ''), 2200);
  renderAll();
}

function fillSettings() {
  const s = state.settings;
  if (!s) return;
  for (const c of CHANNELS) {
    $(`#tgToken-${c.key}`).value = s.telegram[c.key]?.token || '';
    $(`#tgChat-${c.key}`).value = s.telegram[c.key]?.chatId || '';
  }
  $('#symbols').value = s.symbols.join(', ');
  $('#symbolChips').innerHTML = s.symbols.map(x => `<span class="chip">${x}</span>`).join('');
  $('#lane-scalp').checked = !!s.lanes.scalp;
  $('#lane-i1').checked = !!s.lanes.i1;
  $('#lane-watch').checked = !!s.lanes.watch;
  $('#lane-lab').checked = !!s.lanes.lab;
  $('#watchFrame').value = s.watchFrame;
  $('#closeOutBars').value = s.watchCloseOutBars;
  $('#sendCloseOuts').checked = !!s.sendCloseOuts;
}

async function testTelegram(laneKey) {
  const token = $(`#tgToken-${laneKey}`).value.trim();
  const chatId = $(`#tgChat-${laneKey}`).value.trim();
  const label = CHANNELS.find(c => c.key === laneKey)?.label || laneKey;
  if (!token || !chatId) return toast(`Enter a token and a chat ID for ${label} first.`);

  const text = `ASX Investment Tool — test message for the ${label} lane. ` +
               'If you can read this, the channel works.';

  let res;
  if (typeof globalThis.__ASX_TEST_TELEGRAM__ === 'function') {
    res = await globalThis.__ASX_TEST_TELEGRAM__({ token, chatId, text });
  } else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    res = await chrome.runtime.sendMessage({ type: 'test-telegram', token, chatId, text });
  } else {
    return toast('Nothing to send a message from in this window.');
  }
  toast(res?.ok ? `${label} test sent.` : `Failed: ${res?.error || 'unknown'}`);
}

// ── export ─────────────────────────────────────────────────────────────────
/** Local time with its offset, so the sheet matches the table exactly. */
function localISO(at) {
  const d = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const COLUMNS = [
  ['when_local', r => localISO(r.at)],
  ['timestamp_ms', r => r.at],
  ['lane', r => r.lane],
  ['kind', r => r.kind],
  ['symbol', r => r.symbol || ''],
  ['pattern', r => r.pattern || ''],
  ['direction', r => r.direction || ''],
  ['level', r => (r.level == null ? '' : Number(r.level))],
  ['entry', r => (r.entry == null ? '' : Number(r.entry))],
  ['tag', r => r.strength || ''],
  ['note', r => r.note || '']
];

function exportHistory() {
  const sel = historySelection();
  const { lane } = sel;
  const rows = historyRows();
  const win = store.rangeWindow(sel);
  if (!rows.length) return toast(`Nothing to export for ${win.label}${lane === 'all' ? '' : ' · ' + lane}.`);

  const format = $('#histFormat').value;
  const name = `asx-history-${win.label}${lane === 'all' ? '' : '-' + lane}`;

  if (format === 'json') {
    download(`${name}.json`, JSON.stringify({
      period: sel.range, from: localISO(win.from), to: localISO(win.to),
      lane, count: rows.length, exportedAt: new Date().toISOString(), rows
    }, null, 2), 'application/json');
    return toast(`${rows.length} rows → ${name}.json`);
  }

  // Excel: one sheet of rows, one sheet that summarises them.
  const sheet = [
    COLUMNS.map(([h]) => h),
    ...rows.map(r => COLUMNS.map(([, get]) => get(r)))
  ];

  const byLane = new Map();
  for (const r of rows) {
    const v = byLane.get(r.lane) || { rows: 0, signals: 0, wake: 0, breaks: 0, closeouts: 0 };
    v.rows++;
    if (r.kind === 'SIGNAL') v.signals++;
    else if (r.kind === 'WAKE-UP') v.wake++;
    else if (r.kind === 'BREAK') v.breaks++;
    else if (r.kind === 'CLOSE-OUT') v.closeouts++;
    byLane.set(r.lane, v);
  }
  const summary = [
    ['period', sel.range],
    ['window', `${localISO(win.from)} → ${localISO(win.to)}`],
    ['lane filter', lane],
    ['rows', rows.length],
    ['exported', new Date().toISOString()],
    [],
    ['lane', 'rows', 'signals', 'wake-ups', 'breaks', 'close-outs'],
    ...[...byLane.entries()].map(([k, v]) =>
      [k, v.rows, v.signals, v.wake, v.breaks, v.closeouts])
  ];

  try {
    const bytes = buildXlsx([
      { name: `${win.label} ${lane}`, rows: sheet },
      { name: 'Summary', rows: summary }
    ]);
    download(`${name}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast(`${rows.length} rows → ${name}.xlsx`);
  } catch (e) {
    toast('Excel export failed: ' + e.message);
  }
}

async function clearHistory() {
  if (!confirm('Delete every row in the journal? The export you may want should be taken first.')) return;
  await store.clearJournal();
  state.journal = [];
  renderAll();
  toast('History cleared.');
}

// ── utils ──────────────────────────────────────────────────────────────────
function fmt(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const dec = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 10 ? 2 : 4;
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function download(name, data, mime) {
  try {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    toast('Download blocked in this window — open the extension tab instead.');
  }
}
let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

// The web app polls the sweep job and hands the fresh rows back here.
globalThis.__ASX_REFRESH__ = async (journal, status) => {
  state.journal = journal || await store.getJournal();
  state.status = status || await store.getStatus();
  renderAll();
};

boot();
