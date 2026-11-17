'use strict';

// The Loops page's server side: status reads, verb actions, settings edits and draft decisions.
// Everything executed comes from a manifest loaded at start; the request only names a loop, a
// verb from a fixed list, a declared setting key, or a draft id plus its hash.
const fs = require('fs');
const os = require('os');
const { ActionError } = require('./dashboard-actions.cjs');
const { ID } = require('./loops-registry.cjs');
const runner = require('./loops-runner.cjs');
const { writeSetting, validateValue } = require('./loops-config.cjs');
const { HASH, TEXT_MAX, findDraft, readDrafts } = require('./loops-drafts.cjs');

const ACTION_VERBS = ['pause', 'resume', 'run-once', 'kill', 'disable-timer', 'enable-timer'];
const LOCAL_ONLY = new Set(['disable-timer', 'enable-timer']);
const RISK_RAISING = new Set(['resume', 'run-once', 'enable-timer']);
// Pause and kill only lower risk, so a rate-limited page can still use them.
const ALWAYS_ALLOWED = new Set(['pause', 'kill']);
const RUN_ONCE_DEBOUNCE_MS = 10 * 60 * 1000;
const CONTROL_HISTORY = 5;
const AUDIT_TAIL_BYTES = 128 * 1024;
const STATES = new Set(['running', 'paused', 'killed', 'error']);
const LEVELS = new Set(['info', 'error', 'warn']);

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v, max, shape) => (Array.isArray(v) ? v.slice(0, max).map(shape).filter(Boolean) : []);

// The adapter's output is trusted no further than its shape: bounded lists, plain values.
const shapeStatus = (raw, loop) => {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const declared = new Map((loop.settings?.keys || []).map((s) => [s.key, s]));
  const settings = Object.fromEntries(
    Object.entries(doc.settings && typeof doc.settings === 'object' ? doc.settings : {})
      .filter(([key, value]) => declared.has(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 60) : value]),
  );
  const cost = doc.cost && typeof doc.cost === 'object' ? doc.cost : null;
  return {
    state: STATES.has(doc.state) ? doc.state : 'unknown',
    summary: str(doc.summary),
    mode: str(doc.mode, 20),
    in_flight: list(doc.in_flight, 10, (f) => (f && typeof f === 'object' ? { label: str(f.label, 120), since: str(f.since, 40) } : null)),
    caps: list(doc.caps, 10, (c) => (c && typeof c === 'object' ? { name: str(c.name, 60), used: num(c.used), limit: num(c.limit) } : null)),
    cost: cost ? { today_usd: num(cost.today_usd), week_usd: num(cost.week_usd), week_limit_usd: num(cost.week_limit_usd), basis: cost.basis === 'measured' ? 'measured' : 'estimate' } : null,
    pending: Number.isInteger(doc.pending) ? doc.pending : 0,
    errors: list(doc.errors, 20, (e) => (e && typeof e === 'object' ? { at: str(e.at, 40), text: str(e.text) } : null)),
    recent: list(doc.recent, 50, (r) => (r && typeof r === 'object' ? { at: str(r.at, 40), text: str(r.text), level: LEVELS.has(r.level) ? r.level : 'info' } : null)),
    notes: list(doc.notes, 5, (n) => str(n) || null),
    last_outcome: doc.last_outcome === 'error' ? 'error' : 'ok',
    settings,
  };
};

const overBudget = (status) => {
  const cost = status?.cost;
  return cost && cost.week_limit_usd !== null && cost.week_usd !== null && cost.week_usd >= cost.week_limit_usd;
};

const dotOf = (adapter, units) => {
  if (!adapter.ok) return 'error';
  if (units.timer && units.timer.active !== 'active') return 'off';
  if (adapter.status.state === 'paused' || adapter.status.state === 'killed') return 'paused';
  // A failed tick is a loop error; an event such as a refused approve is shown in Errors, not as a red dot.
  if (adapter.status.state === 'error' || (units.service && units.service.result && units.service.result !== 'success')) return 'error';
  return adapter.status.pending > 0 ? 'needs' : 'running';
};

