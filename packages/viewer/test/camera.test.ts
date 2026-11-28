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

// The iso views in the file's axes; the legs of a move to a view that fits; the screw motion between two cameras.
import * as THREE from 'three';
import { AXIS_VIEWS, centred, cubeLook, fitCamera, heightShowing, legacyIso, legCamera, lookLegs, screwCamera, upIso,
  viewAxes, viewCamera, VIEWS } from '../src/camera.ts';

// A Y-up file's axes in the world (glTF's, turned so its Y is the world's Z): x -> x, y -> z, z -> -y.
const Y_UP = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, -1, 0));
// A file whose X is the world's up: x -> z, y -> x, z -> y.
const X_UP = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0));
const arr = (v: THREE.Vector3) => v.toArray();

test('viewAxes and upIso: Iso X, Y and Z put that file axis up; the up axis\'s iso is the world\'s iso', () => {
  const iso = { dir: arr(new THREE.Vector3(...VIEWS.iso.dir).normalize()), up: [0, 0, 1] };
  // A Z-up file (no axes, or the world's): Iso Z is iso.
  for (const axes of [undefined, new THREE.Matrix4()]) {
    const z = viewAxes('isoZ', axes);
    near(arr(z.dir), iso.dir, 'Iso Z dir');
    near(arr(z.up), iso.up, 'Iso Z up');
    assert.equal(upIso(axes), 'isoZ');
    near(arr(viewAxes('isoY', axes).up), [0, 1, 0], 'Iso Y up');
    near(arr(viewAxes('isoX', axes).up), [1, 0, 0], 'Iso X up');
  }
  // A Y-up file: Iso Y is iso; its Z, the world's -Y, is up in Iso Z.
  const y = viewAxes('isoY', Y_UP);
  near(arr(y.dir), iso.dir, 'Y up: Iso Y dir');
  near(arr(y.up), iso.up, 'Y up: Iso Y up');
  near(arr(viewAxes('isoZ', Y_UP).up), [0, -1, 0], 'Y up: Iso Z up');
  assert.equal(upIso(Y_UP), 'isoY');
  assert.equal(upIso(X_UP), 'isoX');
  near(arr(viewAxes('isoX', X_UP).up), [0, 0, 1], 'X up: Iso X up');
  // The world's views ignore the file's axes.
  near(arr(viewAxes('front', Y_UP).dir), [0, -1, 0], 'front');
  // viewCamera with them: about the same target, at the same distance.
  const c = viewCamera({ position: [1, -48, 3], target: [1, 2, 3], up: [0, 0, 1], height: 10 }, 'isoZ', Y_UP);
  near(c.up, [0, -1, 0], 'viewCamera up');
  const d = new THREE.Vector3().fromArray(c.position).sub(new THREE.Vector3(1, 2, 3));
  assert.ok(Math.abs(d.length() - 50) < 1e-9);
  // (Iso Z's direction in the file, (1, -1, 1), in the world: (1, -1, -1).)
  near(arr(d.normalize()), arr(new THREE.Vector3(1, -1, -1).normalize()), 'viewCamera dir');
});

// From the front (looking along +Y, Z up: right is +X), 400 mm high, about the origin.
const front: CameraState = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], height: 400 };

test('centred: the pan made the orbit centre, nothing drawn moving', () => {
  // The pan draws the target 10 mm right of the view's centre and 5 up: the centre is 10 left and 5 down of it.
  const c = centred({ ...front, pan: [10, 5] });
  near(c.target, [-10, 0, -5], 'target');
  near(c.position, [-10, -100, -5], 'position');
  assert.equal(c.pan, undefined);
  assert.equal(centred(front), front);
});

