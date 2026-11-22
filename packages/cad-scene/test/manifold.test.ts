import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { FallbackTessellator, judgeResult, notManifoldCount, notManifoldDiagnostic, notManifoldMessage, reported,
  shellDefects, shellsManifold, tessellateScene, type Scene, type TessellationResult, type Tessellator }
  from '../src/index.ts';

const d = cube().finish();
/** The cube's faces (cad-brep's test cube): 21 the bottom (z 0), 22 the top, 23 to 26 the sides. */
const PRISTINE = { shells: 1, open: 0, misoriented: 0, nonManifold: 0, vertices: 0, faces: [],
  facesBy: { open: [], edges: [], vertices: [] } };

/** `r` with face `id`'s triangles wound the other way. */
function flipped(r: TessellationResult, id: number): TessellationResult {
  const f = r.faces.find((x) => x.entityId === id)!;
  const indices = Uint32Array.from(r.indices);
  for (let t = f.start; t < f.start + f.count; t += 3)
    [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!];
  return { ...r, indices };
}

test('manifold: the cube meshed face by face, its faces sharing positions only, is closed and oriented', () => {
  assert.deepEqual(shellDefects(d, quads(d)), PRISTINE);
  assert.equal(notManifoldDiagnostic(d, quads(d)), undefined);
  // A scene mesh's faces name theirs as `source`: the same verdict.
  const r = quads(d);
  const mesh = { positions: r.positions, indices: r.indices, faces: r.faces.map((f) => ({ source: f.entityId,
    start: f.start, count: f.count })) };
  assert.deepEqual(shellDefects(d, mesh), PRISTINE);
});

test('manifold: a face wound against its neighbours: its four sides used twice the same way, it named first', () => {
  const x = shellDefects(d, flipped(quads(d), 21));
  // (Its diagonal is its own two triangles', still once each way; each side's other use is a neighbour's.)
  assert.deepEqual([x.open, x.misoriented, x.nonManifold], [0, 4, 0]);
  // Its four corners' fans don't close either.
  assert.equal(x.vertices, 4);
  assert.deepEqual(x.facesBy.edges, [[21, 4], [23, 1], [24, 1], [25, 1], [26, 1]]);
  assert.ok(!shellsManifold(x));
  // Reported: the edges; its corners aren't told again.
  const msg = 'not a closed, oriented manifold over its closed shells: 4 mesh edges (4 used twice the same way); '
    + 'faces #21, #23, #24, #25, #26';
  assert.deepEqual(notManifoldDiagnostic(d, flipped(quads(d), 21)), { severity: 'error', message: msg });
  assert.equal(notManifoldCount([{ severity: 'error', message: msg }]), 4);
  assert.equal(notManifoldCount([{ severity: 'warning', message: msg }]), 0);
});

test('manifold: a face meshed twice (the model using it once): every one of its edges used more than twice', () => {
  const r = quads(d);
  const twice = { ...r, faces: [...r.faces, { ...r.faces.find((f) => f.entityId === 22)! }] };
  const x = shellDefects(d, twice);
  // Its four sides three times each, its diagonal four times (twice each way).
  assert.deepEqual([x.open, x.misoriented, x.nonManifold], [0, 0, 5]);
  // The model using it twice (another use of its row): each use's mesh once, its exact repeats one.
  const row = [...d.face.id].indexOf(22);
  const doubled = { ...d, faceUse: { ...d.faceUse, face: Int32Array.from([...d.faceUse.face, row]) } };
  assert.deepEqual(shellDefects(doubled as typeof d, twice), PRISTINE);
});

test('manifold: a mesh open along an edge: used once there, told unless the open edges are said already', () => {
  // Face 24's first corner moved in its own mesh alone: its two sides there, and their copies in 21 and 25, once each.
  const x = shellDefects(d, quads(d, { face: 24, corner: 0, by: [0, 0, 1e-3] }));
  assert.deepEqual([x.open, x.misoriented, x.nonManifold], [4, 0, 0]);
  assert.deepEqual(x.facesBy.open, [[24, 2], [21, 1], [25, 1]]);
  const said = reported(x, false), quiet = reported(x, true);
  assert.deepEqual([said.open, said.vertices, said.faces], [4, 0, [[24, 2], [21, 1], [25, 1]]]);
  assert.deepEqual([quiet.open, quiet.vertices, quiet.faces], [0, 0, []]);
  assert.ok(shellsManifold(quiet));
  assert.equal(notManifoldMessage(said), 'not a closed, oriented manifold over its closed shells: 4 mesh edges '
    + '(4 used once); faces #24, #21, #25');
});

test('manifold: closed shells only, judged whole: one with a face without triangles isn\'t (open by design)', () => {
  const r = quads(d, { face: 24, corner: 0, by: [0, 0, 1e-3] });
  const without = { ...r, faces: r.faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f)) };
  assert.deepEqual(shellDefects(d, without), { ...PRISTINE, shells: 0 });
  assert.deepEqual(shellDefects(d, { ...r, faces: r.faces.filter((f) => f.entityId !== 23) }).shells, 0);
  // An open shell (the cube's said open) isn't judged, its gap there or not.
  const sheet = { ...d, shell: { ...d.shell, kind: Uint8Array.from(d.shell.kind, () => 2) } };
  assert.deepEqual(shellDefects(sheet as typeof d, r), { ...PRISTINE, shells: 0 });
});

