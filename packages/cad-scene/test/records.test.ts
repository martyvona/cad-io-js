import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder } from 'cad-brep';
import { cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { AREA, CHECK, composeRecords, edgeUsers, EXPECTED, FallbackTessellator, faceRecords, joinResult,
  oracleMeasures, ORIENTATION, orientResult, recordsFromJson, recordSewn, recordsJson, shareExpected,
  type FaceRecords, type TessellationRequest, type TessellationResult, type Tessellator } from '../src/index.ts';

const model = cube().finish();
const FACES = [21, 22, 23, 24, 25, 26];
const D = 0.01;
const req = { linearDeflection: D };

/** The cube's quads with each vertex's normal its face's (from its winding), and the area oracle's areas. */
function sound(): TessellationResult {
  const r = quads(model);
  const normals = new Float32Array(r.positions.length);
  for (const f of r.faces) {
    const [a, b, c] = [0, 1, 2].map((k) => r.indices[f.start + k]!);
    const p = (i: number) => Array.from(r.positions.subarray(3 * i, 3 * i + 3));
    const u = p(b!).map((x, i) => x - p(a!)[i]!), v = p(c!).map((x, i) => x - p(a!)[i]!);
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    for (let k = f.start; k < f.start + f.count; k++) normals.set(n, 3 * r.indices[k]!);
  }
  return { ...r, normals, oracle: oracleMeasures(model) };
}

const row = (rec: FaceRecords, id: number) => rec.entityId.indexOf(id);
/** Face `id`'s row as a plain object, the part's size left out. */
function of(rec: FaceRecords, id: number): Record<string, number> {
  const k = row(rec, id);
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => ArrayBuffer.isView(v))
    .map(([name, v]) => [name, (v as unknown as ArrayLike<number>)[k]!]));
}

test('a sound mesh: every face its two triangles, manifold within it, its area the oracle\'s, nothing turned', () => {
  const rec = faceRecords(req, sound(), model, { partSize: 1.7 });
  assert.deepEqual([...rec.entityId], FACES);
  assert.equal(rec.partSize, 1.7);
  for (const id of FACES) {
    const x = of(rec, id);
    assert.deepEqual({ ...x, minAngle: Math.round(x.minAngle! * 1e9) / 1e9, longestEdge: Math.round(
      x.longestEdge! * 1e6) / 1e6 }, { entityId: id, triangles: 2, degenerate: 0, nonManifoldEdges: 0, openEdges: 4,
      holeEdges: 0, area: 1, oracleArea: 1, areaClass: AREA.pass, deviation: NaN, deviationCheck: CHECK.unchecked,
      normalAngle: NaN, normalCheck: CHECK.unchecked, turned: 0, minAngle: Math.round(Math.PI / 4 * 1e9) / 1e9,
      belowMinAngle: 0, longestEdge: Math.round(Math.SQRT2 * 1e6) / 1e6, expected: NaN,
      expectedSource: EXPECTED.none, unsewnEdges: -1, orientation: ORIENTATION.asShipped }, `#${id}`);
  }
  // Without normals: (e) unchecked; without edge polylines: holes unknown; without the model: only the meshed faces.
  const bare = { ...sound(), faces: sound().faces.filter((f) => f.entityId !== 26) };
  delete bare.normals;
  delete bare.edges;
  const r2 = faceRecords(req, bare, undefined);
  assert.deepEqual([...r2.entityId], FACES.slice(0, 5));
  assert.deepEqual([...r2.turned], [-1, -1, -1, -1, -1]);
  assert.deepEqual([...r2.holeEdges], [-1, -1, -1, -1, -1]);
});