test('heightShowing: the whole sphere where it is in the view, with the margin', () => {
  // Centre 30 right and 40 up of the view's centre, radius 10, the free width twice the height: 50 up, 40 / 2 across.
  const sphere = new THREE.Sphere(new THREE.Vector3(30, 50, 40), 10);
  assert.ok(Math.abs(heightShowing(front, sphere, 2) - 2 * 50 * 1.1) < 1e-9);
  // Panned 20 right: the centre 20 left, the sphere 50 right of it: (50 + 10) / 2 = 30, less than 50.
  assert.ok(Math.abs(heightShowing({ ...front, pan: [20, 0] }, sphere, 2) - 2 * 50 * 1.1) < 1e-9);
  // Wide: across decides.
  assert.ok(Math.abs(heightShowing(front, sphere, 0.5) - 2 * (40 / 0.5) * 1.1) < 1e-9);
});

test('lookLegs: zoom out to the model, orbit, zoom in, each left out where the camera is there already', () => {
  const model = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
  const part = new THREE.Sphere(new THREE.Vector3(10, 0, 0), 20);
  const goal = fitCamera(viewCamera(front, 'right'), part, 1.5);
  assert.ok(Math.abs(goal.height - 2 * 20 * 1.1) < 1e-9);
  // The model shows already (220 of 400): orbit at 400, then zoom in to the part.
  let legs = lookLegs(front, goal, 'steps', model, 1.5);
  assert.deepEqual(legs.map((l) => l.kind), ['orbit', 'zoom']);
  assert.deepEqual(legs.map((l) => l.ms), [1, 0.5]);
  assert.equal(legs[0]!.to.height, 400);
  near(legs[0]!.to.target, goal.target, 'orbit to the goal\'s centre');
  near(legs[0]!.to.position, goal.position, 'orbit to the goal\'s pose');
  assert.equal(legs[1]!.from, legs[0]!.to);
  assert.equal(legs[1]!.to, goal);
  // Zoomed in to 50: out to show the model first (220), without moving.
  const close = { ...front, height: 50 };
  legs = lookLegs(close, goal, 'steps', model, 1.5);
  assert.deepEqual(legs.map((l) => [l.kind, l.ms]), [['zoom', 0.5], ['orbit', 1], ['zoom', 0.5]]);
  assert.ok(Math.abs(legs[0]!.to.height - 220) < 1e-9);
  near(legs[0]!.to.position, close.position, 'zoom out in place');
  // Panned: zoomed about the view's centre, made the orbit centre.
  // (The model 120 right of the centre: (120 + 100) / 1.5 across, more than 100 up.)
  legs = lookLegs({ ...close, pan: [120, 0] }, goal, 'steps', model, 1.5);
  near(legs[0]!.from.target, [-120, 0, 0], 'the pan made the centre');
  assert.ok(Math.abs(legs[0]!.to.height - 2 * (220 / 1.5) * 1.1) < 1e-9);
  // Looking along the view at the part's centre already: the zoom alone (no zoom out first, whatever shows).
  for (const height of [300, 10]) {
    assert.deepEqual(lookLegs({ ...goal, height }, goal, 'steps', model, 1.5).map((l) => l.kind), ['zoom']);
  }
  // There already: nothing; the model's sphere empty, no zoom out.
  assert.deepEqual(lookLegs(goal, goal, 'steps', model, 1.5), []);
  assert.deepEqual(lookLegs(close, goal, 'steps', new THREE.Sphere().makeEmpty(), 1.5).map((l) => l.kind),
    ['orbit', 'zoom']);
  // The pose differing only by a turn about the view's axis, or only by its centre: an orbit (the model shown whole
  // first, then the part).
  const all = ['zoom', 'orbit', 'zoom'];
  assert.deepEqual(lookLegs({ ...goal, up: [0, 1, 0] }, goal, 'steps', model, 1.5).map((l) => l.kind), all);
  assert.deepEqual(lookLegs({ ...goal, position: [goal.position[0]!, 5, goal.position[2]!],
    target: [goal.target[0]!, 5, goal.target[2]!] }, goal, 'steps', model, 1.5).map((l) => l.kind), all);
  // Together: one blend.
  legs = lookLegs(close, goal, 'together', model, 1.5);
  assert.deepEqual(legs.map((l) => [l.kind, l.ms, l.from, l.to]), [['blend', 1, close, goal]]);
});

