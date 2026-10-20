// Pixel-art agents for the dashboard cards: string grids composed into frames, drawn as one SVG strip
// and stepped with CSS. A hash of the task id picks each agent's shirt, hair and skin.
const GRID_WIDTH = 32;
const GRID_HEIGHT = 24;
const SCALE = 2;

const PALETTE = {
  k: 'ink', s: 'skin', b: 'blush', h: 'hair', t: 'shirt', j: 'pants', w: 'white', q: 'paper', m: 'case', M: 'case2', g: 'screen', O: 'off',
  1: 'code1', 2: 'code2', 3: 'code3', 4: 'code4', c: 'cursor', d: 'desk', D: 'desk2', f: 'coffee', v: 'steam', r: 'red', y: 'amber', z: 'zzz', C: 'chair',
};
// Seeded colours leave out red, amber and lime so no agent reads as a blocked, flagged or working badge.
const SHIRTS = ['#4a74ff', '#a98bff', '#ff8fc8', '#4fc3e8', '#c062d6', '#e8eaf2', '#c9a27a', '#8b93a8'];
const HAIRS = ['#5a3b28', '#8a5a3c', '#4a4e66', '#e6cf98', '#b9bfcc', '#7d4fb0', '#3f6fb5'];
const SKINS = ['#f6d2b1', '#ecbf98', '#c68a5e', '#8d5a3b'];

const layer = (x, y, rows) => ({ x, y, rows });
const blank = () => Array(GRID_HEIGHT).fill('.'.repeat(GRID_WIDTH));
// In a layer '.' keeps what is underneath and '_' clears it.
const put = (grid, { x, y, rows }) =>
  grid.map((row, gy) => {
    const r = rows[gy - y];
    if (r === undefined) return row;
    return Array.from(row, (c, gx) => {
      const p = r[gx - x];
      if (p === undefined || p === '.') return c;
      return p === '_' ? '.' : p;
    }).join('');
  });
const frame = (...layers) => layers.flat(Infinity).filter(Boolean).reduce(put, blank());
const dots = (ch, points) => points.map(([x, y]) => layer(x, y, [ch]));
const segment = ([x0, y0], [x1, y1]) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
  return Array.from({ length: n + 1 }, (_, i) => [Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n)]);
};
const line = (ch, points) => dots(ch, points.slice(1).flatMap((p, i) => segment(points[i], p)));
const spaced = (lines) => Array.from({ length: 8 }, (_, i) => (i % 2 === 0 && lines[i / 2] ? lines[i / 2] : '.'.repeat(12)));

const HEAD_BACK = ['..kkkkkk..', '.khhhhhhk.', 'khhhhhhhhk', 'khhhhhhhhk', 'khhhhhhhhk', 'kshhhhhhsk', '.khhhhhhk.', '..kssssk..'];
const HEAD_FRONT = ['..kkkkkk..', '.khhhhhhk.', 'khhhhhhhhk', 'khhhhhhhhk', 'khsssssshk', 'kssskssksk', 'ksbssssbsk', '.ksskkssk.', '..kkkkkk..'];
const FRONT_BODY = ['.kttttttk.', 'kttttttttk', 'kttttttttk', 'kskjjjjksk', '.kjjkkjjk.', '.kkk..kkk.'];
const TORSO_BACK = ['..kttttttk..', '.kttttttttk.', 'kttttttttttk', 'kttttttttttk', 'kttttttttttk'];
const CHAIR_BACK = ['kkkkkkkkkk', 'kCCCCCCCCk', 'kCCCCCCCCk', '.kkkkkkkk.', '....kk....'];
const ARMS_ON_DESK = ['.kkkkkkkkkkkk.', 'kttttttttttttk', 'kttttttttttttk', '.kkkkkkkkkkkk.'];
const DESK = layer(0, 15, ['d'.repeat(GRID_WIDTH), 'D'.repeat(GRID_WIDTH)]);
const MUG = layer(27, 11, ['kffk.', 'kwwkk', 'kwwkk', 'kkkk.']);
const STEAM = [['.v..', '..v.', '.v..', '....'], ['..v.', '.v..', '..v.', '.v..'], ['....', '..v.', '.v..', '..v.']].map((rows) => layer(27, 7, rows));
const monitor = ({ led = '1', screen = 'g' } = {}) =>
  layer(11, 1, [
    '.' + 'k'.repeat(14) + '.',
    'k' + 'm'.repeat(13) + 'Mk',
    ...Array(8).fill('km' + screen.repeat(12) + 'Mk'),
    'k' + 'm'.repeat(11) + led + 'mMk',
    'k' + 'M'.repeat(14) + 'k',
    '.' + 'k'.repeat(14) + '.',
    '.....kMMMMk.....',
  ]);
