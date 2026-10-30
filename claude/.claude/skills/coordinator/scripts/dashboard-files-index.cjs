// Finds the viewable artifacts (walking the allowlisted roots and reading the paths the ledger notes
// mention) and works out which task each one belongs to.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeniedName, isGlob, segmentRegex, resolveViewable } = require('./dashboard-files-policy.cjs');

// Bounds keep a page load cheap: `**` before the anchor stays shallow (group/repo/sub-project), and
// demo frame folders can hold thousands of images, which the listed kinds skip anyway.
const MAX_MIDDLE_DEPTH = 4;
const MAX_TRAILING_DEPTH = 6;
const MAX_FILES = 3000;
const INDEX_TTL_MS = 30000;
const LISTED_KINDS = new Set(['html', 'video', 'pdf']);
const LISTED_EXTENSIONS = /\.(html?|mp4|webm|pdf)$/i;

const readDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const childDirs = (dir) => readDirs(dir).filter((d) => d.isDirectory());

// Walks the folders a root pattern can match without following symlinks; every hit is re-checked
// through resolveViewable, so the walk only has to be complete, not strict.
const walkRoot = (root, found) => {
  const collect = (dir, depth) => {
    for (const entry of readDirs(dir)) {
      if (found.size >= MAX_FILES || isDeniedName(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_TRAILING_DEPTH) collect(full, depth + 1);
      else if (entry.isFile() && LISTED_EXTENSIONS.test(entry.name)) found.add(full);
    }
  };
  const visit = (dir, index, depth) => {
    if (found.size >= MAX_FILES || index >= root.segments.length) return;
    const segment = root.segments[index];
    if (segment === '**' && index === root.segments.length - 1) return collect(dir, 0);
    if (segment === '**') {
      visit(dir, index + 1, depth);
      if (depth < MAX_MIDDLE_DEPTH) childDirs(dir).filter((d) => !isDeniedName(d.name)).forEach((d) => visit(path.join(dir, d.name), index, depth + 1));
      return;
    }
    if (isGlob(segment)) {
      const re = segmentRegex(segment);
      childDirs(dir).filter((d) => !isDeniedName(d.name) && re.test(d.name)).forEach((d) => visit(path.join(dir, d.name), index + 1, depth));
      return;
    }
    const next = path.join(dir, segment);
    if (childDirs(dir).some((d) => d.name === segment)) visit(next, index + 1, depth);
  };
  visit(root.base, 0, 0);
};

const scanArtifacts = (policy) => {
  const found = new Set();
  policy.roots.forEach((root) => walkRoot(root, found));
  const byReal = new Map();
  for (const file of found) {
    const viewable = resolveViewable(file, policy);
    if (!viewable.refusal && LISTED_KINDS.has(viewable.kind)) byReal.set(viewable.real, viewable);
  }
  return [...byReal.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const createArtifactIndex = (policy, { ttlMs = INDEX_TTL_MS, now = Date.now } = {}) => {
  let cache = { at: -Infinity, files: [] };
  return {
    list: () => {
      if (now() - cache.at > ttlMs) cache = { at: now(), files: scanArtifacts(policy) };
      return cache.files;
    },
  };
};

// Ledger notes name artifacts as file:// URLs, absolute or ~ paths, or repo-relative .claude/ paths,
// sometimes with a brace list (`report.{md,html}`).
const PATH_CHARS = "[^\\s`\"'<>()\\[\\]|]+";
const NOTE_PATH_PATTERN = new RegExp(`file://(/${PATH_CHARS})|(?<![\\w.~/-])(~?/${PATH_CHARS})|(?<![\\w.-])(\\.claude/${PATH_CHARS})`, 'g');
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const expandNoteBraces = (text) => {
  const group = text.match(/\{([^{}/]*,[^{}/]*)\}/);
  if (!group) return [text];
  return group[1].split(',').flatMap((alt) => expandNoteBraces(text.slice(0, group.index) + alt + text.slice(group.index + group[0].length)));
};

const findNoteRefs = (text) =>
  [...String(text).matchAll(NOTE_PATH_PATTERN)].map((m) => {
    const raw = m[0].replace(TRAILING_PUNCTUATION, '');
    const written = (m[1] || m[2] || m[3]).replace(TRAILING_PUNCTUATION, '');
    let decoded = written;
    try {
      decoded = m[1] ? decodeURIComponent(written) : written;
    } catch {}
    return { start: m.index, end: m.index + raw.length, raw, candidates: expandNoteBraces(decoded) };
  });

const candidatePaths = (candidate, bases, home) => {
  if (candidate.startsWith('~/')) return [path.join(home, candidate.slice(2))];
  if (candidate.startsWith('/')) return [candidate];
  return bases.filter(Boolean).map((base) => path.join(base, candidate));
};

const resolveCandidate = (candidate, bases, policy, home = os.homedir()) => {
  for (const file of candidatePaths(candidate, bases, home)) {
    const viewable = resolveViewable(file, policy);
    if (!viewable.refusal) return viewable;
  }
  return null;
};

const readNotesText = (stateDir, id) => {
  try {
    return fs.readFileSync(path.join(stateDir, 'tasks', id, 'notes.md'), 'utf8');
  } catch {
    return '';
  }
};

const isWorktree = (dir) => /\/\.claude\/worktrees\/[^/]+\/?$/.test(dir || '');
const isInside = (file, dir) => Boolean(dir) && file.startsWith(`${dir.replace(/\/$/, '')}/`);
const realDir = (dir) => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return '';
  }
};

const ticketOf = (name) => (String(name).match(/^(\d{4,6})-/) || [])[1] || '';

// A note mention wins, then a worker's own worktree, then a task-named artifact folder, then a
// folder sharing a ticket number with exactly one task.
const createAttribution = (metas, mentions) => {
  const worktrees = metas.filter((m) => isWorktree(m.workdir)).map((m) => ({ id: m.id, dir: realDir(m.workdir) })).filter((w) => w.dir);
  const ids = new Set(metas.map((m) => m.id));
  return (file) => {
    if (mentions.has(file.real)) return mentions.get(file.real);
    const worktree = worktrees.find((w) => isInside(file.real, w.dir));
    if (worktree) return worktree.id;
    const folder = file.artifactDir ? path.basename(file.artifactDir) : '';
    if (ids.has(folder)) return folder;
    const ticket = ticketOf(folder);
    const sameTicket = ticket ? [...ids].filter((id) => ticketOf(id) === ticket) : [];
    return sameTicket.length === 1 ? sameTicket[0] : '';
  };
};

// Reads every task's notes once: which artifacts each one mentions, and who mentioned each file
// last (by task creation time).
const collectMentions = (stateDir, metas, policy) => {
  const byTask = new Map();
  const owner = new Map();
  [...metas]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .forEach((meta) => {
      const bases = [meta.workdir, meta.repo];
      const files = findNoteRefs(readNotesText(stateDir, meta.id))
        .flatMap((ref) => ref.candidates.map((c) => resolveCandidate(c, bases, policy)))
        .filter(Boolean);
      byTask.set(meta.id, files);
      files.forEach((f) => owner.set(f.real, meta.id));
    });
  return { byTask, owner };
};

module.exports = { createArtifactIndex, findNoteRefs, resolveCandidate, collectMentions, createAttribution };
