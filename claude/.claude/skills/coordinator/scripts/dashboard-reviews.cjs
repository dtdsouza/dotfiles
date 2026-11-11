'use strict';

// "Reviews waiting on you": the posted mr-review-autoloop reviews that still need daniel.souza's approve
// decision. pending.json is written by that skill's poller. The served page can record an approve through
// that skill's decide.py; the poller then approves at the reviewed head sha.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ActionError } = require('./dashboard-actions.cjs');

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

const reviewRowHtml = (r, now, served) => {
  const iid = Number.isInteger(r.iid) ? r.iid : Number.parseInt(String(r.ref).split('!')[1], 10);
  const verdict = VERDICTS.has(r.verdict) ? r.verdict : 'UNKNOWN';
  const tier = TIERS.has(r.tier) ? r.tier : '?';
  const posted = r.posted || {};
  const counts = [
    count(Number(posted.inline) || 0, 'inline', 'inline'),
    count(Number(posted.note) || 0, 'in a note', 'in a note'),
    count(Number(posted.local) || 0, 'kept local', 'kept local'),
  ].join(' · ');
  const ref = MR_URL.test(r.url || '')
    ? `<a class="rvref" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.ref)}</a>`
    : `<span class="rvref">${esc(r.ref)}</span>`;
  const dry = r.dry_run ? '<span class="rvtag">dry run</span>' : '';
  const when = r.reviewed_at ? `<span class="rvage">${esc(age(r.reviewed_at, now))}</span>` : '';
  const decide = Number.isInteger(iid) ? `<code>approve !${iid}</code> or <code>skip !${iid}</code>` : '';
  const approve = served && REF.test(r.ref) && HEAD_SHA.test(String(r.head_sha || ''))
    ? `<button class="mini approve" type="button" data-approve="${esc(r.ref)}" data-sha="${esc(r.head_sha)}" title="Approve at ${esc(String(r.head_sha).slice(0, 8))}; the poller sends it to GitLab on its next tick">Approve</button>`
    : '';
  return `<li class="rv"><div class="rvhead">${ref}<span class="rvtag">${tier}</span><span class="rvverdict v-${verdict.toLowerCase()}">${verdict.replace(/_/g, ' ')}</span>${dry}${when}${approve}</div>`
    + `<div class="rvtitle">${esc(r.title || '')}</div><div class="rvmeta">${counts}${decide ? ` · tell the coordinator ${decide}` : ''}</div></li>`;
};

const reviewsHtml = (reviews, now = Date.now(), { served = false } = {}) => {
  if (!reviews.length) return '';
  return `<section class="reviews" aria-label="Reviews waiting on you"><div class="colhead"><span class="dot s-review"></span><h2>Reviews waiting on you</h2><span class="count">${reviews.length}</span></div>`
    + `<ul>${reviews.map((r) => reviewRowHtml(r, now, served)).join('')}</ul></section>`;
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

const STATES = { posted: 'waiting', approved: 'approved', approve_failed: 'failed', declined: 'declined' };
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
.reviews{margin:20px 40px 0;padding:16px 20px;border:1px solid var(--line);border-radius:24px;background:var(--soft)}
.reviews ul{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:10px}
.rv{padding:10px 0;border-top:1px solid var(--line)}.rv:first-child{border-top:0}
.rvhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rvref{font:500 14px var(--mono);color:var(--green-ink)}a.rvref:hover{text-decoration:underline}
.rvtag{font:500 11px var(--mono);padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.rvverdict{font:600 11px var(--body);letter-spacing:.04em;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.v-block_merge,.v-request_changes{color:var(--red);border-color:var(--red-45)}.v-approve,.v-approve_with_nits{color:var(--green-ink);border-color:var(--green-30)}.v-unknown{color:var(--amber)}
.rvage{margin-left:auto;font-size:12px;color:var(--muted)}
.rv .approve{border-color:var(--green-30);color:var(--green-ink);font-weight:600;padding:3px 14px}.rv .approve:hover{border-color:var(--green-ink)}.rv .approve.armed{background:var(--green-12)}
.rv .approve .spin{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:rvspin .8s linear infinite}
.rv.approving .approve[disabled]{opacity:1;cursor:progress}
.rv{transition:opacity .4s}.rv.gone{opacity:0}
@keyframes rvspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rv .approve .spin{animation-duration:2.4s}.rv{transition:none}}
.rvtitle{margin-top:4px;color:var(--fg);overflow-wrap:anywhere}
.rvmeta{margin-top:2px;font-size:12px;color:var(--muted)}.rvmeta code{font:12px var(--mono);color:var(--text)}
@media (max-width:640px){.reviews{margin:16px 16px 0;padding:14px;border-radius:20px}.rvage{margin-left:0}}
`;

module.exports = { DEFAULT_FILE, DEFAULT_DECIDE, reviewsFile, readReviews, reviewsHtml, reviewsCss, approveReview, reviewStatus };
