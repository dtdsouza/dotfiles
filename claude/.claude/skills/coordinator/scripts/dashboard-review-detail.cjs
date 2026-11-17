'use strict';

// Everything the review panel shows, read from one waiting review's dir. The review session wrote
// most of these files and the MR author steers it, so every file is opened only if its real path
// stays inside the review dir (a planted symlink reads as missing), sizes are capped, and text is
// returned as data for the page to escape.
const fs = require('fs');
const path = require('path');
const { ActionError } = require('./dashboard-actions.cjs');
const { MR_URL, TIERS, VERDICTS, isInside, readReviews, reviewsFile, validTarget } = require('./dashboard-reviews.cjs');
const { TICKET } = require('./dashboard-jira.cjs');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SNIPPET_CONTEXT_LINES = 8;
const SNIPPET_LINE_CHARS = 240;
const MAX_FINDINGS = 60;
const MAX_FILES = 200;
const MAX_COMMITS = 50;
const MAX_REASONS = 12;
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT']);
const WHERE = new Set(['local', 'duplicate', 'inline', 'note']);
const RECHECK = new Set(['holds', 'does_not_hold']);
const TEXT_LIMITS = { title: 300, body: 4000, suggested_fix: 2000, summary: 4000, description: 3000, error: 200, short: 200 };

const text = (value, max = TEXT_LIMITS.short) => (typeof value === 'string' ? value.slice(0, max) : '');
const int = (value) => (Number.isInteger(value) ? value : null);

