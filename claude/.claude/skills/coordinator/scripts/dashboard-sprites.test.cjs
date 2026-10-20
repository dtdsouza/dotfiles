const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { GRID_WIDTH, GRID_HEIGHT, SPRITES, spriteKind, spriteFrames, spriteHtml, spriteDefsHtml, spriteCss } = require('./dashboard-sprites.cjs');

const KINDS = ['working', 'review', 'blocked', 'done-open', 'done-closed'];

describe('spriteKind', () => {
  test('maps each card status to its sprite', () => {
    assert.equal(spriteKind({ status: 'working', live: true }), 'working');
    assert.equal(spriteKind({ status: 'review', live: true }), 'review');
    assert.equal(spriteKind({ status: 'blocked', live: true }), 'blocked');
    assert.equal(spriteKind({ status: 'done', live: true }), 'done-open');
    assert.equal(spriteKind({ status: 'done', live: false }), 'done-closed');
  });
});

describe('spriteFrames', () => {
  for (const kind of KINDS) {
    test(`${kind} has 2 to 6 frames on the fixed grid`, () => {
      const frames = spriteFrames(kind);
      assert.ok(frames.length >= 2 && frames.length <= 6, `${frames.length} frames`);
      for (const grid of frames) {
        assert.equal(grid.length, GRID_HEIGHT);
        for (const row of grid) assert.equal(row.length, GRID_WIDTH);
      }
    });

    test(`${kind} frames differ from each other`, () => {
      const unique = new Set(spriteFrames(kind).map((grid) => grid.join('\n')));
      assert.ok(unique.size > 1);
    });
  }
});

describe('spriteHtml', () => {
  test('references the shared symbol, shows every frame side by side and declares the step count', () => {
    const frames = spriteFrames('working');
    const html = spriteHtml('working', 'task-a');
    assert.match(html, new RegExp(`--n:${frames.length}`));
    assert.match(html, new RegExp(`viewBox="0 0 ${GRID_WIDTH * frames.length} ${GRID_HEIGHT}"`));
    assert.match(html, /<use href="#spr-working"\/>/);
    assert.match(html, /shape-rendering="crispEdges"/);
  });

  test('keeps each card small', () => {
    assert.ok(spriteHtml('working', 'task-a').length < 600);
  });

  test('the same task id always renders the same agent', () => {
    assert.equal(spriteHtml('review', 'dashboard-pixel-art'), spriteHtml('review', 'dashboard-pixel-art'));
  });

  test('different task ids get different looks', () => {
    const looks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => spriteHtml('working', `task-${id}`).match(/--px-shirt:[^;]+;--px-hair:[^;]+;--px-skin:[^;"]+/)[0]));
    assert.ok(looks.size >= 6, `${looks.size} distinct looks`);
  });

  test('no seeded colour clashes with the column colours', () => {
    const forbidden = ['#ff6b6b', '#d93636', '#ffc65c', '#9a6200', '#baf764', '#3f6b0a'];
    for (const kind of KINDS) for (let i = 0; i < 40; i++) {
      const style = spriteHtml(kind, `id-${i}`).match(/style="([^"]+)"/)[1].toLowerCase();
      for (const color of forbidden) assert.ok(!style.includes(color), `${kind} id-${i} uses ${color}`);
    }
  });

  test('escapes the task id into nothing but colour choices', () => {
    assert.doesNotMatch(spriteHtml('working', '"><script>x</script>'), /<script>/);
  });

  test('unknown kinds render nothing', () => {
    assert.equal(spriteHtml('nope', 'x'), '');
  });
});

describe('spriteDefsHtml', () => {
  test('defines one hidden symbol per requested kind, once', () => {
    const defs = spriteDefsHtml(['working', 'done-open', 'working']);
    assert.equal(defs.match(/<symbol /g).length, 2);
    assert.match(defs, new RegExp(`<symbol id="spr-working" viewBox="0 0 ${GRID_WIDTH * spriteFrames('working').length} ${GRID_HEIGHT}">`));
    assert.match(defs, /^<svg [^>]*width="0" height="0"/);
  });

  test('renders nothing when no card needs a sprite', () => {
    assert.equal(spriteDefsHtml([]), '');
  });
});

describe('spriteCss', () => {
  test('defines a fill for every palette class used by the sprites', () => {
    const used = new Set([...spriteDefsHtml(KINDS).matchAll(/class="(px-[a-z0-9]+)"/g)].map((m) => m[1]));
    assert.ok(used.size > 10);
    for (const cls of used) assert.match(spriteCss, new RegExp(`\\.${cls}\\{fill:`));
  });

  test('has a light-theme override and keeps one still frame under reduced motion', () => {
    assert.match(spriteCss, /prefers-color-scheme:light/);
    assert.match(spriteCss, /prefers-reduced-motion:reduce\)\{\.spr svg\{animation:none/);
  });

  test('ships one sprite per kind', () => {
    assert.deepEqual(Object.keys(SPRITES).sort(), [...KINDS].sort());
  });
});
