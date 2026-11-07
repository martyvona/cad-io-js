import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { axisSymbol, axisView, backingColour, Gnomon, GNOMON_EXTENT, gnomonShown, LABEL_BOX, layoutLabels,
  NUDGE_SPEED, TOUCH_REACH, nudgesOf, project, sameTurn, stepNudges, SYMBOL }
  from '../src/gnomon.ts';

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

/**
 * The smallest sphere holding the origin and three tips is centred where the gnomon turns (its scene's origin): the
 * tips equally far from it, in their own plane (a centre off it is farther from all three), the origin no farther.
 */
function assertCentred(g: Gnomon): void {
  const [o, x, y, z] = g.points as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  const r = x.length();
  near(r, Math.sqrt(6) / 3, 'radius');
  near(y.length(), r, 'Y tip');
  near(z.length(), r, 'Z tip');
  const normal = new THREE.Vector3().subVectors(y, x).cross(new THREE.Vector3().subVectors(z, x)).normalize();
  near(normal.dot(x), 0, 'centre in the tips\' plane');
  assert.ok(o.length() <= r + 1e-12, `origin inside: ${o.length()}`);
}

test('the gnomon: the world\'s axes where the file has none, centred on the smallest sphere round its points', () => {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  assertCentred(g);
  const [o, x, y, z] = g.points as THREE.Vector3[];
  // Each tip one unit from the origin along its axis.
  for (const [tip, axis] of [[x, [1, 0, 0]], [y, [0, 1, 0]], [z, [0, 0, 1]]] as const) {
    const d = new THREE.Vector3().subVectors(tip!, o!);
    for (let i = 0; i < 3; i++) near(d.getComponent(i), axis[i]!, `${tip === x ? 'X' : tip === y ? 'Y' : 'Z'}[${i}]`);
  }
});

test('the gnomon: a file\'s Y up as the scene\'s Z, under the model\'s turn; its scale and place dropped', () => {
  const g = new Gnomon();
  // glTF's axes in the scene's: X -> X, Y -> Z, Z -> -Y.
  const yUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  g.set(yUp, new THREE.Matrix4());
  assertCentred(g);
  const dir = (k: number) => new THREE.Vector3().subVectors(g.points[k]!, g.points[0]!);
  assert.deepEqual(dir(2).toArray().map((v) => Math.round(v)), [0, 0, 1]);
  assert.deepEqual(dir(3).toArray().map((v) => Math.round(v)), [0, -1, 0]);
  // The model turned 90 degrees about Z, scaled by 3 and moved: the file's X along the world's Y, lengths 1.
  const world = new THREE.Matrix4().compose(new THREE.Vector3(10, 20, 30),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), new THREE.Vector3(3, 3, 3));
  g.set(yUp, world);
  assertCentred(g);
  const x = dir(1);
  near(x.x, 0, 'X.x');
  near(x.y, 1, 'X.y');
  near(x.z, 0, 'X.z');
  near(dir(3).x, 1, 'Z.x');
});

test('the gnomon starts shown, unless remembered hidden; off in check and shot pages; ?gnomon= decides', () => {
  assert.equal(gnomonShown('', null), true);
  assert.equal(gnomonShown('?model=a.stp', '1'), true);
  assert.equal(gnomonShown('', '0'), false);
  assert.equal(gnomonShown('?check', null), false);
  assert.equal(gnomonShown('?controls=0', null), false);
  assert.equal(gnomonShown('?controls=1', null), true);
  assert.equal(gnomonShown('?check&gnomon=1', '0'), true);
  assert.equal(gnomonShown('?gnomon=0', '1'), false);
});

/**
 * Turns of the axes relative to the view: random ones (a fixed sequence), and views along every axis and diagonal at
 * every 15 degrees of roll, each also mirrored.
 */
function sampledTurns(): THREE.Matrix4[] {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const turns: THREE.Matrix4[] = [];
  for (let i = 0; i < 50000; i++) {
    const q = new THREE.Quaternion(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    turns.push(new THREE.Matrix4().makeRotationFromQuaternion(q));
  }
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const c of [-1, 0, 1]) {
    if (!a && !b && !c) continue;
    const z = new THREE.Vector3(a, b, c).normalize();
    const up = Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    for (let r = 0; r < 24; r++) {
      const m = new THREE.Matrix4().lookAt(z, new THREE.Vector3(), up)
        .premultiply(new THREE.Matrix4().makeRotationAxis(z, r * Math.PI / 12));
      turns.push(m.invert());
    }
  }
  return turns.flatMap((t) => [t, t.clone().multiply(new THREE.Matrix4().makeScale(-1, 1, 1))]);
}