const realInside = (file, root) => {
  try {
    const real = fs.realpathSync(file);
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
};

const readCapped = (file, root, max = MAX_FILE_BYTES) => {
  const real = realInside(file, root);
  if (!real) return null;
  try {
    const stat = fs.statSync(real);
    return stat.isFile() && stat.size <= max ? fs.readFileSync(real, 'utf8') : null;
  } catch {
    return null;
  }
};

const readJsonIn = (root, name) => {
  const raw = readCapped(path.join(root, name), root);
  if (raw === null) return null;
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
};

const snippetOf = (sourceRoot, finding) => {
  if (typeof finding.path !== 'string' || !finding.path || finding.path.includes('\0') || !sourceRoot) return null;
  const raw = readCapped(path.join(sourceRoot, finding.path), sourceRoot, MAX_SOURCE_BYTES);
  if (raw === null) return null;
  const lines = raw.split('\n');
  const center = Number.isInteger(finding.line) && finding.line > 0 ? finding.line : 1;
  const start = Math.max(1, center - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, center + SNIPPET_CONTEXT_LINES);
  return { start, line: center, lines: lines.slice(start - 1, end).map((l) => l.slice(0, SNIPPET_LINE_CHARS)) };
};

const findingsOf = (dir, doc, posted, recheck) => {
  const sourceRoot = realInside(path.join(dir, 'context', 'files'), dir);
  const rows = new Map((Array.isArray(posted?.findings) ? posted.findings : []).filter((r) => r && Number.isInteger(r.index)).map((r) => [r.index, r]));
  return (Array.isArray(doc?.findings) ? doc.findings : []).slice(0, MAX_FINDINGS).map((f, index) => {
    const row = rows.get(index) || {};
    const verdict = recheck && recheck[String(index)];
    return {
      index,
      severity: SEVERITIES.has(f?.severity) ? f.severity : 'UNKNOWN',
      perspective: text(f?.perspective),
      rule: text(f?.rule),
      path: text(f?.path, 500),
      line: int(f?.line),
      title: text(f?.title, TEXT_LIMITS.title),
      body: text(f?.body, TEXT_LIMITS.body),
      suggested_fix: text(f?.suggested_fix, TEXT_LIMITS.suggested_fix),
      recheck: RECHECK.has(verdict) ? verdict : null,
      where: WHERE.has(row.where) ? row.where : null,
      note_id: int(row.note_id),
      error: text(row.error, TEXT_LIMITS.error),
      snippet: f && typeof f === 'object' ? snippetOf(sourceRoot, f) : null,
    };
  });
};

const liveOf = (doc) => {
  if (!doc) return null;
  const threads = doc.our_threads && typeof doc.our_threads === 'object' ? doc.our_threads : {};
  return {
    state: text(doc.state, 20),
    head_moved: doc.head_moved === true,
    pipeline: text(doc.pipeline, 30),
    approved_by: (Array.isArray(doc.approved_by) ? doc.approved_by : []).map((u) => text(u, 80)).filter(Boolean),
    approvals_left: int(doc.approvals_left),
    fetched_at: text(doc.fetched_at, 40),
    our_threads: { threads: int(threads.threads) || 0, resolved: int(threads.resolved) || 0, replies: int(threads.replies) || 0 },
  };
};

const filesOf = (raw) =>
  (raw || '')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .slice(0, MAX_FILES)
    .map((line) => {
      const [file, category, added, removed, flags] = line.split('\t');
      return { path: text(file, 500), category: text(category, 30), added: Number.parseInt(added, 10) || 0, removed: Number.parseInt(removed, 10) || 0, flags: text(flags, 60) };
    });

const jiraOf = (raw) => [...new Set([...(raw || '').matchAll(/^- (TWISM-\d{1,6}):/gm)].map((m) => m[1]))].filter((k) => TICKET.test(k)).slice(0, 10);

const reviewDetail = (query, { file = reviewsFile() } = {}) => {
  if (!validTarget(query)) throw new ActionError('Name a waiting review and its head sha.');
  const entry = readReviews(file).find((r) => r.ref === query.ref && r.head_sha === query.head_sha);
  if (!entry) throw new ActionError(`${query.ref} at ${query.head_sha.slice(0, 8)} is no longer waiting on you; reload the page.`);
  if (typeof entry.dir !== 'string' || !isInside(entry.dir, path.join(path.dirname(file), 'reviews'))) {
    throw new ActionError(`${query.ref}: its review folder is not under the autoloop state.`);
  }
  const dir = fs.realpathSync(entry.dir);
  const doc = readJsonIn(dir, 'findings.json');
  const posted = readJsonIn(dir, 'posted.json');
  const meta = readJsonIn(dir, 'meta.json') || {};
  const triage = readJsonIn(dir, 'triage.json') || {};
  const mr = readJsonIn(dir, path.join('context', 'mr.json')) || {};
  return {
    ref: entry.ref,
    head_sha: entry.head_sha,
    title: text(meta.title || entry.title, TEXT_LIMITS.title),
    url: MR_URL.test(entry.url || '') ? entry.url : '',
    tier: TIERS.has(entry.tier) ? entry.tier : '?',
    verdict: VERDICTS.has(doc?.verdict) ? doc.verdict : 'UNKNOWN',
    summary: text(doc?.summary, TEXT_LIMITS.summary),
    dry_run: meta.dry_run === true,
    reviewed_at: text(entry.reviewed_at, 40),
    posted_known: posted !== null,
    findings: findingsOf(dir, doc, posted, readJsonIn(dir, 'recheck.json')),
    live: liveOf(readJsonIn(dir, 'live.json')),
    triage: { tier_name: text(triage.tier_name, 40), reasons: (Array.isArray(triage.reasons) ? triage.reasons : []).slice(0, MAX_REASONS).map((r) => text(r)).filter(Boolean) },
    mr: {
      author: text(mr.author, 80),
      source_branch: text(mr.source_branch),
      target_branch: text(mr.target_branch),
      labels: (Array.isArray(mr.labels) ? mr.labels : []).slice(0, 20).map((l) => text(l, 80)).filter(Boolean),
      draft: mr.draft === true,
      description: text(mr.description, TEXT_LIMITS.description),
    },
    files: filesOf(readCapped(path.join(dir, 'context', 'files.tsv'), dir)),
    commits: (readCapped(path.join(dir, 'context', 'commits.txt'), dir) || '').split('\n').filter(Boolean).slice(0, MAX_COMMITS).map((l) => text(l, 300)),
    jira: jiraOf(readCapped(path.join(dir, 'context', 'jira.md'), dir)),
  };
};

module.exports = { reviewDetail };
