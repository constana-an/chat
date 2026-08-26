/**
 * Server bootstrap: static files + JSON API, no dependencies.
 *
 *   npm start            # http://localhost:3000
 *   PORT=4000 npm start
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './store.js';
import { createHub } from './hub.js';
import { createRouter } from './routes.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024;

export function createApp({ dataFile = null, seedDemo = true } = {}) {
  const store = createStore({ dataFile, seedDemo });
  const hub = createHub();
  const router = createRouter({ store, hub });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi({ req, res, url, store, router });
      } else {
        serveStatic(url.pathname, res);
      }
    } catch (err) {
      sendError(res, err);
    }
  });

  return { server, store, hub };
}

async function handleApi({ req, res, url, store, router }) {
  const route = router.match(req.method, url.pathname);
  if (!route) {
    return sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  }

  const token = bearerToken(req);
  const user = token ? store.userForToken(token) : null;
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req);

  const result = await route.handler({ req, res, url, body, user, token, params: route.params });
  // SSE handlers write the response themselves and return undefined.
  if (result !== undefined) sendJson(res, 200, result);
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413, expose: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Body is not valid JSON.'), { status: 400, expose: true }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  // Never serve outside public/.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[api]', err);
  sendJson(res, status, { error: err.expose ? err.message : 'Internal server error' });
}

// Only start listening when run directly, so tests can import createApp().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const dataFile = process.env.CHAT_DATA_FILE ?? path.join(ROOT, 'data', 'db.json');
  const { server, store } = createApp({ dataFile });
  server.listen(port, () => {
    console.log(`team-chat listening on http://localhost:${port}`);
    console.log(`persisting to ${dataFile} (mode 0600 — it holds password hashes)`);
    console.log('Tip: open a second tab (or window) to sign in as another user — sessions are per-tab.');

    const unclaimed = store.unclaimedAccounts();
    if (unclaimed.length) {
      console.warn(
        `\n!  ${unclaimed.length} account(s) predate passwords: ${unclaimed.join(', ')}\n` +
        '   Whoever signs in as one of these first will set its password and own it.\n' +
        '   If they are test accounts, delete the data file before sharing this server.\n'
      );
    }
    console.log('\nThis server has no TLS. Reach it over Tailscale or another private');
    console.log('network — do not expose it directly to the internet.\n');
  });
}