test('screwCamera: the ends; a turn about the target keeps it; a slide goes straight; a screw\'s helix', () => {
  const at = (s: CameraState) => ({ target: s.target, up: s.up, dir: arr(new THREE.Vector3().fromArray(s.position)
    .sub(new THREE.Vector3().fromArray(s.target)).normalize()) });
  const same = (c: CameraState, s: CameraState, what: string) => {
    const [x, y] = [at(c), at(s)];
    near(x.target, y.target, `${what}: target`);
    near(x.up, y.up, `${what}: up`);
    near(x.dir, y.dir, `${what}: direction`);
  };
  // About the target: front to right, both 100 away.
  const right: CameraState = { position: [100, 0, 0], target: [0, 0, 0], up: [0, 0, 1], height: 400 };
  let m = screwCamera(front, right);
  same(m(0), front, 'start');
  same(m(1), right, 'end');
  for (const f of [0.25, 0.5, 0.75]) {
    near(m(f).target, [0, 0, 0], `the target fixed at ${f}`);
    const t = (f * Math.PI) / 2;
    near(m(f).position, [100 * Math.sin(t), -100 * Math.cos(t), 0], `on the circle at ${f}`);
  }
  // A slide: the same turn, the centre moving straight at an even pace, the distance and height by theirs.
  const slid: CameraState = { position: [40, -200, 30], target: [40, 0, 30], up: [0, 0, 1], height: 100 };
  m = screwCamera(front, slid);
  for (const f of [0.3, 0.6]) {
    near(m(f).target, [40 * f, 0, 30 * f], `slid at ${f}`);
    near(at(m(f)).dir, [0, -1, 0], `not turned at ${f}`);
    const d = new THREE.Vector3().fromArray(m(f).position).distanceTo(new THREE.Vector3().fromArray(m(f).target));
    assert.ok(Math.abs(d - (100 + 100 * f)) < 1e-9 && Math.abs(m(f).height - 400 * (100 / 400) ** f) < 1e-9);
  }
  // A screw: a turn of 2 about the vertical line through (50, 20, 0) with a slide of 60 up it (independently: three's
  // rotation about that line, then the slide), the camera's frame carried along; halfway is half of each.
  const screw = (angle: number, slide: number) => (p: THREE.Vector3) => p.clone().sub(new THREE.Vector3(50, 20, 0))
    .applyAxisAngle(new THREE.Vector3(0, 0, 1), angle).add(new THREE.Vector3(50, 20, slide));
  const turn = (angle: number) => (v: THREE.Vector3) => v.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), angle);
  const start: CameraState = { position: [0, -100, 30], target: [0, 0, 30], up: [0.6, 0, 0.8], height: 80 };
  const moved = (angle: number, slide: number): CameraState => ({
    position: arr(screw(angle, slide)(new THREE.Vector3().fromArray(start.position))),
    target: arr(screw(angle, slide)(new THREE.Vector3().fromArray(start.target))),
    up: arr(turn(angle)(new THREE.Vector3().fromArray(start.up))), height: 80 });
  m = screwCamera(start, moved(2, 60));
  for (const f of [0.2, 0.5, 0.9]) same(m(f), moved(2 * f, 60 * f), `the helix at ${f}`);
});

test('legCamera: an orbit along the screw (not the blend), a zoom the height alone, a blend interpolateCamera', () => {
  // Turning a quarter about Z while the target moves: the screw's helix and the blend's straight target differ.
  const a: CameraState = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], height: 50 };
  const b: CameraState = { position: [140, 40, 0], target: [40, 40, 0], up: [0, 0, 1], height: 50 };
  const orbit = legCamera({ kind: 'orbit', from: a, to: b, ms: 1 })(0.5);
  near(orbit.target, screwCamera(a, b)(0.5).target, 'orbit: the screw');
  assert.ok(Math.abs(orbit.target[0]! - 20) + Math.abs(orbit.target[1]! - 20) > 1, 'not straight');
  near(legCamera({ kind: 'blend', from: a, to: b, ms: 1 })(0.5).target, [20, 20, 0], 'blend: straight');
  const zoom = legCamera({ kind: 'zoom', from: a, to: { ...a, height: 200 }, ms: 0.5 })(0.5);
  assert.deepEqual({ ...zoom, height: 0 }, { ...a, height: 0 });
  assert.ok(Math.abs(zoom.height - 100) < 1e-9);
});

