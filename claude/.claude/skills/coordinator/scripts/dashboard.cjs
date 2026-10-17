#!/usr/bin/env node
// Usage: dashboard.cjs <state-dir> [out-file]   (out-file defaults to <state-dir>/status.html)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { faviconLink } = require('./favicon.cjs');

const STATE_DIR = process.argv[2];
if (!STATE_DIR) {
  console.error('usage: dashboard.cjs <state-dir> [out-file]');
  process.exit(1);
}
const OUT = process.argv[3] || path.join(STATE_DIR, 'status.html');
const TASKS_DIR = path.join(STATE_DIR, 'tasks');
const PAGE_RELOAD_SECONDS = 300;
const STALE_ON_FOCUS_SECONDS = 60;
// tmux replaces control characters such as \x1f with '_' in -F output, hence the printable '|' separator (name last).
const ARCHIVE_WINDOW_DAYS = 30;
const SNAPSHOT_LINES = 30;
const SNAPSHOT_LINE_WIDTH = 160;
const SUFFIX_STATUS = { review: 'review', blocked: 'blocked', done: 'done' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tmux = (args) => {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readTasks = () => {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR).flatMap((id) => {
    const dir = path.join(TASKS_DIR, id);
    try {
      const meta = JSON.parse(readText(path.join(dir, 'meta.json')));
      return [{ meta, phase: readText(path.join(dir, 'phase')).trim(), notes: parseNotes(readText(path.join(dir, 'notes.md'))) }];
    } catch {
      return [];
    }
  });
};

const parseNotes = (text) =>
  text.split('\n').reduce((notes, line) => {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.*)$/);
    if (m) return [...notes, [m[1].slice(5), m[2]]];
    if (!line.trim() || !notes.length) return notes;
    const [last, ...rest] = [...notes].reverse();
    return [...rest.reverse(), [last[0], `${last[1]}\n${line}`]];
  }, []);

