'use strict';

// Runs a loop's manifest argv (never client input) and reads its systemd units.
const os = require('os');
const { execFile } = require('child_process');

const SYSTEMCTL = '/usr/bin/systemctl';
const VERB_TIMEOUT_MS = 30000;
const OUTPUT_MAX_BYTES = 64 * 1024;
const ERROR_TEXT_MAX = 300;
// The adapters need no secret; the user-bus variables let them talk to systemctl --user.
const CHILD_ENV = ['HOME', 'PATH', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
const SHOW_PROPS = ['Id', 'ActiveState', 'SubState', 'UnitFileState', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'Result', 'ExecMainStatus', 'ExecMainExitTimestamp'];

const childEnv = (env = process.env) => Object.fromEntries(CHILD_ENV.filter((name) => env[name]).map((name) => [name, env[name]]));

const lastLine = (s) => String(s || '').trim().split('\n').pop().slice(0, ERROR_TEXT_MAX);

const exec = (argv, { stdin, timeoutMs = VERB_TIMEOUT_MS, execFileImpl = execFile } = {}) =>
  new Promise((resolve) => {
    const child = execFileImpl(argv[0], argv.slice(1), { env: childEnv(), cwd: os.homedir(), timeout: timeoutMs, maxBuffer: OUTPUT_MAX_BYTES }, (err, stdout, stderr) => {
      resolve({ code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? lastLine(stderr) || lastLine(err.message) : '' });
    });
    if (stdin !== undefined && child && child.stdin) child.stdin.end(stdin);
  });

const verbArgv = (loop, verb) => {
  const spec = loop.verbs[verb];
  if (!spec) return null;
  return spec.systemd ? [SYSTEMCTL, '--user', spec.systemd, '--no-block', spec.unit] : spec.argv;
};

const timerArgv = (loop, enable) => (loop.units.timer ? [SYSTEMCTL, '--user', enable ? 'enable' : 'disable', '--now', loop.units.timer] : null);

const parseShow = (stdout) =>
  Object.fromEntries(
    String(stdout)
      .split(/\n\s*\n/)
      .map((block) => Object.fromEntries(block.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)).filter(([k]) => k)))
      .filter((props) => props.Id)
      .map((props) => [props.Id, props]),
  );

const when = (value) => (value && value !== 'n/a' && value !== '0' ? value : '');

const systemdShow = async (units, { run = exec } = {}) => {
  const names = [units.timer, units.service].filter(Boolean);
  if (!names.length) return { timer: null, service: null };
  const result = await run([SYSTEMCTL, '--user', 'show', ...names, '-p', SHOW_PROPS.join(',')]);
  const byId = parseShow(result.stdout);
  const timer = units.timer && byId[units.timer];
  const service = units.service && byId[units.service];
  return {
    timer: timer ? { active: timer.ActiveState, enabled: timer.UnitFileState, next: when(timer.NextElapseUSecRealtime), last: when(timer.LastTriggerUSec) } : null,
    service: service ? { active: service.ActiveState, sub: service.SubState, result: service.Result, exitStatus: service.ExecMainStatus, exitedAt: when(service.ExecMainExitTimestamp) } : null,
  };
};

const createStatusCache = ({ ttlMs = 10000, now = Date.now } = {}) => {
  const entries = new Map();
  return {
    get: (key, load) => {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = Promise.resolve().then(load);
      entries.set(key, { at: now(), value });
      value.catch(() => entries.delete(key));
      return value;
    },
    drop: (key) => entries.delete(key),
  };
};

module.exports = { SYSTEMCTL, CHILD_ENV, childEnv, exec, verbArgv, timerArgv, parseShow, systemdShow, createStatusCache };