const screen = (rows) => layer(13, 3, rows);
const agentAtDesk = ({ dy = 0, elbows = null, under = [], over = [] } = {}) => [
  layer(1, 15, TORSO_BACK),
  under,
  elbows && [layer(0, elbows === 'left' ? 17 : 18, ['kt', 'kt']), layer(12, elbows === 'left' ? 18 : 17, ['tk', 'tk'])],
  layer(2, 7 + dy, HEAD_BACK),
  over,
  layer(2, 19, CHAIR_BACK),
];

const CODE = ['222.11111...', '..111.33....', '..44444444..', '..2.1111....', '333.111111..'];
const typing = (start, typed, cursor = true) => {
  const current = CODE[start + 3].slice(0, typed).padEnd(12, '.');
  return spaced([...CODE.slice(start, start + 3), cursor ? current.slice(0, typed) + 'c' + current.slice(typed + 1) : current]);
};
const working = () =>
  [[0, 3, 1, 'left', 0], [0, 6, 1, 'right', 1], [0, 8, 1, 'left', 2], [0, 8, 0, 'left', 0], [1, 3, 1, 'right', 1], [1, 7, 1, 'left', 2]].map(([start, typed, cursor, elbows, steam]) =>
    frame(DESK, monitor(), screen(typing(start, typed, cursor)), MUG, STEAM[steam], agentAtDesk({ elbows })));

const HOURGLASS = [
  ['kkkkk', 'kyyyk', '.kyk.', '..k..', '.kqk.', 'kqqqk', 'kkkkk'],
  ['kkkkk', 'kqyqk', '.kyk.', '..y..', '.kqk.', 'kqyqk', 'kkkkk'],
  ['kkkkk', 'kqqqk', '.kqk.', '..y..', '.kyk.', 'kyyyk', 'kkkkk'],
];
const FOOT_UP = layer(10, 22, ['......kkk.', '......___.']);
const review = () =>
  [[0, 0], [1, 1], [1, 0], [2, 1], [2, 0], [2, 1]].map(([sand, footUp]) =>
    frame(layer(10, 18, FRONT_BODY), layer(10, 9, HEAD_FRONT), footUp && FOOT_UP, layer(23, 8, HOURGLASS[sand])));

const ERROR_CODE = spaced(['r.rrrr......', '..44444.....', '..rrr.rrrr..', '..444.......']);
const BUG = [['.y.y.', 'yyyyk', 'y.y.y'], ['y.y.y', 'yyyyk', '.y.y.']];
const SMOKE = [['..v.', '.vv.', '..vv', '...v'], ['.vv.', '..vv', '.v..', '..v.']].map((rows) => layer(25, 0, rows));
const scratchingHead = (shift) => [line('t', [[12, 16], [13, 13], [12, 10]]), dots('s', [[10 - shift, 8], [11 - shift, 8], [10 - shift, 9], [11 - shift, 9]])];
const blocked = () =>
  [0, 2, 4, 6].map((bugX, i) =>
    frame(DESK, monitor(), screen(ERROR_CODE), layer(13 + bugX, 6, BUG[i % 2]), MUG, SMOKE[i % 2], agentAtDesk({ over: scratchingHead(i % 2) })));

