import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BrepBuilder, type BrepData, BrepFormatError, brepFromJson, brepToJson, COLUMNS, decode, MAX_DIAGNOSTICS, openBrep,
  rowCount, validateBrep,
} from '../src/index.ts';
import { box, cone, cube, everyKind, MODELS, seamCylinder } from './models.ts';

const bytes = (d: BrepData) => new Uint8Array(d.buffer);
/** A writable copy (validation cases plant defects in it). */
const copy = (d: BrepData) => openBrep(d.buffer.slice(0));

test('every model validates clean', () => {
  for (const [name, make] of Object.entries(MODELS)) assert.deepEqual(validateBrep(make().finish()), [], name);
});

test('JSON round trip: the same bytes, and decoding gives what was built', () => {
  for (const [name, make] of Object.entries(MODELS)) {
    const d = make().finish();
    const j = brepToJson(d);
    assert.deepEqual(bytes(brepFromJson(JSON.parse(JSON.stringify(j)))), bytes(d), name);
  }
  // Decoded rows equal the builder's input (optional fields left out stay out).
  const d = everyKind().finish();
  assert.deepEqual(decode.curve(d, 0), { kind: 'line', point: [0, 0, 0], direction: [0, 0.6, 0.8], magnitude: 2.5,
    id: 501 });
  assert.deepEqual(decode.curve(d, 8), { kind: 'trimmed', basis: 1, trim1: { parameter: 0, point: [3, 2, 3] },
    trim2: { parameter: 1.5 }, sense: true, preference: 'parameter' });
  assert.deepEqual(decode.curve(d, 19).kind === 'trimmed' && decode.curve(d, 19), { kind: 'trimmed', basis: 12,
    trim1: { point: [2, 2] }, trim2: { point: [1, 3] }, sense: false, preference: 'cartesian' });
  assert.deepEqual(decode.surface(d, 5), { kind: 'torus', position: { origin: [1, 2, 3], axis: [0, 0, 1],
    xDir: [1, 0, 0] }, majorRadius: 1, minorRadius: 2, selectOuter: true });
  assert.equal('selectOuter' in decode.surface(d, 4), false);
  const s7 = decode.surface(d, 7);
  assert.ok(s7.kind === 'bspline');
  assert.deepEqual(s7.weights, [[1, 2], [0.5, 1]]);
  assert.deepEqual(s7.poles[1]![0], [1, 0, 0]);
  const c6 = decode.curve(d, 6);
  assert.ok(c6.kind === 'bspline');
  assert.deepEqual([c6.weights, c6.closed, c6.selfIntersect], [[1, 0.5, 2, 1], false, null]);
  assert.equal('weights' in decode.curve(d, 5), false);
  assert.deepEqual(decode.item(d, rowCount(d, 'item') - 1).transform, [-1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0]);
  assert.deepEqual(decode.part(d), { unit: 1, uncertainty: 1e-5 });
  assert.deepEqual(decode.curve(d, 10), { kind: 'offset', basis: 5, distance: 0.25, selfIntersect: null,
    refDirection: [0, 1, 0] });

  const k = cone().finish();
  assert.deepEqual(decode.edge(k, 2), { start: 1, end: 1, sameSense: true, degenerate: true, tolerance: 1e-7 });
  assert.equal('degenerate' in decode.edge(k, 1), false);
  assert.deepEqual(decode.surface(k, 1), { kind: 'torus', position: { origin: [0, 0, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] }, majorRadius: 1, minorRadius: 3, selectOuter: false });

  const s = seamCylinder().finish();
  const f = decode.face(s, 0);
  assert.equal(f.id, 9);
  const loop = f.loops[0]!;
  assert.ok(loop.kind === 'edge');
  assert.deepEqual(loop.coedges.map((c) => [c.edge, c.orientation, c.pcurve]), [[0, 'forward', 3], [2, 'forward', 6],
    [1, 'reversed', 4], [2, 'reversed', 5]]);
  assert.deepEqual(loop.coedges[3], { edge: 2, orientation: 'reversed', pcurve: 5, range: [0, 5], id: 77 });
  assert.equal('range' in loop.coedges[2]!, false);
  assert.deepEqual(decode.edge(s, 2), { curve: 2, start: 0, end: 1, sameSense: true, tolerance: 1e-7 });
  assert.deepEqual(decode.vertex(s, 0), { point: [2, 0, 0], tolerance: 1e-7 });
});

