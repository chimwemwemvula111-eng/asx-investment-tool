#!/usr/bin/env node
/* ============================================================================
   build-preview.mjs — one self-contained HTML file you can open anywhere.

     node tools/build-preview.mjs   →   preview.html

   The real UI is a page plus three modules that load each other by import,
   and a store that talks to chrome.storage. None of that works when you
   double-click a file on a desktop. So this script flattens them:

     · store.js, xlsx.js and app.js are pasted into one <script type="module">,
       with the import statements removed and the exports gathered into two
       small objects that stand in for the namespaces
     · chrome.storage is left undefined, so the store falls back to the
       in-memory adapter it already ships for the tests
     · that empty memory is then filled with a believable day: five scalp
       prints, an I1 arm-and-confirm, two watch signals, six lab rows

   The result is a look at the interface, not the live tool. It never calls
   Binance, never calls Telegram, and never sends anything.
   ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const fail = (msg) => {
  throw new Error(`${msg}\n  → tools/build-preview.mjs needs updating to match the source`);
};

/* ── 1. a helper that turns a module into a plain block plus its names ───── */

function flatten(path) {
  const original = read(path);
  const names = new Set();
  for (const m of original.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(m[1]);
  }
  /* `export { a, b }` style, in case any module ever switches to it */
  for (const m of original.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  if (!names.size) fail(`${path} has no exports — has it changed shape?`);

  const body = original.replace(/^export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\s)/gm, '');
  if (/^export\s/m.test(body)) fail(`${path} still has an export statement`);
  if (/^import\s/m.test(body)) fail(`${path} has an import statement — inline it first`);

  return { names: [...names], body };
}

/* ── 2. flatten the store ────────────────────────────────────────────────── */

const storeModules = ['src/store/store.js'];
const storeParts = storeModules.map(flatten);
const storeNames = storeParts.flatMap((p) => p.names);

/* ── 3. flatten the app, inlining its imports ────────────────────────────── */

const appPath = 'src/app/app.js';
const appOriginal = read(appPath);
const appImports = [...appOriginal.matchAll(/^import\s+(.+?)\s+from\s+'(.+?)';?$/gm)];

