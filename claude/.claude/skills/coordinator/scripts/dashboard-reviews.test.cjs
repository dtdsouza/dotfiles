const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readReviews, reviewStatus, reviewsFile, reviewCardHtml } = require('./dashboard-reviews.cjs');
const { render } = require('./dashboard.cjs');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const review = (over = {}) => ({
  ref: 'platform/monorepo!1188',
  iid: 1188,
  title: 'fix: wix 404',
  url: 'https://code.twism.info/platform/monorepo/-/merge_requests/1188',
  tier: 'T3',
  verdict: 'APPROVE_WITH_NITS',
  posted: { inline: 2, note: 0, local: 6 },
  reviewed_at: '2026-11-11T13:00:00+00:00',
  dry_run: false,
  ...over,
});

const withFile = (content, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
  const file = path.join(dir, 'pending.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('readReviews', () => {
  test('reads the reviews of pending.json', () => {
    withFile(JSON.stringify({ generated_at: 'x', reviews: [review()] }), (file) => {
      assert.deepEqual(readReviews(file).map((r) => r.ref), ['platform/monorepo!1188']);
    });
  });

  test('a missing or broken file is no reviews, not an error', () => {
    withFile(undefined, (file) => assert.deepEqual(readReviews(file), []));
    withFile('{not json', (file) => assert.deepEqual(readReviews(file), []));
    withFile('{"reviews": "nope"}', (file) => assert.deepEqual(readReviews(file), []));
  });

  test('the file can be moved with an env var', () => {
    assert.equal(reviewsFile({ COORDINATOR_DASHBOARD_REVIEWS_FILE: '/x/p.json' }), '/x/p.json');
    assert.match(reviewsFile({}), /mr-review-autoloop\/pending\.json$/);
  });
});

const SERVED = { csrf: 'x', nonce: 'n', closable: new Set(), replyable: new Set(), remote: false, files: false };
const SHA = 'dc816155f198034826fd76a714ff532c80acd616';