test("the view cube's corners and edges: looking from them, the file's up axis up as the screen shows it", () => {
  const close = (a: readonly number[], b: readonly number[], what: string) =>
    assert.ok(a.every((x, i) => Math.abs(x - b[i]!) < 1e-12), `${what}: ${a} vs ${b}`);
  const s3 = 1 / Math.sqrt(3), s2 = Math.SQRT1_2, s6 = 1 / Math.sqrt(6);
  // A corner: Iso Z's direction, Z up as a camera looking along it sees it (its three faces alike).
  let l = cubeLook([1, -1, 1]);
  close(l.dir, [s3, -s3, s3], 'corner');
  close(l.up, [-s6, s6, 2 * s6], 'its up');
  // Edges: upright, or across with Z tipped back (its two faces above and below).
  l = cubeLook([1, 1, 0]);
  close(l.dir, [s2, s2, 0], 'upright edge');
  close(l.up, [0, 0, 1], 'its up');
  l = cubeLook([0, -1, 1]);
  close(l.dir, [0, -s2, s2], 'edge across');
  close(l.up, [0, s2, s2], 'its up');
  l = cubeLook([-1, 0, -1]);
  close(l.dir, [-s2, 0, -s2], 'edge below');
  close(l.up, [-s2, 0, s2], 'its up');
  // A Y-up file (X -> X, Y -> Z, Z -> -Y): its corner (1, 1, 1) is the world's (1, -1, 1), its Y (the world's Z) up.
  const yUp = new THREE.Matrix4().fromArray([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  l = cubeLook([1, 1, 1], yUp);
  close(l.dir, [s3, -s3, s3], 'Y-up corner');
  close(l.up, [-s6, s6, 2 * s6], 'its up');
  // Along the up axis (a face's, not a corner's or edge's): the next axis up.
  close(cubeLook([0, 0, 1]).up, [1, 0, 0], 'along the up axis');
  // As a view: the camera there, the target and distance kept.
  const s = { position: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1], height: 5 } as CameraState;
  const c = viewCamera(s, cubeLook([1, -1, 1]));
  close(c.position, [10 * s3, -10 * s3, 10 * s3], 'the camera');
  close(c.up, [-s6, s6, 2 * s6], 'its up');
});

test("the isos: from above each of the top's corners, Z up, the faces they're named for in sight; older views' buttons",
  () => {
  // Each looks down on the top and on the two side faces its name gives (front -y, right +x, back +y, left -x).
  const faces: Record<string, [number, number, number]> = { front: [0, -1, 0], right: [1, 0, 0], back: [0, 1, 0],
    left: [-1, 0, 0] };
  for (const v of AXIS_VIEWS.filter((x) => x.name.startsWith('Iso'))) {
    const { dir, up } = viewAxes(v.view);
    const named = /^Iso \(top, (\w+), (\w+)\)$/.exec(v.name)!.slice(1);
    assert.ok(dir.z > 0 && up.z === 1, v.name);
    for (const [f, n] of Object.entries(faces)) {
      assert.equal(dir.dot(new THREE.Vector3(...n)) > 0, named.includes(f), `${v.name}: ${f}`);
    }
  }
  // Older names: iso, a Z-up file's Iso Z, a Y-up file's Iso Y the first; Iso X none (its X up).
  const yUp = new THREE.Matrix4().fromArray([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([legacyIso('iso'), legacyIso('isoZ'), legacyIso('isoY', yUp), legacyIso('isoX'),
    legacyIso('isoY')], ['isoFrontRight', 'isoFrontRight', 'isoFrontRight', undefined, undefined]);
});
