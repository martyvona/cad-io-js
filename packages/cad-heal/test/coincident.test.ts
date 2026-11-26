import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, BrepBuilder, type BrepData, validateBrep, writeBrep } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { LENGTH, MIN_LENGTH, mergeCoincident } from '../src/fix/coincident.ts';

const module = await init();

const line = (a: number[], b: number[]) => ({ kind: 'line' as const, point: a,
  direction: [b[0]! - a[0]!, b[1]! - a[1]!, 0].map((x, _, v) => x / Math.hypot(...v)), magnitude: 1 });
const quad = (p: number[][]) => ({ kind: 'bspline' as const, degree: 2, knots: [0, 1], multiplicities: [3, 3],
  poles: p, closed: false, selfIntersect: false, form: 'unspecified' as const });

/**
 * Three faces on the plane z = 0: F (id 1) between A, the x axis from (L, 0) to V = (0, 0), and B, the parabola
 * y = k x^2 from V to (L, k L^2), closed by C down x = L; F_a (id 2) below A, to y = -5; F_b (id 3) above B, to
 * y = k L^2 + 5. F's loop runs out of V along A's way back: a cusp, B within `tol` of A for sqrt(tol / k) from V.
 * Edges A, B, C ids 11, 12, 13, each of tolerance `tol`; uncertainty 1e-6. (B's slope at L, 2 k L, kept well under
 * 10: steeper, B and C would make a cusp at their corner too.) `disk`: a fourth face (id 4), a disk on z = 10 bounded
 * by a circle edge without vertices (a curve-bounded surface's boundary). `pcurve`: A's uses given p-curves (the
 * plane's (u, v) is (x, y)), B-spline lines at half its parameter, and no range (as sources give them).
 */
function cusp(k: number, tol: number, L = 10, disk = false, pcurve = false): BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const h = k * L * L, top = h + 5;
  const pts: number[][] = [];
  const P = (x: number, y: number) => (pts.push([x, y, 0]), b.addVertex({ point: [x, y, 0] }));
  const V = P(0, 0), P0 = P(L, 0), Q = P(L, h), a1 = P(L, -5), a2 = P(0, -5), b1 = P(0, top), b2 = P(L, top);
  const E = (c: ReturnType<typeof line> | ReturnType<typeof quad>, s: number, e: number, id = 0) =>
    b.addEdge({ curve: b.addCurve(c), start: s, end: e, sameSense: true, tolerance: tol, ...(id ? { id } : {}) });
  const pt = (v: number) => pts[v]!;
  const A = E(line([L, 0, 0], [0, 0, 0]), P0, V, 11);
  const B = E(quad([[0, 0, 0], [L / 2, 0, 0], [L, h, 0]]), V, Q, 12);
  const C = E(line([L, h, 0], [L, 0, 0]), Q, P0, 13);
  const ea = [E(line(pt(P0), pt(a1)), P0, a1), E(line(pt(a1), pt(a2)), a1, a2), E(line(pt(a2), pt(V)), a2, V)];
  const eb = [E(line(pt(V), pt(b1)), V, b1), E(line(pt(b1), pt(b2)), b1, b2), E(line(pt(b2), pt(Q)), b2, Q)];
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  const rev = (edge: number) => ({ edge, orientation: 'reversed' as const });
  const face = (id: number, coedges: { edge: number; orientation: 'forward' | 'reversed'; pcurve?: number }[]) =>
    ({ face: b.addFace({ surface: plane, sameSense: true, id, loops: [{ kind: 'edge', bound: 'outer', coedges }] }),
      sense: true });
  // (A bounded p-curve: a line's has no ends to tell the use's start by.)
  const pc = () => pcurve ? { pcurve: b.addCurve({ kind: 'bspline', degree: 1, knots: [0, L / 2],
    multiplicities: [2, 2], poles: [[L, 0], [0, 0]], closed: false, selfIntersect: false, form: 'unspecified' }) } : {};
  const faces = [face(1, [{ ...fwd(A), ...pc() }, fwd(B), fwd(C)]), face(2, [{ ...rev(A), ...pc() }, ...ea.map(fwd)]),
    face(3, [rev(B), ...eb.map(fwd)])];
  if (disk) {
    const at = { origin: [0, 0, 10], axis: [0, 0, 1], xDir: [1, 0, 0] };
    const circle = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: at, radius: 1 }), sameSense: true,
      range: [0, 2 * Math.PI] });
    faces.push({ face: b.addFace({ surface: b.addSurface({ kind: 'plane', position: at }), sameSense: true, id: 4,
      loops: [{ kind: 'edge', bound: 'outer', coedges: [fwd(circle)] }] }), sense: true });
  }
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  const d = b.finish();
  if (!disk) return d;
  // (The builder gives the circle a vertex; a source's curve-bounded boundary has none: -1, its vertex left unused.)
  const e = d.edge.curve.length - 1, none = (xs: Int32Array) => xs.map((v, i) => i === e ? -1 : v);
  const start = none(d.edge.start), end = none(d.edge.end);
  return writeBrep((c) => c.table === 'edge' && c.column === 'start' ? start : c.table === 'edge' && c.column === 'end'
    ? end : (d as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!);
}

