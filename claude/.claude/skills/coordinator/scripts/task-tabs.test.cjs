// Window and pane ids restart from low numbers on every tmux server, so a ledger entry from an
// earlier server can name ids a live, unrelated pane now holds. These cases come from the ledger
// that put a personal tab in the Twism lane.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { matchTaskTabs, paneProfile, sessionProfilesOf, startedNear } = require('./task-tabs.cjs');

const NOW = Date.parse('2026-10-31T08:30:00-03:00') / 1000;
const atIso = (iso) => Date.parse(iso) / 1000;

const pane = (overrides) => ({
  id: '%1',
  windowId: '@1',
  session: 'twism',
  role: '',
  profile: '',
  task: '',
  command: 'bash',
  windowName: 'x',
  startedAt: NOW,
  ...overrides,
});

const meta = (overrides) => ({ session: 'twism', createdAt: '2026-10-31T08:01:15-03:00', ...overrides });

const SESSIONS = sessionProfilesOf([
  { name: 'twism', session: '' },
  { name: 'personal', session: 'personal' },
]);

const match = (metas, panes, profile = 'twism') => matchTaskTabs(metas, panes, { profile, sessionProfiles: SESSIONS });

describe('recycled ids from an earlier tmux server', () => {
  test('an old entry with the live window id but another pane and session claims nothing', () => {
    const live = pane({ id: '%43', windowId: '@42', session: 'twism', task: 'mr1181-scripts-safety-review', profile: 'twism' });
    const old = meta({ id: 'coordinator-dashboard-favicon', windowId: '@42', paneId: '%51', session: 'twism', createdAt: '2026-10-17T09:44:11-03:00', archivedAt: '2026-10-17T09:46:39-03:00' });
    const tabs = match([old, meta({ id: 'mr1181-scripts-safety-review', windowId: '@42', paneId: '%43', session: '0' })], [live]);
    assert.equal(tabs.has('coordinator-dashboard-favicon'), false);
    assert.equal(tabs.get('mr1181-scripts-safety-review').id, '%43');
  });

  test('a personal pane holding a recycled Twism window id stays out of the Twism ledger', () => {
    const sampleHtml = pane({ id: '%45', windowId: '@44', session: 'personal', startedAt: atIso('2026-10-31T08:05:44-03:00') });
    const personalCoordinator = pane({ id: '%44', windowId: '@43', session: 'personal', role: 'coordinator', profile: 'personal', command: 'codex' });
    const facelift = meta({ id: 'coordinator-dashboard-facelift', windowId: '@44', paneId: '%53', createdAt: '2026-10-17T10:20:50-03:00' });
    const slack = meta({ id: 'slack-send-as-app', windowId: '@43', paneId: '%52', createdAt: '2026-10-17T09:46:33-03:00' });
    assert.equal(match([facelift, slack], [sampleHtml, personalCoordinator]).size, 0);

    const own = meta({ id: 'sample-html', windowId: '@44', paneId: '%45', session: 'personal', createdAt: '2026-10-31T08:05:44-03:00' });
    assert.equal(match([own], [sampleHtml, personalCoordinator], 'personal').get('sample-html').id, '%45');
    assert.equal(match([{ ...own, session: 'twism' }], [sampleHtml]).size, 0);
  });

  test('the same window, pane and session ids on a newer server do not match an old entry', () => {
    const recycled = pane({ id: '%47', windowId: '@38', session: 'twism', startedAt: atIso('2026-10-31T07:48:52-03:00') });
    const old = meta({ id: 'hr-platform-prd', windowId: '@38', paneId: '%47', session: 'twism', createdAt: '2026-10-16T20:09:52-03:00' });
    assert.equal(match([old], [recycled]).size, 0);
  });

  test('a pane without a known start time never matches by ids alone', () => {
    const unknown = pane({ id: '%9', windowId: '@9', startedAt: undefined });
    assert.equal(match([meta({ id: 'a', windowId: '@9', paneId: '%9', createdAt: new Date(NOW * 1000).toISOString() })], [unknown]).size, 0);
  });
});