const readWindows = () =>
  new Map(
    tmux(['list-windows', '-a', '-F', '#{window_id}|#{session_name}|#{pane_id}|#{window_activity}|#{window_name}'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('|'))
      .map(([id, session, pane, activity, ...name]) => [id, { session, pane, name: name.join('|'), activity: Number(activity) }]),
  );

const captureSnapshot = (pane) =>
  tmux(['capture-pane', '-p', '-t', pane])
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').slice(0, SNAPSHOT_LINE_WIDTH))
    .filter((l) => l && !/^[─━\s]+$/.test(l))
    .slice(-SNAPSHOT_LINES);

const ago = (epochSeconds) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const buildItem = ({ meta, phase, notes }, win) => {
  const suffix = win && win.name.match(/-(review|blocked|done)$/);
  const tabClosed = !win;
  const status = tabClosed ? 'done' : suffix ? SUFFIX_STATUS[suffix[1]] : 'working';
  const snapshot = win ? captureSnapshot(win.pane) : [];
  const ctx = snapshot.map((l) => l.match(/ctx:(\d+)%/)).filter(Boolean).pop();
  const lastNote = notes.length ? notes[notes.length - 1][1] : '';
  const flags = [
    meta.archivedAt && win ? 'archived in the ledger, tab still open' : '',
    tabClosed && !meta.archivedAt ? 'tab closed but the task is not archived in the ledger' : '',
    ['exited', 'setup-failed'].includes(phase) ? `phase: ${phase}` : '',
  ].filter(Boolean);
  return {
    id: meta.id,
    tab: win ? win.name : meta.name,
    status,
    win: win ? meta.windowId : '-',
    pane: win ? win.pane : '-',
    session: win ? win.session : meta.session,
    model: meta.model,
    effort: meta.effort || '-',
    ctx: ctx ? ctx[1] : '',
    where: (meta.workdir || '').replace(process.env.HOME || '\0', '~'),
    since: (meta.createdAt || '').slice(0, 16).replace('T', ' '),
    phase,
    activity: win ? ago(win.activity) : '',
    updated: win ? win.activity : Math.floor(Date.parse(meta.archivedAt || meta.createdAt) / 1000) || 0,
    closedAgo: !win && meta.archivedAt ? ago(Math.floor(Date.parse(meta.archivedAt) / 1000)) : '',
    summary: lastNote,
    notes,
    snapshot,
    flags,
  };
};

const isRecent = (iso) => Date.now() - Date.parse(iso) < ARCHIVE_WINDOW_DAYS * 86400 * 1000;

const collectItems = () => {
  const windows = readWindows();
  return readTasks()
    .filter((t) => t.meta.id && (!t.meta.archivedAt || windows.has(t.meta.windowId) || isRecent(t.meta.archivedAt)))
    .map((t) => buildItem(t, windows.get(t.meta.windowId)))
    .sort((a, b) => b.updated - a.updated);
};

const css = `:root{--bg:#000516;--surface:#0c1121;--white-70:rgba(255,255,255,.7);--white-50:rgba(255,255,255,.5);--white-10:rgba(255,255,255,.1);--white-05:rgba(255,255,255,.05);
--green:#baf764;--green-30:rgba(186,247,100,.3);--blue-glow:#4a74ff;--amber:#ffc65c;--red:#ff6b6b;
--display:"Clash Display",Arial,sans-serif;--body:Inter,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--white-70);font:400 14px/1.5 var(--body);-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
h1,h2{font-family:var(--display);font-weight:600;color:#fff;line-height:1.05}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:12px;border:1px solid var(--white-10);color:var(--white-70);white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:6px;border:1.5px solid var(--green-30);border-radius:999px;padding:6px 14px;color:#fff;font:500 12px var(--body);background:transparent;cursor:pointer;white-space:nowrap}
.btn{text-decoration:none}
.btn.on,.chip.on{border-color:var(--green);background:rgba(186,247,100,.12)}
.topbar .right{display:flex;align-items:center;gap:16px}
.filters{display:flex;gap:6px;flex-wrap:wrap;padding:0 6px 14px}
.chip{border:1px solid var(--white-10);border-radius:999px;padding:3px 11px;font:500 12px var(--body);color:var(--white-70);background:transparent;cursor:pointer}
.chip:hover{border-color:rgba(255,255,255,.3)}
.custom{display:flex;gap:6px;align-items:center;width:100%;margin-top:4px;font-size:12px}
.custom input{color-scheme:dark;background:var(--surface);border:1px solid var(--white-10);border-radius:999px;color:#fff;padding:3px 10px;font:12px var(--body)}
.empty{font-size:12px;color:var(--white-50);padding:6px}
[hidden]{display:none!important}
.btn:hover{border-color:var(--green);box-shadow:0 0 18px rgba(186,247,100,.2)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.s-working{background:var(--green);box-shadow:0 0 10px rgba(186,247,100,.6)}
.s-review{background:var(--blue-glow);box-shadow:0 0 10px rgba(74,116,255,.7)}
.s-blocked{background:var(--red);box-shadow:0 0 10px rgba(255,107,107,.6)}
.s-done{background:var(--white-50)}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:22px 40px;border-bottom:1px solid var(--white-10)}
.brand{display:flex;align-items:center;gap:12px}.brand h1{font-size:24px}
.meta{font-size:12px;color:var(--white-50)}
.board{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:28px 40px}
.col{background:linear-gradient(rgba(255,255,255,.03),rgba(255,255,255,0) 40%);border:1px solid var(--white-10);border-radius:32px;padding:18px;min-height:480px}
.colhead{display:flex;align-items:center;gap:10px;padding:4px 6px 16px}.colhead h2{font-size:20px}
.count{margin-left:auto;font:500 12px var(--body);color:var(--white-50)}
.card{border:1.5px solid var(--white-10);border-radius:24px;padding:16px;margin-bottom:14px;background:linear-gradient(230deg,rgba(255,255,255,0) 60%,rgba(255,255,255,.05));cursor:pointer;transition:border-color .2s,transform .2s}
.card:hover{border-color:rgba(255,255,255,.25);transform:translateY(-1px)}
.card.hot{border-color:rgba(255,107,107,.45)}.card.ask{border-color:rgba(74,116,255,.5)}
.card.sel{border-color:var(--green);box-shadow:0 0 24px rgba(186,247,100,.18)}
.card h4{font:600 14px var(--body);color:#fff;margin-bottom:8px;word-break:break-word}
.row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.line{font-size:13px;margin-bottom:12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.q{font-size:13px;color:#fff;background:var(--white-05);border-left:2px solid var(--blue-glow);border-radius:8px;padding:8px 10px;margin-bottom:12px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.warn{font-size:12px;color:var(--amber);margin-bottom:10px}
.foot{display:flex;justify-content:space-between;align-items:center}
.age{font-size:12px;color:var(--white-50)}
.scrim{position:fixed;inset:0;background:rgba(0,5,22,.55);opacity:0;pointer-events:none;transition:opacity .25s}
.drawer{position:fixed;top:0;right:0;bottom:0;width:540px;max-width:100vw;border-left:1px solid var(--white-10);background:linear-gradient(var(--surface),var(--bg) 45%);padding:24px 28px;overflow-y:auto;overflow-x:hidden;transform:translateX(100%);transition:transform .25s ease}
body.open .scrim{opacity:1;pointer-events:auto}body.open .drawer{transform:none}
.dhead{display:flex;align-items:center;justify-content:space-between}
.x{background:none;border:1px solid var(--white-10);border-radius:999px;color:var(--white-70);width:30px;height:30px;cursor:pointer;font-size:14px}
.drawer h2{font-size:22px;margin:12px 0 6px;word-break:break-word}
.askbox{font-size:13px;color:#fff;background:var(--white-05);border-left:2px solid var(--blue-glow);border-radius:8px;padding:10px 12px;margin-top:10px;white-space:pre-wrap;word-break:break-word}
.askbox.blocked{border-left-color:var(--red)}.askbox.flag{border-left-color:var(--amber);color:var(--amber)}
.kv{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:12px;margin:14px 0 6px}
.kv span:nth-child(odd){color:var(--white-50)}.kv span:nth-child(even){color:#fff;word-break:break-word}
h5{font:600 12px var(--body);color:var(--white-50);text-transform:uppercase;letter-spacing:.08em;margin:20px 0 10px}
.tl{border-left:1px solid var(--white-10);margin-left:4px}
.tl div{position:relative;padding:0 0 12px 16px;font-size:13px;white-space:pre-wrap;word-break:break-word}
.tl div::before{content:"";position:absolute;left:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--blue-glow)}
.tl b{color:#fff;font-weight:500;margin-right:6px}
pre{background:var(--surface);border:1px solid var(--white-10);border-radius:16px;padding:14px;font:12px/1.55 var(--mono);color:#e6e9f2;white-space:pre-wrap;word-break:break-word;margin:0}
.ghost{color:var(--white-50)}
.hint{font-size:11px;color:var(--white-50);margin-top:6px}
.cmd{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:16px}
.cmd code{flex:1 1 100%;min-width:0;background:var(--surface);border:1px solid var(--white-10);border-radius:16px;padding:8px 14px;color:#fff;font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-all}`;

const cardHtml = (a) => {
  const cls = a.status === 'blocked' ? 'hot' : a.status === 'review' ? 'ask' : '';
  const body = a.summary ? `<div class="${a.status === 'working' || a.status === 'done' ? 'line' : 'q'}">${esc(a.summary)}</div>` : '';
  const meta = a.status === 'done' && a.win === '-' ? '' : `<div class="row"><span class="pill">${esc(a.win)}</span><span class="pill">${esc(a.model)}/${esc(a.effort)}</span>${a.ctx ? `<span class="pill">ctx ${esc(a.ctx)}% left</span>` : ''}</div>`;
  const age = a.activity ? (a.activity === 'now' ? 'active now' : `active ${a.activity} ago`) : a.closedAgo ? `done ${a.closedAgo === 'now' ? 'just now' : a.closedAgo + ' ago'}` : 'tab closed';
  return `<div class="card ${cls}" data-id="${esc(a.id)}" data-updated="${a.updated}"><h4>${esc(a.tab)}</h4>${meta}${body}${a.flags.map((f) => `<div class="warn">⚠ ${esc(f)}</div>`).join('')}<div class="foot"><span class="age">${age}</span><span class="btn">Details →</span></div></div>`;
};

const FILTERS_HTML = `<div class="filters"><button class="chip" data-range="today">Today</button><button class="chip" data-range="7">7 days</button><button class="chip" data-range="30">30 days</button><button class="chip" data-range="all">All</button><button class="chip" data-range="custom">Custom</button>
<div class="custom" hidden><input type="date" data-from> <span>to</span> <input type="date" data-to></div></div><div class="empty" hidden>No sessions in this range.</div>`;

const columnHtml = (items, [title, dotClass, status]) => {
  const list = items.filter((a) => a.status === status);
  const filters = status === 'done' ? FILTERS_HTML : '';
  return `<div class="col" data-status="${status}"><div class="colhead"><span class="dot ${dotClass}"></span><h2>${title}</h2><span class="count" data-total="${list.length}">${list.length}</span></div>${filters}${list.map(cardHtml).join('')}</div>`;
};

const COLUMNS = [
  ['Needs you', 's-review', 'review'],
  ['Blocked', 's-blocked', 'blocked'],
  ['Working', 's-working', 'working'],
  ['Done', 's-done', 'done'],
];

const clientScript = (items, generatedAt) => `
const ITEMS = ${JSON.stringify(Object.fromEntries(items.map((a) => [a.id, a]))).replace(/</g, '\\u003c')};
const GENERATED_AT = ${JSON.stringify(generatedAt)};
const GENERATED_MS = ${Date.now()};
const STALE_MS = ${STALE_ON_FOCUS_SECONDS * 1000};
const LABEL = { working: 'working', review: 'needs you', blocked: 'blocked', done: 'done' };
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const snapshotLine = (l) => l.trimStart().startsWith('❯') ? '<span class="ghost">' + esc(l) + '  ← prompt line: may be a ghost suggestion</span>' : esc(l);
const drawer = document.querySelector('.drawer');
function openDrawer(id) {
  const a = ITEMS[id]; if (!a) return;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  const live = a.win !== '-';
  const jump = live ? 'tmux select-window -t ' + a.session + ':' + a.win : 'cd ' + a.where + ' && claude --resume ' + a.id;
  const jumpHref = live ? 'tmuxjump://' + encodeURIComponent(a.session) + '/' + a.win : 'tmuxjump://resume/' + encodeURIComponent(a.id);
  const ask = (a.status === 'review' || a.status === 'blocked') && a.summary ? '<div class="askbox ' + a.status + '">' + esc(a.summary) + '</div>' : '';
  drawer.innerHTML = \`
    <div class="dhead"><span class="pill"><span class="dot s-\${a.status}"></span>\${LABEL[a.status]}\${a.win !== '-' ? ' \\u00b7 ' + esc(a.win) + ' \\u00b7 ' + esc(a.pane) : ''}</span><button class="x" title="Close (Esc)">\\u2715</button></div>
    <h2>\${esc(a.tab)}</h2>\${ask}
    \${a.flags.map((f) => '<div class="askbox flag">\\u26a0 ' + esc(f) + '</div>').join('')}
    <div class="kv"><span>Task id</span><span>\${esc(a.id)}</span><span>Workdir</span><span>\${esc(a.where)}</span>
      <span>Model</span><span>\${esc(a.model)}/\${esc(a.effort)}\${a.ctx ? ' \\u00b7 ctx ' + esc(a.ctx) + '% left' : ''}</span>
      <span>Phase</span><span>\${esc(a.phase || '-')}</span><span>Since</span><span>\${esc(a.since)}</span>
      <span>Last active</span><span>\${a.activity ? esc(a.activity) + ' ago' : a.closedAgo ? 'archived ' + esc(a.closedAgo) + ' ago, tab closed' : 'tab closed'}</span></div>
    <h5>Ledger notes</h5><div class="tl">\${a.notes.length ? a.notes.slice().reverse().map(([t, n]) => '<div><b>' + esc(t) + '</b>' + esc(n) + '</div>').join('') : '<div>no notes yet</div>'}</div>
    \${a.snapshot.length ? '<h5>Pane snapshot \\u00b7 ' + esc(GENERATED_AT) + '</h5><pre>' + a.snapshot.map(snapshotLine).join('\\n') + '</pre><div class="hint">Last lines of tmux capture-pane. A \\u276f line may be Claude\\'s grey suggestion, not text the worker typed.</div>' : ''}
    \${jump ? '<div class="cmd"><code>' + esc(jump) + '</code><button class="btn" data-copy="' + esc(jump) + '">Copy</button><a class="btn" href="' + esc(jumpHref) + '">' + (live ? 'Open in terminal' : 'Resume in terminal') + '</a></div>' : ''}\`;
  document.body.classList.add('open');
  history.replaceState(null, '', '#' + encodeURIComponent(id));
}
function closeDrawer() {
  document.body.classList.remove('open');
  document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
  history.replaceState(null, '', location.pathname);
}
const FILTER_KEY = 'agents.doneFilter';
const readFilter = () => { try { return JSON.parse(localStorage.getItem(FILTER_KEY)) || { range: 'today' }; } catch (_) { return { range: 'today' }; } };
const writeFilter = (f) => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch (_) {} };
let filter = readFilter();
const daysAgoStart = (n) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime(); };
const filterBounds = (f) => {
  if (f.range === 'today') return [daysAgoStart(0), Infinity];
  if (f.range === '7') return [daysAgoStart(6), Infinity];
  if (f.range === '30') return [daysAgoStart(29), Infinity];
  if (f.range === 'custom') return [f.from ? new Date(f.from + 'T00:00:00').getTime() : -Infinity, f.to ? new Date(f.to + 'T23:59:59.999').getTime() : Infinity];
  return [-Infinity, Infinity];
};
function applyFilter() {
  const col = document.querySelector('[data-status="done"]');
  const [lo, hi] = filterBounds(filter);
  const cards = [...col.querySelectorAll('.card')];
  cards.forEach((c) => { const t = Number(c.dataset.updated) * 1000; c.hidden = !(t >= lo && t <= hi); });
  const shown = cards.filter((c) => !c.hidden).length;
  col.querySelector('.count').textContent = shown === cards.length ? String(cards.length) : shown + ' of ' + cards.length;
  col.querySelector('.empty').hidden = shown > 0;
  col.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', b.dataset.range === filter.range));
  const custom = col.querySelector('.custom');
  custom.hidden = filter.range !== 'custom';
  custom.querySelector('[data-from]').value = filter.from || '';
  custom.querySelector('[data-to]').value = filter.to || '';
}
function setFilter(next) { filter = next; writeFilter(filter); applyFilter(); }
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-from], [data-to]')) {
    const custom = e.target.closest('.custom');
    setFilter({ range: 'custom', from: custom.querySelector('[data-from]').value, to: custom.querySelector('[data-to]').value });
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - GENERATED_MS > STALE_MS) location.reload(); });
document.addEventListener('click', (e) => {
  const refresh = e.target.closest('#refresh');
  if (refresh) { refresh.textContent = 'Refreshing…'; setTimeout(() => location.reload(), 1500); return; }
  const chip = e.target.closest('[data-range]');
  if (chip) return setFilter({ ...filter, range: chip.dataset.range });
  const copy = e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); }); return; }
  if (e.target.closest('.x') || e.target.classList.contains('scrim')) return closeDrawer();
  const card = e.target.closest('.card');
  if (card) openDrawer(card.dataset.id);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
applyFilter();
if (location.hash) openDrawer(decodeURIComponent(location.hash.slice(1)));
`;

const render = (items) => {
  const generatedAt = new Date().toLocaleTimeString('en-GB', { hour12: false });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${PAGE_RELOAD_SECONDS}">
<title>Agents</title>
${faviconLink(items)}
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@600&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<div class="topbar"><div class="brand"><h1>Agents</h1><span class="pill">coordinator ledger + tmux</span></div><div class="right"><div class="meta">snapshot ${generatedAt} · reloads every ${PAGE_RELOAD_SECONDS / 60} min · click a card for details</div><a class="btn" id="refresh" href="tmuxjump://refresh">↻ Refresh</a></div></div>
<div class="board">${COLUMNS.map((c) => columnHtml(items, c)).join('')}</div>
<div class="scrim"></div><aside class="drawer"></aside>
<script>${clientScript(items, generatedAt)}</script></body></html>`;
};

const tmpFile = `${OUT}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
try {
  fs.writeFileSync(tmpFile, render(collectItems()));
  fs.renameSync(tmpFile, OUT);
} catch (err) {
  fs.rmSync(tmpFile, { force: true });
  throw err;
}