const CHECK = ['............', '.........11.', '........11..', '.11....11...', '..11..11....', '...1111.....', '....11......', '............'];
const TWINKLE = dots('w', [[23, 3], [22, 4], [24, 4], [23, 5]]);
const HANDS_BEHIND_HEAD = [
  line('t', [[5, 11], [1, 9], [0, 11], [1, 15]]),
  line('t', [[8, 11], [12, 9], [13, 11], [12, 15]]),
  line('t', [[2, 10], [1, 12], [2, 15]]),
  line('t', [[11, 10], [12, 12], [11, 15]]),
];
const doneOpen = () =>
  [[0, 0], [1, 1], [2, 0], [0, 1]].map(([steam, twinkle]) =>
    frame(DESK, monitor(), screen(CHECK), twinkle && TWINKLE, MUG, STEAM[steam], agentAtDesk({ dy: 1, under: HANDS_BEHIND_HEAD })));

const Z_SMALL = ['zzz', '.z.', 'zzz'];
const Z_BIG = ['zzzz', '..z.', '.z..', 'zzzz'];
const Z_PATH = [[6, 6, Z_SMALL], [4, 3, Z_SMALL], [1, 0, Z_BIG], null];
const REFLECTION = dots('v', [[14, 5], [15, 4], [16, 3]]);
const doneClosed = () =>
  [0, 1, 2, 3].map((f) =>
    frame(
      DESK, monitor({ led: 'y', screen: 'O' }), REFLECTION, MUG,
      layer(1, 15, TORSO_BACK), layer(0, 14, ARMS_ON_DESK), layer(2, 10 + (f > 1 ? 1 : 0), HEAD_BACK), layer(2, 19, CHAIR_BACK),
      [Z_PATH[f], Z_PATH[(f + 2) % 4]].filter(Boolean).map(([x, y, rows]) => layer(x, y, rows)),
    ));

const SPRITES = {
  working: { name: 'Typing at the screen', build: working, frameMs: 320 },
  review: { name: 'Waiting with an hourglass', build: review, frameMs: 380 },
  blocked: { name: 'A bug on the screen', build: blocked, frameMs: 340 },
  'done-open': { name: 'Leaning back', build: doneOpen, frameMs: 520 },
  'done-closed': { name: 'Asleep at the desk', build: doneClosed, frameMs: 650 },
};

const framesCache = new Map();
const spriteFrames = (kind) => {
  if (!framesCache.has(kind)) framesCache.set(kind, SPRITES[kind].build());
  return framesCache.get(kind);
};

