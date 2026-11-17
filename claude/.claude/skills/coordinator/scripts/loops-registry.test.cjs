const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLoops } = require('./loops-registry.cjs');

const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-home-'));
  const dir = path.join(home, '.config/agentctl/loops');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.claude/skills/mr/scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/mr/scripts/poll.py'), '');
  return { home, dir };
};

const manifest = (overrides = {}) => ({
  id: 'mr-review',
  name: 'MR review autoloop',
  icon: 'mr',
  risk: 'writes-gitlab',
  units: { timer: 'mr-review-poll.timer', service: 'mr-review-poll.service' },
  verbs: {
    status: ['python3', '~/.claude/skills/mr/scripts/poll.py', 'status', '--json'],
    pause: ['python3', '~/.claude/skills/mr/scripts/poll.py', 'pause'],
    resume: ['python3', '~/.claude/skills/mr/scripts/poll.py', 'resume'],
    'run-once': 'systemd:start-service',
    kill: null,
  },
  phone: ['pause', 'resume', 'run-once'],
  settings: {
    file: '~/.config/mr/config.json',
    keys: [{ key: 'caps.reviews_per_day', label: 'Reviews per day', type: 'integer', min: 0, max: 20, description: 'Per day.' }],
  },
  ...overrides,
});

const write = (dir, name, doc, mode = 0o600) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  fs.chmodSync(file, mode);
  return file;
};

test('loads a valid manifest with absolute argv and systemd verbs', () => {
  const { home, dir } = setup();
  write(dir, 'mr-review.json', manifest());
  const { loops, errors } = loadLoops({ dir, home });
  assert.deepEqual(errors, []);
  assert.equal(loops.length, 1);
  const [loop] = loops;
  assert.equal(loop.verbs.status.argv[1], path.join(home, '.claude/skills/mr/scripts/poll.py'));
  assert.deepEqual(loop.verbs['run-once'], { systemd: 'start', unit: 'mr-review-poll.service' });
  assert.equal(loop.verbs.kill, undefined);
  assert.equal(loop.settings.file, path.join(home, '.config/mr/config.json'));
  assert.deepEqual([...loop.phone], ['pause', 'resume', 'run-once']);
});

test('the id must match the file name', () => {
  const { home, dir } = setup();
  write(dir, 'other.json', manifest());
  const { loops, errors } = loadLoops({ dir, home });
  assert.equal(loops.length, 0);
  assert.match(errors[0], /file name/);
});

test('refuses a script outside ~/.claude/skills or a traversal', () => {
  const { home, dir } = setup();
  write(dir, 'mr-review.json', manifest({ verbs: { status: ['python3', '/tmp/evil.py'] } }));
  assert.match(loadLoops({ dir, home }).errors[0], /under ~\/\.claude\/skills/);
  write(dir, 'mr-review.json', manifest({ verbs: { status: ['python3', '~/.claude/skills/../evil.py'] } }));
  assert.match(loadLoops({ dir, home }).errors[0], /under ~\/\.claude\/skills/);
});

test('refuses an interpreter outside the allowlist and unknown verbs', () => {
  const { home, dir } = setup();
  write(dir, 'mr-review.json', manifest({ verbs: { status: ['sh', '~/.claude/skills/mr/scripts/poll.py'] } }));
  assert.match(loadLoops({ dir, home }).errors[0], /interpreter/);
  write(dir, 'mr-review.json', manifest({ verbs: { status: manifest().verbs.status, shell: ['bash', '~/.claude/skills/mr/scripts/poll.py'] } }));
  assert.match(loadLoops({ dir, home }).errors[0], /unknown verb/);
});

test('refuses secret-looking setting keys and settings files outside config dirs', () => {
  const { home, dir } = setup();
  const keys = [{ key: 'slack.token_file', label: 'x', type: 'enum', values: ['a'], description: '' }];
  write(dir, 'mr-review.json', manifest({ settings: { file: '~/.config/mr/config.json', keys } }));
  assert.match(loadLoops({ dir, home }).errors[0], /secret/);
  write(dir, 'mr-review.json', manifest({ settings: { file: '~/.ssh/config.json', keys: manifest().settings.keys } }));
  assert.match(loadLoops({ dir, home }).errors[0], /settings file/);
});

test('refuses a manifest other users can write', () => {
  const { home, dir } = setup();
  write(dir, 'mr-review.json', manifest(), 0o666);
  assert.match(loadLoops({ dir, home }).errors[0], /writable by others/);
});

test('a broken manifest is skipped without hiding the others', () => {
  const { home, dir } = setup();
  write(dir, 'broken.json', '{');
  write(dir, 'mr-review.json', manifest());
  const { loops, errors } = loadLoops({ dir, home });
  assert.deepEqual(loops.map((l) => l.id), ['mr-review']);
  assert.equal(errors.length, 1);
});

test('a missing directory means no loops', () => {
  assert.deepEqual(loadLoops({ dir: '/nonexistent/loops', home: os.tmpdir() }), { loops: [], errors: [] });
});

test('numeric settings need a finite range, enums need values', () => {
  const { home, dir } = setup();
  const bad = [{ key: 'caps.x', label: 'x', type: 'integer', description: '' }];
  write(dir, 'mr-review.json', manifest({ settings: { file: '~/.config/mr/config.json', keys: bad } }));
  assert.match(loadLoops({ dir, home }).errors[0], /min and max/);
});
