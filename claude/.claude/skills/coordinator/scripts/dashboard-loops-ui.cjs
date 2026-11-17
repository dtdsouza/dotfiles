'use strict';

// Client side of the Loops area: the loop list, a loop's page (status, schedule, caps, runs,
// controls, settings) and the triage draft panel. Every value from the server goes through esc().
// Uses CSRF, esc, toast, act, armed, drawer and closeDrawer from the scripts it is appended to.
const LOOPS_POLL_MS = 60000;
const LOOP_PAGE_POLL_MS = 15000;
const BUDGET_WARN = 0.75;

const loopsCss = `
.loopview{padding:28px 40px 60px;max-width:1100px}
.lvhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}.lvhead h2{font-size:26px}
.lvdesc{color:var(--muted);font-size:13px;margin-bottom:14px}
.lvctl{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 22px}
.lvctl .mini{padding:5px 14px;font-size:12px}
.lvgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.lvbox{border:1px solid var(--line);border-radius:22px;padding:16px 18px;background:linear-gradient(var(--soft),transparent 60%)}
.lvbox h5{margin:0 0 12px}.lvbox.wide{grid-column:1/-1}
.cap{display:grid;grid-template-columns:150px 1fr 90px;gap:10px;align-items:center;font-size:12px;margin-bottom:8px}
.cap .bar{height:5px;border-radius:5px;background:var(--line);overflow:hidden}.cap .bar i{display:block;height:100%;background:var(--green-ink)}
.cap.warn .bar i{background:var(--amber)}.cap.over .bar i{background:var(--red)}.cap b{color:var(--fg);font-weight:500;text-align:right}
.runs div{display:grid;grid-template-columns:76px 1fr;gap:10px;font-size:12px;padding:5px 0;border-bottom:1px solid var(--line);word-break:break-word}
.runs div.error span:last-child{color:var(--red)}.runs time{color:var(--muted);font:11px var(--mono)}
.mode{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font:600 11px/18px var(--body);border:1px solid var(--line)}
.mode.m-auto{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 50%,transparent)}.mode.m-guarded{color:var(--green-ink);border-color:var(--green-30)}
.st{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.st label{color:var(--fg);font-size:13px}.st .hint{grid-column:1/-1;margin:0}
.st input,.st select{background:var(--surface);border:1px solid var(--line);border-radius:999px;color:var(--fg);padding:5px 12px;font:13px var(--body);width:130px}
.st .sv{display:flex;gap:6px;align-items:center}
.seg2{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px;gap:3px}
.seg2 button{border:0;border-radius:999px;padding:6px 14px;font:600 12px var(--body);color:var(--text);background:transparent;cursor:pointer}
.seg2 button.on{background:var(--green-12);color:var(--fg);box-shadow:inset 0 0 0 1px var(--green-30)}.seg2 button.armed{color:var(--red);box-shadow:inset 0 0 0 1px var(--red)}
.lrow{display:flex;align-items:center;gap:12px;border:1.5px solid var(--line);border-radius:20px;padding:14px 16px;margin-bottom:12px;text-decoration:none;color:var(--text)}
.lrow .lname{color:var(--fg);font-weight:600;font-size:14px}.lrow .lsum{font-size:12px;color:var(--muted)}.lrow .grow{flex:1;min-width:0}
.ctl div{font-size:12px;padding:4px 0;color:var(--text)}.ctl time{color:var(--muted);font:11px var(--mono);margin-right:8px}
@media (max-width:1100px){.lvgrid{grid-template-columns:minmax(0,1fr)}}
.back{display:none;font-size:13px;color:var(--green-ink);text-decoration:none;margin-bottom:8px}
@media (max-width:640px){.back{display:inline-block}.runs div:nth-child(n+9){display:none}.loopview{padding:16px}.cap{grid-template-columns:110px 1fr 70px}.st input,.st select{width:110px;font-size:16px}}
`;

