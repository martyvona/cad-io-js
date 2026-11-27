import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrepData, BrepBuilder } from 'cad-brep';
import { chordBulge, newBulgeCache } from '../src/bulge.ts';
import { badFaces } from '../src/fallback.ts';
import { BULGE_FACTOR, EXCESS_FRACTION, faceFailures } from '../src/mesh.ts';
import type { Mesh } from '../src/index.ts';

const N = 16, R = 5;
const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

/** Body `b` a sheet of `faces`. */
function sheet(b: BrepBuilder, faces: number[]): BrepData {
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: faces.map((face) => ({ face, sense: true })) }), sense: true }] }) });
  return b.finish();
}

/** Face 10: the square [-10, 10]^2 on z = 0 with a hole of radius R at the origin (its edge the whole circle). */
function plate(): BrepData {
  const b = new BrepBuilder();
  const c = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y]) => b.addVertex({ point: [x!, y!, 0] }));
  const at = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const sides = [0, 1, 2, 3].map((k) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: [...at[k]!, 0],
    direction: [(at[(k + 1) % 4]![0]! - at[k]![0]!) / 20, (at[(k + 1) % 4]![1]! - at[k]![1]!) / 20, 0],
    magnitude: 1 }),
  start: c[k]!, end: c[(k + 1) % 4]!, sameSense: true, id: 1 + k }));
  const v = b.addVertex({ point: [R, 0, 0] });
  const hole = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius: R }), start: v, end: v,
    sameSense: true, id: 5 });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 10, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: sides.map((edge) => ({ edge, orientation: 'forward' })) },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: hole, orientation: 'reversed' }] }] });
  return sheet(b, [face]);
}

/**
 * The plate's mesh: the hole's polygon of N sides (corners on the circle) joined to the points where the same rays
 * meet the square (its corners among them, at 45 degrees), a quad per ray step in two triangles, under `source`;
 * positions minus `origin`.
 */
function plateMesh(origin: [number, number, number] = [0, 0, 0], source = 10): Mesh {
  const pos: number[] = [], ix: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N, c = Math.cos(a), s = Math.sin(a), out = 10 / Math.max(Math.abs(c), Math.abs(s));
    pos.push(R * c - origin[0], R * s - origin[1], -origin[2], out * c - origin[0], out * s - origin[1], -origin[2]);
  }
  for (let k = 0; k < N; k++) {
    const h = 2 * k, o = 2 * k + 1, h1 = 2 * ((k + 1) % N), o1 = h1 + 1;
    ix.push(h, o, o1, h, o1, h1);
  }
  return { origin, positions: Float32Array.from(pos), indices: Uint32Array.from(ix),
    faces: [{ source, start: 0, count: ix.length }] };
}

/** The hole's segments between chords and circle: the circle's area less its polygon's. */
const SEGMENTS = Math.PI * R * R - N / 2 * R * R * Math.sin(2 * Math.PI / N);

test('chordBulge: a hole\'s chords cut into it by the segments between them and the circle; lines add nothing', () => {
  const d = plate();
  const b = chordBulge(d, plateMesh(), 10)!;
  // Simpson's rule on the circle's offsets, within a percent of the exact segments (2.003 mm^2).
  assert.ok(Math.abs(b - SEGMENTS) < 0.01 * SEGMENTS, `${b} against ${SEGMENTS}`);
  // The mesh is over the face's area by exactly that much: the bulge is what a sound mesh may gain.
  const polygon = N / 2 * R * R * Math.sin(2 * Math.PI / N);
  assert.ok(Math.abs((400 - polygon) - (400 - Math.PI * R * R) - SEGMENTS) < 1e-9);
  // Positions minus an origin far off, and with one cache for several calls: the same.
  const cache = newBulgeCache(d);
  const far = chordBulge(d, plateMesh([1000, -2000, 50]), 10, cache)!;
  assert.ok(Math.abs(far - b) < 1e-3 * b, `${far} against ${b}`);
  assert.equal(chordBulge(d, plateMesh(), 10, cache), chordBulge(d, plateMesh(), 10, cache));
  // Only the face's own ranges count: another face's triangles beside them change nothing.
  const m = plateMesh(), other = plateMesh([0, 0, -1], 11);
  const both: Mesh = { origin: [0, 0, 0], positions: Float32Array.from([...m.positions, ...other.positions]),
    indices: Uint32Array.from([...m.indices, ...Array.from(other.indices, (i) => i + 2 * N)]),
    faces: [m.faces[0]!, { source: 11, start: m.indices.length, count: other.indices.length }] };
  assert.equal(chordBulge(d, both, 10), b);
  // A face the model doesn't have; a face with no triangles in the mesh: nothing to measure against, or nothing.
  assert.equal(chordBulge(d, plateMesh(), 99), undefined);
  assert.equal(chordBulge(d, { ...plateMesh(), faces: [] }, 10), 0);
});

