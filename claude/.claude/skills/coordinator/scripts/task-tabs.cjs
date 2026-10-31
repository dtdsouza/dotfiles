#!/usr/bin/env node
// Usage: task-tabs.cjs tabs <state-dir> <profile> <primary-state-dir> [profile-session]
//        task-tabs.cjs adopt <primary-state-dir> [--dry-run]
// Which live tmux pane is a ledger task's own tab. Window and pane ids restart from low numbers on
// every tmux server, so ids alone prove nothing: `spawn` tags the pane with its task and profile,
// and an untagged pane only counts when its ids, session and start time all fit the ledger entry.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmux, tmuxStrict } = require('./tmux.cjs');
const { PRIMARY_PROFILE, loadProfiles } = require('./profiles.cjs');

const ROLE_OPTION = '@agentctl-role';
const PROFILE_OPTION = '@agentctl-profile';
const TASK_OPTION = '@agentctl-task';
// `ps` derives start times from boot time and clock ticks, which can land a second before the
// ledger's createdAt; spawn writes the ledger entry right before it opens the window.
const START_SKEW_SECONDS = 5;
const SPAWN_GRACE_SECONDS = 60;
const ADOPT_HINT = 'run `agentctl.sh adopt-tabs` to enable its actions';

const readLedger = (stateDir) => {
  const tasksDir = path.join(stateDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  return fs.readdirSync(tasksDir).flatMap((id) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(tasksDir, id, 'meta.json'), 'utf8'))];
    } catch {
      return [];
    }
  });
};

