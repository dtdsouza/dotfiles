const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateValue, writeSetting, historyDirOf, HISTORY_KEEP } = require('./loops-config.cjs');
const { parseShow } = require('./loops-runner.cjs');

const INT = { key: 'caps.reviews_per_day', label: 'Reviews per day', type: 'integer', min: 0, max: 20 };
const MODE = { key: 'autonomyMode', label: 'Autonomy', type: 'enum', values: ['auto', 'guarded'] };
const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-config-'));
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};

test('validates by type and range', () => {
  assert.equal(validateValue(INT, 6), 6);
  assert.equal(validateValue(INT, '8'), 8);
  assert.throws(() => validateValue(INT, 2.5), /whole number/);
  assert.throws(() => validateValue(INT, 21), /between 0 and 20/);
  assert.throws(() => validateValue(INT, '1; rm -rf ~'), /must be a number/);
  assert.equal(validateValue(MODE, 'guarded'), 'guarded');
  assert.throws(() => validateValue(MODE, 'yolo'), /one of auto, guarded/);
  assert.throws(() => validateValue({ key: 'x', label: 'X', type: 'boolean' }, 'true'), /on or off/);
});

test('writes a nested key, keeps the other keys and a history copy', () => {
  const file = tmpFile(JSON.stringify({ caps: { concurrent: 2 }, me: 'daniel.souza' }));
  const result = writeSetting({ file, setting: INT, value: 8, now: new Date('2026-11-17T16:00:00Z') });
  assert.deepEqual(result, { from: null, to: 8 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { caps: { concurrent: 2, reviews_per_day: 8 }, me: 'daniel.souza' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const history = fs.readdirSync(historyDirOf(file));
  assert.equal(history.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(historyDirOf(file), history[0]), 'utf8')), { caps: { concurrent: 2 }, me: 'daniel.souza' });
});

test('creates a missing settings file without a history entry', () => {
  const file = tmpFile();
  assert.deepEqual(writeSetting({ file, setting: MODE, value: 'auto' }), { from: null, to: 'auto' });
  assert.equal(fs.existsSync(historyDirOf(file)), false);
});

test('refuses to overwrite a settings file that is not valid JSON', () => {
  const file = tmpFile('{"autonomyMode": "auto",');
  assert.throws(() => writeSetting({ file, setting: MODE, value: 'guarded' }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"autonomyMode": "auto",');
});

test('refuses to replace a scalar with an object path', () => {
  const file = tmpFile(JSON.stringify({ caps: 3 }));
  assert.throws(() => writeSetting({ file, setting: INT, value: 1 }), /not an object/);
});

test('history keeps the newest copies only', () => {
  const file = tmpFile('{}');
  for (let i = 0; i < HISTORY_KEEP + 3; i += 1) writeSetting({ file, setting: INT, value: i % 20, now: new Date(Date.UTC(2026, 10, 17, 0, i)) });
  assert.equal(fs.readdirSync(historyDirOf(file)).length, HISTORY_KEEP);
});

test('parses systemctl show blocks by unit id', () => {
  const out = 'Id=a.timer\nActiveState=active\nNextElapseUSecRealtime=Tue 2026-11-17 16:15:20 -03\n\nId=a.service\nActiveState=inactive\nResult=success\n';
  const parsed = parseShow(out);
  assert.equal(parsed['a.timer'].NextElapseUSecRealtime, 'Tue 2026-11-17 16:15:20 -03');
  assert.equal(parsed['a.service'].Result, 'success');
});