const publicLoop = (loop) => ({
  id: loop.id,
  name: loop.name,
  icon: loop.icon,
  profile: loop.profile,
  description: loop.description,
  risk: loop.risk,
  schedule: loop.schedule,
  units: loop.units,
  verbs: ACTION_VERBS.filter((v) => (LOCAL_ONLY.has(v) ? Boolean(loop.units.timer) : Boolean(loop.verbs[v]))),
  phone: [...loop.phone],
  settings: loop.settings ? { file: loop.settings.file.replace(os.homedir(), '~'), note: loop.settings.note, keys: loop.settings.keys } : null,
  drafts: Boolean(loop.decisions),
});

const readTail = (file, bytes) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const createLoopsApi = ({ loops = [], auditFile, appendAudit, exec = runner.exec, now = Date.now, cacheTtlMs = 10000 }) => {
  const byId = new Map(loops.map((l) => [l.id, l]));
  const cache = runner.createStatusCache({ ttlMs: cacheTtlMs, now });
  const lastRunOnce = new Map();

  const loopOf = (id) => {
    if (typeof id !== 'string' || !ID.test(id) || !byId.has(id)) throw new ActionError('Unknown loop.');
    return byId.get(id);
  };

  const audit = (entry, source) => {
    try {
      appendAudit(auditFile, { at: new Date(now()).toISOString(), kind: 'loop', source, ...entry });
    } catch (err) {
      console.error('[dashboard] writing the audit log failed:', err.message);
    }
  };

  const adapterStatus = (loop) =>
    cache.get(`status:${loop.id}`, async () => {
      const result = await exec(runner.verbArgv(loop, 'status'));
      if (result.code !== 0) return { ok: false, error: result.error || `status exited ${result.code}` };
      try {
        return { ok: true, status: shapeStatus(JSON.parse(result.stdout), loop) };
      } catch {
        return { ok: false, error: 'status --json did not print JSON' };
      }
    });

  const unitsStatus = (loop) => cache.get(`units:${loop.id}`, () => runner.systemdShow(loop.units, { run: exec }).catch(() => ({ timer: null, service: null })));

  const fresh = (loop) => {
    cache.drop(`status:${loop.id}`);
    cache.drop(`units:${loop.id}`);
  };

  const controls = (loop) =>
    readTail(auditFile, AUDIT_TAIL_BYTES)
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.kind === 'loop' && e.loop === loop.id)
      .slice(-CONTROL_HISTORY)
      .reverse()
      .map((e) => ({ at: str(e.at, 40), verb: str(e.verb, 20), key: str(e.key, 60), from: e.from ?? null, to: e.to ?? null, source: str(e.source, 80), exit: Number.isInteger(e.exit) ? e.exit : null }));

  const summaryOf = async (loop) => {
    const [adapter, units] = await Promise.all([adapterStatus(loop), unitsStatus(loop)]);
    const drafts = loop.decisions ? readDrafts(loop.decisions.dir).length : 0;
    return { adapter, units, drafts, dot: drafts > 0 && adapter.ok ? 'needs' : dotOf(adapter, units) };
  };

  const listLoops = async () =>
    Promise.all(
      loops.map(async (loop) => {
        const { adapter, units, drafts, dot } = await summaryOf(loop);
        return { ...publicLoop(loop), dot, summary: adapter.ok ? adapter.status.summary : adapter.error, mode: adapter.ok ? adapter.status.mode : '', state: adapter.ok ? adapter.status.state : 'error', pending: (adapter.ok ? adapter.status.pending : 0) + drafts, next: units.timer?.next || '', cost: adapter.ok ? adapter.status.cost : null, timer: units.timer?.active || '' };
      }),
    );

  const loopStatus = async (id) => {
    const loop = loopOf(id);
    const { adapter, units, drafts, dot } = await summaryOf(loop);
    return { loop: publicLoop(loop), dot, adapter, units, drafts, controls: controls(loop) };
  };

  const loopAction = async (body, context) => {
    const loop = loopOf(body.loop);
    const { verb } = body;
    if (!ACTION_VERBS.includes(verb)) throw new ActionError('Unknown action.');
    const phone = context.via === 'tailnet';
    let argv;
    if (LOCAL_ONLY.has(verb)) {
      if (phone) throw new ActionError('Turning the timer off or on is local only: do it on the PC.');
      argv = runner.timerArgv(loop, verb === 'enable-timer');
    } else {
      if (phone && !loop.phone.has(verb)) throw new ActionError(`${verb} is not offered on the phone for ${loop.name}.`);
      argv = runner.verbArgv(loop, verb);
    }
    if (!argv) throw new ActionError(`${loop.name} has no ${verb}.`);
    if (RISK_RAISING.has(verb)) {
      fresh(loop);
      const adapter = await adapterStatus(loop);
      if (adapter.ok && overBudget(adapter.status)) throw new ActionError(`${loop.name} is at its weekly budget; raise it in Settings or wait.`);
    }
    if (verb === 'run-once') {
      const last = lastRunOnce.get(loop.id) || 0;
      if (now() - last < RUN_ONCE_DEBOUNCE_MS) throw new ActionError(`Run now was used less than 10 minutes ago for ${loop.name}.`);
      lastRunOnce.set(loop.id, now());
    }
    const result = await exec(argv);
    fresh(loop);
    audit({ loop: loop.id, verb, exit: result.code }, context.source);
    if (result.code !== 0) throw new ActionError(`${verb} failed: ${result.error || `exit ${result.code}`}`);
    return { message: `${loop.name}: ${verb} done${result.stdout.trim() ? ` (${result.stdout.trim().split('\n').pop().slice(0, 120)})` : ''}` };
  };

  const loopConfig = (body, context) => {
    const loop = loopOf(body.loop);
    const setting = loop.settings?.keys.find((s) => s.key === body.key);
    if (!setting) throw new ActionError('That setting cannot be edited here.');
    if (context.via === 'tailnet' && !setting.phone) throw new ActionError(`${setting.label} can only be changed on the PC.`);
    validateValue(setting, body.value);
    const { from, to } = writeSetting({ file: loop.settings.file, setting, value: body.value, now: new Date(now()) });
    fresh(loop);
    audit({ loop: loop.id, verb: 'config', key: setting.key, from, to, exit: 0 }, context.source);
    return { message: `${loop.name}: ${setting.label} ${from === null ? 'set to' : `${from} →`} ${to}` };
  };

  const loopDraft = (query) => {
    const loop = loopOf(query.loop);
    return { draft: findDraft(loop, query.id) };
  };

  const loopDecide = async (body, context) => {
    const loop = loopOf(body.loop);
    const draft = findDraft(loop, body.id);
    if (typeof body.hash !== 'string' || !HASH.test(body.hash) || body.hash !== draft.hash) throw new ActionError('The draft changed since the page loaded it; reopen it.');
    if (body.answer !== 'yes' && body.answer !== 'no') throw new ActionError('Answer yes or no.');
    const edited = typeof body.text === 'string' && body.answer === 'yes' && body.text.trim() !== draft.reply.trim();
    if (edited && (body.text.length > TEXT_MAX || !body.text.trim())) throw new ActionError(`The reply must be 1-${TEXT_MAX} characters.`);
    const argv = [...loop.decisions.decide, draft.id, draft.hash, body.answer, ...(edited ? ['--text-stdin'] : [])];
    const result = await exec(argv, edited ? { stdin: body.text } : {});
    fresh(loop);
    audit({ loop: loop.id, verb: body.answer === 'yes' ? (edited ? 'approve-edited' : 'approve') : 'discard', key: draft.id, exit: result.code }, context.source);
    if (result.code !== 0) throw new ActionError(`The decision was not recorded: ${result.error || `exit ${result.code}`}`);
    return { message: result.stdout.trim().split('\n').pop().slice(0, 200) || 'Recorded.' };
  };

  const allDrafts = () => loops.filter((l) => l.decisions).flatMap((l) => readDrafts(l.decisions.dir).map((d) => ({ loop: l, draft: d })));

  return { loops, listLoops, loopStatus, loopAction, loopConfig, loopDraft, loopDecide, allDrafts, exemptFromLimit: (body) => body && ALWAYS_ALLOWED.has(body.verb) };
};

module.exports = { ACTION_VERBS, createLoopsApi, shapeStatus, overBudget, dotOf };