describe('reviewCardHtml', () => {
  test('a Needs-you card with its MR link, tier, verdict, counts and age', () => {
    const html = reviewCardHtml(review({ head_sha: SHA }), NOW);
    assert.match(html, /^<div class="card ask rvcard" data-id="review\/platform\/monorepo!1188@dc816155"/);
    assert.match(html, /href="https:\/\/code\.twism\.info\/platform\/monorepo\/-\/merge_requests\/1188"/);
    assert.match(html, />T3</);
    assert.match(html, /APPROVE WITH NITS/);
    assert.match(html, /2 inline · 0 in a note · 6 kept local/);
    assert.match(html, /reviewed 2 h ago/);
  });

  test('escapes the MR title, which the MR author controls', () => {
    const html = reviewCardHtml(review({ title: '<img src=x onerror=alert(1)>' }), NOW);
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('links only a GitLab MR url, and only known verdicts and tiers', () => {
    const html = reviewCardHtml(review({ url: 'javascript:alert(1)', verdict: '<b>x</b>', tier: '<i>' }), NOW);
    assert.ok(!html.includes('javascript:'));
    assert.ok(!html.includes('<b>') && !html.includes('<i>'));
    assert.match(html, /UNKNOWN/);
  });

  test('marks a dry run', () => {
    assert.match(reviewCardHtml(review({ dry_run: true }), NOW), /dry run/);
  });

  test('shows the linked Jira keys as tags', () => {
    const html = reviewCardHtml(review({ jira: ['TWISM-21343', 'bogus'] }), NOW);
    assert.match(html, /href="https:\/\/twism\.atlassian\.net\/browse\/TWISM-21343"/);
    assert.ok(!html.includes('bogus'));
  });

  test('warns when the poller saw a push or a red pipeline, and names other approvers', () => {
    const html = reviewCardHtml(review({ live: { head_moved: true, pipeline: 'failed', approved_by: ['rodney', '<x>'], fetched_at: '2026-11-11T14:58:00+00:00' } }), NOW);
    assert.match(html, /pushed since the review/);
    assert.match(html, /pipeline failed/);
    assert.match(html, /approved by rodney, &lt;x&gt;/);
  });

  test('the file copy tells the coordinator command instead of an Approve button', () => {
    const html = reviewCardHtml(review({ head_sha: SHA }), NOW);
    assert.ok(!html.includes('data-approve'));
    assert.match(html, /<code>approve !1188<\/code>/);
  });
});

describe('approve button', () => {
  test('only the served page gets one, pinned to the reviewed head sha', () => {
    const r = review({ head_sha: SHA });
    assert.match(reviewCardHtml(r, NOW, { served: true }), /data-approve="platform\/monorepo!1188" data-sha="dc816155f198034826fd76a714ff532c80acd616"/);
  });

  test('no button and no card id without a usable head sha', () => {
    const html = reviewCardHtml(review({ head_sha: '"><b>' }), NOW, { served: true });
    assert.ok(!html.includes('data-approve'));
    assert.ok(!html.includes('<b>'));
  });
});

describe('reviewStatus', () => {
  const SHA = 'dc816155f198034826fd76a714ff532c80acd616';
  const REF = 'platform/monorepo!1231';
  const setup = (status, logLines = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-status-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ runs: [
      { ref: REF, head_sha: 'ffffffffffffffffffffffffffffffffffffffff', status: 'approved' },
      { ref: REF, head_sha: SHA, status },
    ] }));
    fs.writeFileSync(path.join(dir, 'poll.log'), logLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return { file: path.join(dir, 'pending.json') };
  };

  test('reports the run for that exact ref and head sha', () => {
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, setup('posted')), { state: 'waiting' });
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, setup('approved')), { state: 'approved' });
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, setup('declined')), { state: 'declined' });
  });

  test('a failed approve carries the newest reason the poller logged for that ref', () => {
    const where = setup('approve_failed', [
      { event: 'approve-failed', ref: REF, reason: 'old reason' },
      { event: 'approve-failed', ref: 'platform/monorepo!9', reason: 'other MR' },
      { event: 'approve-failed', ref: REF, reason: 'HTTP 409: head moved' },
      { event: 'tick', ref: REF },
    ]);
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, where), { state: 'failed', reason: 'HTTP 409: head moved' });
  });

  test('a failed approve without a log line still reports failed', () => {
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, setup('approve_failed')), { state: 'failed', reason: '' });
  });

  test('an unknown run, or no state file, is unknown', () => {
    assert.deepEqual(reviewStatus({ ref: 'platform/monorepo!9', head_sha: SHA }, setup('posted')), { state: 'unknown' });
    assert.deepEqual(reviewStatus({ ref: REF, head_sha: SHA }, { file: path.join(os.tmpdir(), 'nowhere-' + process.pid, 'pending.json') }), { state: 'unknown' });
  });

  test('refuses a malformed ref or sha', () => {
    for (const query of [{ ref: REF }, { ref: 'x; rm', head_sha: SHA }, { ref: REF, head_sha: 'zz' }]) {
      assert.throws(() => reviewStatus(query, setup('posted')), /Name a waiting review/);
    }
  });
});

describe('render', () => {
  const PROFILES = [
    { name: 'twism', label: 'Twism', stateDir: '/x/twism', session: 'twism', harness: 'claude' },
    { name: 'personal', label: 'Personal', stateDir: '/x/personal', session: 'personal', harness: 'codex' },
  ];
  const needsYou = (html) => html.match(/<div class="col" data-status="review">[\s\S]*?(?=<div class="col" data-status="blocked">)/)[0];
  const lane = (html, name) => html.match(new RegExp(`<section class="lane" data-profile="${name}">[\\s\\S]*?</section>`))[0];

  test('reviews are cards in the Needs you column, not a section of their own', () => {
    const html = render([], { reviews: [review({ head_sha: SHA })], served: SERVED });
    assert.ok(!html.includes('Reviews waiting on you'));
    const column = needsYou(html);
    assert.match(column, /class="card ask rvcard"/);
    assert.match(column, /<span class="count" data-total="1">1<\/span>/);
  });

  test('with lanes they sit in the Twism lane only, counted in its summary', () => {
    const html = render([], { reviews: [review({ head_sha: SHA })], served: SERVED, profiles: PROFILES });
    assert.match(lane(html, 'twism'), /rvcard/);
    assert.match(lane(html, 'twism'), /1 review</);
    assert.ok(!lane(html, 'personal').includes('rvcard'));
  });
});

