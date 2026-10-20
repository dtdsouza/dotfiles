// Markup, styles and client script for the action controls; only the served page gets them.
const SERVED_RELOAD_SECONDS = 60;
const CONFIRM_MS = 4000;
const TOAST_MS = 3500;
const PEEK_POLL_MS = 3000;
const TAP_TARGET_PX = 44;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const actionsCss = `.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msg{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 3px 3px 14px;background:var(--surface)}
.msg:focus-within{border-color:var(--green-30)}
.msg input{width:260px;min-width:0;border:0;outline:0;background:transparent;color:var(--fg);font:13px var(--body)}
.msg input::placeholder{color:var(--muted)}
.msg .btn{padding:5px 14px}
.btn.quiet{border-color:var(--line)}.btn.quiet:hover{border-color:var(--edge);box-shadow:none}
.btn[disabled],.mini[disabled]{opacity:.5;cursor:wait}
.mini.kill:hover{color:var(--red);border-color:var(--red-45)}
.mini.armed{color:var(--red);border-color:var(--red);background:var(--stripe)}
.foot .acts{display:flex;gap:6px}
.readonly{font-size:12px;color:var(--muted);text-decoration:none;border-bottom:1px dotted var(--edge)}
.readonly:hover{color:var(--fg)}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;pointer-events:none;max-width:min(560px,calc(100vw - 32px));border:1.5px solid var(--green-30);border-radius:999px;background:var(--surface);color:var(--fg);padding:9px 18px;font:500 13px var(--body);box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .2s,transform .2s;z-index:10}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.err{border-color:var(--red)}
.reply{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 3px 3px 12px;background:var(--surface);margin:0 0 12px;cursor:auto}
.reply:focus-within{border-color:var(--green-30)}
.reply input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--fg);font:13px var(--body)}
.reply input::placeholder{color:var(--muted)}
.reply .btn{padding:4px 12px}
.drawer .reply{margin:10px 0 0}
.peek pre{max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
.peek .hint{display:flex;justify-content:space-between;gap:8px}
.peek .hint.err{color:var(--red)}
.remote .desktop-only{display:none!important}
@media (max-width:640px){.topbar .right{flex-wrap:wrap;gap:10px;width:100%}.topbar .meta{flex:1;min-width:0}.actions{width:100%}.msg{flex:1 1 100%;min-width:0}.msg input{width:auto;flex:1}}
@media (max-width:640px),(pointer:coarse){.btn,.mini,.chip,.x{min-height:${TAP_TARGET_PX}px;min-width:${TAP_TARGET_PX}px;justify-content:center}
.mini,.chip{display:inline-flex;align-items:center;padding:0 14px;font-size:13px}.x{width:${TAP_TARGET_PX}px;height:${TAP_TARGET_PX}px}
.msg,.reply{min-height:${TAP_TARGET_PX + 6}px}.msg input,.reply input,.custom input{font-size:16px;min-height:${TAP_TARGET_PX}px}.msg .btn,.reply .btn{padding:0 16px}
.foot{flex-wrap:wrap}.foot .acts{flex-wrap:wrap}}`;

const headerActionsHtml = `<div class="actions"><form class="msg" autocomplete="off"><input name="text" maxlength="2000" placeholder="Message coordinator" aria-label="Message coordinator" enterkeyhint="send"><button class="btn" type="submit">Send</button></form><button class="btn quiet" data-act="coordinator" type="button">Coordinator</button><button class="btn quiet desktop-only" data-act="focus" type="button">Go to coordinator</button></div>`;

const replyFormHtml = (id) =>
  `<form class="reply" data-reply="${esc(id)}" autocomplete="off"><input name="text" maxlength="2000" placeholder="Reply to this worker" aria-label="Reply to ${esc(id)}" enterkeyhint="send"><button class="btn" type="submit">Send</button></form>`;

const peekButtonHtml = (id) => `<button class="mini" data-peek="${esc(id)}" type="button">Peek</button>`;

