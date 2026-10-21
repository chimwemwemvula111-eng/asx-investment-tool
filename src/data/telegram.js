// ============================================================================
// telegram — one function, one job.
// ============================================================================

export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  if (!token || !chatId) return { ok: false, skipped: 'not configured' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Order flow and activity as a single trailing line. Tags only. */
export function tagLine({ takerRatio, trades, funding, openInterest } = {}) {
  const parts = [];
  if (typeof takerRatio === 'number') parts.push(`taker ${(takerRatio * 100).toFixed(0)}%`);
  if (typeof trades === 'number') parts.push(`${trades} trades`);
  if (typeof funding === 'number') parts.push(`funding ${(funding * 100).toFixed(3)}%`);
  if (typeof openInterest === 'number') parts.push(`OI ${Math.round(openInterest)}`);
  return parts.length ? parts.join(' · ') : null;
}