test('the labels: no two boxes overlap, the origin\'s never moved, every layout inside GNOMON_EXTENT', () => {
  const reach = { left: 0, right: 0, down: 0, up: 0 };
  let overlap = 0, rose = 0;
  for (const t of sampledTurns()) {
    const { tips, placements, origin } = project(t);
    const labels = layoutLabels(placements, origin, LABEL_BOX);
    const all = [...labels, origin];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      overlap = Math.max(overlap, Math.min(LABEL_BOX - Math.abs(all[i]!.x - all[j]!.x),
        LABEL_BOX - Math.abs(all[i]!.y - all[j]!.y)));
    }
    // (Labels only move sideways.)
    for (const [k, l] of labels.entries()) rose = Math.max(rose, Math.abs(l.y - placements[k]!.y));
    // The lines' ends and origin with their width, the boxes' edges.
    for (const [p, r] of [...[...tips, origin].map((q) => [q, 1] as const), ...labels.map((q) =>
      [q, LABEL_BOX / 2] as const)]) {
      reach.left = Math.max(reach.left, r - p.x);
      reach.right = Math.max(reach.right, p.x + r);
      reach.down = Math.max(reach.down, r - p.y);
      reach.up = Math.max(reach.up, p.y + r);
    }
  }
  console.log('reach', reach);
  assert.ok(overlap <= 1e-6, `boxes overlap by ${overlap}`);
  assert.equal(rose, 0, 'labels moved up or down');
  for (const k of ['left', 'right', 'down', 'up'] as const) {
    assert.ok(reach[k] <= GNOMON_EXTENT[k], `${k}: ${reach[k]} past ${GNOMON_EXTENT[k]}`);
    // (Not much room to spare: the box is the gnomon's.)
    assert.ok(reach[k] > GNOMON_EXTENT[k] - 2, `${k}: ${reach[k]} well inside ${GNOMON_EXTENT[k]}`);
  }
});

test('the labels: a pair nudged apart evenly, the way their points lie; one off the origin\'s box alone', () => {
  const o = { x: 100, y: 100 };
  // x a little right of y, both well away from the origin: each moves half, x to the right.
  const [x, y, z] = layoutLabels([{ x: 3, y: 0 }, { x: 0, y: 5 }, { x: 50, y: 50 }], o, 14);
  assert.deepEqual([x!.x, y!.x, z!.x], [3 + 5.5, 0 - 5.5, 50]);
  // Level: the lower index left.
  const [a, b] = layoutLabels([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 50 }], o, 14);
  assert.deepEqual([a!.x, b!.x], [-7, 7]);
  // On the origin's box: the label moves the whole way, the way it lies (or left, level), the box not at all.
  const [p] = layoutLabels([{ x: 2, y: 1 }, { x: -50, y: 0 }, { x: 50, y: 0 }], { x: 0, y: 0 }, 14);
  assert.deepEqual([p!.x, p!.y], [14, 1]);
  const [q] = layoutLabels([{ x: 0, y: 0 }, { x: -50, y: 0 }, { x: 50, y: 0 }], { x: 0, y: 0 }, 14);
  assert.equal(q!.x, -14);
});

test('the labels: nudged again until nothing overlaps (a pair pushed onto the origin\'s box)', () => {
  // x and y overlap; parting them pushes x onto the origin's box, which pushes x back into y: more than one pass.
  const o = { x: -14, y: 0 };
  const [x, y, z] = layoutLabels([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 80, y: 0 }], o, 14);
  const all = [x!, y!, z!, o];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    assert.ok(Math.abs(all[i]!.x - all[j]!.x) >= 14 - 1e-6, `${i} and ${j} overlap: ${JSON.stringify(all)}`);
  }
  assert.ok(o.x < x!.x && x!.x < y!.x, 'their order as their points lie');
});

