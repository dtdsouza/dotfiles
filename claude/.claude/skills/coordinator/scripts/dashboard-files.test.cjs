// File viewer: path policy, signed view links, Range, isolation headers and the pages that list files.
// Runs on a throwaway workspace in the temp dir and a tmux socket that has no server.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.COORDINATOR_TMUX_SOCKET = `agentctl-files-test-${process.pid}`;
delete process.env.TMUX_PANE;

const { COOKIE, createDashboardServer } = require('./dashboard-server.cjs');
const { loadFilePolicy, resolveViewable, ROOTS_ENV, DEFAULT_ROOTS } = require('./dashboard-files-policy.cjs');
const { createArtifactIndex, findNoteRefs } = require('./dashboard-files-index.cjs');
const { createSigner, parseRange, viewHref } = require('./dashboard-files-serve.cjs');

const KEY = 'k'.repeat(43);
const TAILNET_HOST = 'pc.tail-test.ts.net';
const OWNER = 'owner@example.com';
const VIDEO_BYTES = 10000;

let env;

const write = (file, content = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const buildWorkspace = () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-files-')));
  const ws = path.join(top, 'ws');
  const repo = path.join(ws, 'group', 'repo');
  const tmp = path.join(repo, '.claude', 'tmp');
  const files = {
    report: write(path.join(tmp, 'task-a', 'report.html'), '<!doctype html><title>r</title><img src="img/pic.png"><video src="demo/clip.mp4"></video>'),
    picture: write(path.join(tmp, 'task-a', 'img', 'pic.png'), 'png-bytes'),
    video: write(path.join(tmp, 'task-a', 'demo', 'clip.mp4'), Buffer.alloc(VIDEO_BYTES, 7)),
    markdown: write(path.join(tmp, 'task-a', 'notes.md'), '# Notes\n<script>alert(1)</script>\n'),
    gitConfig: write(path.join(tmp, 'task-a', '.git', 'config.html'), 'x'),
    nodeModule: write(path.join(tmp, 'task-a', 'node_modules', 'pkg', 'index.html'), 'x'),
    tokenNamed: write(path.join(tmp, 'task-a', 'api-token-dump.html'), 'x'),
    envFile: write(path.join(tmp, 'task-a', 'prod.env'), 'A=1'),
    pemFile: write(path.join(tmp, 'task-a', 'cert.pem'), 'x'),
    script: write(path.join(tmp, 'task-a', 'run.sh'), 'echo'),
    other: write(path.join(tmp, 'task-b', 'other.html'), '<p>b</p>'),
    plan: write(path.join(repo, '.claude', 'worktrees', 'wt1', 'docs', 'plans', 'plan.html'), '<p>plan</p>'),
    worktreeSource: write(path.join(repo, '.claude', 'worktrees', 'wt1', 'src', 'page.html'), 'x'),
    repoSource: write(path.join(repo, 'src', 'page.html'), 'x'),
    outside: write(path.join(top, 'outside', 'private.html'), 'private'),
  };
  files.escape = path.join(tmp, 'escape.html');
  fs.symlinkSync(files.outside, files.escape);
  files.crossLink = path.join(tmp, 'task-a', 'cross.html');
  fs.symlinkSync(files.other, files.crossLink);
  files.renamed = path.join(tmp, 'task-a', 'renamed.html');
  fs.symlinkSync(files.envFile, files.renamed);
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(files.other, old, old);
  const roots = [`${ws}/**/.claude/tmp/**`, `${ws}/**/.claude/worktrees/*/{.claude/tmp,docs,openspec}/**`].join(':');
  return { top, ws, repo, tmp, files, roots };
};

const writeTask = (stateDir, meta, notes = '') => {
  const dir = path.join(stateDir, 'tasks', meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: 'twism', model: 'sonnet', createdAt: '2026-10-30T09:00:00-03:00', ...meta }));
  fs.writeFileSync(path.join(dir, 'notes.md'), notes);
};

