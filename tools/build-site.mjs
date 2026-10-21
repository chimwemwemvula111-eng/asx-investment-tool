// Builds site/index.html from src/app/index.html.
//
// The extension and the web app are the same interface — same markup, same CSS,
// same app.js. This script is the only place they differ: it swaps the stylesheet
// for a relative path, swaps the bootstrap for the login gate, and adds the
// sign-in overlay. Run it after any change to the app markup:
//
//   node tools/build-site.mjs
//
// The output is committed, so GitHub Pages / Netlify / Cloudflare Pages can
// serve the folder with no build step at all. tests/site.test.js fails if the
// committed file drifts from this generator.

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(root + p, 'utf8');

const LOGIN = `
  <!-- ── sign-in gate (the web app only) ─────────────────────────────── -->
  <div class="gate" id="gate">
    <form class="gate-card" id="gateForm" autocomplete="on">
      <div class="gate-brand">
        <img src="../src/assets/icon48.png" alt="ASX" width="44" height="44">
        <div><b>ASX</b><span>investment tool</span></div>
      </div>

      <h2 id="gateTitle">Sign in</h2>
      <p class="gate-sub" id="gateSub">Same lanes, same channels, from any device.</p>

      <label class="gate-field"><span>Email</span>
        <input id="gateEmail" type="email" autocomplete="username" placeholder="you@example.com" required>
      </label>
      <label class="gate-field"><span>Password</span>
        <input id="gatePassword" type="password" autocomplete="current-password" placeholder="••••••••" required>
      </label>

      <div class="gate-error" id="gateError"></div>
      <button class="gate-go" id="gateGo" type="submit">Sign in</button>
      <p class="gate-note" id="gateNote">Your rows, your channels. Nobody else can read them.</p>
    </form>
  </div>

  <!-- ── whose session this is ──────────────────────────────────────── -->
  <div class="site-bar hidden" id="siteBar">
    <span id="siteWho"></span>
    <button id="siteOut" type="button">Sign out</button>
  </div>`;

const page = read('src/app/index.html')
  // the extension loads app.css from its own folder; the site from src/
  .replace('<link rel="stylesheet" href="app.css">',
           '<link rel="stylesheet" href="../src/app/app.css">\n<link rel="stylesheet" href="site.css">')
  // the extension loads app.js directly; the site boots it after a login
  .replace('<script type="module" src="app.js"></script>',
           '<script type="module" src="site.js"></script>')
  // the app lives in src/app/ for the extension and in site/ for the web —
  // every asset path has to move with it
  .replaceAll('../assets/', '../src/assets/')
  .replace('</head>', '  <link rel="icon" href="../src/assets/icon48.png">\n</head>')
  .replace('</body>', () => `${LOGIN}\n</body>`);

writeFileSync(root + 'site/index.html', page);
console.log(`site/index.html written · ${(page.length / 1024).toFixed(1)} KB`);

export { page };
