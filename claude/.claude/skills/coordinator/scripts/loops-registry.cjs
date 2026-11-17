'use strict';

// Loop manifests (~/.config/agentctl/loops/<id>.json), read once when the server starts. A manifest
// decides what the dashboard may execute, so validation is strict and a bad file is skipped whole.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[a-z0-9-]{1,32}$/;
const UNIT = /^[a-zA-Z0-9@._-]{1,80}\.(service|timer)$/;
const SETTING_KEY = /^[a-zA-Z0-9_]{1,40}(\.[a-zA-Z0-9_]{1,40}){0,3}$/;
const SECRET_KEY = /token|secret|passw|cred|api[-_]?key|private|(^|[._])(key|path|file|dir)$/i;
const SECRET_FILE = /token|secret|credential|passw|\.(key|pem|cred|p12|pfx)$/i;
const VERBS = ['status', 'pause', 'resume', 'run-once', 'kill'];
const SYSTEMD = { 'systemd:start-service': 'start', 'systemd:stop-service': 'stop' };
const INTERPRETERS = { python3: '/usr/bin/python3', node: process.execPath, bash: '/bin/bash' };
const SETTING_TYPES = new Set(['integer', 'number', 'boolean', 'enum']);
const ICONS = new Set(['mr', 'bug', 'loop', 'clock']);
const TEXT_MAX = 300;
const MAX_ARGS = 12;
const MAX_SETTINGS = 24;

const defaultDir = (env = process.env, home = os.homedir()) => env.COORDINATOR_DASHBOARD_LOOPS_DIR || path.join(home, '.config/agentctl/loops');

class ManifestError extends Error {}
const fail = (message) => {
  throw new ManifestError(message);
};

const text = (value, name, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > TEXT_MAX || (required && !value)) fail(`${name} must be a string of at most ${TEXT_MAX} characters`);
  return value;
};

const expandHome = (value, home) => (value.startsWith('~/') ? path.join(home, value.slice(2)) : value);

// Lexical, not realpath: skills are symlinks into their repos, and the manifest names the skill path.
const underRoot = (file, root) => !file.split('/').includes('..') && path.normalize(file).startsWith(root + path.sep);

const argvOf = (raw, name, home) => {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ARGS || !raw.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200)) {
    fail(`${name} must be [interpreter, script, ...args] of plain strings`);
  }
  const [interpreter, script, ...args] = raw;
  if (!INTERPRETERS[interpreter]) fail(`${name}: interpreter must be one of ${Object.keys(INTERPRETERS).join(', ')}`);
  const absolute = expandHome(script, home);
  if (!underRoot(absolute, path.join(home, '.claude/skills'))) fail(`${name}: the script must be under ~/.claude/skills/`);
  if (args.some((a) => a.includes('\0'))) fail(`${name}: NUL in an argument`);
  return [INTERPRETERS[interpreter], absolute, ...args];
};

const verbsOf = (raw, units, home) => {
  if (!raw || typeof raw !== 'object') fail('verbs must be an object');
  const verbs = {};
  for (const [verb, value] of Object.entries(raw)) {
    if (!VERBS.includes(verb)) fail(`unknown verb ${verb}`);
    if (value === null) continue;
    if (typeof value === 'string') {
      if (!SYSTEMD[value]) fail(`${verb}: unknown systemd verb ${value}`);
      if (!units.service) fail(`${verb}: ${value} needs units.service`);
      verbs[verb] = { systemd: SYSTEMD[value], unit: units.service };
    } else {
      verbs[verb] = { argv: argvOf(value, verb, home) };
    }
  }
  if (!verbs.status) fail('the status verb is required');
  return verbs;
};

const unitsOf = (raw) => {
  const units = {};
  for (const kind of ['timer', 'service']) {
    if (raw?.[kind] === undefined) continue;
    if (typeof raw[kind] !== 'string' || !UNIT.test(raw[kind]) || !raw[kind].endsWith(`.${kind}`)) fail(`units.${kind} is not a ${kind} unit name`);
    units[kind] = raw[kind];
  }
  return units;
};