/** Face 20: the cylinder of radius R about z from z = 0 to 10, bounded by its two circles and a seam. */
function tube(): BrepData {
  const b = new BrepBuilder();
  const top = { ...XY, origin: [0, 0, 10] };
  const v0 = b.addVertex({ point: [R, 0, 0] }), v1 = b.addVertex({ point: [R, 0, 10] });
  const bottom = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius: R }), start: v0, end: v0,
    sameSense: true, id: 1 });
  const upper = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: top, radius: R }), start: v1, end: v1,
    sameSense: true, id: 2 });
  const seam = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [R, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
    start: v0, end: v1, sameSense: true, id: 3 });
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: XY, radius: R }), sameSense: true,
    id: 20, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: bottom, orientation: 'forward' },
      { edge: seam, orientation: 'forward' }, { edge: upper, orientation: 'reversed' },
      { edge: seam, orientation: 'reversed' }] }] });
  return sheet(b, [face]);
}

test('chordBulge: a chord\'s sag into the surface moves no area past the boundary (a cylinder\'s end circles)', () => {
  // The tube in N facets around, one row along: each end's chord sags R (1 - cos(pi / N)) into the cylinder, which
  // the whole offset would count as about 2/3 L s per chord (4.0 mm^2 in all); across the chord within the surface
  // the circle doesn't move. The seam's sides are used twice (welded), so they aren't boundary.
  const pos: number[] = [], ix: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N;
    pos.push(R * Math.cos(a), R * Math.sin(a), 0, R * Math.cos(a), R * Math.sin(a), 10);
  }
  for (let k = 0; k < N; k++) {
    const b0 = 2 * k, t0 = b0 + 1, b1 = 2 * ((k + 1) % N), t1 = b1 + 1;
    ix.push(b0, b1, t1, b0, t1, t0);
  }
  const mesh: Mesh = { origin: [0, 0, 0], positions: Float32Array.from(pos), indices: Uint32Array.from(ix),
    faces: [{ source: 20, start: 0, count: ix.length }] };
  const L = 2 * R * Math.sin(Math.PI / N), s = R * (1 - Math.cos(Math.PI / N)), whole = 2 * N * 2 / 3 * L * s;
  const b = chordBulge(tube(), mesh, 20)!;
  assert.ok(b >= 0 && b < 1e-3 * whole, `${b} against ${whole}`);
});

test('faceFailures\' excessSlack: over its area within d x P, judged against BULGE_FACTOR times the bulge', () => {
  // A square 10 x 10 meshed at 100 against a measured area under it; perimeter 400 and deflection 0.1 make d x P
  // (40) larger than any excess here, so without a bulge none is flagged.
  const mesh: Mesh = { origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3), faces: [{ source: 1, start: 0, count: 6 }] };
  const asked: number[] = [];
  const judge = (area: number, bulge: number | undefined, uses = 1, perimeter = 400) => faceFailures(mesh, {
    measured: { deflection: 0.1, measures: { by: 'test', faces: new Map([[1, { area, perimeter, valid: true,
      ...(uses > 1 ? { uses } : {}) }]]) }, excessSlack: (s) => (asked.push(s), bulge) } }).get(1);
  // 80 is 25 % under the mesh's 100: over by 20.
  assert.equal(judge(80, undefined), undefined);
  assert.equal(judge(80, 20 / BULGE_FACTOR + 0.01), undefined);
  assert.equal(judge(80, 20 / BULGE_FACTOR - 0.01), 'excess');
  assert.equal(judge(80, 0), 'excess');
  assert.deepEqual(asked, [1, 1, 1, 1]);
  // Within EXCESS_FRACTION it's not asked; past d x P it's not asked (excess whatever the bulge).
  asked.length = 0;
  assert.equal(judge(100 / (1 + EXCESS_FRACTION) + 0.01, 0), undefined);
  assert.equal(judge(50, 1000, 1, 100), 'excess');
  assert.deepEqual(asked, []);
  // A face used by two shells keeps d x P (its bulge is of one use's ranges).
  const twice: Mesh = { ...mesh, faces: [mesh.faces[0]!, mesh.faces[0]!] };
  assert.equal(faceFailures(twice, { measured: { deflection: 0.1, measures: { by: 'test', faces: new Map([[1,
    { area: 80, perimeter: 400, valid: true, uses: 2 }]]) }, excessSlack: () => 0 } }).get(1), undefined);
});

test('badFaces judges a face over its area by its chords\' bulge where the model lets it be measured', () => {
  // The plate with its square's ring of points lifted 3.5 out of the plane: its facets tilt, the mesh 18 % (57 mm^2)
  // over the face's area. At a deflection of 1, d x P (111 mm^2) hides that; the hole's bulge (2 mm^2) doesn't.
  const d = plate(), m = plateMesh();
  const positions = Float32Array.from(m.positions, (x, i) => (i % 6 === 5 ? 3.5 : x));
  const r = { origin: m.origin, positions, indices: m.indices, faces: [{ entityId: 10, start: 0,
    count: m.indices.length }], diagnostics: [] } as never;
  assert.equal(badFaces(r, d, 1).get(10), 'excess');
  // Without a model there's no bulge to measure: d x P judges it, as before.
  const oracle = [{ entityId: 10, area: 400 - Math.PI * R * R, perimeter: 80 + 2 * Math.PI * R }];
  assert.equal(badFaces({ ...(r as object), oracle } as never, undefined, 1).get(10), undefined);
  // Flat, the same mesh is over by the bulge alone.
  assert.equal(badFaces({ ...(r as object), positions: m.positions } as never, d, 1).get(10), undefined);
});
