'use strict';

// The review panel: a drawer variant the served page opens from a review card. It fetches
// /api/reviews/detail and renders every field through esc(); the MR author steers that text.
// Uses CSRF, drawer, esc, closeDrawer and JIRA_BROWSE from the scripts it is appended to.

const reviewDrawerCss = `
.drawer.review{width:640px}
.rvf{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin:0 0 8px;background:var(--soft)}
.rvf summary{cursor:pointer;display:flex;gap:8px;align-items:baseline;list-style:none}.rvf summary::-webkit-details-marker{display:none}
.rvft{color:var(--fg);font-size:13px;word-break:break-word}
.sev{font:600 10px/16px var(--body);letter-spacing:.05em;padding:0 6px;border-radius:6px;border:1px solid var(--line);white-space:nowrap}
.sev-critical,.sev-high{color:var(--red);border-color:var(--red-45)}.sev-medium{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 45%,transparent)}.sev-low,.sev-nit,.sev-unknown{color:var(--muted)}
.rvloc{font:11px var(--mono);color:var(--muted);margin-top:6px;word-break:break-all}.rvloc a{color:var(--green-ink)}
.rvbody{font-size:13px;color:var(--fg);margin-top:8px;white-space:pre-wrap;word-break:break-word}
.rvfix{font-size:12px;color:var(--text);margin-top:6px;white-space:pre-wrap;word-break:break-word}.rvfix b{color:var(--green-ink);font-weight:600;margin-right:4px}
pre.snip{margin-top:8px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre;word-break:normal;border-radius:10px}
.snip span{display:block}.snip span.hit{background:var(--green-12)}.snip i{display:inline-block;width:3.5em;color:var(--muted);font-style:normal;user-select:none}
.rvlive{font-size:12px;color:var(--text);margin:10px 0 0}
.rvfiles div{display:flex;justify-content:space-between;gap:10px;font:11px var(--mono);padding:4px 0;border-bottom:1px solid var(--line)}.rvfiles span:first-child{word-break:break-all}
.rvdesc{margin-top:10px}.rvdesc summary{cursor:pointer;font-size:12px;color:var(--muted)}
.rvbar{position:sticky;bottom:0;margin:20px -28px -24px;padding:12px 28px calc(12px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center;background:var(--surface);border-top:1px solid var(--line)}
.rvbar .approve{padding:6px 18px;font-size:13px}
@media (max-width:640px){.drawer.review{width:100vw;border-left:0}.rvbar{margin:20px -16px -20px;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}}
`;

