const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { faviconLink, agentIconSvg, moodOf, ICON_GRID, MOOD_COLORS } = require('./favicon.cjs');

const decodeLink = (link) => decodeURIComponent(link.match(/href="data:image\/svg\+xml,([^"]+)"/)[1]);

describe('ICON_GRID', () => {
  test('is a 16x16 pixel grid', () => {
    assert.equal(ICON_GRID.length, 16);
    for (const row of ICON_GRID) assert.equal(row.length, 16);
  });
});

describe('agentIconSvg', () => {
  for (const mood of Object.keys(MOOD_COLORS)) {
    test(`${mood} is a 16x16 crisp-edged SVG lit with its colour`, () => {
      const svg = agentIconSvg(mood);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">/);
      assert.match(svg, /<\/svg>$/);
      assert.ok(svg.includes(`fill="${MOOD_COLORS[mood]}"`));
      for (const other of Object.keys(MOOD_COLORS).filter((m) => m !== mood)) {
        assert.ok(!svg.includes(MOOD_COLORS[other]), `${mood} icon leaks ${other} colour`);
      }
    });
  }

  test('draws only whole-pixel axis-aligned runs', () => {
    const paths = agentIconSvg('calm').match(/ d="[^"]+"/g);
    assert.ok(paths.length > 0);
    for (const d of paths) assert.match(d, /^ d="(M\d+ \d+h\d+v1h-\d+z)+"$/);
  });

  test('mood colour covers a large block so it reads at 16px', () => {
    const lit = ICON_GRID.join('').split('').filter((c) => c === 'g').length;
    assert.ok(lit >= 40, `${lit} mood pixels`);
  });

  test('opaque tile has no gradients, curves or external references', () => {
    const svg = agentIconSvg('review');
    assert.ok(!/gradient|<circle|rx=|href=|url\(/.test(svg));
  });
});

describe('moodOf', () => {
  test('is calm with no agents or only calm ones', () => {
    assert.equal(moodOf([]), 'calm');
    assert.equal(moodOf([{ status: 'working' }, { status: 'done' }]), 'calm');
  });

  test('review beats calm', () => {
    assert.equal(moodOf([{ status: 'working' }, { status: 'review' }]), 'review');
  });

  test('blocked beats review', () => {
    assert.equal(moodOf([{ status: 'review' }, { status: 'blocked' }, { status: 'working' }]), 'blocked');
  });
});

describe('faviconLink', () => {
  test('embeds the icon for the current mood as an SVG data URI', () => {
    const link = faviconLink([{ status: 'review' }, { status: 'blocked' }]);
    assert.match(link, /^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    assert.equal(decodeLink(link), agentIconSvg('blocked'));
  });
});
