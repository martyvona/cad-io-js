import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropDegenerate, faceFailures, INSIDE_OUT, manifoldProblems, orientShells,
  tessellateScene, weld, type FaceMeasures, type Mesh, type Scene, type TessellationRequest, type TessellationResult,
  type Tessellator } from '../src/index.ts';

// A box's corners and faces, each counter-clockwise seen from outside.
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const QUADS = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
const OUTWARD = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];

interface Box { lo?: number[]; size?: number; turned?: boolean; normals?: 'outward' | 'winding'; open?: boolean }
/**
 * Boxes as a tessellator gives them: each face with four vertices of its own and its normal. `turned`: wound
 * inward; `normals`: outward (as the file's own, for a tessellated part) or following the winding (as OCCT's);
 * `open`: without its top face.
 */
function boxes(...specs: Box[]): Mesh {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const faces: Mesh['faces'] = [];
  for (const b of specs) {
    const lo = b.lo ?? [0, 0, 0], size = b.size ?? 1;
    QUADS.forEach((q, f) => {
      if (b.open && f === 1) return;
      const base = positions.length / 3;
      const n = b.turned && b.normals === 'winding' ? OUTWARD[f]!.map((x) => -x) : OUTWARD[f]!;
      for (const c of q) { positions.push(...CORNERS[c]!.map((x, k) => lo[k]! + x * size)); normals.push(...n); }
      const start = indices.length;
      for (const t of [[0, 1, 2], [0, 2, 3]]) indices.push(
        ...(b.turned ? [t[0]!, t[2]!, t[1]!] : t).map((k) => base + k));
      faces.push({ source: faces.length, start, count: 6 });
    });
  }
  return { origin: [0, 0, 0], positions: Float32Array.from(positions), normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices), faces };
}
/** The welded mesh's problems, as 3MF's check sees them. */
function problems(m: Mesh): string[] {
  const w = weld(m.positions);
  return manifoldProblems(w.positions, Uint32Array.from(m.indices, (v) => w.remap[v]!));
}
/** Per triangle, whether its vertex normals point the way its winding does. */
function normalsFollowWinding(m: Mesh): boolean[] {
  const p = m.positions, n = m.normals!, out: boolean[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const u = [0, 1, 2].map((k) => p[3 * b + k]! - p[3 * a + k]!),
      w = [0, 1, 2].map((k) => p[3 * c + k]! - p[3 * a + k]!);
    const g = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    out.push(g.reduce((s, x, k) => s + x * n[3 * a + k]!, 0) > 0);
  }
  return out;
}

test('orientShells: an inside-out box turned over, its normals too when they followed the winding', () => {
  const plain = boxes({});
  assert.deepEqual(orientShells(plain), { mesh: plain, turned: 0 });
  // As OCCT meshes a surface model whose shell faces inward: normals with the winding.
  const occt = boxes({ turned: true, normals: 'winding' });
  assert.deepEqual(problems(occt), [INSIDE_OUT]);
  const r = orientShells(occt);
  assert.equal(r.turned, 1);
  assert.deepEqual(problems(r.mesh), []);
  assert.ok(normalsFollowWinding(r.mesh).every((x) => x));
  assert.deepEqual(Array.from(r.mesh.normals!), Array.from(plain.normals!));
  // The input is left as it was; positions and faces are shared.
  assert.deepEqual(problems(occt), [INSIDE_OUT]);
  assert.equal(r.mesh.positions, occt.positions);
  assert.equal(r.mesh.faces, occt.faces);
  // As a tessellated part whose triangles face inward but whose normals point out: the normals stay.
  const tessellated = boxes({ turned: true, normals: 'outward' });
  const t = orientShells(tessellated);
  assert.equal(t.turned, 1);
  assert.deepEqual(problems(t.mesh), []);
  assert.deepEqual(Array.from(t.mesh.normals!), Array.from(tessellated.normals!));
  // No normals at all.
  const bare = { ...boxes({ turned: true }) };
  delete bare.normals;
  const b = orientShells(bare);
  assert.deepEqual([b.turned, b.mesh.normals, problems(b.mesh)], [1, undefined, []]);
});

