// Two profiles on a private tmux server (-L socket), never the user's own panes: a Claude
// coordinator found by window name in session twism, and a Codex coordinator marked by role and
// profile in session personal, with one Codex worker.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const SOCKET = `agentctl-profiles-test-${process.pid}`;
process.env.COORDINATOR_TMUX_SOCKET = SOCKET;
delete process.env.TMUX_PANE;

const actions = require('./dashboard-actions.cjs');
const { COOKIE, createDashboardServer } = require('./dashboard-server.cjs');

const KEY = 'p'.repeat(43);
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const readOr = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

const CLAUDE_PROMPT = "printf '%s\\n' '────────────────' '❯ ' '────────────────'";
const CODEX_PROMPT = "printf '%s\\n' '› Ask Codex to do anything' '  gpt-6-sol medium · ~/workspace/github'";
const CODEX_DIALOG = "printf '%s\\n' 'Update available!' '› 1. Update now' '  2. Skip' '  Press enter to continue'";

let env;

const newWindow = (session, name, command) => {
  const [windowId, paneId] = tmux('new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', `${session}:`, '-n', name, command).split(' ');
  tmux('set-window-option', '-t', windowId, 'automatic-rename', 'off');
  return { windowId, paneId };
};

// What `agentctl.sh spawn` does to a worker's pane.
const tagAsTask = (window, id, profile = 'twism') =>
  tmux('set-option', '-p', '-t', window.paneId, actions.TASK_OPTION, id, ';', 'set-option', '-p', '-t', window.paneId, actions.PROFILE_OPTION, profile);
const writeTask = (stateDir, meta) => {
  const dir = path.join(stateDir, 'tasks', meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ model: 'sonnet', createdAt: '2026-10-30T10:00:00-03:00', ...meta }));
};

