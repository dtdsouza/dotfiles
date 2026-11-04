// `agentctl.sh dashboard --ensure` and the launcher hook, against a throwaway tmux server (a socket in
// a temp dir), a temp HOME with stub `claude`/`codex`, and a free port.
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
const listeners = [];

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-ensure-'));
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
  const ensure = () => spawnSync('bash', [AGENTCTL, 'dashboard', '--ensure'], { encoding: 'utf8', env, timeout: 30000 });
  const launch = (session, ...args) =>
    tmux('new-session', '-d', '-s', session, '-n', 'coordinator', '-c', root, `bash ${AGENTCTL} ${args.join(' ')} coordinator`);
  const windowNames = () => tmux('list-windows', '-a', '-F', '#{session_name}:#{window_name}').split('\n').sort();
  return { env, port, tmux, ensure, launch, windowNames };
};

after(() => {
  for (const socket of sockets) {
    try {
      execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {}
  }
  for (const server of listeners) server.close();
});

describe('dashboard --ensure', () => {
  test('starts a dashboard window when nothing serves, then is a no-op', async () => {
    const world = await makeWorld();
    world.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-n', 'coordinator', 'sleep 600');
    const first = world.ensure();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /dashboard: started in session twism/);
    assert.ok(await waitFor(async () => (await answers(world.port)) === 401), 'the dashboard never answered');
    const before = world.windowNames();
    assert.deepEqual(before, ['twism:coordinator', 'twism:dashboard']);

    const second = world.ensure();
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /dashboard already serving on 127\.0\.0\.1:/);
    await sleep(300);
    assert.deepEqual(world.windowNames(), before);
  });

  test('is a no-op while a server of any origin already listens on the port', async () => {
    const world = await makeWorld();
    world.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-n', 'coordinator', 'sleep 600');
    const server = net.createServer().listen(world.port, '127.0.0.1');
    listeners.push(server);
    await new Promise((resolve) => server.once('listening', resolve));

    const r = world.ensure();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /dashboard already serving/);
    assert.deepEqual(world.windowNames(), ['twism:coordinator']);
  });

  test('refuses --profile like the rest of the dashboard', async () => {
    const world = await makeWorld();
    const r = spawnSync('bash', [AGENTCTL, '--profile', 'personal', 'dashboard', '--ensure'], { encoding: 'utf8', env: world.env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /run it without --profile/);
  });
});

describe('the coordinator launcher', () => {
  test('the Twism launch starts the dashboard in its own session', async () => {
    const world = await makeWorld();
    world.launch('twism');
    assert.ok(await waitFor(async () => (await answers(world.port)) === 401), 'the dashboard never answered');
    assert.deepEqual(world.windowNames(), ['twism:coordinator', 'twism:dashboard']);
  });

  test('a personal launch starts no dashboard', async () => {
    const world = await makeWorld();
    world.launch('personal', '--profile', 'personal');
    assert.ok(await waitFor(() => world.tmux('list-panes', '-a', '-F', '#{@agentctl-role}') === 'coordinator'), 'the coordinator never marked its pane');
    await sleep(1000);
    assert.equal(await answers(world.port), 0);
    assert.deepEqual(world.windowNames(), ['personal:coordinator']);
  });
});