test('manifold: degenerate triangles (two corners at one position) aren\'t judged (dropDegenerate drops them)',
  () => {
  const r = quads(d);
  const f = r.faces.find((x) => x.entityId === 21)!;
  // A triangle of face 21's first two corners and a copy of the first (its own index, the same position).
  const a = r.indices[f.start]!, b = r.indices[f.start + 1]!;
  const positions = Float32Array.from([...r.positions, ...r.positions.subarray(3 * a, 3 * a + 3)]);
  const copy = positions.length / 3 - 1;
  const indices = Uint32Array.from([...r.indices.subarray(0, f.start + f.count), a, b, copy,
    ...r.indices.subarray(f.start + f.count)]);
  const faces = r.faces.map((x) => (x.entityId === 21 ? { ...x, count: x.count + 3 }
    : x.start > f.start ? { ...x, start: x.start + 3 } : x));
  assert.deepEqual(shellDefects(d, { ...r, positions, indices, faces }), PRISTINE);
});

test('manifold: a vertex where two closed fans touch, every edge sound: told by its vertex alone', () => {
  // Each face's triangles a closed tetrahedron of its own (the check reads the mesh, not the faces' shapes): 21's
  // from the origin into x, y, z >= 0, 22's its reflection through the origin (wound the other way, so outward too),
  // sharing only the origin; 23 to 26 apart. Every edge once each way; the origin's triangles two fans.
  const A = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const OUT = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  const positions: number[] = [], indices: number[] = [], faces: TessellationResult['faces'] = [];
  const add = (id: number, corners: number[][], winding: number[]) => {
    const base = positions.length / 3;
    for (const c of corners) positions.push(...c);
    faces.push({ entityId: id, start: indices.length, count: winding.length });
    indices.push(...winding.map((k) => base + k));
  };
  add(21, A, OUT);
  // (Reflected: the same triangles, each wound the other way; its first corner the origin again, a copy of 21's.)
  add(22, A.map((c) => c.map((x) => -x)), OUT.map((_, k) => OUT[k - (k % 3) + [0, 2, 1][k % 3]!]!));
  for (const id of [23, 24, 25, 26]) add(id, A.map((c) => [c[0]! + 3 * id, c[1]!, c[2]!]), OUT);
  const x = shellDefects(d, { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces });
  assert.deepEqual([x.open, x.misoriented, x.nonManifold, x.vertices], [0, 0, 0, 1]);
  assert.deepEqual(x.facesBy.vertices, [[21, 3], [22, 3]]);
  const msg = notManifoldMessage(reported(x, false));
  assert.equal(msg, 'not a closed, oriented manifold over its closed shells: 1 vertex whose triangles aren\'t one '
    + 'fan; faces #21, #22');
  assert.equal(notManifoldCount([{ severity: 'error', message: msg }]), 1);
});

/** A one-part scene of the cube. */
const scene = (): Scene => ({ unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [],
  properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {},
    origin: [0, 0, 0], lods: [], brep: { format: 'step', model: d } }] });
/** A backend answering every request with `r`. */
function backend(r: TessellationResult, name = 'fake'): Tessellator & { asked: number } {
  const t: Tessellator & { asked: number } = { asked: 0,
    info: { name, version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true, supportsEdges: true,
      supportsCurves: false },
    init: async () => {},
    tessellate: async () => { t.asked++; return { ...r, diagnostics: [] }; },
    dispose: () => {} };
  return t;
}

test('tessellateScene: an error where a part\'s mesh, as kept, isn\'t a closed, oriented manifold; manifold: false '
  + 'none', async () => {
  const bad = flipped(quads(d), 21);
  const msg = 'not a closed, oriented manifold over its closed shells: 4 mesh edges (4 used twice the same way); '
    + 'faces #21, #23, #24, #25, #26';
  const opts = { measures: false, join: false, fill: false, orient: false, linearDeflection: 0.1 };
  const r = await tessellateScene(scene(), backend(bad), opts);
  assert.deepEqual(r.diagnostics, [{ severity: 'error', message: msg, source: { format: 'step', id: 7 } }]);
  assert.deepEqual((await tessellateScene(scene(), backend(quads(d)), opts)).diagnostics, []);
  assert.deepEqual((await tessellateScene(scene(), backend(bad), { ...opts, manifold: false })).diagnostics, []);
});

test('fallback: a primary whose mesh isn\'t an oriented manifold falls back, judged so whatever it says', async () => {
  const bad = flipped(quads(d), 21);
  const v = judgeResult(bad, d, 0.1);
  assert.deepEqual([v.ok, v.rank], [false, [0, 0, 0, 0, 4, 0]]);
  assert.match(v.problems[0]!, /^not a closed, oriented manifold over its closed shells: 4 mesh edges/);
  const a = backend(bad, 'a'), b = backend(quads(d), 'b');
  const t = new FallbackTessellator(a, b, { perFace: false, join: false, fill: false, orient: false });
  const r = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer), origin: [0, 0, 0],
    linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.equal(b.asked, 1);
  assert.equal(r.backend, 'b 1');
});