const readOnlyHintHtml = (liveUrl) =>
  `<a class="readonly" href="${esc(liveUrl)}" title="This file is read-only. Actions need agentctl.sh dashboard --serve and its URL.">read-only · open live page</a>`;

const closeButtonHtml = (id) => `<button class="mini kill" data-close="${esc(id)}" type="button">Close tab</button>`;

const closeAllButtonHtml = (count) => (count > 1 ? `<button class="mini kill" data-close-all type="button">Close all ${count}</button>` : '');

// The drawer hooks (dashboardDrawer, dashboardDrawerOpened, dashboardDrawerClosed) are called by
// the base page script in dashboard.cjs, which also works without them for the file:// copy.
const actionsClientScript = (csrf, replyable) => `
const CSRF = ${JSON.stringify(csrf)};
const REPLYABLE = new Set(${JSON.stringify([...replyable]).replace(/</g, '\\u003c')});
const toastEl = document.querySelector('.toast');
let toastTimer;
function toast(text, ok) {
  toastEl.textContent = text;
  toastEl.classList.toggle('err', !ok);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ${TOAST_MS});
}
async function act(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': CSRF }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.reload) throw new Error('The dashboard server restarted: reload the page.');
  if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed (HTTP ' + res.status + ').');
  return data.message;
}
async function run(button, path, body, after) {
  button.disabled = true;
  try { toast(await act(path, body), true); if (after) after(); } catch (err) { toast(err.message, false); } finally { button.disabled = false; }
}
const msgForm = document.querySelector('.msg');
const msgInput = msgForm.querySelector('input');
const typing = () => [...document.querySelectorAll('.msg input, .reply input')].some((i) => i === document.activeElement || i.value !== '');
window.dashboardBusy = () => typing() || document.body.classList.contains('open') || !!document.querySelector('.armed');
msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return msgInput.focus();
  run(msgForm.querySelector('button'), '/api/message', { text }, () => { msgInput.value = ''; msgInput.blur(); });
});
function armed(button, label) {
  if (button.classList.contains('armed')) { button.classList.remove('armed'); clearTimeout(button.armTimer); return true; }
  const original = button.textContent;
  button.classList.add('armed');
  button.textContent = label;
  button.armTimer = setTimeout(() => { button.classList.remove('armed'); button.textContent = original; }, ${CONFIRM_MS});
  return false;
}
let peekTimer;
let peekId = '';
// Task ids never contain ':', so this cannot collide with a ledger task.
const COORDINATOR_PEEK = ':coordinator';
const peekUrl = (id) => (id === COORDINATOR_PEEK ? '/api/coordinator/peek' : '/api/peek?id=' + encodeURIComponent(id));
const peekBoxHtml = (id) => '<h5>Live pane</h5><div class="peek" data-peek-id="' + esc(id) + '"><pre>loading…</pre><div class="hint"><span>connecting…</span><span>last ${PEEK_POLL_MS / 1000}s refresh, ANSI stripped</span></div></div>';
async function refreshPeek() {
  const box = document.querySelector('.drawer .peek');
  if (!box || box.dataset.peekId !== peekId) return;
  const pre = box.querySelector('pre');
  const status = box.querySelector('.hint');
  try {
    const res = await fetch(peekUrl(peekId), { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Dashboard-Token': CSRF } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(res.status === 403 && data.reload ? 'The dashboard server restarted: reload the page.' : data.error || 'Peek failed (HTTP ' + res.status + ').');
    if (box.dataset.peekId !== peekId) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = data.lines.length ? data.lines.join('\\n') : '(the pane is empty)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    status.classList.remove('err');
    status.firstChild.textContent = 'live \u00b7 ' + new Date(data.at).toLocaleTimeString('en-GB', { hour12: false }) + (data.command && data.command !== 'claude' ? ' \u00b7 pane runs ' + data.command : '');
  } catch (err) {
    status.classList.add('err');
    status.firstChild.textContent = err.message;
  }
}
function stopPeek() { clearInterval(peekTimer); peekId = ''; }
function startPeek(id) {
  stopPeek();
  peekId = id;
  refreshPeek();
  peekTimer = setInterval(() => { if (!document.hidden) refreshPeek(); }, ${PEEK_POLL_MS});
}
function openCoordinatorDrawer() {
  document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
  drawer.innerHTML = '<div class="dhead"><span class="pill">coordinator</span><button class="x" title="Close (Esc)">\u2715</button></div><h2>Coordinator</h2>'
    + peekBoxHtml(COORDINATOR_PEEK)
    + '<form class="reply" data-reply="' + COORDINATOR_PEEK + '" autocomplete="off"><input name="text" maxlength="2000" placeholder="Message coordinator" aria-label="Message coordinator" enterkeyhint="send"><button class="btn" type="submit">Send</button></form>'
    + '<div class="hint">Typed into the coordinator\\'s prompt with a [via dashboard] prefix. Permission dialogs and menus must be answered in the terminal.</div>';
  document.body.classList.add('open');
  startPeek(COORDINATOR_PEEK);
}
window.dashboardDrawer = (a) => REPLYABLE.has(a.id)
  ? peekBoxHtml(a.id)
    + '<form class="reply" data-reply="' + esc(a.id) + '" autocomplete="off"><input name="text" maxlength="2000" placeholder="Reply to this worker" aria-label="Reply to ' + esc(a.id) + '" enterkeyhint="send"><button class="btn" type="submit">Send</button></form>'
    + '<div class="hint">Typed into the worker\\'s prompt with a [via dashboard] prefix. Permission dialogs and menus must be answered in the terminal.</div>'
  : '';
window.dashboardDrawerOpened = (a) => { if (REPLYABLE.has(a.id)) startPeek(a.id); else stopPeek(); };
window.dashboardDrawerClosed = stopPeek;
document.addEventListener('visibilitychange', () => { if (!document.hidden && peekId) refreshPeek(); });
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form.reply');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('input');
  const text = input.value.trim();
  if (!text) return input.focus();
  const toCoordinator = form.dataset.reply === COORDINATOR_PEEK;
  run(form.querySelector('button'), toCoordinator ? '/api/message' : '/api/reply', toCoordinator ? { text } : { id: form.dataset.reply, text }, () => { input.value = ''; input.blur(); if (peekId === form.dataset.reply) setTimeout(refreshPeek, 600); });
});
const reloadSoon = () => setTimeout(reloadIfIdle, 1200);
document.addEventListener('click', (e) => {
  if (e.target.closest('.card form.reply')) { e.stopPropagation(); return; }
  const peekButton = e.target.closest('[data-peek]');
  if (peekButton) {
    e.stopPropagation();
    openDrawer(peekButton.dataset.peek);
    document.querySelector('.drawer .peek')?.scrollIntoView({ block: 'start' });
    return;
  }
  if (e.target.closest('[data-act="coordinator"]')) return openCoordinatorDrawer();
  const focus = e.target.closest('[data-act="focus"]');
  if (focus) return run(focus, '/api/coordinator/focus');
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); if (armed(close, 'Confirm close')) run(close, '/api/tabs/close', { id: close.dataset.close }, reloadSoon); return; }
  const all = e.target.closest('[data-close-all]');
  if (all) { e.stopPropagation(); if (armed(all, 'Confirm close all')) run(all, '/api/tabs/close-done', {}, reloadSoon); }
}, true);
setInterval(reloadIfIdle, ${SERVED_RELOAD_SECONDS * 1000});
`;

module.exports = {
  SERVED_RELOAD_SECONDS,
  actionsCss,
  headerActionsHtml,
  readOnlyHintHtml,
  replyFormHtml,
  peekButtonHtml,
  closeButtonHtml,
  closeAllButtonHtml,
  actionsClientScript,
};
