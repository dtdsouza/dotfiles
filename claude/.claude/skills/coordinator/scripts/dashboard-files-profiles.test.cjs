// Each profile's notes may only claim and link files under that profile's own roots: a Codex
// worker on the personal profile must not pull Twism artifacts onto a Personal card, nor the reverse.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.COORDINATOR_TMUX_SOCKET = `agentctl-files-profiles-test-${process.pid}`;
delete process.env.TMUX_PANE;

const { COOKIE, createDashboardServer } = require('./dashboard-server.cjs');
const { loadFilePolicy, fileProfileOf, ROOTS_ENV } = require('./dashboard-files-policy.cjs');
const { createArtifactIndex } = require('./dashboard-files-index.cjs');
const { createSigner } = require('./dashboard-files-serve.cjs');
const { createProfileAttribution } = require('./dashboard-files-ui.cjs');

const KEY = 'f'.repeat(43);

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const writeTask = (stateDir, meta, notes) => {
  const dir = path.join(stateDir, 'tasks', meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ model: 'sonnet', name: meta.id, createdAt: '2026-10-31T08:00:00-03:00', ...meta }));
  fs.writeFileSync(path.join(dir, 'notes.md'), notes ? `- 2026-10-31 09:00 ${notes}\n` : '');
};

// A home with the default Twism roots and the Personal roots from profiles/personal.env.example.
const buildWorld = ({ twismNote = '', personalNote = '', globalRoots = '' } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-files-profiles-')));
  const twismFile = write(path.join(home, 'workspace', 'twism', 'repo', '.claude', 'tmp', 'twism-task', 'report.html'), '<title>Twism report</title>');
  const personalFile = write(path.join(home, 'workspace', 'github', 'repo', '.claude', 'tmp', 'codex-task', 'personal.html'), '<title>Personal</title>');
  const fill = (text) => text.replace('TWISM_FILE', twismFile).replace('PERSONAL_FILE', personalFile);
  const twismState = path.join(home, 'twism-state');
  const personalState = path.join(home, 'personal-state');
  writeTask(twismState, { id: 'twism-task' }, fill(twismNote));
  writeTask(personalState, { id: 'codex-task', profile: 'personal', harness: 'codex' }, fill(personalNote));
  const profiles = [
    { name: 'twism', label: 'Twism', stateDir: twismState, session: '', harness: 'claude' },
    { name: 'personal', label: 'Personal', stateDir: personalState, session: 'personal', harness: 'codex', fileRoots: `${home}/workspace/github/**/.claude/tmp/**` },
  ];
  const policy = loadFilePolicy(globalRoots ? { [ROOTS_ENV]: globalRoots.replace(/HOME/g, home) } : {}, home, profiles);
  const index = createArtifactIndex(policy);
  const owners = () => new Map(index.list().map((f) => [f.real, createProfileAttribution(profiles, policy)(f)]));
  return { home, twismFile, personalFile, profiles, policy, index, owners, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
};

describe('attribution stays inside the note profile roots', () => {
  test('a Personal note naming a Twism report leaves it with its Twism task', () => {
    const world = buildWorld({ personalNote: 'see TWISM_FILE' });
    try {
      assert.equal(world.owners().get(world.twismFile), 'twism-task');
    } finally {
      world.cleanup();
    }
  });

  test('a Twism note naming a Personal artifact leaves it with its Personal task', () => {
    const world = buildWorld({ twismNote: 'report at PERSONAL_FILE' });
    try {
      assert.equal(world.owners().get(world.personalFile), 'personal/codex-task');
    } finally {
      world.cleanup();
    }
  });

  test('with an explicit global root covering both, each file still belongs to one profile', () => {
    const world = buildWorld({ twismNote: 'PERSONAL_FILE', personalNote: 'TWISM_FILE', globalRoots: 'HOME/workspace/**/.claude/tmp/**' });
    try {
      assert.equal(fileProfileOf(world.twismFile, world.policy), 'twism');
      assert.equal(fileProfileOf(world.personalFile, world.policy), 'personal');
      assert.equal(world.owners().get(world.twismFile), 'twism-task');
      assert.equal(world.owners().get(world.personalFile), 'personal/codex-task');
    } finally {
      world.cleanup();
    }
  });

  test('a profile without its own roots claims nothing', () => {
    const world = buildWorld();
    try {
      const other = { name: 'other', label: 'Other', stateDir: path.join(world.home, 'other-state'), session: 'other', harness: 'codex' };
      writeTask(other.stateDir, { id: 'twism-task', profile: 'other' }, `see ${world.twismFile}`);
      const profiles = [...world.profiles, other];
      const policy = loadFilePolicy({}, world.home, profiles);
      const attribute = createProfileAttribution(profiles, policy);
      const twism = createArtifactIndex(policy).list().find((f) => f.real === world.twismFile);
      assert.equal(attribute(twism), 'twism-task');
    } finally {
      world.cleanup();
    }
  });
});

describe('note links on the served page', () => {
  test('a card links only paths under its own profile roots', async () => {
    const world = buildWorld({ twismNote: 'mine TWISM_FILE, theirs PERSONAL_FILE', personalNote: 'mine PERSONAL_FILE, theirs TWISM_FILE' });
    const server = createDashboardServer({ stateDir: world.profiles[0].stateDir, profiles: world.profiles, key: KEY, files: { policy: world.policy, signer: createSigner(), index: world.index } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const page = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Cookie: `${COOKIE}=${KEY}` } })).text();
      const items = JSON.parse(page.match(/const ITEMS = (\{.*\});\n/)[1].replace(/\\u003c/g, '<'));
      const links = (key) => (items[key].notes[0][1].match(/class="flink"/g) || []).length;
      assert.equal(links('twism-task'), 1);
      assert.equal(links('personal/codex-task'), 1);
      assert.deepEqual(items['twism-task'].files.map((f) => f.name), ['report.html']);
      assert.deepEqual(items['personal/codex-task'].files.map((f) => f.name), ['personal.html']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      world.cleanup();
    }
  });
});