test('orientShells: voids stay inward; only shells no other encloses are turned', () => {
  // A solid with two voids: inward boxes inside an outward one. Nothing to do.
  const voids = boxes({ size: 10 }, { lo: [2, 2, 2], size: 2, turned: true, normals: 'winding' },
    { lo: [6, 5, 4], size: 3, turned: true, normals: 'winding' });
  assert.deepEqual(problems(voids), []);
  assert.equal(orientShells(voids).turned, 0);
  // All of it inside out: the outer shell is turned, the inner ones (now right as voids) left.
  const inverted = boxes({ size: 10, turned: true, normals: 'winding' }, { lo: [2, 2, 2], size: 2 },
    { lo: [6, 5, 4], size: 3 });
  const r = orientShells(inverted);
  assert.equal(r.turned, 1);
  assert.deepEqual(problems(r.mesh), []);
  assert.deepEqual(Array.from(r.mesh.indices.subarray(36)), Array.from(inverted.indices.subarray(36)));
  // Two separate bodies, one inside out: that one turned, the other untouched.
  const two = boxes({}, { lo: [5, 0, 0], turned: true, normals: 'winding' });
  const s = orientShells(two);
  assert.equal(s.turned, 1);
  assert.deepEqual(Array.from(s.mesh.indices.subarray(0, 36)), Array.from(two.indices.subarray(0, 36)));
  assert.deepEqual(problems(s.mesh), []);
  // An inward box inside an outer shell that is open: maybe a void of a solid meshed with a gap, so left.
  const gap = boxes({ size: 10, open: true }, { lo: [2, 2, 2], size: 2, turned: true, normals: 'winding' });
  assert.equal(orientShells(gap).turned, 0);
  // Beside an open shell that doesn't contain it: turned.
  const beside = boxes({ size: 10, open: true }, { lo: [20, 2, 2], size: 2, turned: true, normals: 'winding' });
  assert.equal(orientShells(beside).turned, 1);
  // A degenerate triangle (two corners at one place) touching both of two separate boxes doesn't join them.
  const bridged = boxes({}, { lo: [5, 0, 0], turned: true, normals: 'winding' });
  const bp = Float32Array.from([...bridged.positions, 0, 0, 0]);
  const bridge: Mesh = { ...bridged, positions: bp, normals: Float32Array.from([...bridged.normals!, 0, 0, 1]),
    indices: Uint32Array.from([...bridged.indices, 0, bp.length / 3 - 1, 24]) };
  assert.equal(orientShells(bridge).turned, 1);
  // An open shell facing inward isn't closed, so has no inside to turn out.
  assert.equal(orientShells(boxes({ turned: true, open: true, normals: 'winding' })).turned, 0);
});

/** Each face's triangles, as corner triples. */
function faceTriangles(m: Mesh): number[][][] {
  return m.faces.map((f) => Array.from({ length: f.count / 3 },
    (_, k) => Array.from(m.indices.subarray(f.start + 3 * k, f.start + 3 * k + 3))));
}

