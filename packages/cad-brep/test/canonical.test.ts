// The builder's canonical topology (docs/brep-reference.md, "The canonical model"): each rule on a model built in a
// source's forms, against what the rule says the rows become; the result valid, and itself again when built anew.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, decode, openBrep, rowCount, validateBrep } from '../src/index.ts';
import type { Coedge, Loop } from '../src/types.ts';

const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
/** A square's corners, its sides as line edges (k from corner k to k + 1), ids 1-4 and 11-14 from `base`. */
function square(b: BrepBuilder, z = 0, base = 0) {
  const c = [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]];
  const vs = c.map((point, k) => b.addVertex({ point, id: base + 1 + k }));
  const es = c.map((p, k) => {
    const q = c[(k + 1) % 4]!;
    const line = b.addCurve({ kind: 'line', point: p, direction: q.map((x, j) => x - p[j]!), magnitude: 1 });
    return b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, id: base + 11 + k });
  });
  return { vs, es, plane: b.addSurface({ kind: 'plane', position: { ...XY, origin: [0, 0, z] } }) };
}
const forward = (es: number[], ids: number[] = []): Coedge[] => es.map((edge, k) => ({ edge,
  orientation: 'forward', ...(ids[k] ? { id: ids[k] } : {}) }));
const errors = (d: BrepData) => validateBrep(d).filter((x) => x.severity === 'error');
const uses = (l: Loop) => l.kind === 'edge' ? l.coedges.map((c) => [c.edge, c.orientation, c.id]) : l.kind;
/** The model given to a builder again, row by row: the same bytes if canonical. */
function rebuilt(d: BrepData): BrepData {
  const b = new BrepBuilder(decode.part(d));
  for (let k = 0; k < rowCount(d, 'curve'); k++) b.addCurve(decode.curve(d, k));
  for (let k = 0; k < rowCount(d, 'surface'); k++) b.addSurface(decode.surface(d, k));
  for (let k = 0; k < rowCount(d, 'vertex'); k++) b.addVertex(decode.vertex(d, k));
  for (let k = 0; k < rowCount(d, 'edge'); k++) b.addEdge(decode.edge(d, k));
  for (let k = 0; k < rowCount(d, 'face'); k++) b.addFace(decode.face(d, k));
  for (let k = 0; k < rowCount(d, 'shell'); k++) b.addShell(decode.shell(d, k));
  for (let k = 0; k < rowCount(d, 'body'); k++) b.addBody(decode.body(d, k));
  for (let k = 0; k < rowCount(d, 'item'); k++) b.addItem(decode.item(d, k));
  for (let k = 0; k < rowCount(d, 'copy'); k++) b.addCopy(decode.copy(d, k));
  return b.finish();
}
const sameBytes = (a: BrepData, b: BrepData) => assert.deepEqual(new Uint8Array(b.buffer), new Uint8Array(a.buffer));

test('rule 1: a loop against its bound runs as listed: its coedges in reverse order, each turned; ids kept', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const f = b.addFace({ surface: plane, sameSense: true, id: 30, loops: [{ kind: 'edge', bound: 'outer', sense: false,
    coedges: [...forward(es.slice(0, 3), [41, 42, 43]), { edge: es[3]!, orientation: 'internal', id: 44 }],
    id: 40 }] });
  b.addItem({ kind: 'face', ref: f });
  const d = b.finish();
  const l = decode.face(d, 0).loops[0]!;
  assert.deepEqual([uses(l), l.id], [[[es[3], 'internal', 44], [es[2], 'reversed', 43], [es[1], 'reversed', 42],
    [es[0], 'reversed', 41]], 40]);
  assert.deepEqual(errors(d), []);
  sameBytes(d, rebuilt(d));
});

test('rule 2: reversed uses baked into the faces; a face used both ways copied, the copy under a fresh id', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const loop = (): Loop => ({ kind: 'edge', bound: 'outer', sense: true, coedges: forward(es, [41, 42, 43, 44]),
    id: 40 });
  // Face 0 used reversed only (through a reversed member: a shell used reversed), face 1 both ways.
  const f0 = b.addFace({ surface: plane, sameSense: true, loops: [loop()], id: 30 });
  const f1 = b.addFace({ surface: plane, sameSense: false, loops: [loop()], id: 31 });
  const s0 = b.addShell({ kind: 'open', faces: [{ face: f0, sense: true }], id: 50 });
  const s1 = b.addShell({ kind: 'open', faces: [{ face: f1, sense: false }], id: 51 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: s0, sense: false }], id: 60 }) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: s1, sense: true }], id: 61 }) });
  b.addItem({ kind: 'face', ref: f1, id: 70 });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const turned = [[es[3], 'reversed', 44], [es[2], 'reversed', 43], [es[1], 'reversed', 42], [es[0], 'reversed', 41]];
  const g0 = decode.face(d, 0), g1 = decode.face(d, 1);
  assert.deepEqual([g0.id, g0.sameSense, uses(g0.loops[0]!)], [30, false, turned]);
  // Face 1 itself as given (the item's, forward), its copy turned over with fresh ids above the largest (70).
  assert.deepEqual([g1.id, g1.sameSense, uses(g1.loops[0]!)], [31, false, forward(es, [41, 42, 43, 44]).map((c) =>
    [c.edge, c.orientation, c.id])]);
  assert.equal(rowCount(d, 'face'), 3);
  const g2 = decode.face(d, 2), l2 = g2.loops[0]!;
  assert.ok(l2.kind === 'edge');
  const fresh = [g2.id, l2.id, ...l2.coedges.map((c) => c.id)];
  // (The coedges' taken in the source's order, then the loop turned.)
  assert.deepEqual(fresh, [71, 72, 76, 75, 74, 73]);
  assert.deepEqual([g2.sameSense, l2.coedges.map((c) => [c.edge, c.orientation])],
    [true, turned.map(([e, o]) => [e, o])]);
  // Each fresh id a copy of its source (no instances: an empty path).
  const copies = Array.from({ length: rowCount(d, 'copy') }, (_, k) => decode.copy(d, k));
  assert.deepEqual(copies.map((c) => [c.id, c.source, c.path]), [[71, 31, []], [72, 40, []], [73, 41, []],
    [74, 42, []], [75, 43, []], [76, 44, []]]);
  // The shells: forward uses only, the second sheet's of the copy.
  const shells = Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k));
  assert.deepEqual(shells.map((s) => [s.faces.map((u) => u.face), s.id]), [[[0], 50], [[2], 51]]);
  sameBytes(d, rebuilt(d));
});