test('(k) and (b): a face without triangles, short of its area; over, short and unverified by the oracle', () => {
  const r = sound();
  r.faces = r.faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f));
  r.oracle = r.oracle!.filter((o) => o.entityId !== 24).map((o) => (o.entityId === 21 ? { ...o, area: 0.5 }
    : o.entityId === 22 ? { ...o, area: 2 } : o));
  const rec = faceRecords(req, r, model);
  assert.deepEqual([of(rec, 23).triangles, of(rec, 23).area, of(rec, 23).areaClass], [0, 0, AREA.short]);
  assert.equal(of(rec, 21).areaClass, AREA.over);
  assert.equal(of(rec, 22).areaClass, AREA.short);
  assert.deepEqual([of(rec, 24).areaClass, of(rec, 24).oracleArea], [AREA.unverified, NaN]);
  assert.equal(of(rec, 25).areaClass, AREA.pass);
  // Within the boundary's slack (d x P): 1 against 1.035 is short by 3.4 %, under max(3 % of A, 0.01 x 4).
  r.oracle = r.oracle.map((o) => (o.entityId === 25 ? { ...o, area: 1.035 } : o));
  assert.equal(of(faceRecords(req, r, model), 25).areaClass, AREA.pass);
  r.oracle = r.oracle.map((o) => (o.entityId === 25 ? { ...o, area: 1.05 } : o));
  assert.equal(of(faceRecords(req, r, model), 25).areaClass, AREA.short);
  // A face under d x d has nothing to mesh: no triangles pass (its slack, 2e-5, short of its area).
  r.oracle = r.oracle.map((o) => (o.entityId === 23 ? { ...o, area: 5e-5, perimeter: 0.002 } : o));
  assert.equal(of(faceRecords(req, r, model), 23).areaClass, AREA.pass);
  // A face of the model the result leaves out has its row, without triangles.
  const left = faceRecords(req, { ...sound(), faces: sound().faces.filter((f) => f.entityId !== 26) }, model);
  assert.deepEqual([...left.entityId], FACES);
  assert.equal(of(left, 26).triangles, 0);
});

test('(b): a face two shells use is meshed in each, judged against twice its area', () => {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const edges = corners.map((p, k) => {
    const q = corners[(k + 1) % 4]!;
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0],
      magnitude: 1 }), start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, 1] });
  });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] } }), sameSense: true, id: 5, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
  const shells = [0, 1].map(() => b.addShell({ kind: 'open', faces: [{ face, sense: true }] }));
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: shells.map((ref) => ({ ref, sense: true })) }) });
  const twice = b.finish();
  const square = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const r: TessellationResult = { origin: [0, 0, 0], positions: new Float32Array([...square, ...square]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), faces: [{ entityId: 5, start: 0, count: 6 },
      { entityId: 5, start: 6, count: 6 }], oracle: [{ entityId: 5, area: 1, perimeter: 4 }], diagnostics: [] };
  const rec = faceRecords(req, r, twice);
  assert.deepEqual([rec.area[0], rec.oracleArea[0], rec.areaClass[0]], [2, 2, AREA.pass]);
});

test('(l) and (a.1): a degenerate triangle counted and left out of the edges; a triangle twice; a hole', () => {
  const r = sound();
  const f21 = r.faces.find((f) => f.entityId === 21)!, f22 = r.faces.find((f) => f.entityId === 22)!;
  const ix = Array.from(r.indices);
  // Face 21: a triangle with two corners at one position (a copy of its first vertex, at another index).
  const copy = r.positions.length / 3, a = ix[f21.start]!;
  const positions = new Float32Array(r.positions.length + 3);
  positions.set(r.positions);
  positions.set(r.positions.subarray(3 * a, 3 * a + 3), 3 * copy);
  const normals = new Float32Array(positions.length);
  normals.set(r.normals!);
  normals.set(r.normals!.subarray(3 * a, 3 * a + 3), 3 * copy);
  // Face 22: its first triangle again, wound the same way (its three edges then used too often or twice one way).
  const extra21 = [a, copy, ix[f21.start + 1]!], extra22 = ix.slice(f22.start, f22.start + 3);
  const indices: number[] = [];
  const faces = r.faces.map((f) => {
    const start = indices.length;
    indices.push(...ix.slice(f.start, f.start + f.count));
    if (f.entityId === 21) indices.push(...extra21);
    if (f.entityId === 22) indices.push(...extra22);
    return { ...f, start, count: indices.length - start };
  });
  const rec = faceRecords(req, { ...r, positions, normals, indices: Uint32Array.from(indices), faces }, model);
  assert.deepEqual([of(rec, 21).triangles, of(rec, 21).degenerate, of(rec, 21).nonManifoldEdges,
    of(rec, 21).openEdges], [3, 1, 0, 4]);
  assert.deepEqual([of(rec, 22).triangles, of(rec, 22).degenerate, of(rec, 22).nonManifoldEdges], [3, 0, 3]);
  // A hole: an edge of the face's mesh used once that's on no edge's polyline (edge 9's taken away).
  const holed = { ...sound(), edges: sound().edges!.filter((e) => e.entityId !== 9) };
  const h = faceRecords(req, holed, model);
  const users = edgeUsers(model).get(9)!;
  for (const id of FACES) assert.equal(of(h, id).holeEdges, users.includes(id) ? 1 : 0, `#${id}`);
});