test('dropDegenerate: triangles with two corners at one position go, slivers and the rest stay, faces follow', () => {
  const box = boxes({});
  assert.equal(dropDegenerate(box).mesh, box);
  // Extra vertices: one at corner 0's position with -0s, one in the middle of the bottom's edge 0-1.
  const positions = Float32Array.from([...box.positions, -0, -0, 0, 0.5, 0, 0]);
  const zero = positions.length / 3 - 2, mid = zero + 1;
  // Into face 0 (the bottom): triangles through the twin of vertex 0 (its first and third corners at one place),
  // using a vertex twice (first and second), and with its second and third at one place; then a sliver on the
  // edge 0-1 (three positions on a line). Faces listed out of order.
  const extra = [[0, 2, zero], [1, 1, 3], [2, 0, zero], [0, mid, 1]];
  const indices = [...box.indices.subarray(0, 6), ...extra.flat(), ...box.indices.subarray(6)];
  const faces = box.faces.map((f, k) => (k ? { ...f, start: f.start + 12 } : { ...f, count: 18 })).reverse();
  const mesh: Mesh = { ...box, positions, normals: Float32Array.from([...box.normals!, 0, 0, -1, 0, 0, -1]),
    indices: Uint32Array.from(indices), faces };
  const r = dropDegenerate(mesh);
  assert.equal(r.dropped, 3);
  assert.equal(r.mesh.positions, mesh.positions);
  assert.equal(r.mesh.normals, mesh.normals);
  assert.equal(r.mesh.indices.length, indices.length - 9);
  assert.deepEqual(r.mesh.faces.map((f) => f.source), faces.map((f) => f.source));
  const expected = faceTriangles(mesh).map(
    (ts) => ts.filter((t) => !extra.slice(0, 3).some((x) => x.join() === t.join())));
  assert.deepEqual(faceTriangles(r.mesh), expected);
  let at = 0;
  for (const f of r.mesh.faces) { assert.equal(f.start, at); at += f.count; }
  assert.equal(at, r.mesh.indices.length);
  // A face of nothing but degenerate triangles keeps its entry, empty (judged by the part's measures, where it has
  // them: faceFailures); a mesh without faces loses them too.
  const flat: Mesh = { origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0),
    indices: Uint32Array.of(0, 1, 2, 1, 3, 2),
    faces: [{ source: 7, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }] };
  assert.deepEqual(dropDegenerate(flat).mesh.faces,
    [{ source: 7, start: 0, count: 3 }, { source: 8, start: 3, count: 0 }]);
  assert.deepEqual(Array.from(dropDegenerate({ ...flat, faces: [] }).mesh.indices), [0, 1, 2]);
  // A vertex used twice is one position even when that position isn't a number.
  assert.equal(dropDegenerate(
    { ...flat, positions: Float32Array.of(NaN, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0),
    indices: Uint32Array.of(0, 0, 1, 1, 3, 2), faces: [] }).dropped, 1);
});

test('tessellateScene: degenerate triangles dropped and inside-out shells turned as the meshes are made, with '
  + 'diagnostics; or kept', async () => {
  const scene: Scene = {
    unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {},
    diagnostics: [],
    parts: ['key', 'cube'].map(
      (name, i) => ({ name, sources: [{ format: 'step', id: 10 + i }], properties: {}, unit: 1,
      origin: [0, 0, 0] as [number, number, number], lods: [],
      brep: { format: 'step' as const, payload: () => Uint8Array.of(i) } })),
  };
  const key = boxes({ turned: true, normals: 'winding' }, { lo: [3, 0, 0], turned: true, normals: 'winding' });
  // The cube with a degenerate triangle in its last face.
  const box = boxes({});
  const cube: Mesh = { ...box, indices: Uint32Array.from([...box.indices, 0, 0, 7]),
    faces: box.faces.map((f, k) => (k === 5 ? { ...f, count: 9 } : f)) };
  const backend: Tessellator = {
    info: { name: 'fake', version: '1', license: 'x', formats: ['step'], supportsFaceIds: true, supportsEdges: false,
      supportsCurves: false },
    async init() {},
    dispose() {},
    async tessellate(req: TessellationRequest): Promise<TessellationResult> {
      const m = req.data[0] === 0 ? key : cube;
      return { origin: [0, 0, 0], positions: m.positions, normals: m.normals!, indices: m.indices,
        faces: m.faces.map((f) => ({ entityId: f.source, start: f.start, count: f.count })), diagnostics: [] };
    },
  };
  const seen: Mesh[] = [];
  const r = await tessellateScene(scene, backend,
    { linearDeflection: 0.1, angularDeflection: 0.5, onPart: (_p, m) => seen.push(m!) });
  assert.deepEqual(r.diagnostics, [
    { severity: 'warning', message: '2 closed shells turned over (inside out, and inside no other shell)',
      source: { format: 'step', id: 10 } },
    { severity: 'info', message: '1 degenerate triangle dropped (two corners at one position)',
      source: { format: 'step', id: 11 } },
  ]);
  assert.deepEqual(Array.from(r.meshes.get(1)!.indices), Array.from(box.indices));
  assert.deepEqual(problems(r.meshes.get(0)!), []);
  assert.deepEqual(problems(r.meshes.get(1)!), []);
  assert.equal(seen[0], r.meshes.get(0));
  const kept = await tessellateScene(scene, backend,
    { linearDeflection: 0.1, angularDeflection: 0.5, orient: false, dropDegenerate: false });
  assert.deepEqual([kept.diagnostics, problems(kept.meshes.get(0)!), kept.meshes.get(1)!.indices.length],
    [[], [INSIDE_OUT], 39]);
  const one = await tessellateScene(scene, backend,
    { linearDeflection: 0.1, angularDeflection: 0.5, dropDegenerate: false });
  assert.deepEqual([one.diagnostics.length, one.meshes.get(1)!.indices.length], [1, 39]);
});