test('rule 2: a solid\'s void, its shell used reversed: its faces turned over, facing into the void', () => {
  const b = new BrepBuilder();
  const box = (z: number, base: number) => {
    // A flat box of two squares facing apart (top up, bottom down), their sides shared: closed by its edges.
    const { es, plane } = square(b, z, base);
    const top = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: forward(es) }], id: base + 21 });
    const bottom = b.addFace({ surface: plane, sameSense: false, loops: [{ kind: 'edge', bound: 'outer',
      sense: false, coedges: forward(es) }], id: base + 22 });
    return b.addShell({ kind: 'closed', faces: [{ face: top, sense: true }, { face: bottom, sense: true }] });
  };
  const outer = box(0, 0), inner = box(5, 100);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: inner, sense: false }] }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const faces = Array.from({ length: rowCount(d, 'face') }, (_, k) => decode.face(d, k));
  assert.deepEqual(faces.map((f) => [f.id, f.sameSense]), [[21, true], [22, false], [121, false], [122, true]]);
  const shells = Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k).kind);
  assert.deepEqual(shells, ['closed', 'closed']);
  sameBytes(d, rebuilt(d));
});

test('rule 3: poly loops as edge loops of line edges, one per pair of corners, shared by the faces that have it',
  () => {
  const b = new BrepBuilder();
  const p = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 4]];
  const v = p.map((point, k) => b.addVertex({ point, id: 1 + k }));
  const plane = b.addSurface({ kind: 'plane', position: XY });
  const tri = (t: number[], sense = true) => b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'poly',
    bound: 'outer', sense, vertices: t.map((k) => v[k]!) }] });
  // Two triangles sharing corners 0 and 1 (the second the other way along that side), one against its bound.
  const f = [tri([0, 2, 1]), tri([0, 1, 3]), tri([1, 2, 3], false)];
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: f.map((face) => ({ face, sense: true })) }), sense: true }] }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  // Each side: a line from its lower vertex row to its higher, parameter 0 to 1 (magnitude its length).
  const sides = new Map<string, number>();
  for (let e = 0; e < rowCount(d, 'edge'); e++) {
    const x = decode.edge(d, e), c = decode.curve(d, x.curve!);
    assert.ok(c.kind === 'line' && x.start! < x.end! && x.sameSense);
    const a = p[x.start!]!, z = p[x.end!]!, len = Math.hypot(...z.map((q, i) => q - a[i]!));
    assert.deepEqual([c.point, c.magnitude], [a, len]);
    assert.ok(c.direction.every((q, i) => Math.abs(q - (z[i]! - a[i]!) / len) < 1e-15));
    sides.set(`${x.start}-${x.end}`, e);
  }
  assert.deepEqual([...sides.keys()].sort(), ['0-1', '0-2', '0-3', '1-2', '1-3', '2-3']);
  const corners = (k: number) => {
    const l = decode.face(d, k).loops[0]!;
    assert.ok(l.kind === 'edge');
    return l.coedges.map((c) => {
      const x = decode.edge(d, c.edge);
      return c.orientation === 'forward' ? `${x.start}>${x.end}` : `${x.end}>${x.start}`;
    });
  };
  assert.deepEqual([corners(0), corners(1)], [['0>2', '2>1', '1>0'], ['0>1', '1>3', '3>0']]);
  // Against its bound: the polygon the other way round.
  assert.deepEqual(corners(2), ['1>3', '3>2', '2>1']);
  sameBytes(d, rebuilt(d));
});

