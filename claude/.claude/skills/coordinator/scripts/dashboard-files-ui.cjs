// The served dashboard's file features: the Files page, each task's files in its drawer, and the
// artifact paths in ledger notes turned into viewer links.
const os = require('os');
const path = require('path');
const { readLedger } = require('./dashboard-actions.cjs');
const { findNoteRefs, resolveCandidate, collectMentions, createAttribution } = require('./dashboard-files-index.cjs');
const { viewHref } = require('./dashboard-files-serve.cjs');
const { fileProfileOf, scopePolicy } = require('./dashboard-files-policy.cjs');
const { PRIMARY_PROFILE, taskKey } = require('./profiles.cjs');

const FILES_PAGE_LIMIT = 300;
const DRAWER_FILES_LIMIT = 20;
const STALE_LINKS_MS = 10 * 60 * 1000;
const KIND_LABELS = { html: 'HTML', video: 'Video', pdf: 'PDF', image: 'Image', svg: 'Image', text: 'Text' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ago = (ms) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const shortDir = (file, home = os.homedir()) => path.dirname(file).replace(home, '~');

const fileRow = (signer, viewable) => ({
  name: path.basename(viewable.real),
  dir: shortDir(viewable.real),
  kind: viewable.kind,
  href: viewHref(signer, viewable),
  age: ago(viewable.mtimeMs),
  mtimeMs: viewable.mtimeMs,
});

const linkHtml = (row, label) => `<a class="flink" href="${esc(row.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

// Everything outside a recognized, viewable path stays escaped text; a brace list keeps its text
// and gets one link per file it names.
const linkifyText = (text, { bases, policy, signer }) => {
  let html = '';
  let at = 0;
  for (const ref of findNoteRefs(text)) {
    const files = ref.candidates.map((c) => resolveCandidate(c, bases, policy)).filter(Boolean);
    if (!files.length) continue;
    html += esc(text.slice(at, ref.start));
    html +=
      files.length === 1 && ref.candidates.length === 1
        ? linkHtml(fileRow(signer, files[0]), ref.raw)
        : `${esc(ref.raw)} ${files.map((f) => linkHtml(fileRow(signer, f), path.extname(f.real).slice(1) || path.basename(f.real))).join(' ')}`;
    at = ref.end;
  }
  return html + esc(text.slice(at));
};

// One profile's attribution: its notes resolve only files under its own roots, and a file under
// another profile's roots is never its own, whatever a note or folder name says.
const profileAttribution = (stateDir, metas, policy, profile) => {
  const scoped = scopePolicy(policy, profile);
  const mentions = collectMentions(stateDir, metas, scoped);
  const attribute = createAttribution(metas, mentions.owner);
  return { ...mentions, scoped, attribute: (file) => (fileProfileOf(file.real, policy) === profile ? attribute(file) : '') };
};

// Returns the owning task key; a file belongs to at most one profile, so profiles never compete.
const createProfileAttribution = (profiles, policy) => {
  const byProfile = new Map(
    profiles.map((p) => [p.name, profileAttribution(p.stateDir, readLedger(p.stateDir).filter((m) => m.id), policy, p.name).attribute]),
  );
  return (file) => {
    const profile = fileProfileOf(file.real, policy);
    const id = byProfile.has(profile) ? byProfile.get(profile)(file) : '';
    return id ? taskKey(profile, id) : '';
  };
};

// Adds `files` (newest first) and HTML notes to each served item; the file:// copy never gets them.
// profile names whose notes these are (default: the primary); their links stay inside its roots.
const decorateItems = (items, { stateDir, policy, index, signer, profile = PRIMARY_PROFILE }) => {
  const metas = readLedger(stateDir).filter((m) => m.id);
  const byId = new Map(metas.map((m) => [m.id, m]));
  const { byTask, scoped, attribute } = profileAttribution(stateDir, metas, policy, profile);
  const indexed = new Map();
  index.list().forEach((f) => {
    const id = attribute(f);
    if (id) indexed.set(id, [...(indexed.get(id) || []), f]);
  });
  return items.map((item) => {
    const meta = byId.get(item.id) || {};
    const context = { bases: [meta.workdir, meta.repo], policy: scoped, signer };
    const unique = new Map([...(byTask.get(item.id) || []), ...(indexed.get(item.id) || [])].map((f) => [f.real, f]));
    const files = [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, DRAWER_FILES_LIMIT).map((f) => fileRow(signer, f));
    return {
      ...item,
      files,
      notes: item.notes.map(([at, text]) => [at, linkifyText(text, context)]),
      notesHtml: true,
      summaryHtml: item.summary ? linkifyText(item.summary, context) : '',
    };
  });
};

const filesCss = `.fbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:16px 40px 0}
.fbar input{flex:1 1 220px;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:999px;color:var(--fg);padding:8px 14px;font:14px var(--body)}
.flist{padding:12px 40px 40px;display:grid;gap:10px}
.frow{border:1.5px solid var(--line);border-radius:18px;padding:12px 14px;display:grid;gap:4px;background:linear-gradient(230deg,transparent 60%,var(--card-sheen))}
.frow .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.flink{color:var(--green-ink);text-decoration:none;font-weight:600;word-break:break-all}.flink:hover{text-decoration:underline}
.frow .where{font:11px/1.4 var(--mono);color:var(--muted);word-break:break-all}
.frow .age{margin-left:auto;font-size:12px;color:var(--muted)}
.fsep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}
.tasklink{color:var(--text);text-decoration:none}.tasklink:hover{color:var(--fg)}
.files{display:grid;gap:8px}.files .frow{padding:10px 12px}
.tl .flink,.askbox .flink{font-weight:500}
@media (max-width:640px){.fbar{padding:12px 16px 0}.flist{padding:12px 16px 32px}.flink{display:inline-block;padding:4px 0}}`;

const kindTag = (kind) => `<span class="tag">${esc(KIND_LABELS[kind] || kind)}</span>`;

const PROFILE_STORAGE_KEY = 'agentctl.files.profile';

// The same badge as a lane head: the primary profile gets tone 0, every other one tone 1.
const profileBadge = (profiles, name) => {
  const index = profiles.findIndex((p) => p.name === name);
  return index === -1 ? '' : `<span class="prof p${Math.min(index, 1)}">${esc(profiles[index].label || name)}</span>`;
};

const filesPageRow = (row, taskId, profile, profiles) =>
  `<div class="frow" data-kind="${esc(row.kind)}" data-profile="${esc(profile)}" data-text="${esc(`${row.name} ${row.dir} ${taskId}`.toLowerCase())}"><div class="top">${profileBadge(profiles, profile)}${kindTag(row.kind)}${linkHtml(row, row.name)}<span class="age">${esc(row.age)}</span></div>${
    taskId ? `<a class="tasklink pill" href="/#${esc(encodeURIComponent(taskId))}">${esc(taskId)}</a>` : ''
  }<div class="where">${esc(row.dir)}</div></div>`;

// The profile choice is a per-browser convenience: storage may be missing or throw, and then the
// page simply starts on All.
const filesPageScript = (initialProfile) => `
const chips = [...document.querySelectorAll('[data-kind-filter]')];
const profileChips = [...document.querySelectorAll('[data-profile-filter]')];
const search = document.querySelector('.fbar input');
const rows = [...document.querySelectorAll('.frow')];
const PROFILE_KEY = ${JSON.stringify(PROFILE_STORAGE_KEY)};
const known = (name) => profileChips.some((c) => c.dataset.profileFilter === name);
const stored = () => { try { return localStorage.getItem(PROFILE_KEY); } catch { return null; } };
const store = (name) => { try { localStorage.setItem(PROFILE_KEY, name); } catch {} };
let kind = 'all';
let profile = [${JSON.stringify(initialProfile || '')}, stored()].find((name) => name && known(name)) || 'all';
function apply() {
  const q = search.value.trim().toLowerCase();
  let shown = 0;
  rows.forEach((r) => { r.hidden = !((kind === 'all' || r.dataset.kind === kind) && (profile === 'all' || r.dataset.profile === profile) && (!q || r.dataset.text.includes(q))); if (!r.hidden) shown += 1; });
  chips.forEach((c) => c.classList.toggle('on', c.dataset.kindFilter === kind));
  profileChips.forEach((c) => c.classList.toggle('on', c.dataset.profileFilter === profile));
  document.querySelector('.empty').hidden = shown > 0;
}
chips.forEach((c) => c.addEventListener('click', () => { kind = c.dataset.kindFilter; apply(); }));
profileChips.forEach((c) => c.addEventListener('click', () => { profile = c.dataset.profileFilter; store(profile); apply(); }));
search.addEventListener('input', apply);
const LOADED = Date.now();
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - LOADED > ${STALE_LINKS_MS} && !search.value) location.reload(); });
apply();
`;

// baseCss is the dashboard's own stylesheet, so the page shares its palette and light mode.
// initialProfile must already be a known profile name (the server validates it) or empty.
const filesPageHtml = ({ stateDir, profiles: given, policy, index, signer, nonce, baseCss, remote, initialProfile = '' }) => {
  const profiles = given || [{ name: PRIMARY_PROFILE, label: 'Twism', stateDir }];
  const attribute = createProfileAttribution(profiles, policy);
  const files = index.list().slice(0, FILES_PAGE_LIMIT);
  const kindChips = [['all', 'All'], ['html', 'Reports'], ['video', 'Videos'], ['pdf', 'PDFs']]
    .map(([value, label]) => `<button class="chip" type="button" data-kind-filter="${value}">${label}</button>`)
    .join('');
  const profileChips =
    profiles.length > 1
      ? [{ name: 'all', label: 'All' }, ...profiles]
          .map((p) => `<button class="chip" type="button" data-profile-filter="${esc(p.name)}">${esc(p.label || p.name)}</button>`)
          .join('')
      : '';
  const chips = profileChips ? `${profileChips}<span class="fsep"></span>${kindChips}` : kindChips;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Files · Agents</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@600&display=swap" rel="stylesheet">
<style>${baseCss}${filesCss}</style></head><body${remote ? ' class="remote"' : ''}>
<div class="topbar"><div class="brand"><h1>Files</h1><span class="pill">${files.length} newest reports, videos and PDFs</span></div><div class="right"><a class="btn" href="/">← Agents</a></div></div>
<div class="fbar">${chips}<input type="search" placeholder="Filter by name, folder or task" aria-label="Filter files"></div>
<div class="flist">${files.map((f) => filesPageRow(fileRow(signer, f), attribute(f), fileProfileOf(f.real, policy), profiles)).join('')}<div class="empty" hidden>No files match.</div></div>
<script nonce="${nonce}">${filesPageScript(initialProfile)}</script></body></html>`;
};

module.exports = { filesCss, createProfileAttribution, decorateItems, filesPageHtml };
