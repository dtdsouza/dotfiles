const MOOD_COLORS = { calm: '#baf764', review: '#ffc65c', blocked: '#ff6b6b' };

const moodOf = (items) => {
  if (items.some((a) => a.status === 'blocked')) return 'blocked';
  if (items.some((a) => a.status === 'review')) return 'review';
  return 'calm';
};

// An opaque purple tile keeps the lime robot legible on both light and dark tab bars.
// Alarm moods light the whole visor: eye-sized colour dots are indistinguishable at 16px.
const robotSvg = (mood) => {
  const signal = MOOD_COLORS[mood];
  const visor = mood === 'calm' ? '#000516' : signal;
  const eyes = mood === 'calm' ? signal : '#000516';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b4dff"/><stop offset="1" stop-color="#4b1aa8"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#tile)"/>
<rect x="30.5" y="8" width="3" height="10" fill="#baf764"/>
<circle cx="32" cy="8" r="5" fill="${signal}" stroke="#000516" stroke-width="2"/>
<rect x="6" y="28" width="6" height="12" rx="2" fill="#baf764"/>
<rect x="52" y="28" width="6" height="12" rx="2" fill="#baf764"/>
<rect x="11" y="17" width="42" height="32" rx="9" fill="#baf764"/>
<rect x="17" y="24" width="30" height="15" rx="7.5" fill="${visor}" stroke="#000516" stroke-width="2"/>
<circle cx="25" cy="31.5" r="4.2" fill="${eyes}"/>
<circle cx="39" cy="31.5" r="4.2" fill="${eyes}"/>
<rect x="26" y="43" width="12" height="2.5" rx="1.25" fill="#000516"/>
<rect x="17" y="53" width="30" height="11" rx="4" fill="#baf764"/>
</svg>`;
};

const faviconLink = (items) =>
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(robotSvg(moodOf(items)))}">`;

module.exports = { faviconLink, robotSvg, MOOD_COLORS };
