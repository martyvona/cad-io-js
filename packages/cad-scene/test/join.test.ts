import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, decode } from 'cad-brep';
import { cube } from '../../cad-brep/test/models.ts';
import { quads, withPoint, withPolygon } from './meshes.ts';
import { FallbackTessellator, JOIN_SNAP, joinedMessage, joinEdges, openEdges, openEdgesMessage, tessellateScene,
  type Scene, type TessellationRequest, type TessellationResult, type Tessellator } from '../src/index.ts';

const d = cube().finish();
const D = 0.1;

/** The edge ids of a face (by id), as its loop uses them. */
function edgesOf(m: BrepData, face: number): number[] {
  const loop = decode.face(m, [...m.face.id].indexOf(face)).loops[0]!;
  return loop.kind === 'edge' ? loop.coedges.map((c) => decode.edge(m, c.edge).id!) : [];
}

/** Each face's triangles' area, and each triangle's normal against its face's first (all positive: none turned). */
function areas(r: TessellationResult) {
  const p = (i: number) => [0, 1, 2].map((k) => r.positions[3 * i + k]!);
  const out = new Map<number, number>();
  let turned = 0;
  for (const f of r.faces) {
    let first: number[] | undefined, a = 0;
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [x, y, z] = [0, 1, 2].map((j) => p(r.indices[t + j]!));
      const u = y!.map((v, i) => v - x![i]!), w = z!.map((v, i) => v - x![i]!);
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      a += Math.hypot(...n) / 2;
      first ??= n;
      if (n[0]! * first[0]! + n[1]! * first[1]! + n[2]! * first[2]! <= 0) turned++;
    }
    out.set(f.entityId!, (out.get(f.entityId!) ?? 0) + a);
  }
  return { out, turned };
}

/** The points of edge `id`'s polylines, in order. */
const polyline = (r: TessellationResult, id: number) => r.edges!.filter((e) => e.entityId === id)
  .flatMap((e) => Array.from(r.edgePositions!.subarray(3 * e.start, 3 * (e.start + e.count))));

test('join: a T-junction (one face with a point of its own along a side) split in its neighbour, the polyline too',
  () => {
  const [side] = edgesOf(d, 21);
  const r = withPoint(quads(d), 21, 0);
  assert.deepEqual(openEdges(d, r).open, [side]);
  const j = joinEdges(d, r, D);
  assert.deepEqual([j.joined, j.open, [...j.skipped]], [[side], [], []]);
  assert.deepEqual(openEdges(d, j.result).open, []);
  // The neighbour's triangle on the side made two (its 2 now 3); every face's area kept, none turned over.
  const neighbour = [...d.face.id].find((f) => f !== 21 && edgesOf(d, f).includes(side!))!;
  assert.equal(j.result.faces.find((f) => f.entityId === neighbour)!.count, 9);
  const before = areas(r), after = areas(j.result);
  assert.equal(after.turned, 0);
  for (const [f, a] of before.out) assert.ok(Math.abs(after.out.get(f)! - a) < 1e-6, `face ${f}`);
  // The polyline the side's three points; the new point a copy of face 21's (the same numbers).
  const pl = polyline(j.result, side!);
  assert.equal(pl.length, 9);
  assert.deepEqual(pl.slice(3, 6), Array.from(r.positions.subarray(r.positions.length - 3)));
  // Deterministic: the same input, the same output.
  assert.deepEqual(joinEdges(d, r, D).result, j.result);
});

