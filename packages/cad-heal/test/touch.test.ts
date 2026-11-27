import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder, type BrepData, LOOP_KIND, validateBrep } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { mendTouches, rowsFrom, TOUCH } from '../src/fix/touch.ts';

const module = await init();

interface Opts {
  at?: 'edge' | 'vertex';
  gap?: number;
  x?: number;
  pcurve?: 'none' | 'edge' | 'own';
  neighbour?: boolean;
  joined?: boolean;
  vloop?: boolean;
  second?: boolean;
}

/**
 * Face 1 (id 1) on the plane z = 0: its outer loop the square (0, 0), (10, 0), (10, 10), (0, 10), its bottom edge
 * (id 11, from P1 = (0, 0) to P2 = (10, 0), parameter x) or, `at` 'vertex', two edges (11 to M = (x, 0), id 22; 12
 * from M on); its hole a triangle H (id 21) = (x, gap), (x + 1, 3), (x - 1, 3), run clockwise. `x` 5 by default. Vertex
 * and edge tolerances 1e-3, uncertainty 1e-6. `pcurve`: the bottom edge's use's p-curve ((u, v) is (x, y)), none with
 * a range: 'edge' a line at its edge's parameter, 'own' a B-spline segment over [0, 1]. `neighbour`: face 2 (id 2)
 * below, (0, 0), (0, -10), (10, -10), (10, 0), using the bottom edge(s) back. `joined`: an edge (id 19) from H to M,
 * used by no face. `vloop`: face 2 (`neighbour` on) has an inner vertex loop at H. `second`: a second hole, the
 * triangle (3, 10) (id 31), (4, 7), (2, 7), touching the top edge (id 13, from (10, 10) to (0, 10)) mid-span.
 */