/** A sliver F (id 1) between A, the x axis from (0, 0) to (10, 0), and B back from (10, 0) to (0, 0) bulging `bulge`
 * in y; F_a (id 2) below A, F_b (id 3) above B. */
function sliver(bulge: number, tol: number): BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const pts: number[][] = [];
  const P = (x: number, y: number) => (pts.push([x, y, 0]), b.addVertex({ point: [x, y, 0] }));
  const v0 = P(0, 0), v1 = P(10, 0), a1 = P(10, -5), a2 = P(0, -5), b1 = P(10, 5), b2 = P(0, 5);
  const E = (c: ReturnType<typeof line> | ReturnType<typeof quad>, s: number, e: number, id = 0) =>
    b.addEdge({ curve: b.addCurve(c), start: s, end: e, sameSense: true, tolerance: tol, ...(id ? { id } : {}) });
  const pt = (v: number) => pts[v]!;
  const A = E(line([0, 0, 0], [10, 0, 0]), v0, v1, 11);
  const B = E(quad([[10, 0, 0], [5, 2 * bulge, 0], [0, 0, 0]]), v1, v0, 12);
  const ea = [E(line(pt(v1), pt(a1)), v1, a1), E(line(pt(a1), pt(a2)), a1, a2), E(line(pt(a2), pt(v0)), a2, v0)];
  const eb = [E(line(pt(v0), pt(b2)), v0, b2), E(line(pt(b2), pt(b1)), b2, b1), E(line(pt(b1), pt(v1)), b1, v1)];
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  const rev = (edge: number) => ({ edge, orientation: 'reversed' as const });
  const face = (id: number, coedges: { edge: number; orientation: 'forward' | 'reversed' }[]) =>
    ({ face: b.addFace({ surface: plane, sameSense: true, id, loops: [{ kind: 'edge', bound: 'outer', coedges }] }),
      sense: true });
  const faces = [face(1, [fwd(A), fwd(B)]), face(2, [rev(A), ...ea.slice().reverse().map(rev)]),
    face(3, [rev(B), ...eb.slice().reverse().map(rev)])];
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  return b.finish();
}

const errors = (d: BrepData) => validateBrep(d).filter((x) => x.severity === 'error').map((x) => x.message);
const loopOf = (d: BrepData, id: number) => {
  const f = [...d.face.id].indexOf(id), l = d.face.firstLoop[f]!;
  return Array.from({ length: d.loop.count[l]! }, (_, k) => d.loop.first[l]! + k);
};
const usesOf = (d: BrepData, e: number) => [...d.coedge.edge].filter((x) => x === e).length;
const at = (d: BrepData, v: number) => [0, 1, 2].map((k) => d.vertex.point[3 * v + k]!);

