#!/usr/bin/env node
// Usage: dashboard-server.cjs <state-dir> [out-file]   serves the page with actions on 127.0.0.1
//        dashboard-server.cjs --print-url [--tailnet]  prints the URL to open (it carries the key)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DEFAULT_PORT, collectItems, render, writePage } = require('./dashboard.cjs');
const actions = require('./dashboard-actions.cjs');
const { classifyRequest, loadTailnetConfig } = require('./dashboard-tailnet.cjs');

const HOST = '127.0.0.1';
const COOKIE = 'agentctl_dashboard';
const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_ACTIONS = 30;
// An open peek panel polls every few seconds, so reads get their own, looser budget.
const RATE_MAX_PEEKS = 240;
const COOKIE_MAX_AGE_SECONDS = 400 * 86400;
const FONT_SOURCES = 'https://fonts.gstatic.com https://cdn.fontshare.com https://api.fontshare.com';
const STYLE_SOURCES = 'https://fonts.googleapis.com https://api.fontshare.com';

const privateStateDir = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'agentctl');
const keyFile = () => path.join(privateStateDir(), 'dashboard.key');
const defaultAuditFile = () => path.join(privateStateDir(), 'dashboard-audit.jsonl');

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

const createRateLimiter = (max) => {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = [...stamps.filter((t) => now - t < RATE_WINDOW_MS), now];
    return stamps.length <= max;
  };
};

const appendAudit = (file, entry) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
};

const ROUTES = {
  '/api/message': (context, body) => actions.sendToCoordinator(body.text),
  '/api/reply': (context, body) => actions.replyToTask(context.stateDir, body.id, body.text),
  '/api/coordinator/focus': () => actions.focusCoordinator(),
  '/api/tabs/close': (context, body) => actions.closeTaskTab(context.stateDir, body.id),
  '/api/tabs/close-done': (context) => actions.closeAllDoneTabs(context.stateDir),
};

// Typed text reaches a terminal, so whatever an action reports as typed is kept in a private log.
const auditTyped = (context, result) => {
  if (!result || typeof result !== 'object' || !result.task) return;
  try {
    appendAudit(context.auditFile, { at: new Date().toISOString(), task: result.task, source: context.source, text: result.text });
  } catch (err) {
    console.error('[dashboard] writing the audit log failed:', err.message);
  }
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
    const result = await route(context, body);
    auditTyped(context, result);
    console.error(`[dashboard] ${context.url.pathname} ok (${context.source})`);
    return send(res, 200, { ok: true, message: typeof result === 'string' ? result : result.message });
  } catch (err) {
    if (err instanceof actions.ActionError) return send(res, 409, { ok: false, error: err.message });
    console.error(`[dashboard] ${context.url.pathname} failed:`, err.message);
    return send(res, 500, { ok: false, error: 'The action failed; see the dashboard tab for details.' });
  }
};

// Browsers send no Origin on a same-origin GET, so a read leans on Sec-Fetch-Site and the custom
// token header (which no cross-site page can set without a preflight this server never answers).
const refuseRead = (req, { key, csrf }) => {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return [403, 'Cross-site request refused.'];
  if (!safeEqual(readCookie(req.headers.cookie, COOKIE), key)) return [401, 'Missing or wrong key cookie.'];
  if (!safeEqual(req.headers['x-dashboard-token'], csrf)) return [403, 'Missing or wrong dashboard token.'];
  return null;
};

const handlePeek = async (req, res, context, readPane) => {
  const refusal = refuseRead(req, context);
  if (refusal) return send(res, refusal[0], { ok: false, error: refusal[1], reload: refusal[0] === 403 && /token/.test(refusal[1]) });
  if (!context.allowPeek()) return send(res, 429, { ok: false, error: 'Too many refreshes; wait a minute.' });
  try {
    const { lines, command } = await readPane();
    return send(res, 200, { ok: true, lines, command, at: new Date().toISOString() });
  } catch (err) {
    if (err instanceof actions.ActionError) return send(res, 409, { ok: false, error: err.message });
    throw err;
  }
};