test('join: a point off the side within the deflection is a point of both; beyond it the edge stays open', () => {
  const [side] = edgesOf(d, 21);
  // Face 21's own point 0.05 off its side, in its plane (inward): within the deflection.
  const base = quads(d), f21 = base.faces.find((f) => f.entityId === 21)!;
  const c = (k: number) => Array.from(base.positions.subarray(3 * base.indices[f21.start + k]!,
    3 * base.indices[f21.start + k]! + 3));
  const [c0, c1, c2] = [0, 1, 2].map(c);
  // (Inward: from the side towards the face's opposite corner, perpendicular to the side.)
  const dir = c2!.map((x, i) => x - c1![i]!);
  const near = withPoint(base, 21, 0, 0.5, dir.map((x) => 0.05 * x) as [number, number, number]);
  assert.ok(c0);
  const j = joinEdges(d, near, D);
  assert.deepEqual([j.joined, j.open], [[side], []]);
  // 0.2 off (beyond it): the face's boundary leaves the edge, not joined.
  const far = withPoint(base, 21, 0, 0.5, dir.map((x) => 0.2 * x) as [number, number, number]);
  const k = joinEdges(d, far, D);
  assert.deepEqual([k.joined, k.open, k.skipped.get(side!)], [[], [side], 'a face\'s boundary leaves the edge']);
  assert.equal(k.result, far);
});

test('join: a corner within the snap distance moved onto the other faces\' everywhere; beyond it, not joined',
  () => {
  const ids = edgesOf(d, 21);
  const at = [ids[0]!, ids[3]!].sort((a, b) => a - b);
  // Face 21's copy of its first corner moved by 0.9 x the snap distance: the two edges at it open, then both joined,
  // and the third face at the corner still meets both (the point the same everywhere).
  const small = quads(d, { face: 21, corner: 0, by: [0, 0, 0.9 * JOIN_SNAP * D] });
  assert.deepEqual(openEdges(d, small).open.sort((a, b) => a - b), at);
  const j = joinEdges(d, small, D);
  assert.deepEqual([j.joined.sort((a, b) => a - b), j.open], [at, []]);
  assert.deepEqual(openEdges(d, j.result).open, []);
  // Beyond it (within the deflection): the corners apart, not joined.
  const big = quads(d, { face: 21, corner: 0, by: [0, 0, 2 * JOIN_SNAP * D] });
  const k = joinEdges(d, big, D);
  assert.deepEqual(k.joined, []);
  assert.equal(k.skipped.get(ids[0]!), 'the faces\' corners apart by more than the snap distance');
  // Beyond the deflection: the corner off the edge's end.
  const off = joinEdges(d, quads(d, { face: 21, corner: 0, by: [0, 0, 2 * D] }), D);
  assert.equal(off.skipped.get(ids[0]!), 'a face\'s corner off the edge\'s end');
  // (The face whose corner it is named for each edge it leaves open.)
  assert.equal(off.culprits.get(ids[0]!), 21);
});

test('join: an edge\'s polyline in pieces (either way round) made one; nothing open, the result itself', () => {
  const [side] = edgesOf(d, 21);
  const r = withPoint(quads(d), 21, 0);
  // The side's polyline as two pieces meeting at its middle, the second reversed.
  const e = r.edges!.findIndex((x) => x.entityId === side);
  const p = r.edgePositions!, s = 3 * r.edges![e]!.start;
  const a = Array.from(p.subarray(s, s + 3)), b = Array.from(p.subarray(s + 3, s + 6));
  const m = a.map((x, i) => (x + b[i]!) / 2);
  const ep = Float32Array.from([...p, ...a, ...m, ...b, ...m]);
  const n = p.length / 3;
  const edges = [...r.edges!.filter((_, k) => k !== e), { ...r.edges![e]!, start: n, count: 2 },
    { ...r.edges![e]!, start: n + 2, count: 2 }];
  // (With the T-junction's point exactly the pieces' middle, the side is shared: the neighbour lacks it.)
  const pieces = { ...r, edges, edgePositions: ep };
  assert.deepEqual(openEdges(d, pieces).open, [side]);
  const j = joinEdges(d, pieces, D);
  assert.deepEqual([j.joined, j.open], [[side], []]);
  assert.equal(j.result.edges!.filter((x) => x.entityId === side).length, 1);
  assert.equal(polyline(j.result, side!).length, 9);
  // A result with nothing open, or without polylines, comes back as it is.
  const plain = quads(d);
  assert.equal(joinEdges(d, plain, D).result, plain);
  const bare = { ...r, edges: undefined, edgePositions: undefined };
  assert.deepEqual(joinEdges(d, bare, D),
    { result: bare, joined: [], open: [], skipped: new Map(), culprits: new Map() });
});