describe('the task tag', () => {
  test('a tagged pane belongs to its task whatever ids the ledger recorded', () => {
    const tagged = pane({ id: '%5', windowId: '@5', task: 'a', profile: 'twism' });
    assert.equal(match([meta({ id: 'a', windowId: '@1', paneId: '%1' })], [tagged]).get('a').id, '%5');
  });

  test('a pane tagged for one task is never claimed by another through matching ids', () => {
    const tagged = pane({ id: '%5', windowId: '@5', task: 'a', profile: 'twism', startedAt: atIso('2026-10-31T08:01:16-03:00') });
    assert.equal(match([meta({ id: 'b', windowId: '@5', paneId: '%5' })], [tagged]).size, 0);
  });

  test('a tag of another profile does not count, even with the same task id', () => {
    const tagged = pane({ id: '%5', windowId: '@5', session: 'twism', task: 'a', profile: 'personal' });
    assert.equal(match([meta({ id: 'a', windowId: '@5', paneId: '%5' })], [tagged]).size, 0);
    assert.equal(match([meta({ id: 'a' })], [tagged], 'personal').get('a').id, '%5');
  });

  test('a coordinator pane is never a task tab', () => {
    const coordinator = pane({ id: '%0', windowId: '@0', role: 'coordinator', startedAt: atIso('2026-10-31T08:01:15-03:00') });
    assert.equal(match([meta({ id: 'a', windowId: '@0', paneId: '%0' })], [coordinator]).size, 0);
  });
});

describe('legacy entries without a tag', () => {
  test('match when window, pane and session agree and the pane started at spawn time', () => {
    const live = pane({ id: '%39', windowId: '@38', startedAt: atIso('2026-10-31T07:48:51-03:00') });
    const tabs = match([meta({ id: 'poc', windowId: '@38', paneId: '%39', createdAt: '2026-10-31T07:48:52-03:00' })], [live]);
    assert.equal(tabs.get('poc').id, '%39');
    assert.equal(tabs.get('poc').legacy, true);
  });

  test('do not match a renamed session: the adopt step handles that', () => {
    const live = pane({ id: '%43', windowId: '@42', session: 'twism', startedAt: atIso('2026-10-31T08:01:15-03:00') });
    assert.equal(match([meta({ id: 'a', windowId: '@42', paneId: '%43', session: '0' })], [live]).size, 0);
  });

  test('two entries claiming one pane both lose it', () => {
    const live = pane({ id: '%3', windowId: '@3', startedAt: atIso('2026-10-31T08:01:15-03:00') });
    const twin = meta({ windowId: '@3', paneId: '%3' });
    assert.equal(match([{ ...twin, id: 'a' }, { ...twin, id: 'b' }], [live]).size, 0);
  });

  test('a grouped session listing the pane twice still yields one match', () => {
    const live = pane({ id: '%3', windowId: '@3', startedAt: atIso('2026-10-31T08:01:15-03:00') });
    const tabs = match([meta({ id: 'a', windowId: '@3', paneId: '%3' })], [live, { ...live, session: 'phone' }]);
    assert.equal(tabs.get('a').id, '%3');
  });
});

describe('helpers', () => {
  test('paneProfile reads the tag, then the session, then falls back to the primary', () => {
    assert.equal(paneProfile(pane({ profile: 'personal', session: 'twism' }), SESSIONS), 'personal');
    assert.equal(paneProfile(pane({ session: 'personal' }), SESSIONS), 'personal');
    assert.equal(paneProfile(pane({ session: '0' }), SESSIONS), 'twism');
  });

  test('startedNear allows clock rounding before spawn and a short delay after it', () => {
    const created = '2026-10-31T08:01:15-03:00';
    assert.equal(startedNear(atIso(created) - 2, created), true);
    assert.equal(startedNear(atIso(created) + 30, created), true);
    assert.equal(startedNear(atIso(created) - 60, created), false);
    assert.equal(startedNear(atIso(created) + 3600, created), false);
    assert.equal(startedNear(atIso(created), 'not a date'), false);
  });
});
