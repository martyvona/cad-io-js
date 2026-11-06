import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeArea, heightFor, matte, modelRect, snapped } from '../src/screenshot.ts';

const view = { left: 300, top: 0, width: 900, height: 800 };

test('free area: right of the tree, left of the controls; controls leaving nothing beside them ignored', () => {
  assert.deepEqual(freeArea(view), view);
  assert.deepEqual(freeArea(view, { left: 0, top: 0, width: 300, height: 800 }, { left: 955, top: 0, width: 245,
    height: 400 }), { left: 300, top: 0, width: 655, height: 800 });
  // A tree over the view (a phone): the area starts right of it.
  const phone = { left: 0, top: 0, width: 390, height: 844 };
  assert.deepEqual(freeArea(phone, { left: 0, top: 0, width: 141, height: 844 }),
    { left: 141, top: 0, width: 249, height: 844 });
  // Controls left of the tree's edge (covering everything): ignored.
  assert.deepEqual(freeArea(phone, { left: 0, top: 0, width: 141, height: 844 }, { left: 100, top: 0, width: 290,
    height: 30 }), { left: 141, top: 0, width: 249, height: 844 });
  // A closed tree (no width) changes nothing.
  assert.deepEqual(freeArea(view, { left: 0, top: 0, width: 0, height: 0 }), view);
});

test("the model's box: its circle's square within the free area; none when out of view", () => {
  const free = { left: 300, top: 0, width: 655, height: 800 };
  assert.deepEqual(modelRect({ x: 600, y: 400, r: 100 }, free), { left: 500, top: 300, width: 200, height: 200 });
  // Larger than the area: cut to it, on each side.
  assert.deepEqual(modelRect({ x: 600, y: 400, r: 1000 }, free), free);
  // Partly past the controls and the top.
  assert.deepEqual(modelRect({ x: 900, y: 50, r: 100 }, free), { left: 800, top: 0, width: 155, height: 150 });
  assert.equal(modelRect({ x: 100, y: 400, r: 100 }, free), undefined);
  assert.equal(modelRect({ x: 600, y: 400, r: 0.2 }, free), undefined);
});

test('whole pixels, and the height in proportion', () => {
  assert.deepEqual(snapped({ left: 10.4, top: 2.6, width: 100.2, height: 50.5 }), { left: 10, top: 3, width: 101,
    height: 50 });
  assert.equal(heightFor(200, { width: 100, height: 50 }), 100);
  assert.equal(heightFor(333, { width: 1000, height: 1 }), 1);
  assert.equal(heightFor(1001, { width: 1000, height: 333 }), 333);
});

test('matte: coverage and colour back from the view on black and on white, blended in sRGB values', () => {
  // Pixels of colour F (sRGB) at coverage a, blended over black and white as the antialiasing does, after encoding.
  const cases: [number[], number][] = [[[200, 40, 10], 1], [[0, 0, 0], 0], [[30, 160, 250], 0.5], [[255, 255, 255],
    0.25], [[0, 0, 0], 1], [[0, 0, 0], 0.12]];
  const black = new Uint8ClampedArray(cases.length * 4), white = new Uint8ClampedArray(cases.length * 4);
  cases.forEach(([f, a], i) => {
    for (let k = 0; k < 3; k++) {
      black[4 * i + k] = Math.round(a * f[k]!);
      white[4 * i + k] = Math.round(a * f[k]! + (1 - a) * 255);
    }
    black[4 * i + 3] = white[4 * i + 3] = 255;
  });
  const out = matte(black, white);
  cases.forEach(([f, a], i) => {
    assert.ok(Math.abs(out[4 * i + 3]! - 255 * a) <= 1, `alpha ${i}: ${out[4 * i + 3]} for ${a}`);
    if (a > 0.2) for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[4 * i + k]! - f[k]!) <= 3, `colour ${i}: ${[
      ...out.slice(4 * i, 4 * i + 3)]} for ${f}`);
    // Over white again, in sRGB: the pixel as it was drawn on white.
    for (let k = 0; k < 3; k++) {
      const back = out[4 * i + 3]! / 255 * out[4 * i + k]! + (1 - out[4 * i + 3]! / 255) * 255;
      assert.ok(Math.abs(back - white[4 * i + k]!) <= 1.5, `over white ${i}: ${back} for ${white[4 * i + k]}`);
    }
  });
  // A pixel the same on both (a solid part, whatever its colour): opaque, as it is.
  assert.deepEqual([...matte(new Uint8ClampedArray([12, 34, 56, 255]), new Uint8ClampedArray([12, 34, 56, 255]))],
    [12, 34, 56, 255]);
});