test('join: normals for the new points; a face in two ranges made one; faces without an id kept as they are', () => {
  const [side] = edgesOf(d, 21);
  const r = withPoint(quads(d), 21, 0);
  const neighbour = [...d.face.id].find((f) => f !== 21 && edgesOf(d, f).includes(side!))!;
  // Normals: each vertex's index as its x, to see which the new point's copied.
  const normals = new Float32Array(r.positions.length);
  for (let i = 0; i < normals.length / 3; i++) normals[3 * i] = i;
  // The neighbour's two triangles as two ranges, an id-less copy of face 26 after them.
  const nb = r.faces.find((f) => f.entityId === neighbour)!;
  const f26 = r.faces.find((f) => f.entityId === 26)!;
  const faces = [...r.faces.filter((f) => f !== nb), { ...nb, count: 3 }, { ...nb, start: nb.start + 3, count: 3 }];
  const indices = Uint32Array.from([...r.indices, ...r.indices.subarray(f26.start, f26.start + f26.count)]);
  faces.push({ entityId: null, start: r.indices.length, count: f26.count });
  const j = joinEdges(d, { ...r, normals, faces, indices }, D);
  assert.deepEqual(j.joined, [side]);
  const out = j.result;
  assert.equal(out.normals!.length, out.positions.length);
  const added = out.positions.length / 3 - 1;
  // (The new point's normal is one of the split triangle's corners': the neighbour's vertices.)
  assert.ok([...out.indices].includes(added));
  const corners = new Set(r.indices.subarray(nb.start, nb.start + nb.count));
  assert.ok(corners.has(out.normals![3 * added]!), String(out.normals![3 * added]));
  assert.equal(out.faces.filter((f) => f.entityId === neighbour).length, 1);
  assert.equal(out.faces.find((f) => f.entityId === neighbour)!.count, 9);
  const bareFace = out.faces.find((f) => f.entityId === null)!;
  assert.deepEqual(Array.from(out.indices.subarray(bareFace.start, bareFace.start + bareFace.count)),
    Array.from(r.indices.subarray(f26.start, f26.start + f26.count)));
  // The faces partition the indices.
  assert.equal(out.faces.reduce((n, f) => n + f.count, 0), out.indices.length);
});

test('join: a split that would turn a triangle over leaves the edge as it was', () => {
  const [side] = edgesOf(d, 21);
  const base = quads(d);
  const neighbour = [...d.face.id].find((f) => f !== 21 && edgesOf(d, f).includes(side!))!;
  // The neighbour made thin along the side: its copies of its two corners off the side moved to 0.2 from it; then
  // face 21's own point 0.5 into the neighbour's plane, beyond them (the deflection 1, so within it).
  const nb = base.faces.find((f) => f.entityId === neighbour)!;
  const sidePts = polyline(base, side!);
  const same = (i: number, o: number) => [0, 1, 2].every((k) => base.positions[3 * i + k] === sidePts[o + k]);
  const onSide = (i: number) => same(i, 0) || same(i, 3);
  const positions = Float32Array.from(base.positions);
  const corners = [...new Set(base.indices.subarray(nb.start, nb.start + nb.count))];
  const inner = corners.filter((i) => !onSide(i)), outer = corners.filter(onSide);
  const gap = (x: number, i: number) => Math.hypot(...[0, 1, 2].map((k) => positions[3 * x + k]!
    - positions[3 * i + k]!));
  for (const i of inner) {
    // (Towards the side along the face: 0.8 of the way from the corner off it to the nearer corner on it.)
    const near = gap(outer[0]!, i) < gap(outer[1]!, i) ? outer[0]! : outer[1]!;
    for (let k = 0; k < 3; k++) {
      positions[3 * i + k] = positions[3 * i + k]! + 0.8 * (positions[3 * near + k]! - positions[3 * i + k]!);
    }
  }
  const thin = { ...base, positions };
  const into = [0, 1, 2].map((k) => positions[3 * inner[0]! + k]! - sidePts[k]!);
  const len = Math.hypot(...into);
  const r = withPoint(thin, 21, 0, 0.5, into.map((x) => 0.5 * x / len) as [number, number, number]);
  const j = joinEdges(d, r, 1);
  assert.equal(j.skipped.get(side!), 'a split would turn a triangle over');
  assert.ok(!j.joined.includes(side!));
});