test('the bytes depend on each table\'s rows, not on how tables are interleaved', () => {
  const a = new BrepBuilder({ unit: 1 }), b = new BrepBuilder({ unit: 1 });
  const circle = { kind: 'circle' as const, position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 };
  const plane = { kind: 'plane' as const, position: circle.position };
  a.addCurve(circle); a.addSurface(plane); a.addItem({ kind: 'point', point: [1, 2, 3] }); a.addCurve(circle);
  b.addItem({ kind: 'point', point: [1, 2, 3] }); b.addCurve(circle); b.addCurve(circle); b.addSurface(plane);
  assert.deepEqual(bytes(a.finish()), bytes(b.finish()));
  // And twice the same: the same bytes, padding included.
  assert.deepEqual(bytes(cube().finish()), bytes(cube().finish()));
});

test('layout: every column 8-byte aligned, in order, counts as built', () => {
  const d = everyKind().finish();
  const view = new DataView(d.buffer);
  assert.equal(String.fromCharCode(...new Uint8Array(d.buffer, 0, 4)), 'CBR1');
  assert.equal(view.getUint32(4, true), COLUMNS.length);
  let last = 0;
  COLUMNS.forEach((c, k) => {
    const offset = view.getUint32(8 + 8 * k, true), count = view.getUint32(12 + 8 * k, true);
    assert.equal(offset % 8, 0);
    assert.ok(offset >= last);
    last = offset;
    assert.equal(count, (d[c.table] as Record<string, ArrayLike<number>>)[c.column]!.length);
  });
  assert.deepEqual([rowCount(d, 'curve'), rowCount(d, 'surface'), rowCount(d, 'part')], [22 + 12, 14 + 6, 1]);
  assert.equal(d.vertex.point.length, 3 * rowCount(d, 'vertex'));
});