test('rule 7: a degenerate edge out of its loop; a loop of nothing else a vertex loop at its vertex', () => {
  const b = new BrepBuilder();
  const { vs, es, plane } = square(b);
  const pole = b.addEdge({ start: vs[2]!, end: vs[2]!, sameSense: true, degenerate: true, id: 9 });
  const f = b.addFace({ surface: plane, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [...forward(es.slice(0, 2)), { edge: pole,
      orientation: 'forward' }, ...forward(es.slice(2))] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: pole, orientation: 'reversed' }], id: 8 }] });
  b.addItem({ kind: 'face', ref: f });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const [outer, inner] = decode.face(d, 0).loops;
  assert.deepEqual(uses(outer!), forward(es).map((c) => [c.edge, c.orientation, undefined]));
  assert.deepEqual(inner, { kind: 'vertex', vertex: vs[2], bound: 'inner', id: 8 });
  // (The edge's row kept, used by nothing, without its flag.)
  assert.deepEqual(decode.edge(d, pole), { start: vs[2], end: vs[2], sameSense: true, id: 9 });
  sameBytes(d, rebuilt(d));
});

test('rule 9: the one outer loop first; several outer, or none, as given', () => {
  const b = new BrepBuilder();
  const { vs, plane } = square(b);
  const vl = (vertex: number, bound: 'outer' | 'inner' | 'unknown'): Loop => ({ kind: 'vertex', bound, sense: true,
    vertex });
  const face = (loops: Loop[]) => b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true,
    loops }) });
  face([vl(vs[0]!, 'inner'), vl(vs[1]!, 'outer'), vl(vs[2]!, 'inner')]);
  face([vl(vs[0]!, 'inner'), vl(vs[1]!, 'outer'), vl(vs[2]!, 'outer')]);
  face([vl(vs[0]!, 'unknown'), vl(vs[1]!, 'unknown')]);
  const d = b.finish();
  const order = (k: number) => decode.face(d, k).loops.map((l) => l.kind === 'vertex' ? l.vertex : -1);
  assert.deepEqual([order(0), order(1), order(2)], [[1, 0, 2], [0, 1, 2], [0, 1]]);
  sameBytes(d, rebuilt(d));
});

test('rule 8: shells by topology: open shells sharing edges merged, a shell in pieces split, closed by its edges',
  () => {
  const b = new BrepBuilder();
  // Two squares side by side sharing an edge (x = 1), a third apart; a fourth square's face against itself twice
  // over makes no shell closed.
  const c = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]];
  const v = c.map((point) => b.addVertex({ point }));
  const edge = (i: number, j: number) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: c[i]!,
    direction: c[j]!.map((x, k) => x - c[i]![k]!), magnitude: 1 }), start: v[i]!, end: v[j]!, sameSense: true });
  const [e01, e14, e43, e30, e12, e25, e54] = [edge(0, 1), edge(1, 4), edge(4, 3), edge(3, 0), edge(1, 2),
    edge(2, 5), edge(5, 4)];
  const plane = b.addSurface({ kind: 'plane', position: XY });
  const quad = (coedges: Coedge[], id: number) => b.addFace({ surface: plane, sameSense: true, id,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
  const left = quad(forward([e01, e14, e43, e30]), 1);
  const right = quad([{ edge: e12, orientation: 'forward' }, { edge: e25, orientation: 'forward' },
    { edge: e54, orientation: 'forward' }, { edge: e14, orientation: 'reversed' }], 2);
  const sq = square(b, 5, 100);
  const apart = quad(forward(sq.es), 3);
  // One sheet: left alone and right with the face apart, each said open; they share e14, so left and right merge,
  // the face apart its own piece.
  const s1 = b.addShell({ kind: 'open', faces: [{ face: left, sense: true }], id: 50 });
  const s2 = b.addShell({ kind: 'faceSet', faces: [{ face: right, sense: true }, { face: apart, sense: true }],
    id: 51 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: s1, sense: true },
    { ref: s2, sense: true }] }) });
  // A shell said closed whose edges aren't: open by them, the source's claim kept as declared.
  const s3 = b.addShell({ kind: 'closed', faces: [{ face: apart, sense: true }], id: 52 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: s3, sense: true }] }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const shells = Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k));
  assert.deepEqual(shells.map((s) => [s.faces.map((u) => decode.face(d, u.face).id), s.kind, s.declared, s.id]), [
    [[1, 2], 'open', 'open', 50], [[3], 'open', 'faceSet', 51], [[3], 'open', 'closed', 52]]);
  const bodies = Array.from({ length: rowCount(d, 'body') }, (_, k) => decode.body(d, k));
  assert.deepEqual(bodies.map((x) => [x.kind, x.members.map((m) => m.ref)]), [['sheet', [0, 1]], ['solid', [2]]]);
  sameBytes(d, rebuilt(d));
});

test('rule 11: a sheet of one closed shell is a solid, the source\'s kind declared; of two, a sheet', () => {
  const b = new BrepBuilder();
  const box = (z: number, base: number) => {
    const { es, plane } = square(b, z, base);
    const top = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: forward(es) }] });
    const bottom = b.addFace({ surface: plane, sameSense: false, loops: [{ kind: 'edge', bound: 'outer',
      sense: false, coedges: forward(es) }] });
    return b.addShell({ kind: 'open', faces: [{ face: top, sense: true }, { face: bottom, sense: true }] });
  };
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: box(0, 0), sense: true }], id: 60 }) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: box(3, 100), sense: true },
    { ref: box(6, 200), sense: true }], id: 61 }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const bodies = Array.from({ length: rowCount(d, 'body') }, (_, k) => decode.body(d, k));
  assert.deepEqual(bodies.map((x) => [x.id, x.kind, x.declared, x.members.map((m) => decode.shell(d, m.ref).kind)]),
    [[60, 'solid', 'sheet', ['closed']], [61, 'sheet', 'sheet', ['closed', 'closed']]]);
  sameBytes(d, rebuilt(d));
});

