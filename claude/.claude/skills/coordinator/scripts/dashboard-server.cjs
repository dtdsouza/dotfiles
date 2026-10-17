#!/usr/bin/env node
// Usage: dashboard-server.cjs <state-dir> [out-file]   serves the page with actions on 127.0.0.1
//        dashboard-server.cjs --print-url              prints the URL to open (it carries the key)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DEFAULT_PORT, collectItems, render, writePage } = require('./dashboard.cjs');
const actions = require('./dashboard-actions.cjs');

const HOST = '127.0.0.1';
const COOKIE = 'agentctl_dashboard';
const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_ACTIONS = 30;
const COOKIE_MAX_AGE_SECONDS = 400 * 86400;
const FONT_SOURCES = 'https://fonts.gstatic.com https://cdn.fontshare.com https://api.fontshare.com';
const STYLE_SOURCES = 'https://fonts.googleapis.com https://api.fontshare.com';

const keyFile = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'agentctl', 'dashboard.key');

// The key gates the page itself: anything on 127.0.0.1 can be reached by every local user, so
// only someone who can read this 0600 file gets the cookie, the page and its CSRF token.
const loadOrCreateKey = (file = keyFile()) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const stat = fs.statSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${file} must be owned by you and not readable by others (chmod 600 it)`);
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32) throw new Error(`${file} holds no usable key; delete it to get a new one`);
  return key;
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

const readCookie = (header, name) =>
  String(header || '')
    .split(';')
    .map((part) => part.trim().split('='))
    .filter(([k]) => k === name)
    .map(([, ...v]) => v.join('='))[0] || '';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
};

const pageCsp = (nonce) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${STYLE_SOURCES}`,
    `font-src ${FONT_SOURCES}`,
    'img-src data:',
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Agents</title><body style="font:14px sans-serif;background:#000516;color:#fff;padding:40px">
<p>This page needs its key. Open the URL printed by <code>agentctl.sh dashboard --url</code>.</p>`;

// Bytes past the limit are dropped rather than buffered; the request is refused once it ends.
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });

const createRateLimiter = () => {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = [...stamps.filter((t) => now - t < RATE_WINDOW_MS), now];
    return stamps.length <= RATE_MAX_ACTIONS;
  };
};

const ROUTES = {
  '/api/message': (stateDir, body) => actions.sendToCoordinator(body.text),
  '/api/coordinator/focus': () => actions.focusCoordinator(),
  '/api/tabs/close': (stateDir, body) => actions.closeTaskTab(stateDir, body.id),
  '/api/tabs/close-done': (stateDir) => actions.closeAllDoneTabs(stateDir),
};

// The order matters: every check that needs no secret runs first, so a cross-site or rebinding
// request is turned away before it can probe the cookie or the CSRF token.
const refuseAction = (req, { origins, key, csrf }) => {
  if (!origins.has(req.headers.origin || '')) return [403, 'Cross-origin request refused.'];
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return [403, 'Cross-site request refused.'];
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) return [415, 'JSON only.'];
  if (!safeEqual(readCookie(req.headers.cookie, COOKIE), key)) return [401, 'Missing or wrong key cookie.'];
  if (!safeEqual(req.headers['x-dashboard-token'], csrf)) return [403, 'Missing or wrong dashboard token.'];
  return null;
};

const handleAction = async (req, res, context) => {
  const route = ROUTES[context.url.pathname];
  if (!route) return send(res, 404, { ok: false, error: 'Unknown action.' });
  const refusal = refuseAction(req, context);
  if (refusal) return send(res, refusal[0], { ok: false, error: refusal[1], reload: refusal[0] === 403 && /token/.test(refusal[1]) });
  if (!context.allowAction()) return send(res, 429, { ok: false, error: 'Too many actions; wait a minute.' });
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return send(res, err.status || 400, { ok: false, error: err.status === 413 ? 'Message too large.' : 'Invalid JSON.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { ok: false, error: 'Invalid JSON.' });
  try {
    const message = await route(context.stateDir, body);
    console.error(`[dashboard] ${context.url.pathname} ok`);
    return send(res, 200, { ok: true, message });
  } catch (err) {
    if (err instanceof actions.ActionError) return send(res, 409, { ok: false, error: err.message });
    console.error(`[dashboard] ${context.url.pathname} failed:`, err.message);
    return send(res, 500, { ok: false, error: 'The action failed; see the dashboard tab for details.' });
  }
};

const handlePage = (req, res, context) => {
  if (context.url.pathname !== '/') return send(res, 404, 'Not found');
  if (context.url.searchParams.has('key')) {
    if (!safeEqual(context.url.searchParams.get('key'), context.key)) return send(res, 401, LOCKED_PAGE);
    const cookie = `${COOKIE}=${context.key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
    return send(res, 303, '', { Location: '/', 'Set-Cookie': cookie });
  }
  if (!safeEqual(readCookie(req.headers.cookie, COOKIE), context.key)) return send(res, 401, LOCKED_PAGE);
  const nonce = crypto.randomBytes(16).toString('base64');
  const closable = actions.closableTaskIds(context.stateDir);
  const html = render(collectItems(context.stateDir), { served: { csrf: context.csrf, nonce, closable } });
  return send(res, 200, html, { 'Content-Security-Policy': pageCsp(nonce) });
};

