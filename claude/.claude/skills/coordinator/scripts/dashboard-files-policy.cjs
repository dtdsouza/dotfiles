// Which files the served dashboard may show: allowlisted root patterns, a name denylist that applies
// even inside them, an extension allowlist, and containment checked on the realpath.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOTS_ENV = 'COORDINATOR_DASHBOARD_FILE_ROOTS';
const DEFAULT_ROOTS = ['~/workspace/twism/**/.claude/tmp/**', '~/workspace/twism/**/.claude/worktrees/*/{.claude/tmp,docs,openspec}/**'];

const HTML = { kind: 'html', type: 'text/html; charset=utf-8' };
const FILE_TYPES = {
  '.html': HTML,
  '.htm': HTML,
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.png': { kind: 'image', type: 'image/png' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.gif': { kind: 'image', type: 'image/gif' },
  '.webp': { kind: 'image', type: 'image/webp' },
  '.svg': { kind: 'svg', type: 'image/svg+xml' },
  '.pdf': { kind: 'pdf', type: 'application/pdf' },
  '.md': { kind: 'text', type: 'text/markdown; charset=utf-8' },
};

const DENIED_WORDS = /token|secret|credential|passw|private[-_.]?key|api[-_.]?key/i;
const DENIED_SUFFIXES = /\.(env|pem|key|p12|pfx|crt|kdbx)$/i;
const SSH_KEY_NAMES = /^id_(rsa|dsa|ecdsa|ed25519)/;

const isDeniedName = (name) =>
  name.startsWith('.') || name === 'node_modules' || DENIED_SUFFIXES.test(name) || DENIED_WORDS.test(name) || SSH_KEY_NAMES.test(name);

const fileTypeOf = (file) => FILE_TYPES[path.extname(file).toLowerCase()] || null;

const expandBraces = (pattern) => {
  const group = pattern.match(/\{([^{}]*,[^{}]*)\}/);
  if (!group) return [pattern];
  const head = pattern.slice(0, group.index);
  const tail = pattern.slice(group.index + group[0].length);
  return group[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
};

const isGlob = (segment) => /[*?]/.test(segment);
const segmentRegex = (segment) =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

const realpathOr = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
};

// The literal head of a pattern is canonicalized once, so a symlinked ~/workspace still matches
// the realpaths that requests are checked against.
const compileRoot = (pattern, home) => {
  const expanded = pattern.trim().replace(/^~(?=\/|$)/, home);
  if (!path.isAbsolute(expanded)) return null;
  const segments = expanded.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  const firstGlob = segments.findIndex(isGlob);
  const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  const rest = firstGlob === -1 ? ['**'] : segments.slice(firstGlob);
  return { pattern, base: realpathOr(`/${literal.join('/')}`), segments: rest };
};

const parseRoots = (text, home = os.homedir()) =>
  String(text)
    .split(':')
    .filter((p) => p.trim())
    .flatMap(expandBraces)
    .map((p) => compileRoot(p, home))
    .filter(Boolean);

// null turns the viewer off.
const loadFilePolicy = (env = process.env, home = os.homedir(), profiles = []) => {
  const configured = (env[ROOTS_ENV] || '').trim();
  if (configured === 'off') return null;
  // An explicit global setting remains authoritative, including `off`. Profiles only augment
  // the defaults, so a Personal setting cannot replace another profile's configured policy.
  const defaults = [...DEFAULT_ROOTS, ...profiles.map((p) => p.fileRoots).filter(Boolean)];
  const roots = parseRoots(configured || defaults.join(':'), home);
  return roots.length ? { roots } : null;
};

// Wildcards never match a denied name, so `**` cannot walk into `.git/` or `node_modules/`; only a
// segment the pattern spells out (`.claude`) may start with a dot. Returns how many path segments
// come before the trailing `**` (the anchor), or -1.
const matchSegments = (pattern, segments, pi = 0, si = 0) => {
  if (pi === pattern.length) return si === segments.length ? segments.length - 1 : -1;
  const head = pattern[pi];
  if (head === '**') {
    if (pi === pattern.length - 1) return si < segments.length && segments.slice(si).every((s) => !isDeniedName(s)) ? si : -1;
    for (let k = si; k < segments.length; k += 1) {
      if (k > si && isDeniedName(segments[k - 1])) return -1;
      const found = matchSegments(pattern, segments, pi + 1, k);
      if (found !== -1) return found;
    }
    return -1;
  }
  if (si === segments.length) return -1;
  const segment = segments[si];
  const fits = isGlob(head) ? !isDeniedName(segment) && segmentRegex(head).test(segment) : head === segment;
  return fits ? matchSegments(pattern, segments, pi + 1, si + 1) : -1;
};

// artifactDir is the first directory under the anchor (`.claude/tmp/<task-dir>`): an HTML report
// may load its own assets from there. A file sitting right in the anchor gets no directory.
const matchRoots = (real, roots) => {
  if (isDeniedName(path.basename(real))) return null;
  for (const root of roots) {
    if (!real.startsWith(`${root.base}/`)) continue;
    const segments = real.slice(root.base.length + 1).split('/');
    const anchor = matchSegments(root.segments, segments);
    if (anchor === -1) continue;
    const artifactDir = anchor + 1 < segments.length ? path.join(root.base, ...segments.slice(0, anchor + 1)) : null;
    return { root: root.pattern, artifactDir };
  }
  return null;
};

const refuse = (status, reason) => ({ refusal: [status, reason] });

const validRequestPath = (requested) => {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) return false;
  if (!requested.startsWith('/')) return false;
  return requested
    .slice(1)
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..');
};

// Returns { real, kind, type, size, mtimeMs, artifactDir } or { refusal: [status, reason] }.
const resolveViewable = (requested, policy) => {
  if (!policy) return refuse(404, 'The file viewer is off.');
  if (!validRequestPath(requested)) return refuse(400, 'Invalid path.');
  if (!fileTypeOf(requested) || isDeniedName(path.basename(requested))) return refuse(403, 'This file is not viewable.');
  let real;
  try {
    real = fs.realpathSync.native(requested);
  } catch {
    return refuse(404, 'File not found.');
  }
  const fileType = fileTypeOf(real);
  if (!fileType) return refuse(403, 'This file is not viewable.');
  const match = matchRoots(real, policy.roots);
  if (!match) return refuse(403, 'This file is outside the viewable folders.');
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return refuse(404, 'File not found.');
  }
  if (!stat.isFile()) return refuse(404, 'Not a file.');
  return { real, ...fileType, size: stat.size, mtimeMs: stat.mtimeMs, artifactDir: match.artifactDir };
};

module.exports = { ROOTS_ENV, DEFAULT_ROOTS, isDeniedName, isGlob, segmentRegex, loadFilePolicy, resolveViewable };