test('the builder can go on after finish: the same rows, the same canonical bytes', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const f = b.addFace({ surface: plane, sameSense: true, id: 30, loops: [{ kind: 'poly', bound: 'outer', sense: false,
    vertices: [0, 1, 2] }] });
  b.addItem({ kind: 'face', ref: f });
  // (A face used both ways too: its copy's fresh id the same each time.)
  const g = b.addFace({ surface: plane, sameSense: true, id: 31, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: forward(es) }] });
  for (const sense of [true, false]) {
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
      faces: [{ face: g, sense }] }), sense: true }] }) });
  }
  const once = b.finish(), twice = b.finish();
  assert.equal(rowCount(once, 'copy'), 1);
  sameBytes(once, twice);
  // And more after it: the rows given before keep their places.
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: forward(es) }] }) });
  const more = b.finish();
  assert.equal(rowCount(more, 'face'), 4);
  assert.deepEqual(decode.face(more, 0), decode.face(once, 0));
});

test('rule 8, closed exactly: every edge once each way (not twice the same way), internal uses aside; faces without '
  + 'edges keep the source\'s claim', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const face = (sameSense: boolean, coedges: Coedge[]) => b.addFace({ surface: plane, sameSense,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
  const turned = es.map((edge) => ({ edge, orientation: 'reversed' as const })).reverse();
  // Two faces back to back (closed), with an internal use on one; two using every edge the same way (open).
  const top = face(true, [...forward(es), { edge: es[0]!, orientation: 'internal' }]), bottom = face(false, turned);
  const again = face(true, forward(es)), same = face(true, forward(es));
  const shell = (faces: number[], kind: 'closed' | 'open') => b.addShell({ kind, faces: faces.map((f) => ({ face: f,
    sense: true })) });
  // Whole spheres (no loops): their shells as the source says.
  const sphere = b.addSurface({ kind: 'sphere', position: XY, radius: 1 });
  const whole = () => b.addFace({ surface: sphere, sameSense: true, loops: [] });
  for (const [faces, kind] of [[[top, bottom], 'closed'], [[again, same], 'closed'], [[whole()], 'open'],
    [[whole()], 'closed']] as const) {
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell([...faces], kind), sense: true },
      { ref: shell([whole()], 'open'), sense: true }] }) });
  }
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  const kinds = Array.from({ length: rowCount(d, 'body') }, (_, k) => decode.body(d, k).members.map((m) =>
    decode.shell(d, m.ref).kind)[0]);
  assert.deepEqual(kinds, ['closed', 'open', 'open', 'closed']);
});

test('rule 8, ids: a shell split keeps its id on its first piece only', () => {
  const b = new BrepBuilder();
  const a = square(b, 0, 0), z = square(b, 5, 100);
  const face = (s: typeof a) => b.addFace({ surface: s.plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: forward(s.es) }] });
  const f = [face(a), face(z), face(a), face(z)];
  for (const kind of ['open', 'closed'] as const) {
    const pair = kind === 'open' ? [f[0]!, f[1]!] : [f[2]!, f[3]!];
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind, id: kind === 'open'
      ? 50 : 51, faces: pair.map((face) => ({ face, sense: true })) }), sense: true }] }) });
  }
  const d = b.finish();
  const ids = Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k).id);
  assert.deepEqual(ids, [50, undefined, 51, undefined]);
});

test('rule 8, a second pass: a closed shell split into an open piece then a closed one, given again, the same', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const sphere = b.addSurface({ kind: 'sphere', position: { ...XY, origin: [9, 0, 0] }, radius: 1 });
  const flat = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: forward(es) }] }), ball = b.addFace({ surface: sphere, sameSense: true, loops: [] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: b.addShell({ kind: 'closed', id: 7,
    faces: [{ face: flat, sense: true }, { face: ball, sense: true }] }), sense: true }] }) });
  const d = b.finish();
  const shells = () => Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k));
  assert.deepEqual(shells().map((s) => [s.kind, s.declared, s.id]), [['open', 'closed', 7],
    ['closed', 'closed', undefined]]);
  sameBytes(d, rebuilt(d));
});

test('rule 8: a shell the source calls closed isn\'t merged with an open one it shares an edge with', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const turned = es.map((edge) => ({ edge, orientation: 'reversed' as const })).reverse();
  const top = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: forward(es) }] });
  const bottom = b.addFace({ surface: plane, sameSense: false, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: turned }] });
  const flap = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: forward(es) }] });
  const shell = (kind: 'closed' | 'open', faces: number[]) => b.addShell({ kind, faces: faces.map((face) => ({ face,
    sense: true })) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell('closed', [top, bottom]),
    sense: true }, { ref: shell('open', [flap]), sense: true }] }) });
  const d = b.finish();
  assert.deepEqual(Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k)).map((x) => [x.kind,
    x.faces.length]), [['closed', 2], ['open', 1]]);
});

