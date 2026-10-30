// Serves allowlisted files under /v/<token>/<absolute path>. The token, not the cookie, authorizes
// these requests, because every response here is sandboxed into an opaque origin, and a report's
// own <img>/<video> requests from that origin never carry the SameSite=Strict cookie.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveViewable } = require('./dashboard-files-policy.cjs');

const VIEW_PREFIX = '/v/';
const TOKEN_TTL_SECONDS = 3600;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TOKEN_PATTERN = /^(\d{1,12})\.(\d{1,3})\.([A-Za-z0-9_-]{43})$/;
const FONT_SOURCES = 'https://fonts.gstatic.com https://cdn.fontshare.com https://api.fontshare.com';
const STYLE_SOURCES = 'https://fonts.googleapis.com https://api.fontshare.com';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A per-process secret: restarting the server revokes every link it handed out.
const createSigner = ({ secret = crypto.randomBytes(32), now = Date.now, ttlSeconds = TOKEN_TTL_SECONDS } = {}) => {
  const mac = (exp, scope) => crypto.createHmac('sha256', secret).update(`v1\n${exp}\n${scope}`).digest('base64url');
  const encodePath = (abs) => abs.split('/').map(encodeURIComponent).join('/');
  return {
    // scope is the file itself or a folder above it; the link then also opens that folder's other files.
    href: (file, scope = file) => {
      const exp = Math.floor(now() / 1000) + ttlSeconds;
      const depth = scope.split('/').length - 1;
      return `${VIEW_PREFIX}${exp}.${depth}.${mac(exp, scope)}${encodePath(file)}`;
    },
    // Returns { file, scope } for a well-formed, unexpired, untampered link, else a refusal.
    verify: (pathname) => {
      const [token, ...encoded] = pathname.slice(VIEW_PREFIX.length).split('/');
      const parts = TOKEN_PATTERN.exec(token || '');
      if (!parts) return { refusal: [403, 'This link is not valid.'] };
      let segments;
      try {
        segments = encoded.map(decodeURIComponent);
      } catch {
        return { refusal: [400, 'Invalid path.'] };
      }
      if (!segments.length || segments.some((s) => !s || s === '.' || s === '..' || s.includes('/') || s.includes('\0'))) return { refusal: [400, 'Invalid path.'] };
      const [, exp, depth, given] = parts;
      if (Number(depth) < 1 || Number(depth) > segments.length) return { refusal: [403, 'This link is not valid.'] };
      const scope = `/${segments.slice(0, Number(depth)).join('/')}`;
      if (!crypto.timingSafeEqual(Buffer.from(mac(exp, scope)), Buffer.from(given))) return { refusal: [403, 'This link is not valid.'] };
      if (Number(exp) * 1000 <= now()) return { refusal: [410, 'This link expired. Reload the dashboard or the Files page and open it again.'] };
      return { file: `/${segments.join('/')}`, scope };
    },
  };
};

// An HTML report may load its siblings in its own artifact folder; anything else is scoped to itself.
const linkScope = (viewable) => (viewable.kind === 'html' && viewable.artifactDir ? viewable.artifactDir : viewable.real);

const viewHref = (signer, viewable) => signer.href(viewable.real, linkScope(viewable)) + (viewable.kind === 'video' ? '?play' : '');

// RFC 9110: a malformed or multi-range header is ignored (200), an unsatisfiable one gets a 416.
const UNSATISFIABLE = 'unsatisfiable';
const parseRange = (header, size) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    return suffix === 0 || size === 0 ? UNSATISFIABLE : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  return start >= size ? UNSATISFIABLE : { start, end };
};

// No allow-same-origin: the document gets an opaque origin, so it cannot read the dashboard, send
// its cookie or pass the Origin check on the action endpoints. No COOP either: browsers refuse a
// sandboxed top-level document that also sends a Cross-Origin-Opener-Policy.
const sandboxCsp = (kind, self) => {
  const own = `'self' ${self}`;
  if (kind === 'html') {
    return [
      'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      `style-src 'unsafe-inline' ${STYLE_SOURCES}`,
      `font-src data: ${FONT_SOURCES}`,
      `img-src ${own} data: blob:`,
      `media-src ${own} data: blob:`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return ['sandbox allow-downloads', "default-src 'none'", "style-src 'unsafe-inline'", `img-src ${own} data:`, `media-src ${own}`, "frame-ancestors 'none'"].join('; ');
};

const baseHeaders = (viewable) => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // The sandboxed page is a different (opaque) origin from its own images and videos.
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': viewable.kind === 'html' || viewable.kind === 'text' ? 'no-store' : 'private, max-age=300',
});