function touching({ at = 'edge', gap = 0, x = 5, pcurve = 'none', neighbour = false, joined = false, vloop = false,
  second = false }: Opts = {}): BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const vx = (p: number[], id = 0) => b.addVertex({ point: [p[0]!, p[1]!, 0], tolerance: 1e-3, ...(id ? { id } : {}) });
  const P1 = vx([0, 0]), P2 = vx([10, 0]), P3 = vx([10, 10]), P4 = vx([0, 10]);
  const H = vx([x, gap], 21), H2 = vx([x + 1, 3]), H3 = vx([x - 1, 3]);
  const line = (p: number[], q: number[], id = 0, s = 0) => {
    const l = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!), dir = [(q[0]! - p[0]!) / l, (q[1]! - p[1]!) / l, 0];
    return { curve: b.addCurve({ kind: 'line', point: [p[0]! - s * dir[0]!, p[1]! - s * dir[1]!, 0], direction: dir,
      magnitude: 1 }), range: [s, s + l] as [number, number], ...(id ? { id } : {}) };
  };
  const edge = (from: number, to: number, p: number[], q: number[], id = 0, s = 0) =>
    b.addEdge({ ...line(p, q, id, s), start: from, end: to, sameSense: true, tolerance: 1e-3 });
  const use = (e: number, orientation: 'forward' | 'reversed' = 'forward', pc = -1) =>
    ({ edge: e, orientation, ...(pc >= 0 ? { pcurve: pc } : {}) });
  // The bottom: one edge, or two meeting at M.
  let bottom: number[];
  let M = -1;
  const pcOf = (p: number[], q: number[], s: number) => pcurve === 'edge' ? b.addCurve({ kind: 'line',
    point: [p[0]! - s, 0], direction: [1, 0], magnitude: 1 }) : pcurve === 'own' ? b.addCurve({ kind: 'bspline',
    degree: 1, knots: [0, 1], multiplicities: [2, 2], poles: [p, q], closed: false, selfIntersect: false,
    form: 'unspecified' }) : -1;
  const bottomUses: ReturnType<typeof use>[] = [];
  if (at === 'edge') {
    bottom = [edge(P1, P2, [0, 0], [10, 0], 11)];
    bottomUses.push(use(bottom[0]!, 'forward', pcOf([0, 0], [10, 0], 0)));
  } else {
    M = vx([x, 0], 22);
    bottom = [edge(P1, M, [0, 0], [x, 0], 11), edge(M, P2, [x, 0], [10, 0], 12, x)];
    bottomUses.push(use(bottom[0]!, 'forward', pcOf([0, 0], [x, 0], 0)), use(bottom[1]!, 'forward', pcOf([x, 0],
      [10, 0], x)));
  }
  const right = edge(P2, P3, [10, 0], [10, 10]), top = edge(P3, P4, [10, 10], [0, 10], 13);
  const left = edge(P4, P1, [0, 10], [0, 0]);
  // The hole, clockwise: H to H3 to H2 and back.
  const h1 = edge(H, H3, [x, gap], [x - 1, 3]), h2 = edge(H3, H2, [x - 1, 3], [x + 1, 3]);
  const h3 = edge(H2, H, [x + 1, 3], [x, gap]);
  if (joined && M >= 0) edge(H, M, [x, gap], [x, 0], 19);
  // The second hole, clockwise: (3, 10) to (4, 7) to (2, 7).
  function secondHole() {
    const S = vx([3, 10], 31), S2 = vx([4, 7]), S3 = vx([2, 7]);
    return { kind: 'edge' as const, bound: 'inner' as const, coedges: [use(edge(S, S2, [3, 10], [4, 7])),
      use(edge(S2, S3, [4, 7], [2, 7])), use(edge(S3, S, [2, 7], [3, 10]))] };
  }
  const faces: { face: number; sense: boolean }[] = [{ face: b.addFace({ surface: plane, sameSense: true, id: 1,
    loops: [{ kind: 'edge', bound: 'outer', coedges: [...bottomUses, use(right), use(top), use(left)] },
      { kind: 'edge', bound: 'inner', coedges: [use(h1), use(h2), use(h3)] },
      ...(second ? [secondHole()] : [])] }), sense: true }];
  if (neighbour) {
    const Q1 = vx([0, -10]), Q2 = vx([10, -10]);
    const a = edge(P1, Q1, [0, 0], [0, -10]), c = edge(Q1, Q2, [0, -10], [10, -10]);
    const e2 = edge(Q2, P2, [10, -10], [10, 0]);
    faces.push({ face: b.addFace({ surface: plane, sameSense: true, id: 2, loops: [{ kind: 'edge', bound: 'outer',
      coedges: [use(a), use(c), use(e2), ...[...bottom].reverse().map((e) => use(e, 'reversed'))] },
    ...(vloop ? [{ kind: 'vertex' as const, bound: 'inner' as const, sense: true, vertex: H }] : [])] }),
    sense: true });
  }
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  return b.finish();
}