test("manifoldProblems", () => {
  const c = boxes({});
  const w = weld(c.positions);
  const tris = Array.from(c.indices, (v) => w.remap[v]!).filter((_, i, a) => {
    const t = i - (i % 3);
    return a[t] !== a[t + 1] && a[t + 1] !== a[t + 2] && a[t + 2] !== a[t];
  });
  assert.deepEqual(manifoldProblems(w.positions, Uint32Array.from(tris)), []);
  assert.deepEqual(manifoldProblems(w.positions, Uint32Array.from(tris.slice(3))), ['3 boundary edges']);
  // A fin: a third triangle on one edge.
  const fin = Float32Array.from([...w.positions, 5, 5, 5]);
  assert.deepEqual(manifoldProblems(fin, Uint32Array.from([...tris, tris[0]!, tris[1]!, w.positions.length / 3])),
    ['2 boundary edges', '1 non-manifold edge']);
  assert.deepEqual(manifoldProblems(w.positions, Uint32Array.from(tris.slice(0, 9))),
    ['7 boundary edges', '3 triangles (a solid needs 4)']);
});


test('weld: equal coordinates join, -0 and 0 too; others stay apart', () => {
  // Random positions, half repeated (shuffled), against a reference by string keys.
  const n = 20000, p = new Float32Array(3 * n);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const j = i % 2 && i > 1 ? Math.floor(rand() * i) : i;
    for (let k = 0; k < 3; k++) p[3 * i + k] = j === i ? Math.fround((rand() - 0.5) * 100) : p[3 * j + k]!;
  }
  p[3] = -0; p[4] = 0; p[5] = 0; p[6] = 0; p[7] = -0; p[8] = 0;
  const w = weld(p);
  const keys = new Map<string, number>();
  const expected = Array.from({ length: n }, (_, i) => {
    const key = `${p[3 * i]! + 0},${p[3 * i + 1]! + 0},${p[3 * i + 2]! + 0}`;
    if (!keys.has(key)) keys.set(key, keys.size);
    return keys.get(key)!;
  });
  assert.deepEqual(Array.from(w.remap), expected);
  assert.equal(w.positions.length, 3 * keys.size);
  assert.equal(w.remap[1], w.remap[2]);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) assert.equal(w.positions[3 * w.remap[i]! + k],
    p[3 * i + k]! + 0);
  assert.ok(!Array.from(w.positions).some((x) => Object.is(x, -0)));
});


test('faceFailures without measures: no triangles failed (an empty piece beside a meshed one is not); left out failed',
  () => {
  // Faces 1-3 a triangle each of area 0.5; face 2 also an empty piece; face 4 only empty pieces; null ignored.
  const mesh: Mesh = { origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
    indices: Uint32Array.of(0, 1, 2, 0, 1, 2, 0, 1, 2), faces: [
      { source: 1, start: 0, count: 3 }, { source: 2, start: 3, count: 3 }, { source: 2, start: 6, count: 0 },
      { source: 3, start: 6, count: 3 }, { source: 4, start: 9, count: 0 }, { source: 4, start: 9, count: 0 },
      { source: null, start: 9, count: 0 }] };
  assert.deepEqual([...faceFailures(mesh)], [[4, 'failed']]);
  // Faces the source lists that the mesh leaves out: failed.
  assert.deepEqual([...faceFailures(mesh, { expected: [1, 9] })].sort(), [[4, 'failed'], [9, 'failed']]);
});

