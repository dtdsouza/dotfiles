const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readReviews, reviewStatus, reviewsFile, reviewsHtml } = require('./dashboard-reviews.cjs');
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

describe('reviewsHtml', () => {
  test('no reviews renders nothing', () => {
    assert.equal(reviewsHtml([], NOW), '');
  });

  test('lists each review with its MR link, tier, verdict, counts, age and the decide command', () => {
    const html = reviewsHtml([review()], NOW);
    assert.match(html, /Reviews waiting on you/);
    assert.match(html, /href="https:\/\/code\.twism\.info\/platform\/monorepo\/-\/merge_requests\/1188"/);
    assert.match(html, /T3/);
    assert.match(html, /APPROVE WITH NITS/);
    assert.match(html, /2 inline · 0 in a note · 6 kept local/);
    assert.match(html, /2 h ago/);
    assert.match(html, /<code>approve !1188<\/code>/);
  });

  test('escapes the MR title, which the MR author controls', () => {
    const html = reviewsHtml([review({ title: '<img src=x onerror=alert(1)>' })], NOW);
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('links only a GitLab MR url, and only known verdicts and tiers', () => {
    const html = reviewsHtml([review({ url: 'javascript:alert(1)', verdict: '<b>x</b>', tier: '<i>' })], NOW);
    assert.ok(!html.includes('href='));
    assert.ok(!html.includes('<b>') && !html.includes('<i>'));
    assert.match(html, /UNKNOWN/);
  });

  test('marks a dry run', () => {
    assert.match(reviewsHtml([review({ dry_run: true })], NOW), /dry run/);
  });
});

describe('approve button', () => {
  test('only the served page gets one, pinned to the reviewed head sha', () => {
    const r = review({ head_sha: 'dc816155f198034826fd76a714ff532c80acd616' });
    assert.ok(!reviewsHtml([r], NOW).includes('data-approve'));
    assert.match(reviewsHtml([r], NOW, { served: true }), /data-approve="platform\/monorepo!1188" data-sha="dc816155f198034826fd76a714ff532c80acd616"/);
  });

  test('no button without a usable head sha', () => {
    assert.ok(!reviewsHtml([review({ head_sha: '"><b>' })], NOW, { served: true }).includes('data-approve'));
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
  test('puts the section on the page only when reviews are passed', () => {
    assert.ok(!render([], {}).includes('Reviews waiting on you'));
    assert.match(render([], { reviews: [review()] }), /Reviews waiting on you/);
  });
});
