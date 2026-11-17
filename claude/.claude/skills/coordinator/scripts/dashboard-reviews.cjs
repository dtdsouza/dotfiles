'use strict';

// The posted mr-review-autoloop reviews that still need daniel.souza's approve decision, shown as
// Needs-you cards in the Twism lane. pending.json is written by that skill's poller. The served page can record an approve through
// that skill's decide.py; the poller then approves at the reviewed head sha.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ActionError } = require('./dashboard-actions.cjs');
const { PRIMARY_PROFILE } = require('./profiles.cjs');
const { TICKET, ticketTagsHtml } = require('./dashboard-jira.cjs');

const DEFAULT_FILE = path.join(os.homedir(), '.local/state/mr-review-autoloop/pending.json');
const VERDICTS = new Set(['BLOCK_MERGE', 'REQUEST_CHANGES', 'APPROVE_WITH_NITS', 'APPROVE']);
const MR_URL = /^https:\/\/[a-z0-9.-]+\/[\w./-]+\/-\/merge_requests\/\d+$/i;
const TIERS = new Set(['T0', 'T1', 'T2', 'T3']);
const REF = /^[\w.\/-]+![0-9]+$/;
const HEAD_SHA = /^[0-9a-f]{7,40}$/;
const DEFAULT_DECIDE = path.join(os.homedir(), '.claude/skills/mr-review-autoloop/scripts/decide.py');
const DECIDE_TIMEOUT_MS = 30000;
// decide.py needs no secret; the user-bus variables let it trigger an immediate poll tick.
const DECIDE_ENV = ['HOME', 'PATH', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const reviewsFile = (env = process.env) => env.COORDINATOR_DASHBOARD_REVIEWS_FILE || DEFAULT_FILE;

// A missing or broken file means no section, never a broken page.
const readReviews = (file = reviewsFile()) => {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(doc.reviews) ? doc.reviews.filter((r) => r && typeof r.ref === 'string') : [];
  } catch {
    return [];
  }
};

const age = (iso, now) => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const FAILED_PIPELINES = new Set(['failed', 'canceled']);
const SHORT_SHA = 8;

const reviewIid = (r) => (Number.isInteger(r.iid) ? r.iid : Number.parseInt(String(r.ref).split('!')[1], 10));
const usableSha = (r) => HEAD_SHA.test(String(r.head_sha || ''));
// The card's id doubles as the drawer's URL hash: #review/<ref>@<sha8>.
const reviewCardId = (r) => `review/${r.ref}@${usableSha(r) ? String(r.head_sha).slice(0, SHORT_SHA) : '-'}`;
const postedCounts = (posted = {}) =>
  [count(Number(posted.inline) || 0, 'inline', 'inline'), count(Number(posted.note) || 0, 'in a note', 'in a note'), count(Number(posted.local) || 0, 'kept local', 'kept local')].join(' · ');

// live.json is the poller's last look at GitLab; the phone cannot ask GitLab itself.
const liveHintsHtml = (live) => {
  if (!live || typeof live !== 'object') return '';
  const warns = [
    live.head_moved === true ? 'pushed since the review: Approve will be refused' : '',
    FAILED_PIPELINES.has(live.pipeline) ? `pipeline ${live.pipeline}` : '',
  ].filter(Boolean);
  const approvers = Array.isArray(live.approved_by) ? live.approved_by.filter((u) => typeof u === 'string' && u) : [];
  return warns.map((w) => `<div class="warn">${esc(w)}</div>`).join('') + (approvers.length ? `<div class="line">approved by ${esc(approvers.join(', '))}</div>` : '');
};

const reviewCardHtml = (r, now = Date.now(), { served = false, profile = PRIMARY_PROFILE } = {}) => {
  const iid = reviewIid(r);
  const verdict = VERDICTS.has(r.verdict) ? r.verdict : 'UNKNOWN';
  const tier = TIERS.has(r.tier) ? r.tier : '?';
  const mrLink = MR_URL.test(r.url || '') ? `<a class="mini" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">MR</a>` : '';
  const tickets = ticketTagsHtml((Array.isArray(r.jira) ? r.jira : []).filter((key) => TICKET.test(String(key))));
  const dry = r.dry_run ? '<span class="tag">dry run</span>' : '';
  const when = r.reviewed_at ? `reviewed ${age(r.reviewed_at, now)}` : 'reviewed';
  const approve = served && REF.test(r.ref) && usableSha(r)
    ? `<button class="mini approve" type="button" data-approve="${esc(r.ref)}" data-sha="${esc(r.head_sha)}" title="Approve at ${esc(String(r.head_sha).slice(0, SHORT_SHA))}; the poller sends it to GitLab on its next tick">Approve</button>`
    : '';
  const decide = !served && Number.isInteger(iid) ? `<div class="line">tell the coordinator <code>approve !${iid}</code> or <code>skip !${iid}</code></div>` : '';
  const sha = usableSha(r) ? ` data-review="${esc(r.ref)}" data-sha="${esc(r.head_sha)}"` : '';
  return `<div class="card ask rvcard" data-id="${esc(reviewCardId(r))}" data-profile="${esc(profile)}"${sha} data-updated="${Math.floor((Date.parse(r.reviewed_at) || now) / 1000)}">`
    + `<h4><span class="rvref">${esc(r.ref)}</span></h4>`
    + `<div class="row"><span class="tag">review</span><span class="tag">${tier}</span><span class="rvverdict v-${verdict.toLowerCase()}">${verdict.replace(/_/g, ' ')}</span>${tickets}${dry}</div>`
    + `<div class="goal">${esc(r.title || '')}</div><div class="line">${postedCounts(r.posted)}</div>${liveHintsHtml(r.live)}${decide}`
    + `<div class="foot"><span class="age">${esc(when)}</span><span class="acts">${approve}${mrLink}</span></div></div>`;
};

