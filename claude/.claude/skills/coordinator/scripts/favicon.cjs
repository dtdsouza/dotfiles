const MOOD_COLORS = { calm: '#baf764', review: '#ffc65c', blocked: '#ff6b6b' };

const moodOf = (items) => {
  if (items.some((a) => a.status === 'blocked')) return 'blocked';
  if (items.some((a) => a.status === 'review')) return 'review';
  return 'calm';
};

// The card agent seen from behind at its CRT, redrawn on 16x16 because the 32x24 sprite turns to mush at tab size.
// The mood lights the whole screen: eye-sized colour dots are indistinguishable at 16px.
const ICON_GRID = [
  '.BBBBBBBBBBBBBB.',
  'BkkkkkkkkkkkkkkB',
  'BkmmmmmmmmmmmMkB',
  'BkmggggggggggMkB',
  'BkmgccgccccggMkB',
  'BkmggggggggggMkB',
  'BkmgcccgccgggMkB',
  'BkmggggggggggMkB',
  'BkmggggggggggMkB',
  'BkmmmkkkkkkmmMkB',
  'BkkkkhhhhhhkkkkB',
  'BBBkhhhhhhhhkBBB',
  'BBBkhhhhhhhhkBBB',
  'BBBkshhhhhhskBBB',
  'BBkkttttttttkkBB',
  '.BkttttttttttkB.',
];

// Hex values from the dark theme of dashboard-sprites.cjs: a data-URI icon cannot read the page's CSS variables.
// The opaque tile keeps the icon legible on both light and dark tab bars.
const ICON_FILLS = {
  B: '#151b2c', k: '#232c48', m: '#7d869e', M: '#596179', c: '#0b1612', h: '#7d4fb0', s: '#f6d2b1', t: '#4a74ff',
};

const runsOf = (ch) =>
  ICON_GRID.flatMap((row, y) => [...row.matchAll(new RegExp(`${ch}+`, 'g'))].map((m) => `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`)).join('');

const agentIconSvg = (mood) => {
  const fills = { ...ICON_FILLS, g: MOOD_COLORS[mood] };
  const paths = Object.entries(fills).map(([ch, fill]) => `<path fill="${fill}" d="${runsOf(ch)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${paths}</svg>`;
};

const faviconLink = (items) =>
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(agentIconSvg(moodOf(items)))}">`;

module.exports = { faviconLink, agentIconSvg, moodOf, ICON_GRID, MOOD_COLORS };
