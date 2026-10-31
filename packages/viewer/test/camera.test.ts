import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolateCamera } from '../src/camera.ts';
import type { CameraState } from '../src/view-state.ts';

const near = (a: readonly number[], b: readonly number[], what: string) => assert.ok(
  a.every((v, i) => Math.abs(v - b[i]!) < 1e-9), `${what}: ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

// From the front (looking along +Y, Z up) at 100 mm to the right side (looking along -X) at 300 mm, about another
// target, zoomed in from a 400 mm view to 100 mm.
const a: CameraState = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], height: 400 };
const b: CameraState = { position: [310, 0, 0], target: [10, 0, 0], up: [0, 0, 1], height: 100 };

test('interpolateCamera: the ends are the two cameras', () => {
  for (const [f, s] of [[0, a], [1, b]] as const) {
    const c = interpolateCamera(a, b, f);
    near(c.position, s.position, `position at ${f}`);
    near(c.target, s.target, `target at ${f}`);
    near(c.up, s.up, `up at ${f}`);
    assert.ok(Math.abs(c.height - s.height) < 1e-9, `height at ${f}: ${c.height}`);
  }
});

test('interpolateCamera: halfway, half the turn, the target and distance halfway, the height by ratio', () => {
  const c = interpolateCamera(a, b, 0.5);
  near(c.target, [5, 0, 0], 'target');
  // Halfway between looking from -Y and from +X: from (1, -1, 0) / sqrt 2, at the mean distance, 200 mm.
  const d = 200 / Math.SQRT2;
  near(c.position, [5 + d, -d, 0], 'position');
  near(c.up, [0, 0, 1], 'up');
  assert.ok(Math.abs(c.height - 200) < 1e-9, `height ${c.height}`);
});

test('interpolateCamera: up stays a unit vector across the view direction, with up changing too', () => {
  const top: CameraState = { position: [0, 0, 50], target: [0, 0, 0], up: [0, 1, 0], height: 10 };
  for (const f of [0.1, 0.3, 0.7, 0.9]) {
    const c = interpolateCamera(a, top, f);
    const dir = c.position.map((v, i) => v - c.target[i]!);
    const len = Math.hypot(...dir);
    assert.ok(Math.abs(Math.hypot(...c.up) - 1) < 1e-9, `up's length at ${f}`);
    assert.ok(Math.abs(dir.reduce((s, v, i) => s + v * c.up[i]!, 0) / len) < 1e-9, `up across the view at ${f}`);
  }
});

test('interpolateCamera: the pan straight, none at either end none between', () => {
  assert.equal(interpolateCamera(a, b, 0.5).pan, undefined);
  const c = interpolateCamera({ ...a, pan: [10, -4] }, b, 0.25);
  near(c.pan!, [7.5, -3], 'pan');
  near(interpolateCamera(a, { ...b, pan: [0, 8] }, 1).pan!, [0, 8], 'pan at the end');
});