test('openBrep: header checks, and a Uint8Array view copied or used', () => {
  const d = cube().finish();
  assert.throws(() => openBrep(new ArrayBuffer(8)), BrepFormatError);
  const bad = d.buffer.slice(0);
  new Uint8Array(bad)[3] = 0x32;
  assert.throws(() => openBrep(bad), /magic "CBR2"/);
  const fewer = d.buffer.slice(0);
  new DataView(fewer).setUint32(4, COLUMNS.length - 1, true);
  assert.throws(() => openBrep(fewer), /columns/);
  const past = d.buffer.slice(0);
  new DataView(past).setUint32(12, 1e6, true);
  assert.throws(() => openBrep(past), /don't fit/);
  const odd = d.buffer.slice(0);
  new DataView(odd).setUint32(8, new DataView(odd).getUint32(8, true) + 4, true);
  assert.throws(() => openBrep(odd), /don't fit/);
  // Rows of a table disagreeing: one more vertex tolerance than points.
  const k = COLUMNS.findIndex((c) => c.table === 'vertex' && c.column === 'tolerance');
  const rows = d.buffer.slice(0);
  new DataView(rows).setUint32(12 + 8 * k, 7, true);
  assert.throws(() => openBrep(rows), /vertex: columns of 8, 7/);
  const parts = d.buffer.slice(0);
  for (const c of ['unit', 'uncertainty']) {
    new DataView(parts).setUint32(12 + 8 * COLUMNS.findIndex((x) => x.table === 'part' && x.column === c), 0, true);
  }
  assert.throws(() => openBrep(parts), /one part row/);
  const width = d.buffer.slice(0);
  new DataView(width).setUint32(12 + 8 * COLUMNS.findIndex((c) => c.table === 'vertex' && c.column === 'point'), 23,
    true);
  assert.throws(() => openBrep(width), /not rows of 3/);

  const inside = new Uint8Array(d.buffer.byteLength + 8);
  inside.set(bytes(d), 8);
  const view = openBrep(inside.subarray(8));
  assert.notEqual(view.buffer, inside.buffer);
  assert.deepEqual(bytes(view), bytes(d));
  assert.equal(openBrep(new Uint8Array(d.buffer)).buffer, d.buffer);
});

test('the builder refuses what would make the buffer unreadable', () => {
  const b = new BrepBuilder({ unit: 1 });
  const P = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const line2 = b.addCurve({ kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1 });
  const line3 = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const cases: [string, () => unknown, RegExp][] = [
    ['a forward curve', () => b.addCurve({ kind: 'trimmed', basis: 5, trim1: {}, trim2: {}, sense: true,
      preference: 'unspecified' }), /curve 5 not added yet/],
    ['a 2D edge curve', () => b.addEdge({ curve: line2, sameSense: true }), /2D, not 3D/],
    ['a 3D p-curve', () => b.addFace({ surface: 0, sameSense: true, loops: [] }), /surface 0 not added yet/],
    ['a 3D placement without an axis', () => b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0],
      xDir: [1, 0, 0] }, radius: 1 }), /without an axis/],
    ['a 2D placement with one', () => b.addCurve({ kind: 'circle', position: { origin: [0, 0], axis: [0, 1],
      xDir: [1, 0] }, radius: 1 }), /2D placement with an axis/],
    ['a 3D offset without a reference', () => b.addCurve({ kind: 'offset', basis: line3, distance: 1,
      selfIntersect: false }), /reference direction/],
    ['a 2D offset with one', () => b.addCurve({ kind: 'offset', basis: line2, distance: 1, selfIntersect: false,
      refDirection: [0, 0, 1] }), /reference direction/],
    ['mixed dimensions', () => b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0], magnitude: 1 }),
      /2 numbers, not 3/],
    ['no poles', () => b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1], multiplicities: [2, 2], poles: [],
      closed: false, selfIntersect: false, form: 'unspecified' }), /no poles/],
    ['weights not one per pole', () => b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1],
      multiplicities: [2, 2], poles: [[0, 0, 0], [1, 0, 0]], weights: [1], closed: false, selfIntersect: false,
      form: 'unspecified' }), /weights and poles/],
    ['knots without multiplicities', () => b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1],
      multiplicities: [2], poles: [[0, 0, 0], [1, 0, 0]], closed: false, selfIntersect: false, form: 'unspecified' }),
    /knots and multiplicities/],
    ['ragged surface poles', () => b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1],
      vKnots: [0, 1], uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]],
      [[1, 0, 0]]], uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' }), /different lengths/],
    ['a composite of segments of two dimensions', () => b.addCurve({ kind: 'composite', segments: [
      { curve: line2, sameSense: true, transition: 'continuous' }, { curve: line3, sameSense: true,
        transition: 'continuous' }], selfIntersect: false }), /3D, not 2D/],
    ['an empty composite', () => b.addCurve({ kind: 'composite', segments: [], selfIntersect: false }), /no segments/],
    ['a 2D surface placement', () => b.addSurface({ kind: 'plane', position: { origin: [0, 0], xDir: [1, 0] } }),
      /2D placement/],
    ['a vertex in 2D', () => b.addVertex({ point: [0, 0] }), /a point of 2/],
    ['an edge to a missing vertex', () => b.addEdge({ curve: line3, start: 0, end: 0, sameSense: true }),
      /vertex 0 not added yet/],
    ['a shell of a missing face', () => b.addShell({ kind: 'open', faces: [{ face: 0, sense: true }] }),
      /face 0 not added yet/],
    ['a wire of a missing edge', () => b.addBody({ kind: 'wire', members: [{ ref: 3, sense: true }] }),
      /edge 3 not added yet/],
    ['an instance of a later item', () => b.addItem({ kind: 'instance', ref: 0, transform: [] }),
      /item 0 not added yet/],
    ['a short transform', () => b.addItem({ kind: 'point', point: [0, 0, 0], transform: [1, 0, 0] }),
      /transform of 3/],
    ['a 2D curve item', () => b.addItem({ kind: 'curve', ref: line2 }), /2D, not 3D/],
    ['a fractional reference', () => b.addCurve({ kind: 'trimmed', basis: 0.5, trim1: {}, trim2: {}, sense: true,
      preference: 'unspecified' }), /not added yet/],
    ['a surface placement made of a curve', () => b.addSurface({ kind: 'extrusion', curve: line2,
      direction: [0, 0, 1], magnitude: 1 }), /2D, not 3D/],
  ];
  for (const [what, f, re] of cases) assert.throws(f, re, what);
  // Nothing refused was added, and what's left is a valid buffer.
  assert.equal(rowCount(b.finish(), 'curve'), 2);
  void P;
});