const errors = (d: BrepData) => validateBrep(d).filter((x) => x.severity === 'error').map((x) => x.message);
const rows = (xs: ArrayLike<number>, id: number) => Array.from(xs).flatMap((x, i) => x === id ? [i] : []);
const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a}`);

/** Face f's loops (rows of d) as lists of their coedges' [edge id, start vertex id, end vertex id] as they run. */
function loops(d: BrepData, id: number): [number, number, number][][] {
  const f = rows(d.face.id, id)[0]!, out: [number, number, number][][] = [];
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    const cs: [number, number, number][] = [];
    for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
      const e = d.coedge.edge[c]!, rev = d.coedge.orientation[c] !== 0;
      const s = d.vertex.id[d.edge.start[e]!]!, t = d.vertex.id[d.edge.end[e]!]!;
      cs.push([d.edge.id[e]!, rev ? t : s, rev ? s : t]);
    }
    out.push(cs);
  }
  return out;
}

/** Each loop of each face running end to end (each coedge's end its next's start). */
function chained(d: BrepData): boolean {
  for (let l = 0; l < d.loop.kind.length; l++) {
    const ends: [number, number][] = [];
    for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
      const e = d.coedge.edge[c]!, rev = d.coedge.orientation[c] !== 0;
      ends.push(rev ? [d.edge.end[e]!, d.edge.start[e]!] : [d.edge.start[e]!, d.edge.end[e]!]);
    }
    for (let k = 0; k < ends.length; k++) if (ends[k]![1] !== ends[(k + 1) % ends.length]![0]) return false;
  }
  return true;
}

test('vertexOnEdge: a hole\'s vertex on the outer loop\'s edge, mid-span: the edge split there, at that vertex', () => {
  for (const neighbour of [false, true]) {
    const d = touching({ neighbour });
    assert.deepEqual(errors(d), []);
    const r = mendTouches(module, d)!;
    assert.ok(r, `found (neighbour ${neighbour})`);
    assert.deepEqual(r.touched, [{ kind: 'split', face: 1, vertex: 21, other: 11, gap: 0 }]);
    const m = r.model;
    assert.deepEqual(errors(m), []);
    assert.ok(chained(m), 'chained');
    // Edge 11 two rows, the first from P1 to H, the second from H to P2, at x = 5.
    const e = rows(m.edge.id, 11);
    assert.equal(e.length, 2);
    assert.deepEqual(e.map((x) => [m.edge.range[2 * x], m.edge.range[2 * x + 1]]), [[0, 5], [5, 10]]);
    const h = rows(m.vertex.id, 21)[0]!;
    assert.equal(m.edge.end[e[0]!], h), assert.equal(m.edge.start[e[1]!], h);
    // The outer loop runs through H; the neighbour's uses both pieces back.
    assert.deepEqual(loops(m, 1)[0]!.slice(0, 2).map((c) => c[2]), [21, 0]);
    if (neighbour) assert.deepEqual(loops(m, 2)[0]!.slice(3).map((c) => c[0]), [11, 11]);
    if (neighbour) assert.deepEqual(loops(m, 2)[0]!.slice(3).map((c) => c[1]), [0, 21]);
    // The rows' given rows: both pieces from edge 11's, every vertex its own.
    assert.deepEqual(e.map((x) => d.edge.id[r.edgeFrom[x]!]), [11, 11]);
    assert.deepEqual(Array.from(r.vertexFrom), Array.from(d.vertex.id, (_, i) => i));
    assert.equal(rows(m.coedge.edge, e[0]!).length + rows(m.coedge.edge, e[1]!).length, neighbour ? 4 : 2);
  }
});

test('vertexOnEdge: the split use\'s p-curve cut at its edge\'s parameter, or at its own', () => {
  for (const pcurve of ['edge', 'own'] as const) {
    const d = touching({ pcurve });
    const r = mendTouches(module, d)!;
    assert.equal(r?.touched.length, 1, pcurve);
    assert.equal(r.pcurvesDropped, 0, pcurve);
    const m = r.model, e = rows(m.edge.id, 11), g = new Geometry(module, new Uint8Array(m.buffer));
    try {
      const cs = e.map((x) => rows(m.coedge.edge, x)[0]!);
      const want = pcurve === 'edge' ? [[0, 5], [5, 10]] : [[0, 0.5], [0.5, 1]];
      cs.forEach((c, k) => {
        assert.ok(m.coedge.pcurve[c]! >= 0, `${pcurve} ${k} keeps its p-curve`);
        near(m.coedge.range[2 * c]!, want[k]![0]!, 1e-9, `${pcurve} ${k} start`);
        near(m.coedge.range[2 * c + 1]!, want[k]![1]!, 1e-9, `${pcurve} ${k} end`);
      });
      // The first piece's p-curve ends at H's (u, v).
      const uv = g.evalCurve(m.coedge.pcurve[cs[0]!]!, [m.coedge.range[2 * cs[0]! + 1]!], 0).values;
      near(uv[0]!, 5, 1e-9, `${pcurve} u`), near(uv[1]!, 0, 1e-9, `${pcurve} v`);
    } finally {
      g.dispose();
    }
  }
});

test('vertexOnEdge: two vertex rows of two loops at one point merged into the first loop\'s', () => {
  const d = touching({ at: 'vertex' });
  const r = mendTouches(module, d)!;
  assert.ok(r, 'found');
  assert.deepEqual(r.touched, [{ kind: 'merged', face: 1, vertex: 22, other: 21, gap: 0 }]);
  const m = r.model;
  assert.deepEqual(errors(m), []);
  assert.ok(chained(m), 'chained');
  assert.deepEqual(rows(m.vertex.id, 21), []);
  assert.equal(m.vertex.id.length, d.vertex.id.length - 1);
  assert.deepEqual(loops(m, 1)[1]!.map((c) => c[1]), [22, 0, 0]);
  assert.equal(m.edge.id.length, d.edge.id.length);
  // M keeps its row's point and tolerance (the other's the same).
  const v = rows(m.vertex.id, 22)[0]!;
  assert.deepEqual([...m.vertex.point.subarray(3 * v, 3 * v + 3), m.vertex.tolerance[v]], [5, 0, 0, 1e-3]);
  assert.equal(d.vertex.id[r.vertexFrom[v]!], 22);
});

test('vertexOnEdge: the merged vertex\'s tolerance grown to reach the other\'s', () => {
  const b = touching({ at: 'vertex', gap: 0.5 * TOUCH * 1e-3 });
  const h = rows(b.vertex.id, 21)[0]!;
  const d = touching({ at: 'vertex', gap: 0.5 * TOUCH * 1e-3 });
  d.vertex.tolerance[h] = 2e-3;
  const r = mendTouches(module, d)!;
  assert.equal(r?.touched[0]?.kind, 'merged');
  const m = r.model, v = rows(m.vertex.id, 22)[0]!;
  near(m.vertex.tolerance[v]!, 2e-3 + 0.5 * TOUCH * 1e-3, 1e-15, 'grown');
});

test('vertexOnEdge: left where the loops are apart by more than TOUCH x the tolerance, the vertex is near the '
  + 'edge\'s end, or an edge joins the two vertices', () => {
  // Within TOUCH of the tolerance: mended; past it, left.
  assert.equal(mendTouches(module, touching({ gap: 0.5 * TOUCH * 1e-3 }))?.touched.length, 1);
  assert.equal(mendTouches(module, touching({ gap: 2 * TOUCH * 1e-3 })), undefined);
  assert.equal(mendTouches(module, touching({ at: 'vertex', gap: 0.5 * TOUCH * 1e-3 }))?.touched.length, 1);
  assert.equal(mendTouches(module, touching({ at: 'vertex', gap: 2 * TOUCH * 1e-3 })), undefined);
  // On the edge within its tolerance of an end (5e-4 from it): neither a split nor (5e-4 apart) a merge.
  assert.equal(mendTouches(module, touching({ x: 10 - 5e-4 })), undefined);
  assert.equal(mendTouches(module, touching({ x: 5e-4 })), undefined);
  // The controls: 2e-3 from the end, past the tolerance, split.
  assert.equal(mendTouches(module, touching({ x: 10 - 2e-3 }))?.touched[0]?.kind, 'split');
  assert.equal(mendTouches(module, touching({ x: 2e-3 }))?.touched[0]?.kind, 'split');
  assert.equal(mendTouches(module, touching({ at: 'vertex', joined: true })), undefined);
});

test('vertexOnEdge in healPart: its diagnostic, its switch, the source model kept for healing again', async () => {
  const d = touching({ neighbour: true });
  const r = await healPart(d, {}, module);
  const said = r.diagnostics.find((x) => x.message.startsWith('vertexOnEdge'))?.message;
  assert.equal(said, 'vertexOnEdge: loops of one face meeting at a point to rounding made to share a vertex there: '
    + '1 edge split at a vertex of another loop of the face lying on it (face #1\'s #11 at #21 (0.0 mm))');
  assert.ok(r.changed);
  assert.equal(rows(r.model.edge.id, 11).length, 2);
  const off = await healPart(d, { fixes: { vertexOnEdge: false } }, module);
  assert.equal(off.diagnostics.find((x) => x.message.startsWith('vertexOnEdge')), undefined);
  assert.equal(rows(off.model.edge.id, 11).length, 1);
  // Healed again (the model and its analysis): the same model, from the source the analysis keeps.
  const again = await healPart(r.model, {}, module, undefined, r.analysis);
  assert.equal(again.changed, false);
  assert.deepEqual(new Uint8Array(again.model.buffer), new Uint8Array(r.model.buffer));
  // And again with the fix off: back to the source's topology.
  const back = await healPart(r.model, { fixes: { vertexOnEdge: false } }, module, undefined, r.analysis);
  assert.equal(rows(back.model.edge.id, 11).length, 1);
});

test('vertexOnEdge: a vertex loop at the merged vertex follows it', () => {
  const m = mendTouches(module, touching({ at: 'vertex', neighbour: true, vloop: true }))!.model;
  assert.deepEqual(errors(m), []);
  const f = rows(m.face.id, 2)[0]!, l = m.face.firstLoop[f]! + 1;
  assert.equal(m.loop.kind[l], LOOP_KIND.vertex);
  assert.equal(m.vertex.id[m.loop.first[l]!], 22);
});

test('vertexOnEdge: two touches in one part, a merge then a split, each row mapped to its given row', () => {
  const d = touching({ at: 'vertex', second: true });
  const r = mendTouches(module, d)!;
  assert.deepEqual(r.touched.map((t) => [t.kind, t.vertex, t.other]), [['merged', 22, 21], ['split', 31, 13]]);
  const m = r.model;
  assert.deepEqual(errors(m), []);
  assert.ok(chained(m), 'chained');
  assert.equal(rows(m.edge.id, 13).length, 2);
  // Every row's given row: the same id, and for vertices the same point; edges the same curve.
  for (let v = 0; v < m.vertex.id.length; v++) {
    const k = r.vertexFrom[v]!;
    assert.equal(d.vertex.id[k], m.vertex.id[v], `vertex ${v}`);
    assert.deepEqual([...d.vertex.point.subarray(3 * k, 3 * k + 3)], [...m.vertex.point.subarray(3 * v, 3 * v + 3)]);
  }
  for (let e = 0; e < m.edge.id.length; e++) assert.equal(d.edge.curve[r.edgeFrom[e]!], m.edge.curve[e], `edge ${e}`);
  for (let c = 0; c < m.coedge.id.length; c++) {
    assert.equal(d.edge.curve[d.coedge.edge[r.coedgeFrom[c]!]!], m.edge.curve[m.coedge.edge[c]!], `coedge ${c}`);
  }
});

test('rowsFrom: a second fix\'s rows mapped through the first\'s to the given rows, made rows kept -1', () => {
  const i = (...xs: number[]) => Int32Array.from(xs);
  const first = { model: {} as BrepData, vertexFrom: i(2, -1, 0), edgeFrom: i(1, 0), coedgeFrom: i(0), faceFrom: i(0) };
  const then = { model: {} as BrepData, vertexFrom: i(1, 2, -1), edgeFrom: i(1, 1, 0), coedgeFrom: i(0, 0),
    faceFrom: i(0) };
  const r = rowsFrom(first, then)!;
  assert.equal(r.model, then.model);
  assert.deepEqual([...r.vertexFrom], [-1, 0, -1]);
  assert.deepEqual([...r.edgeFrom], [0, 0, 1]);
  assert.deepEqual([...r.coedgeFrom], [0, 0]);
  assert.equal(rowsFrom(undefined, then), then), assert.equal(rowsFrom(first, undefined), first);
});
