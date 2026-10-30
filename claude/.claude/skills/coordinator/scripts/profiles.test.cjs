const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRIMARY_PROFILE, parseEnvFile, loadProfiles, taskKey, parseTaskKey } = require('./profiles.cjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-profiles-'));
const writeProfile = (configHome, name, text) => {
  const dir = path.join(configHome, 'agentctl', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.env`), text);
};

describe('parseEnvFile', () => {
  test('reads KEY=value lines, strips quotes and comments, expands ~ and $HOME', () => {
    const text = '# comment\nA=plain\nB="double quoted"\nC=\'single\'\nD=~/x\nE=$HOME/y\nF=${HOME}/z\n\nnot a line\nexport G=exported\n';
    assert.deepEqual(parseEnvFile(text, '/home/u'), {
      A: 'plain',
      B: 'double quoted',
      C: 'single',
      D: '/home/u/x',
      E: '/home/u/y',
      F: '/home/u/z',
      G: 'exported',
    });
  });
});

describe('loadProfiles', () => {
  test('without profile files there is only the primary profile on the given state dir', () => {
    const profiles = loadProfiles({ primaryStateDir: '/state/twism', env: { XDG_CONFIG_HOME: tmpDir() }, home: '/home/u' });
    assert.deepEqual(profiles, [{ name: PRIMARY_PROFILE, label: 'Twism', stateDir: '/state/twism', session: '', harness: 'claude' }]);
  });

  test('adds every valid profile file after the primary, sorted by name', () => {
    const configHome = tmpDir();
    writeProfile(configHome, 'personal', 'AGENTCTL_LABEL=Personal\nCOORDINATOR_STATE_DIR=~/p/state\nAGENTCTL_SESSION=personal\nAGENTCTL_HARNESS=codex\n');
    writeProfile(configHome, 'lab', 'COORDINATOR_STATE_DIR=/lab/state\n');
    writeProfile(configHome, 'Bad Name', 'COORDINATOR_STATE_DIR=/x\n');
    writeProfile(configHome, 'nostate', 'AGENTCTL_LABEL=No state\n');
    const profiles = loadProfiles({ primaryStateDir: '/state/twism', env: { XDG_CONFIG_HOME: configHome }, home: '/home/u' });
    assert.deepEqual(
      profiles.map((p) => [p.name, p.label, p.stateDir, p.session, p.harness]),
      [
        ['twism', 'Twism', '/state/twism', '', 'claude'],
        ['lab', 'lab', '/lab/state', '', 'claude'],
        ['personal', 'Personal', '/home/u/p/state', 'personal', 'codex'],
      ],
    );
  });

  test('a twism profile file only adds settings to the primary, never moves its state dir', () => {
    const configHome = tmpDir();
    writeProfile(configHome, 'twism', 'COORDINATOR_STATE_DIR=/elsewhere\nAGENTCTL_SESSION=twism\n');
    const [primary, ...rest] = loadProfiles({ primaryStateDir: '/state/twism', env: { XDG_CONFIG_HOME: configHome }, home: '/home/u' });
    assert.equal(primary.stateDir, '/state/twism');
    assert.equal(primary.session, 'twism');
    assert.equal(rest.length, 0);
  });
});

describe('task keys', () => {
  test('primary tasks keep their bare id; other profiles prefix it', () => {
    assert.equal(taskKey('twism', 'a-task'), 'a-task');
    assert.equal(taskKey('personal', 'a-task'), 'personal/a-task');
    assert.deepEqual(parseTaskKey('a-task'), { profile: 'twism', id: 'a-task' });
    assert.deepEqual(parseTaskKey('personal/a-task'), { profile: 'personal', id: 'a-task' });
  });
});