// Chrome cannot show a PDF in a sandboxed document, so a PDF gets the viewer's own isolation and
// no page CSP.
const headersFor = (viewable, self) => ({
  ...baseHeaders(viewable),
  ...(viewable.kind === 'pdf' ? { 'Content-Disposition': `inline; filename="${path.basename(viewable.real).replace(/[^\w.-]/g, '_')}"` } : { 'Content-Security-Policy': sandboxCsp(viewable.kind, self) }),
});

const viewerShell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#000516;color:rgba(255,255,255,.85);font:14px/1.5 Inter,system-ui,sans-serif}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}
.bar b{color:#fff;font-weight:600;word-break:break-all}.bar a{color:#baf764;white-space:nowrap}
video{display:block;width:100%;max-height:82vh;background:#000}.meta{padding:10px 16px;color:rgba(255,255,255,.55);font-size:12px}
pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,"JetBrains Mono",monospace;color:#e6e9f2}
@media (prefers-color-scheme:light){:root{color-scheme:light}body{background:#f4f6fb;color:#0b1020}.bar b{color:#0b1020}.bar a{color:#3f6b0a}pre{color:#1b2235}.meta{color:rgba(11,16,32,.62)}}</style></head><body>${body}</body></html>`;

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const playerPage = (viewable) => {
  const name = path.basename(viewable.real);
  const src = esc(encodeURIComponent(name));
  const type = viewable.type.split(';')[0];
  return viewerShell(
    name,
    `<div class="bar"><b>${esc(name)}</b><a href="${src}" download>Download</a></div><video controls playsinline preload="metadata"><source src="${src}" type="${type}"></video><div class="meta">${sizeLabel(viewable.size)} · ${esc(new Date(viewable.mtimeMs).toLocaleString('en-GB', { hour12: false }))}</div>`,
  );
};

const readTextHead = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_TEXT_BYTES);
    const read = fs.readSync(fd, buffer, 0, MAX_TEXT_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
};

const textPage = (viewable) => {
  const name = path.basename(viewable.real);
  const cut = viewable.size > MAX_TEXT_BYTES ? `<div class="meta">Showing the first ${sizeLabel(MAX_TEXT_BYTES)} of ${sizeLabel(viewable.size)}.</div>` : '';
  return viewerShell(name, `<div class="bar"><b>${esc(name)}</b></div>${cut}<pre>${esc(readTextHead(viewable.real))}</pre>`);
};

const sendRefusal = (res, [status, message]) => {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  res.end(`${message}\n`);
};

const sendPage = (req, res, viewable, self, html) => {
  const body = Buffer.from(html);
  res.writeHead(200, { ...headersFor({ ...viewable, kind: 'page' }, self), 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
};

// O_NOFOLLOW plus fstat: the bytes come from the file that was checked, not from a symlink swapped
// in after the realpath check.
const sendFile = (req, res, viewable, self) => {
  let fd;
  try {
    fd = fs.openSync(viewable.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return sendRefusal(res, [404, 'File not found.']);
  }
  const size = fs.fstatSync(fd).size;
  const range = parseRange(req.headers.range, size);
  const headers = { ...headersFor(viewable, self), 'Content-Type': viewable.type, 'Accept-Ranges': 'bytes' };
  if (range === UNSATISFIABLE) {
    fs.closeSync(fd);
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': size ? end - start + 1 : 0, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD' || !size) {
    fs.closeSync(fd);
    return res.end();
  }
  const stream = fs.createReadStream(null, { fd, start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
};

const isWithin = (real, scope) => {
  let scopeReal;
  try {
    scopeReal = fs.realpathSync.native(scope);
  } catch {
    return false;
  }
  return real === scopeReal || real.startsWith(`${scopeReal}/`);
};

// self is the origin the browser sees (http://127.0.0.1:<port> or https://<tailnet name>).
const handleView = (req, res, { url, policy, signer, self }) => {
  const link = signer.verify(url.pathname);
  if (link.refusal) return sendRefusal(res, link.refusal);
  const viewable = resolveViewable(link.file, policy);
  if (viewable.refusal) return sendRefusal(res, viewable.refusal);
  if (!isWithin(viewable.real, link.scope)) return sendRefusal(res, [403, 'This link does not cover that file.']);
  if (viewable.kind === 'video' && url.searchParams.has('play')) return sendPage(req, res, viewable, self, playerPage(viewable));
  if (viewable.kind === 'text') return sendPage(req, res, viewable, self, textPage(viewable));
  return sendFile(req, res, viewable, self);
};

module.exports = { VIEW_PREFIX, createSigner, viewHref, parseRange, handleView };
