import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder, type BrepData, validateBrep } from 'cad-brep';
import { init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { AGREE, APART, splitVertices } from '../src/fix/split.ts';

const module = await init();

interface Opts {
  h?: number;
  lean?: number;
  keep?: 'A' | 'D';
  sheet?: boolean;
  sewn?: boolean;
  broken?: boolean;
  edgeTol?: number;
  uncertainty?: number;
}

/**
 * Face 1 (id 1) on the plane z = 0, the rectangle A = (0, 0), B = (10, 0), C = (10, h), D = (0, h) (h 1 by default)
 * with one vertex V (id 5) for both A and D, at A (`keep` 'D': at D): the bottom (id 11) V to B, the right (id 12) B
 * to C, the top (id 13) C to V, its curve ending at D + (lean, 0) (lean 0 by default), and the left (id 14) from V
 * back to V, its curve from D down to A: trj3_s1-al #6704's #768. The part's uncertainty 1, its rows' tolerances
 * unset. `sheet`: face 2 (id 2), the square (0, 0), (0, -10), (-10, -10), (-10, 0), at V by edges of its own (ids 21
 * to 24). `sewn`: face 3 (id 3), the rectangle D, (0, 2h), (10, 2h), C below face 1's top, using it back, its left
 * edge (id 31) from (0, 2h) to V on a curve ending at D. `broken` (with `sheet`): face 2's last edge ends at a vertex
 * of its own at (0, 0), not V, so its loop doesn't close at V in topology. `edgeTol`: every edge's tolerance (unset by
 * default); `uncertainty` the part's (1 by default).
 */
function apart({ h = 1, lean = 0, keep = 'A', sheet = false, sewn = false, broken = false, edgeTol = NaN,
  uncertainty = 1 }: Opts = {}): BrepData {
  const b = new BrepBuilder({ uncertainty });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const vx = (p: number[], id = 0) => b.addVertex({ point: [p[0]!, p[1]!, 0], ...(id ? { id } : {}) });
  const V = vx(keep === 'A' ? [0, 0] : [0, h], 5), B = vx([10, 0]), C = vx([10, h]);
  const edge = (from: number, to: number, p: number[], q: number[], id = 0) => {
    const l = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!), dir = [(q[0]! - p[0]!) / l, (q[1]! - p[1]!) / l, 0];
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: [p[0]!, p[1]!, 0], direction: dir, magnitude: 1 }),
      range: [0, l], start: from, end: to, sameSense: true, ...(Number.isFinite(edgeTol) ? { tolerance: edgeTol } : {}),
      ...(id ? { id } : {}) });
  };
  const use = (e: number, orientation: 'forward' | 'reversed' = 'forward') => ({ edge: e, orientation });
  const top = edge(C, V, [10, h], [lean, h], 13);
  const faces: { face: number; sense: boolean }[] = [{ face: b.addFace({ surface: plane, sameSense: true, id: 1,
    loops: [{ kind: 'edge', bound: 'outer', coedges: [use(edge(V, B, [0, 0], [10, 0], 11)),
      use(edge(B, C, [10, 0], [10, h], 12)), use(top), use(edge(V, V, [0, h], [0, 0], 14))] }] }), sense: true }];
  if (sheet) {
    const Q1 = vx([0, -10]), Q2 = vx([-10, -10]), Q3 = vx([-10, 0]);
    faces.push({ face: b.addFace({ surface: plane, sameSense: true, id: 2, loops: [{ kind: 'edge', bound: 'outer',
      coedges: [use(edge(V, Q3, [0, 0], [-10, 0], 21)), use(edge(Q3, Q2, [-10, 0], [-10, -10], 22)),
        use(edge(Q2, Q1, [-10, -10], [0, -10], 23)),
        use(edge(Q1, broken ? vx([0, 0]) : V, [0, -10], [0, 0], 24))] }] }), sense: true });
  }
  if (sewn) {
    const E = vx([0, 2 * h]), F = vx([10, 2 * h]);
    faces.push({ face: b.addFace({ surface: plane, sameSense: true, id: 3, loops: [{ kind: 'edge', bound: 'outer',
      coedges: [use(top, 'reversed'), use(edge(C, F, [10, h], [10, 2 * h])), use(edge(F, E, [10, 2 * h], [0, 2 * h])),
        use(edge(E, V, [0, 2 * h], [0, h], 31))] }] }), sense: true });
  }
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  return b.finish();
}

const errors = (d: BrepData) => validateBrep(d).filter((x) => x.severity === 'error').map((x) => x.message);
const row = (xs: ArrayLike<number>, id: number) => Array.from(xs).indexOf(id);
const pointOf = (d: BrepData, v: number) => Array.from(d.vertex.point.subarray(3 * v, 3 * v + 3));

/** Edge `id`'s start and end vertices' points in d. */
function endsOf(d: BrepData, id: number): number[][] {
  const e = row(d.edge.id, id);
  return [pointOf(d, d.edge.start[e]!), pointOf(d, d.edge.end[e]!)];
}

