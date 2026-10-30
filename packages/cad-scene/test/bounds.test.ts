import assert from 'node:assert/strict';
import { test } from 'node:test';
import { around, boundScene, boundsFrom, enclose, grow, identity, meshBox, placeSphere, sceneBounds, tessellateScene,
  type Mat4, type Mesh, type Part, type Scene, type Sphere, type TessellationRequest, type TessellationResult,
  type Tessellator, type Vec3 } from '../src/index.ts';

const translate = (x: number, y: number, z: number, s = 1): Mat4 => {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
const mesh = (positions: number[], origin: Vec3 = [0, 0, 0]): Mesh => ({ origin,
  positions: Float32Array.from(positions), indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
  faces: [] });
const part = (o: Partial<Part> = {}): Part => ({ name: 'p', sources: [], properties: {}, unit: 1, origin: [0, 0, 0],
  lods: [], ...o });
// Part 0 placed at the root twice (x 0 and x 100) by component 0; part 1 once in component 1 (y 50), from inches.
function scene(parts: Part[]): Scene {
  return { unit: 'millimetre', materials: [], layers: [], overrides: [], properties: {}, diagnostics: [], parts,
    components: [
      { name: 'a', sources: [], properties: {}, parts: [{ part: 0, transform: identity() },
        { part: 0, transform: translate(100, 0, 0) }], children: [{ component: 1, transform: translate(0, 50, 0),
        sources: [], properties: {} }] },
      { name: 'b', sources: [], properties: {}, parts: [{ part: 1, transform: translate(0, 0, 0, 25.4),
        visible: false }],
        children: [] }],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }] };
}
const holds = (s: Sphere, t: Sphere) => Math.hypot(...[0, 1, 2].map((k) => s.center[k]! - t.center[k]!)) + t.radius
  <= s.radius * (1 + 1e-12);

test('meshBox: everything the mesh draws, in its coordinates; none for nothing drawn', () => {
  const m: Mesh = { ...mesh([0, 0, 0, 1, 0, 0, 0, 2, 0]), curvePositions: Float32Array.of(-5, 0, 0, 0, 0, 1),
    points: Float32Array.of(0, 0, 9), edgePositions: Float32Array.of(0, -3, 0, 0, 0, 0) };
  assert.deepEqual(meshBox(m), { min: [-5, -3, 0], max: [1, 2, 9] });
  // Only failure outlines: nothing drawn.
  assert.equal(meshBox({ ...mesh([]), faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 1, 1),
    faceOutlines: [{ source: 1, start: 0, count: 2 }] }), undefined);
});

test('placeSphere: centre transformed, radius by the largest scale; around a box', () => {
  assert.deepEqual(around({ min: [0, 0, 0], max: [2, 2, 1] }), { center: [1, 1, 0.5], radius: 1.5 });
  const m = translate(10, 0, 0);
  m[5] = 3; // y scaled by 3
  assert.deepEqual(placeSphere({ center: [1, 1, 0], radius: 2 }, m), { center: [11, 3, 0], radius: 6 });
  // Turned 90 degrees about z and scaled by 25.4: the radius by 25.4.
  const r = Float64Array.of(0, 25.4, 0, 0, -25.4, 0, 0, 0, 0, 0, 25.4, 0, 0, 0, 0, 1);
  const p = placeSphere({ center: [1, 0, 0], radius: 1 }, r);
  assert.deepEqual(p.center.map((x) => Math.round(x * 1e9) / 1e9), [0, 25.4, 0]);
  assert.equal(p.radius, 25.4);
});

test('enclose: holds every sphere; two points exactly; grow keeps the centre', () => {
  assert.equal(enclose([]), undefined);
  assert.deepEqual(enclose([{ center: [0, 0, 0], radius: 0 }, { center: [10, 0, 0], radius: 0 }]),
    { center: [5, 0, 0], radius: 5 });
  // One sphere: itself.
  assert.deepEqual(enclose([{ center: [1, 2, 3], radius: 4 }]), { center: [1, 2, 3], radius: 4 });
  // Random spheres: every one inside, and the result no larger than the trivial bound's double.
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 20; n++) {
    const ss = Array.from({ length: 1 + n * 7 }, () => ({ center: [rnd() * 100, rnd() * 50, rnd() * 10] as Vec3,
      radius: rnd() * 5 }));
    const s = enclose(ss)!;
    for (const t of ss) assert.ok(holds(s, t), `n ${n}`);
    assert.ok(s.radius <= Math.hypot(100, 50, 10) + 5);
  }
  // A point outside the first two's diameter grows it (Ritter's second pass).
  const s = enclose([{ center: [0, 0, 0], radius: 0 }, { center: [10, 0, 0], radius: 0 },
    { center: [5, 9, 0], radius: 0 }])!;
  // (From (5, 9), the farthest from the first: centre (2.5, 4.5), then grown for (10, 0) to 6.95.)
  assert.ok(s.radius < 7 && holds(s, { center: [5, 9, 0], radius: 0 }));
  // A square's corners after its centre: from the farthest from the centre, two opposite corners, exactly.
  const sq = enclose([[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => ({ center: [x!, y!, 0] as Vec3,
    radius: 0 })))!;
  assert.equal(sq.radius, Math.SQRT2);
  const g = { center: [0, 0, 0] as Vec3, radius: 1 };
  assert.equal(grow(g, { center: [0.5, 0, 0], radius: 0.5 }), g);
  assert.deepEqual(grow(g, { center: [3, 0, 0], radius: 1 }), { center: [0, 0, 0], radius: 4 });
});