const request = ({ method = 'GET', urlPath = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: env.port, method, path: urlPath, headers: { Host: `127.0.0.1:${env.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString('utf8'), json: () => JSON.parse(raw.toString('utf8')) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const withCookie = (headers = {}) => ({ Cookie: `${COOKIE}=${KEY}`, ...headers });
const tailnetHeaders = (extra = {}) => ({ Host: TAILNET_HOST, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': OWNER, ...extra });
const href = (file, scope) => env.signer.href(file, scope);
const viewOf = (file) => viewHref(env.signer, resolveViewable(file, env.policy));

before(async () => {
  const workspace = buildWorkspace();
  const policy = loadFilePolicy({ [ROOTS_ENV]: workspace.roots });
  const clock = { now: Date.now() };
  const signer = createSigner({ now: () => clock.now });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-files-state-'));
  writeTask(
    stateDir,
    { id: 'task-a', name: 'task-a', workdir: workspace.repo, repo: workspace.repo },
    `- 2026-10-30 09:10 Report at .claude/tmp/task-a/report.html, notes in .claude/tmp/task-a/notes.md.\n- 2026-10-30 09:20 Also see file://${workspace.files.other} and ${workspace.tmp}/task-a/{report.html,notes.md}\n`,
  );
  writeTask(stateDir, { id: 'wt1', name: 'wt1', workdir: path.join(workspace.repo, '.claude', 'worktrees', 'wt1'), repo: workspace.repo });
  const files = { policy, signer, index: createArtifactIndex(policy) };
  const server = createDashboardServer({ stateDir, key: KEY, tailnet: { host: TAILNET_HOST, logins: [OWNER] }, files, auditFile: path.join(stateDir, 'audit.jsonl') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env = { ...workspace, policy, signer, clock, server, port: server.address().port, stateDir };
  const page = await request({ headers: withCookie() });
  env.page = page;
  env.csrf = page.body.match(/const CSRF = "([^"]+)"/)[1];
});

after(() => {
  env?.server.close();
  if (env) fs.rmSync(env.top, { recursive: true, force: true });
});

describe('root configuration', () => {
  test('defaults to the twism .claude/tmp folders and worktree docs, expanding ~ and braces', () => {
    const policy = loadFilePolicy({}, '/home/someone');
    assert.deepEqual(DEFAULT_ROOTS.length, 2);
    assert.deepEqual(
      policy.roots.map((r) => `${r.base}/${r.segments.join('/')}`),
      [
        '/home/someone/workspace/twism/**/.claude/tmp/**',
        '/home/someone/workspace/twism/**/.claude/worktrees/*/.claude/tmp/**',
        '/home/someone/workspace/twism/**/.claude/worktrees/*/docs/**',
        '/home/someone/workspace/twism/**/.claude/worktrees/*/openspec/**',
      ],
    );
  });

  test('turns off with the env var, and refuses relative or dot-dot roots', () => {
    assert.equal(loadFilePolicy({ [ROOTS_ENV]: 'off' }), null);
    assert.equal(loadFilePolicy({ [ROOTS_ENV]: 'relative/**:/a/../b/**' }), null);
  });
});

describe('path policy', () => {
  test('accepts a report and gives it its artifact folder', () => {
    const viewable = resolveViewable(env.files.report, env.policy);
    assert.equal(viewable.kind, 'html');
    assert.equal(viewable.artifactDir, path.join(env.tmp, 'task-a'));
  });

  test('accepts a worktree plan under docs/', () => {
    assert.equal(resolveViewable(env.files.plan, env.policy).kind, 'html');
  });

  for (const [label, file, status] of [
    ['a dot-dot path', () => `${env.tmp}/task-a/../task-b/other.html`, 400],
    ['a relative path', () => '.claude/tmp/task-a/report.html', 400],
    ['a NUL byte', () => `${env.files.report}\0.html`, 400],
    ['a double slash', () => env.files.report.replace('/task-a/', '//task-a/'), 400],
    ['a symlink that escapes the roots', () => env.files.escape, 403],
    ['a file under .git/', () => env.files.gitConfig, 403],
    ['a file under node_modules/', () => env.files.nodeModule, 403],
    ['a token-named file', () => env.files.tokenNamed, 403],
    ['a .env file', () => env.files.envFile, 403],
    ['a .pem file', () => env.files.pemFile, 403],
    ['a script (extension not allowlisted)', () => env.files.script, 403],
    ['an innocent name linking to a .env', () => env.files.renamed, 403],
    ['repo source outside .claude/tmp', () => env.files.repoSource, 403],
    ['worktree source outside docs/', () => env.files.worktreeSource, 403],
    ['a missing file', () => path.join(env.tmp, 'task-a', 'nope.html'), 404],
  ]) {
    test(`refuses ${label}`, () => {
      assert.equal(resolveViewable(file(), env.policy).refusal[0], status);
    });
  }

  test('refuses a directory, so nothing is ever listed', () => {
    fs.mkdirSync(path.join(env.tmp, 'task-a', 'folder.html'), { recursive: true });
    assert.ok(resolveViewable(path.join(env.tmp, 'task-a', 'folder.html'), env.policy).refusal);
  });
});

describe('discovery', () => {
  test('lists reports, videos and PDFs newest first and skips everything denied', () => {
    const listed = createArtifactIndex(env.policy).list().map((f) => f.real);
    assert.ok(listed.includes(env.files.report) && listed.includes(env.files.video) && listed.includes(env.files.plan));
    assert.equal(listed[listed.length - 1], env.files.other, 'the oldest file comes last');
    for (const denied of [env.files.gitConfig, env.files.nodeModule, env.files.tokenNamed, env.files.outside, env.files.repoSource, env.files.worktreeSource, env.files.picture]) {
      assert.ok(!listed.includes(denied), denied);
    }
  });

  test('finds file://, absolute, ~ and repo-relative paths in notes, with brace lists', () => {
    const refs = findNoteRefs('see file:///a/b%20c/r.html, ~/x/y.mp4 and .claude/tmp/t/report.{md,html}. w/o /clear');
    assert.deepEqual(refs.map((r) => r.candidates), [['/a/b c/r.html'], ['~/x/y.mp4'], ['.claude/tmp/t/report.md', '.claude/tmp/t/report.html'], ['/clear']]);
    assert.equal(refs[0].raw, 'file:///a/b%20c/r.html');
  });
});

describe('signed view links', () => {
  test('round-trip and refuse tampering, a widened scope and expiry', () => {
    const clock = { now: 1_800_000_000_000 };
    const signer = createSigner({ now: () => clock.now, ttlSeconds: 60 });
    const link = signer.href('/a/b/c.html', '/a/b');
    assert.deepEqual(signer.verify(link), { file: '/a/b/c.html', scope: '/a/b' });
    assert.deepEqual(signer.verify(link.replace('/c.html', '/d.html')), { file: '/a/b/d.html', scope: '/a/b' });
    assert.equal(signer.verify(link.replace(/\.2\./, '.1.')).refusal[0], 403);
    const [token] = link.slice('/v/'.length).split('/');
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal(signer.verify(link.replace(token, flipped)).refusal[0], 403);
    assert.equal(createSigner({ now: () => clock.now }).verify(link).refusal[0], 403, 'another server secret');
    clock.now += 61000;
    assert.equal(signer.verify(link).refusal[0], 410);
  });

  test('parseRange follows RFC 9110', () => {
    assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-1', 100), null);
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
    assert.equal(parseRange('items=0-1', 100), null);
    assert.equal(parseRange(undefined, 100), null);
  });
});

describe('view endpoint', () => {
  test('serves a report sandboxed into an opaque origin with the isolation headers', async () => {
    const res = await request({ urlPath: viewOf(env.files.report) });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /^sandbox allow-scripts /);
    assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-top-navigation/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cross-origin-opener-policy'], undefined, 'COOP would make browsers refuse a sandboxed page');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('needs no cookie, but a cookie without a valid link opens nothing', async () => {
    const forged = viewOf(env.files.report).replace(/^\/v\/[^/]+/, `/v/9999999999.4.${'A'.repeat(43)}`);
    assert.equal((await request({ urlPath: forged, headers: withCookie() })).status, 403);
    assert.equal((await request({ urlPath: `/v${env.files.report}`, headers: withCookie() })).status, 403);
  });

  test("loads a report's own image and video by relative URL", async () => {
    const base = viewOf(env.files.report).replace(/report\.html$/, '');
    const image = await request({ urlPath: `${base}img/pic.png` });
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal((await request({ urlPath: `${base}demo/clip.mp4`, headers: { Range: 'bytes=0-1' } })).status, 206);
  });

  test("refuses a sibling task's file through a report's link", async () => {
    const res = await request({ urlPath: viewOf(env.files.report).replace('/task-a/report.html', '/task-b/other.html') });
    assert.equal(res.status, 403);
  });

  test('refuses a symlink inside the scope that points out of it', async () => {
    const res = await request({ urlPath: href(env.files.crossLink, path.join(env.tmp, 'task-a')) });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /<p>b<\/p>/);
  });

  test('refuses a denied or wrongly typed file even with a link signed for it', async () => {
    for (const file of [env.files.envFile, env.files.script, env.files.gitConfig, env.files.escape, env.files.repoSource]) {
      const res = await request({ urlPath: href(file) });
      assert.ok([403, 404].includes(res.status), `${file}: ${res.status}`);
      assert.doesNotMatch(res.body, /private|A=1|echo/);
    }
  });

  test('refuses dot-dot and encoded-slash escapes in the URL', async () => {
    const link = viewOf(env.files.report);
    const dotted = link.replace('/task-a/report.html', '/task-a/%2e%2e/task-b/other.html');
    assert.equal((await request({ urlPath: dotted })).status, 403);
    const slashed = link.replace('/task-a/report.html', '/task-a%2F..%2Ftask-b/other.html');
    assert.equal((await request({ urlPath: slashed })).status, 400);
  });

  test('a video link plays in a player page with playsinline', async () => {
    const res = await request({ urlPath: viewOf(env.files.video) });
    assert.equal(res.status, 200);
    assert.match(res.body, /<video controls playsinline preload="metadata"><source src="clip\.mp4" type="video\/mp4"><\/video>/);
    assert.match(res.headers['content-security-policy'], /^sandbox allow-downloads; default-src 'none'/);
    assert.match(res.headers['content-security-policy'], new RegExp(`media-src 'self' http://127\\.0\\.0\\.1:${env.port}`));
  });

  test('answers Range requests on a video', async () => {
    const link = viewOf(env.files.video).replace('?play', '');
    const first = await request({ urlPath: link, headers: { Range: 'bytes=0-1' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers['content-range'], `bytes 0-1/${VIDEO_BYTES}`);
    assert.equal(first.headers['content-length'], '2');
    assert.equal(first.headers['accept-ranges'], 'bytes');
    assert.equal(first.headers['content-type'], 'video/mp4');
    assert.equal(first.raw.length, 2);
    const tail = await request({ urlPath: link, headers: { Range: 'bytes=-100' } });
    assert.equal(tail.headers['content-range'], `bytes ${VIDEO_BYTES - 100}-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`);
    const open = await request({ urlPath: link, headers: { Range: 'bytes=9000-' } });
    assert.equal(open.raw.length, 1000);
    const beyond = await request({ urlPath: link, headers: { Range: `bytes=${VIDEO_BYTES}-` } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers['content-range'], `bytes */${VIDEO_BYTES}`);
    const whole = await request({ urlPath: link });
    assert.equal(whole.status, 200);
    assert.equal(whole.raw.length, VIDEO_BYTES);
    const head = await request({ method: 'HEAD', urlPath: link });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(VIDEO_BYTES));
    assert.equal(head.raw.length, 0);
  });

  test('shows markdown as escaped text', async () => {
    const res = await request({ urlPath: viewOf(env.files.markdown) });
    assert.equal(res.status, 200);
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(res.body, /<script>/);
  });

  test('says an expired link expired', async () => {
    const link = viewOf(env.files.report);
    env.clock.now += 3601 * 1000;
    try {
      assert.equal((await request({ urlPath: link })).status, 410);
    } finally {
      env.clock.now -= 3601 * 1000;
    }
  });

  test('keeps the tailnet gate: a valid link through the tailnet name still needs the login', async () => {
    const link = viewOf(env.files.report);
    const allowed = await request({ urlPath: link, headers: tailnetHeaders() });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers['content-security-policy'], new RegExp(`img-src 'self' https://${TAILNET_HOST.replace(/\./g, '\\.')}`));
    assert.equal((await request({ urlPath: link, headers: tailnetHeaders({ 'Tailscale-User-Login': '' }) })).status, 403);
    assert.equal((await request({ urlPath: link, headers: tailnetHeaders({ 'Tailscale-Funnel-Request': '?1' }) })).status, 403);
    assert.equal((await request({ urlPath: link, headers: { Host: 'evil.example' } })).status, 403);
  });

  test('allows only GET and HEAD', async () => {
    assert.equal((await request({ method: 'PUT', urlPath: viewOf(env.files.report) })).status, 405);
  });
});

