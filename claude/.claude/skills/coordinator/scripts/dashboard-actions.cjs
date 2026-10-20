// tmux side of the served dashboard's actions: find the coordinator, type into it, focus it, and
// close the tabs of finished tasks. Every check here fails closed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROLE_OPTION = '@agentctl-role';
const COORDINATOR_ROLE = 'coordinator';
const PROTECTED_WINDOW_NAMES = ['coordinator', 'dashboard'];
const MAX_MESSAGE_CHARS = 2000;
// Neutralises Claude Code's input prefixes (`!` shell mode, `/` commands) and tells the coordinator
// where the line came from.
const MESSAGE_PREFIX = '[via dashboard] ';
const ENTER_DELAY_MS = 150;
const PROMPT_SCAN_LINES = 15;

class ActionError extends Error {}

const tmuxArgs = (args) => (process.env.COORDINATOR_TMUX_SOCKET ? ['-L', process.env.COORDINATOR_TMUX_SOCKET, ...args] : args);
const tmuxStrict = (args) => execFileSync('tmux', tmuxArgs(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmux = (args) => {
  try {
    return tmuxStrict(args);
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// tmux replaces control characters such as \x1f with '_' in -F output, hence the printable '|' separator (name last).
const listPanes = () =>
  tmux(['list-panes', '-a', '-F', `#{pane_id}|#{window_id}|#{session_name}|#{pane_current_command}|#{${ROLE_OPTION}}|#{window_name}`])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'))
    .map(([id, windowId, session, command, role, ...name]) => ({ id, windowId, session, command, role, windowName: name.join('|') }));

const capturePane = (paneId) => tmux(['capture-pane', '-p', '-t', paneId]).split('\n');

// The role option is set by `agentctl.sh coordinator`; the window name covers a coordinator that was
// restarted by hand (`claude --resume` carries no `-n coordinator` on its command line).
// `list-panes -a` repeats a pane once per session of a group (`tmux new -t twism`), so count pane ids.
const resolveCoordinator = (panes) => {
  const byRole = panes.filter((p) => p.role === COORDINATOR_ROLE);
  const matches = byRole.length ? byRole : panes.filter((p) => p.windowName === 'coordinator');
  const candidates = matches.filter((p, index) => matches.findIndex((other) => other.id === p.id) === index);
  if (!candidates.length) throw new ActionError('No coordinator pane found: start it with `agentctl.sh coordinator`.');
  if (candidates.length > 1) {
    throw new ActionError(`Found ${candidates.length} coordinator panes (${candidates.map((p) => p.id).join(', ')}); close the extra ones first.`);
  }
  return candidates[0];
};

const sanitizeMessage = (text) => {
  if (typeof text !== 'string') throw new ActionError('The message must be text.');
  const clean = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!clean) throw new ActionError('The message is empty.');
  if (clean.length > MAX_MESSAGE_CHARS) throw new ActionError(`The message is longer than ${MAX_MESSAGE_CHARS} characters.`);
  return clean;
};

// Claude Code's input box is a `❯` line right under a horizontal rule. A permission dialog also
// draws `❯ 1. Yes`, and an Enter there would approve it, so any numbered choice refuses too.
const promptIsReady = (lines) => {
  const tail = lines.map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-PROMPT_SCAN_LINES);
  const isRule = (l) => /^\s*─{8,}/.test(l);
  const hasInputBox = tail.some((l, i) => i > 0 && isRule(tail[i - 1]) && /^\s*❯/.test(l));
  const hasDialog = tail.some((l) => /❯\s*\d+\.|Do you want to/.test(l));
  return hasInputBox && !hasDialog;
};

// A trailing `;` in a tmux argument is a command separator, so those go as hex key codes.
const typeLiteral = (paneId, text) => {
  const trailing = text.length - text.replace(/;+$/, '').length;
  const head = text.slice(0, text.length - trailing);
  if (head) tmuxStrict(['send-keys', '-t', paneId, '-l', '--', head]);
  if (trailing) tmuxStrict(['send-keys', '-t', paneId, '-H', ...Array(trailing).fill('3b')]);
};

const sendToCoordinator = async (text) => {
  const message = MESSAGE_PREFIX + sanitizeMessage(text);
  const pane = resolveCoordinator(listPanes());
  if (pane.command !== 'claude') throw new ActionError(`The coordinator pane is running ${pane.command || 'nothing'}, not Claude; nothing was sent.`);
  if (!promptIsReady(capturePane(pane.id))) {
    throw new ActionError('The coordinator is showing a dialog, not its prompt; answer it in the terminal first.');
  }
  typeLiteral(pane.id, message);
  await sleep(ENTER_DELAY_MS);
  tmuxStrict(['send-keys', '-t', pane.id, 'Enter']);
  return 'Sent to the coordinator.';
};

const focusCoordinator = async () => {
  const pane = resolveCoordinator(listPanes());
  tmuxStrict(['select-window', '-t', pane.windowId]);
  tmuxStrict(['select-pane', '-t', pane.id]);
  return `Switched ${pane.session} to the coordinator tab.`;
};

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

const protectedWindowIds = (panes) => {
  const ids = panes
    .filter((p) => p.role === COORDINATOR_ROLE || PROTECTED_WINDOW_NAMES.includes(p.windowName) || p.id === process.env.TMUX_PANE)
    .map((p) => p.windowId);
  return new Set(ids);
};

// Window ids restart at @0 with the tmux server, so the window must still hold the task's own pane
// in the task's session before it counts as that task's tab.
const closeRefusal = (meta, panes, guarded) => {
  if (!meta) return 'is not in the ledger';
  if (!meta.archivedAt) return 'is not done in the ledger';
  if (!meta.windowId) return 'has no tab on record';
  if (guarded.has(meta.windowId)) return 'has a protected tab (coordinator or dashboard)';
  const windowPanes = panes.filter((p) => p.windowId === meta.windowId);
  if (!windowPanes.length) return 'has no open tab';
  if (!windowPanes.some((p) => p.id === meta.paneId && p.session === meta.session)) return 'no longer owns that tab';
  return '';
};

const closableTaskIds = (stateDir, panes = listPanes()) => {
  const guarded = protectedWindowIds(panes);
  return new Set(readLedger(stateDir).filter((m) => m.id && !closeRefusal(m, panes, guarded)).map((m) => m.id));
};

const closeTaskTab = async (stateDir, id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new ActionError('Invalid task id.');
  const panes = listPanes();
  const meta = readLedger(stateDir).find((m) => m.id === id);
  const refusal = closeRefusal(meta, panes, protectedWindowIds(panes));
  if (refusal) throw new ActionError(`Task ${id} ${refusal}; its tab was left open.`);
  tmuxStrict(['kill-window', '-t', meta.windowId]);
  return `Closed the tab of ${id}.`;
};

const closeAllDoneTabs = async (stateDir) => {
  const ids = [...closableTaskIds(stateDir)];
  if (!ids.length) throw new ActionError('No done task has an open tab.');
  const results = await Promise.allSettled(ids.map((id) => closeTaskTab(stateDir, id)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  const closed = ids.length - failed;
  if (failed) throw new ActionError(`Closed ${closed} tab(s); ${failed} could not be closed.`);
  return `Closed ${closed} done tab(s).`;
};

module.exports = {
  ActionError,
  MAX_MESSAGE_CHARS,
  MESSAGE_PREFIX,
  ROLE_OPTION,
  tmux,
  listPanes,
  resolveCoordinator,
  sanitizeMessage,
  promptIsReady,
  sendToCoordinator,
  focusCoordinator,
  closableTaskIds,
  closeTaskTab,
  closeAllDoneTabs,
};
