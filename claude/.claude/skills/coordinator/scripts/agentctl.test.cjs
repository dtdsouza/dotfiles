// Drives agentctl.sh against a private tmux server ($TMUX points at it) with a throwaway HOME whose
// ~/.local/bin holds stub `claude` and `codex` binaries, so no real agent ever starts.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const AGENTCTL = path.join(__dirname, 'agentctl.sh');
const SOCKET = `agentctl-cli-test-${process.pid}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const readOr = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

let env;
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
const paneOption = (pane, option) => {
  try {
    return tmux('show-options', '-p', '-v', '-t', pane, option);
  } catch {
    return '';
  }
};

const agentctl = (args, extraEnv = {}) =>
  spawnSync('bash', [AGENTCTL, ...args], { encoding: 'utf8', env: { ...env.base, ...extraEnv }, timeout: 20000 });

const waitFor = async (check, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(100);
  }
  return false;
};

before(() => {
  const root = tmpDir('agentctl-cli-');
  const home = path.join(root, 'home');
  const bin = path.join(home, '.local', 'bin');
  const fakes = path.join(root, 'fakes');
  const out = path.join(root, 'out');
  const twismRoot = path.join(root, 'twism');
  const personalWork = path.join(root, 'personal-work');
  const twismState = path.join(root, 'twism-state');
  const personalState = path.join(personalWork, '.claude', 'coordinator');
  for (const dir of [bin, fakes, out]) fs.mkdirSync(dir, { recursive: true });
  const tee = execFileSync('bash', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim();
  for (const name of ['claude', 'codex']) {
    fs.symlinkSync(tee, path.join(fakes, name));
    // The stub records how it was started, draws an idle prompt, then becomes a process named like the harness.
    const prompt = name === 'codex' ? "printf '%s\\n' '› Ask Codex to do anything'" : "printf '%s\\n' '────────────────' '❯ ' '────────────────'";
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/bash\nf="${out}/${name}-$$"\nprintf '%s\\n' "$@" >"$f.args"; env >"$f.env"; pwd >"$f.pwd"\n${prompt}\nexec "${fakes}/${name}" -a "$f.typed" >/dev/null\n`,
      { mode: 0o755 },
    );
  }

  for (const dir of [twismRoot, path.join(personalWork, 'sandbox'), twismState]) fs.mkdirSync(dir, { recursive: true });
  const profiles = path.join(home, '.config', 'agentctl', 'profiles');
  fs.mkdirSync(profiles, { recursive: true });
  fs.writeFileSync(
    path.join(profiles, 'personal.env'),
    [
      'AGENTCTL_LABEL=Personal',
      `COORDINATOR_STATE_DIR=${personalState}`,
      `COORDINATOR_DEFAULT_REPO=${personalWork}`,
      'AGENTCTL_SESSION=personal',
      'AGENTCTL_HARNESS=codex',
      'AGENTCTL_MODEL=gpt-6-sol',
      'AGENTCTL_COORDINATOR_MODEL=gpt-6-sol',
      `AGENTCTL_DENY_ROOTS=${twismRoot}`,
      "AGENTCTL_KEEP_ENV='^(HOME|PATH|TERM|LANG|TMUX|TMUX_PANE|XDG_CONFIG_HOME|AGENT_PROFILE|AGENTCTL_[A-Z_]+|COORDINATOR_[A-Z_]+)$'",
      '',
    ].join('\n'),
  );

  // Panes inherit the server's env, so everything that keeps agentctl off the real ledgers lives here.
  const serverEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GITLAB_TOKEN: 'probe-token',
    UNLISTED_SETTING: 'not-on-the-allowlist',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTCTL_PRIMARY_STATE_DIR: twismState,
    AGENTCTL_REPORT_RETRIES: '0',
  };
  delete serverEnv.TMUX;
  delete serverEnv.TMUX_PANE;
  execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'twism', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600'], { env: serverEnv });
  tmux('new-session', '-d', '-s', 'personal', '-x', '200', '-y', '40', '-n', 'scratch', 'sleep 600');
  const socketPath = tmux('display-message', '-p', '#{socket_path}');
  const serverPid = tmux('display-message', '-p', '#{pid}');

  const base = {
    ...serverEnv,
    TMUX: `${socketPath},${serverPid},0`,
    COORDINATOR_STATE_DIR: twismState,
    COORDINATOR_DEFAULT_REPO: twismRoot,
  };
  delete base.AGENTCTL_PROFILE;
  delete base.ANTHROPIC_BASE_URL;
  delete base.CLAUDE_CONFIG_DIR;
  const brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, '# Goal\n\nProbe.\n');
  env = { root, home, out, base, brief, twismRoot, personalWork, personalState, twismState };
});