describe('a sandboxed report cannot drive the dashboard', () => {
  // What a fetch from an opaque origin looks like, even if the page somehow knew the cookie and token.
  const fromSandbox = (extra = {}) => withCookie({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json', 'X-Dashboard-Token': env.csrf, ...extra });

  for (const route of ['/api/message', '/api/reply', '/api/tabs/close', '/api/tabs/close-done', '/api/coordinator/focus']) {
    test(`refuses ${route} from Origin null`, async () => {
      const res = await request({ method: 'POST', urlPath: route, headers: fromSandbox(), body: JSON.stringify({ id: 'task-a', text: 'hi' }) });
      assert.equal(res.status, 403);
    });
  }

  test('refuses Origin null even without Sec-Fetch-Site (older Safari)', async () => {
    const { 'Sec-Fetch-Site': _, ...headers } = fromSandbox();
    const res = await request({ method: 'POST', urlPath: '/api/message', headers, body: '{"text":"hi"}' });
    assert.equal(res.status, 403);
  });

  test('refuses a peek from Origin null', async () => {
    const { 'Sec-Fetch-Site': _, ...headers } = fromSandbox();
    const res = await request({ urlPath: '/api/coordinator/peek', headers });
    assert.equal(res.status, 403);
  });

  test('refuses the Files page to a navigation the report started', async () => {
    const res = await request({ urlPath: '/files', headers: withCookie({ 'Sec-Fetch-Site': 'cross-site' }) });
    assert.equal(res.status, 403);
  });
});

describe('Files page and drawer', () => {
  test('refuses the Files page without the key cookie', async () => {
    const res = await request({ urlPath: '/files' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /\/v\//);
  });

  test('lists the files newest first with the task inferred, under a nonce CSP', async () => {
    const res = await request({ urlPath: '/files', headers: withCookie({ 'Sec-Fetch-Site': 'same-origin' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /script-src 'nonce-/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    const names = [...res.body.matchAll(/class="flink" href="[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.ok(names.includes('report.html') && names.includes('clip.mp4') && names.includes('plan.html'), names.join());
    assert.equal(names[names.length - 1], 'other.html');
    assert.match(res.body, /href="\/#task-a">task-a</);
    assert.match(res.body, /href="\/#wt1">wt1</);
    assert.match(res.body, /target="_blank" rel="noopener noreferrer"/);
    assert.match(res.body, /clip\.mp4\?play/);
  });

  test("puts each task's files in its drawer data and links the paths in its notes", () => {
    const items = JSON.parse(env.page.body.match(/const ITEMS = (\{.*\});\n/)[1].replace(/\\u003c/g, '<'));
    const files = items['task-a'].files.map((f) => f.name);
    assert.ok(files.includes('report.html') && files.includes('notes.md') && files.includes('other.html'), files.join());
    assert.ok(items['wt1'].files.some((f) => f.name === 'plan.html'));
    const notes = items['task-a'].notes.map(([, html]) => html).join('\n');
    assert.match(notes, /<a class="flink" href="\/v\/[^"]+\/task-a\/report\.html"[^>]*>\.claude\/tmp\/task-a\/report\.html<\/a>/);
    assert.match(notes, new RegExp(`>file://${env.files.other.replace(/[.]/g, '\\.')}</a>`));
    assert.match(notes, /\{report\.html,notes\.md\} <a [^>]+>html<\/a> <a [^>]+>md<\/a>/);
    assert.equal(items['task-a'].notesHtml, true);
  });

  test('shows a Files button on the served page', () => {
    assert.match(env.page.body, /<a class="btn quiet" href="\/files">Files<\/a>/);
  });

  test('ships inline scripts that parse', async () => {
    const res = await request({ urlPath: '/files', headers: withCookie() });
    for (const body of [env.page.body, res.body]) {
      const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      for (const script of scripts) assert.doesNotThrow(() => new Function(script));
    }
  });
});

describe('profile artifact roots', () => {
  test('discovers central, repo and worktree Personal artifacts but excludes repo source', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-personal-roots-'));
    try {
      const github = path.join(home, 'workspace', 'github');
      const central = write(path.join(github, '.claude', 'tmp', 'sample-html', 'sample.html'), 'sample');
      const repo = write(path.join(github, 'repo', '.claude', 'tmp', 'task-a', 'report.html'), 'report');
      const worktree = write(path.join(github, 'repo', '.claude', 'worktrees', 'wt1', 'docs', 'plan.html'), 'plan');
      const source = write(path.join(github, 'repo', 'src', 'index.html'), 'source');
      const profile = { fileRoots: '~/workspace/github/**/.claude/tmp/**:~/workspace/github/**/.claude/worktrees/*/{.claude/tmp,docs,openspec}/**' };
      const policy = loadFilePolicy({}, home, [profile]);
      const files = createArtifactIndex(policy).list().map((f) => f.real);
      for (const file of [central, repo, worktree]) assert.ok(files.includes(file), file);
      assert.equal(resolveViewable(source, policy).refusal[0], 403);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('augments defaults but respects explicit global roots and off', () => {
    const profiles = [{ name: 'personal', fileRoots: '/personal/.claude/tmp/**' }];
    const roots = (policy) => policy.roots.map((r) => r.pattern);
    assert.ok(roots(loadFilePolicy({}, '/home/u', profiles)).includes('/personal/.claude/tmp/**'));
    assert.deepEqual(roots(loadFilePolicy({ [ROOTS_ENV]: '/explicit/**' }, '/home/u', profiles)), ['/explicit/**']);
    assert.equal(loadFilePolicy({ [ROOTS_ENV]: 'off' }, '/home/u', profiles), null);
  });
});

describe('Personal files on the shared dashboard', () => {
  test('links Personal cards and attributes colliding task ids to their own profiles', async () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-personal-files-'));
    const primaryState = path.join(top, 'primary-state');
    const personalState = path.join(top, 'personal-state');
    const primaryFile = write(path.join(top, 'primary', 'task-a', 'primary.html'), '<title>Primary</title>');
    const personalFile = write(path.join(top, 'personal', 'task-a', 'sample.html'), '<title>Personal sample</title>');
    writeTask(primaryState, { id: 'task-a', name: 'task-a' }, `- 2026-10-31 09:00 ${primaryFile}\n`);
    writeTask(personalState, { id: 'task-a', name: 'task-a', profile: 'personal', harness: 'codex' }, `- 2026-10-31 09:00 ${personalFile}\n`);
    const policy = loadFilePolicy({ [ROOTS_ENV]: `${top}/primary/**:${top}/personal/**` });
    const profiles = [
      { name: 'twism', label: 'Primary', stateDir: primaryState },
      { name: 'personal', label: 'Personal', stateDir: personalState },
    ];
    const server = createDashboardServer({ stateDir: primaryState, profiles, key: KEY, files: { policy, signer: createSigner(), index: createArtifactIndex(policy) } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const get = (pathname, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers: authenticated ? withCookie() : {} });
    try {
      const page = await (await get('/')).text();
      const items = JSON.parse(page.match(/const ITEMS = (\{.*\});\n/)[1].replace(/\\u003c/g, '<'));
      const personalItem = items['personal/task-a'];
      assert.equal(personalItem.files.length, 1);
      assert.equal(personalItem.files[0].name, 'sample.html');
      assert.match(personalItem.notes[0][1], /class="flink"/);
      const primaryItem = items['task-a'];
      assert.deepEqual(primaryItem.files.map((f) => f.name), ['primary.html']);
      const listing = await (await get('/files')).text();
      const personalRow = listing.match(/<div class="frow"[^]*?sample\.html[^]*?<\/div><\/div>/)[0];
      assert.match(personalRow, /href="\/#personal%2Ftask-a"/);
      const content = await get(personalItem.files[0].href, false);
      assert.equal(content.status, 200);
      assert.equal(await content.text(), '<title>Personal sample</title>');
      assert.match(content.headers.get('content-security-policy'), /sandbox/);
      assert.equal((await get('/files', false)).status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(top, { recursive: true, force: true });
    }
  });
});