test('faceFailures with measures: partly, excess, unverified and failed by the face\'s area, the tolerances\' edges',
  () => {
  // Face 1 a 10 x 10 square in two triangles (area 100, perimeter 40); face 2 a triangle of area 0.5 (perimeter
  // 3.41); deflection 0.1, so the boundary allowance is 4 for face 1, 0.341 for face 2, and nothing under 0.01 is
  // a face to mesh.
  const mesh: Mesh = { origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6),
    faces: [{ source: 1, start: 0, count: 6 }, { source: 2, start: 6, count: 3 }] };
  const d = 0.1;
  const judge = (faces: [number, Partial<FaceMeasures>][], m: Mesh = mesh) => faceFailures(m, { measured: {
    deflection: d, measures: { by: 'test', faces: new Map(faces.map(([s, f]) => [s, { area: 1, perimeter: 1,
      valid: true, ...f }])) } } });
  const one = (area: number, perimeter = 40, valid = true) => judge([[1, { area, perimeter, valid }]]).get(1);
  assert.equal(one(100), undefined);
  // Short: 4 is the larger of 3 % (3.0-3.3) and the strip (4): 103.9 passes, 104.1 is partly; at 200, 3 % (6) is.
  assert.equal(one(103.9), undefined);
  assert.equal(one(104.1), 'partly');
  assert.equal(one(205.9), 'partly');
  assert.equal(one(105.9, 400), undefined);
  // The strip scales with the perimeter: 10 short passes with a perimeter of 101 (allowance 10.1), not with 99.
  assert.equal(one(110, 101), undefined);
  assert.equal(one(110, 99), 'partly');
  // With no strip, the fraction alone: 3 short of 103 passes (3.09 allowed), 3.5 of 103.5 doesn't.
  assert.equal(one(103, 0), undefined);
  assert.equal(one(103.5, 0), 'partly');
  // Over: the larger of 10 % (9.1-9.3) and the strip (4).
  assert.equal(one(91), undefined);
  assert.equal(one(90.5), 'excess');
  // With no strip (a perimeter of 0), the fraction alone: over by 9.05 of 90.95 passes, by 9.15 of 90.85 doesn't.
  assert.equal(one(90.95, 0), undefined);
  assert.equal(one(90.85, 0), 'excess');
  // A small face meshed coarsely: 0.5 of 0.6 is 17 % short, within its strip (0.341 x 2 = 0.68).
  assert.equal(judge([[2, { area: 0.6, perimeter: 6.83 }]]).get(2), undefined);
  assert.equal(judge([[2, { area: 0.6, perimeter: 0.5 }]]).get(2), 'partly');
  // Not to be trusted: unverified with triangles, failed without.
  assert.equal(one(100, 40, false), 'unverified');
  for (const area of [NaN, Infinity, -1, 1e21]) assert.equal(one(area), 'unverified', String(area));
  // (A huge area that's still possible is judged: the mesh is short of it.)
  assert.equal(one(1e19), 'partly');
  assert.equal(one(100, NaN), 'unverified');
  const empty: Mesh = { ...mesh, faces: [{ source: 1, start: 0, count: 0 }, { source: 2, start: 6, count: 3 }] };
  assert.equal(judge([[1, { area: 100, valid: false }]], empty).get(1), 'failed');
  // No triangles: failed if there's something to mesh (d x d = 0.01 or more), else nothing missing.
  assert.equal(judge([[1, { area: 0.0101 }]], empty).get(1), 'failed');
  assert.equal(judge([[1, { area: 0.0099 }]], empty).get(1), undefined);
  // A measured face the mesh lacks: failed, or nothing if it has nothing to mesh; a face without measures by the
  // no-triangles rule alone.
  assert.equal(judge([[7, { area: 5 }]]).get(7), 'failed');
  assert.equal(judge([[7, { area: 0.001 }]]).get(7), undefined);
  assert.equal(judge([[7, { area: 5 }]], empty).get(1), 'failed');
  assert.equal(judge([[2, { area: 0.5 }]]).get(1), undefined);
});