test('coincidentEdges: a cusp merged up to where its edges part, the stretch one edge shared by the neighbours',
  async () => {
    // y = x^2 / 100 within 0.01 of the axis for x < 1.
    const d = cusp(0.01, 0.01);
    assert.deepEqual(errors(d), []);
    const r = mergeCoincident(module, d)!;
    assert.ok(r, 'merged');
    assert.equal(r.merged.length, 1);
    const m = r.merged[0]!;
    assert.deepEqual([m.face, ...m.edges], [1, 11, 12]);
    // B is within the tolerance for x < 1 (y = 0.01), and parts from A past a tenth of it at x = 0.316 (y = 0.001):
    // merged up to there, measured along B.
    assert.ok(Math.abs(m.length - Math.sqrt(0.1)) < 0.001, `length ${m.length}`);
    assert.ok(Math.abs(m.distance - 0.001) < 1e-6, `distance ${m.distance}`);
    const x = r.model;
    assert.deepEqual(errors(x), []);
    assert.deepEqual(r.removed, []);
    // One vertex and one edge more: A and B split, B's stretch gone into A's.
    assert.equal(x.vertex.id.length, d.vertex.id.length + 1);
    assert.equal(x.edge.id.length, d.edge.id.length + 1);
    // F keeps three uses (A's and B's far pieces and C), meeting at the new vertex near (0.316, 0.0005); F_a and F_b
    // one more each, the shared stretch used once each way.
    const F = loopOf(x, 1), Fa = loopOf(x, 2), Fb = loopOf(x, 3);
    assert.equal(F.length, 3);
    assert.equal(Fa.length, 5);
    assert.equal(Fb.length, 5);
    const shared = Fa.map((c) => x.coedge.edge[c]!).filter((e) => Fb.some((c) => x.coedge.edge[c] === e));
    assert.equal(shared.length, 1);
    const s = shared[0]!;
    assert.equal(usesOf(x, s), 2);
    const [ca, cb] = [Fa, Fb].map((l) => l.find((c) => x.coedge.edge[c] === s)!);
    assert.notEqual(x.coedge.orientation[ca!], x.coedge.orientation[cb!]);
    const P = x.edge.start[s] === 0 ? x.edge.end[s]! : x.edge.start[s]!;
    const p = at(x, P);
    assert.ok(Math.abs(p[0]! - Math.sqrt(0.1)) < 0.001 && Math.abs(p[1]! - 0.0005) < 1e-4, `the parting vertex ${p}`);
    // The new vertex's tolerance reaches both split points (0.001 apart): half that.
    assert.ok(Math.abs(x.vertex.tolerance[P]! - 0.0005) < 1e-5, `its tolerance ${x.vertex.tolerance[P]}`);
    // The stretch is on A's curve (the x axis), its end at V.
    const g = new Geometry(module, new Uint8Array(x.buffer));
    const ends = [x.edge.start[s]!, x.edge.end[s]!].map((v) => at(x, v));
    assert.ok(ends.some((q) => Math.hypot(...q) < 1e-12), 'one end V');
    g.dispose();
    // Ids: each piece keeps its edge's source id, the stretch A's (11 twice, B's far piece 12).
    assert.deepEqual([...x.edge.id].filter((i) => i === 11 || i === 12).sort(), [11, 11, 12], `${[...x.edge.id]}`);
    assert.equal(x.edge.id[s], 11);
    // A (from (10, 0) to V, its parameter the distance from (10, 0)) split at 10 - 0.316: its own piece from 0, the
    // stretch to 10.
    const a = [...x.edge.id].indexOf(11);
    assert.ok(Math.abs(x.edge.range[2 * a]!) < 1e-12
      && Math.abs(x.edge.range[2 * a + 1]! - (10 - Math.sqrt(0.1))) < 0.001,
      `A's range ${x.edge.range.slice(2 * a, 2 * a + 2)}`);
    assert.ok(Math.abs(x.edge.range[2 * s]! - x.edge.range[2 * a + 1]!) < 1e-12 && x.edge.range[2 * s + 1] === 10,
      `the stretch's range ${x.edge.range.slice(2 * s, 2 * s + 2)}`);
  });