describe('review panel script', () => {
  const vm = require('vm');
  const { reviewDrawerScript } = require('./dashboard-review-ui.cjs');
  const scriptOf = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];

  test('the served page carries the panel and its script parses', () => {
    const html = render([], { reviews: [review({ head_sha: SHA })], served: SERVED });
    assert.match(html, /window\.openReviewDrawer = openReviewDrawer/);
    assert.match(html, /\/api\/reviews\/detail\?ref=/);
    assert.doesNotThrow(() => new vm.Script(scriptOf(html)));
  });

  test('the file copy has no panel, and its script still parses', () => {
    const html = render([], { reviews: [review({ head_sha: SHA })] });
    assert.ok(!html.includes('window.openReviewDrawer ='));
    assert.doesNotThrow(() => new vm.Script(scriptOf(html)));
  });

  test('renders hostile review text as text', () => {
    const context = vm.createContext({
      window: {},
      location: { hash: '' },
      document: { querySelectorAll: () => [] },
      drawer: { classList: { contains: () => false, add() {}, remove() {} } },
      CSRF: 'x',
      JIRA_BROWSE: 'https://twism.atlassian.net/browse/',
    });
    vm.runInContext("const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');", context);
    vm.runInContext(reviewDrawerScript, context);
    const evil = '<img src=x onerror=alert(1)>';
    const detail = {
      ref: 'platform/monorepo!1188', head_sha: SHA, title: evil, url: 'https://code.twism.info/platform/monorepo/-/merge_requests/1188', tier: 'T3', verdict: 'REQUEST_CHANGES', summary: evil, dry_run: false, posted_known: true,
      findings: [{ index: 0, severity: 'HIGH', perspective: evil, rule: evil, path: evil, line: 2, title: evil, body: evil, suggested_fix: evil, recheck: 'holds', where: 'inline', note_id: 911, error: evil, snippet: { start: 1, line: 2, lines: [evil, evil] } }],
      live: { state: evil, head_moved: true, pipeline: evil, approved_by: [evil], approvals_left: 0, fetched_at: evil, our_threads: { threads: 1, resolved: 0, replies: 2 } },
      triage: { tier_name: evil, reasons: [evil] },
      mr: { author: evil, source_branch: evil, target_branch: evil, labels: [evil], draft: false, description: evil },
      files: [{ path: evil, category: 'code', added: 1, removed: 0, flags: '-' }], commits: [evil], jira: ['TWISM-1'],
    };
    const html = vm.runInContext('reviewDrawerHtml(' + JSON.stringify(detail) + ')', context);
    assert.ok(!html.includes('<img'), 'an unescaped tag reached the drawer');
    assert.match(html, /href="https:\/\/code\.twism\.info\/platform\/monorepo\/-\/merge_requests\/1188#note_911"/);
    assert.match(html, /Pushed since the review/);
    assert.match(html, /<span class="hit"><i>2<\/i>/);
  });
});

describe('reviewStatus after the MR is gone', () => {
  test('a merged or closed run reports that state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-gone-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ runs: [{ ref: 'platform/monorepo!7', head_sha: SHA, status: 'merged' }, { ref: 'platform/monorepo!8', head_sha: SHA, status: 'closed' }] }));
    const where = { file: path.join(dir, 'pending.json') };
    assert.deepEqual(reviewStatus({ ref: 'platform/monorepo!7', head_sha: SHA }, where), { state: 'merged' });
    assert.deepEqual(reviewStatus({ ref: 'platform/monorepo!8', head_sha: SHA }, where), { state: 'closed' });
  });
});
