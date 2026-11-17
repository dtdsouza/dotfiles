const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reviewDetail } = require('./dashboard-review-detail.cjs');

const SHA = '7fb963d3b590960b3934cf321faafcc3de008bb0';
const REF = 'platform/monorepo!1188';
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
let env;

const finding = (over) => ({ severity: 'MEDIUM', perspective: 'Tests', rule: 'missing-test', path: 'src/a.ts', line: 10, title: 'No test', body: 'Nothing covers it.', suggested_fix: 'Add one.', ...over });

before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-detail-'));
  const state = path.join(root, 'autoloop');
  const dir = path.join(state, 'reviews', '159-1188', '7fb963d3');
  const context = path.join(dir, 'context');
  fs.mkdirSync(path.join(context, 'files', 'src'), { recursive: true });
  const secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET-KEY\n');

  writeJson(path.join(dir, 'meta.json'), { ref: REF, title: 'fix: wix', head_sha: SHA, dry_run: false });
  writeJson(path.join(dir, 'findings.json'), {
    verdict: 'REQUEST_CHANGES',
    summary: 'Two problems.',
    findings: [
      finding({ severity: 'LOW', title: 'Nit <b>bold</b>' }),
      finding({ severity: 'HIGH', line: 3, title: 'Wrong id' }),
      finding({ path: null, line: null, title: 'MR level' }),
      finding({ path: 'leak.ts', line: 1, title: 'Symlinked file' }),
      finding({ path: '../../../../secret.txt', line: 1, title: 'Escapes the pack' }),
    ],
  });
  writeJson(path.join(dir, 'recheck.json'), { 1: 'holds' });
  writeJson(path.join(dir, 'triage.json'), { tier: 'T3', tier_name: 'Deep', reasons: ['churn 900', 'payments path'] });
  writeJson(path.join(dir, 'posted.json'), { version: 1, head_sha: SHA, dry_run: false, findings: [
    { index: 0, where: 'local' },
    { index: 1, where: 'inline', discussion_id: 'abc', note_id: 911 },
    { index: 2, where: 'note', note_id: 4242, error: 'HTTP 400 line_code' },
  ] });
  fs.symlinkSync(secret, path.join(dir, 'live.json'));
  writeJson(path.join(context, 'mr.json'), { author: 'michel.pedroso', source_branch: 'fix/x', target_branch: 'trunk', labels: ['A.I. Assistance'], draft: false, description: 'Why: x' });
  fs.writeFileSync(path.join(context, 'files.tsv'), 'path\tcategory\tadded\tremoved\tflags\nsrc/a.ts\tcode\t15\t1\t-\n');
  fs.writeFileSync(path.join(context, 'commits.txt'), '523439e7 fix: one\nf82621db fix: two\n');
  fs.writeFileSync(path.join(context, 'jira.md'), '# Linked Jira tickets\n\n- TWISM-21343: https://twism.atlassian.net/browse/TWISM-21343\n');
  fs.writeFileSync(path.join(context, 'files', 'src', 'a.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.symlinkSync(secret, path.join(context, 'files', 'leak.ts'));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'review-outside-'));
  const file = path.join(state, 'pending.json');
  writeJson(file, { reviews: [
    { ref: REF, iid: 1188, tier: 'T3', verdict: 'REQUEST_CHANGES', title: 'fix: wix', url: 'https://code.twism.info/platform/monorepo/-/merge_requests/1188', head_sha: SHA, dir, jira: ['TWISM-21343'], reviewed_at: '2026-11-17T11:00:00+00:00' },
    { ref: 'platform/monorepo!66', iid: 66, tier: 'T1', head_sha: SHA, dir: outside },
  ] });
  env = { root, dir, file, secret };
});

after(() => fs.rmSync(env.root, { recursive: true, force: true }));

describe('reviewDetail', () => {
  const detail = () => reviewDetail({ ref: REF, head_sha: SHA }, { file: env.file });

  test('returns the review, its findings with where each went, and the MR context', () => {
    const d = detail();
    assert.equal(d.ref, REF);
    assert.equal(d.verdict, 'REQUEST_CHANGES');
    assert.equal(d.summary, 'Two problems.');
    assert.equal(d.url, 'https://code.twism.info/platform/monorepo/-/merge_requests/1188');
    assert.deepEqual(d.findings.map((f) => f.where), ['local', 'inline', 'note', null, null]);
    assert.equal(d.findings[1].note_id, 911);
    assert.equal(d.findings[1].recheck, 'holds');
    assert.equal(d.findings[2].error, 'HTTP 400 line_code');
    assert.equal(d.mr.author, 'michel.pedroso');
    assert.deepEqual(d.files, [{ path: 'src/a.ts', category: 'code', added: 15, removed: 1, flags: '-' }]);
    assert.deepEqual(d.commits, ['523439e7 fix: one', 'f82621db fix: two']);
    assert.deepEqual(d.jira, ['TWISM-21343']);
    assert.deepEqual(d.triage.reasons, ['churn 900', 'payments path']);
    assert.equal(d.posted_known, true);
  });

  test('cuts a 17-line snippet around the cited line from the context pack', () => {
    const snippet = detail().findings[0].snippet;
    assert.equal(snippet.start, 2);
    assert.equal(snippet.lines.length, 17);
    assert.equal(snippet.lines[8], 'line 10');
    assert.deepEqual(detail().findings[1].snippet.lines.slice(0, 2), ['line 1', 'line 2']);
    assert.equal(detail().findings[2].snippet, null);
  });

  test('never follows a symlink or a path out of the review dir', () => {
    const d = detail();
    assert.equal(d.findings[3].snippet, null);
    assert.equal(d.findings[4].snippet, null);
    assert.equal(d.live, null);
    assert.ok(!JSON.stringify(d).includes('TOP-SECRET'));
  });

  test('does not hand out the review dir path', () => {
    assert.ok(!JSON.stringify(detail()).includes(env.dir));
  });

  test('passes text through as data for the page to escape', () => {
    assert.equal(detail().findings[0].title, 'Nit <b>bold</b>');
  });

  test('refuses a review that is not waiting, or whose dir is outside the autoloop state', () => {
    assert.throws(() => reviewDetail({ ref: REF, head_sha: 'f'.repeat(40) }, { file: env.file }), /no longer waiting/);
    assert.throws(() => reviewDetail({ ref: 'platform/monorepo!66', head_sha: SHA }, { file: env.file }), /not under the autoloop state/);
  });

  test('reads a live.json that is a plain file', () => {
    fs.rmSync(path.join(env.dir, 'live.json'));
    writeJson(path.join(env.dir, 'live.json'), { state: 'opened', head_moved: true, pipeline: 'failed', approved_by: ['rodney'], approvals_left: 0, fetched_at: 'x', our_threads: { threads: 2, resolved: 1, replies: 3 } });
    assert.deepEqual(detail().live, { state: 'opened', head_moved: true, pipeline: 'failed', approved_by: ['rodney'], approvals_left: 0, fetched_at: 'x', our_threads: { threads: 2, resolved: 1, replies: 3 } });
  });
});