test('coincidentEdges: a split use\'s p-curve at another parameter than its edge\'s, without a range, cut at the split '
  + 'point\'s', () => {
  const d = cusp(0.01, 0.01, 10, false, true);
  assert.deepEqual(errors(d), []);
  const r = mergeCoincident(module, d)!;
  assert.ok(r);
  assert.equal(r.pcurvesDropped, 0);
  const x = r.model, a = [...x.edge.id].indexOf(11);
  // A's own piece, from (10, 0) to x = 0.316 (its parameter 0 to 9.684): the p-curve's 0 to 4.842, in both its uses
  // (F's runs it forward, F_a's back).
  const uses = [...x.coedge.edge.keys()].filter((c) => x.coedge.edge[c] === a);
  assert.equal(uses.length, 2);
  for (const c of uses) assert.ok(x.coedge.pcurve[c]! >= 0, 'kept');
  // The stretch's uses (F_a's, and F_b's from B) are bare.
  const g = new Geometry(module, new Uint8Array(x.buffer));
  // (A coedge's range is in its edge's start-to-end order whichever way the use runs: the piece's start, (10, 0),
  // first.)
  for (const c of uses) {
    assert.ok(Math.abs(x.coedge.range[2 * c]!) < 1e-9
      && Math.abs(x.coedge.range[2 * c + 1]! - (10 - Math.sqrt(0.1)) / 2) < 0.001,
      `range ${x.coedge.range.slice(2 * c, 2 * c + 2)}`);
    const p = g.evalCoedge(c, [x.coedge.range[2 * c]!], 0).values;
    assert.ok(Math.hypot(p[0]! - 10, p[1]!) < 1e-9, `the piece starts at (10, 0): ${p[0]}, ${p[1]}`);
  }
  g.dispose();
});

test('coincidentEdges: a model with an edge without vertices (a curve-bounded face\'s) written again whole', () => {
  const d = cusp(0.01, 0.01, 10, true);
  assert.deepEqual(errors(d), []);
  const r = mergeCoincident(module, d)!;
  assert.ok(r);
  assert.deepEqual(errors(r.model), []);
  const circle = (m: BrepData) => [...m.edge.curve].findIndex((c) => m.curve.kind[c] === 2);
  const e0 = circle(d), e = circle(r.model);
  assert.deepEqual([d.edge.start[e0], d.edge.end[e0]], [-1, -1]);
  assert.deepEqual([r.model.edge.start[e], r.model.edge.end[e]], [-1, -1]);
});

test('coincidentEdges: a sliver within the tolerance end to end removed, its two edges one', async () => {
  // (Within a tenth of the tolerance end to end.)
  const d = sliver(0.0005, 0.01);
  assert.deepEqual(errors(d), []);
  const r = mergeCoincident(module, d)!;
  assert.ok(r);
  assert.deepEqual(r.removed, [1]);
  const x = r.model;
  assert.deepEqual(errors(x), []);
  assert.deepEqual([...x.face.id], [2, 3]);
  assert.equal(x.edge.id.length, d.edge.id.length - 1);
  assert.equal(x.vertex.id.length, d.vertex.id.length);
  // A (id 11) now F_a's and F_b's, once each way.
  const a = [...x.edge.id].indexOf(11);
  assert.equal(usesOf(x, a), 2);
  assert.ok(![...x.edge.id].includes(12));
  // The faces' maps to the given rows.
  assert.deepEqual([...r.faceFrom], [1, 2]);
});

test('coincidentEdges: what isn\'t merged: a corner, a stretch under LENGTH x the tolerance or MIN_LENGTH, the '
  + 'sliver wider than its tolerance', () => {
  // The parabola y = 2 x^2 within 0.01 for x < 0.07: under 10 x the tolerance.
  assert.equal(mergeCoincident(module, cusp(2, 0.01, 1)), undefined);
  // y = x^2 / 10 at the part's 1e-6 (an edge's tolerance under it is widened to it): within it for 0.0032 mm, past
  // 10 x it but under MIN_LENGTH.
  assert.ok(Math.sqrt(1e-6 / 0.1) < MIN_LENGTH && Math.sqrt(1e-6 / 0.1) > LENGTH * 1e-6);
  assert.equal(mergeCoincident(module, cusp(0.1, 1e-7)), undefined);
  // y = x^2 / 100 there: within it for 0.01 mm, past MIN_LENGTH, but parting by a tenth of it at 0.0032 mm: what
  // would be merged is under MIN_LENGTH.
  assert.equal(mergeCoincident(module, cusp(0.01, 1e-7)), undefined);
  // y = x^2 / 1000 there: within a tenth of it for 0.01 mm: merged.
  assert.ok(mergeCoincident(module, cusp(0.001, 1e-7)));
  // A sliver bulging 0.05 at a tolerance of 0.01: its edges part.
  assert.equal(mergeCoincident(module, sliver(0.05, 0.01))?.removed.length ?? 0, 0);
});