const createDashboardServer = ({ stateDir, key }) => {
  const csrf = crypto.randomBytes(32).toString('base64url');
  const allowAction = createRateLimiter();
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
    // DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
    if (!hosts.has(req.headers.host || '')) return send(res, 403, { ok: false, error: 'Unexpected Host header.' });
    const context = {
      stateDir,
      key,
      csrf,
      allowAction,
      origins: new Set([...hosts].map((h) => `http://${h}`)),
      url: new URL(req.url, `http://${HOST}:${port}`),
    };
    const handler = req.method === 'GET' ? handlePage : req.method === 'POST' ? handleAction : null;
    if (!handler) return send(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    Promise.resolve(handler(req, res, context)).catch((err) => {
      console.error('[dashboard] request failed:', err.message);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'Internal error.' });
    });
  });
  return server;
};

const portFromEnv = () => Number(process.env.COORDINATOR_DASHBOARD_PORT || DEFAULT_PORT);
const urlWithKey = (key, port = portFromEnv()) => `http://${HOST}:${port}/?key=${key}`;

const main = () => {
  if (process.argv[2] === '--print-url') {
    console.log(urlWithKey(loadOrCreateKey()));
    return;
  }
  const [stateDir, outArg] = process.argv.slice(2);
  if (!stateDir) {
    console.error('usage: dashboard-server.cjs <state-dir> [out-file] | --print-url');
    process.exit(1);
  }
  const out = outArg || path.join(stateDir, 'status.html');
  const refreshSeconds = Number(process.env.DASHBOARD_REFRESH_SECONDS || 300);
  const key = loadOrCreateKey();
  const server = createDashboardServer({ stateDir, key });
  const regenerate = () => {
    try {
      writePage(stateDir, out);
    } catch (err) {
      console.error('[dashboard] regenerating the file failed:', err.message);
    }
  };
  server.on('error', (err) => {
    console.error(`[dashboard] cannot listen on ${HOST}:${portFromEnv()}: ${err.message}`);
    process.exit(1);
  });
  server.listen(portFromEnv(), HOST, () => {
    regenerate();
    setInterval(regenerate, refreshSeconds * 1000);
    console.log(`[dashboard] serving on http://${HOST}:${portFromEnv()}/ (open the keyed URL from \`agentctl.sh dashboard --url\`)`);
    console.log(`[dashboard] also regenerating file://${out} every ${refreshSeconds}s; ctrl-c to stop`);
  });
};

module.exports = { COOKIE, MAX_BODY_BYTES, createDashboardServer, loadOrCreateKey, urlWithKey };

if (require.main === module) main();