test('validateBrep: a body\'s open shells sharing an edge (they\'d be one)', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  // (Two faces sharing one edge, an open shell; their loops left unclosed, which validation says too.)
  const f = [0, 1].map((k) => b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: k === 0 ? forward(es.slice(0, 2)) : [{ edge: es[1]!, orientation: 'reversed' },
      { edge: es[2]!, orientation: 'forward' }] }] }));
  const apart = square(b, 5, 100);
  const g = b.addFace({ surface: apart.plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: forward(apart.es) }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [...f, g].map((face) => ({ face, sense: true })) }), sense: true }] }) });
  const d = b.finish();
  // Its two shells (the pair, the square apart): the square swapped with one of the pair, they share edges.
  assert.equal(rowCount(d, 'shell'), 2);
  const copy = openBrep(d.buffer.slice(0));
  [copy.faceUse.face[1], copy.faceUse.face[2]] = [copy.faceUse.face[2]!, copy.faceUse.face[1]!];
  assert.ok(validateBrep(copy).some((v) => /body 0: open shells 0 and 1 share edge/.test(v.message)),
    JSON.stringify(validateBrep(copy)));
});

test('fresh ids: the builder\'s face copies and a bake\'s copies never share one', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b, 0, 0);
  const f = b.addFace({ surface: plane, sameSense: true, id: 30, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: forward(es) }] });
  for (const sense of [true, false]) {
    const it = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
      faces: [{ face: f, sense }] }), sense: true }] }) });
    if (sense) b.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0], id: 90 });
  }
  const d = b.finish();
  assert.deepEqual(validateBrep(d), []);
  const ids = Array.from({ length: rowCount(d, 'copy') }, (_, k) => decode.copy(d, k).id);
  assert.equal(new Set(ids).size, ids.length);
  // From a first fresh id given: the same.
  const c = new BrepBuilder({}, { firstFreshId: 1000 });
  const s = square(c, 0, 0);
  const h = c.addFace({ surface: s.plane, sameSense: true, id: 30, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: forward(s.es) }] });
  for (const sense of [true, false]) {
    const it = c.addItem({ kind: 'body', ref: c.addBody({ kind: 'sheet', members: [{ ref: c.addShell({ kind: 'open',
      faces: [{ face: h, sense }] }), sense: true }] }) });
    if (sense) c.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0], id: 90 });
  }
  const e = c.finish();
  assert.deepEqual(validateBrep(e), []);
  const eids = Array.from({ length: rowCount(e, 'copy') }, (_, k) => decode.copy(e, k).id);
  assert.ok(eids.every((x) => x >= 1000) && new Set(eids).size === eids.length, `${eids}`);
});

test('rule 4: an edge with both vertices on a trimmed curve is on its basis, turned where the trim runs against it',
  () => {
  const b = new BrepBuilder();
  const { vs, plane } = square(b);
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1, id: 5 });
  const back = b.addCurve({ kind: 'trimmed', basis: line, trim1: { parameter: 1 }, trim2: { parameter: 0 },
    sense: false, preference: 'parameter' });
  const twice = b.addCurve({ kind: 'trimmed', basis: back, trim1: { parameter: 1 }, trim2: { parameter: 0 },
    sense: true, preference: 'parameter' });
  const e = [b.addEdge({ curve: back, start: vs[1]!, end: vs[0]!, sameSense: true, range: [1, 0] }),
    b.addEdge({ curve: twice, start: vs[1]!, end: vs[0]!, sameSense: true }),
    b.addEdge({ curve: back, sameSense: true })];
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: e[0]!, orientation: 'forward' }, { edge: e[1]!,
      orientation: 'reversed' }] }, { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e[2]!,
      orientation: 'forward' }] }] }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  // The range stays (the trim's parameters are the basis's); without one, the trim's, from start to end; an edge
  // without vertices keeps its trim, its bound.
  assert.deepEqual(decode.edge(d, e[0]!), { curve: line, start: vs[1], end: vs[0], sameSense: false, range: [1, 0] });
  assert.deepEqual(decode.edge(d, e[1]!), { curve: line, start: vs[1], end: vs[0], sameSense: false, range: [1, 0] });
  assert.deepEqual(decode.edge(d, e[2]!), { curve: back, sameSense: true });
});

test('rule 5: a face with loops on a rectangular trim is on its basis; a trim reversing a direction, or a face '
  + 'without loops, kept', () => {
  const b = new BrepBuilder();
  const { es, plane } = square(b);
  const trim = (uSense: boolean) => b.addSurface({ kind: 'rectangularTrimmed', basis: plane, u1: 0, u2: 1, v1: 0,
    v2: 1, uSense, vSense: true });
  const kept = trim(true), against = trim(false);
  const twice = b.addSurface({ kind: 'rectangularTrimmed', basis: kept, u1: 0, u2: 1, v1: 0, v2: 1, uSense: true,
    vSense: true });
  const loops = (): Loop[] => [{ kind: 'edge', bound: 'outer', sense: true, coedges: forward(es) }];
  for (const surface of [kept, twice, against]) b.addItem({ kind: 'face', ref: b.addFace({ surface, sameSense: true,
    loops: loops() }) });
  b.addItem({ kind: 'face', ref: b.addFace({ surface: kept, sameSense: true, loops: [] }) });
  // A face on the trim used both ways: its copy on the basis too.
  const both = b.addFace({ surface: kept, sameSense: true, loops: loops() });
  for (const sense of [true, false]) {
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
      faces: [{ face: both, sense }] }), sense: true }] }) });
  }
  const d = b.finish();
  assert.deepEqual(Array.from({ length: 6 }, (_, k) => decode.face(d, k).surface),
    [plane, plane, against, kept, plane, plane]);
});