const validTarget = ({ ref, head_sha: headSha }) => typeof ref === 'string' && REF.test(ref) && typeof headSha === 'string' && HEAD_SHA.test(headSha);

const isInside = (dir, root) => {
  try {
    const real = fs.realpathSync(dir);
    return real.startsWith(fs.realpathSync(root) + path.sep);
  } catch {
    return false;
  }
};

const runDecide = (command, args) =>
  new Promise((resolve, reject) => {
    const env = Object.fromEntries(DECIDE_ENV.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    execFile(command[0], [...command.slice(1), ...args], { env, cwd: os.homedir(), timeout: DECIDE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new ActionError(`decide.py did not record it: ${String(stderr || err.message).trim().split('\n').pop().slice(0, 200)}`));
      resolve(String(stdout).trim().split('\n').pop());
    });
  });

// The click names a ref and the head sha the page showed. Both must match a review still waiting in
// pending.json, so a re-review that replaced it, or a stale page, records nothing.
const approveReview = async (body, { file = reviewsFile(), command = ['python3', DEFAULT_DECIDE] } = {}) => {
  if (!validTarget(body)) throw new ActionError('Name a waiting review and its head sha.');
  const { ref, head_sha: headSha } = body;
  const entry = readReviews(file).find((r) => r.ref === ref && r.head_sha === headSha);
  if (!entry) throw new ActionError(`${ref} at ${headSha.slice(0, 8)} is no longer waiting on you; reload the page.`);
  if (typeof entry.dir !== 'string' || !isInside(entry.dir, path.join(path.dirname(file), 'reviews'))) {
    throw new ActionError(`${ref}: its review folder is not under the autoloop state; approve it from the coordinator.`);
  }
  const message = await runDecide(command, ['answer', entry.dir, 'yes']);
  return { task: `review ${ref}`, text: `approve ${ref} at ${headSha.slice(0, 8)}`, message };
};

const STATES = { posted: 'waiting', approved: 'approved', approve_failed: 'failed', declined: 'declined', merged: 'merged', closed: 'closed' };
const LOG_TAIL_BYTES = 64 * 1024;
const REASON_MAX = 300;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const tail = (file, bytes) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const lastFailureReason = (logFile, ref) => {
  const lines = tail(logFile, LOG_TAIL_BYTES).split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('approve-failed')) continue;
    try {
      const event = JSON.parse(line);
      if (event.event === 'approve-failed' && event.ref === ref) return String(event.reason || '').slice(0, REASON_MAX);
    } catch {
      // The tail's first line is usually cut mid-record.
    }
  }
  return '';
};

// state.json is the poller's own record next to pending.json; the page polls this after an approve
// to learn whether GitLab accepted it.
const reviewStatus = (query, { file = reviewsFile() } = {}) => {
  if (!validTarget(query)) throw new ActionError('Name a waiting review and its head sha.');
  const root = path.dirname(file);
  const runs = readJson(path.join(root, 'state.json'))?.runs;
  const run = Array.isArray(runs) ? runs.filter((r) => r && r.ref === query.ref && typeof r.head_sha === 'string' && r.head_sha.startsWith(query.head_sha)).pop() : null;
  const state = (run && STATES[run.status]) || 'unknown';
  return state === 'failed' ? { state, reason: lastFailureReason(path.join(root, 'poll.log'), query.ref) } : { state };
};

const reviewsCss = `
.rvref{font:500 14px var(--mono);color:var(--green-ink);word-break:break-all}
.rvverdict{font:600 11px/18px var(--body);letter-spacing:.04em;padding:1px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.v-block_merge,.v-request_changes{color:var(--red);border-color:var(--red-45)}.v-approve,.v-approve_with_nits{color:var(--green-ink);border-color:var(--green-30)}.v-unknown{color:var(--amber)}
.rvcard .line code{font:12px var(--mono);color:var(--text)}
.approve{border-color:var(--green-30);color:var(--green-ink);font-weight:600;padding:3px 14px}.approve:hover{border-color:var(--green-ink)}.approve.armed{background:var(--green-12)}
.approve .spin{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:rvspin .8s linear infinite}
.approving .approve[disabled]{opacity:1;cursor:progress}
.rvcard{transition:opacity .4s}.rvcard.gone{opacity:0}
@keyframes rvspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.approve .spin{animation-duration:2.4s}.rvcard{transition:none}}
`;

module.exports = { DEFAULT_FILE, DEFAULT_DECIDE, REF, HEAD_SHA, MR_URL, VERDICTS, TIERS, reviewsFile, readReviews, reviewCardHtml, reviewCardId, reviewsCss, approveReview, reviewStatus, validTarget, isInside, readJson };
