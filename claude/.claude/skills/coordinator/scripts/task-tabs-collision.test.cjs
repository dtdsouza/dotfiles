// Reproduces the collision on a private tmux server (-L socket): archived Twism entries from an
// earlier server name the window and pane ids that live Twism and personal panes hold now.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const SOCKET = `agentctl-collision-test-${process.pid}`;
process.env.COORDINATOR_TMUX_SOCKET = SOCKET;
delete process.env.TMUX_PANE;

const actions = require('./dashboard-actions.cjs');
const tabs = require('./task-tabs.cjs');
const { collectProfileItems } = require('./dashboard.cjs');
const { COOKIE, createDashboardServer } = require('./dashboard-server.cjs');

const KEY = 'c'.repeat(43);
const DAY_MS = 86400 * 1000;
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const paneOption = (pane, option) => {
  try {
    return tmux('show-options', '-p', '-v', '-t', pane, option);
  } catch {
    return '';
  }
};
const windowIds = () => tmux('list-windows', '-a', '-F', '#{window_id}').split('\n');

const newWindow = (session, name, tag = null) => {
  const [windowId, paneId] = tmux('new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', `${session}:`, '-n', name, 'sleep 600').split(' ');
  tmux('set-window-option', '-t', windowId, 'automatic-rename', 'off');
  if (tag) tmux('set-option', '-p', '-t', paneId, tabs.TASK_OPTION, tag.id, ';', 'set-option', '-p', '-t', paneId, tabs.PROFILE_OPTION, tag.profile);
  return { windowId, paneId };
};

const writeTask = (stateDir, meta) => {
  const dir = path.join(stateDir, 'tasks', meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ model: 'sonnet', name: meta.id, ...meta }));
  fs.writeFileSync(path.join(dir, 'brief.md'), `# Goal\n\nGoal of ${meta.id}.\n`);
};

let env;

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

const headers = () => ({
  Host: `127.0.0.1:${env.port}`,
  Origin: `http://127.0.0.1:${env.port}`,
  'Content-Type': 'application/json',
  Cookie: `${COOKIE}=${KEY}`,
  'X-Dashboard-Token': env.csrf,
});
const post = (urlPath, payload) => request({ method: 'POST', urlPath, headers: headers(), body: JSON.stringify(payload) });
const peek = (id) => {
  const { Origin, ...rest } = headers();
  return request({ urlPath: `/api/peek?id=${encodeURIComponent(id)}`, headers: rest });
};
const loadPage = async () => {
  const page = await request({ headers: { Host: `127.0.0.1:${env.port}`, Cookie: `${COOKIE}=${KEY}` } });
  env.csrf = page.body.match(/const CSRF = "([^"]+)"/)[1];
  return page.body;
};