/** A B-spline's point at t, by the Cox-de Boor recursion over its flat knots (rational: weights). */
function deBoor(p: number, u: number[], poles: number[][], t: number, w?: number[]): number[] {
  const N = (i: number, k: number): number => {
    if (k === 0) {
      // The last nonempty span closed on the right, so the range's end evaluates.
      const last = u.findLastIndex((x) => x < u[u.length - 1]!);
      return (u[i]! <= t && t < u[i + 1]!) || (i === last && t === u[i + 1]) ? 1 : 0;
    }
    const a = u[i + k]! > u[i]! ? (t - u[i]!) / (u[i + k]! - u[i]!) * N(i, k - 1) : 0;
    const z = u[i + k + 1]! > u[i + 1]! ? (u[i + k + 1]! - t) / (u[i + k + 1]! - u[i + 1]!) * N(i + 1, k - 1) : 0;
    return a + z;
  };
  const out = poles[0]!.map(() => 0);
  let den = 0;
  poles.forEach((q, i) => {
    const n = N(i, p) * (w ? w[i]! : 1);
    den += n;
    q.forEach((x, j) => { out[j]! += n * x; });
  });
  return out.map((x) => x / den);
}

test('rule 6: an unclamped B-spline clamped to its valid range, the same curve or surface there', () => {
  const b = new BrepBuilder();
  // A degree 1 curve on uniform knots 0..4: valid on [1, 3], its poles already the points there.
  const lin = b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1, 2, 3, 4], multiplicities: [1, 1, 1, 1, 1],
    poles: [[0, 0, 0], [1, 2, 0], [3, 1, 0]], closed: false, selfIntersect: false, form: 'unspecified' });
  // A rational cubic on uniform knots, and one already clamped at one end.
  const poles = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 0], [5, -1, 2], [7, 0, 1]];
  const weights = [1, 0.5, 2, 1, 0.7, 1.3];
  const flat = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const cubic = b.addCurve({ kind: 'bspline', degree: 3, knots: flat, multiplicities: flat.map(() => 1), poles,
    weights, closed: false, selfIntersect: false, form: 'unspecified' });
  const half = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1, 2, 3, 4, 5], multiplicities: [4, 1, 1, 1, 1, 1],
    poles: poles.slice(0, 5), closed: false, selfIntersect: false, form: 'unspecified' });
  const s = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1, 2, 3, 4, 5, 6],
    vKnots: [0, 1], uMultiplicities: [1, 1, 1, 1, 1, 1, 1], vMultiplicities: [2, 2],
    poles: [0, 1, 2, 3].map((i) => [0, 1].map((j) => [i, j, (i * 7 + j * 3) % 4])), uClosed: false, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  // A surface unclamped in v only, and a curve whose knots don't fit its poles (left as given, validation's to say).
  const sv = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1, 2, 3, 4, 5, 6],
    uMultiplicities: [2, 2], vMultiplicities: [1, 1, 1, 1, 1, 1, 1],
    poles: [0, 1].map((i) => [0, 1, 2, 3].map((j) => [i, j, (i * 3 + j * 7) % 4])), uClosed: false, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const bad = b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1, 2, 3, 4, 5], multiplicities: [1, 1, 1, 1, 1, 1],
    poles: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], closed: false, selfIntersect: false, form: 'unspecified' });
  const d = b.finish();
  // (Valid, but for the curve given so: knots and poles fit.)
  assert.deepEqual(errors(d).map((x) => x.message.split(':')[0]), [`curve ${bad} (bspline)`]);
  const cb = decode.curve(d, bad);
  assert.ok(cb.kind === 'bspline');
  assert.deepEqual([cb.knots, cb.multiplicities], [[0, 1, 2, 3, 4, 5], [1, 1, 1, 1, 1, 1]]);
  const y = decode.surface(d, sv);
  assert.ok(y.kind === 'bspline');
  assert.deepEqual([y.uKnots, y.uMultiplicities, y.vKnots, y.vMultiplicities, y.poles.length, y.poles[0]!.length],
    [[0, 1], [2, 2], [2, 3, 4], [3, 1, 3], 2, 4]);
  const c0 = decode.curve(d, lin);
  assert.ok(c0.kind === 'bspline');
  assert.deepEqual([c0.knots, c0.multiplicities, c0.poles], [[1, 2, 3], [2, 1, 2], [[0, 0, 0], [1, 2, 0], [3, 1, 0]]]);
  const near = (a: number[], z: number[]) => Math.hypot(...a.map((x, i) => x - z[i]!)) < 1e-12;
  for (const [k, given] of [[cubic, { u: flat, poles, weights }], [half, { u: [0, 0, 0, 0, 1, 2, 3, 4, 5],
    poles: poles.slice(0, 5) }]] as const) {
    const c = decode.curve(d, k);
    assert.ok(c.kind === 'bspline');
    assert.deepEqual([c.multiplicities[0], c.multiplicities.at(-1)], [4, 4]);
    const u = c.knots.flatMap((x, i) => Array<number>(c.multiplicities[i]!).fill(x));
    const [a, z] = [u[0]!, u.at(-1)!];
    assert.deepEqual([a, z], k === cubic ? [3, 6] : [0, 2]);
    for (let i = 0; i <= 30; i++) {
      const t = a + (z - a) * i / 30;
      assert.ok(near(deBoor(3, u, c.poles, t, c.weights), deBoor(3, [...given.u], given.poles.map((x) => [...x]), t,
        'weights' in given ? [...given.weights] : undefined)), `curve ${k} at ${t}`);
    }
  }
  const x = decode.surface(d, s);
  assert.ok(x.kind === 'bspline');
  assert.deepEqual([x.uKnots, x.uMultiplicities, x.vKnots, x.vMultiplicities], [[2, 3, 4], [3, 1, 3], [0, 1], [2, 2]]);
  const uf = [2, 2, 2, 3, 4, 4, 4], given = [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i <= 20; i++) {
    for (const v of [0, 0.4, 1]) {
      const t = 2 + 2 * i / 20;
      // (At v: each column's u curve's points, then the line between them.)
      const at = (pts: number[][][], knots: number[]) => {
        const cols = [0, 1].map((j) => deBoor(2, knots, pts.map((r) => r[j]!), t));
        return cols[0]!.map((c, k) => c * (1 - v) + cols[1]![k]! * v);
      };
      assert.ok(near(at(x.poles, uf), at([0, 1, 2, 3].map((r) => [0, 1].map((j) => [r, j, (r * 7 + j * 3) % 4])),
        given)), `surface at ${t}, ${v}`);
    }
  }
});