const helperParts = [];
for (const [, clause, spec] of appImports) {
  if (/^\*\s+as\s+/.test(clause)) continue; // namespaces are rebuilt below
  if (!/^\{/.test(clause.trim())) fail(`app.js has an unsupported import: ${clause}`);
  const target = join('src/app', spec);
  const flat = flatten(`src/app/${spec.replace(/^\.\//, '')}`);
  /* a rename would need a shim here; none exists today, so refuse loudly */
  if (/\sas\s/.test(clause)) fail(`app.js renames an import (${clause}) — preview needs a shim`);
  helperParts.push({ spec, ...flat });
}

const appBody = appOriginal
  .replace(/^import\s+.*$/gm, '')
  .replace(/^\n+/, '');
if (/^import\s/m.test(appBody)) fail('app.js still has an import statement');

/* ── 4. the demo day ─────────────────────────────────────────────────────── */

const MIN = 60_000;
const now = Date.now();

/* A lane only ever shows today, so the demo day has to fit inside today —
   otherwise opening this at 00:14 would leave four of the five scalp rows
   filed under yesterday. The window squeezes to whatever today has left. */
const dayStart = new Date(now);
dayStart.setHours(0, 0, 0, 0);
const room = Math.max(now - dayStart.getTime() - 2 * MIN, 0);
const OLDEST = 92; // minutes — the age of the oldest row
const at = (minutesAgo) => {
  const share = Math.min(minutesAgo, OLDEST) / OLDEST;
  return new Date(now - share * Math.min(OLDEST * MIN, room)).toISOString();
};

const demoJournal = [
  /* ── scalp: what a fast tape actually prints */
  { at: at(9), lane: 'scalp', kind: 'SIGNAL', symbol: 'BTCUSDT', direction: 'long',
    level: 67842.5, entry: 67861, strength: 'A', pattern: 'break and retest',
    note: 'closed at 0.71 of the range · body 0.62 · first touch of the level' },
  { at: at(24), lane: 'scalp', kind: 'SIGNAL', symbol: 'SOLUSDT', direction: 'short',
    level: 172.84, entry: 172.66, strength: 'B', pattern: 'range break',
    note: 'closed at 0.66 of the range · body 0.55 · second attempt at it' },
  { at: at(41), lane: 'scalp', kind: 'SIGNAL', symbol: 'ETHUSDT', direction: 'long',
    level: 3312.4, entry: 3314.1, strength: 'A', pattern: 'break and retest',
    note: 'closed at 0.83 of the range · body 0.70 · level was untouched for 40 bars' },
  { at: at(63), lane: 'scalp', kind: 'SIGNAL', symbol: 'BTCUSDT', direction: 'short',
    level: 67905, entry: 67898.5, strength: 'C', pattern: 'range break',
    note: 'closed at 0.65 of the range · body 0.51 · thin body, tagged C not dropped' },
  { at: at(88), lane: 'scalp', kind: 'SIGNAL', symbol: 'SOLUSDT', direction: 'long',
    level: 171.92, entry: 172.05, strength: 'B', pattern: 'break and retest',
    note: 'closed at 0.74 of the range · body 0.58 · held the retest' },

  /* ── I1: the arm is not a signal. the confirmation is. */
  { at: at(17), lane: 'i1', kind: 'ARMED', symbol: 'ETHUSDT', direction: 'long',
    level: 3308, entry: null, strength: '–', pattern: '1h range, 15m inside it',
    note: 'price came within 0.27 of the 1h edge — armed, nothing sent' },
  { at: at(14), lane: 'i1', kind: 'SIGNAL', symbol: 'ETHUSDT', direction: 'long',
    level: 3308, entry: 3310.4, strength: 'A', pattern: '1h range, 15m inside it',
    note: 'confirmed on the 15m close · closed at 0.78 of the range · body 0.64' },

  /* ── watch: swing structure, slow by design */
  { at: at(52), lane: 'watch', kind: 'SIGNAL', symbol: 'BTCUSDT', direction: 'long',
    level: 67510, entry: 67532, strength: 'A', pattern: 'Wyckoff spring',
    note: 'spring 9 bars back · range is 0.09 of price wide · swept 67488 and closed back inside' },
  { at: at(131), lane: 'watch', kind: 'SIGNAL', symbol: 'SOLUSDT', direction: 'short',
    level: 174.6, entry: 174.44, strength: 'B', pattern: 'head and shoulders',
    note: 'neckline 174.60 · shoulders 15 bars apart · promising enough 0.0051 of price' },

  /* ── lab: silent by definition. one idea, nine readings, all scored. */
  { at: at(6), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'A_strict_single', pattern: 'break and retest',
    note: 'tp · artificial ruler 1× the measured move · bar 2' },
  { at: at(9), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'B_two_closes', pattern: 'break and retest',
    note: 'tp · artificial ruler 1× the measured move · bar 3' },
  { at: at(12), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'C_two_closes_bodies', pattern: 'break and retest',
    note: 'tp · artificial ruler 1× the measured move · bar 4' },
  { at: at(15), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'D_two_of_three', pattern: 'break and retest',
    note: 'opposite · artificial ruler 1× the measured move · bar 5' },
  { at: at(18), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'E_hold_after', pattern: 'break and retest',
    note: 'tp · artificial ruler 1× the measured move · bar 6' },
  { at: at(21), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'F_softer_single', pattern: 'break and retest',
    note: 'both · artificial ruler 1× the measured move · bar 7' },
  { at: at(24), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'G_displacement', pattern: 'break and retest',
    note: 'tp · artificial ruler 1× the measured move · bar 8' },
  { at: at(27), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'H_two_candle_displacement', pattern: 'break and retest',
    note: 'open · artificial ruler 1× the measured move · bar 9' },
  { at: at(30), lane: 'lab', kind: 'ROW', symbol: 'BTCUSDT', direction: 'long',
    level: 67788, entry: 67788, strength: 'I_body_plus_displacement', pattern: 'break and retest',
    note: 'opposite · artificial ruler 1× the measured move · bar 10' },
];

const demoSent = demoJournal
  .filter((r) => r.kind === 'SIGNAL')
  .map((r) => ({ key: `${r.symbol}|${r.direction}|${r.level}`, at: r.at }));

const demoStatus = {
  lastRun: new Date(now - 4 * MIN).toISOString(),
  lastOk: new Date(now - 4 * MIN).toISOString(),
  lastError: null,
  source: 'sweep',
  lanes: {
    scalp: { scanned: 3, fired: 5, silent: 0 },
    i1: { scanned: 3, fired: 1, silent: 2 },
    watch: { scanned: 3, fired: 2, silent: 1 },
    lab: { scanned: 3, fired: 0, silent: 3 },
  },
};

/* ── 5. assemble ─────────────────────────────────────────────────────────── */

const js = `
/* flatten by tools/build-preview.mjs — store, helpers, demo seed, app */

/* each module keeps its own scope, so a name in the store can never collide
   with the same name in the app — which is exactly what happens to
   saveSettings in both files */
const store = (() => {
${storeParts.map((p) => p.body).join('\n')}
  return {
${storeNames.map((n) => `    ${n},`).join('\n')}
  };
})();

const { ${helperParts.flatMap((p) => p.names).join(', ')} } = (() => {
${helperParts.map((p) => p.body).join('\n')}
  return { ${helperParts.flatMap((p) => p.names).join(', ')} };
})();

/* ── demo seed ────────────────────────────────────────────────────────────
   Everything below this line exists only in this preview file. The shipped
   app reads its rows from Supabase, never from an array. */

const DEMO_JOURNAL = ${JSON.stringify(demoJournal, null, 2)};
const DEMO_SENT = ${JSON.stringify(demoSent, null, 2)};
const DEMO_STATUS = ${JSON.stringify(demoStatus, null, 2)};

/* the run-now button talks to the service worker; here it just answers,
   so the button can be pressed without throwing */
globalThis.chrome = {
  runtime: {
    sendMessage: async () => ({
      ok: true,
      summary: { messages: 2, rows: 16, errors: [], sent: [], unsent: [] },
    }),
  },
};

for (const row of DEMO_JOURNAL) await store.appendJournal([row]);
await store.saveStatus(DEMO_STATUS);
await store.claim(DEMO_SENT.map((r) => r.key));

/* a banner, so a screenshot of this is never mistaken for a live account */
{
  const bar = document.createElement('div');
  bar.textContent = 'PREVIEW · sample data · nothing here is live';
  bar.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:9999',
    'padding:8px 14px', 'text-align:center', 'letter-spacing:.14em',
    'font:600 10px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'color:#93b4f5', 'background:rgba(7,10,18,.95)',
    'border-top:1px solid #1d2942', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(bar);
  /* keep the banner from sitting on top of the last row */
  document.body.style.paddingBottom = '34px';
}

${appBody}
`;

const page = read('src/app/index.html');
const css = read('src/app/app.css');
const styleTag = `<style>\n${css}\n</style>`;
const scriptTag = `<script type="module">\n${js}\n</script>`;

let html = page
  .replace(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi, () => styleTag)
  .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, () => scriptTag);

if (!html.includes(styleTag.slice(0, 40))) fail('could not find the stylesheet link to replace');
if (!html.includes(scriptTag.slice(0, 40))) fail('could not find the script tag to replace');
if (html === page) fail('nothing was replaced — check the source page');

/* the page points at ../assets for its icon; carry those in as data URIs so
   the file is genuinely standalone */
html = html.replace(/((?:src|href)\s*=\s*["'])([^"']*assets\/[^"']+\.png)(["'])/gi, (m, pre, rel, post) => {
  const file = join('src/app', rel);
  const ext = rel.split('.').pop();
  return `${pre}data:image/${ext};base64,${readFileSync(join(root, file)).toString('base64')}${post}`;
});

/* a preview must work with no network, so nothing may point outward */
const external = [...html.matchAll(/(?:src|href)\s*=\s*["'](?!#|data:)([^"']+)["']/gi)];
if (external.length) fail(`external references left in preview.html: ${external.map((m) => m[1])}`);

writeFileSync(join(root, 'preview.html'), html);
console.log(
  `preview.html  ${(html.length / 1024).toFixed(0)} KB  ·  ` +
  `${storeNames.length} store names  ·  ${helperParts.length} helper modules  ·  ` +
  `${demoJournal.length} demo rows`,
);