test('sceneBounds: every placement (hidden too), meshes where boxed, else vertex boxes (estimated)', () => {
  // Part 0 a mesh from 0 to 2 on x, its origin 1 on x; part 1 only a B-rep whose vertices span y 0..4 (unit inch).
  const p0 = part({ lods: [{ mesh: mesh([-1, 0, 0, 1, 0, 0, 0, 0, 0], [1, 0, 0]), from: 'source' }] });
  const p1 = part({ unit: 25.4, brep: { format: 'step', payload: () => new Uint8Array(),
    vertexBox: { min: [0, 0, 0], max: [0, 4, 0] } } });
  const s = scene([p0, p1]);
  // No boxes yet: part 0's mesh has none, so only part 1 counts.
  const before = sceneBounds(s)!;
  assert.equal(before.from, 'estimated');
  assert.deepEqual(before.center.map((x) => Math.round(x * 1e9) / 1e9), [0, 50 + 2 * 25.4, 0]);
  boundScene(s);
  assert.deepEqual(p0.lods[0]!.mesh.box, { min: [-1, 0, 0], max: [1, 0, 0] });
  const b = s.bounds!;
  assert.equal(b.from, 'estimated');
  // The two placements of part 0 (x 0..2 and 100..102) and part 1 (hidden; y 50..151.6, x 0).
  for (const t of [{ center: [1, 0, 0], radius: 1 }, { center: [101, 0, 0], radius: 1 },
    { center: [0, 50 + 2 * 25.4, 0], radius: 2 * 25.4 }] as Sphere[]) assert.ok(holds(b, t));
  // Meshes only: part 1 left out, and every placed part's from a mesh.
  const m = sceneBounds(s, { meshesOnly: true })!;
  assert.equal(m.from, 'meshes');
  assert.deepEqual(m.center.map((x) => Math.round(x * 1e6) / 1e6), [51, 0, 0]);
  assert.ok(Math.abs(m.radius - 51) < 1e-9);
  // A file's sphere is kept, though the scene could make one.
  const t = scene([part({ lods: [{ mesh: mesh([0, 0, 0, 5, 0, 0, 0, 5, 0]), from: 'source' }] }), part()]);
  t.bounds = { center: [1, 2, 3], radius: 4, from: 'source' };
  boundScene(t);
  assert.deepEqual(t.bounds, { center: [1, 2, 3], radius: 4, from: 'source' });
  // Nothing to bound: none.
  const u = scene([part(), part()]);
  boundScene(u);
  assert.equal(u.bounds, undefined);
});

test('tessellateScene boxes its meshes (before onPart) and makes the sphere from the meshes', async () => {
  const p0 = part({ brep: { format: 'step', payload: () => new Uint8Array([0]), vertexBox: { min: [0, 0, 0],
    max: [1000, 0, 0] } } });
  // (Part 1 fails; its vertices far off.)
  const p1 = part({ brep: { format: 'step', payload: () => new Uint8Array([1]), vertexBox: { min: [5000, 0, 0],
    max: [5000, 0, 0] } } });
  const s = scene([p0, p1]);
  boundScene(s);
  assert.ok(s.bounds!.radius > 2500);
  const t: Tessellator = {
    info: { name: 'fake', version: '1', license: 'x', formats: ['step'], supportsFaceIds: true, supportsEdges: false,
      supportsCurves: false },
    async init() {}, dispose() {},
    async tessellate(req: TessellationRequest): Promise<TessellationResult> {
      // Part 1 fails.
      if (req.data[0] === 1) throw new Error('no');
      return { origin: req.origin!, positions: Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 0),
        indices: Uint32Array.of(0, 1, 2), faces: [], diagnostics: [] };
    },
  };
  const seen: (Mesh | undefined)[] = [];
  await tessellateScene(s, t, { onPart: (_i, m) => seen.push(m) });
  assert.deepEqual(seen.filter(Boolean).map((m) => m!.box), [{ min: [0, 0, 0], max: [2, 2, 0] }]);
  // Shrunk from the vertex estimate to the meshes' (part 0's two placements, x 0..102); part 1 failed, left out.
  assert.equal(s.bounds!.from, 'meshes');
  assert.ok(s.bounds!.radius < 60 && holds(s.bounds!, { center: [101, 1, 0], radius: Math.SQRT2 }));
  // A file's sphere stays.
  const u = scene([part({ brep: { format: 'step', payload: () => new Uint8Array([0]) } }), part()]);
  u.bounds = { center: [0, 0, 0], radius: 1, from: 'source' };
  await tessellateScene(u, t);
  assert.deepEqual(u.bounds, { center: [0, 0, 0], radius: 1, from: 'source' });
});

test('boundsFrom: a centre of three finite numbers and a finite radius at least 0, else none', () => {
  assert.deepEqual(boundsFrom({ center: [1, 2, 3], radius: 0 }), { center: [1, 2, 3], radius: 0, from: 'source' });
  for (const j of [{ center: [1, 2, 3], radius: -1 }, { center: [1, 2, 3], radius: NaN },
    { center: [1, 2, 3], radius: Infinity }, { center: [1, 2, 3], radius: '4' }, { center: [1, 2], radius: 4 },
    { center: [1, 2, NaN], radius: 4 }, [1, 2, 3, 4], null, 'x']) assert.equal(boundsFrom(j), undefined);
});