const loopsScript = `
const DOT_LABEL = { running: 'running', paused: 'paused', off: 'timer off', error: 'error', needs: 'needs you', unknown: '\\u2026' };
const VERB_LABEL = { pause: 'Pause', resume: 'Resume', 'run-once': 'Run now', kill: 'Kill', 'disable-timer': 'Disable timer', 'enable-timer': 'Enable timer' };
const CONFIRM = { pause: 'Confirm pause', resume: 'Confirm resume', 'run-once': 'Confirm run now', kill: 'Confirm kill', 'disable-timer': 'Confirm disable', 'enable-timer': 'Confirm enable' };
const REMOTE = document.body.classList.contains('remote');
const hhmm = (v) => {
  const m = String(v || '').match(/(\\d{2}:\\d{2})(:\\d{2})?/);
  if (m && !/T/.test(v)) return m[1];
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return String(v || '-');
  const time = t.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return t.toDateString() === new Date().toDateString() ? time : t.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + time;
};
const money = (n) => (n === null || n === undefined ? '-' : '$' + (Math.round(n * 100) / 100));
async function readJson(url) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Dashboard-Token': CSRF } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.reload) throw new Error('The dashboard server restarted: reload the page.');
  if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed (HTTP ' + res.status + ').');
  return data;
}
let loopList = [];
const subLine = (l) => [l.mode ? l.mode : '', l.pending ? l.pending + ' wait' : '', l.next ? 'next ' + hhmm(l.next) : '', l.cost && l.cost.week_limit_usd ? money(l.cost.week_usd) + ' / ' + money(l.cost.week_limit_usd) + ' wk' : ''].filter(Boolean).join(' \\u00b7 ');
function paintRail() {
  loopList.forEach((l) => {
    document.querySelectorAll('[data-loop-link="' + l.id + '"] .ldot').forEach((d) => { d.dataset.dot = l.dot; d.title = DOT_LABEL[l.dot] || l.dot; });
    document.querySelectorAll('[data-loop-sub="' + l.id + '"]').forEach((s) => { s.textContent = subLine(l); });
  });
  const week = loopList.reduce((sum, l) => sum + ((l.cost && l.cost.week_usd) || 0), 0);
  document.querySelectorAll('[data-loops-total]').forEach((f) => { f.textContent = 'all loops ' + money(week) + ' this week'; });
  const dot = document.querySelector('.tabbar .tdot');
  if (dot) dot.hidden = !loopList.some((l) => l.dot === 'needs' || l.dot === 'error');
}
async function refreshLoops() {
  try { loopList = (await readJson('/api/loops')).loops; paintRail(); if (viewOfHash().view === 'loops') renderLoopList(); } catch (_) {}
}
const view = () => document.querySelector('.loopview');
const dotHtml = (dot) => '<span class="pill"><i class="ldot" style="position:static" data-dot="' + esc(dot) + '"></i>' + esc(DOT_LABEL[dot] || dot) + '</span>';
const modeHtml = (mode) => (mode ? '<span class="mode m-' + esc(mode) + '">' + (mode === 'auto' ? 'automatic' : mode === 'guarded' ? 'manual (approve each)' : esc(mode)) + '</span>' : '');
function verbButton(loopId, verb) {
  return '<button class="mini' + (verb === 'kill' ? ' kill' : '') + ((verb === 'disable-timer' || verb === 'enable-timer') ? ' desktop-only' : '') + '" type="button" data-loop-verb="' + esc(verb) + '" data-loop="' + esc(loopId) + '">' + esc(VERB_LABEL[verb]) + '</button>';
}
function renderLoopList() {
  const el = view();
  el.innerHTML = '<div class="lvhead"><h2>My loops</h2></div><div class="lvdesc">Background loops on systemd timers. Pause only lowers risk; resume and run now check the weekly budget.</div>'
    + (loopList.length ? loopList.map((l) => '<a class="lrow" href="#loop/' + esc(l.id) + '"><i class="ldot" style="position:static" data-dot="' + esc(l.dot) + '"></i><span class="grow"><div class="lname">' + esc(l.name) + '</div><div class="lsum">' + esc(DOT_LABEL[l.dot] || l.dot) + (subLine(l) ? ' \\u00b7 ' + esc(subLine(l)) : '') + '</div></span>'
      + (l.verbs.includes('pause') && l.state === 'running' && (!REMOTE || l.phone.includes('pause')) ? verbButton(l.id, 'pause') : '') + '</a>').join('') : '<div class="hint">Loading\\u2026</div>');
}
function capHtml(name, used, limit, money_) {
  const ratio = limit ? used / limit : 0;
  const cls = ratio >= 1 ? ' over' : ratio >= ${BUDGET_WARN} ? ' warn' : '';
  return '<div class="cap' + cls + '"><span>' + esc(name) + '</span><span class="bar"><i style="width:' + Math.min(100, Math.round(ratio * 100)) + '%"></i></span><b>' + (money_ ? money(used) + ' / ' + money(limit) : esc(used) + ' / ' + esc(limit)) + '</b></div>';
}
function settingInput(loopId, s, value) {
  const id = 'set-' + loopId + '-' + s.key.replace(/\\./g, '-');
  let input;
  if (s.type === 'enum') input = '<select id="' + id + '">' + s.values.map((v) => '<option' + (v === value ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
  else if (s.type === 'boolean') input = '<select id="' + id + '"><option value="true"' + (value === true ? ' selected' : '') + '>on</option><option value="false"' + (value === false ? ' selected' : '') + '>off</option></select>';
  else input = '<input id="' + id + '" type="number" inputmode="decimal" min="' + s.min + '" max="' + s.max + '" step="' + (s.type === 'integer' ? 1 : 'any') + '" value="' + esc(value === null || value === undefined ? '' : value) + '">';
  const blocked = REMOTE && !s.phone;
  return '<div class="st"><label for="' + id + '">' + esc(s.label) + '</label><span class="sv">' + input + '<button class="mini" type="button" data-save-setting="' + esc(s.key) + '" data-loop="' + esc(loopId) + '" data-type="' + esc(s.type) + '"' + (blocked ? ' disabled title="PC only"' : '') + '>Save</button></span><div class="hint">' + esc(s.description || '') + (s.type === 'integer' || s.type === 'number' ? ' (' + s.min + '\\u2013' + s.max + ')' : '') + (blocked ? ' PC only.' : '') + '</div></div>';
}
function modeSwitchHtml(loopId, s, value) {
  if (!s || s.type !== 'enum') return '';
  return '<div class="lvbox wide"><h5>' + esc(s.label) + '</h5><div class="seg2">' + s.values.map((v) => '<button type="button" data-mode-value="' + esc(v) + '" data-mode-key="' + esc(s.key) + '" data-loop="' + esc(loopId) + '"' + (v === value ? ' class="on"' : '') + '>' + esc(v === 'auto' ? 'Automatic' : v === 'guarded' ? 'Manual' : v) + '</button>').join('') + '</div><div class="hint">' + esc(s.description || '') + '</div></div>';
}
function controlsHtml(controls) {
  if (!controls.length) return '<div class="hint">No control actions recorded yet.</div>';
  return '<div class="ctl">' + controls.map((c) => '<div><time>' + esc(hhmm(c.at)) + '</time>' + esc(c.verb === 'config' ? c.key + ': ' + (c.from === null ? '-' : c.from) + ' \\u2192 ' + c.to : c.verb + (c.key ? ' ' + c.key : '')) + ' \\u00b7 ' + esc(c.source) + (c.exit ? ' \\u00b7 exit ' + c.exit : '') + '</div>').join('') + '</div>';
}
function loopPageHtml(d) {
  const L = d.loop;
  const st = d.adapter.ok ? d.adapter.status : null;
  const badge = L.settings && L.settings.keys.find((k) => k.badge);
  const allowed = L.verbs.filter((v) => !REMOTE || L.phone.includes(v));
  const verbs = allowed.filter((v) => !(v === 'pause' && st && st.state !== 'running') && !(v === 'resume' && st && st.state === 'running')).filter((v) => !(v === 'disable-timer' && d.units.timer && d.units.timer.active !== 'active') && !(v === 'enable-timer' && (!d.units.timer || d.units.timer.active === 'active')));
  const t = d.units.timer || {};
  const s = d.units.service || {};
  const schedule = '<div class="kv"><span>Schedule</span><span>' + esc(L.schedule || '-') + '</span><span>Timer</span><span>' + esc((t.active || 'unknown') + (t.enabled ? ' \\u00b7 ' + t.enabled : '')) + '</span><span>Last tick</span><span>' + esc(t.last ? hhmm(t.last) : '-') + (s.result ? ' \\u00b7 ' + esc(s.result) + (s.exitStatus && s.exitStatus !== '0' ? ' (exit ' + esc(s.exitStatus) + ')' : '') : '') + '</span><span>Next tick</span><span>' + esc(t.next ? hhmm(t.next) : '-') + '</span><span>In flight</span><span>' + (st && st.in_flight.length ? st.in_flight.map((f) => esc(f.label) + ' since ' + esc(hhmm(f.since))).join('<br>') : 'none') + '</span></div>';
  const caps = st ? st.caps.map((c) => capHtml(c.name, c.used, c.limit, false)).join('') + (st.cost && st.cost.week_limit_usd !== null ? capHtml('week $ (' + st.cost.basis + ')', st.cost.week_usd, st.cost.week_limit_usd, true) + '<div class="hint">today ' + esc(money(st.cost.today_usd)) + '</div>' : '') : '';
  const runs = st && st.recent.length ? '<div class="runs">' + st.recent.slice(0, 20).map((r) => '<div class="' + esc(r.level) + '"><time>' + esc(hhmm(r.at)) + '</time><span>' + esc(r.text) + '</span></div>').join('') + '</div>' : '<div class="hint">No runs logged yet.</div>';
  const errors = st && st.errors.length ? '<div class="runs">' + st.errors.map((r) => '<div class="error"><time>' + esc(hhmm(r.at)) + '</time><span>' + esc(r.text) + '</span></div>').join('') + '</div>' : '<div class="hint">No errors in the last 24 h.</div>';
  const settings = L.settings ? '<div class="lvbox wide"><h5>Settings</h5>' + L.settings.keys.filter((k) => !k.badge).map((k) => settingInput(L.id, k, st ? st.settings[k.key] : null)).join('') + '<div class="hint">Saved to ' + esc(L.settings.file) + '. ' + esc(L.settings.note || '') + ' The previous file is kept in its .history folder and every change is in the audit log.</div></div>' : '';
  const waiting = L.drafts ? (d.drafts ? '<div class="hint">' + d.drafts + ' draft' + (d.drafts === 1 ? '' : 's') + ' wait in Needs you on the Agents page.</div>' : '<div class="hint">No drafts waiting.</div>') : (st && st.pending ? '<div class="hint">' + st.pending + ' waiting: they show as cards in Needs you.</div>' : '<div class="hint">Nothing waiting. Decisions show as cards in Needs you.</div>');
  return '<a class="back" href="#loops">\u2039 Loops</a><div class="lvhead"><h2>' + esc(L.name) + '</h2>' + dotHtml(d.dot) + (L.risk ? '<span class="tag">' + esc(L.risk) + '</span>' : '') + '<span class="tag">systemd timer</span>' + modeHtml(st && badge ? st.settings[badge.key] : '') + '</div>'
    + '<div class="lvdesc">' + esc(L.description) + (st ? ' \\u00b7 ' + esc(st.summary) : '') + '</div>'
    + (d.adapter.ok ? '' : '<div class="askbox blocked">status failed: ' + esc(d.adapter.error) + '</div>')
    + (st && st.notes.length ? st.notes.map((n) => '<div class="askbox flag">' + esc(n) + '</div>').join('') : '')
    + '<div class="lvctl">' + verbs.map((v) => verbButton(L.id, v)).join('') + '</div>'
    + '<div class="lvgrid">' + (badge ? modeSwitchHtml(L.id, badge, st ? st.settings[badge.key] : null) : '')
    + '<div class="lvbox"><h5>Schedule</h5>' + schedule + '</div><div class="lvbox"><h5>Caps & budget</h5>' + (caps || '<div class="hint">No caps reported.</div>') + '</div>'
    + '<div class="lvbox"><h5>Recent runs</h5>' + runs + '</div><div class="lvbox"><h5>Errors \\u00b7 24 h</h5>' + errors + '<h5 style="margin-top:18px">Waiting on you</h5>' + waiting + '<h5 style="margin-top:18px">Last control actions</h5>' + controlsHtml(d.controls) + '</div>'
    + settings + '</div>';
}
let loopShown = '';
let loopTimer;
const pageBusy = () => { const el = view(); return !!el && (!!el.querySelector('.armed') || [...el.querySelectorAll('input,select')].some((i) => i === document.activeElement)); };
async function renderLoopPage(id, quiet) {
  const el = view();
  if (!quiet) el.innerHTML = '<div class="lvhead"><h2>Loading\\u2026</h2></div>';
  try {
    const d = await readJson('/api/loops/status?loop=' + encodeURIComponent(id));
    if (loopShown === id && !(quiet && pageBusy())) el.innerHTML = loopPageHtml(d);
  } catch (err) {
    if (loopShown === id && !quiet) el.innerHTML = '<div class="askbox blocked">' + esc(err.message) + '</div>';
  }
}
window.renderLoopRoute = (route) => {
  clearInterval(loopTimer);
  loopShown = route.view === 'loop' ? route.id : '';
  if (route.view === 'loops') { renderLoopList(); refreshLoops(); }
  if (route.view === 'loop') { renderLoopPage(route.id, false); loopTimer = setInterval(() => renderLoopPage(route.id, true), ${LOOP_PAGE_POLL_MS}); }
};
const settingValue = (button) => {
  const input = button.closest('.st').querySelector('input,select');
  if (button.dataset.type === 'boolean') return input.value === 'true';
  if (button.dataset.type === 'enum') return input.value;
  return input.value === '' ? null : Number(input.value);
};
async function loopPost(button, path, body, label) {
  button.disabled = true;
  try { toast(await act(path, body), true); await refreshLoops(); if (loopShown) renderLoopPage(loopShown, false); } catch (err) { toast(err.message, false); } finally { button.disabled = false; if (label) button.textContent = label; }
}
document.addEventListener('click', (e) => {
  const verb = e.target.closest('[data-loop-verb]');
  if (verb) { e.preventDefault(); e.stopPropagation(); const label = VERB_LABEL[verb.dataset.loopVerb]; if (armed(verb, CONFIRM[verb.dataset.loopVerb])) loopPost(verb, '/api/loops/action', { loop: verb.dataset.loop, verb: verb.dataset.loopVerb }, label); return; }
  const save = e.target.closest('[data-save-setting]');
  if (save) { if (armed(save, 'Confirm save')) loopPost(save, '/api/loops/config', { loop: save.dataset.loop, key: save.dataset.saveSetting, value: settingValue(save) }, 'Save'); return; }
  const mode = e.target.closest('[data-mode-value]');
  if (mode && !mode.classList.contains('on')) { if (armed(mode, 'Confirm ' + mode.textContent.toLowerCase())) loopPost(mode, '/api/loops/config', { loop: mode.dataset.loop, key: mode.dataset.modeKey, value: mode.dataset.modeValue }); }
}, true);
const baseBusy = window.dashboardBusy;
window.dashboardBusy = () => (baseBusy ? baseBusy() : false) || pageBusy() || !!document.querySelector('textarea.dfedit');
refreshLoops();
setInterval(refreshLoops, ${LOOPS_POLL_MS});

const KIND_TEXT = { 'real-bug': 'suspected bug', 'not-a-bug': 'not a bug', 'data-request': 'data/CX request', contribute: 'context for an open ticket', noise: 'noise', unknown: 'case' };
let draftShown = null;
const draftHead = (d) => '<div class="dhead"><span class="pill"><span class="dot s-review"></span>triage draft' + (d ? ' \\u00b7 ' + esc(d.channel.name || d.channel.id) : '') + '</span><button class="x" title="Close (Esc)">\\u2715</button></div>';
function draftHtml(d) {
  const jira = d.jira.action === 'create' ? '<div class="kv"><span>Action</span><span>file a new bug (label ai-triaged)</span><span>Summary</span><span>' + esc(d.jira.summary) + '</span></div><div class="dfbox">' + esc(d.jira.description) + '</div>'
    : d.jira.action === 'comment' ? '<div class="kv"><span>Action</span><span>comment on ' + esc(d.jira.key) + '</span></div><div class="dfbox">' + esc(d.jira.description) + '</div>' : '<div class="hint">none</div>';
  return draftHead(d) + '<h2>' + esc(d.title || 'Triage draft') + '</h2><div class="row"><span class="tag">' + esc(KIND_TEXT[d.kind] || d.kind) + '</span>' + modeHtml(d.mode) + (d.dryRun ? '<span class="tag">dry run</span>' : '') + '</div>'
    + (d.status === 'held' ? '<div class="askbox flag">Held for you: ' + esc(d.heldReason || 'needs approval') + '</div>' : '') + (d.error ? '<div class="askbox blocked">' + esc(d.error) + '</div>' : '')
    + (d.summary ? '<div class="goal">' + esc(d.summary) + '</div>' : '')
    + '<h5>Case</h5><div class="dfbox">' + esc(d.caseText || '-') + '</div>' + (d.permalink ? '<div class="hint"><a href="' + esc(d.permalink) + '" target="_blank" rel="noopener noreferrer">Open the thread in Slack</a></div>' : '')
    + '<h5>Slack reply (as the app)</h5><div class="dfbox dfreply">' + esc(d.reply) + '</div>'
    + '<h5>Jira</h5>' + jira
    + (d.evidence.length ? '<h5>Evidence</h5><div class="tl">' + d.evidence.map((e) => '<div>' + esc(e) + '</div>').join('') + '</div>' : '')
    + '<div class="hint">Slack and model text is shown as plain text. The reply already carries the unreviewed-AI banner.</div>'
    + '<div class="dfbar"><button class="mini approve" type="button" data-draft-answer="yes">Approve &amp; send</button><button class="mini" type="button" data-draft-edit>Edit</button><button class="mini kill" type="button" data-draft-answer="no">Discard</button></div>';
}
async function openDraftDrawer(id) {
  const [, loop, draftId] = id.split('/');
  if (window.dashboardDrawerClosed) window.dashboardDrawerClosed();
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  draftShown = { id, loop, draftId, draft: null };
  drawer.classList.add('draft');
  drawer.innerHTML = draftHead(null) + '<div class="hint">Loading the draft\\u2026</div>';
  document.body.classList.add('open');
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  try {
    const { draft } = await readJson('/api/loops/draft?loop=' + encodeURIComponent(loop) + '&id=' + encodeURIComponent(draftId));
    if (draftShown && draftShown.id === id) { draftShown.draft = draft; drawer.innerHTML = draftHtml(draft); }
  } catch (err) {
    if (draftShown && draftShown.id === id) drawer.innerHTML = draftHead(null) + '<div class="askbox blocked">' + esc(err.message) + '</div>';
  }
}
function leaveDraft() { draftShown = null; drawer.classList.remove('draft'); }
const draftClosed = window.dashboardDrawerClosed;
window.dashboardDrawerClosed = () => { leaveDraft(); if (draftClosed) draftClosed(); };
const draftOpened = window.dashboardDrawerOpened;
window.dashboardDrawerOpened = (a) => { leaveDraft(); if (draftOpened) draftOpened(a); };
window.openDraftDrawer = openDraftDrawer;
document.addEventListener('click', (e) => {
  if (!draftShown || !draftShown.draft) return;
  const edit = e.target.closest('[data-draft-edit]');
  if (edit) { const box = drawer.querySelector('.dfreply'); if (box && box.tagName !== 'TEXTAREA') { const ta = document.createElement('textarea'); ta.className = 'dfedit'; ta.maxLength = 4000; ta.value = draftShown.draft.reply; box.replaceWith(ta); ta.focus(); edit.textContent = 'Editing'; edit.disabled = true; } return; }
  const answer = e.target.closest('[data-draft-answer]');
  if (!answer) return;
  e.stopPropagation();
  if (!armed(answer, answer.dataset.draftAnswer === 'yes' ? 'Confirm send' : 'Confirm discard')) return;
  const ta = drawer.querySelector('textarea.dfedit');
  const { loop, draftId, draft, id } = draftShown;
  const body = { loop, id: draftId, hash: draft.hash, answer: answer.dataset.draftAnswer, ...(ta ? { text: ta.value } : {}) };
  answer.disabled = true;
  act('/api/loops/decide', body).then((message) => {
    toast(message, true);
    document.querySelectorAll('.dfcard').forEach((c) => { if (c.dataset.id === id) c.remove(); });
    closeDrawer();
    refreshLoops();
  }).catch((err) => { toast(err.message, false); answer.disabled = false; });
}, true);
`;

module.exports = { loopsCss, loopsScript };
