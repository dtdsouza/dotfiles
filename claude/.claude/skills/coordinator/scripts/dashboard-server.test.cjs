// Runs against a private tmux server (-L socket), never the user's own panes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const SOCKET = `agentctl-test-${process.pid}`;
process.env.COORDINATOR_TMUX_SOCKET = SOCKET;
delete process.env.TMUX_PANE;

const actions = require('./dashboard-actions.cjs');
const { COOKIE, MAX_BODY_BYTES, createDashboardServer, loadOrCreateKey } = require('./dashboard-server.cjs');

const KEY = 'k'.repeat(43);
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const newWindow = (name, command) => {
  const [windowId, paneId] = tmux('new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', 'twism:', '-n', name, command).split(' ');
  tmux('set-window-option', '-t', windowId, 'automatic-rename', 'off');
  return { windowId, paneId };
};
const windowIds = () => tmux('list-windows', '-a', '-F', '#{window_id}').split('\n');

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

const goodHeaders = (extra = {}) => ({
  Host: `127.0.0.1:${env.port}`,
  Origin: `http://127.0.0.1:${env.port}`,
  'Content-Type': 'application/json',
  Cookie: `${COOKIE}=${KEY}`,
  'X-Dashboard-Token': env.csrf,
  ...extra,
});

const post = (urlPath, payload, headers = goodHeaders()) => request({ method: 'POST', urlPath, headers, body: JSON.stringify(payload) });

before(async () => {
  const scratch = tmpDir('agentctl-dash-');
  const fakeClaude = path.join(scratch, 'claude');
  fs.symlinkSync(execFileSync('bash', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim(), fakeClaude);
  const typed = path.join(scratch, 'typed.txt');
  const promptBox = "printf '%s\\n' '────────────────' '❯ ' '────────────────'";
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600');
  const coordinator = newWindow('coordinator', `${promptBox}; exec ${fakeClaude} -a ${typed} >/dev/null`);
  tmux('set-option', '-p', '-t', coordinator.paneId, actions.ROLE_OPTION, 'coordinator');
  const dashboard = newWindow('dashboard', 'sleep 600');
  const done = newWindow('done-task-done', 'sleep 600');
  const working = newWindow('working-task', 'sleep 600');
  const doneToo = newWindow('second-done', 'sleep 600');
  const reused = newWindow('someone-else', 'sleep 600');

  const stateDir = tmpDir('agentctl-state-');
  const archivedAt = '2026-10-17T11:00:00-03:00';
  writeTask(stateDir, { id: 'done-task', name: 'done-task', ...done, archivedAt });
  writeTask(stateDir, { id: 'second-done', name: 'second-done', ...doneToo, archivedAt });
  writeTask(stateDir, { id: 'working-task', name: 'working-task', ...working });
  writeTask(stateDir, { id: 'points-at-dashboard', name: 'x', ...dashboard, archivedAt });
  writeTask(stateDir, { id: 'points-at-coordinator', name: 'x', ...coordinator, archivedAt });
  writeTask(stateDir, { id: 'stale-window', name: 'x', windowId: reused.windowId, paneId: '%999', archivedAt });

  const server = createDashboardServer({ stateDir, key: KEY });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env = { server, port: server.address().port, stateDir, typed, coordinator, dashboard, done, working, doneToo, reused };
  const page = await request({ headers: { Host: `127.0.0.1:${env.port}`, Cookie: `${COOKIE}=${KEY}` } });
  env.csrf = page.body.match(/const CSRF = "([^"]+)"/)[1];
  env.page = page;
});

after(() => {
  env?.server.close();
  try {
    tmux('kill-server');
  } catch {}
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
});

