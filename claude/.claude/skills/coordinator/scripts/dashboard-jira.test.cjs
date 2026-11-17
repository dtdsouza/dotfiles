const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { JIRA_BOARD_URL, ticketsOf, ticketTagsHtml, ticketHref } = require('./dashboard-jira.cjs');

describe('ticketsOf', () => {
  test('meta.tickets set by spawn --ticket wins', () => {
    assert.deepEqual(ticketsOf({ id: '21343-wix', tickets: ['TWISM-1', 'TWISM-2'], branch: 'feat/TWISM-9+x' }, 'twism'), ['TWISM-1', 'TWISM-2']);
  });

  test('an empty meta.tickets (spawn --ticket none) shows no tag at all', () => {
    assert.deepEqual(ticketsOf({ id: '21343-wix', tickets: [], branch: 'feat/TWISM-9+x' }, 'twism'), []);
  });

  test('falls back to a numeric id prefix, then to the branch', () => {
    assert.deepEqual(ticketsOf({ id: '21343-wix-pay' }, 'twism'), ['TWISM-21343']);
    assert.deepEqual(ticketsOf({ id: 'dash-x', branch: 'fix/TWISM-1523+payment-timeout' }, 'twism'), ['TWISM-1523']);
    assert.deepEqual(ticketsOf({ id: 'dash-x', branch: 'wip/twism-20171-olive' }, 'twism'), ['TWISM-20171']);
    assert.deepEqual(ticketsOf({ id: 'dash-x', branch: 'wip/dash-x' }, 'twism'), []);
  });

  test('a date-like id is not a ticket', () => {
    assert.deepEqual(ticketsOf({ id: '2026-11-recap' }, 'twism'), []);
  });

  test('other profiles never get Twism tickets', () => {
    assert.deepEqual(ticketsOf({ id: '21343-wix', tickets: ['TWISM-1'] }, 'personal'), []);
  });

  test('drops malformed keys and duplicates, and caps the list', () => {
    const tickets = ['TWISM-1', 'twism-2', '"><img>', 'TWISM-1', 'TWISM-3', 'TWISM-4', 'TWISM-5', 'TWISM-6', 'TWISM-7'];
    assert.deepEqual(ticketsOf({ id: 'x', tickets }, 'twism'), ['TWISM-1', 'TWISM-3', 'TWISM-4', 'TWISM-5', 'TWISM-6']);
  });
});

describe('ticketTagsHtml', () => {
  test('one key is a link tag to the Jira issue', () => {
    const html = ticketTagsHtml(['TWISM-21343']);
    assert.match(html, /<a class="tag jira" href="https:\/\/twism\.atlassian\.net\/browse\/TWISM-21343" target="_blank" rel="noopener noreferrer"[^>]*>TWISM-21343<\/a>/);
  });

  test('several keys show the first and a +N count', () => {
    const html = ticketTagsHtml(['TWISM-1', 'TWISM-2', 'TWISM-3']);
    assert.match(html, />TWISM-1<\/a>/);
    assert.match(html, /<span class="tag" title="TWISM-2, TWISM-3">\+2<\/span>/);
    assert.ok(!html.includes('>TWISM-2<'));
  });

  test('no keys renders nothing', () => {
    assert.equal(ticketTagsHtml([]), '');
  });

  test('ticketHref only builds links for valid keys', () => {
    assert.equal(ticketHref('TWISM-7'), 'https://twism.atlassian.net/browse/TWISM-7');
    assert.equal(ticketHref('javascript:alert(1)'), '');
  });

  test('the board link points at the user board', () => {
    assert.equal(JIRA_BOARD_URL, 'https://twism.atlassian.net/jira/software/c/projects/TWISM/boards/228');
  });
});

describe('task cards', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { collectItems, render } = require('./dashboard.cjs');
  const stateWith = (metas) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-cards-'));
    for (const meta of metas) {
      fs.mkdirSync(path.join(dir, 'tasks', meta.id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'tasks', meta.id, 'meta.json'), JSON.stringify({ model: 'sonnet', createdAt: new Date().toISOString(), ...meta }));
    }
    return dir;
  };

  test('collectItems derives each task ticket for its profile', () => {
    const dir = stateWith([{ id: '21343-wix' }, { id: 'tagged', tickets: ['TWISM-7'] }]);
    const byId = Object.fromEntries(collectItems(dir, { profile: 'twism', panes: [] }).map((a) => [a.id, a.tickets]));
    assert.deepEqual(byId, { '21343-wix': ['TWISM-21343'], tagged: ['TWISM-7'] });
    assert.deepEqual(collectItems(dir, { profile: 'personal', panes: [] }).map((a) => a.tickets), [[], []]);
  });

  test('a card shows its ticket tag even with its tab closed, and the drawer lists them', () => {
    const dir = stateWith([{ id: '21343-wix' }]);
    const html = render(collectItems(dir, { profile: 'twism', panes: [] }));
    assert.match(html, /<div class="card done closed"[^>]*>[\s\S]*?<a class="tag jira" href="https:\/\/twism\.atlassian\.net\/browse\/TWISM-21343"/);
    assert.match(html, /<span>Tickets<\/span>/);
  });

  test('a click on a link inside a card follows the link instead of opening the drawer', () => {
    assert.match(render([]), /if \(e\.target\.closest\('\.card a\[href\]'\)\) return;/);
  });
});

describe('My Jira board link', () => {
  const { render } = require('./dashboard.cjs');
  const SERVED = { csrf: 'x', nonce: 'n', closable: new Set(), replyable: new Set(), remote: true, files: false };
  const PROFILES = [
    { name: 'twism', label: 'Twism', stateDir: '/x/twism', session: 'twism', harness: 'claude' },
    { name: 'personal', label: 'Personal', stateDir: '/x/personal', session: 'personal', harness: 'codex' },
  ];
  const BOARD = /<a class="btn quiet" href="https:\/\/twism\.atlassian\.net\/jira\/software\/c\/projects\/TWISM\/boards\/228" target="_blank" rel="noopener noreferrer">My Jira board<\/a>/;

  test('sits in the Twism coordinator console only, and is not desktop-only', () => {
    const html = render([], { served: SERVED, profiles: PROFILES });
    const lane = (name) => html.match(new RegExp(`<section class="lane" data-profile="${name}">[\\s\\S]*?</section>`))[0];
    assert.match(lane('twism'), BOARD);
    assert.doesNotMatch(lane('personal'), /My Jira board/);
  });

  test('the single-profile header has it too', () => {
    assert.match(render([], { served: SERVED }), BOARD);
  });

  test('the phone feed carries it next to the coordinator buttons', () => {
    assert.match(render([], { served: SERVED, profiles: PROFILES }), /const JIRA_BOARD = "https:\/\/twism\.atlassian\.net\/jira\/software\/c\/projects\/TWISM\/boards\/228"/);
  });
});
