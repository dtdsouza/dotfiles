'use strict';

// The served page's navigation: a collapsible rail on desktop (Agents, Files, My loops) and a
// bottom tab bar on the phone (Agents, Loops, Files). The file:// copy keeps the plain topbar.
const RAIL_KEY = 'agents.railOpen';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const svg = (paths) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  agents: svg('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'),
  files: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  loops: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  mr: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.5L10.5 6 13 8.5"/>'),
  bug: svg('<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>'),
  loop: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  collapse: svg('<path d="M15 6l-6 6 6 6"/>'),
};
const iconOf = (name) => ICONS[name] || ICONS.loop;

const railHtml = ({ loops = [], files = false, needsYou = 0 }) => {
  const loopLinks = loops
    .map((l) => `<a class="ri" href="#loop/${esc(l.id)}" data-loop-link="${esc(l.id)}" title="${esc(l.name)}">${iconOf(l.icon)}<i class="ldot" data-dot="unknown"></i><span class="rl"><span>${esc(l.name)}</span><small class="rsub" data-loop-sub="${esc(l.id)}"></small></span></a>`)
    .join('');
  return `<nav class="rail" aria-label="Main">`
    + `<a class="ri" href="#" data-nav="agents" title="Agents">${ICONS.agents}<span class="rl"><span>Agents</span></span>${needsYou ? `<b class="rc">${needsYou}</b>` : ''}</a>`
    + (files ? `<a class="ri" href="/files" title="Files">${ICONS.files}<span class="rl"><span>Files</span></span></a>` : '')
    + (loops.length ? `<div class="rsec"><span>My loops</span></div>${loopLinks}<div class="rfoot" data-loops-total></div>` : '')
    + `<button class="ri rtoggle" type="button" data-rail-toggle title="Expand or collapse">${ICONS.collapse}<span class="rl"><span>Collapse</span></span></button></nav>`;
};

const tabBarHtml = ({ loops = [], files = false }) =>
  `<nav class="tabbar" aria-label="Main"><a href="#" data-nav="agents">${ICONS.agents}<span>Agents</span></a>`
  + (loops.length ? `<a href="#loops" data-nav="loops">${ICONS.loops}<span>Loops</span><i class="tdot" hidden></i></a>` : '')
  + (files ? `<a href="/files">${ICONS.files}<span>Files</span></a>` : '')
  + '</nav>';

const shellCss = `
.shell{display:flex;min-height:100vh}.main{flex:1;min-width:0}
.rail{position:sticky;top:0;height:100vh;width:54px;flex:none;display:flex;flex-direction:column;gap:4px;padding:14px 7px;border-right:1px solid var(--line);background:linear-gradient(var(--surface),var(--bg));overflow-y:auto;overflow-x:hidden;transition:width .2s}
body.rail-open .rail{width:214px}
.ri{position:relative;display:flex;align-items:center;gap:12px;min-height:40px;padding:0 10px;border-radius:12px;color:var(--text);text-decoration:none;border:1px solid transparent;background:none;font:500 13px var(--body);cursor:pointer;text-align:left;width:100%}
.ri svg{flex:none}.ri:hover{color:var(--fg);background:var(--soft)}.ri.on{color:var(--fg);border-color:var(--green-30);background:var(--green-12)}
.rl{display:none;flex-direction:column;min-width:0;line-height:1.25}.rl>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.rail-open .rl{display:flex}
.rsub{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rsec{margin:14px 4px 4px;height:14px;border-top:1px solid var(--line)}.rsec span{display:none;font:600 10px var(--body);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
body.rail-open .rsec{border-top:0}body.rail-open .rsec span{display:block}
.rfoot{display:none;font-size:11px;color:var(--muted);padding:6px 10px}body.rail-open .rfoot{display:block}
.rtoggle{margin-top:auto}body:not(.rail-open) .rtoggle svg{transform:rotate(180deg)}
.rc{position:absolute;top:4px;left:26px;min-width:16px;height:16px;border-radius:8px;background:var(--blue-glow);color:#fff;font:600 10px/16px var(--body);text-align:center;padding:0 4px}
.ldot{position:absolute;left:28px;top:9px;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--bg);background:var(--muted)}
.ldot[data-dot="running"]{background:var(--green-ink)}.ldot[data-dot="needs"]{background:var(--blue-glow)}.ldot[data-dot="error"]{background:var(--red)}.ldot[data-dot="paused"]{background:var(--amber)}.ldot[data-dot="off"]{background:var(--muted)}
.tabbar{display:none}
@media (max-width:640px){.rail{display:none}
.tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:5;border-top:1px solid var(--line);background:var(--surface);padding:4px 8px calc(4px + env(safe-area-inset-bottom))}
.tabbar a{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-height:52px;justify-content:center;color:var(--muted);text-decoration:none;font:600 11px var(--body)}
.tabbar a.on{color:var(--green-ink)}.tdot{position:absolute;top:8px;left:calc(50% + 6px);width:8px;height:8px;border-radius:50%;background:var(--blue-glow)}
body.served{padding-bottom:72px}.toast{bottom:84px}}
`;

// Routing is by hash: '' the board, #loops the loop list, #loop/<id> one loop. Drawer hashes
// (task ids, #review/..., #draft/...) leave the board showing underneath.
const shellScript = `
const RAIL_KEY = ${JSON.stringify(RAIL_KEY)};
const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (_) { return false; } };
document.body.classList.toggle('rail-open', readRail());
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-rail-toggle]')) return;
  const open = !document.body.classList.contains('rail-open');
  document.body.classList.toggle('rail-open', open);
  try { localStorage.setItem(RAIL_KEY, open ? '1' : '0'); } catch (_) {}
});
const viewOfHash = () => { const h = decodeURIComponent(location.hash.slice(1)); if (h === 'loops') return { view: 'loops' }; if (h.startsWith('loop/')) return { view: 'loop', id: h.slice(5) }; return { view: 'board' }; };
function markNav(route) {
  document.querySelectorAll('.rail .ri[data-nav], .rail .ri[data-loop-link]').forEach((a) => a.classList.toggle('on', route.view === 'board' ? a.dataset.nav === 'agents' : a.dataset.loopLink === route.id));
  document.querySelectorAll('.tabbar a[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === (route.view === 'board' ? 'agents' : 'loops')));
}
function applyRoute() {
  const route = viewOfHash();
  const board = document.querySelector('.boardarea');
  const view = document.querySelector('.loopview');
  if (board && view) { board.hidden = route.view !== 'board'; view.hidden = route.view === 'board'; }
  markNav(route);
  if (window.renderLoopRoute) window.renderLoopRoute(route);
  if (route.view !== 'board') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', applyRoute);
applyRoute();
`;

module.exports = { ICONS, iconOf, railHtml, tabBarHtml, shellCss, shellScript };