/** A one-part scene of the cube. */
const scene = (): Scene => ({ unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [],
  properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {},
    origin: [0, 0, 0], lods: [], brep: { format: 'step', model: d } }] });

/** A backend answering with `r` and the open-edge error its open edges make (as every backend gives it). */
function backend(r: TessellationResult) {
  const asked: TessellationRequest[] = [];
  const t: Tessellator & { asked: TessellationRequest[] } = { asked,
    info: { name: 'fake', version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {},
    tessellate: async (req) => {
      asked.push(req);
      const n = openEdges(d, r).open.length;
      return { ...r, diagnostics: n ? [{ severity: 'error', message: openEdgesMessage(n) }] : [] };
    },
    dispose: () => {} };
  return t;
}

test('tessellateScene joins each part (edges asked for, kept only if asked), the open-edge error made the edges left',
  async () => {
  const tj = withPoint(quads(d), 21, 0);
  const t = backend(tj), s = scene();
  const { diagnostics } = await tessellateScene(s, t, { measures: false, linearDeflection: D });
  assert.equal(t.asked[0]!.edges, true);
  assert.deepEqual(diagnostics, [{ severity: 'info', message: joinedMessage(1), source: { format: 'step', id: 7 } }]);
  const mesh = s.parts[0]!.lods[0]!.mesh;
  assert.equal(mesh.edges, undefined);
  // Asked for edges: the joined polylines kept.
  const s2 = scene();
  await tessellateScene(s2, backend(tj), { measures: false, linearDeflection: D, edges: true });
  assert.equal(s2.parts[0]!.lods[0]!.mesh.edges!.length, 12);
  // One edge joinable, another not (a corner off by more than the deflection): the error the one left.
  const both = withPoint(quads(d, { face: 22, corner: 0, by: [0, 0, 3 * D] }), 21, 0);
  const s3 = scene();
  const r3 = await tessellateScene(s3, backend(both), { measures: false, linearDeflection: D });
  const left = openEdges(d, joinEdges(d, both, D).result).open.length;
  assert.ok(left > 0);
  assert.deepEqual(r3.diagnostics.map((x) => [x.severity, x.message]),
    [['info', joinedMessage(1)], ['error', openEdgesMessage(left)]]);
  // Opted out: as the backend gave it, edges not asked for.
  const off = backend(tj), s4 = scene();
  const r4 = await tessellateScene(s4, off, { measures: false, linearDeflection: D, join: false });
  assert.equal(off.asked[0]!.edges, undefined);
  assert.deepEqual(r4.diagnostics.map((x) => x.message), [openEdgesMessage(1)]);
});

test('the fallback judges joined results: a primary open only where a join closes it isn\'t sent to the fallback',
  async () => {
  const a = backend(withPoint(quads(d), 21, 0)), b = backend(quads(d));
  const t = new FallbackTessellator(a, b);
  await t.init();
  const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(d.buffer), origin: [0, 0, 0],
    linearDeflection: D, angularDeflection: 0.5 };
  const r = await t.tessellate(req);
  assert.equal(b.asked.length, 0);
  assert.deepEqual(r.diagnostics, [{ severity: 'info', message: joinedMessage(1) }]);
  assert.equal(r.edges, undefined);
  // Without the join, the primary is open and the fallback (closed) kept.
  const off = new FallbackTessellator(backend(withPoint(quads(d), 21, 0)), b, { join: false });
  await off.init();
  assert.equal((await off.tessellate(req)).backend, 'fake 1');
  assert.equal(b.asked.length, 1);
});

/**
 * Two discs sharing a closed edge (a circle, radius 2), each meshed as a fan of eight points round it (the first the
 * vertex), the second wound the other way and with a point of its own between its points `k` and `k + 1`, `inward`
 * from the circle.
 */