const settingOf = (raw) => {
  if (!raw || typeof raw !== 'object') fail('each setting must be an object');
  const { key, type } = raw;
  if (typeof key !== 'string' || !SETTING_KEY.test(key)) fail(`setting key ${key} is not a dotted name`);
  if (SECRET_KEY.test(key)) fail(`setting ${key} looks like a secret or a path; it cannot be edited from the dashboard`);
  if (!SETTING_TYPES.has(type)) fail(`setting ${key}: type must be integer, number, boolean or enum`);
  const setting = { key, type, label: text(raw.label, `${key}.label`) || key, description: text(raw.description, `${key}.description`), badge: raw.badge === true, phone: raw.phone !== false };
  if (type === 'integer' || type === 'number') {
    if (!Number.isFinite(raw.min) || !Number.isFinite(raw.max) || raw.min > raw.max) fail(`setting ${key}: needs a finite min and max`);
    return { ...setting, min: raw.min, max: raw.max };
  }
  if (type === 'enum') {
    if (!Array.isArray(raw.values) || !raw.values.length || raw.values.length > 20 || !raw.values.every((v) => typeof v === 'string' && v.length <= 40)) fail(`setting ${key}: enum needs 1-20 string values`);
    return { ...setting, values: [...raw.values] };
  }
  return setting;
};

const configFileOf = (raw, home, name) => {
  if (typeof raw !== 'string') fail(`${name} must be a path`);
  const file = expandHome(raw, home);
  const allowed = [path.join(home, '.config'), path.join(home, '.local/share'), path.join(home, '.local/state')].some((root) => underRoot(file, root));
  if (!allowed || SECRET_FILE.test(path.basename(file))) fail(`${name} must be under ~/.config, ~/.local/share or ~/.local/state and not look like a secret`);
  return file;
};

const settingsOf = (raw, home) => {
  if (raw === undefined || raw === null) return null;
  const file = configFileOf(raw.file, home, 'settings file');
  if (!file.endsWith('.json')) fail('settings file must be a .json file');
  if (!Array.isArray(raw.keys) || raw.keys.length > MAX_SETTINGS) fail(`settings.keys must be a list of at most ${MAX_SETTINGS}`);
  const keys = raw.keys.map(settingOf);
  if (new Set(keys.map((k) => k.key)).size !== keys.length) fail('settings keys repeat');
  return { file, note: text(raw.note, 'settings.note'), keys };
};

const decisionsOf = (raw, home) => {
  if (raw === undefined || raw === null) return null;
  if (raw.kind !== 'drafts') fail('decisions.kind must be drafts');
  return { kind: 'drafts', dir: configFileOf(raw.dir, home, 'decisions.dir'), decide: argvOf(raw.decide, 'decisions.decide', home) };
};

const parseManifest = (doc, fileId, home) => {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('the manifest must be a JSON object');
  if (!ID.test(String(doc.id))) fail('id must match [a-z0-9-]{1,32}');
  if (doc.id !== fileId) fail(`id ${doc.id} does not match the file name ${fileId}.json`);
  const units = unitsOf(doc.units);
  const verbs = verbsOf(doc.verbs, units, home);
  const phone = new Set(Array.isArray(doc.phone) ? doc.phone.filter((v) => verbs[v]) : []);
  return {
    id: doc.id,
    name: text(doc.name, 'name', true),
    icon: ICONS.has(doc.icon) ? doc.icon : 'loop',
    profile: text(doc.profile, 'profile') || 'twism',
    description: text(doc.description, 'description'),
    risk: text(doc.risk, 'risk'),
    schedule: text(doc.schedule, 'schedule'),
    units,
    verbs,
    phone,
    settings: settingsOf(doc.settings, home),
    decisions: decisionsOf(doc.decisions, home),
  };
};

const checkOwnership = (file) => {
  const stat = fs.statSync(file);
  if (stat.uid !== process.getuid()) fail('the manifest is not owned by you');
  if (stat.mode & 0o022) fail('the manifest is writable by others (chmod 600 it)');
};

const loadLoops = ({ dir = defaultDir(), home = os.homedir() } = {}) => {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { loops: [], errors: [] };
  }
  const loops = [];
  const errors = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      checkOwnership(file);
      loops.push(parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')), name.slice(0, -'.json'.length), home));
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { loops, errors };
};

module.exports = { ID, VERBS, defaultDir, loadLoops, parseManifest };