test('rule 10: a curve-bounded face\'s segments joined where their ends meet within the uncertainty, a vertex between '
  + 'them; their trims unwrapped to ranges', () => {
  const b = new BrepBuilder({ uncertainty: 0.01 });
  const plane = b.addSurface({ kind: 'plane', position: XY });
  // (A line from p, parameter 1 at q.)
  const line = (p: number[], q: number[]) => {
    const v = q.map((x, j) => x - p[j]!), n = Math.hypot(...v);
    return b.addCurve({ kind: 'line', point: p, direction: v.map((x) => x / n), magnitude: n });
  };
  const trim = (c: number, t1: number, t2: number, sense = true) => b.addCurve({ kind: 'trimmed', basis: c,
    trim1: { parameter: t1 }, trim2: { parameter: t2 }, sense, preference: 'parameter' });
  // A triangle of three segments: the second trimmed against its line and used reversed, the third 0.004 short of
  // the first's start.
  const s0 = trim(line([0, 0, 0], [1, 0, 0]), 0, 1), s1 = trim(line([1, 0, 0], [0, 1, 0]), 1, 0, false);
  const s2 = trim(line([0, 1, 0], [0, 0, 0]), 0, 0.996);
  const e = [s0, s1, s2].map((curve, k) => b.addEdge({ curve, sameSense: true, id: 10 + k }));
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, id: 20, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: e[0]!, orientation: 'forward' }, { edge: e[1]!,
      orientation: 'reversed' }, { edge: e[2]!, orientation: 'forward' }] }] }) });
  // A circle of one segment, the loop's ends one point.
  const circle = b.addCurve({ kind: 'circle', position: { ...XY, origin: [5, 0, 0] }, radius: 1 });
  const ring = b.addEdge({ curve: trim(circle, 0, 2 * Math.PI), sameSense: true });
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: ring, orientation: 'forward' }] }] }) });
  const d = b.finish();
  assert.deepEqual(errors(d), []);
  assert.deepEqual(b.diagnostics, []);
  const ed = e.map((k) => decode.edge(d, k)), pt = (v: number | undefined) => decode.vertex(d, v!);
  // Corners: (1, 0, 0) where 0 meets 1 (exactly), (0, 1, 0) where 1 meets 2, the midpoint of (0, 0.004, 0) and
  // (0, 0, 0) where 2 meets 0, its tolerance the gap.
  assert.deepEqual([pt(ed[0]!.end).point, pt(ed[0]!.end).tolerance], [[1, 0, 0], undefined]);
  assert.deepEqual([ed[0]!.start, ed[1]!.end, ed[1]!.start, ed[2]!.start, ed[2]!.end],
    [ed[2]!.end, ed[0]!.end, ed[2]!.start, ed[1]!.start, ed[0]!.start]);
  const c = pt(ed[0]!.start);
  assert.ok(Math.abs(c.point[1]! - 0.002) < 1e-15 && Math.abs(c.tolerance! - 0.004) < 1e-15, JSON.stringify(c));
  // On their lines now, ranges from the trims: the second against its line, from 1 to 0; ids kept.
  assert.deepEqual(ed.map((x) => [decode.curve(d, x.curve!).kind, x.sameSense, x.range, x.id]), [
    ['line', true, [0, 1], 10], ['line', false, [1, 0], 11], ['line', true, [0, 0.996], 12]]);
  const r = decode.edge(d, ring);
  assert.deepEqual([r.start === r.end, decode.curve(d, r.curve!).kind, r.range], [true, 'circle', [0, 2 * Math.PI]]);
  sameBytes(d, rebuilt(d));
});