test('a label\'s view: its axis at the viewer, or away if it already is; the same turn', () => {
  const world = new THREE.Matrix4();
  const back = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
  assert.equal(axisView(0, world, back(0, -1, 0)), 'right');
  assert.equal(axisView(0, world, back(1, 0, 0)), 'left');
  assert.equal(axisView(1, world, back(0, -1, 0)), 'back');
  assert.equal(axisView(1, world, back(0, 1, 0)), 'front');
  assert.equal(axisView(2, world, back(1, -1, 1)), 'top');
  assert.equal(axisView(2, world, back(0, 0, 1)), 'bottom');
  // Within a degree counts as already; two degrees off doesn't.
  const tilt = (deg: number) => back(0, -Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180));
  assert.equal(axisView(2, world, tilt(0.9)), 'bottom');
  assert.equal(axisView(2, world, tilt(2)), 'top');
  // glTF's axes: its y the world's Z, its z the world's -Y.
  const yUp = new THREE.Matrix4().fromArray([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  assert.equal(axisView(1, yUp, back(0, -1, 0)), 'top');
  assert.equal(axisView(2, yUp, back(1, 0, 0)), 'front');
  const q = new THREE.Quaternion().setFromAxisAngle(back(1, 2, 3), 0.7);
  assert.ok(sameTurn(q, q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(back(0, 1, 0), 0.015))));
  assert.ok(!sameTurn(q, q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(back(0, 1, 0), 0.03))));
  // (q and -q are one turn.)
  assert.ok(sameTurn(q, new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w)));
});

test('a label\'s backing: a shade lighter than a dark background, darker than a light one', () => {
  const dark = new THREE.Color(0x404040), light = new THREE.Color(0xffffff);
  const [d, l] = [backingColour(dark), backingColour(light)];
  assert.ok(d.r > dark.r && d.g > dark.g && d.b > dark.b && d.r < 1, `dark: ${d.getHexString()}`);
  assert.ok(l.r < 1 && l.g < 1 && l.b < 1 && l.r > 0.5, `light: ${l.getHexString()}`);
  // (The background itself left as it was.)
  assert.equal(dark.getHex(), 0x404040);
});

/** A camera's turn looking from `dir` (from the target) with `up`. */
const looking = (dir: number[], up: number[]) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4()
  .lookAt(new THREE.Vector3().fromArray(dir), new THREE.Vector3(), new THREE.Vector3().fromArray(up)));
const ISO = looking([1, -1, 1], [0, 0, 1]), FRONT = looking([0, -1, 0], [0, 0, 1]);

/** The labels' layout as a fresh gnomon gives it at once for a turn (nothing to glide from). */
function settled(q: THREE.Quaternion): { x: number; y: number }[] {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  g.advance(q, { now: 0 });
  return g.layout;
}

const far = (a: { x: number; y: number }[], b: { x: number; y: number }[]) =>
  Math.max(...a.map((p, k) => Math.hypot(p.x - b[k]!.x, p.y - b[k]!.y)));

test('nudges: stepped at most so far towards their places; the layout\'s less the placement points', () => {
  assert.deepEqual(stepNudges([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 6, y: 8 }, { x: 1.5, y: 1 }], 5),
    [{ x: 3, y: 4 }, { x: 1.5, y: 1 }]);
  const p = { placements: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 60, y: 60 }], origin: { x: -60, y: -60 } };
  assert.deepEqual(nudgesOf(p), [{ x: -5.5, y: 0 }, { x: 5.5, y: 0 }, { x: 0, y: 0 }]);
});

test('the labels turning freely: their nudges change at most NUDGE_SPEED, frames wanted till they\'re placed', () => {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  g.advance(ISO, { now: 0 });
  assert.equal(g.moving, false);
  // At once to the front (as a fast drag might): the y label, now on the origin, glides aside.
  let t = 1000;
  g.advance(FRONT, { now: t });
  // (The placement points jump with the turn; the nudges, from the first frame after a pause, MAX_STEP's worth.)
  assert.ok(g.moving, 'placed at once');
  let last = g.layout;
  const want = settled(FRONT);
  let frames = 0;
  while (g.moving && frames < 100) {
    t += 33;
    g.advance(FRONT, { now: t });
    const step = far(g.layout, last);
    assert.ok(step <= NUDGE_SPEED * 0.033 + 1e-9, `frame ${frames}: moved ${step}`);
    last = g.layout;
    frames++;
  }
  assert.ok(frames >= 3 && frames < 100, `${frames} frames`);
  assert.ok(far(g.layout, want) < 1e-9, 'not where the layout puts them');
  // A new model: placed at once.
  g.set(undefined, new THREE.Matrix4());
  g.advance(ISO, { now: t + 33 });
  assert.equal(g.moving, false);
});