const keyCookie = (key, secure) => `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`;

const handlePage = (req, res, context) => {
  if (context.url.pathname === '/api/peek') {
    return handlePeek(req, res, context, () => actions.peekTask(context.stateDir, context.url.searchParams.get('id')));
  }
  if (context.url.pathname === '/api/coordinator/peek') return handlePeek(req, res, context, actions.peekCoordinator);
  if (context.url.pathname !== '/') return send(res, 404, 'Not found');
  if (context.url.searchParams.has('key')) {
    if (!safeEqual(context.url.searchParams.get('key'), context.key)) return send(res, 401, LOCKED_PAGE);
    return send(res, 303, '', { Location: '/', 'Set-Cookie': keyCookie(context.key, context.secure) });
  }
  if (!safeEqual(readCookie(req.headers.cookie, COOKIE), context.key)) return send(res, 401, LOCKED_PAGE);
  const nonce = crypto.randomBytes(16).toString('base64');
  const panes = actions.listPanes();
  const served = {
    csrf: context.csrf,
    nonce,
    closable: actions.closableTaskIds(context.stateDir, panes),
    replyable: actions.replyableTaskIds(context.stateDir, panes),
    remote: context.via === 'tailnet',
  };
  const html = render(collectItems(context.stateDir), { served });
  return send(res, 200, html, { 'Content-Security-Policy': pageCsp(nonce) });
};

// tailnet = { host, logins } admits requests proxied by `tailscale serve`; null keeps it local-only.
const createDashboardServer = ({ stateDir, key, tailnet = null, auditFile = defaultAuditFile() }) => {
  const csrf = crypto.randomBytes(32).toString('base64url');
  const allowAction = createRateLimiter(RATE_MAX_ACTIONS);
  const allowPeek = createRateLimiter(RATE_MAX_PEEKS);
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const arrival = classifyRequest(req.headers, { port, tailnet });
    if (arrival.refusal) return send(res, arrival.refusal[0], { ok: false, error: arrival.refusal[1] });
    const context = {
      ...arrival,
      stateDir,
      key,
      csrf,
      allowAction,
      allowPeek,
      auditFile,
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

const printUrl = (flag) => {
  if (flag !== '--tailnet') return console.log(urlWithKey(loadOrCreateKey()));
  const tailnet = loadTailnetConfig();
  if (!tailnet) {
    console.error('[dashboard] no tailnet name: Tailscale is not running, or COORDINATOR_DASHBOARD_TAILNET is off');
    process.exit(1);
  }
  return console.log(`https://${tailnet.host}/?key=${loadOrCreateKey()}`);
};

const main = () => {
  if (process.argv[2] === '--print-url') return printUrl(process.argv[3]);
  const [stateDir, outArg] = process.argv.slice(2);
  if (!stateDir) {
    console.error('usage: dashboard-server.cjs <state-dir> [out-file] | --print-url');
    process.exit(1);
  }
  const out = outArg || path.join(stateDir, 'status.html');
  const refreshSeconds = Number(process.env.DASHBOARD_REFRESH_SECONDS || 300);
  const key = loadOrCreateKey();
  const tailnet = loadTailnetConfig();
  const server = createDashboardServer({ stateDir, key, tailnet });
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
    console.log(
      tailnet
        ? `[dashboard] also accepting https://${tailnet.host}/ through \`tailscale serve\` for ${tailnet.logins.join(', ')}`
        : '[dashboard] tailnet access off (no Tailscale name found, or COORDINATOR_DASHBOARD_TAILNET=off)',
    );
    console.log(`[dashboard] also regenerating file://${out} every ${refreshSeconds}s; ctrl-c to stop`);
  });
};

module.exports = { COOKIE, MAX_BODY_BYTES, createDashboardServer, loadOrCreateKey, urlWithKey };

if (require.main === module) main();
