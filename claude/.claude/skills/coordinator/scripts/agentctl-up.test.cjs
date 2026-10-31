// `agentctl.sh up` against throwaway tmux servers ($TMUX names a socket in a temp dir), a temp HOME
// with stub `claude`/`codex`, and a dashboard on a free port: cold start, a second run, and a
// Twism coordinator that already lives in session `0`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const AGENTCTL = path.join(__dirname, 'agentctl.sh');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets = [];

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const answers = (port) =>
  new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => resolve(res.statusCode)).on('error', () => resolve(0));
  });

const waitFor = async (check, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(150);
  }
  return false;
};

const makeWorld = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-up-'));
  const home = path.join(root, 'home');
  const bin = path.join(home, '.local', 'bin');
  const fakes = path.join(root, 'fakes');
  for (const dir of [bin, fakes]) fs.mkdirSync(dir, { recursive: true });
  const sleepBin = execFileSync('bash', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();
  for (const name of ['claude', 'codex']) {
    fs.symlinkSync(sleepBin, path.join(fakes, name));
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nexec "${fakes}/${name}" 600\n`, { mode: 0o755 });
  }
  const twismRepo = path.join(root, 'twism-repo');
  const twismState = path.join(root, 'twism-state');
  const personalWork = path.join(root, 'personal');
  for (const dir of [twismRepo, twismState, personalWork]) fs.mkdirSync(dir, { recursive: true });
  const profiles = path.join(home, '.config', 'agentctl', 'profiles');
  fs.mkdirSync(profiles, { recursive: true });
  fs.writeFileSync(
    path.join(profiles, 'personal.env'),
    `COORDINATOR_STATE_DIR=${personalWork}/.claude/coordinator\nCOORDINATOR_DEFAULT_REPO=${personalWork}\nAGENTCTL_SESSION=personal\nAGENTCTL_HARNESS=codex\n`,
  );
  const socket = path.join(root, 'tmux.sock');
  sockets.push(socket);
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TMUX: `${socket},0,0`,
    COORDINATOR_STATE_DIR: twismState,
    COORDINATOR_DEFAULT_REPO: twismRepo,
    AGENTCTL_PRIMARY_STATE_DIR: twismState,
    COORDINATOR_DASHBOARD_PORT: String(port),
    COORDINATOR_DASHBOARD_TAILNET: 'off',
    COORDINATOR_DASHBOARD_FILE_ROOTS: 'off',
  };
  delete env.TMUX_PANE;
  delete env.AGENTCTL_PROFILE;
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env }).trim();
  const up = () => spawnSync('bash', [AGENTCTL, 'up', '--no-attach'], { encoding: 'utf8', env, timeout: 30000 });
  const coordinators = () =>
    tmux('list-panes', '-a', '-F', '#{session_name}|#{@agentctl-role}|#{@agentctl-profile}')
      .split('\n')
      .map((l) => l.split('|'))
      .filter(([, role]) => role === 'coordinator')
      .map(([session, , profile]) => `${profile || 'twism'}@${session}`)
      .sort();
  const windowCount = () => tmux('list-windows', '-a', '-F', '#{window_id}').split('\n').length;
  return { root, env, port, tmux, up, coordinators, windowCount, twismState };
};

after(() => {
  for (const socket of sockets) {
    try {
      execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {}
  }
});

describe('up from a cold start', () => {
  let world;

  test('creates both sessions, both coordinators and the dashboard', async () => {
    world = await makeWorld();
    const r = world.up();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(await waitFor(() => world.coordinators().length === 2), `coordinators: ${world.coordinators()}`);
    assert.deepEqual(world.coordinators(), ['personal@personal', 'twism@twism']);
    assert.ok(await waitFor(async () => (await answers(world.port)) === 401), 'the dashboard never answered');
    assert.equal(world.tmux('display-message', '-p', '-t', '=twism:dashboard', '#{session_name}'), 'twism');
    assert.match(world.tmux('show-environment', '-t', '=personal', 'AGENT_PROFILE'), /=personal$/);
    assert.match(world.tmux('show-environment', '-t', '=twism', 'AGENT_PROFILE'), /=twism$/);
    assert.match(r.stdout, /attach: tmux attach -t =twism/);
  });

  test('a second run changes nothing', async () => {
    const windows = world.windowCount();
    const r = world.up();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    await sleep(500);
    assert.equal(world.windowCount(), windows);
    assert.deepEqual(world.coordinators(), ['personal@personal', 'twism@twism']);
    assert.match(r.stdout, /twism: coordinator already running/);
    assert.match(r.stdout, /dashboard already serving/);
  });
});

describe('up with the Twism coordinator in session 0', () => {
  test('keeps session 0 as the Twism session and lists tabs to resume without resuming them', async () => {
    const world = await makeWorld();
    world.tmux('-f', '/dev/null', 'new-session', '-d', '-s', '0', '-n', 'coordinator', 'sleep 600');
    world.tmux('new-window', '-d', '-t', '0:', '-n', 'some-work', 'sleep 600');
    const taskDir = path.join(world.twismState, 'tasks', 'lost-tab');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({ id: 'lost-tab', name: 'lost-tab', windowId: '@99', paneId: '%99', session: '0', workdir: world.root, createdAt: '2026-10-30T10:00:00-03:00' }));
    const [recycledWindow, recycledPane] = world.tmux('display-message', '-p', '-t', '=0:some-work', '#{window_id} #{pane_id}').split(' ');
    const recycledDir = path.join(world.twismState, 'tasks', 'recycled-tab');
    fs.mkdirSync(recycledDir, { recursive: true });
    fs.writeFileSync(path.join(recycledDir, 'meta.json'), JSON.stringify({ id: 'recycled-tab', name: 'recycled-tab', windowId: recycledWindow, paneId: recycledPane, session: '0', workdir: world.root, createdAt: '2026-10-17T10:00:00-03:00' }));

    const r = world.up();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(await waitFor(() => world.coordinators().includes('personal@personal')));
    const sessions = world.tmux('list-sessions', '-F', '#{session_name}').split('\n').sort();
    assert.deepEqual(sessions, ['0', 'personal']);
    assert.equal(world.tmux('list-windows', '-t', '=0', '-F', '#{window_name}').split('\n').filter((n) => n === 'coordinator').length, 1);
    assert.ok(await waitFor(async () => (await answers(world.port)) === 401), 'the dashboard never answered');
    assert.equal(world.tmux('display-message', '-p', '-t', '=0:dashboard', '#{session_name}'), '0');
    assert.match(r.stdout, /twism: coordinator already running in session 0/);
    assert.match(r.stdout, /lost-tab: bash \S+agentctl\.sh resume lost-tab/);
    assert.match(r.stdout, /recycled-tab: bash \S+agentctl\.sh resume recycled-tab/);
    assert.match(r.stdout, /attach: tmux attach -t =0/);
    assert.ok(!world.tmux('list-sessions', '-F', '#{session_name}').includes('resume-lost-tab'));
  });
});