test('coincidentEdges in healPart: said, switched off by name, healed again from the source the analysis keeps',
  async () => {
    const d = cusp(0.01, 0.01);
    const on = await healPart(d, {}, module);
    assert.ok(on.changed);
    const said = on.diagnostics.filter((x) => x.message.startsWith('coincidentEdges'));
    assert.equal(said.length, 1);
    assert.equal(said[0]!.severity, 'warning');
    assert.match(said[0]!.message, new RegExp(String.raw`^coincidentEdges: 1 stretch of consecutive edges within `
      + String.raw`their tolerance of each other merged, up to 0\.316 mm long \(face #1's #11 and #12 \(0\.316 mm, `
      + String.raw`within 0\.0010 of 0\.010\)\)$`));
    const a = await analysisFor(on.model, on.analysis!);
    // The source kept whole.
    assert.deepEqual(new Uint8Array(a.source.model), new Uint8Array(d.buffer));
    assert.equal(a.vertex.givenTolerance.length, on.model.vertex.id.length);
    const off = await healPart(d, { fixes: { coincidentEdges: false } }, module);
    assert.ok(!off.diagnostics.some((x) => x.message.startsWith('coincidentEdges')));
    assert.equal(off.model.edge.id.length, d.edge.id.length);
    // heal(heal(m, A), B) = heal(m, B), both ways, and healing off gives the source back.
    const again = await healPart(on.model, { fixes: { coincidentEdges: false } }, module, undefined, on.analysis);
    assert.deepEqual(new Uint8Array(again.model.buffer), new Uint8Array(off.model.buffer));
    assert.deepEqual(new Uint8Array(again.analysis!.buffer), new Uint8Array(off.analysis!.buffer));
    const back = await healPart(off.model, {}, module, undefined, off.analysis);
    assert.deepEqual(new Uint8Array(back.model.buffer), new Uint8Array(on.model.buffer));
    const none = await healPart(on.model, { heal: false }, module, undefined, on.analysis);
    assert.deepEqual(new Uint8Array(none.model.buffer), new Uint8Array(d.buffer));
    // The same options again: nothing to do.
    const same = await healPart(on.model, {}, module, undefined, on.analysis);
    assert.equal(same.changed, false);
  });

/**
 * A triangle F (id 1) as trj12_b3 #23876 has it: A along the x axis from W = (1, 0) to V = (0, 0), B from V to
 * Q = (0.9, q) within the tolerance 0.01 of A whole (within a tenth of it where q is), C from Q back to W. F_a (2)
 * below A, F_b (3) above B and C. Merging B into A leaves F a lens of A's piece from Q's foot to W and C, within q of
 * each other.
 */
function triangle(q: number, qx = 0.9): BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const pts: number[][] = [];
  const P = (x: number, y: number) => (pts.push([x, y, 0]), b.addVertex({ point: [x, y, 0] }));
  const W = P(1, 0), V = P(0, 0), Q = P(qx, q), a1 = P(1, -5), a2 = P(0, -5), b1 = P(0, 5), b2 = P(1, 5);
  const E = (c: ReturnType<typeof line> | ReturnType<typeof quad>, s: number, e: number, id = 0) =>
    b.addEdge({ curve: b.addCurve(c), start: s, end: e, sameSense: true, tolerance: 0.01, ...(id ? { id } : {}) });
  const L = (s: number, e: number, id = 0) => E(line(pts[s]!, pts[e]!), s, e, id);
  const A = L(W, V, 11), B = E(quad([[0, 0, 0], [qx / 2, 0, 0], [qx, q, 0]]), V, Q, 12), C = L(Q, W, 13);
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  const rev = (edge: number) => ({ edge, orientation: 'reversed' as const });
  const face = (id: number, coedges: { edge: number; orientation: 'forward' | 'reversed' }[]) =>
    ({ face: b.addFace({ surface: plane, sameSense: true, id, loops: [{ kind: 'edge', bound: 'outer', coedges }] }),
      sense: true });
  const faces = [face(1, [fwd(A), fwd(B), fwd(C)]), face(2, [rev(A), fwd(L(W, a1)), fwd(L(a1, a2)), fwd(L(a2, V))]),
    face(3, [rev(B), fwd(L(V, b1)), fwd(L(b1, b2)), fwd(L(b2, W)), rev(C)])];
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  return b.finish();
}