/** A defect planted in a copy of a valid buffer, and the message validateBrep must give for it. */
type Case = [string, () => BrepBuilder, (d: BrepData) => void, RegExp];

const poolAt = (d: BrepData, table: 'curve' | 'surface', k: number) =>
  table === 'curve' ? { real: d.pool.curveReal, r: d.curve.real[k]!, int: d.pool.curveInt, i: d.curve.int[k]! }
    : { real: d.pool.surfaceReal, r: d.surface.real[k]!, int: d.pool.surfaceInt, i: d.surface.int[k]! };

test('validateBrep finds each kind of defect', () => {
  // Plant a value at an offset into a curve's or surface's reals or ints.
  const at = (table: 'curve' | 'surface', ints: boolean) => (k: number, off: number, x: number) => (d: BrepData) => {
    const p = poolAt(d, table, k);
    if (ints) p.int[p.i + off] = x;
    else p.real[p.r + off] = x;
  };
  const C = at('curve', false), CI = at('curve', true), S = at('surface', false), SI = at('surface', true);
  const E = everyKind;
  const cases: Case[] = [
    ['unit', E, (d) => { d.part.unit[0] = 0; }, /part: unit 0/],
    ['uncertainty', E, (d) => { d.part.uncertainty[0] = -1; }, /part: uncertainty -1/],
    ['line direction', E, C(0, 3, 1), /curve 0 \(#501\) \(line\): direction not of unit length/],
    ['line point', E, C(0, 0, NaN), /line\): point not finite/],
    ['line magnitude', E, C(0, 6, 0), /magnitude 0/],
    ['circle radius', E, C(1, 9, -2), /curve 1 \(circle\): radius -2/],
    ['placement axis length', E, C(1, 3, 0.5), /curve 1 \(circle\): a placement direction not of unit/],
    ['placement origin', E, C(1, 0, Infinity), /origin not finite/],
    ['placement orthogonality', E, (d) => { const p = poolAt(d, 'curve', 1); p.real.set([0.6, 0, 0.8], p.r + 3); },
      /not orthogonal/],
    ['2D placement direction', E, C(12, 2, 2), /curve 12 \(circle\): a placement direction/],
    ['ellipse axis', E, C(2, 10, 0), /second semi-axis 0/],
    ['hyperbola axis', E, C(3, 9, -1), /first semi-axis -1/],
    ['parabola focus', E, C(4, 9, 0), /focal distance 0/],
    ['bspline degree', E, CI(5, 0, 0), /degree 0/],
    ['bspline knots order', E, C(5, 1, 2), /knots not finite and increasing/],
    ['bspline knots equal', E, C(5, 1, 0), /knots not finite and increasing/],
    ['bspline knot NaN', E, C(5, 0, NaN), /knots not finite/],
    ['bspline multiplicity', E, CI(5, 7, 4), /multiplicities out of range/],
    ['bspline interior multiplicity', E, CI(5, 8, 3), /multiplicities out of range/],
    ['bspline sum', E, (d) => { const p = poolAt(d, 'curve', 5); p.int[p.i + 8] = 2; }, /sum to 8, not/],
    ['bspline poles', E, CI(5, 1, 1), /1 poles for degree 2/],
    ['bspline pole NaN', E, C(5, 4, NaN), /poles not finite/],
    ['bspline weight', E, C(6, 3 + 12 + 1, 0), /weights not positive/],
    ['bspline rational flag', E, CI(5, 3, 2), /rational 2/],
    ['bspline closed', E, CI(5, 4, 3), /closed 3/],
    ['bspline self_intersect', E, CI(5, 5, 7), /self_intersect 7/],
    ['bspline form', E, CI(5, 6, 99), /form 99/],
    ['bspline overrun', E, CI(5, 2, 1000), /beyond its pool/],
    ['bspline negative counts', E, CI(5, 2, -1), /-1 knots/],
    ['polyline points', E, CI(7, 0, 1), /1 points/],
    ['polyline NaN', E, C(7, 0, NaN), /points not finite/],
    ['trimmed basis', E, CI(8, 0, 8), /basis 8 not an earlier curve/],
    ['trimmed basis dimension', E, CI(8, 0, 11), /basis 11 not an earlier curve|basis 11 is 2D, not 3D/],
    ['trimmed without either', E, C(8, 1, NaN), /trim 2 with neither/],
    ['trimmed partial point', E, C(8, 2, NaN), /trim 1's point partly given/],
    ['trimmed sense', E, CI(8, 1, 2), /sense 2/],
    ['trimmed preference', E, CI(8, 2, 3), /master representation 3/],
    ['composite segments', E, CI(9, 0, 0), /0 segments/],
    ['composite segment', E, CI(9, 2, 9), /segment curve 9 not an earlier curve/],
    ['composite transition', E, CI(9, 4, 4), /transition 4/],
    ['composite same sense', E, CI(9, 3, 5), /same_sense 5/],
    ['composite self_intersect', E, CI(9, 1, 3), /self_intersect 3/],
    ['offset distance', E, C(10, 0, NaN), /distance NaN/],
    ['offset reference', E, C(10, 1, 1), /reference direction not of unit length/],
    ['offset basis dimension', E, CI(10, 0, 16), /basis 16 not an earlier curve/],
    ['offset self_intersect', E, CI(10, 1, 9), /self_intersect 9/],
    ['curve kind', E, (d) => { d.curve.kind[3] = 99; }, /curve 3: kind 99/],
    ['curve dimension', E, (d) => { d.curve.dim[3] = 4; }, /curve 3 \(hyperbola\): dimension 4/],
    ['curve pool offset', E, (d) => { d.curve.real[1] = -5; }, /curve 1 \(circle\): reals beyond its pool/],
    ['surface radius', E, S(1, 9, 0), /surface 1 \(cylinder\): radius 0/],
    ['cone radius', E, S(2, 9, -1), /radius -1/],
    ['cone angle', E, S(2, 10, Math.PI / 2), /semi-angle/],
    ['cone zero angle', E, S(2, 10, 0), /semi-angle 0/],
    ['sphere radius', E, S(3, 9, NaN), /surface 3 \(sphere\): radius NaN/],
    ['torus radius', E, S(4, 10, 0), /minor radius 0/],
    ['torus major', E, S(4, 9, -3), /major radius -3/],
    ['degenerate torus radii', E, S(5, 9, 3), /degenerate with the major radius not under/],
    ['degenerate torus radii equal', E, S(5, 9, 2), /degenerate with the major radius not under/],
    ['select_outer alone', E, SI(4, 1, 1), /select_outer on a torus not degenerate/],
    ['torus flags', E, SI(4, 0, 2), /degenerate 2/],
    ['torus select flag', E, SI(5, 1, 2), /select_outer 2/],
    ['surface placement', E, S(0, 6, 0.9), /surface 0 \(#601\) \(plane\): a placement direction/],
    ['bspline surface u knots', E, SI(6, 11, 1), /u multiplicities out of range|u multiplicities sum/],
    ['bspline surface v degree', E, SI(6, 1, 5), /v degree|v poles/],
    ['bspline surface weights', E, S(7, 4 + 12, -1), /weights not positive/],
    ['bspline surface poles', E, S(6, 4, Infinity), /poles not finite/],
    ['bspline surface overrun', E, SI(6, 2, 1e6), /beyond its pool/],
    ['bspline surface negative', E, SI(6, 4, -2), /negative counts/],
    ['bspline surface flags', E, SI(6, 6, 2), /rational 2/],
    ['bspline surface closed', E, SI(6, 7, 3), /u_closed 3/],
    ['bspline surface v closed', E, SI(6, 8, 3), /v_closed 3/],
    ['bspline surface self', E, SI(6, 9, 3), /self_intersect 3/],
    ['bspline surface form', E, SI(6, 10, 11), /form 11/],
    ['extrusion direction', E, S(8, 0, 2), /direction not of unit length/],
    ['extrusion magnitude', E, S(8, 3, 0), /magnitude 0/],
    ['extrusion curve', E, SI(8, 0, 11), /swept curve 11 is 2D, not 3D/],
    ['revolution axis', E, S(9, 3, 0), /axis direction not of unit length/],
    ['revolution location', E, S(9, 0, NaN), /axis location not finite/],
    ['revolution curve', E, SI(9, 0, 99), /swept curve 99 not an earlier curve/],
    ['offset surface basis', E, SI(10, 0, 10), /basis 10 not an earlier surface/],
    ['offset surface distance', E, S(10, 0, Infinity), /distance Infinity/],
    ['offset surface self', E, SI(10, 1, 3), /self_intersect 3/],
    ['trimmed surface bounds', E, S(11, 1, 0), /bounds 0, 0/],
    ['trimmed surface basis', E, SI(11, 0, -1), /basis -1 not an earlier surface/],
    ['trimmed surface senses', E, SI(11, 1, 2), /usense 2/],
    ['trimmed surface v sense', E, SI(11, 2, 2), /vsense 2/],
    ['swept reference', E, SI(12, 2, 12), /reference surface 12 not an earlier/],
    ['swept curve', E, SI(12, 0, 16), /swept curve 16 is 2D/],
    ['swept directrix', E, SI(12, 1, 400), /directrix 400 not an earlier curve/],
    ['fixed reference', E, S(13, 1, 0), /fixed reference not of unit length/],
    ['fixed reference directrix', E, SI(13, 1, 12), /directrix 12 is 2D/],
    ['surface kind', E, (d) => { d.surface.kind[2] = 0; }, /surface 2: kind 0/],
    ['vertex point', cube, (d) => { d.vertex.point[4] = NaN; }, /vertex 1 \(#2\): point not finite/],
    ['vertex tolerance', cube, (d) => { d.vertex.tolerance[0] = -1; }, /vertex 0 \(#1\): tolerance -1/],
    ['edge curve', cube, (d) => { d.edge.curve[0] = 99; }, /edge 0 \(#9\): curve 99 not a 3D curve/],
    ['edge vertex', cube, (d) => { d.edge.start[0] = 8; }, /vertex 8 out of range/],
    ['edge one vertex', cube, (d) => { d.edge.end[1] = -1; }, /edge 1 \(#10\): one vertex only/],
    ['edge nothing', cube, (d) => { d.edge.curve[0] = -1; d.edge.start[0] = d.edge.end[0] = -1; },
      /edge 0 \(#9\): neither a curve nor vertices, and a use without a p-curve/],
    ['edge nothing, unused', E, (d) => { d.edge.curve[0] = -1; d.coedge.edge[0] = 1; },
      /edge 0: neither a curve nor vertices, and no use/],
    ['edge sense', cube, (d) => { d.edge.sameSense[0] = 2; }, /same_sense 2/],
    ['edge flags', cube, (d) => { d.edge.flags[0] = 4; }, /flags 4/],
    ['edge range', cube, (d) => { d.edge.range[1] = NaN; }, /range 0, NaN/],
    ['edge tolerance', cube, (d) => { d.edge.tolerance[2] = Infinity; }, /tolerance Infinity/],
    ['coedge edge', cube, (d) => { d.coedge.edge[0] = 12; }, /coedge 0: edge 12 out of range/],
    ['coedge orientation', cube, (d) => { d.coedge.orientation[0] = 4; }, /orientation 4/],
    ['coedge p-curve', seamCylinder, (d) => { d.coedge.pcurve[0] = 0; }, /p-curve 0 not a 2D curve/],
    ['coedge range', seamCylinder, (d) => { d.coedge.range[0] = Infinity; }, /coedge 0: range Infinity/],
    ['loop not joined', cube, (d) => { d.coedge.orientation[1] = 1 - d.coedge.orientation[1]!; },
      /loop 0: coedge 0 ends at vertex \d, the next starts at \d/],
    ['loop range', cube, (d) => { d.loop.count[0] = 30; }, /coedges 0 to 29 out of range/],
    ['coedge in two loops', cube, (d) => { d.loop.first[1] = 2; }, /coedge \d already belongs/],
    ['coedge in none', cube, (d) => { d.loop.count[5] = 3; }, /coedge 23: in no edge loop/],
    ['first coedge in none', cube, (d) => { d.loop.first[0] = 1; d.loop.count[0] = 3; }, /coedge 0: in no edge loop/],
    ['empty edge loop', cube, (d) => { d.loop.count[5] = 0; }, /loop 5: 0 coedges/],
    ['loop bound', cube, (d) => { d.loop.bound[0] = 3; }, /bound 3/],
    ['loop sense', cube, (d) => { d.loop.sense[0] = 2; }, /loop 0: sense 2/],
    ['loop kind', cube, (d) => { d.loop.kind[0] = 7; }, /loop 0: kind 7/],
    ['vertex loop', MODELS.spheres, (d) => { d.loop.first[1] = 9; }, /loop 1: vertex 9/],
    ['poly loop', MODELS.facetedAndWire, (d) => { d.loop.count[0] = 2; }, /loop 0: 2 points/],
    ['poly loop NaN', MODELS.facetedAndWire, (d) => { d.pool.loopReal[0] = NaN; }, /points not finite/],
    ['face surface', cube, (d) => { d.face.surface[0] = 6; }, /face 0 \(#21\): surface 6 out of range/],
    ['face sense', cube, (d) => { d.face.sameSense[0] = 2; }, /same_sense 2/],
    ['face loops', cube, (d) => { d.face.loopCount[5] = 2; }, /loops 5 to 6 out of range/],
    ['loop in two faces', cube, (d) => { d.face.firstLoop[1] = 0; }, /loop 0 already belongs/],
    ['loop in none', cube, (d) => { d.face.loopCount[5] = 0; }, /loop 5: in no face/],
    ['two outer bounds', MODELS.spheres, (d) => { d.loop.bound[1] = 1; }, /2 outer bounds/],
    ['face tolerance', cube, (d) => { d.face.tolerance[0] = -0.1; }, /tolerance -0.1/],
    ['shell kind', cube, (d) => { d.shell.kind[0] = 0; }, /shell 0: kind 0/],
    ['shell face', cube, (d) => { d.faceUse.face[2] = 40; }, /face 40 out of range/],
    ['shell range', cube, (d) => { d.shell.count[0] = 9; }, /faceUses 0 to 8 out of range/],
    ['face use in none', cube, (d) => { d.shell.count[0] = 5; }, /faceUse 5: in no shell/],
    ['face use sense', cube, (d) => { d.faceUse.sense[0] = 3; }, /faceUse 0: sense 3/],
    ['face use in two shells', MODELS.spheres, (d) => { d.shell.first[1] = 0; }, /faceUse 0 already belongs/],
    ['body kind', cube, (d) => { d.body.kind[0] = 9; }, /body 0 \(#100\): kind 9/],
    ['body members', cube, (d) => { d.body.count[0] = 0; }, /no members/],
    ['body shell', cube, (d) => { d.member.ref[0] = 1; }, /shell 1 out of range/],
    ['solid of an open shell', cube, (d) => { d.shell.kind[0] = 2; }, /shell 0 not closed/],
    ['member in two bodies', MODELS.spheres, (d) => { d.body.first[1] = 0; }, /member 0 already belongs/],
    ['member in none', MODELS.spheres, (d) => { d.body.count[1] = 0; }, /member 1: in no body/],
    ['member sense', cube, (d) => { d.member.sense[0] = 2; }, /member 0: sense 2/],
    ['member range', cube, (d) => { d.body.first[0] = 3; }, /members 3 to 3 out of range/],
    ['wire edge', MODELS.facetedAndWire, (d) => { d.member.ref[1] = 99; }, /edge 99 out of range/],
    ['item kind', cube, (d) => { d.item.kind[0] = 0; }, /item 0 \(#101\): kind 0/],
    ['item body', cube, (d) => { d.item.ref[0] = 1; }, /body 1 out of range/],
    ['item point', E, (d) => { d.item.ref[26] = d.pool.itemReal.length; }, /point at/],
    ['instance forward', E, (d) => { d.item.ref[28] = 28; }, /item 28 not an earlier item/],
    ['instance without transform', E, (d) => { d.item.transform[28] = -1; }, /instance without a transform/],
    ['singular transform', E, (d) => { d.pool.itemReal.fill(0, 3, 15); }, /singular or not finite/],
    ['transform range', E, (d) => { d.item.transform[28] = 1e6; }, /out of range/],
    ['duplicate face ids', cube, (d) => { d.face.id[3] = 21; }, /face 3: source id #21, as face 0/],
    ['duplicate edge ids', cube, (d) => { d.edge.id[3] = 9; }, /edge 3: source id #9, as edge 0/],
    ['duplicate vertex ids', cube, (d) => { d.vertex.id[7] = 1; }, /vertex 7: source id #1, as vertex 0/],
  ];
  const seen = new Set<string>(), missed: string[] = [];
  for (const [what, make, plant, re] of cases) {
    assert.ok(!seen.has(what), `case named twice: ${what}`);
    seen.add(what);
    const d = copy(make().finish());
    plant(d);
    const ds = validateBrep(d);
    if (!ds.some((x) => re.test(x.message))) missed.push(`${what}: ${JSON.stringify(ds.slice(0, 4))}`);
  }
  assert.deepEqual(missed, []);
});

test('validateBrep: warnings are warnings, and the count is capped', () => {
  const d = copy(cube().finish());
  d.face.id[3] = 21;
  assert.deepEqual(validateBrep(d).map((x) => x.severity), ['warning']);
  const b = new BrepBuilder({ unit: 1 });
  for (let k = 0; k < MAX_DIAGNOSTICS + 5; k++) b.addVertex({ point: [0, 0, 0], tolerance: -1 });
  const ds = validateBrep(b.finish());
  assert.equal(ds.length, MAX_DIAGNOSTICS + 1);
  assert.equal(ds.at(-1)!.message, 'and 5 more');
});

test('internal and external coedges needn\'t join', () => {
  const b = new BrepBuilder({ unit: 1 });
  const shell = box(b, [1, 1, 1]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  const d = copy(b.finish());
  // The third face's first and third coedges are reversed: as internal and external they would join only if read
  // as reversed.
  assert.deepEqual([d.coedge.orientation[8], d.coedge.orientation[10]], [1, 1]);
  d.coedge.orientation[8] = 2;
  d.coedge.orientation[10] = 3;
  assert.deepEqual(validateBrep(d), []);
});

test('joining is checked only where both vertices are known', () => {
  const b = new BrepBuilder({ unit: 1 });
  const circle = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const v = [b.addVertex({ point: [1, 0, 0] }), b.addVertex({ point: [-1, 0, 0] })];
  const half = b.addEdge({ curve: circle, start: v[0], end: v[1], sameSense: true });
  const rest = b.addEdge({ curve: circle, sameSense: true });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  b.addItem({ kind: 'face', ref: b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: [{ edge: half, orientation: 'forward' }, { edge: rest, orientation: 'forward' }] }] }) });
  assert.deepEqual(validateBrep(b.finish()), []);
});

test('unit directions: just over the tolerance is an error, within it not', () => {
  const plant = (eps: number) => {
    const d = copy(everyKind().finish());
    d.pool.curveReal[d.curve.real[0]! + 5] = 0.8 + eps;
    return validateBrep(d).filter((x) => /direction not of unit length/.test(x.message)).length;
  };
  assert.equal(plant(1e-12), 0);
  assert.equal(plant(1e-8), 1);
});
