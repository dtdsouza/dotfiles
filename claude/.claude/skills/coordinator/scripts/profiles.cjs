// Coordinator profiles: one ledger, tmux session and harness each. The primary profile is the
// state dir the dashboard was started on; every other one comes from a shell-style env file in
// $XDG_CONFIG_HOME/agentctl/profiles/<name>.env, the same file agentctl.sh sources.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRIMARY_PROFILE = 'twism';
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const unquote = (value) => {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"(.*)"$/) || trimmed.match(/^'(.*)'$/);
  return quoted ? quoted[1] : trimmed.replace(/\s+#.*$/, '');
};

const expandHome = (value, home) => value.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home);

const parseEnvFile = (text, home = os.homedir()) =>
  Object.fromEntries(
    String(text)
      .split('\n')
      .filter((line) => !/^\s*(#|$)/.test(line))
      .map((line) => line.match(ENV_LINE))
      .filter(Boolean)
      .map(([, key, value]) => [key, expandHome(unquote(value), home)]),
  );

const profilesDir = (env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentctl', 'profiles');

const readProfileFiles = (dir, home) => {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((file) => file.endsWith('.env'))
    .map((file) => file.slice(0, -'.env'.length))
    .filter((name) => PROFILE_NAME_PATTERN.test(name))
    .sort()
    .map((name) => ({ name, vars: parseEnvFile(fs.readFileSync(path.join(dir, `${name}.env`), 'utf8'), home) }));
};

const toProfile = (name, vars, stateDir) => ({
  name,
  label: vars.AGENTCTL_LABEL || (name === PRIMARY_PROFILE ? 'Twism' : name),
  stateDir,
  session: vars.AGENTCTL_SESSION || '',
  harness: vars.AGENTCTL_HARNESS || 'claude',
});

// A profile without COORDINATOR_STATE_DIR is skipped: the dashboard must never guess a ledger.
const loadProfiles = ({ primaryStateDir, env = process.env, home = os.homedir() }) => {
  const files = readProfileFiles(profilesDir(env), home);
  const primaryVars = (files.find((f) => f.name === PRIMARY_PROFILE) || { vars: {} }).vars;
  const others = files
    .filter((f) => f.name !== PRIMARY_PROFILE && f.vars.COORDINATOR_STATE_DIR)
    .map((f) => toProfile(f.name, f.vars, f.vars.COORDINATOR_STATE_DIR));
  return [toProfile(PRIMARY_PROFILE, primaryVars, primaryStateDir), ...others];
};

// Task ids never contain '/', so a key is unambiguous; primary keys stay bare for pages already open.
const taskKey = (profile, id) => (profile === PRIMARY_PROFILE ? id : `${profile}/${id}`);

const parseTaskKey = (key) => {
  const slash = String(key).indexOf('/');
  return slash === -1 ? { profile: PRIMARY_PROFILE, id: String(key) } : { profile: key.slice(0, slash), id: key.slice(slash + 1) };
};

module.exports = { PRIMARY_PROFILE, PROFILE_NAME_PATTERN, parseEnvFile, profilesDir, loadProfiles, taskKey, parseTaskKey };
