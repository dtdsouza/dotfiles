// Tailnet access, peek and reply. Runs against a private tmux server (-L socket), never the user's own panes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const SOCKET = `agentctl-remote-test-${process.pid}`;
process.env.COORDINATOR_TMUX_SOCKET = SOCKET;
delete process.env.TMUX_PANE;

const actions = require('./dashboard-actions.cjs');
const { COOKIE, createDashboardServer } = require('./dashboard-server.cjs');
const { tailnetFromStatus, loadTailnetConfig } = require('./dashboard-tailnet.cjs');

const KEY = 'k'.repeat(43);
const TAILNET_HOST = 'pc.tail-test.ts.net';
const OWNER = 'owner@example.com';
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const newWindow = (name, command) => {
  const [windowId, paneId] = tmux('new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', 'twism:', '-n', name, command).split(' ');
  tmux('set-window-option', '-t', windowId, 'automatic-rename', 'off');
  return { windowId, paneId };
};

const writeTask = (stateDir, meta) => {
  const dir = path.join(stateDir, 'tasks', meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: 'twism', model: 'sonnet', createdAt: '2026-10-17T10:00:00-03:00', ...meta }));
};

let env;

const request = ({ method = 'GET', urlPath = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: env.port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const localHeaders = (extra = {}) => ({
  Host: `127.0.0.1:${env.port}`,
  Origin: `http://127.0.0.1:${env.port}`,
  'Content-Type': 'application/json',
  Cookie: `${COOKIE}=${KEY}`,
  'X-Dashboard-Token': env.csrf,
  ...extra,
});

// What `tailscale serve` forwards: the browser's Host, X-Forwarded-Proto https and the peer's login.
const tailnetHeaders = (extra = {}) => ({
  Host: TAILNET_HOST,
  Origin: `https://${TAILNET_HOST}`,
  'X-Forwarded-Host': TAILNET_HOST,
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '100.64.0.7',
  'Tailscale-User-Login': OWNER,
  'Content-Type': 'application/json',
  Cookie: `${COOKIE}=${KEY}`,
  'X-Dashboard-Token': env.csrf,
  ...extra,
});

const without = (headers, ...names) => Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k)));
const post = (urlPath, payload, headers = localHeaders()) => request({ method: 'POST', urlPath, headers, body: JSON.stringify(payload) });
const peek = (id, headers = localHeaders()) => request({ urlPath: `/api/peek?id=${encodeURIComponent(id)}`, headers: without(headers, 'Origin', 'Content-Type') });
const peekCoordinator = (headers = localHeaders()) => request({ urlPath: '/api/coordinator/peek', headers: without(headers, 'Origin', 'Content-Type') });
const readAudit = () => (fs.existsSync(env.auditFile) ? fs.readFileSync(env.auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

before(async () => {
  const scratch = tmpDir('agentctl-remote-');
  const fakeClaude = path.join(scratch, 'claude');
  fs.symlinkSync(execFileSync('bash', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim(), fakeClaude);
  const rule = '────────────────';
  const promptBox = `printf '%s\\n' '${rule}' '❯ ' '${rule}'`;
  const dialog = `printf '%s\\n' 'Do you want to proceed?' '❯ 1. Yes' '  2. No'`;
  const typedReady = path.join(scratch, 'typed-ready.txt');
  const typedDialog = path.join(scratch, 'typed-dialog.txt');
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600');
  const coordinator = newWindow('coordinator', `printf '%s\\n' 'coordinator-marker' '${rule}${rule} session-label ${rule}'; ${promptBox}; exec ${fakeClaude} -a ${path.join(scratch, 'typed-coord.txt')} >/dev/null`);
  tmux('set-option', '-p', '-t', coordinator.paneId, actions.ROLE_OPTION, 'coordinator');
  const ready = newWindow('ready-task', `printf 'peek-marker \\033[31mRED\\033[0m\\n'; ${promptBox}; exec ${fakeClaude} -a ${typedReady} >/dev/null`);
  const asking = newWindow('asking-task-review', `${dialog}; exec ${fakeClaude} -a ${typedDialog} >/dev/null`);
  const shell = newWindow('shell-task', `printf '%s\\n' '${rule}' '❯ ' '${rule}'; exec sleep 600`);

  const stateDir = tmpDir('agentctl-remote-state-');
  writeTask(stateDir, { id: 'ready-task', name: 'ready-task', ...ready });
  writeTask(stateDir, { id: 'asking-task', name: 'asking-task', ...asking });
  writeTask(stateDir, { id: 'shell-task', name: 'shell-task', ...shell });
  writeTask(stateDir, { id: 'points-at-coordinator', name: 'x', ...coordinator });
  writeTask(stateDir, { id: 'stale-pane', name: 'x', windowId: ready.windowId, paneId: '%999' });
  writeTask(stateDir, { id: 'no-pane', name: 'x' });

  const auditFile = path.join(tmpDir('agentctl-audit-'), 'nested', 'dashboard-audit.jsonl');
  const server = createDashboardServer({ stateDir, key: KEY, tailnet: { host: TAILNET_HOST, logins: [OWNER] }, auditFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env = { server, port: server.address().port, stateDir, auditFile, typedReady, typedDialog };
  await sleep(300);
  const page = await request({ headers: { Host: `127.0.0.1:${env.port}`, Cookie: `${COOKIE}=${KEY}` } });
  env.csrf = page.body.match(/const CSRF = "([^"]+)"/)[1];
  env.localPage = page;
});

after(() => {
  env?.server.close();
  try {
    tmux('kill-server');
  } catch {}
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
});

describe('tailnet config', () => {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'PC.tail-test.ts.net.', UserID: 7 },
    User: { 7: { LoginName: OWNER }, 8: { LoginName: 'someone@else.com' } },
  };

  test('tailnetFromStatus takes the MagicDNS name and the machine owner', () => {
    assert.deepEqual(tailnetFromStatus(status), { host: TAILNET_HOST, logins: [OWNER] });
  });

  test('tailnetFromStatus gives nothing when Tailscale is not running or has no name', () => {
    assert.equal(tailnetFromStatus({ ...status, BackendState: 'Stopped' }), null);
    assert.equal(tailnetFromStatus({ ...status, Self: { UserID: 7 } }), null);
    assert.equal(tailnetFromStatus({ ...status, User: {} }), null);
  });

  test('loadTailnetConfig lets the env override the name and the logins, or turn it off', () => {
    const readStatus = () => status;
    assert.deepEqual(loadTailnetConfig({}, readStatus), { host: TAILNET_HOST, logins: [OWNER] });
    assert.deepEqual(
      loadTailnetConfig({ COORDINATOR_DASHBOARD_TAILNET_HOST: 'Other.ts.net', COORDINATOR_DASHBOARD_TAILNET_LOGINS: 'a@x.com, B@y.com' }, readStatus),
      { host: 'other.ts.net', logins: ['a@x.com', 'b@y.com'] },
    );
    assert.equal(loadTailnetConfig({ COORDINATOR_DASHBOARD_TAILNET: 'off' }, readStatus), null);
  });

  test('loadTailnetConfig falls back to local-only when tailscale cannot be read', () => {
    assert.equal(loadTailnetConfig({}, () => { throw new Error('no tailscale'); }), null);
  });
});

describe('tailnet host gate', () => {
  test('serves the page through the tailnet name to the allowlisted login', async () => {
    const res = await request({ headers: without(tailnetHeaders(), 'Origin', 'Content-Type') });
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /<body class="remote">/);
  });

  test('keeps the local page unchanged on 127.0.0.1', () => {
    assert.equal(env.localPage.status, 200);
    assert.doesNotMatch(env.localPage.body, /<body class="remote">/);
    assert.match(env.localPage.body, /Copy jump/);
  });

  test('refuses another tailnet name', async () => {
    const res = await request({ headers: tailnetHeaders({ Host: 'other.tail-test.ts.net', 'X-Forwarded-Host': 'other.tail-test.ts.net' }) });
    assert.equal(res.status, 403);
  });

  for (const [label, headers] of [
    ['a missing login', () => without(tailnetHeaders(), 'Tailscale-User-Login')],
    ['a wrong login', () => tailnetHeaders({ 'Tailscale-User-Login': 'intruder@example.com' })],
    ['a Funnel request', () => tailnetHeaders({ 'Tailscale-Funnel-Request': '?1' })],
    ['plain HTTP', () => without(tailnetHeaders(), 'X-Forwarded-Proto')],
  ]) {
    test(`refuses ${label} on the tailnet name, even with the key cookie`, async () => {
      const res = await request({ headers: headers() });
      assert.equal(res.status, 403);
      assert.doesNotMatch(res.body, /CSRF/);
    });
  }

  test('marks the cookie Secure when it is set over the tailnet', async () => {
    const res = await request({ urlPath: `/?key=${KEY}`, headers: without(tailnetHeaders(), 'Cookie') });
    assert.equal(res.status, 303);
    assert.match(res.headers['set-cookie'][0], /; Secure(;|$)/);
    assert.match(res.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  });

  test('leaves the cookie without Secure on 127.0.0.1', async () => {
    const res = await request({ urlPath: `/?key=${KEY}`, headers: { Host: `127.0.0.1:${env.port}` } });
    assert.equal(res.status, 303);
    assert.doesNotMatch(res.headers['set-cookie'][0], /Secure/);
  });

  test('accepts the https tailnet origin on an action', async () => {
    const res = await post('/api/reply', { id: 'no-such-task', text: 'hi' }, tailnetHeaders());
    assert.equal(res.status, 409);
    assert.match(res.json().error, /not in the ledger/);
  });

  for (const origin of [`http://${TAILNET_HOST}`, 'http://127.0.0.1:47317', 'https://evil.ts.net']) {
    test(`refuses origin ${origin} on the tailnet name`, async () => {
      const res = await post('/api/reply', { id: 'ready-task', text: 'hi' }, tailnetHeaders({ Origin: origin }));
      assert.equal(res.status, 403);
    });
  }

  test('refuses the tailnet origin on the local host', async () => {
    const res = await post('/api/reply', { id: 'ready-task', text: 'hi' }, localHeaders({ Origin: `https://${TAILNET_HOST}` }));
    assert.equal(res.status, 403);
  });
});

describe('peek', () => {
  test('returns the last lines of a ledger task pane, ANSI stripped, uncached', async () => {
    const res = await peek('ready-task');
    assert.equal(res.status, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { lines } = res.json();
    assert.ok(lines.includes('peek-marker RED'), lines.join('\n'));
    assert.ok(lines.every((l) => !/[\u0000-\u001f]/.test(l)));
    assert.ok(lines.every((l) => !/^[─━\s]+$/.test(l)), 'rule lines wrap badly on a phone');
    assert.ok(lines.length <= actions.PEEK_LINES);
  });

  test('works over the tailnet', async () => {
    const res = await peek('ready-task', tailnetHeaders());
    assert.equal(res.status, 200, res.body);
  });

  for (const [id, reason] of [
    ['not-in-ledger', /not in the ledger/],
    ['%0', /Invalid task id/],
    ['../../etc', /Invalid task id/],
    ['points-at-coordinator', /protected/],
    ['stale-pane', /no longer owns/],
    ['no-pane', /no pane on record/],
  ]) {
    test(`refuses to peek ${id}`, async () => {
      const res = await peek(id);
      assert.equal(res.status, 409);
      assert.match(res.json().error, reason);
    });
  }

  test('refuses a peek without the token', async () => {
    const res = await peek('ready-task', without(localHeaders(), 'X-Dashboard-Token'));
    assert.equal(res.status, 403);
  });

  test('refuses a peek without the key cookie', async () => {
    const res = await peek('ready-task', without(localHeaders(), 'Cookie'));
    assert.equal(res.status, 401);
  });

  test('refuses a cross-site peek', async () => {
    const res = await peek('ready-task', localHeaders({ 'Sec-Fetch-Site': 'cross-site' }));
    assert.equal(res.status, 403);
  });
});

describe('coordinator peek', () => {
  test('returns the coordinator pane, uncached, so its replies can be read from the phone', async () => {
    const res = await peekCoordinator(tailnetHeaders());
    assert.equal(res.status, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.json().lines.includes('coordinator-marker'), res.body);
  });

  test('shortens a labelled rule line, which would wrap into a wall of dashes on a phone', async () => {
    const { lines } = (await peekCoordinator()).json();
    assert.ok(lines.includes('── session-label ──'), lines.join('\n'));
  });

  for (const [label, headers, status] of [
    ['the token', () => without(localHeaders(), 'X-Dashboard-Token'), 403],
    ['the key cookie', () => without(localHeaders(), 'Cookie'), 401],
    ['the tailnet login', () => without(tailnetHeaders(), 'Tailscale-User-Login'), 403],
  ]) {
    test(`refuses without ${label}`, async () => {
      const res = await peekCoordinator(headers());
      assert.equal(res.status, status);
    });
  }

  test('refuses a cross-site read', async () => {
    const res = await peekCoordinator(localHeaders({ 'Sec-Fetch-Site': 'cross-site' }));
    assert.equal(res.status, 403);
  });
});

describe('reply', () => {
  test('refuses a pane showing a dialog and types nothing', async () => {
    const res = await post('/api/reply', { id: 'asking-task', text: 'yes' });
    assert.equal(res.status, 409);
    assert.match(res.json().error, /answer it in the terminal/);
    await sleep(200);
    assert.equal(fs.existsSync(env.typedDialog) ? fs.readFileSync(env.typedDialog, 'utf8') : '', '');
  });

  test('refuses a pane that is not running Claude', async () => {
    const res = await post('/api/reply', { id: 'shell-task', text: 'ls' });
    assert.equal(res.status, 409);
    assert.match(res.json().error, /not Claude/);
  });

  for (const [id, reason] of [
    ['not-in-ledger', /not in the ledger/],
    ['%1', /Invalid task id/],
    ['points-at-coordinator', /protected/],
  ]) {
    test(`refuses to reply to ${id}`, async () => {
      const res = await post('/api/reply', { id, text: 'hi' });
      assert.equal(res.status, 409);
      assert.match(res.json().error, reason);
    });
  }

  test('refuses a too-long reply', async () => {
    const res = await post('/api/reply', { id: 'ready-task', text: 'x'.repeat(actions.MAX_MESSAGE_CHARS + 1) });
    assert.equal(res.status, 409);
  });

  test('types the sanitized, prefixed reply into the worker pane and audits it', async () => {
    const res = await post('/api/reply', { id: 'ready-task', text: 'go on\u001b[2J\nplease;' });
    assert.equal(res.status, 200, res.body);
    await sleep(300);
    assert.equal(fs.readFileSync(env.typedReady, 'utf8'), `${actions.MESSAGE_PREFIX}go on[2J please;\n`);
    const entry = readAudit().pop();
    assert.equal(entry.task, 'ready-task');
    assert.equal(entry.source, 'local');
    assert.equal(entry.text, 'go on[2J please;');
    assert.ok(!Number.isNaN(Date.parse(entry.at)));
    assert.equal(fs.statSync(env.auditFile).mode & 0o777, 0o600);
  });

  test('records the tailnet login as the source of a reply sent from the phone', async () => {
    const res = await post('/api/reply', { id: 'ready-task', text: 'from the phone' }, tailnetHeaders());
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(
      (({ task, source, text }) => ({ task, source, text }))(readAudit().pop()),
      { task: 'ready-task', source: `tailnet:${OWNER}`, text: 'from the phone' },
    );
  });

  test('audits a message to the coordinator too', async () => {
    const res = await post('/api/message', { text: 'status?' });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual((({ task, source, text }) => ({ task, source, text }))(readAudit().pop()), { task: 'coordinator', source: 'local', text: 'status?' });
  });
});

describe('served page controls', () => {
  test('offers a reply box and a peek button on live task cards', () => {
    const { body } = env.localPage;
    assert.match(body, /<form class="reply" data-reply="ready-task"/);
    assert.match(body, /data-peek="ready-task"/);
    assert.doesNotMatch(body, /data-reply="no-pane"/);
  });

  test('offers a coordinator button that is not desktop-only', () => {
    assert.match(env.localPage.body, /<button class="btn quiet" data-act="coordinator" type="button">/);
  });

  test('ships inline scripts that parse', () => {
    const scripts = [...env.localPage.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 2);
    for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  });

  test('marks the desktop-only controls so the tailnet page can hide them', () => {
    assert.match(env.localPage.body, /class="mini desktop-only" data-copy=/);
  });
});
