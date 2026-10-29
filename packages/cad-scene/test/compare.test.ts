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
});
