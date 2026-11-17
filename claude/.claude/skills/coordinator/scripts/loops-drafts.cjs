'use strict';

// Drafts a loop leaves for a decision (today the triage loop's Slack replies and Jira bugs). The
// model that wrote them read untrusted Slack text, so every field is read through a fixed shape,
// capped, and rendered as escaped text.
const fs = require('fs');
const path = require('path');
const { ActionError } = require('./dashboard-actions.cjs');
const { PRIMARY_PROFILE } = require('./profiles.cjs');

const DRAFT_ID = /^[A-Z0-9]{6,15}-\d{9,11}\.\d{6}$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE_MAX_BYTES = 64 * 1024;
const TEXT_MAX = 4000;
const SHORT_MAX = 300;
const WAITING = new Set(['pending', 'held']);
const KINDS = new Set(['real-bug', 'not-a-bug', 'data-request', 'contribute', 'noise']);
const JIRA_ACTIONS = new Set(['none', 'create', 'comment']);
const TICKET = /^TWISM-\d{1,7}$/;
const SLACK_LINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(\?[\w=&.-]*)?$/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v, max = SHORT_MAX) => (typeof v === 'string' ? v.slice(0, max) : '');

const sanitize = (raw) => {
  if (!raw || typeof raw !== 'object' || !DRAFT_ID.test(String(raw.id)) || !HASH.test(String(raw.hash))) return null;
  const jira = raw.jira && typeof raw.jira === 'object' ? raw.jira : {};
  return {
    id: raw.id,
    hash: raw.hash,
    status: str(raw.status, 20),
    createdAt: str(raw.createdAt, 40),
    channel: { id: str(raw.channel?.id, 20), name: str(raw.channel?.name, 80) },
    permalink: SLACK_LINK.test(String(raw.permalink || '')) ? raw.permalink : '',
    kind: KINDS.has(raw.kind) ? raw.kind : 'unknown',
    title: str(raw.title),
    summary: str(raw.summary, 1000),
    caseText: str(raw.caseText, TEXT_MAX),
    reply: str(raw.reply, TEXT_MAX),
    jira: {
      action: JIRA_ACTIONS.has(jira.action) ? jira.action : 'none',
      key: TICKET.test(String(jira.key || '')) ? jira.key : '',
      summary: str(jira.summary),
      description: str(jira.description, TEXT_MAX),
    },
    evidence: Array.isArray(raw.evidence) ? raw.evidence.slice(0, 12).map((e) => str(e)) : [],
    heldReason: str(raw.heldReason),
    error: str(raw.error),
    mode: raw.mode === 'guarded' ? 'guarded' : 'auto',
    dryRun: raw.dryRun === true,
  };
};

// Only regular files directly in the dir: the run that wrote them is steered by Slack text.
const readDraftFile = (dir, name) => {
  const file = path.join(dir, name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) return null;
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
};

const readDrafts = (dir) => {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && DRAFT_ID.test(n.slice(0, -5)));
  } catch {
    return [];
  }
  return names
    .map((n) => readDraftFile(dir, n))
    .filter((d) => d && WAITING.has(d.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

const findDraft = (loop, id) => {
  if (!loop.decisions || !DRAFT_ID.test(String(id))) throw new ActionError('Name a waiting draft.');
  const draft = readDraftFile(loop.decisions.dir, `${id}.json`);
  if (!draft || !WAITING.has(draft.status)) throw new ActionError('That draft is no longer waiting; reload the page.');
  return draft;
};

const KIND_LABEL = { 'real-bug': 'bug', 'not-a-bug': 'not a bug', 'data-request': 'data/CX request', contribute: 'ticket context', noise: 'noise', unknown: 'case' };

const draftCardId = (loopId, d) => `draft/${loopId}/${d.id}`;

const draftCardHtml = (loopId, d, { served = false, profile = PRIMARY_PROFILE } = {}) => {
  const jira = d.jira.action === 'create' ? 'new Jira bug' : d.jira.action === 'comment' ? `comment on ${d.jira.key}` : 'no Jira';
  const held = d.status === 'held' ? `<div class="warn">held: ${esc(d.heldReason || 'needs your approval')}</div>` : '';
  const hint = served ? '' : `<div class="line">answer it on the served dashboard</div>`;
  return `<div class="card ask dfcard" data-id="${esc(draftCardId(loopId, d))}" data-profile="${esc(profile)}" data-draft="${esc(d.id)}" data-loop="${esc(loopId)}" data-updated="${Math.floor((Date.parse(d.createdAt) || Date.now()) / 1000)}">`
    + `<h4>${esc(d.title || 'Triage draft')}</h4>`
    + `<div class="row"><span class="tag">triage draft</span><span class="tag">${esc(d.channel.name || d.channel.id)}</span><span class="tag">${esc(KIND_LABEL[d.kind])}</span>${d.dryRun ? '<span class="tag">dry run</span>' : ''}</div>`
    + `<div class="goal">${esc(d.summary)}</div><div class="line">Slack reply as the app · ${esc(jira)}</div>${held}${hint}`
    + `<div class="foot"><span class="age">${esc(d.createdAt.slice(11, 16))}</span><span class="acts">${served ? '<button class="mini" type="button">Open</button>' : ''}</span></div></div>`;
};

const draftsCss = `
.dfcard h4{word-break:break-word}
.drawer.draft{width:640px}
.dfbox{font-size:13px;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:14px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.drawer textarea.dfedit{width:100%;min-height:180px;background:var(--surface);color:var(--fg);border:1px solid var(--green-30);border-radius:14px;padding:10px 12px;font:13px/1.5 var(--body);resize:vertical}
.dfbar{position:sticky;bottom:0;margin:20px -28px -24px;padding:12px 28px calc(12px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--surface);border-top:1px solid var(--line)}
@media (max-width:640px){.drawer.draft{width:100vw;border-left:0}.dfbar{margin:20px -16px -20px;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}.drawer textarea.dfedit{font-size:16px}}
`;

module.exports = { DRAFT_ID, HASH, TEXT_MAX, sanitize, readDrafts, findDraft, draftCardHtml, draftCardId, draftsCss };
