// tmux side of the served dashboard's actions: find the coordinator, type into it or into a worker,
// peek at a worker's pane, focus the coordinator, and close the tabs of finished tasks. Every check
// here fails closed.
const { tmux, tmuxStrict } = require('./tmux.cjs');
const { ROLE_OPTION, PROFILE_OPTION, TASK_OPTION, ADOPT_HINT, readLedger, listPanes, matchTaskTabs } = require('./task-tabs.cjs');

const COORDINATOR_ROLE = 'coordinator';
// A pane marked before profiles existed carries no profile option and belongs to the primary one.
const DEFAULT_PROFILE = 'twism';
const HARNESS_COMMANDS = ['claude', 'codex'];
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturePane = (paneId) => tmux(['capture-pane', '-p', '-t', paneId]).split('\n');

// The role option is set by `agentctl.sh coordinator`; the window name covers a coordinator that was
// restarted by hand (`claude --resume` carries no `-n coordinator` on its command line). A scope
// ({ name, session, excludeSessions }) keeps each profile to its own coordinator: an unmarked window
// only counts inside the profile's session, or outside every other profile's session.
// `list-panes -a` repeats a pane once per session of a group (`tmux new -t twism`), so count pane ids.
const inScopeSession = (pane, { session = '', excludeSessions = [] }) => (session ? pane.session === session : !excludeSessions.includes(pane.session));