test('coincidentEdges: a face the merge leaves a lens within the tolerance removed, its two edges one', () => {
  const d = triangle(0.0005);
  assert.deepEqual(errors(d), []);
  const r = mergeCoincident(module, d)!;
  assert.ok(r);
  assert.deepEqual(r.removed, [1]);
  const x = r.model;
  assert.deepEqual(errors(x), []);
  assert.deepEqual([...x.face.id], [2, 3]);
  // C (13) gone into A's piece, B (12) into the stretch.
  assert.ok(![...x.edge.id].includes(12) && ![...x.edge.id].includes(13), `${[...x.edge.id]}`);
  // Each edge used once each way by F_a and F_b, along the x axis from W to V through Q's foot.
  for (const e of [...x.coedge.edge]) assert.ok(usesOf(x, e) <= 2);
});

test('coincidentEdges: an edge within the tolerance whole: the other split at its far vertex\'s foot', () => {
  // Q 0.0009 off A: B within a tenth of the tolerance of A whole, so Q stays and A is split at Q's own foot (0.9, 0);
  // the lens it leaves (C within 0.0009 of A's piece) removed too.
  const r = mergeCoincident(module, triangle(0.0009))!;
  assert.ok(r);
  assert.deepEqual(r.removed, [1]);
  const x = r.model, q = [...x.vertex.id].findIndex((_, v) => x.vertex.point[3 * v] === 0.9);
  assert.ok(q >= 0);
  const a = [...x.edge.id].indexOf(11);
  assert.ok(Math.abs(x.edge.range[2 * a + 1]! - 0.1) < 1e-6, `A's range ${x.edge.range.slice(2 * a, 2 * a + 2)}`);
  assert.ok(Math.abs(x.vertex.tolerance[q]! - 0.0009) < 1e-9, `Q's tolerance ${x.vertex.tolerance[q]}`);
});

test('coincidentEdges: a lens shorter than LENGTH x the tolerance left by a merge removed (only the lens rule does)',
  () => {
    // C 0.05 long beside A's piece: no pair of its own (under 10 x 0.01), the lens removed by the merge itself.
    const r = mergeCoincident(module, triangle(0.0005, 0.95))!;
    assert.ok(r);
    assert.deepEqual(r.removed, [1]);
    assert.deepEqual(errors(r.model), []);
  });

test('coincidentEdges: a loop not in trouble left (gate (b)): two edges leaving their vertex at 0.05 rad', () => {
  // B the line y = 0.05 x from V: within 0.01 of A for x < 0.2 (20 x the tolerance, past MIN_LENGTH), never crossing
  // it, the face API seeing nothing in the loop: no merge.
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const pts: number[][] = [];
  const P = (x: number, y: number) => (pts.push([x, y, 0]), b.addVertex({ point: [x, y, 0] }));
  const V = P(0, 0), P0 = P(10, 0), Q = P(10, 0.5);
  const L = (s: number, e: number, id = 0) => b.addEdge({ curve: b.addCurve(line(pts[s]!, pts[e]!)), start: s, end: e,
    sameSense: true, tolerance: 0.01, ...(id ? { id } : {}) });
  const face = b.addFace({ surface: plane, sameSense: true, id: 1, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: L(P0, V, 11), orientation: 'forward' }, { edge: L(V, Q, 12), orientation: 'forward' },
    { edge: L(Q, P0, 13), orientation: 'forward' }] }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  assert.equal(mergeCoincident(module, b.finish()), undefined);
});
