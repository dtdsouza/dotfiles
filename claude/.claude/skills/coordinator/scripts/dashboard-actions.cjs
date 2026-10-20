// tmux side of the served dashboard's actions: find the coordinator, type into it or into a worker,
// peek at a worker's pane, focus the coordinator, and close the tabs of finished tasks. Every check
// here fails closed.
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
const PEEK_LINES = 60;
const PEEK_SCROLLBACK_LINES = 200;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

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

const typeIntoClaude = async (pane, text, label) => {
  const message = MESSAGE_PREFIX + text;
  if (pane.command !== 'claude') throw new ActionError(`The ${label} pane is running ${pane.command || 'nothing'}, not Claude; nothing was sent.`);
  if (!promptIsReady(capturePane(pane.id))) {
    throw new ActionError(`The ${label} is showing a dialog, not its prompt; answer it in the terminal first.`);
  }
  typeLiteral(pane.id, message);
  await sleep(ENTER_DELAY_MS);
  tmuxStrict(['send-keys', '-t', pane.id, 'Enter']);
};

// Returns the sanitized text (without the prefix) so the caller can audit exactly what was typed.
const sendToCoordinator = async (text) => {
  const clean = sanitizeMessage(text);
  await typeIntoClaude(resolveCoordinator(listPanes()), clean, 'coordinator');
  return { message: 'Sent to the coordinator.', task: 'coordinator', text: clean };
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

const validTaskId = (id) => {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new ActionError('Invalid task id.');
  return id;
};

// The client names a task, never a pane: the pane comes from the ledger and must still be that
// task's own pane, in its own window and session.
const findTaskPane = (meta, panes, guarded) => {
  if (!meta) return { refusal: 'is not in the ledger' };
  if (!meta.paneId || !meta.windowId) return { refusal: 'has no pane on record' };
  if (guarded.has(meta.windowId)) return { refusal: 'has a protected tab (coordinator or dashboard)' };
  const pane = panes.find((p) => p.id === meta.paneId && p.windowId === meta.windowId && p.session === meta.session);
  return pane ? { pane } : { refusal: 'no longer owns a tab; it may be closed' };
};

const resolveTaskPane = (stateDir, id) => {
  validTaskId(id);
  const panes = listPanes();
  const { pane, refusal } = findTaskPane(readLedger(stateDir).find((m) => m.id === id), panes, protectedWindowIds(panes));
  if (refusal) throw new ActionError(`Task ${id} ${refusal}.`);
  return pane;
};

const stripTerminalCodes = (line) =>
  line
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

const capturePeek = (pane) => {
  const lines = tmux(['capture-pane', '-p', '-J', '-S', `-${PEEK_SCROLLBACK_LINES}`, '-t', pane.id])
    .split('\n')
    .map((l) => stripTerminalCodes(l).replace(/\s+$/, ''))
    .filter((l) => !/^[─━\s]+$/.test(l) || l === '')
    .map((l) => l.replace(/[─━]{3,}/g, '──'));
  const trailingBlank = [...lines].reverse().findIndex((l) => l !== '');
  const kept = trailingBlank === -1 ? [] : lines.slice(0, lines.length - trailingBlank);
  return { lines: kept.slice(-PEEK_LINES), command: pane.command };
};

const peekTask = async (stateDir, id) => capturePeek(resolveTaskPane(stateDir, id));

const peekCoordinator = async () => capturePeek(resolveCoordinator(listPanes()));

const replyToTask = async (stateDir, id, text) => {
  const clean = sanitizeMessage(text);
  await typeIntoClaude(resolveTaskPane(stateDir, id), clean, `${id} worker`);
  return { message: `Sent to ${id}.`, task: id, text: clean };
};

const replyableTaskIds = (stateDir, panes = listPanes()) => {
  const guarded = protectedWindowIds(panes);
  return new Set(readLedger(stateDir).filter((m) => m.id && findTaskPane(m, panes, guarded).pane).map((m) => m.id));
};

const closableTaskIds = (stateDir, panes = listPanes()) => {
  const guarded = protectedWindowIds(panes);
  return new Set(readLedger(stateDir).filter((m) => m.id && !closeRefusal(m, panes, guarded)).map((m) => m.id));
};

const closeTaskTab = async (stateDir, id) => {
  validTaskId(id);
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
  PEEK_LINES,
  ROLE_OPTION,
  tmux,
  listPanes,
  resolveCoordinator,
  sanitizeMessage,
  promptIsReady,
  sendToCoordinator,
  peekTask,
  peekCoordinator,
  replyToTask,
  replyableTaskIds,
  focusCoordinator,
  closableTaskIds,
  closeTaskTab,
  closeAllDoneTabs,
};
