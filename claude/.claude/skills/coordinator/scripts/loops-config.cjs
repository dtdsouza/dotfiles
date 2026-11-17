'use strict';

// Writes one declared setting into a loop's JSON settings file: validated, atomic, with history.
const fs = require('fs');
const path = require('path');
const { ActionError } = require('./dashboard-actions.cjs');

const HISTORY_KEEP = 20;

const validateValue = (setting, value) => {
  if (setting.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ActionError(`${setting.label} must be on or off.`);
    return value;
  }
  if (setting.type === 'enum') {
    if (!setting.values.includes(value)) throw new ActionError(`${setting.label} must be one of ${setting.values.join(', ')}.`);
    return value;
  }
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new ActionError(`${setting.label} must be a number.`);
  if (setting.type === 'integer' && !Number.isInteger(number)) throw new ActionError(`${setting.label} must be a whole number.`);
  if (number < setting.min || number > setting.max) throw new ActionError(`${setting.label} must be between ${setting.min} and ${setting.max}.`);
  return number;
};

const readSettingsFile = (file) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { doc: {}, raw: null };
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ActionError(`${path.basename(file)} is not valid JSON; fix it by hand before editing it here.`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ActionError(`${path.basename(file)} does not hold a JSON object.`);
  return { doc, raw };
};

const getPath = (doc, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' && Object.hasOwn(node, part) ? node[part] : undefined), doc);

const setPath = (doc, [head, ...rest], value) => {
  if (!rest.length) return { ...doc, [head]: value };
  const child = doc[head];
  if (child !== undefined && (typeof child !== 'object' || child === null || Array.isArray(child))) throw new ActionError(`${head} in the settings file is not an object.`);
  return { ...doc, [head]: setPath(child || {}, rest, value) };
};

const historyDirOf = (file) => `${file}.history`;

const keepHistory = (file, raw, now) => {
  if (raw === null) return;
  const dir = historyDirOf(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.json`), raw, { mode: 0o600 });
  const old = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(0, -HISTORY_KEEP);
  old.forEach((n) => fs.rmSync(path.join(dir, n), { force: true }));
};

const writeSetting = ({ file, setting, value, now = new Date() }) => {
  const valid = validateValue(setting, value);
  const { doc, raw } = readSettingsFile(file);
  const from = getPath(doc, setting.key);
  const next = setPath(doc, setting.key.split('.'), valid);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  keepHistory(file, raw, now);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { from: from === undefined ? null : from, to: valid };
};

module.exports = { HISTORY_KEEP, validateValue, writeSetting, getPath, historyDirOf };
