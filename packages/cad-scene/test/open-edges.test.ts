import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrepData, decode } from 'cad-brep';
import { cube, withoutIds } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { openEdges, openEdgesCount, openEdgesDiagnostic, openEdgesMessage } from '../src/index.ts';

/** The edge ids of a face (by id), as its loop uses them. */
function edgesOf(d: BrepData, face: number): number[] {
  const row = [...d.face.id].indexOf(face);
  const loop = decode.face(d, row).loops[0]!;
  return loop.kind === 'edge' ? loop.coedges.map((c) => decode.edge(d, c.edge).id!) : [];
}

test('open edges: none where every face meets its neighbours exactly; a moved corner opens the two edges at it',
  () => {
  const d = cube().finish();
  assert.deepEqual(openEdges(d, quads(d)), { open: [], unjudged: [] });
  // Face 21's first corner moved: its first edge (from that corner) and its last (to it) are open, no other.
  const ids = edgesOf(d, 21);
  const r = openEdges(d, quads(d, { face: 21, corner: 0, by: [0, 0, 1e-3] }));
  assert.deepEqual(r.open.sort(), [ids[0]!, ids[3]!].sort());
  assert.deepEqual(r.unjudged, []);
  // However little: one unit in the last place of single precision is open.
  const tiny = openEdges(d, quads(d, { face: 22, corner: 1, by: [0, 0, 1e-6] }));
  assert.equal(tiny.open.length, 2);
});

test('open edges: an edge is judged only when two or more faces use it and all have triangles', () => {
  const d = cube().finish();
  const moved = quads(d, { face: 21, corner: 0, by: [0, 0, 1e-3] });
  // Face 21 without triangles: its edges can't be judged (the failed face is told elsewhere), the rest are closed.
  const without = { ...moved, faces: moved.faces.map((f) => (f.entityId === 21 ? { ...f, count: 0 } : f)) };
  assert.deepEqual(openEdges(d, without).open, []);
  // A face left out of the result entirely: the same.
  assert.deepEqual(openEdges(d, { ...moved, faces: moved.faces.filter((f) => f.entityId !== 21) }).open, []);
});

test('open edges: a judged edge without a polyline is unjudged; a result without edges judges none', () => {
  const d = cube().finish();
  const r = quads(d, { face: 21, corner: 0, by: [0, 0, 1e-3] });
  const [first] = edgesOf(d, 21);
  const r2 = { ...r, edges: r.edges!.filter((e) => e.entityId !== first) };
  const o = openEdges(d, r2);
  assert.deepEqual(o.unjudged, [first]);
  assert.equal(o.open.length, 1);
  assert.deepEqual(openEdges(d, { ...r, edges: undefined, edgePositions: undefined }), { open: [], unjudged: [] });
  // Edges without an id, or ids the model doesn't have, aren't judged.
  assert.deepEqual(openEdges(d, { ...r, edges: r.edges!.map((e) => ({ ...e, entityId: null })) }).open, []);
  assert.deepEqual(openEdges(d, { ...r, edges: r.edges!.map((e) => ({ ...e, entityId: e.entityId! + 1000 })) }).open,
    []);
});

test('open edges: -0 and 0 are one position; a polyline segment from a point to itself is no gap', () => {
  const d = cube().finish();
  const r = quads(d);
  // Every 0 in the mesh as -0: the faces still meet the polylines' 0s.
  const neg = { ...r, positions: r.positions.map((x) => (x === 0 ? -0 : x)) };
  assert.ok(neg.positions.some((x) => Object.is(x, -0)));
  assert.deepEqual(openEdges(d, neg).open, []);
  // A polyline with a repeated point (single precision makes them): no segment of none.
  const at = r.edges![0]!;
  const p = r.edgePositions!;
  const extra = new Float32Array(p.length + 3);
  extra.set(p.subarray(0, 3 * (at.start + 1)));
  extra.set(p.subarray(3 * at.start, 3 * (at.start + 1)), 3 * (at.start + 1));
  extra.set(p.subarray(3 * (at.start + 1)), 3 * (at.start + 2));
  const edges = r.edges!.map((e, k) => (k === 0 ? { ...e, count: 3 } : { ...e, start: e.start + 1 }));
  assert.deepEqual(openEdges(d, { ...r, edgePositions: extra, edges }).open, []);
});

test('open edges: the error, its count read back, and the diagnostic from the model or its bytes', () => {
  const d = cube().finish();
  const r = quads(d, { face: 21, corner: 0, by: [0, 0, 1e-3] });
  assert.deepEqual(openEdgesDiagnostic(d, r), { severity: 'error', message: openEdgesMessage(2) });
  assert.deepEqual(openEdgesDiagnostic(new Uint8Array(d.buffer), r), openEdgesDiagnostic(d, r));
  assert.equal(openEdgesDiagnostic(d, quads(d)), undefined);
  assert.equal(openEdgesCount([{ severity: 'error', message: openEdgesMessage(7) },
    { severity: 'error', message: openEdgesMessage(5) }, { severity: 'warning', message: openEdgesMessage(100) },
    { severity: 'error', message: '3 faces failed to mesh' }]), 12);
  assert.equal(openEdgesCount([]), 0);
});

test('open edges: free edges (one face\'s) are never open; a polyline segment no triangle has isn\'t judged open', () => {
  // Two unit squares used as sheets, each edge one face's: one triangle has each boundary segment.
  const sheets = withoutIds().finish();
  assert.deepEqual(openEdges(sheets, quads(sheets)).open, []);
  // A polyline with a point the mesh lacks (its middle): its segments are no mesh edge's, so not open; only a segment
  // one triangle has is.
  const d = cube().finish();
  const r = quads(d);
  const e = r.edges![0]!, p = r.edgePositions!;
  const a = p.subarray(3 * e.start, 3 * e.start + 3), b = p.subarray(3 * e.start + 3, 3 * e.start + 6);
  const finer = new Float32Array(p.length + 3);
  finer.set(p.subarray(0, 3 * e.start));
  finer.set([...a, ...a.map((x, i) => (x + b[i]!) / 2), ...b], 3 * e.start);
  finer.set(p.subarray(3 * e.start + 6), 3 * e.start + 9);
  const edges = r.edges!.map((x, k) => (k === 0 ? { ...x, count: 3 } : { ...x, start: x.start + 1 }));
  assert.deepEqual(openEdges(d, { ...r, edgePositions: finer, edges }).open, []);
});
