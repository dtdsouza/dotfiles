const { test, describe, before, after, beforeEach } = require('node:test');
process.env.COORDINATOR_TMUX_SOCKET = `loops-api-test-none-${process.pid}`;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { COOKIE, appendAudit, createDashboardServer } = require('./dashboard-server.cjs');
const { parseManifest } = require('./loops-registry.cjs');
const { createLoopsApi } = require('./loops-api.cjs');
const { SYSTEMCTL } = require('./loops-runner.cjs');

const KEY = 'k'.repeat(43);
const TAILNET_HOST = 'pc.tail1234.ts.net';
const OWNER = 'owner@example.com';
const HASH = 'a'.repeat(64);
const DRAFT_ID = 'C03HWJV44CE-1791397356.866549';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-api-home-'));
const auditFile = path.join(home, 'audit.jsonl');
const settingsFile = path.join(home, '.config/triage/config.json');
const draftsDir = path.join(home, '.local/share/triage/drafts');
const script = '~/.claude/skills/triage/scripts/loop.mjs';

const manifest = parseManifest(
  {
    id: 'triage',
    name: 'CX/bug triage',
    units: { timer: 'triage-poll.timer', service: 'triage-poll.service' },
    verbs: { status: ['node', script, 'status', '--json'], pause: ['node', script, 'pause'], resume: ['node', script, 'resume'], 'run-once': 'systemd:start-service', kill: ['node', script, 'kill'] },
    phone: ['pause', 'resume', 'kill'],
    settings: {
      file: '~/.config/triage/config.json',
      keys: [
        { key: 'autonomyMode', label: 'Autonomy', type: 'enum', values: ['auto', 'guarded'], badge: true },
        { key: 'casesPerPass', label: 'Cases per pass', type: 'integer', min: 1, max: 10, phone: false },
      ],
    },
    decisions: { kind: 'drafts', dir: '~/.local/share/triage/drafts', decide: ['node', '~/.claude/skills/triage/scripts/decide.mjs', 'answer'] },
  },
  'triage',
  home,
);

let calls;
let status;
const fakeExec = async (argv, options = {}) => {
  calls.push({ argv, stdin: options.stdin });
  if (argv[0] === SYSTEMCTL && argv[2] === 'show') return { code: 0, stdout: 'Id=triage-poll.timer\nActiveState=active\nNextElapseUSecRealtime=Tue 2026-11-17 16:20:00 -03\n\nId=triage-poll.service\nActiveState=inactive\nResult=success\n', stderr: '', error: '' };
  if (argv.includes('status')) return { code: 0, stdout: JSON.stringify(status), stderr: '', error: '' };
  return { code: 0, stdout: 'ok\n', stderr: '', error: '' };
};