function discs(k: number, inward: number) {
  const b = new BrepBuilder();
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const circle = b.addCurve({ kind: 'circle', position, radius: 2 });
  const v = b.addVertex({ point: [2, 0, 0] });
  const edge = b.addEdge({ curve: circle, start: v, end: v, sameSense: true, id: 1 });
  const plane = b.addSurface({ kind: 'plane', position });
  const disc = (id: number, forward: boolean) => b.addFace({ surface: plane, sameSense: forward, id,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge, orientation: forward ? 'forward'
      : 'reversed' }] }] });
  const up = disc(3, true), down = disc(4, false);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face: up, sense: true }, { face: down, sense: true }] }), sense: true }] }) });
  const m = b.finish();
  const N = 8, at = (a: number, rr = 2) => [rr * Math.cos(a), rr * Math.sin(a), 0];
  const ring = Array.from({ length: N }, (_, j) => at((2 * Math.PI * j) / N));
  const extra = at((2 * Math.PI * (k + 0.5)) / N, 2 - inward);
  const positions = [0, 0, 0, ...ring.flat(), 0, 0, 0, ...ring.flat(), ...extra];
  const c1 = 0, c2 = N + 1, x = 2 * N + 2;
  const tri: number[] = [];
  for (let j = 0; j < N; j++) tri.push(c1, 1 + j, 1 + (j + 1) % N);
  const second: number[] = [];
  for (let j = 0; j < N; j++) {
    const p = c2 + 1 + j, q = c2 + 1 + (j + 1) % N;
    if (j === k) second.push(c2, x, p, c2, q, x);
    else second.push(c2, q, p);
  }
  const r: TessellationResult = { origin: [0, 0, 0], positions: Float32Array.from(positions),
    indices: Uint32Array.from([...tri, ...second]), faces: [{ entityId: 3, start: 0, count: tri.length },
      { entityId: 4, start: tri.length, count: second.length }],
    edges: [{ entityId: 1, start: 0, count: N + 1, kind: 'shared' }],
    edgePositions: Float32Array.from([...ring.flat(), ...ring[0]!]), diagnostics: [] };
  return { m, r, N };
}

test('join: a closed edge (a circle two discs share, one with a point of its own on it) joined round', () => {
  // (The extra point on the circle, 0.15 off the chord it splits: within a deflection of 0.5.)
  const { m, r, N } = discs(2, 0);
  assert.deepEqual(openEdges(m, r).open, [1]);
  const j = joinEdges(m, r, 0.5);
  assert.deepEqual([j.joined, j.open, [...j.skipped]], [[1], [], []]);
  assert.equal(polyline(j.result, 1).length, 3 * (N + 2));
  assert.equal(areas(j.result).turned, 0);
  // Its own point just after the vertex and off the polyline, its point before the vertex on it: the walk goes on
  // to the next point along, not round the circle the wrong way to the nearer.
  const near = discs(0, 0.05);
  const k = joinEdges(near.m, near.r, 0.5);
  assert.deepEqual([k.joined, k.open], [[1], []]);
});

test('join: at a corner, the walk goes along the edge, not along the next one where a point of it is nearer', () => {
  // Face 21's polygon: its corners, a point of its own on its first side 0.05 into the face, and one on its last
  // side 0.02 from its first corner (nearer the first side's polyline than the first point).
  const base = quads(d), f21 = base.faces.find((f) => f.entityId === 21)!;
  const c = (k: number) => Array.from(base.positions.subarray(3 * base.indices[f21.start + k]!,
    3 * base.indices[f21.start + k]! + 3));
  const [c0, c1, c2, , c3] = [0, 1, 2, 0, 5].map(c);
  const inward = c2!.map((x, i) => x - c1![i]!);
  const m = c0!.map((x, i) => (x + c1![i]!) / 2 + 0.05 * inward[i]!);
  const n = c0!.map((x, i) => x + 0.02 * (c3![i]! - x));
  const r = withPolygon(base, 21, [c2!, c3!, n, c0!, m, c1!]);
  const ids = edgesOf(d, 21);
  const j = joinEdges(d, r, D);
  assert.deepEqual([j.joined.sort((a, b) => a - b), j.open], [[ids[0]!, ids[3]!].sort((a, b) => a - b), []]);
});