test('(e), (f) and (g): turned facets against their shipped normals; the smallest angle, under minAngle; the longest '
  + 'edge', () => {
  const r = sound();
  const f25 = r.faces.find((f) => f.entityId === 25)!;
  const normals = Float32Array.from(r.normals!);
  for (let k = f25.start; k < f25.start + f25.count; k++) for (let c = 0; c < 3; c++) {
    normals[3 * r.indices[k]! + c] = -r.normals![3 * r.indices[k]! + c]!;
  }
  assert.equal(of(faceRecords(req, { ...r, normals }, model), 25).turned, 2);
  // A needle: corners (0, 0, 0), (10, 0, 0), (0, 1, 0), its smallest angle atan(0.1) (5.7 degrees).
  const needle: TessellationResult = { origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), faces: [{ entityId: 7, start: 0, count: 3 }], diagnostics: [] };
  const n = faceRecords(req, needle, undefined);
  assert.ok(Math.abs(n.minAngle[0]! - Math.atan(0.1)) < 1e-7);
  assert.equal(n.belowMinAngle[0], 1);
  assert.equal(faceRecords({ ...req, minAngle: 0.05 }, needle, undefined).belowMinAngle[0], 0);
  assert.ok(Math.abs(n.longestEdge[0]! - Math.hypot(10, 1)) < 1e-6);
  // Its corners in each order: the longest edge whichever side it is.
  for (const ix of [[1, 2, 0], [2, 0, 1], [0, 2, 1]]) assert.ok(Math.abs(faceRecords(req, { ...needle,
    indices: new Uint32Array(ix) }, undefined).longestEdge[0]! - Math.hypot(10, 1)) < 1e-6, String(ix));
  // A face split into pieces (two ranges of one id): its record is theirs together.
  const split = { ...sound(), faces: sound().faces.flatMap((f) => (f.entityId === 26
    ? [{ ...f, count: 3 }, { ...f, start: f.start + 3, count: 3 }] : [f])) };
  assert.deepEqual(of(faceRecords(req, split, model), 26), of(faceRecords(req, sound(), model), 26));
});

test('(c), (d) and (h): the backend\'s own checks and expected counts where it reports them, else the first meshing\'s',
  () => {
    const r = { ...sound(), reported: [{ entityId: 21, deviationCheck: CHECK.lowerBound, deviation: 0.3,
      normalCheck: CHECK.failedUnmeasured, normalAngle: NaN, expected: 12 },
    { entityId: 22, deviationCheck: CHECK.passed, deviation: NaN, normalCheck: CHECK.passed, normalAngle: NaN,
      expected: 0 }] };
    const rec = faceRecords(req, r, model, { expected: new Map([[21, 10], [22, 5], [23, 0]]) });
    assert.deepEqual([of(rec, 21).deviationCheck, of(rec, 21).deviation, of(rec, 21).normalCheck],
      [CHECK.lowerBound, 0.3, CHECK.failedUnmeasured]);
    assert.deepEqual([of(rec, 21).expected, of(rec, 21).expectedSource], [12, EXPECTED.backend]);
    // (The backend's count 0: none of its own, the first meshing's kept.)
    assert.deepEqual([of(rec, 22).expected, of(rec, 22).expectedSource], [5, EXPECTED.firstMeshing]);
    assert.deepEqual([of(rec, 22).deviationCheck, of(rec, 22).normalCheck], [CHECK.passed, CHECK.passed]);
    // A count of 0 is no count.
    assert.deepEqual([of(rec, 23).expected, of(rec, 23).expectedSource], [NaN, EXPECTED.none]);
    assert.equal(of(rec, 24).deviationCheck, CHECK.unchecked);
  });

test('(a.2) and (j): written by joinResult and orientResult where the result has records', () => {
  const rec = faceRecords(req, sound(), model);
  // Joined with nothing open: every face 0; without edge polylines, unknown.
  const joined = joinResult(model, { ...sound(), records: rec }, D);
  assert.deepEqual([...joined.records!.unsewnEdges], [0, 0, 0, 0, 0, 0]);
  const bare = { ...sound(), records: rec };
  delete bare.edges;
  assert.deepEqual([...joinResult(model, bare, D).records!.unsewnEdges], [-1, -1, -1, -1, -1, -1]);
  // Edges left open: each face using one counts it.
  const users = edgeUsers(model);
  const s = recordSewn(rec, model, [9, 10], true);
  for (const id of FACES) assert.equal(of(s, id).unsewnEdges,
    Number(users.get(9)!.includes(id)) + Number(users.get(10)!.includes(id)), `#${id}`);
  // A solid's shell meshed inside out: orientResult turns it, every face said turned; a sound one, none.
  const r = sound();
  const ix = Uint32Array.from(r.indices);
  for (let t = 0; t < ix.length; t += 3) [ix[t + 1], ix[t + 2]] = [ix[t + 2]!, ix[t + 1]!];
  const inside = { ...r, indices: ix, records: rec };
  assert.deepEqual([...orientResult(model, inside, D).records!.orientation], FACES.map(() => ORIENTATION.turned));
  assert.deepEqual([...orientResult(model, { ...sound(), records: rec }, D).records!.orientation],
    FACES.map(() => ORIENTATION.asShipped));
  assert.equal(orientResult(model, sound(), D).records, undefined);
});