const svgPaths = (frames) => {
  const paths = {};
  frames.forEach((grid, f) =>
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {
        const c = row[x];
        let run = 1;
        while (row[x + run] === c) run++;
        if (c !== '.') (paths[c] ||= []).push(`M${f * GRID_WIDTH + x} ${y}h${run}v1h-${run}z`);
        x += run;
      }
    }),
  );
  return Object.entries(paths).map(([c, d]) => `<path class="px-${PALETTE[c]}" d="${d.join('')}"/>`).join('');
};
const stripViewBox = (kind) => `0 0 ${GRID_WIDTH * spriteFrames(kind).length} ${GRID_HEIGHT}`;
// One hidden symbol per kind keeps the page small: every card only references it with <use>.
const spriteDefsHtml = (kinds) => {
  const unique = [...new Set(kinds)].filter((kind) => SPRITES[kind]);
  if (!unique.length) return '';
  const symbols = unique.map((kind) => `<symbol id="spr-${kind}" viewBox="${stripViewBox(kind)}">${svgPaths(spriteFrames(kind))}</symbol>`).join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>`;
};

const fnv1a = (text) => [...String(text)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
// FNV alone clusters on ids that share a prefix (twism-2xxxx-...), so its bits are mixed before indexing.
const mixBits = (h) => {
  const a = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  const b = Math.imul(a ^ (a >>> 15), 0x846ca68b) >>> 0;
  return (b ^ (b >>> 16)) >>> 0;
};
const looksFor = (id) => {
  const h = mixBits(fnv1a(id));
  return { shirt: SHIRTS[h % SHIRTS.length], hair: HAIRS[(h >>> 5) % HAIRS.length], skin: SKINS[(h >>> 10) % SKINS.length], phase: (h >>> 14) % 6 };
};

const spriteKind = ({ status, live }) => (status === 'done' ? (live ? 'done-open' : 'done-closed') : status);

const spriteHtml = (kind, id) => {
  const sprite = SPRITES[kind];
  if (!sprite) return '';
  const n = spriteFrames(kind).length;
  const look = looksFor(id);
  const style = [
    `width:${GRID_WIDTH * SCALE}px;height:${GRID_HEIGHT * SCALE}px`,
    `--n:${n};--dur:${n * sprite.frameMs}ms;--delay:-${(look.phase % n) * sprite.frameMs}ms`,
    `--px-shirt:${look.shirt};--px-hair:${look.hair};--px-skin:${look.skin}`,
  ].join(';');
  const svg = `<svg viewBox="${stripViewBox(kind)}" width="${GRID_WIDTH * n * SCALE}" height="${GRID_HEIGHT * SCALE}" shape-rendering="crispEdges" aria-hidden="true"><use href="#spr-${kind}"/></svg>`;
  return `<span class="avatar"><span class="spr" style="${style}" role="img" aria-label="${sprite.name}">${svg}</span></span>`;
};

const DARK_VARS = '--px-ink:#232c48;--px-pants:#4b5682;--px-paper:#e9edf7;--px-case:#7d869e;--px-case2:#596179;--px-off:#151b2c;--px-desk:#9a6a45;--px-desk2:#6e4a30;--px-steam:rgba(255,255,255,.42);--px-zzz:#9fb4ff;--px-chair:#525b80';
const LIGHT_VARS = '--px-ink:#1b2235;--px-pants:#3d4770;--px-paper:#fff;--px-case:#d5dae5;--px-case2:#a9b0c3;--px-off:#1d2333;--px-desk:#b98458;--px-desk2:#8a5d3b;--px-steam:rgba(11,16,32,.3);--px-zzz:#2f5bff;--px-chair:#5d6688';
const FIXED_FILLS = {
  ink: 'var(--px-ink)', skin: 'var(--px-skin)', blush: 'color-mix(in srgb,var(--px-skin) 62%,#e0605a)', hair: 'var(--px-hair)', shirt: 'var(--px-shirt)', pants: 'var(--px-pants)',
  white: '#fff', paper: 'var(--px-paper)', case: 'var(--px-case)', case2: 'var(--px-case2)', screen: '#0b1612', off: 'var(--px-off)', code1: '#baf764', code2: '#7fa4ff',
  code3: '#ff9bd6', code4: '#3f5249', cursor: '#fff', desk: 'var(--px-desk)', desk2: 'var(--px-desk2)', coffee: '#6b3b22', steam: 'var(--px-steam)', red: 'var(--red)',
  amber: '#ffc65c', zzz: 'var(--px-zzz)', chair: 'var(--px-chair)',
};
const spriteCss = `:root{${DARK_VARS}}
@media (prefers-color-scheme:light){:root{${LIGHT_VARS}}}
.card .avatar{float:right;margin:-6px -6px 4px 10px;line-height:0}
.spr{display:inline-block;overflow:hidden;vertical-align:top}
.spr svg{display:block;animation:spr-play var(--dur) steps(var(--n)) infinite;animation-delay:var(--delay,0s)}
@keyframes spr-play{to{transform:translateX(-100%)}}
${Object.entries(FIXED_FILLS).map(([name, fill]) => `.px-${name}{fill:${fill}}`).join('')}
@media (prefers-reduced-motion:reduce){.spr svg{animation:none}}`;

module.exports = { GRID_WIDTH, GRID_HEIGHT, SPRITES, spriteKind, spriteFrames, spriteHtml, spriteDefsHtml, spriteCss };
