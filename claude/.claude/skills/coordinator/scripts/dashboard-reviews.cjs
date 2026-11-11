'use strict';

// "Reviews waiting on you": the posted mr-review-autoloop reviews that still need daniel.souza's approve
// decision. pending.json is written by that skill's poller; the page only reads it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.local/state/mr-review-autoloop/pending.json');
const VERDICTS = new Set(['BLOCK_MERGE', 'REQUEST_CHANGES', 'APPROVE_WITH_NITS', 'APPROVE']);
const MR_URL = /^https:\/\/[a-z0-9.-]+\/[\w./-]+\/-\/merge_requests\/\d+$/i;
const TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

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

const reviewRowHtml = (r, now) => {
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
  return `<li class="rv"><div class="rvhead">${ref}<span class="rvtag">${tier}</span><span class="rvverdict v-${verdict.toLowerCase()}">${verdict.replace(/_/g, ' ')}</span>${dry}${when}</div>`
    + `<div class="rvtitle">${esc(r.title || '')}</div><div class="rvmeta">${counts}${decide ? ` · tell the coordinator ${decide}` : ''}</div></li>`;
};

const reviewsHtml = (reviews, now = Date.now()) => {
  if (!reviews.length) return '';
  return `<section class="reviews" aria-label="Reviews waiting on you"><div class="colhead"><span class="dot s-review"></span><h2>Reviews waiting on you</h2><span class="count">${reviews.length}</span></div>`
    + `<ul>${reviews.map((r) => reviewRowHtml(r, now)).join('')}</ul></section>`;
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
.rvtitle{margin-top:4px;color:var(--fg);overflow-wrap:anywhere}
.rvmeta{margin-top:2px;font-size:12px;color:var(--muted)}.rvmeta code{font:12px var(--mono);color:var(--text)}
@media (max-width:640px){.reviews{margin:16px 16px 0;padding:14px;border-radius:20px}.rvage{margin-left:0}}
`;

module.exports = { DEFAULT_FILE, reviewsFile, readReviews, reviewsHtml, reviewsCss };