let env;
const request = ({ method = 'GET', urlPath, headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: env.port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const local = (extra = {}) => ({ Host: `127.0.0.1:${env.port}`, Origin: `http://127.0.0.1:${env.port}`, 'Content-Type': 'application/json', Cookie: `${COOKIE}=${KEY}`, 'X-Dashboard-Token': env.csrf, ...extra });
const phone = (extra = {}) => ({ Host: TAILNET_HOST, Origin: `https://${TAILNET_HOST}`, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': OWNER, 'Content-Type': 'application/json', Cookie: `${COOKIE}=${KEY}`, 'X-Dashboard-Token': env.csrf, ...extra });
const post = (urlPath, payload, headers = local()) => request({ method: 'POST', urlPath, headers, body: JSON.stringify(payload) });
const get = (urlPath, headers = local()) => request({ urlPath, headers });
const audits = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

const writeDraft = (fields = {}) => {
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.writeFileSync(path.join(draftsDir, `${DRAFT_ID}.json`), JSON.stringify({ id: DRAFT_ID, hash: HASH, status: 'pending', createdAt: '2026-11-17T15:50:00Z', channel: { id: 'C03HWJV44CE', name: '#cx-support' }, kind: 'data-request', title: 'Activate a business in QA', summary: 'asks to activate', reply: 'Done.\n\nbanner', jira: { action: 'none' }, ...fields }));
};

const startServer = (extra = {}) => {
  const loops = createLoopsApi({ loops: [manifest], auditFile, appendAudit, exec: fakeExec, cacheTtlMs: 0, ...extra });
  const server = createDashboardServer({ stateDir: home, key: KEY, tailnet: { host: TAILNET_HOST, logins: [OWNER] }, auditFile, loops });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
};

before(async () => {
  const server = await startServer();
  env = { server, port: server.address().port };
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: env.port, path: '/', headers: { Host: `127.0.0.1:${env.port}`, Cookie: `${COOKIE}=${KEY}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  env.csrf = page.match(/const CSRF = "([^"]+)"/)[1];
  env.page = page;
});
after(() => env.server.close());
beforeEach(() => {
  calls = [];
  status = { state: 'running', summary: 'quiet', mode: 'auto', caps: [{ name: 'passes today', used: 1, limit: 12 }], cost: { today_usd: 0.2, week_usd: 1, week_limit_usd: 15, basis: 'measured' }, settings: { autonomyMode: 'auto', casesPerPass: 3, slackToken: 'xoxb-leak' } };
  fs.rmSync(auditFile, { force: true });
  fs.rmSync(draftsDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
});

const actionArgv = () => calls.filter((c) => !(c.argv[0] === SYSTEMCTL && c.argv[2] === 'show') && !c.argv.includes('status')).map((c) => c.argv);

describe('reads', () => {
  test('need the cookie and the CSRF header', async () => {
    assert.equal((await get('/api/loops', local({ Cookie: '' }))).status, 401);
    assert.equal((await get('/api/loops', local({ 'X-Dashboard-Token': 'nope' }))).status, 403);
    assert.equal((await get('/api/loops', local({ Origin: 'null' }))).status, 403);
  });

  test('status carries only declared settings and the units', async () => {
    const res = await get('/api/loops/status?loop=triage');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.deepEqual(body.adapter.status.settings, { autonomyMode: 'auto', casesPerPass: 3 });
    assert.equal(body.units.timer.next, 'Tue 2026-11-17 16:20:00 -03');
    assert.equal(body.dot, 'running');
    assert.equal(body.loop.settings.file, settingsFile.replace(os.homedir(), '~'));
    assert.ok(!JSON.stringify(body).includes('xoxb'));
  });

  test('an unknown loop is refused', async () => {
    assert.equal((await get('/api/loops/status?loop=../etc')).status, 409);
    assert.equal((await get('/api/loops/status?loop=nope')).status, 409);
  });

  test('the page lists the loop in the rail and waiting drafts as cards', async () => {
    assert.match(env.page, /data-loop-link="triage"/);
  });
});

describe('actions', () => {
  test('pause runs the manifest argv and ignores extra fields', async () => {
    const res = await post('/api/loops/action', { loop: 'triage', verb: 'pause', args: ['--evil'], argv: ['rm'] });
    assert.equal(res.status, 200);
    assert.deepEqual(actionArgv(), [[process.execPath, path.join(home, '.claude/skills/triage/scripts/loop.mjs'), 'pause']]);
    assert.deepEqual(audits().map((a) => [a.kind, a.loop, a.verb, a.source, a.exit]), [['loop', 'triage', 'pause', 'local', 0]]);
  });

  test('unknown verbs and loops are refused before anything runs', async () => {
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'status' })).status, 409);
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'rm' })).status, 409);
    assert.equal((await post('/api/loops/action', { loop: 'other', verb: 'pause' })).status, 409);
    assert.deepEqual(actionArgv(), []);
  });

  test('phone cannot run local-only verbs or verbs the manifest keeps off the phone', async () => {
    assert.match((await post('/api/loops/action', { loop: 'triage', verb: 'disable-timer' }, phone())).json().error, /local only/);
    assert.match((await post('/api/loops/action', { loop: 'triage', verb: 'run-once' }, phone())).json().error, /not offered on the phone/);
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'kill' }, phone())).status, 200);
    assert.equal(audits()[0].source, `tailnet:${OWNER}`);
  });

  test('disable-timer runs systemctl on the manifest timer from the PC', async () => {
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'disable-timer' })).status, 200);
    assert.deepEqual(actionArgv(), [[SYSTEMCTL, '--user', 'disable', '--now', 'triage-poll.timer']]);
  });

  test('resume is refused at the weekly budget', async () => {
    status.cost.week_usd = 15;
    assert.match((await post('/api/loops/action', { loop: 'triage', verb: 'resume' })).json().error, /weekly budget/);
    assert.deepEqual(actionArgv(), []);
  });

  test('run-once runs the service once per 10 minutes', async () => {
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'run-once' })).status, 200);
    assert.deepEqual(actionArgv(), [[SYSTEMCTL, '--user', 'start', '--no-block', 'triage-poll.service']]);
    assert.match((await post('/api/loops/action', { loop: 'triage', verb: 'run-once' })).json().error, /less than 10 minutes/);
  });
});

describe('settings', () => {
  test('writes a declared key, audits from and to', async () => {
    const res = await post('/api/loops/config', { loop: 'triage', key: 'autonomyMode', value: 'guarded' });
    assert.equal(res.status, 200, JSON.stringify(res.json()));
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { autonomyMode: 'guarded' });
    assert.deepEqual(audits().map((a) => [a.verb, a.key, a.from, a.to]), [['config', 'autonomyMode', null, 'guarded']]);
  });

  test('refuses undeclared keys and out-of-schema values', async () => {
    assert.match((await post('/api/loops/config', { loop: 'triage', key: 'slackToken', value: 'x' })).json().error, /cannot be edited/);
    assert.match((await post('/api/loops/config', { loop: 'triage', key: 'casesPerPass', value: 99 })).json().error, /between 1 and 10/);
    assert.equal(fs.existsSync(settingsFile), false);
  });

  test('a key marked phone: false is PC only; the autonomy switch works from the phone', async () => {
    assert.match((await post('/api/loops/config', { loop: 'triage', key: 'casesPerPass', value: 2 }, phone())).json().error, /only be changed on the PC/);
    assert.equal((await post('/api/loops/config', { loop: 'triage', key: 'autonomyMode', value: 'guarded' }, phone())).status, 200);
  });
});

describe('drafts', () => {
  test('a draft opens by id and refuses a stale hash', async () => {
    writeDraft();
    const res = await get(`/api/loops/draft?loop=triage&id=${DRAFT_ID}`);
    assert.equal(res.json().draft.title, 'Activate a business in QA');
    assert.match((await post('/api/loops/decide', { loop: 'triage', id: DRAFT_ID, hash: 'b'.repeat(64), answer: 'yes' })).json().error, /changed/);
    assert.deepEqual(actionArgv(), []);
  });

  test('approve runs decide with the id and hash; an edit goes in on stdin', async () => {
    writeDraft();
    assert.equal((await post('/api/loops/decide', { loop: 'triage', id: DRAFT_ID, hash: HASH, answer: 'yes' })).status, 200);
    assert.equal((await post('/api/loops/decide', { loop: 'triage', id: DRAFT_ID, hash: HASH, answer: 'yes', text: 'Edited reply' })).status, 200);
    const decide = calls.filter((c) => c.argv[1].endsWith('decide.mjs'));
    assert.deepEqual(decide.map((c) => c.argv.slice(2)), [['answer', DRAFT_ID, HASH, 'yes'], ['answer', DRAFT_ID, HASH, 'yes', '--text-stdin']]);
    assert.equal(decide[1].stdin, 'Edited reply');
    assert.deepEqual(audits().map((a) => a.verb), ['approve', 'approve-edited']);
  });

  test('a draft that is no longer waiting is refused', async () => {
    writeDraft({ status: 'sent' });
    assert.match((await post('/api/loops/decide', { loop: 'triage', id: DRAFT_ID, hash: HASH, answer: 'no' })).json().error, /no longer waiting/);
  });
});

describe('rate limit', () => {
  test('pause still works after the action budget is spent', async () => {
    for (let i = 0; i < 31; i += 1) await post('/api/loops/action', { loop: 'nope', verb: 'resume' });
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'resume' })).status, 429);
    assert.equal((await post('/api/loops/action', { loop: 'triage', verb: 'pause' })).status, 200);
  });
});

describe('rail dot', () => {
  const { dotOf } = require('./loops-api.cjs');
  const ok = (extra = {}) => ({ ok: true, status: { state: 'running', last_outcome: 'error', pending: 0, ...extra } });
  test('an event error alone keeps the dot green; a failed tick turns it red', () => {
    assert.equal(dotOf(ok(), { timer: { active: 'active' }, service: { result: 'success' } }), 'running');
    assert.equal(dotOf(ok(), { timer: { active: 'active' }, service: { result: 'exit-code' } }), 'error');
    assert.equal(dotOf(ok(), { timer: { active: 'inactive' }, service: null }), 'off');
    assert.equal(dotOf(ok({ state: 'paused' }), { timer: { active: 'active' }, service: null }), 'paused');
    assert.equal(dotOf({ ok: false, error: 'x' }, { timer: null, service: null }), 'error');
  });
});
