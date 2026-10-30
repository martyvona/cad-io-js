import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLod, exportView, identity, viewDifferences, type Mat4, type Mesh, type Scene } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
const tri = (): Mesh => ({ origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
  indices: Uint32Array.of(0, 1, 2), faces: [{ source: 5, start: 0, count: 3 }],
  edgePositions: Float32Array.of(0, 0, 0, 1, 0, 0), edges: [{ source: 6, start: 0, count: 2, kind: 'free' }] });
const scene = (mesh = tri(), origin: [number, number, number] = [0, 0, 0]): Scene => {
  const s: Scene = { unit: 'millimetre', layers: [], overrides: [], properties: {}, diagnostics: [],
    materials: [{ color: [1, 0, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    components: [{ name: 'c', sources: [], properties: {}, parts: [{ part: 0, transform: translation(...origin) }],
      children: [] }],
    roots: [{ component: 0, transform: translation(10, 0, 0), sources: [], properties: {} }],
    parts: [{ name: 'p', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [], material: 0 }] };
  addLod(s.parts[0]!, { mesh, from: 'source' });
  return s;
};
const of = (s: Scene) => ({ scene: s, view: exportView(s, { edges: true }) });

test('viewDifferences: none for the same drawing however said; each kind of difference found', () => {
  assert.deepEqual(viewDifferences(of(scene()), of(scene())), []);
  // The same triangle with its origin in the mesh rather than the transform, its corners in another order, the
  // colour by override: the same drawing.
  const moved = tri();
  moved.origin = [1, 0, 0];
  moved.positions = Float32Array.of(-1, 0, 0, 0, 0, 0, -1, 1, 0);
  moved.indices = Uint32Array.of(1, 2, 0);
  moved.edgePositions = Float32Array.of(-1, 0, 0, 0, 0, 0);
  const same = scene(moved);
  same.parts[0]!.material = 1;
  same.overrides.push({ path: [0], ref: 0, material: 0, sources: [] });
  assert.deepEqual(viewDifferences(of(scene()), of(same)), []);
  // A vertex moved, another colour, hidden, another face id, no edge.
  const diff = (change: (s: Scene) => void) => { const s = scene(); change(s); return viewDifferences(of(scene()),
    of(s)); };
  const one = (d: string[], pattern: RegExp) => d.length === 1 && pattern.test(d[0]!);
  assert.ok(one(diff((s) => { s.parts[0]!.lods[0]!.mesh.positions[3] = 1.01; }), /triangles/));
  assert.ok(one(diff((s) => { s.parts[0]!.material = 1; }), /triangles/));
  assert.ok(one(diff((s) => { s.overrides.push({ path: [0], visible: false, sources: [] }); }), /visible true/));
  assert.ok(one(diff((s) => { s.parts[0]!.lods[0]!.mesh.faces[0]!.source = 9; }), /triangles/));
  assert.ok(one(diff((s) => { s.parts[0]!.lods[0]!.mesh.edges = []; }), /lines/));
  const has = (d: string[], pattern: RegExp) => d.some((x) => pattern.test(x));
  const renamed = diff((s) => { s.components[0]!.name = 'd'; });
  assert.ok(has(renamed, /\/c\): missing/) && has(renamed, /\/d: 1 placed parts only in the second/), renamed.join());
  const extra = diff((s) => { s.components[0]!.parts.push({ part: 0, transform: identity() }); });
  assert.ok(has(extra, /1 placed parts against 2/) && has(extra, /\/c: 1 placed parts more/), extra.join());
  // Within a tolerance: a step of 0.01 mm passes at 0.05 mm (a lossy codec's), not at the default.
  const near = scene();
  near.parts[0]!.lods[0]!.mesh.positions[3] = 1.01;
  assert.equal(viewDifferences(of(scene()), of(near), { tolerance: 0.05 }).length, 0);
  // For a format without faces or lines (3MF): face ids, or edges, curves and points, left out on request; a
  // colour or a vertex still counts.
  const refaced = diff((s) => { s.parts[0]!.lods[0]!.mesh.faces[0]!.source = 9; });
  assert.ok(one(refaced, /triangles/));
  const unlined = scene();
  unlined.parts[0]!.lods[0]!.mesh.edges = [];
  unlined.parts[0]!.lods[0]!.mesh.faces[0]!.source = 9;
  assert.equal(viewDifferences(of(scene()), of(unlined)).length, 2);
  assert.deepEqual(viewDifferences(of(scene()), of(unlined), { faceIds: false, lines: false }), []);
  assert.equal(viewDifferences(of(scene()), of(unlined), { faceIds: false }).length, 1);
  assert.equal(viewDifferences(of(scene()), of(unlined), { lines: false }).length, 1);
  unlined.parts[0]!.material = 1;
  assert.ok(one(viewDifferences(of(scene()), of(unlined), { faceIds: false, lines: false }), /triangles/));
});

test('viewDifferences: a triangle with two corners within the tolerance, unmatched, is no difference', () => {
  // The triangle, and another along its edge from (0, 0) to (1, 0) with its third corner at `y` (in the mesh, so
  // 10 mm on in the world).
  const extra = (y: number, x = 1) => {
    const m = tri();
    m.positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, x, y, 0);
    m.indices = Uint32Array.of(0, 1, 2, 0, 1, 3);
    m.faces[0]!.count = 6;
    return scene(m);
  };
  assert.deepEqual(viewDifferences(of(scene()), of(extra(5e-5))), []);
  assert.deepEqual(viewDifferences(of(extra(5e-5)), of(scene())), []);
  // (Its third corner near its first.)
  assert.deepEqual(viewDifferences(of(scene()), of(extra(5e-5, 0))), []);
  assert.equal(viewDifferences(of(scene()), of(extra(0.01))).length, 1);
  assert.deepEqual(viewDifferences(of(scene()), of(extra(0.01)), { tolerance: 0.05 }), []);
  // A sliver: three corners on a line, none near another, is drawn (as a line, at least): still a difference.
  assert.equal(viewDifferences(of(scene()), of(extra(0, 0.5))).length, 1);
});
