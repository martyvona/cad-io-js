import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { closesUp, MAX_BOUNDARY, WIDTH } from '../src/closure.ts';

/** A geometry's positions and triangles (non-indexed ones numbered in order). */
function mesh(g: THREE.BufferGeometry): [Float32Array, Uint32Array] {
  const pos = g.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], 3 * i);
  const index = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i);
  return [positions, Uint32Array.from(index)];
}

/** A unit cube from 8 corners, 12 triangles facing out. */
function cube(): { p: number[]; t: number[] } {
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
    7];
  return { p, t };
}
const run = ({ p, t }: { p: number[]; t: number[] }) => closesUp(Float32Array.from(p), Uint32Array.from(t));

test('closesUp: a box, faces apart (welded by position), inside out too, indexed or not', () => {
  assert.equal(closesUp(...mesh(new THREE.BoxGeometry(1, 2, 3))), true);
  assert.equal(closesUp(...mesh(new THREE.BoxGeometry().toNonIndexed())), true);
  const c = cube();
  assert.equal(run(c), true);
  for (let i = 0; i < c.t.length; i += 3) [c.t[i + 1], c.t[i + 2]] = [c.t[i + 2]!, c.t[i + 1]!];
  assert.equal(run(c), true);
});

test('closesUp: not a sheet, a box missing a face, an edge of three triangles, a mixed-up orientation', () => {
  assert.equal(closesUp(...mesh(new THREE.PlaneGeometry())), false);
  const open = cube();
  open.t.splice(0, 6);
  assert.equal(run(open), false);
  const fin = cube();
  fin.p.push(0.5, -1, 0.5);
  fin.t.push(0, 1, 8);
  assert.equal(run(fin), false);
  const flipped = cube();
  [flipped.t[1], flipped.t[2]] = [flipped.t[2]!, flipped.t[1]!];
  assert.equal(run(flipped), false);
  assert.equal(run({ p: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2] }), false);
  assert.equal(closesUp(new Float32Array(), new Uint32Array()), false);
  // Two cubes sharing an edge (x = 1, y = 1): each closed, the edge used four times.
  const two = cube();
  const b = cube();
  two.p.push(...b.p.map((v, i) => v + (i % 3 === 2 ? 0 : 1)));
  two.t.push(...b.t.map((i) => i + 8));
  assert.equal(run(two), false);
});

test('closesUp: gaps narrower than WIDTH of the size pass (a T-junction, a sliver); wider ones fail', () => {
  // A T-junction: the bottom face's edge 0-1 split at its midpoint (8) on the front face's side only.
  const t = cube();
  t.p.push(0.5, 0, 0);
  // Front face 0,1,5 + 0,5,4 becomes 0,8,5 + 8,1,5 + 0,5,4.
  t.t.splice(12, 3, 0, 8, 5, 8, 1, 5);
  assert.equal(run(t), true);
  // The same, the midpoint off the line by a hair (a sliver of width 1e-6), then by a visible amount.
  const sliver = structuredClone(t);
  sliver.p[3 * 8 + 1] = -1e-6;
  assert.equal(run(sliver), true);
  const notch = structuredClone(t);
  notch.p[3 * 8 + 1] = -0.2;
  assert.equal(run(notch), false);
  // Two faces' corners apart (unwelded: a wedge of a gap two edges long), by 0.1 WIDTH of the size, and by 100.
  const apart = (d: number) => {
    const c = cube();
    c.p.push(1 + d, 1, 1);
    // The top face's triangles use their own copy of corner 6.
    for (let i = 6; i < 12; i++) if (c.t[i] === 6) c.t[i] = 8;
    return run(c);
  };
  assert.equal(apart(0.1 * WIDTH), true);
  assert.equal(apart(100 * WIDTH), false);
});

test('closesUp: a tube open at both ends fails, and three.js\'s, whose unwelded seam makes its openings one loop',
  () => {
    // Faces: the side's 16 quads (corners 0-15 below, 16-31 above), welded; no ends.
    const p: number[] = [], t: number[] = [];
    for (const z of [0, 2]) {
      for (let k = 0; k < 16; k++) p.push(Math.cos(k * Math.PI / 8), Math.sin(k * Math.PI / 8), z);
    }
    for (let k = 0; k < 16; k++) {
      const k1 = (k + 1) % 16;
      t.push(k, k1, 16 + k1, k, 16 + k1, 16 + k);
    }
    assert.equal(run({ p, t }), false);
    assert.equal(closesUp(...mesh(new THREE.CylinderGeometry(1, 1, 2, 16, 1, true))), false);
    // Finely divided: an opening's next edges round are as near as a sliver's sides, but run the same way.
    assert.equal(closesUp(...mesh(new THREE.CylinderGeometry(1, 1, 2, 1000, 1, true))), false);
    // Closed (its seam a sliver 1e-16 wide).
    assert.equal(closesUp(...mesh(new THREE.CylinderGeometry(1, 1, 2, 16, 1, false))), true);
  });

test('closesUp: a sliver along a curved edge passes (opposite sides near, though it winds around)', () => {
  // A closed cylinder (its own, welded), then the top cap's vertices nudged 1e-5 outward: a gap all around the rim.
  const g = new THREE.CylinderGeometry(1, 1, 2, 32, 1, false);
  const [p, t] = mesh(g);
  const torso = 33 * 2;
  for (let i = torso; i < p.length / 3; i++) if (p[3 * i + 1]! > 0) {
    const r = Math.hypot(p[3 * i]!, p[3 * i + 2]!);
    if (r > 0) for (const k of [0, 2]) p[3 * i + k] = p[3 * i + k]! * (1 + 1e-5 / r);
  }
  assert.equal(closesUp(p, t), true);
});

test('closesUp: more boundary edges than MAX_BOUNDARY count as open', () => {
  const g = new THREE.PlaneGeometry(1, 1, MAX_BOUNDARY / 4 + 1, 1);
  const [p, t] = mesh(g);
  // Closed by a copy facing the other way, every vertex its own (each edge a gap of no width, but too many).
  const n = p.length / 3;
  const both = new Float32Array(p.length * 2);
  both.set(p);
  both.set(p, p.length);
  for (let i = 0; i < both.length; i += 3) both[i + 2] = both[i + 2]! + (i < p.length ? 0 : 1e-9);
  const tt = Uint32Array.from([...t, ...Array.from(t, (_, i) => n + t[i - (i % 3) + [0, 2, 1][i % 3]!]!)]);
  assert.equal(closesUp(both, tt), false);
});
