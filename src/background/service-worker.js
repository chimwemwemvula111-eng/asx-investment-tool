// ============================================================================
// service worker — thin. Opens the app, holds the alarm, calls the runner.
// No lane logic lives here.
// ============================================================================

import { runOnce } from '../runner/runner.js';

const RUN_ALARM = 'asx-run';
const RUN_EVERY_MINUTES = 5;
const APP_PAGE = 'src/app/index.html';

// --- open the app in a tab -------------------------------------------------
// No "tabs" permission: we remember the tab we opened and reuse it. If that
// id is gone, we simply open a new one.
const KEY_TAB = 'lastTabId';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(APP_PAGE);
  const { [KEY_TAB]: id } = await chrome.storage.local.get(KEY_TAB);
  if (id != null) {
    try {
      const tab = await chrome.tabs.update(id, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch { /* the tab was closed — fall through */ }
  }
  const tab = await chrome.tabs.create({ url });
  if (tab?.id != null) await chrome.storage.local.set({ [KEY_TAB]: tab.id });
});

// --- the alarm -------------------------------------------------------------
chrome.alarms.create(RUN_ALARM, { periodInMinutes: RUN_EVERY_MINUTES });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== RUN_ALARM) return;
  sweep('alarm').catch(e => console.error('[asx] sweep failed', e));
});

chrome.runtime.onInstalled.addListener(() => sweep('installed').catch(() => {}));
chrome.runtime.onStartup.addListener(() => sweep('startup').catch(() => {}));

// --- messages from the app -------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'run-now') {
    sweep('manual').then(r => reply({ ok: true, summary: r })).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'test-telegram') {
    import('../data/telegram.js')
      .then(m => m.sendTelegram({ token: msg.token, chatId: msg.chatId, text: msg.text }))
      .then(r => reply(r))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function sweep(reason) {
  const summary = await runOnce({ now: Date.now() });
  summary.reason = reason;
  if (summary.errors?.length) console.warn('[asx] errors', summary.errors);
  return summary;
}