after(() => {
  try {
    tmux('kill-server');
  } catch {}
});

describe('spawn guards', () => {
  test('personal refuses a repo under a denied root', () => {
    const r = agentctl(['--profile', 'personal', 'spawn', '--name', 'leak', '--brief', env.brief, '--coordinator', 'c', '--cwd', env.twismRoot]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not allowed for profile personal/);
    assert.ok(!fs.existsSync(path.join(env.personalState, 'tasks', 'leak')));
  });

  test('personal refuses the claude harness', () => {
    const r = agentctl(['--profile', 'personal', 'spawn', '--name', 'x', '--harness', 'claude', '--brief', env.brief, '--coordinator', 'c', '--cwd', env.personalWork]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /harness claude is not allowed/);
  });

  test('twism refuses the codex harness', () => {
    const r = agentctl(['spawn', '--name', 'x', '--harness', 'codex', '--brief', env.brief, '--coordinator', 'c', '--cwd', env.twismRoot, '--session', 'twism']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /harness codex is not allowed/);
  });

  test('twism refuses to start Claude through a gateway', () => {
    const r = agentctl(['spawn', '--name', 'x', '--brief', env.brief, '--coordinator', 'c', '--cwd', env.twismRoot, '--session', 'twism'], { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ANTHROPIC_BASE_URL/);
  });

  test('an unknown profile is refused', () => {
    const r = agentctl(['--profile', 'nope', 'ls']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no profile 'nope'/);
  });

  test('the dashboard only runs on the primary profile', () => {
    const r = agentctl(['--profile', 'personal', 'dashboard', '--serve']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /without --profile/);
  });
});

describe('personal spawn', () => {
  test('starts a Codex worker in the personal session with Twism secrets scrubbed', async () => {
    const r = agentctl(['--profile', 'personal', 'spawn', '--name', 'sandbox-probe', '--effort', 'max', '--brief', env.brief, '--coordinator', 'c', '--cwd', path.join(env.personalWork, 'sandbox')]);
    assert.equal(r.status, 0, r.stderr);
    const meta = JSON.parse(fs.readFileSync(path.join(env.personalState, 'tasks', 'sandbox-probe', 'meta.json'), 'utf8'));
    assert.equal(meta.profile, 'personal');
    assert.equal(meta.harness, 'codex');
    assert.equal(meta.model, 'gpt-6-sol');
    assert.equal(meta.session, 'personal');
    const brief = fs.readFileSync(path.join(env.personalState, 'tasks', 'sandbox-probe', 'brief.md'), 'utf8');
    assert.match(brief, /--profile personal report sandbox-probe/);
    assert.match(brief, /on its own/);
    assert.doesNotMatch(brief, /SendMessage/);

    assert.ok(await waitFor(() => fs.readdirSync(env.out).some((f) => f.startsWith('codex-') && f.endsWith('.env'))), 'codex stub never started');
    const stub = fs.readdirSync(env.out).find((f) => f.startsWith('codex-') && f.endsWith('.args')).replace(/\.args$/, '');
    const args = readOr(path.join(env.out, `${stub}.args`)).trim().split('\n');
    assert.deepEqual(args.slice(0, 11), ['-C', path.join(env.personalWork, 'sandbox'), '-s', 'workspace-write', '-a', 'on-request', '--no-daemon', '--disable', 'shell_snapshot', '-m', 'gpt-6-sol']);
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
    const stubEnv = readOr(path.join(env.out, `${stub}.env`));
    assert.doesNotMatch(stubEnv, /^GITLAB_TOKEN=/m);
    assert.doesNotMatch(stubEnv, /^UNLISTED_SETTING=/m);
    assert.match(stubEnv, /^TMUX=/m);
    assert.match(stubEnv, /^AGENT_PROFILE=personal$/m);
    assert.match(stubEnv, /^AGENTCTL_PROFILE=personal$/m);
    assert.equal(tmux('display-message', '-p', '-t', meta.windowId, '#{session_name}'), 'personal');
  });
});

describe('coordinators', () => {
  test('a second profile coordinator leaves the primary coordinator marked and scrubs its session env', async () => {
    const primary = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'twism:', '-n', 'coordinator', 'sleep 600');
    tmux('set-option', '-p', '-t', primary, '@agentctl-role', 'coordinator');
    const pane = tmux(
      'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'personal:', '-n', 'scratch2',
      `bash ${AGENTCTL} --profile personal coordinator`,
    );
    assert.ok(await waitFor(() => paneOption(pane, '@agentctl-profile') === 'personal'), 'personal pane never marked');
    assert.equal(paneOption(primary, '@agentctl-role'), 'coordinator');
    assert.equal(paneOption(pane, '@agentctl-role'), 'coordinator');
    assert.equal(tmux('display-message', '-p', '-t', pane, '#{window_name}'), 'coordinator');
    // The pane is marked before the session env is scrubbed, so wait for the scrub to finish.
    assert.ok(await waitFor(() => /^-UNLISTED_SETTING$/m.test(tmux('show-environment', '-t', 'personal'))), 'session env never scrubbed');
    const sessionEnv = tmux('show-environment', '-t', 'personal');
    assert.match(sessionEnv, /^-GITLAB_TOKEN$/m);
    assert.match(sessionEnv, /^-UNLISTED_SETTING$/m);
    assert.doesNotMatch(sessionEnv, /^-TMUX$/m);
    assert.match(sessionEnv, /^AGENT_PROFILE=personal$/m);
    assert.ok(await waitFor(() => fs.readdirSync(env.out).filter((f) => f.startsWith('codex-') && f.endsWith('.args')).length >= 2));
    const args = fs
      .readdirSync(env.out)
      .filter((f) => f.startsWith('codex-') && f.endsWith('.args'))
      .map((f) => readOr(path.join(env.out, f)))
      .find((a) => a.includes('Coordinator ledger'));
    assert.ok(args, 'the coordinator prompt carries the ledger brief');
    assert.match(args, new RegExp(`^-C\\n${env.personalWork}\\n`));
  });

  test('report notes the ledger and types into the profile coordinator', async () => {
    const r = agentctl(['--profile', 'personal', 'report', 'sandbox-probe', 'done', 'PR #7 open'], { AGENTCTL_PROFILE: 'personal' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readOr(path.join(env.personalState, 'tasks', 'sandbox-probe', 'notes.md')), /\[done\] PR #7 open/);
    const typedFile = () =>
      fs
        .readdirSync(env.out)
        .filter((f) => f.startsWith('codex-') && f.endsWith('.typed'))
        .map((f) => readOr(path.join(env.out, f)))
        .find((t) => t.includes('PR #7 open'));
    assert.ok(await waitFor(typedFile), 'the coordinator never received the report');
    assert.match(typedFile(), /^\[via agentctl\] \[sandbox-probe\] done: PR #7 open$/m);
  });

  test('report from a sandbox that cannot reach tmux writes nothing and says to rerun it on its own', () => {
    const notes = path.join(env.personalState, 'tasks', 'sandbox-probe', 'notes.md');
    const before = readOr(notes);
    const r = agentctl(['--profile', 'personal', 'report', 'sandbox-probe', 'progress', 'halfway'], { TMUX: '/nonexistent/socket,1,0' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /run this report again as a command on its own/);
    assert.equal(readOr(notes), before);
  });

  test('report refuses an unknown kind', () => {
    const r = agentctl(['--profile', 'personal', 'report', 'sandbox-probe', 'finished', 'x']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /done\|blocked\|question\|progress/);
  });
});

describe('task tabs on a recycled window id', () => {
  const twismTask = (id) => path.join(env.twismState, 'tasks', id);
  const writeOld = (id, extra) => {
    fs.mkdirSync(twismTask(id), { recursive: true });
    fs.writeFileSync(
      path.join(twismTask(id), 'meta.json'),
      JSON.stringify({ id, name: `${id}-done`, model: 'sonnet', session: 'twism', workdir: env.twismRoot, createdAt: '2026-10-17T09:44:11-03:00', archivedAt: '2026-10-17T09:46:39-03:00', ...extra }),
    );
  };
  const readMeta = (id) => JSON.parse(fs.readFileSync(path.join(twismTask(id), 'meta.json'), 'utf8'));
  let live;

  before(() => {
    const r = agentctl(['spawn', '--name', 'live-probe', '--brief', env.brief, '--coordinator', 'c', '--cwd', env.twismRoot, '--session', 'twism']);
    assert.equal(r.status, 0, r.stderr);
    live = readMeta('live-probe');
    writeOld('old-other-pane', { windowId: live.windowId, paneId: '%951' });
    writeOld('old-same-ids', { windowId: live.windowId, paneId: live.paneId });
  });

  test('spawn tags the pane with its task and profile', () => {
    assert.equal(paneOption(live.paneId, '@agentctl-task'), 'live-probe');
    assert.equal(paneOption(live.paneId, '@agentctl-profile'), 'twism');
    const personal = JSON.parse(fs.readFileSync(path.join(env.personalState, 'tasks', 'sandbox-probe', 'meta.json'), 'utf8'));
    assert.equal(paneOption(personal.paneId, '@agentctl-task'), 'sandbox-probe');
    assert.equal(paneOption(personal.paneId, '@agentctl-profile'), 'personal');
  });

  test('ls shows the old entries as closed and the live task on its window', () => {
    const r = agentctl(['ls', '--all']);
    assert.equal(r.status, 0, r.stderr);
    const row = (id) => r.stdout.split('\n').find((l) => l.startsWith(`${id} `));
    assert.match(row('live-probe'), new RegExp(`^live-probe\\s+${live.windowId}\\s`));
    assert.match(row('old-other-pane'), /^old-other-pane\s+-\s+archived\s+old-other-pane-done\s/);
    assert.match(row('old-same-ids'), /^old-same-ids\s+-\s+archived\s+old-same-ids-done\s/);
  });

  test('rename by an old id refuses and leaves the live window alone', () => {
    const r = agentctl(['rename', 'old-same-ids', 'hijacked']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no open tab of its own/);
    assert.equal(tmux('display-message', '-p', '-t', live.windowId, '#{window_name}'), 'live-probe');
  });

  test('rename by window id records the name only on the task that owns the window', () => {
    const r = agentctl(['rename', live.windowId, 'live-probe-review']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readMeta('live-probe').name, 'live-probe-review');
    assert.equal(readMeta('old-other-pane').name, 'old-other-pane-done');
    assert.equal(readMeta('old-same-ids').name, 'old-same-ids-done');
  });

  test('done on an old id archives nothing new and renames no window', () => {
    const r = agentctl(['done', 'old-other-pane']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(tmux('display-message', '-p', '-t', live.windowId, '#{window_name}'), 'live-probe-review');
  });

  test('resume refuses a task whose own tab is still open, but not an old entry on its window id', () => {
    const r = agentctl(['resume', 'live-probe']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /still has its tab open/);
    const brief = agentctl(['brief']);
    assert.match(brief.stdout, /### live-probe\ntab `live-probe-review` \(@\d+\) \| (starting|running|setting-up)/);
  });

  test('adopt-tabs tags an untagged legacy tab that started at spawn time', () => {
    const pane = tmux('new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', 'twism:', '-n', 'legacy-probe', 'sleep 600').split(' ');
    fs.mkdirSync(twismTask('legacy-probe'), { recursive: true });
    fs.writeFileSync(
      path.join(twismTask('legacy-probe'), 'meta.json'),
      JSON.stringify({ id: 'legacy-probe', name: 'legacy-probe', model: 'sonnet', session: '0', workdir: env.twismRoot, createdAt: new Date().toISOString(), windowId: pane[0], paneId: pane[1] }),
    );
    const r = agentctl(['adopt-tabs']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`twism: tagged \\${pane[1]} \\(twism:${pane[0]}\\) as legacy-probe`));
    assert.doesNotMatch(r.stdout, /old-/);
    assert.equal(paneOption(pane[1], '@agentctl-task'), 'legacy-probe');
  });
});
