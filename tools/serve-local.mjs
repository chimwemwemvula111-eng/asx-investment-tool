#!/usr/bin/env node
/* ============================================================================
   serve-local.mjs — look at the real web app on this machine, before hosting.

     npm run serve        →   http://localhost:8123

   It serves the repository root, because site/index.html reaches back into
   ../src for the app modules and ../assets for the mark. It also answers / for
   /site/index.html so you do not have to type the path.

   This is a development server. It has no cache, no compression and no
   security hardening, and it must not be used to host anything.
   ========================================================================== */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    /* redirect rather than serve, so the page's relative ../src paths resolve
       from /site/ the way they do on a real host */
    if (path === '/' || path === '') {
      res.writeHead(302, { location: '/site/index.html' }).end();
      return;
    }

    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('outside the repository');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('that is a directory');
      return;
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, HOST, () => {
  console.log(`ASX web app  →  http://localhost:${PORT}`);
});
