const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('./dashboard.cjs');

const served = { csrf: 'c', nonce: 'n', closable: new Set(), replyable: new Set(), remote: false, files: true, loops: [{ id: 'triage', name: 'CX/bug triage', icon: 'bug' }] };
const draft = { id: 'C03HWJV44CE-1791397356.866549', hash: 'a'.repeat(64), status: 'held', createdAt: '2026-11-17T15:50:00Z', channel: { id: 'C03HWJV44CE', name: '#cx-support' }, kind: 'data-request', title: '<b>Activate</b>', summary: 's', reply: 'r', jira: { action: 'none' }, evidence: [], heldReason: 'mentions mail_3', dryRun: false, mode: 'auto' };

test('the served page has the rail, the loop links, the phone tab bar and the loop view', () => {
  const html = render([], { served, profiles: [{ name: 'twism', label: 'Twism', stateDir: '/tmp', session: '', harness: 'claude' }] });
  assert.match(html, /<nav class="rail"/);
  assert.match(html, /data-loop-link="triage"/);
  assert.match(html, /<nav class="tabbar"[^]*href="#loops"/);
  assert.match(html, /<section class="loopview" hidden>/);
  assert.doesNotMatch(html, /<a class="btn quiet" href="\/files">/);
});

test('waiting drafts are Needs-you cards, escaped, with the held reason', () => {
  const html = render([], { served, drafts: [{ loop: 'triage', draft }] });
  assert.match(html, /data-id="draft\/triage\/C03HWJV44CE-1791397356\.866549"/);
  assert.match(html, /&lt;b&gt;Activate&lt;\/b&gt;/);
  assert.match(html, /held: mentions mail_3/);
  assert.match(html, /<span class="count" data-total="1">1<\/span>/);
});

test('the file:// copy keeps the plain layout without loops', () => {
  const html = render([], { drafts: [{ loop: 'triage', draft }] });
  assert.doesNotMatch(html, /class="rail"|class="tabbar"|data-loop-link|dfcard/);
});

test('the Files page rail links the loops through the board route and marks Files active', () => {
  const { railHtml, tabBarHtml } = require('./dashboard-shell-ui.cjs');
  const loops = [{ id: 'triage', name: 'CX/bug triage', icon: 'bug' }];
  const rail = railHtml({ loops, files: true, page: 'files' });
  assert.match(rail, /href="\/#loop\/triage"/);
  assert.doesNotMatch(rail, /class="ri on"[^>]*data-nav="agents"/);
  assert.match(tabBarHtml({ loops, files: true, page: 'files' }), /<a href="\/#loops" data-nav="loops">/);
});