test('the labels in a flight: from where they were to the destination\'s places as it goes; a new flight anew', () => {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  g.advance(ISO, { now: 0 });
  const start = g.layout;
  const id = {};
  const at = (s: number) => {
    const q = ISO.clone().slerp(FRONT, s);
    g.advance(q, { now: s * 1000, flight: { id, to: FRONT, s } });
    return g.layout;
  };
  assert.ok(far(at(0), start) < 1e-9, 'not from where they were');
  // Each label its placement point plus its nudge a fraction s of the way (y's from none to its final one).
  const end = settled(FRONT);
  const mid = at(0.5);
  assert.ok(far(at(1), end) < 1e-9, 'not at the destination\'s places');
  // A smooth path: small steps all the way.
  let last = at(0), most = 0;
  for (let s = 0.02; s <= 1 + 1e-9; s += 0.02) { const l = at(s); most = Math.max(most, far(l, last)); last = l; }
  assert.ok(most < 3, `a step of ${most}`);
  assert.ok(far(mid, start) > 1 && far(mid, end) > 1, 'half way, between');
  // Another flight (another id) starts from where the labels are, not from the first's start.
  const now = g.layout, other = {};
  g.advance(FRONT, { now: 2000, flight: { id: other, to: ISO, s: 0 } });
  assert.ok(far(g.layout, now) < 1e-9, 'a new flight jumped');
});

test('hits: a drawn box for a mouse, TOUCH_REACH for a finger, the nearest centre where reaches overlap', () => {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  g.advance(FRONT, { now: 0 });
  const [, y, z, o] = g.layout as { x: number; y: number }[];
  // Inside the drawn box, or just off it.
  assert.equal(g.hit(z!.x + 6, z!.y + 6), 'z');
  assert.equal(g.hit(z!.x, z!.y + 8), undefined);
  // A finger reaches further, but not past TOUCH_REACH.
  assert.equal(g.hit(z!.x, z!.y + 8, TOUCH_REACH), 'z');
  assert.equal(g.hit(z!.x, z!.y + TOUCH_REACH + 1, TOUCH_REACH), undefined);
  // The origin's box in a view along an axis too.
  assert.equal(g.hit(o!.x, o!.y), 'iso');
  // Between the origin's box and y's beside it (both in a finger's reach): the nearer.
  assert.ok(Math.abs(Math.abs(y!.x - o!.x) - LABEL_BOX) < 1e-9 && Math.abs(y!.y - o!.y) < 1e-9,
    `y beside the origin's box: ${JSON.stringify([y, o])}`);
  const mid = (o!.x + y!.x) / 2, toward = Math.sign(o!.x - y!.x);
  assert.equal(g.hit(mid + toward, o!.y, TOUCH_REACH), 'iso');
  assert.equal(g.hit(mid - toward, o!.y, TOUCH_REACH), 'y');
});

test('an axis along the line of sight: a ringed dot at the viewer, a cross away, faded in from 10 to 3 degrees', () => {
  const along = (deg: number, sign: number) => {
    const c = Math.cos(deg * Math.PI / 180);
    return [0.1, sign * c, Math.sqrt(Math.max(0, 1 - c * c - 0.01))];
  };
  assert.deepEqual(axisSymbol([0, 1, 0]), { axis: 1, head: true, opacity: 1 });
  assert.deepEqual(axisSymbol([0, 0, -1]), { axis: 2, head: false, opacity: 1 });
  assert.equal(axisSymbol(along(2, -1))!.opacity, 1);
  const half = axisSymbol(along(6.5, 1))!;
  assert.ok(half.head && half.opacity > 0.2 && half.opacity < 0.8, `6.5 degrees: ${half.opacity}`);
  assert.equal(axisSymbol(along(11, 1)), undefined);
  assert.equal(axisSymbol([Math.SQRT1_2, 0, Math.SQRT1_2]), undefined);
  // Within the origin's box, which every label clears (the sampled layouts' test): never under a label.
  assert.ok(SYMBOL.ring + SYMBOL.stroke / 2 <= LABEL_BOX / 2);
  // The gnomon's: in the front, y away from the viewer; iso, none.
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  g.advance(FRONT, { now: 0 });
  assert.deepEqual(g.symbol, { axis: 1, head: false, opacity: 1 });
  g.advance(ISO, { now: 0 });
  assert.equal(g.symbol, undefined);
});