const paneStartTimes = (pids) => {
  if (!pids.length) return new Map();
  try {
    const now = Math.floor(Date.now() / 1000);
    return new Map(
      execFileSync('ps', ['-o', 'pid=,etimes=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter(([pid, elapsed]) => pid && /^\d+$/.test(elapsed))
        .map(([pid, elapsed]) => [pid, now - Number(elapsed)]),
    );
  } catch {
    return new Map();
  }
};

// tmux replaces control characters such as \x1f with '_' in -F output, hence the printable '|' separator (name last).
const listPanes = () => {
  const panes = tmux([
    'list-panes',
    '-a',
    '-F',
    `#{pane_id}|#{window_id}|#{session_name}|#{pane_pid}|#{pane_current_command}|#{${ROLE_OPTION}}|#{${PROFILE_OPTION}}|#{${TASK_OPTION}}|#{window_activity}|#{window_name}`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'))
    .map(([id, windowId, session, pid, command, role, profile, task, activity, ...name]) => ({
      id,
      windowId,
      session,
      pid,
      command,
      role,
      profile,
      task,
      activity: Number(activity),
      windowName: name.join('|'),
    }));
  const started = paneStartTimes([...new Set(panes.map((p) => p.pid).filter(Boolean))]);
  return panes.map((p) => ({ ...p, startedAt: started.get(p.pid) }));
};

const sessionProfilesOf = (profiles) => new Map(profiles.filter((p) => p.session).map((p) => [p.session, p.name]));

const paneProfile = (pane, sessionProfiles) => pane.profile || sessionProfiles.get(pane.session) || PRIMARY_PROFILE;

const startedNear = (startedAt, createdAt) => {
  const created = Date.parse(createdAt) / 1000;
  if (!Number.isFinite(startedAt) || !Number.isFinite(created)) return false;
  return startedAt >= created - START_SKEW_SECONDS && startedAt <= created + SPAWN_GRACE_SECONDS;
};

// `list-panes -a` repeats a pane once per session of a group (`tmux new -t twism`).
const uniquePanes = (panes) => panes.filter((p, index) => panes.findIndex((other) => other.id === p.id) === index);

const isWorkerPane = (pane) => !pane.role;

const fitsLegacy = (pane, meta, { profile, sessionProfiles }) =>
  isWorkerPane(pane) &&
  !pane.task &&
  pane.id === meta.paneId &&
  pane.windowId === meta.windowId &&
  paneProfile(pane, sessionProfiles) === profile &&
  startedNear(pane.startedAt, meta.createdAt);

const taggedFor = (panes, meta, { profile, sessionProfiles }) =>
  panes.filter((p) => isWorkerPane(p) && p.task === meta.id && paneProfile(p, sessionProfiles) === profile);

const claimOf = (meta, panes, scope) => {
  const tagged = taggedFor(panes, meta, scope);
  if (tagged.length) return tagged.length === 1 ? { ...tagged[0], legacy: false } : null;
  const legacy = panes.filter((p) => fitsLegacy(p, meta, scope) && p.session === meta.session);
  return legacy.length === 1 ? { ...legacy[0], legacy: true } : null;
};

// Returns Map<task id, pane & { legacy }>; a pane two entries claim goes to neither.
const matchTaskTabs = (metas, panes, scope) => {
  const unique = uniquePanes(panes);
  const claims = metas.filter((m) => m.id).map((m) => [m.id, claimOf(m, unique, scope)]).filter(([, pane]) => pane);
  const claimants = (paneId) => claims.filter(([, pane]) => pane.id === paneId).length;
  return new Map(claims.filter(([, pane]) => claimants(pane.id) === 1));
};

const tagPane = (paneId, id, profile) =>
  tmuxStrict(['set-option', '-p', '-t', paneId, TASK_OPTION, id, ';', 'set-option', '-p', '-t', paneId, PROFILE_OPTION, profile]);

// The one-time backfill for tabs spawned before the tag existed. The start time pins the pane to
// its spawn, so a session renamed since (`0` -> `twism`) is forgiven here and nowhere else.
const adoptTaskTabs = ({ stateDir, profile, profiles, panes = listPanes(), dryRun = false }) => {
  const scope = { profile, sessionProfiles: sessionProfilesOf(profiles) };
  const unique = uniquePanes(panes);
  const metas = readLedger(stateDir).filter((m) => m.id && !taggedFor(unique, m, scope).length);
  const claims = metas.map((m) => [m, unique.filter((p) => fitsLegacy(p, m, scope))]).filter(([, found]) => found.length === 1);
  const claimants = (paneId) => claims.filter(([, [pane]]) => pane.id === paneId).length;
  return claims
    .filter(([, [pane]]) => claimants(pane.id) === 1)
    .map(([meta, [pane]]) => {
      if (!dryRun) tagPane(pane.id, meta.id, profile);
      return { id: meta.id, profile, paneId: pane.id, windowId: pane.windowId, session: pane.session };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

const profilesFor = (primaryStateDir, extra = null) => {
  const loaded = loadProfiles({ primaryStateDir });
  if (!extra) return loaded;
  return [...loaded.filter((p) => p.name !== extra.name), { ...(loaded.find((p) => p.name === extra.name) || {}), ...extra }];
};

const printTabs = ([stateDir, profile, primaryStateDir, session = '']) => {
  const profiles = profilesFor(primaryStateDir, { name: profile, stateDir, ...(session ? { session } : {}) });
  const found = matchTaskTabs(readLedger(stateDir), listPanes(), { profile, sessionProfiles: sessionProfilesOf(profiles) });
  for (const [id, pane] of found) console.log([id, pane.windowId, pane.id, pane.session, pane.legacy ? 1 : 0, pane.windowName].join('|'));
};

const printAdopted = ([primaryStateDir, flag]) => {
  const dryRun = flag === '--dry-run';
  const profiles = profilesFor(primaryStateDir);
  const panes = listPanes();
  const adopted = profiles.flatMap((p) => adoptTaskTabs({ stateDir: p.stateDir, profile: p.name, profiles, panes, dryRun }));
  for (const a of adopted) console.log(`${a.profile}: ${dryRun ? 'would tag' : 'tagged'} ${a.paneId} (${a.session}:${a.windowId}) as ${a.id}`);
  if (!adopted.length) console.log('no untagged task tab to adopt');
};

const main = () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'tabs' && args.length >= 3) return printTabs(args);
  if (command === 'adopt' && (args.length === 1 || (args.length === 2 && args[1] === '--dry-run'))) return printAdopted(args);
  console.error('usage: task-tabs.cjs tabs <state-dir> <profile> <primary-state-dir> [session] | adopt <primary-state-dir> [--dry-run]');
  process.exit(1);
};

module.exports = {
  ROLE_OPTION,
  PROFILE_OPTION,
  TASK_OPTION,
  ADOPT_HINT,
  readLedger,
  listPanes,
  sessionProfilesOf,
  paneProfile,
  startedNear,
  matchTaskTabs,
  adoptTaskTabs,
};

if (require.main === module) main();