describe('page access', () => {
  test('refuses the page without the key cookie', async () => {
    const res = await request({ headers: { Host: `127.0.0.1:${env.port}` } });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /CSRF/);
  });

  test('refuses a wrong key in the URL', async () => {
    const res = await request({ urlPath: '/?key=nope', headers: { Host: `127.0.0.1:${env.port}` } });
    assert.equal(res.status, 401);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('trades the right key for a strict HttpOnly cookie and drops it from the URL', async () => {
    const res = await request({ urlPath: `/?key=${KEY}`, headers: { Host: `localhost:${env.port}` } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/');
    assert.match(res.headers['set-cookie'][0], new RegExp(`^${COOKIE}=${KEY}; HttpOnly; SameSite=Strict; Path=/`));
  });

  test('serves the page with a nonce CSP, no framing and the close button only on the done task', () => {
    const { headers, body } = env.page;
    assert.equal(env.page.status, 200);
    const nonce = headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.match(body, new RegExp(`<script nonce="${nonce.replace(/[+/]/g, '\\$&')}">`));
    assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.deepEqual([...body.matchAll(/data-close="([^"]+)"/g)].map((m) => m[1]).sort(), ['done-task', 'second-done']);
    assert.match(body, /Message coordinator/);
  });

  test('refuses a wrong Host even with a valid cookie (DNS rebinding)', async () => {
    const res = await request({ headers: { Host: `evil.example:${env.port}`, Cookie: `${COOKIE}=${KEY}` } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /CSRF/);
  });
});

describe('action gate', () => {
  test('refuses a cross-origin request carrying the real cookie and token', async () => {
    const res = await post('/api/coordinator/focus', {}, goodHeaders({ Origin: 'http://evil.example' }));
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('refuses a request with no Origin', async () => {
    const { Origin, ...headers } = goodHeaders();
    const res = await post('/api/coordinator/focus', {}, headers);
    assert.equal(res.status, 403);
  });

  test('refuses a cross-site Sec-Fetch-Site', async () => {
    const res = await post('/api/coordinator/focus', {}, goodHeaders({ 'Sec-Fetch-Site': 'cross-site' }));
    assert.equal(res.status, 403);
  });

  test('answers a CORS preflight without allowing anything', async () => {
    const res = await request({ method: 'OPTIONS', urlPath: '/api/message', headers: { Host: `127.0.0.1:${env.port}`, Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-dashboard-token' } });
    assert.equal(res.status, 405);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-headers'], undefined);
  });

  test('refuses a wrong Host on an action', async () => {
    const res = await post('/api/coordinator/focus', {}, goodHeaders({ Host: `attacker.test:${env.port}` }));
    assert.equal(res.status, 403);
  });

  test('refuses a missing token', async () => {
    const { 'X-Dashboard-Token': _, ...headers } = goodHeaders();
    const res = await post('/api/coordinator/focus', {}, headers);
    assert.equal(res.status, 403);
    assert.equal(res.json().reload, true);
  });

  test('refuses a wrong token', async () => {
    const res = await post('/api/coordinator/focus', {}, goodHeaders({ 'X-Dashboard-Token': `${env.csrf.slice(0, -1)}x` }));
    assert.equal(res.status, 403);
  });

  test('refuses a missing key cookie', async () => {
    const { Cookie, ...headers } = goodHeaders();
    const res = await post('/api/coordinator/focus', {}, headers);
    assert.equal(res.status, 401);
  });

  test('refuses a form-encoded body', async () => {
    const res = await request({ method: 'POST', urlPath: '/api/message', headers: goodHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: 'text=hi' });
    assert.equal(res.status, 415);
  });

  test('refuses a body over the size limit', async () => {
    const res = await post('/api/message', { text: 'x'.repeat(MAX_BODY_BYTES + 1) });
    assert.equal(res.status, 413);
  });

  test('refuses a too-long message', async () => {
    const res = await post('/api/message', { text: 'x'.repeat(actions.MAX_MESSAGE_CHARS + 1) });
    assert.equal(res.status, 409);
  });
});

describe('actions on the test tmux server', () => {
  test('types the message into the coordinator pane, prefixed and stripped of control characters', async () => {
    const res = await post('/api/message', { text: 'hello\u001b[31m\nworld; done;;' });
    assert.equal(res.status, 200, res.body);
    await sleep(300);
    assert.equal(fs.readFileSync(env.typed, 'utf8'), `${actions.MESSAGE_PREFIX}hello[31m world; done;;\n`);
  });

  test('switches the session to the coordinator window', async () => {
    tmux('select-window', '-t', env.working.windowId);
    const res = await post('/api/coordinator/focus', {});
    assert.equal(res.status, 200, res.body);
    assert.equal(tmux('display-message', '-p', '-t', 'twism:', '#{window_id}'), env.coordinator.windowId);
  });

  for (const [id, reason] of [
    ['working-task', /not done/],
    ['points-at-coordinator', /protected/],
    ['points-at-dashboard', /protected/],
    ['stale-window', /no longer owns/],
    ['not-in-ledger', /not in the ledger/],
    ['../../etc', /Invalid task id/],
  ]) {
    test(`refuses to close ${id}`, async () => {
      const before = windowIds();
      const res = await post('/api/tabs/close', { id });
      assert.equal(res.status, 409);
      assert.match(res.json().error, reason);
      assert.deepEqual(windowIds(), before);
    });
  }

  test('closes the tab of a done task', async () => {
    const res = await post('/api/tabs/close', { id: 'done-task' });
    assert.equal(res.status, 200, res.body);
    assert.ok(!windowIds().includes(env.done.windowId));
  });

  test('close-done closes only the remaining done tabs', async () => {
    const res = await post('/api/tabs/close-done', {});
    assert.equal(res.status, 200, res.body);
    const left = windowIds();
    assert.ok(!left.includes(env.doneToo.windowId));
    for (const kept of [env.coordinator, env.dashboard, env.working, env.reused]) assert.ok(left.includes(kept.windowId));
  });
});

describe('helpers', () => {
  test('promptIsReady refuses a permission dialog and accepts the input box', () => {
    const rule = '─'.repeat(40);
    assert.equal(actions.promptIsReady(['output', rule, '❯ ', rule, '  status line']), true);
    assert.equal(actions.promptIsReady(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), false);
    assert.equal(actions.promptIsReady([rule, '❯ draft', rule, 'Do you want to proceed?', '❯ 1. Yes']), false);
    assert.equal(actions.promptIsReady(['$ ']), false);
  });

  test('resolveCoordinator prefers the role option, falls back to the window name and refuses ambiguity', () => {
    const pane = (id, windowName, role = '') => ({ id, windowId: `@${id}`, session: 's', command: 'claude', role, windowName });
    assert.equal(actions.resolveCoordinator([pane('1', 'coordinator'), pane('2', 'x', 'coordinator')]).id, '2');
    assert.equal(actions.resolveCoordinator([pane('1', 'coordinator'), pane('2', 'x')]).id, '1');
    assert.throws(() => actions.resolveCoordinator([pane('1', 'coordinator'), pane('2', 'coordinator')]), /2 coordinator panes/);
    assert.throws(() => actions.resolveCoordinator([pane('1', 'x')]), /No coordinator pane/);
  });

  test('sanitizeMessage rejects empty and non-text input', () => {
    assert.throws(() => actions.sanitizeMessage('\u0007\n '), /empty/);
    assert.throws(() => actions.sanitizeMessage(42), /must be text/);
    assert.equal(actions.sanitizeMessage('a‮b\tc'), 'ab c');
  });

  test('loadOrCreateKey creates a private key file and refuses a readable one', () => {
    const file = path.join(tmpDir('agentctl-key-'), 'nested', 'dashboard.key');
    const key = loadOrCreateKey(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(loadOrCreateKey(file), key);
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadOrCreateKey(file), /not readable by others/);
  });
});
