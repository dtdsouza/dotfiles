// Markup, styles and client script for the action controls; only the served page gets them.
const SERVED_RELOAD_SECONDS = 60;
const CONFIRM_MS = 4000;
const TOAST_MS = 3500;

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
@media (max-width:640px){.topbar .right{flex-wrap:wrap;gap:10px;width:100%}.topbar .meta{flex:1;min-width:0}.actions{width:100%}.msg{flex:1;min-width:0}.msg input{width:auto;flex:1}}`;

const headerActionsHtml = `<div class="actions"><form class="msg" autocomplete="off"><input name="text" maxlength="2000" placeholder="Message coordinator" aria-label="Message coordinator"><button class="btn" type="submit">Send</button></form><button class="btn quiet" data-act="focus" type="button">Go to coordinator</button></div>`;

const readOnlyHintHtml = (liveUrl) =>
  `<a class="readonly" href="${esc(liveUrl)}" title="This file is read-only. Actions need agentctl.sh dashboard --serve and its URL.">read-only · open live page</a>`;

const closeButtonHtml = (id) => `<button class="mini kill" data-close="${esc(id)}" type="button">Close tab</button>`;

const closeAllButtonHtml = (count) => (count > 1 ? `<button class="mini kill" data-close-all type="button">Close all ${count}</button>` : '');

const actionsClientScript = (csrf) => `
const CSRF = ${JSON.stringify(csrf)};
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
window.dashboardBusy = () => document.activeElement === msgInput || msgInput.value !== '' || !!document.querySelector('.armed');
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
const reloadSoon = () => setTimeout(reloadIfIdle, 1200);
document.addEventListener('click', (e) => {
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
  closeButtonHtml,
  closeAllButtonHtml,
  actionsClientScript,
};