const resolveCoordinator = (panes, scope = {}) => {
  const profile = scope.name || DEFAULT_PROFILE;
  const byRole = panes.filter((p) => p.role === COORDINATOR_ROLE && (p.profile || DEFAULT_PROFILE) === profile);
  const matches = byRole.length ? byRole : panes.filter((p) => p.windowName === 'coordinator' && !p.role && inScopeSession(p, scope));
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

// Claude Code's input box is a `❯` line right under a horizontal rule; Codex's composer is a `›`
// line. Both draw their dialogs (permissions, trust, updates) as `❯ 1. Yes` / `› 1. Update now`,
// and an Enter there would choose for the user, so any numbered choice refuses too.
const promptIsReady = (lines, harness = 'claude') => {
  const tail = lines.map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-PROMPT_SCAN_LINES);
  if (harness === 'codex') {
    const hasDialog = tail.some((l) => /›\s*\d+\.|Press enter to continue|Would you like to/.test(l));
    return !hasDialog && tail.some((l) => /^\s*›(\s|$)/.test(l));
  }
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

const typeIntoAgent = async (pane, text, label, prefix = MESSAGE_PREFIX) => {
  const message = prefix + text;
  if (!HARNESS_COMMANDS.includes(pane.command)) {
    throw new ActionError(`The ${label} pane is running ${pane.command || 'nothing'}, not Claude or Codex; nothing was sent.`);
  }
  if (!promptIsReady(capturePane(pane.id), pane.command)) {
    throw new ActionError(`The ${label} is showing a dialog, not its prompt; answer it in the terminal first.`);
  }
  typeLiteral(pane.id, message);
  await sleep(ENTER_DELAY_MS);
  tmuxStrict(['send-keys', '-t', pane.id, 'Enter']);
};

// Returns the sanitized text (without the prefix) so the caller can audit exactly what was typed.
const sendToCoordinator = async (text, scope = {}, prefix = MESSAGE_PREFIX) => {
  const clean = sanitizeMessage(text);
  await typeIntoAgent(resolveCoordinator(listPanes(), scope), clean, 'coordinator', prefix);
  return { message: 'Sent to the coordinator.', task: 'coordinator', text: clean };
};

const focusCoordinator = async (scope = {}) => {
  const pane = resolveCoordinator(listPanes(), scope);
  tmuxStrict(['select-window', '-t', pane.windowId]);
  tmuxStrict(['select-pane', '-t', pane.id]);
  return `Switched ${pane.session} to the coordinator tab.`;
};

const protectedWindowIds = (panes) => {
  const ids = panes
    .filter((p) => p.role === COORDINATOR_ROLE || PROTECTED_WINDOW_NAMES.includes(p.windowName) || p.id === process.env.TMUX_PANE)
    .map((p) => p.windowId);
  return new Set(ids);
};

// A task scope is { stateDir, profile, sessionProfiles }: the profile the request names, its ledger,
// and which tmux session belongs to which profile. The client names a task, never a pane; the pane
// must carry that task's tag and that profile, whatever ids the ledger recorded.
const ownTab = (meta, panes, scope) => {
  const pane = matchTaskTabs([meta], panes, scope).get(meta.id);
  if (!pane) return { refusal: null };
  if (pane.legacy) return { refusal: `has an untagged tab; ${ADOPT_HINT}` };
  return { pane };
};

const closeTarget = (meta, panes, guarded, scope) => {
  if (!meta) return { refusal: 'is not in the ledger' };
  if (!meta.archivedAt) return { refusal: 'is not done in the ledger' };
  if (!meta.windowId) return { refusal: 'has no tab on record' };
  if (guarded.has(meta.windowId)) return { refusal: 'has a protected tab (coordinator or dashboard)' };
  const { pane, refusal } = ownTab(meta, panes, scope);
  if (refusal) return { refusal };
  if (!pane) return { refusal: panes.some((p) => p.windowId === meta.windowId) ? 'no longer owns that tab' : 'has no open tab' };
  if (guarded.has(pane.windowId)) return { refusal: 'has a protected tab (coordinator or dashboard)' };
  return { pane };
};

const validTaskId = (id) => {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new ActionError('Invalid task id.');
  return id;
};

const findTaskPane = (meta, panes, guarded, scope) => {
  if (!meta) return { refusal: 'is not in the ledger' };
  if (!meta.paneId || !meta.windowId) return { refusal: 'has no pane on record' };
  if (guarded.has(meta.windowId)) return { refusal: 'has a protected tab (coordinator or dashboard)' };
  const { pane, refusal } = ownTab(meta, panes, scope);
  if (refusal) return { refusal };
  if (!pane) return { refusal: 'no longer owns a tab; it may be closed' };
  if (guarded.has(pane.windowId)) return { refusal: 'has a protected tab (coordinator or dashboard)' };
  return { pane };
};

const resolveTaskPane = (scope, id) => {
  validTaskId(id);
  const panes = listPanes();
  const { pane, refusal } = findTaskPane(readLedger(scope.stateDir).find((m) => m.id === id), panes, protectedWindowIds(panes), scope);
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

const peekTask = async (scope, id) => capturePeek(resolveTaskPane(scope, id));

const peekCoordinator = async (scope = {}) => capturePeek(resolveCoordinator(listPanes(), scope));

const replyToTask = async (scope, id, text) => {
  const clean = sanitizeMessage(text);
  await typeIntoAgent(resolveTaskPane(scope, id), clean, `${id} worker`);
  return { message: `Sent to ${id}.`, task: id, text: clean };
};

const replyableTaskIds = (scope, panes = listPanes()) => {
  const guarded = protectedWindowIds(panes);
  return new Set(readLedger(scope.stateDir).filter((m) => m.id && findTaskPane(m, panes, guarded, scope).pane).map((m) => m.id));
};

const closableTaskIds = (scope, panes = listPanes()) => {
  const guarded = protectedWindowIds(panes);
  return new Set(readLedger(scope.stateDir).filter((m) => m.id && closeTarget(m, panes, guarded, scope).pane).map((m) => m.id));
};

// The match is redone right before the kill, from a fresh pane list.
const closeTaskTab = async (scope, id) => {
  validTaskId(id);
  const panes = listPanes();
  const meta = readLedger(scope.stateDir).find((m) => m.id === id);
  const { pane, refusal } = closeTarget(meta, panes, protectedWindowIds(panes), scope);
  if (refusal) throw new ActionError(`Task ${id} ${refusal}; its tab was left open.`);
  tmuxStrict(['kill-window', '-t', pane.windowId]);
  return `Closed the tab of ${id}.`;
};

const closeAllDoneTabs = async (scope) => {
  const ids = [...closableTaskIds(scope)];
  if (!ids.length) throw new ActionError('No done task has an open tab.');
  const results = await Promise.allSettled(ids.map((id) => closeTaskTab(scope, id)));
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
  PROFILE_OPTION,
  TASK_OPTION,
  tmux,
  listPanes,
  readLedger,
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