const reviewDrawerScript = `
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT', 'UNKNOWN'];
const OPEN_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM']);
const WHERE_LABEL = { inline: 'inline comment', note: 'in the MR note', local: 'kept local', duplicate: 'posted earlier' };
const RECHECK_LABEL = { holds: 're-check: holds', does_not_hold: 're-check: does not hold' };
let reviewShown = '';
const reviewCardFor = (id) => [...document.querySelectorAll('.rvcard')].find((c) => c.dataset.id === id);
const timeOf = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : t.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }); };
const outLink = (href, label) => '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
const noteHref = (d, f) => (d.url && Number.isInteger(f.note_id) ? d.url + '#note_' + f.note_id : '');
const snippetHtml = (s) => (!s ? '' : '<pre class="snip">' + s.lines.map((l, i) => '<span' + (s.start + i === s.line ? ' class="hit"' : '') + '><i>' + (s.start + i) + '</i>' + esc(l) + '</span>').join('') + '</pre>');
function findingHtml(d, f) {
  const href = noteHref(d, f);
  const label = f.where ? esc(WHERE_LABEL[f.where]) : 'where it went is not recorded';
  const where = [href ? outLink(href, label) : label, f.recheck ? RECHECK_LABEL[f.recheck] : '', f.error ? 'inline post failed: ' + esc(f.error) : ''].filter(Boolean).join(' \\u00b7 ');
  const loc = (f.path ? esc(f.path) + (f.line ? ':' + f.line : '') : 'MR level') + ' \\u00b7 ' + esc(f.perspective) + ' \\u00b7 ' + esc(f.rule);
  return '<details class="rvf"' + (OPEN_SEVERITIES.has(f.severity) ? ' open' : '') + '><summary><span class="sev sev-' + esc(f.severity.toLowerCase()) + '">' + esc(f.severity) + '</span><span class="rvft">' + esc(f.title) + '</span></summary>'
    + '<div class="rvloc">' + loc + '</div><div class="rvloc">' + where + '</div><div class="rvbody">' + esc(f.body) + '</div>'
    + (f.suggested_fix ? '<div class="rvfix"><b>Fix</b>' + esc(f.suggested_fix) + '</div>' : '') + snippetHtml(f.snippet) + '</details>';
}
function liveHtml(live) {
  if (!live) return '<div class="hint">No GitLab snapshot yet: the poller writes one on its next tick.</div>';
  const t = live.our_threads;
  const bits = ['MR ' + esc(live.state || '?'), 'pipeline ' + esc(live.pipeline || 'none'), live.approved_by.length ? 'approved by ' + esc(live.approved_by.join(', ')) : 'no approvals yet',
    t.threads ? t.threads + ' of our threads, ' + t.resolved + ' resolved, ' + t.replies + ' replies' : ''];
  return (live.head_moved ? '<div class="askbox flag">Pushed since the review: GitLab will refuse this approve. A new head gets its own review.</div>' : '')
    + '<div class="rvlive">' + bits.filter(Boolean).join(' \\u00b7 ') + '<span class="age"> \\u00b7 as of ' + esc(timeOf(live.fetched_at)) + '</span></div>';
}
const reviewHeadHtml = (tier) => '<div class="dhead"><span class="pill"><span class="dot s-review"></span>review' + (tier ? ' \\u00b7 ' + esc(tier) : '') + '</span><button class="x" title="Close (Esc)">\\u2715</button></div>';
const reviewBarHtml = (ref, sha, url) => '<div class="rvbar"><button class="mini approve" type="button" data-approve="' + esc(ref) + '" data-sha="' + esc(sha) + '">Approve</button>'
  + (url ? '<a class="mini" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open MR</a>' : '') + '<span class="age">at ' + esc(sha.slice(0, 8)) + '</span></div>';
function reviewDrawerHtml(d) {
  const sorted = d.findings.slice().sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.index - b.index);
  const jira = d.jira.map((k) => '<a class="tag jira" href="' + esc(JIRA_BROWSE + k) + '" target="_blank" rel="noopener noreferrer">' + esc(k) + '</a>').join('');
  const triage = esc(d.tier + (d.triage.tier_name ? ' ' + d.triage.tier_name : '')) + (d.triage.reasons.length ? ': ' + esc(d.triage.reasons.join(', ')) : '');
  const mr = '<div class="kv"><span>Author</span><span>' + esc(d.mr.author || '-') + '</span><span>Branch</span><span>' + esc(d.mr.source_branch) + ' \\u2192 ' + esc(d.mr.target_branch) + '</span>'
    + (d.mr.labels.length ? '<span>Labels</span><span>' + esc(d.mr.labels.join(', ')) + '</span>' : '') + '<span>Reviewed head</span><span>' + esc(d.head_sha.slice(0, 8)) + '</span><span>Triage</span><span>' + triage + '</span></div>';
  const files = d.files.length ? '<h5>Files \\u00b7 ' + d.files.length + '</h5><div class="rvfiles">' + d.files.map((f) => '<div><span>' + esc(f.path) + '</span><span class="age">+' + f.added + ' \\u2212' + f.removed + '</span></div>').join('') + '</div>' : '';
  return reviewHeadHtml(d.tier) + '<h2>' + esc(d.ref) + '</h2><div class="goal">' + esc(d.title) + '</div>'
    + '<div class="row"><span class="rvverdict v-' + esc(d.verdict.toLowerCase()) + '">' + esc(d.verdict.replace(/_/g, ' ')) + '</span>' + jira + (d.dry_run ? '<span class="tag">dry run</span>' : '') + '</div>'
    + liveHtml(d.live) + (d.summary ? '<h5>Summary</h5><div class="askbox">' + esc(d.summary) + '</div>' : '')
    + '<h5>Findings \\u00b7 ' + d.findings.length + '</h5>' + (d.posted_known ? '' : '<div class="hint">Posted before posted.json existed: where each finding went is not recorded.</div>')
    + (sorted.length ? sorted.map((f) => findingHtml(d, f)).join('') : '<div class="hint">No findings.</div>')
    + '<h5>Merge request</h5>' + mr + (d.mr.description ? '<details class="rvdesc"><summary>MR description</summary><div class="rvbody">' + esc(d.mr.description) + '</div></details>' : '') + files
    + (d.commits.length ? '<h5>Commits</h5><pre>' + d.commits.map(esc).join('\\n') + '</pre>' : '')
    + '<div class="hint">MR and review text is shown as plain text. GitLab links need the VPN.</div>';
}
const showingReview = (id) => reviewShown === id && drawer.classList.contains('review');
async function openReviewDrawer(id) {
  const card = reviewCardFor(id);
  if (!card || !card.dataset.sha) return;
  if (window.dashboardDrawerClosed) window.dashboardDrawerClosed();
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c === card));
  const ref = card.dataset.review;
  const sha = card.dataset.sha;
  const mrLink = card.querySelector('a.mini[href]');
  const bar = reviewBarHtml(ref, sha, mrLink ? mrLink.getAttribute('href') : '');
  reviewShown = id;
  drawer.classList.add('review');
  drawer.innerHTML = reviewHeadHtml('') + '<h2>' + esc(ref) + '</h2><div class="hint">Loading the review\\u2026</div>' + bar;
  document.body.classList.add('open');
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  try {
    const res = await fetch('/api/reviews/detail?ref=' + encodeURIComponent(ref) + '&head_sha=' + encodeURIComponent(sha), { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Dashboard-Token': CSRF } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.reload) throw new Error('The dashboard server restarted: reload the page.');
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load the review (HTTP ' + res.status + ').');
    if (showingReview(id)) drawer.innerHTML = reviewDrawerHtml(data) + bar;
  } catch (err) {
    if (showingReview(id)) drawer.innerHTML = reviewHeadHtml('') + '<h2>' + esc(ref) + '</h2><div class="askbox blocked">' + esc(err.message) + '</div>' + bar;
  }
}
const leaveReview = () => { reviewShown = ''; drawer.classList.remove('review'); };
const baseDrawerOpened = window.dashboardDrawerOpened;
const baseDrawerClosed = window.dashboardDrawerClosed;
window.dashboardDrawerOpened = (a) => { leaveReview(); if (baseDrawerOpened) baseDrawerOpened(a); };
window.dashboardDrawerClosed = () => { leaveReview(); if (baseDrawerClosed) baseDrawerClosed(); };
window.dashboardLeaveReview = leaveReview;
window.openReviewDrawer = openReviewDrawer;
if (location.hash.startsWith('#review')) openReviewDrawer(decodeURIComponent(location.hash.slice(1)));
`;

module.exports = { reviewDrawerCss, reviewDrawerScript };