before(async () => {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-x', '200', '-y', '40', '-n', 'coordinator', 'sleep 600');
  tmux('set-option', '-p', '-t', 'twism:coordinator', actions.ROLE_OPTION, 'coordinator');
  tmux('new-session', '-d', '-s', 'personal', '-x', '200', '-y', '40', '-n', 'coordinator', 'sleep 600');
  tmux('set-option', '-p', '-t', 'personal:coordinator', actions.ROLE_OPTION, 'coordinator', ';', 'set-option', '-p', '-t', 'personal:coordinator', actions.PROFILE_OPTION, 'personal');
  const personalCoordinator = tmux('display-message', '-p', '-t', 'personal:coordinator', '#{window_id} #{pane_id}').split(' ');

  const liveTwism = newWindow('twism', 'mr1181-scripts-safety-review', { id: 'mr1181-scripts-safety-review', profile: 'twism' });
  const untaggedTwism = newWindow('twism', 'two-coordinators-poc-duplicate-done');
  const renamedSession = newWindow('twism', 'olive-monitoring-alerts');
  const sampleHtml = newWindow('personal', 'sample-html-done', { id: 'sample-html', profile: 'personal' });
  const legacyPersonal = newWindow('personal', 'personal-file-serving');

  const twismState = tmpDir('agentctl-collision-twism-');
  const personalState = tmpDir('agentctl-collision-personal-');
  const now = isoAgo(0);
  const old = isoAgo(14 * DAY_MS);
  const archivedAt = isoAgo(14 * DAY_MS - 60000);
  writeTask(twismState, { id: 'mr1181-scripts-safety-review', session: '0', createdAt: now, ...liveTwism });
  writeTask(twismState, { id: 'coordinator-dashboard-favicon', session: 'twism', createdAt: old, archivedAt, windowId: liveTwism.windowId, paneId: '%951' });
  writeTask(twismState, { id: 'coordinator-dashboard-facelift', session: 'twism', createdAt: old, archivedAt, ...sampleHtml });
  writeTask(twismState, { id: 'slack-send-as-app', session: 'twism', createdAt: old, archivedAt, windowId: personalCoordinator[0], paneId: personalCoordinator[1] });
  writeTask(twismState, { id: 'hr-platform-prd', session: 'twism', createdAt: old, archivedAt, ...untaggedTwism });
  writeTask(twismState, { id: 'olive-monitoring-alerts', session: '0', createdAt: now, ...renamedSession });
  writeTask(personalState, { id: 'sample-html', session: 'personal', profile: 'personal', createdAt: now, archivedAt: now, ...sampleHtml });
  writeTask(personalState, { id: 'personal-file-serving', session: 'personal', profile: 'personal', createdAt: now, ...legacyPersonal });

  const profiles = [
    { name: 'twism', label: 'Twism', stateDir: twismState, session: '', harness: 'claude' },
    { name: 'personal', label: 'Personal', stateDir: personalState, session: 'personal', harness: 'codex' },
  ];
  const server = createDashboardServer({ stateDir: twismState, profiles, key: KEY, auditFile: path.join(tmpDir('agentctl-collision-audit-'), 'audit.jsonl') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env = { server, port: server.address().port, profiles, liveTwism, untaggedTwism, renamedSession, sampleHtml, legacyPersonal };
  env.page = await loadPage();
});

after(() => {
  env?.server.close();
  try {
    tmux('kill-server');
  } catch {}
});

const itemsByKey = () => new Map(collectProfileItems(env.profiles).map((a) => [a.key, a]));

describe('the board', () => {
  test('old Twism entries claim no live window and show as closed', () => {
    const items = itemsByKey();
    for (const id of ['coordinator-dashboard-favicon', 'coordinator-dashboard-facelift', 'slack-send-as-app', 'hr-platform-prd']) {
      assert.equal(items.get(id).win, '-', id);
      assert.equal(items.get(id).status, 'done', id);
      assert.deepEqual(items.get(id).flags, [], id);
    }
  });

  test('each live window shows on exactly one card, in the lane of its pane', () => {
    const items = [...itemsByKey().values()];
    const holders = (windowId) => items.filter((a) => a.win === windowId).map((a) => a.key);
    assert.deepEqual(holders(env.liveTwism.windowId), ['mr1181-scripts-safety-review']);
    assert.deepEqual(holders(env.sampleHtml.windowId), ['personal/sample-html']);
    assert.deepEqual(holders(env.legacyPersonal.windowId), ['personal/personal-file-serving']);
    assert.equal(itemsByKey().get('personal/sample-html').profile, 'personal');
    assert.ok(items.filter((a) => a.profile === 'twism').every((a) => a.session !== 'personal'));
  });

  test('a legacy tab that matches but carries no tag says how to adopt it', () => {
    assert.ok(itemsByKey().get('personal/personal-file-serving').flags.some((f) => /adopt-tabs/.test(f)));
  });

  test('the served page offers Close only for the tagged, archived task', () => {
    const closable = [...env.page.matchAll(/data-close="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(closable, ['personal/sample-html']);
  });
});

describe('actions recheck the tag', () => {
  test('peek and reply refuse an old entry whose window id is live', async () => {
    const res = await peek('coordinator-dashboard-favicon');
    assert.equal(res.status, 409);
    const reply = await post('/api/reply', { id: 'coordinator-dashboard-facelift', text: 'x' });
    assert.equal(reply.status, 409);
  });

  test('peek refuses an untagged legacy tab until it is adopted', async () => {
    const res = await peek('personal/personal-file-serving');
    assert.equal(res.status, 409);
    assert.match(res.json().error, /adopt-tabs/);
  });

  test('close on an old entry leaves the recycled windows open', async () => {
    const before = windowIds();
    for (const id of ['coordinator-dashboard-favicon', 'coordinator-dashboard-facelift', 'slack-send-as-app', 'hr-platform-prd']) {
      const res = await post('/api/tabs/close', { id });
      assert.equal(res.status, 409, id);
    }
    assert.deepEqual(windowIds(), before);
  });

  test('Close all in the Twism lane touches no recycled window', async () => {
    const before = windowIds();
    const res = await post('/api/tabs/close-done', { profile: 'twism' });
    assert.equal(res.status, 409);
    assert.deepEqual(windowIds(), before);
  });

  test('Close all in the personal lane closes only its own done tab', async () => {
    const res = await post('/api/tabs/close-done', { profile: 'personal' });
    assert.equal(res.status, 200, res.body);
    const left = windowIds();
    assert.ok(!left.includes(env.sampleHtml.windowId));
    for (const kept of [env.liveTwism, env.untaggedTwism, env.renamedSession, env.legacyPersonal]) assert.ok(left.includes(kept.windowId));
  });
});

describe('adopting legacy tabs', () => {
  test('tags panes that started at spawn time, forgiving a renamed session, and nothing else', () => {
    const twism = tabs.adoptTaskTabs({ stateDir: env.profiles[0].stateDir, profile: 'twism', profiles: env.profiles });
    assert.deepEqual(twism.map((a) => a.id), ['olive-monitoring-alerts']);
    const personal = tabs.adoptTaskTabs({ stateDir: env.profiles[1].stateDir, profile: 'personal', profiles: env.profiles });
    assert.deepEqual(personal.map((a) => a.id), ['personal-file-serving']);
    assert.equal(paneOption(env.untaggedTwism.paneId, tabs.TASK_OPTION), '');
    assert.equal(paneOption(env.renamedSession.paneId, tabs.TASK_OPTION), 'olive-monitoring-alerts');
    assert.equal(paneOption(env.legacyPersonal.paneId, tabs.PROFILE_OPTION), 'personal');
  });

  test('an adopted tab can be peeked', async () => {
    const res = await peek('personal/personal-file-serving');
    assert.equal(res.status, 200, res.body);
    assert.equal(itemsByKey().get('olive-monitoring-alerts').win, env.renamedSession.windowId);
  });
});
