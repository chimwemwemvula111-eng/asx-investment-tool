// ============================================================================
// scalp-format — the two output surfaces for a scalp-core signal.
// SPEC v1.0.0. Imports only scalp-core (for nothing but the shape of the object).
//
// One message per signal, never threaded, never edited after sending.
// If a fill condition changes, send formatCancel() instead of editing.
// ============================================================================

/** The Telegram message. Seven fields, in the order agreed. */
export function formatTelegram(s) {
  const dir = s.direction === 'BUY' ? 'BUY' : 'SELL';
  const basis = s.basis === 'held' ? 'price held beyond the level' : 'break failed, closed back inside';
  const g = s.tags?.strength;
  const lines = [
    `◆ ${s.symbol} — ${dir}`,
    `Candle    ${s.candle.label}`,
    `Pattern   ${s.pattern.name.toLowerCase()} · ${s.pattern.role}${s.pattern.tier ? ` (${s.pattern.tier})` : ''}`,
    `Level     ${fmtPrice(s.level)} · ${s.levelKind}`,
    `Entry     ${s.entry.hhmmss}`,
    `Timezone  ${s.entry.line}`,
    `Basis     ${basis}`,
    `Voids at  ${fmtPrice(s.kill)}`,
    `ASX ${s.preset} · scalp · ${s.candle.reading}/${s.candle.trade}`
  ];
  if (g) lines.splice(8, 0, `Strength  ${g.grade} (${g.passes}/${Object.keys(g.checks || {}).length || 4})`);
  return lines.join('\n');
}

/** A CANCEL notice. Never edit a sent signal. */
export function formatCancel(s, reason = 'condition no longer valid') {
  return [
    `◆ CANCEL — ${s.symbol} ${s.direction}`,
    `Was       entry ${s.entry.hhmmss} · level ${fmtPrice(s.level)}`,
    `Reason    ${reason}`,
    `ASX ${s.preset}`
  ].join('\n');
}

/** The in-extension card. Same seven fields, same order, nothing extra. */
export function formatCard(s) {
  const g = s.tags?.strength;
  const badge = s.direction === 'BUY' ? 'buy' : 'sell';
  const row = (k, v, cls = '') =>
    `<div class="xrow"><span class="xk">${k}</span><span class="xv ${cls}">${v}</span></div>`;
  return `
<div class="xcard">
  <div class="xhead">
    <div>
      <div class="sym">${s.symbol}</div>
      <div class="sub">${s.preset} · ${s.candle.reading} → ${s.candle.trade}</div>
    </div>
    <div class="badge ${badge}">${s.direction}</div>
  </div>
  <div class="xbody">
    ${row('Candle', s.candle.label)}
    ${row('Pattern', s.pattern.name)}
    ${row('Mode', s.mode + (g ? ` · ${g.grade}` : ''))}
    ${row('Level', fmtPrice(s.level), 'level')}
    ${row('Entry', s.entry.hhmmss, 'time')}
    ${row('Timezone', s.entry.line, 'time')}
  </div>
  <div class="xfoot">
    <span>${s.basis === 'held' ? 'Held beyond level' : 'Failed — traded against'}</span>
    <span class="pill">ASX ${s.preset}</span>
  </div>
</div>`.trim();
}

/** Journal row — what gets written down, including the fields filled in later. */
export function formatJournalRow(s) {
  return {
    spec: s.spec, preset: s.preset, symbol: s.symbol,
    time: s.entry.iso, direction: s.direction, basis: s.basis, mode: s.mode,
    pattern: s.pattern.id, pattern_tier: s.pattern.tier,
    level: s.level, kill: s.kill,
    grade: s.tags?.strength?.grade ?? null,
    grade_passes: s.tags?.strength?.passes ?? null,
    volume_ratio: s.tags?.volumeRatio ?? null,
    session_hour_utc: s.tags?.sessionHourUtc ?? null,
    overshoot_pct: s.tags?.overshootPct ?? null,
    spread_pct: s.tags?.spreadPct ?? null,
    // filled manually after you exit
    exit_price: null, exit_time: null, mfe: null, mae: null,
    repaint_in_favour: null, notes: null
  };
}

function fmtPrice(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 3 : 6;
  return v.toFixed(dp);
}