test('rule 10: segments farther apart than the uncertainty, of no ends of their own, or bounding a face whose loops '
  + 'are all inner: left as they are, said (but the last)', () => {
  const b = new BrepBuilder({ uncertainty: 0.001 });
  const plane = b.addSurface({ kind: 'plane', position: XY });
  const seg = (p: number[], q: number[], bounded = true) => {
    const l = b.addCurve({ kind: 'line', point: p, direction: q.map((x, j) => x - p[j]!), magnitude: 1 });
    return b.addEdge({ curve: bounded ? b.addCurve({ kind: 'trimmed', basis: l, trim1: { parameter: 0 },
      trim2: { parameter: 1 }, sense: true, preference: 'parameter' }) : l, sameSense: true });
  };
  const face = (es: number[], bound: 'outer' | 'inner', id: number) => b.addItem({ kind: 'face', ref: b.addFace({
    surface: plane, sameSense: true, id, loops: [{ kind: 'edge', bound, sense: true, coedges: forward(es) }] }) });
  face([seg([0, 0, 0], [1, 0, 0]), seg([1, 0, 0], [0, 0.002, 0])], 'outer', 1);
  face([seg([0, 0, 0], [1, 0, 0]), seg([1, 0, 0], [0, 0, 0], false)], 'outer', 2);
  face([seg([0, 0, 0], [1, 0, 0]), seg([1, 0, 0], [0, 0, 0])], 'inner', 3);
  const d = b.finish();
  for (let e = 0; e < rowCount(d, 'edge'); e++) assert.equal(decode.edge(d, e).start, undefined, `edge ${e}`);
  assert.deepEqual(b.diagnostics.map((x) => x.message), [
    'a curve-bounded face whose boundary\'s segments don\'t meet within the uncertainty (left as segments) (#1)',
    'a curve-bounded face with a segment of no ends of its own (an unbounded curve, untrimmed: left as segments) '
      + '(#2)']);
});

test('rule 10: an untrimmed segment joined takes the range its ends were taken at; a second pass the same', () => {
  const b = new BrepBuilder({ uncertainty: 0.01 });
  const plane = b.addSurface({ kind: 'plane', position: XY });
  // Two B-spline segments, untrimmed, knots from 2 to 5: across and back, the second ending 0.004 short.
  const spline = (p: number[], q: number[]) => b.addCurve({ kind: 'bspline', degree: 1, knots: [2, 5],
    multiplicities: [2, 2], poles: [p, q], form: 'unspecified', closed: false, selfIntersect: false });
  const es = [spline([0, 0, 0], [1, 0, 0]), spline([1, 0, 0], [0, 0.004, 0])].map((curve) => b.addEdge({ curve,
    sameSense: true }));
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: forward(es) }] }) });
  const d = b.finish();
  assert.deepEqual(b.diagnostics, []);
  const ed = es.map((e) => decode.edge(d, e));
  assert.deepEqual(ed.map((e) => e.range), [[2, 5], [2, 5]]);
  // The corner between the second's end and the first's start: their midpoint, the ends where the ranges put them.
  assert.deepEqual(decode.vertex(d, ed[0]!.start!).point, [0, 0.002, 0]);
  // (Given again, the ends are the same and so is the vertex; a range found from the vertices would move them.)
  sameBytes(d, rebuilt(d));
});

test('rule 10: a segment with only a p-curve: its ends the p-curve\'s on the surface', () => {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const cyl = b.addSurface({ kind: 'cylinder', position: XY, radius: 2 });
  // On the cylinder, u along the circle, v up: a quarter turn at v = 0 and back down a line at u = pi/2... as one
  // closed loop: u from 0 to pi/2 at v = 0, then v 0 to 1, then back along u, then down.
  const p2 = (point: number[], direction: number[], magnitude: number) => b.addCurve({ kind: 'trimmed', basis:
    b.addCurve({ kind: 'line', point, direction, magnitude }), trim1: { parameter: 0 }, trim2: { parameter: 1 },
    sense: true, preference: 'parameter' });
  const pcs = [p2([0, 0], [1, 0], Math.PI / 2), p2([Math.PI / 2, 0], [0, 1], 1), p2([Math.PI / 2, 1], [-1, 0],
    Math.PI / 2), p2([0, 1], [0, -1], 1)];
  const es = pcs.map(() => b.addEdge({ sameSense: true }));
  b.addItem({ kind: 'face', ref: b.addFace({ surface: cyl, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: es.map((edge, k) => ({ edge, orientation: 'forward' as const, pcurve: pcs[k] })) }] }) });
  const d = b.finish();
  assert.deepEqual(b.diagnostics, []);
  const corners = es.map((e) => decode.vertex(d, decode.edge(d, e).start!).point.map((x) => +x.toFixed(12) + 0));
  assert.deepEqual(corners, [[2, 0, 0], [0, 2, 0], [0, 2, 1], [2, 0, 1]]);
  // Each use's range where the ends were taken (the edge has no curve of its own to range over).
  const loop = decode.face(d, 0).loops[0]!;
  assert.deepEqual(loop.kind === 'edge' && loop.coedges.map((c) => c.range), [[0, 1], [0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(es.map((e) => decode.edge(d, e).range), [undefined, undefined, undefined, undefined]);
  sameBytes(d, rebuilt(d));
});