test('records compose as their meshes do, and survive JSON (NaN as null)', () => {
  const a = faceRecords(req, sound(), model, { partSize: 2 });
  const r = sound();
  r.faces = r.faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f));
  const b = faceRecords(req, r, model, { partSize: 3 });
  const c = composeRecords(b, a, new Set([23]));
  assert.equal(of(c, 23).triangles, 2);
  assert.equal(c.partSize, 3);
  assert.deepEqual(of(c, 24), of(b, 24));
  assert.equal(of(b, 23).triangles, 0, 'b unchanged');
  const back = recordsFromJson(JSON.parse(JSON.stringify(recordsJson(a))));
  assert.deepEqual(back, a);
  assert.equal(recordsFromJson({ entityId: [1], triangles: [] }), undefined);
});

test('(h) shared: a face without a count of its own takes the other backend\'s cap where it has one, as the '
  + 'fallback composes the part', async () => {
  const reported = (expected: number) => FACES.map((entityId) => ({ entityId, deviationCheck: CHECK.passed,
    deviation: NaN, normalCheck: CHECK.passed, normalAngle: NaN, expected }));
  const own = faceRecords(req, { ...sound(), reported: reported(7) }, model);
  const foreign = faceRecords(req, sound(), model, { expected: new Map([[21, 3]]) });
  const s = shareExpected(foreign, own);
  assert.deepEqual([...s.expected], FACES.map(() => 7));
  assert.deepEqual([...s.expectedSource], FACES.map(() => EXPECTED.otherCap));
  assert.equal(shareExpected(own, foreign), own, 'its own cap kept');
  const other = faceRecords(req, { ...sound(), reported: reported(9) }, model);
  assert.deepEqual([...shareExpected(own, other).expected], FACES.map(() => 7), 'its own cap, not the other\'s');
  assert.equal(shareExpected(foreign, foreign), foreign, 'nothing to take');
  // Through FallbackTessellator: the primary (its own caps reported) leaves face 23 without triangles, the fallback's
  // mesh of it taken with the primary's count.
  const backend = (name: string, answer: () => TessellationResult): Tessellator => ({
    info: { name, version: '1', license: 'A', formats: ['cad-brep'], supportsFaceIds: true, supportsEdges: true,
      supportsCurves: false },
    init: async () => {}, dispose: () => {},
    tessellate: async (q: TessellationRequest) => {
      const r = answer();
      return q.records ? { ...r, records: faceRecords(q, r, model) } : r;
    } });
  const primary = () => {
    const r = sound();
    return { ...r, faces: r.faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f)), reported: reported(7) };
  };
  const t = new FallbackTessellator(backend('a', primary), backend('b', sound));
  await t.init();
  const r = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(model.buffer), linearDeflection: D,
    angularDeflection: 0.5, records: true });
  assert.match(r.backend!, /with 1 face by b/);
  assert.equal(of(r.records!, 23).triangles, 2);
  assert.deepEqual([of(r.records!, 23).expected, of(r.records!, 23).expectedSource], [7, EXPECTED.otherCap]);
  assert.deepEqual([of(r.records!, 21).expected, of(r.records!, 21).expectedSource], [7, EXPECTED.backend]);
  // The other way round: a foreign primary, its faces the fallback's caps.
  const foreignFirst = () => {
    const x = sound();
    return { ...x, faces: x.faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f)) };
  };
  const u = new FallbackTessellator(backend('a', foreignFirst), backend('b', () => ({ ...sound(),
    reported: reported(5) })));
  await u.init();
  const ru = await u.tessellate({ format: 'cad-brep', data: new Uint8Array(model.buffer), linearDeflection: D,
    angularDeflection: 0.5, records: true });
  assert.match(ru.backend!, /with 1 face by b/);
  assert.deepEqual([of(ru.records!, 21).expected, of(ru.records!, 21).expectedSource], [5, EXPECTED.otherCap]);
  assert.deepEqual([of(ru.records!, 23).expected, of(ru.records!, 23).expectedSource], [5, EXPECTED.backend]);
});

