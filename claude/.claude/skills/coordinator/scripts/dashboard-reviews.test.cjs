const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readReviews, reviewsFile, reviewsHtml } = require('./dashboard-reviews.cjs');
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

describe('render', () => {
  test('puts the section on the page only when reviews are passed', () => {
    assert.ok(!render([], {}).includes('Reviews waiting on you'));
    assert.match(render([], { reviews: [review()] }), /Reviews waiting on you/);
  });
});