test('vertexSplit: one vertex for two corners, its joints agreeing at each: the far corner given its own', () => {
  for (const keep of ['A', 'D'] as const) {
    const d = apart({ keep });
    assert.deepEqual(errors(d), []);
    const r = splitVertices(module, d)!;
    assert.ok(r, `found (keep ${keep})`);
    assert.equal(r.split.length, 1);
    const s = r.split[0]!;
    assert.equal(s.vertex, 5);
    assert.equal(s.added, 1);
    assert.equal(s.tolerance, 1);
    assert.ok(Math.abs(s.distance - 1) < 1e-12, `distance ${s.distance}`);
    const m = r.model;
    assert.deepEqual(errors(m), []);
    assert.equal(m.vertex.id.length, d.vertex.id.length + 1);
    // Every corner its own vertex: the left edge from D to A, the top ending at D, the bottom starting at A.
    assert.deepEqual(endsOf(m, 14), [[0, 1, 0], [0, 0, 0]]);
    assert.deepEqual(endsOf(m, 13)[1], [0, 1, 0]);
    assert.deepEqual(endsOf(m, 11)[0], [0, 0, 0]);
    // V kept for the corner at its point; the new one made by the fix, the moved edges said.
    const nv = m.vertex.id.length - 1;
    assert.equal(r.vertexFrom[nv], -1);
    assert.equal(m.vertex.id[nv], 0);
    const v5 = row(m.vertex.id, 5);
    assert.deepEqual(pointOf(m, v5), keep === 'A' ? [0, 0, 0] : [0, 1, 0]);
    assert.deepEqual(s.edges.sort(), keep === 'A' ? [13, 14] : [11, 14]);
    for (let i = 0; i < nv; i++) assert.equal(m.vertex.id[r.vertexFrom[i]!] ?? -1, d.vertex.id[r.vertexFrom[i]!]);
    assert.deepEqual(Array.from(r.edgeFrom), Array.from(d.edge.id, (_, i) => i));
  }
});

test('vertexSplit: the joints at a corner agree within AGREE x the tolerance and the corners are APART x it apart',
  () => {
    // A corner's two ends 1.2 x AGREE apart: its uses don't say where they meet, the vertex left; 0.8 x, split.
    assert.equal(splitVertices(module, apart({ lean: 1.2 * AGREE })), undefined);
    assert.equal(splitVertices(module, apart({ lean: 0.8 * AGREE }))?.split.length, 1);
    // The corners 0.8 x APART apart: one point within the tolerance, left; 1.2 x, split.
    assert.equal(splitVertices(module, apart({ h: 0.8 * APART })), undefined);
    assert.equal(splitVertices(module, apart({ h: 1.2 * APART }))?.split.length, 1);
  });

test('vertexSplit: the tolerance the largest of the vertex\'s and its edges\'', () => {
  // Edges at 1, the part at 0.01: a corner's ends 0.5 x AGREE x 1 apart agree.
  const r = splitVertices(module, apart({ lean: 0.5 * AGREE, edgeTol: 1, uncertainty: 0.01 }));
  assert.equal(r?.split[0]?.tolerance, 1);
  // Edges unset, the part at 0.01: the same ends don't.
  assert.equal(splitVertices(module, apart({ lean: 0.5 * AGREE, uncertainty: 0.01 })), undefined);
});

test('vertexSplit: an unsewn face at a vertex, its joints a group of its own at one point, isn\'t split off', () => {
  const r = splitVertices(module, apart({ sheet: true }))!;
  // (Only D's corner: face 2's edges stay at V with face 1's bottom.)
  assert.equal(r.split.length, 1);
  assert.deepEqual(r.split[0]!.edges.sort(), [13, 14]);
  for (const id of [21, 24]) assert.ok(endsOf(r.model, id).some((p) => p.every((x, k) => x === [0, 0, 0][k])), `${id}`);
  // Face 2's loop not closing at V in topology: its uses don't say where they meet, V left.
  assert.equal(splitVertices(module, apart({ sheet: true, broken: true })), undefined);
  // Face 1's left corners within APART x the tolerance: one point, no split at all.
  assert.equal(splitVertices(module, apart({ sheet: true, h: 0.8 * APART })), undefined);
});

test('vertexSplit: a corner joined through another face\'s loop moves together', () => {
  const r = splitVertices(module, apart({ sewn: true }))!;
  assert.equal(r.split.length, 1);
  assert.deepEqual(r.split[0]!.edges.sort(), [13, 14, 31]);
  assert.deepEqual(errors(r.model), []);
  assert.deepEqual(endsOf(r.model, 31)[1], [0, 1, 0]);
});

test('vertexSplit in healPart: its diagnostic, its switch, no tolerance grown for the gap, healing again', async () => {
  const d = apart({ h: 1.2 });
  const r = await healPart(d, {}, module);
  const said = r.diagnostics.find((x) => x.message.startsWith('vertexSplit'))?.message;
  assert.equal(said, 'vertexSplit: 1 vertex whose uses meet at points apart, each given a vertex of its own: #5 (a '
    + 'vertex 1.20 mm from it at a tolerance of 1.00, for #13, #14)');
  assert.ok(r.changed);
  assert.equal(r.model.vertex.id.length, d.vertex.id.length + 1);
  assert.equal(r.diagnostics.find((x) => x.message.startsWith('tolerances grown')), undefined);
  const off = await healPart(d, { fixes: { vertexSplit: false } }, module);
  assert.equal(off.diagnostics.find((x) => x.message.startsWith('vertexSplit')), undefined);
  assert.equal(off.model.vertex.id.length, d.vertex.id.length);
  // (Without it, V's tolerance grown to cover the far corner.)
  assert.ok(off.model.vertex.tolerance[row(off.model.vertex.id, 5)]! >= 1.2, 'grown');
  assert.ok(!(r.model.vertex.tolerance[row(r.model.vertex.id, 5)]! > 1), 'not grown');
  const again = await healPart(r.model, {}, module, undefined, r.analysis);
  assert.equal(again.changed, false);
  assert.deepEqual(new Uint8Array(again.model.buffer), new Uint8Array(r.model.buffer));
  const back = await healPart(r.model, { fixes: { vertexSplit: false } }, module, undefined, r.analysis);
  assert.equal(back.model.vertex.id.length, d.vertex.id.length);
});
