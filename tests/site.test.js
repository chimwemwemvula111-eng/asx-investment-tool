// Run: node tests/site.test.js
//
// The web app's index.html is generated from the extension's. This test fails
// the moment the two drift apart, which is the only way duplicated markup stays
// honest without a bundler.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(root + p, 'utf8');

console.log('\n1 · site/index.html is generated, and up to date');
{
  const before = read('site/index.html');
  const run = spawnSync('node', ['tools/build-site.mjs'], { cwd: root, encoding: 'utf8' });
  ok('the generator runs', run.status === 0, run.stderr);
  const after = read('site/index.html');
  ok('the committed file matches the generator', before === after,
    'run `npm run site` and commit the result');
}

console.log('\n2 · Same bones as the extension');
{
  const ext = read('src/app/index.html');
  const site = read('site/index.html');

  const views = ['scalp', 'intraday', 'watch', 'lab', 'history', 'settings'];
  ok('every view exists in the site', views.every(v => site.includes(`id="view-${v}"`)));
  ok('the rail is identical', ['Scalp', 'Intraday', 'Watch', 'Lab', 'History', 'Settings']
    .every(v => site.includes(`<span>${v}</span>`) && ext.includes(`<span>${v}</span>`)));
  ok('the site loads the shared stylesheet', site.includes('../src/app/app.css'));
  ok('the site loads its own bootstrap, not the extension one', site.includes('src="site.js"'));
  ok('the extension still loads its own', ext.includes('src="app.js"'));
  ok('the site does not ship the extension manifest', !site.includes('chrome-extension://'));
}

console.log('\n3 · The sign-in gate');
{
  const site = read('site/index.html');
  ok('there is a gate', site.includes('id="gate"'));
  ok('email and password fields', site.includes('id="gateEmail"') && site.includes('id="gatePassword"'));
  ok('a sign-out control', site.includes('id="siteOut"'));
  ok('the gate starts visible', !/class="gate[^"]*gone/.test(site));
}

console.log('\n4 · Config holds a public URL and a public key — or placeholders');
{
  const cfg = read('site/config.js');
  const placeholder = cfg.includes('YOUR-PROJECT') && cfg.includes('YOUR-ANON-KEY');
  const url = cfg.match(/supabaseUrl:\s*'([^']+)'/)?.[1] || '';
  const key = cfg.match(/supabaseAnonKey:\s*'([^']+)'/)?.[1] || '';

  ok('it is either a placeholder or a real configuration', placeholder || (url && key));
  if (!placeholder) {
    /* a configured copy must look like a project URL and a publishable or anon
       key, and must not have kept the /rest/v1/ path the dashboard shows —
       the client appends that itself */
    ok('the URL is a bare project URL', /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url), url);
    ok('the key is a publishable key or an anon JWT',
      /^sb_publishable_/.test(key) || /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(key));
  }
  /* this one is never negotiable, configured or not */
  ok('the service key is NOT in the site', !/service_role|SERVICE_KEY|sb_secret_/.test(cfg));
}

console.log('\n5 · Nothing secret in the client bundle');
{
  const files = ['site/site.js', 'site/config.js', 'src/data/supabase.js', 'src/store/supabase-backend.js'];
  const leaks = files.filter(f => /service_role|SUPABASE_SERVICE_KEY/.test(read(f)));
  ok('no service key anywhere in the browser code', leaks.length === 0, leaks.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