// Runs the Files page script against a minimal DOM: the rows and chips it renders, and a storage
// that can be missing, empty or throwing.
const runFilesScript = (html, storage) => {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const element = (attrs) => {
    const listeners = {};
    const classes = new Set();
    return {
      dataset: attrs,
      hidden: false,
      value: '',
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      addEventListener: (type, fn) => (listeners[type] = fn),
      click: () => listeners.click && listeners.click(),
    };
  };
  const data = (tag, attr) => [...html.matchAll(new RegExp(`<${tag} class="[^"]*"[^>]*?((?:data-[a-z-]+="[^"]*"\\s*)+)`, 'g'))]
    .map((m) => Object.fromEntries([...m[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(([, k, v]) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])))
    .filter((d) => attr in d);
  const rows = data('div', 'profile').map(element);
  const kindChips = data('button', 'kindFilter').map(element);
  const profileChips = data('button', 'profileFilter').map(element);
  const search = element({});
  const empty = element({});
  const document = {
    hidden: false,
    addEventListener: () => {},
    querySelector: (sel) => (sel === '.fbar input' ? search : sel === '.empty' ? empty : null),
    querySelectorAll: (sel) => (sel === '.frow' ? rows : sel === '[data-kind-filter]' ? kindChips : sel === '[data-profile-filter]' ? profileChips : []),
  };
  new Function('document', 'localStorage', 'location', script)(document, storage, { reload: () => {} });
  const shown = () => rows.filter((r) => !r.hidden).map((r) => r.dataset.profile);
  const chip = (name) => profileChips.find((c) => c.dataset.profileFilter === name);
  return { shown, chip };
};

const memoryStorage = (initial = {}) => {
  const values = { ...initial };
  return { values, getItem: (k) => (k in values ? values[k] : null), setItem: (k, v) => (values[k] = String(v)) };
};

describe('Files page profile filter', () => {
  let world;
  let server;
  const files = async (query = '') => fetch(`http://127.0.0.1:${server.address().port}/files${query}`, { headers: { Cookie: `${COOKIE}=${KEY}` } });

  test('starts a server over both profiles', async () => {
    world = buildWorld();
    server = createDashboardServer({ stateDir: world.profiles[0].stateDir, profiles: world.profiles, key: KEY, files: { policy: world.policy, signer: createSigner(), index: world.index } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  test('offers All and one chip per profile, and badges each file with its profile', async () => {
    const html = await (await files()).text();
    const chips = [...html.matchAll(/data-profile-filter="([^"]+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(chips, ['all:All', 'twism:Twism', 'personal:Personal']);
    const rows = html.split('<div class="frow"').slice(1);
    const row = (name) => {
      const found = rows.find((r) => new RegExp(`>${name}<`).test(r));
      return [found, found.match(/data-profile="([^"]*)"/)[1]];
    };
    assert.equal(row('report\\.html')[1], 'twism');
    assert.equal(row('personal\\.html')[1], 'personal');
    assert.match(row('report\\.html')[0], /<span class="prof p0">Twism<\/span>/);
    assert.match(row('personal\\.html')[0], /<span class="prof p1">Personal<\/span>/);
  });

  test('defaults to All, even when storage throws', async () => {
    const html = await (await files()).text();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const page = runFilesScript(html, broken);
    assert.deepEqual(page.shown().sort(), ['personal', 'twism']);
    page.chip('personal').click();
    assert.deepEqual(page.shown(), ['personal']);
  });

  test('remembers the chosen profile per browser and ignores a stored unknown one', async () => {
    const html = await (await files()).text();
    const storage = memoryStorage();
    runFilesScript(html, storage).chip('twism').click();
    assert.deepEqual(runFilesScript(html, storage).shown(), ['twism']);
    assert.deepEqual(runFilesScript(html, memoryStorage({ [Object.keys(storage.values)[0]]: 'nope' })).shown().sort(), ['personal', 'twism']);
  });

  test('a profile in the URL preselects its chip; an unknown one is refused', async () => {
    const html = await (await files('?profile=personal')).text();
    assert.deepEqual(runFilesScript(html, memoryStorage()).shown(), ['personal']);
    for (const bad of ['nope', '<script>', '']) {
      const res = await files(`?profile=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, bad);
    }
  });

  test('task drawers still list only their own task files', async () => {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Cookie: `${COOKIE}=${KEY}` } })).text();
    const items = JSON.parse(page.match(/const ITEMS = (\{.*\});\n/)[1].replace(/\\u003c/g, '<'));
    assert.deepEqual(items['twism-task'].files.map((f) => f.name), ['report.html']);
    assert.deepEqual(items['personal/codex-task'].files.map((f) => f.name), ['personal.html']);
  });

  test('stops the server', async () => {
    await new Promise((resolve) => server.close(resolve));
    world.cleanup();
  });
});