const request = ({ method = 'GET', urlPath = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: env.port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const headers = (extra = {}) => ({
  Host: `127.0.0.1:${env.port}`,
  Origin: `http://127.0.0.1:${env.port}`,
  'Content-Type': 'application/json',
  Cookie: `${COOKIE}=${KEY}`,
  'X-Dashboard-Token': env.csrf,
  ...extra,
});
const post = (urlPath, payload) => request({ method: 'POST', urlPath, headers: headers(), body: JSON.stringify(payload) });
const get = (urlPath) => {
  const { Origin, ...rest } = headers();
  return request({ urlPath, headers: rest });
};

before(async () => {
  const scratch = tmpDir('agentctl-profiles-');
  const tee = execFileSync('bash', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim();
  for (const name of ['claude', 'codex']) fs.symlinkSync(tee, path.join(scratch, name));
  const typed = { twism: path.join(scratch, 'twism.txt'), personal: path.join(scratch, 'personal.txt'), worker: path.join(scratch, 'worker.txt'), busy: path.join(scratch, 'busy.txt') };

  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600');
  tmux('new-session', '-d', '-s', 'personal', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600');
  const twismCoordinator = newWindow('twism', 'coordinator', `${CLAUDE_PROMPT}; exec ${scratch}/claude -a ${typed.twism} >/dev/null`);
  const personalCoordinator = newWindow('personal', 'coordinator', `${CODEX_PROMPT}; exec ${scratch}/codex -a ${typed.personal} >/dev/null`);
  tmux('set-option', '-p', '-t', personalCoordinator.paneId, actions.ROLE_OPTION, 'coordinator');
  tmux('set-option', '-p', '-t', personalCoordinator.paneId, actions.PROFILE_OPTION, 'personal');
  const worker = newWindow('personal', 'mimic-bug', `${CODEX_PROMPT}; exec ${scratch}/codex -a ${typed.worker} >/dev/null`);
  const busy = newWindow('personal', 'busy-worker', `${CODEX_DIALOG}; exec ${scratch}/codex -a ${typed.busy} >/dev/null`);

  tagAsTask(worker, 'mimic-bug', 'personal');
  tagAsTask(busy, 'busy-worker', 'personal');
  const twismState = tmpDir('agentctl-twism-');
  const personalState = tmpDir('agentctl-personal-');
  writeTask(personalState, { id: 'mimic-bug', name: 'mimic-bug', session: 'personal', model: 'gpt-6-sol', harness: 'codex', profile: 'personal', ...worker });
  writeTask(personalState, { id: 'busy-worker', name: 'busy-worker', session: 'personal', model: 'gpt-6-sol', harness: 'codex', profile: 'personal', ...busy });

  const auditFile = path.join(scratch, 'audit.jsonl');
  const profiles = [
    { name: 'twism', label: 'Twism', stateDir: twismState, session: '', harness: 'claude' },
    { name: 'personal', label: 'Personal', stateDir: personalState, session: 'personal', harness: 'codex' },
  ];
  const server = createDashboardServer({ stateDir: twismState, profiles, key: KEY, auditFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env = { server, port: server.address().port, typed, twismCoordinator, personalCoordinator, worker, auditFile };
  await sleep(200);
  const page = await request({ headers: { Host: `127.0.0.1:${env.port}`, Cookie: `${COOKIE}=${KEY}` } });
  env.csrf = page.body.match(/const CSRF = "([^"]+)"/)[1];
  env.page = page.body;
});

after(() => {
  env?.server.close();
  try {
    tmux('kill-server');
  } catch {}
});

describe('page', () => {
  test('renders one lane per profile, each with its own coordinator console', () => {
    assert.match(env.page, /class="lane" data-profile="twism"/);
    assert.match(env.page, /class="lane" data-profile="personal"/);
    assert.match(env.page, /<form class="msg" data-profile="personal"/);
    assert.match(env.page, /data-id="personal\/mimic-bug"/);
  });
});

describe('collapsible lanes', () => {
  test('each lane has a toggle and a summary of what collapsing hides', () => {
    assert.match(env.page, /<button class="lanetoggle" type="button" data-lane-toggle="personal" aria-expanded="true"/);
    assert.match(env.page, /<span class="lanesum" data-lane-sum="personal">2 working<\/span>/);
    assert.match(env.page, /<span class="lanesum" data-lane-sum="twism">nothing open<\/span>/);
  });
});

describe('routing by profile', () => {
  test('a message for personal reaches only the Codex coordinator', async () => {
    const res = await post('/api/message', { text: 'status?', profile: 'personal' });
    assert.equal(res.status, 200, res.body);
    await sleep(300);
    assert.equal(readOr(env.typed.personal), `${actions.MESSAGE_PREFIX}status?\n`);
    assert.equal(readOr(env.typed.twism), '');
  });

  test('a message without a profile still reaches the primary coordinator', async () => {
    const res = await post('/api/message', { text: 'hi' });
    assert.equal(res.status, 200, res.body);
    await sleep(300);
    assert.equal(readOr(env.typed.twism), `${actions.MESSAGE_PREFIX}hi\n`);
  });

  test('an unknown profile is refused', async () => {
    const res = await post('/api/message', { text: 'hi', profile: 'nope' });
    assert.equal(res.status, 409);
    assert.match(res.json().error, /Unknown profile/);
  });

  test('focus switches the personal session to its coordinator window', async () => {
    tmux('select-window', '-t', env.worker.windowId);
    const res = await post('/api/coordinator/focus', { profile: 'personal' });
    assert.equal(res.status, 200, res.body);
    assert.equal(tmux('display-message', '-p', '-t', 'personal:', '#{window_id}'), env.personalCoordinator.windowId);
  });

  test('a reply to a profile-keyed task types into that worker; the bare id is not in the primary ledger', async () => {
    const res = await post('/api/reply', { id: 'personal/mimic-bug', text: 'try again' });
    assert.equal(res.status, 200, res.body);
    await sleep(300);
    assert.equal(readOr(env.typed.worker), `${actions.MESSAGE_PREFIX}try again\n`);
    const bare = await post('/api/reply', { id: 'mimic-bug', text: 'x' });
    assert.equal(bare.status, 409);
    assert.match(bare.json().error, /not in the ledger/);
  });

  test('a Codex pane showing a numbered dialog is refused', async () => {
    const res = await post('/api/reply', { id: 'personal/busy-worker', text: 'x' });
    assert.equal(res.status, 409);
    assert.match(res.json().error, /dialog/);
    assert.equal(readOr(env.typed.busy), '');
  });

  test('peek reads the personal coordinator pane', async () => {
    const res = await get('/api/coordinator/peek?profile=personal');
    assert.equal(res.status, 200, res.body);
    assert.ok(res.json().lines.some((l) => l.includes('Ask Codex')));
  });

  test('the audit log records the profile of every typed message', () => {
    const entries = readOr(env.auditFile).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      entries.map((e) => [e.profile, e.task]),
      [
        ['personal', 'coordinator'],
        ['twism', 'coordinator'],
        ['personal', 'mimic-bug'],
      ],
    );
  });
});

describe('helpers', () => {
  test('promptIsReady for Codex accepts the composer and refuses numbered choices', () => {
    assert.equal(actions.promptIsReady(['• Working (3s)', '› Ask Codex to do anything', '  gpt-6-sol'], 'codex'), true);
    assert.equal(actions.promptIsReady(['Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'], 'codex'), false);
    assert.equal(actions.promptIsReady(['› 1. Update now', '  2. Skip', '  Press enter to continue'], 'codex'), false);
    assert.equal(actions.promptIsReady(['$ '], 'codex'), false);
  });

  test('resolveCoordinator scopes by profile and keeps unmarked coordinators out of other profile sessions', () => {
    const pane = (id, session, windowName, role = '', profile = '') => ({ id, windowId: `@${id}`, session, command: 'claude', role, profile, windowName });
    const panes = [pane('1', 'twism', 'coordinator'), pane('2', 'personal', 'coordinator', 'coordinator', 'personal')];
    assert.equal(actions.resolveCoordinator(panes, { name: 'twism', excludeSessions: ['personal'] }).id, '1');
    assert.equal(actions.resolveCoordinator(panes, { name: 'personal', session: 'personal' }).id, '2');
    const unmarked = [pane('1', 'twism', 'coordinator'), pane('3', 'personal', 'coordinator')];
    assert.equal(actions.resolveCoordinator(unmarked, { name: 'twism', excludeSessions: ['personal'] }).id, '1');
  });
});
