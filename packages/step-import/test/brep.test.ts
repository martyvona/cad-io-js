import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrepData, decode, rowCount, validateBrep } from 'cad-brep';
import { openModel, parseStep, Reader } from 'step-parser';
import { foldKnots, implicitKnots, stepBrep, type StepBrepResult } from '../src/brep.ts';
import { importStep } from '../src/index.ts';
import { compareScaled } from './unit-oracle.ts';

const enc = new TextEncoder();
const file = (data: string) => enc.encode(`ISO-10303-21;HEADER;FILE_NAME('t.stp','',(''),(''),'','','');`
  + `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));ENDSEC;DATA;\n${data}\nENDSEC;END-ISO-10303-21;`);
const DEG = Math.PI / 180;

/** stepBrep over the given item ids of a DATA section, with its diagnostics. */
async function convert(data: string, ids: number[], angle = 1) {
  const model = await openModel(parseStep(file(data)));
  const r = new Reader(model);
  const warnings: string[] = [];
  const out = stepBrep(r, ids.map((id) => model.resolve(id)), { length: 1, angle }, (m) => warnings.push(m));
  return { ...out, warnings };
}
const close = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);

// Geometry, in a file whose plane angle unit is the degree: trims on a circle, a cone's semi-angle, a rectangular
// trim of a cylinder; implicit and repeated knots; a rational complex instance; a negative radius; a surface curve as
// a loose item; offsets, sweeps, a composite curve, a point.
const GEOMETRY = `
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#10=CIRCLE('',#4,2.);
#11=TRIMMED_CURVE('',#10,(PARAMETER_VALUE(90.)),(PARAMETER_VALUE(180.)),.T.,.PARAMETER.);
#12=CYLINDRICAL_SURFACE('',#4,2.);
#13=CONICAL_SURFACE('',#4,1.,30.);
#14=RECTANGULAR_TRIMMED_SURFACE('',#12,90.,180.,0.,5.,.T.,.F.);
#15=SPHERICAL_SURFACE('',#4,3.);
#16=TOROIDAL_SURFACE('',#4,5.,-1.);
#21=DIRECTION('',(0.,0.,2.));
#22=VECTOR('',#21,4.);
#23=LINE('',#1,#22);
#24=TRIMMED_CURVE('',#23,(PARAMETER_VALUE(2.)),(#1),.F.,.CARTESIAN.);
#31=CARTESIAN_POINT('',(1.,1.,0.));
#32=CARTESIAN_POINT('',(2.,0.,0.));
#33=CARTESIAN_POINT('',(3.,1.,0.));
#35=QUASI_UNIFORM_CURVE('',2,(#1,#31,#32,#33),.UNSPECIFIED.,.F.,.U.);
#36=BEZIER_CURVE('',3,(#1,#31,#32,#33),.UNSPECIFIED.,.F.,.F.);
#37=UNIFORM_CURVE('',1,(#1,#31,#32),.POLYLINE_FORM.,.F.,.F.);
#38=B_SPLINE_CURVE_WITH_KNOTS('',2,(#1,#31,#32,#33),.UNSPECIFIED.,.F.,.F.,(2,1,1,3),(0.,0.,0.5,1.),.UNSPECIFIED.);
#39=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#1,#31,#32,#33),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,1,3),(0.,0.5,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,0.5,2.,1.))REPRESENTATION_ITEM(''));
#40=QUASI_UNIFORM_SURFACE('',1,2,((#1,#31,#32),(#33,#1,#31)),.UNSPECIFIED.,.F.,.F.,.F.);
#41=SURFACE_CURVE('',#10,(#12),.CURVE_3D.);
#42=OFFSET_SURFACE('',#12,0.5,.F.);
#43=SURFACE_OF_LINEAR_EXTRUSION('',#10,#44);
#44=VECTOR('',#3,3.);
#45=SURFACE_OF_REVOLUTION('',#23,#46);
#46=AXIS1_PLACEMENT('',#1,#3);
#47=COMPOSITE_CURVE('',(#48),.F.);
#48=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#23);
#49=OFFSET_CURVE_3D('',#10,0.25,.F.,#2);
#50=GEOMETRIC_SET('',(#11,#24,#35,#36,#37,#38,#39,#12,#13,#14,#15,#16,#40,#41,#42,#43,#45,#47,#49,#52,#53,#1));
#52=DEGENERATE_TOROIDAL_SURFACE('',#4,1.,2.,.T.);
#53=(BOUNDED_SURFACE()B_SPLINE_SURFACE(1,1,((#1,#31),(#32,#33)),.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS((2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(((1.,2.),(0.5,1.)))REPRESENTATION_ITEM('')SURFACE());
#51=AXIS2_PLACEMENT_3D('',#1,#2,#3);
`;

test('geometry: angles to radians, implicit and folded knots, rows shared, ids kept', async () => {
  const { brep: d, warnings } = await convert(GEOMETRY, [50, 51], DEG);
  assert.deepEqual(validateBrep(d), []);
  // Rows in the order met: #10, #11, #23, #24, #35..#39, then #47 and #49; #41 is #10's row.
  assert.deepEqual(Array.from(d.curve.id), [10, 11, 23, 24, 35, 36, 37, 38, 39, 47, 49]);
  assert.deepEqual(Array.from(d.surface.id), [12, 13, 14, 15, 16, 40, 42, 43, 45, 52, 53]);
  const c = (k: number) => decode.curve(d, k), s = (k: number) => decode.surface(d, k);
  const t1 = c(1);
  assert.ok(t1.kind === 'trimmed');
  assert.ok(close([t1.trim1.parameter!, t1.trim2.parameter!], [Math.PI / 2, Math.PI]));
  assert.deepEqual([t1.basis, t1.sense, t1.preference], [0, true, 'parameter']);
  // A line's parameter isn't an angle; its direction made unit, its magnitude kept.
  assert.deepEqual(c(2), { kind: 'line', point: [0, 0, 0], direction: [0, 0, 1], magnitude: 4, id: 23 });
  assert.deepEqual(c(3), { kind: 'trimmed', basis: 2, trim1: { parameter: 2 }, trim2: { point: [0, 0, 0] },
    sense: false, preference: 'cartesian', id: 24 });
  const k = (x: ReturnType<typeof c>) => x.kind === 'bspline' ? [x.degree, x.knots, x.multiplicities] : undefined;
  assert.deepEqual(k(c(4)), [2, [0, 1, 2], [3, 1, 3]]);
  assert.deepEqual(k(c(5)), [3, [0, 1], [4, 4]]);
  assert.deepEqual(k(c(6)), [1, [0, 1, 2, 3, 4], [1, 1, 1, 1, 1]]);
  assert.deepEqual(k(c(7)), [2, [0, 0.5, 1], [3, 1, 3]]);
  const q = c(4), u = c(6), rat = c(8);
  assert.ok(q.kind === 'bspline' && u.kind === 'bspline' && rat.kind === 'bspline');
  assert.deepEqual([q.closed, q.selfIntersect, u.form], [false, null, 'polyline_form']);
  assert.deepEqual(rat.weights, [1, 0.5, 2, 1]);
  assert.equal('weights' in c(7), false);
  const cone = s(1);
  assert.ok(cone.kind === 'cone' && Math.abs(cone.semiAngle - Math.PI / 6) < 1e-15 && cone.radius === 1);
  const rt = s(2);
  assert.ok(rt.kind === 'rectangularTrimmed');
  assert.ok(close([rt.u1, rt.u2, rt.v1, rt.v2], [Math.PI / 2, Math.PI, 0, 5]));
  assert.deepEqual([rt.basis, rt.uSense, rt.vSense], [0, true, false]);
  const torus = s(4);
  assert.ok(torus.kind === 'torus' && torus.minorRadius === 1 && torus.majorRadius === 5);
  assert.ok(warnings.some((w) => /a negative radius \(read as its absolute value\) \(#16\)/.test(w)), `${warnings}`);
  const qs = s(5);
  assert.ok(qs.kind === 'bspline');
  assert.deepEqual([qs.uKnots, qs.uMultiplicities, qs.vKnots, qs.vMultiplicities], [[0, 1], [2, 2], [0, 1], [3, 3]]);
  assert.deepEqual(qs.poles[1]![2], [1, 1, 0]);
  assert.deepEqual(s(6), { kind: 'offset', basis: 0, distance: 0.5, selfIntersect: false, id: 42 });
  assert.deepEqual(s(7), { kind: 'extrusion', curve: 0, direction: [1, 0, 0], magnitude: 3, id: 43 });
  assert.deepEqual(s(8), { kind: 'revolution', curve: 2, axisOrigin: [0, 0, 0], axisDirection: [1, 0, 0], id: 45 });
  assert.deepEqual(c(9), { kind: 'composite', segments: [{ curve: 2, sameSense: true, transition: 'continuous' }],
    selfIntersect: false, id: 47 });
  assert.deepEqual(c(10), { kind: 'offset', basis: 0, distance: 0.25, selfIntersect: false, refDirection: [0, 0, 1],
    id: 49 });
  // Items: every element of the set, the loose surface curve as its 3D curve's row; the placement left out.
  const items = Array.from({ length: rowCount(d, 'item') }, (_, j) => decode.item(d, j));
  assert.equal(items.length, 22);
  assert.deepEqual(items.find((x) => x.id === 41), { kind: 'curve', ref: 0, id: 41 });
  assert.deepEqual(items.at(-1), { kind: 'point', point: [0, 0, 0], id: 1 });
  assert.equal(items.filter((x) => x.kind === 'surface').length, 11);
  const dt = s(9), rs = s(10);
  assert.ok(dt.kind === 'torus' && dt.selectOuter === true && rs.kind === 'bspline');
  assert.deepEqual(rs.weights, [[1, 2], [0.5, 1]]);
});

test('geometry in radians is left as written', async () => {
  const { brep: d } = await convert(GEOMETRY, [50], 1);
  const t = decode.curve(d, 1), cone = decode.surface(d, 1);
  assert.ok(t.kind === 'trimmed' && cone.kind === 'cone');
  assert.deepEqual([t.trim1.parameter, t.trim2.parameter, cone.semiAngle], [90, 180, 30]);
});

test('implicit knots and folding', () => {
  assert.deepEqual(implicitKnots('bezier', 7, 3), { knots: [0, 1, 2], multiplicities: [4, 3, 4] });
  assert.equal(implicitKnots('bezier', 6, 3), undefined);
  assert.equal(implicitKnots('quasi', 2, 2), undefined);
  assert.deepEqual(implicitKnots('quasi', 5, 2), { knots: [0, 1, 2, 3], multiplicities: [3, 1, 1, 3] });
  assert.deepEqual(foldKnots([0, 1, 1, 2], [2, 1, 1, 2]),
    { knots: [0, 1, 2], multiplicities: [2, 2, 2], folded: true });
  assert.deepEqual(foldKnots([0, 1], [2, 2]), { knots: [0, 1], multiplicities: [2, 2], folded: false });
});

// Topology: two planar faces sharing an edge whose SURFACE_CURVE has a p-curve on each plane (the second face's use
// nested oriented edges, the face itself used reversed in its shell), an edge whose only geometry is a p-curve; a
// cylinder's side with circles whose p-curves are lines in degrees and a seam with two p-curves; a solid with a void
// (natural-bound spheres); a face with two outer bounds; two faceted faces sharing two points, one of them a
// vertex's; a face on a missing surface; an edge-based
// wireframe; a curve-bounded surface.
const TOPOLOGY = `
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#5=DIRECTION('',(0.,1.,0.));
#6=DIRECTION('',(0.,-1.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#7=AXIS2_PLACEMENT_3D('',#1,#6,#3);
#8=(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('2D',''));
#10=PLANE('',#4);
#11=PLANE('',#7);
#21=CARTESIAN_POINT('',(1.,0.,0.));
#22=CARTESIAN_POINT('',(0.,1.,0.));
#23=CARTESIAN_POINT('',(0.,0.,1.));
#31=VERTEX_POINT('',#1);
#32=VERTEX_POINT('',#21);
#33=VERTEX_POINT('',#22);
#34=VERTEX_POINT('',#23);
#40=VECTOR('',#3,1.);
#41=LINE('',#1,#40);
#42=CARTESIAN_POINT('',(0.,0.));
#43=DIRECTION('',(1.,0.));
#44=VECTOR('',#43,1.);
#45=LINE('',#42,#44);
#46=DEFINITIONAL_REPRESENTATION('',(#45),#8);
#47=PCURVE('',#10,#46);
#48=LINE('',#42,#44);
#49=DEFINITIONAL_REPRESENTATION('',(#48),#8);
#50=PCURVE('',#11,#49);
#51=SURFACE_CURVE('',#41,(#47,#50),.CURVE_3D.);
#52=EDGE_CURVE('',#31,#32,#51,.T.);
#53=LINE('',#21,#40);
#54=EDGE_CURVE('',#32,#33,#53,.T.);
#55=DIRECTION('',(0.,-1.));
#56=VECTOR('',#55,1.);
#57=CARTESIAN_POINT('',(0.,1.));
#58=LINE('',#57,#56);
#59=DEFINITIONAL_REPRESENTATION('',(#58),#8);
#60=PCURVE('',#10,#59);
#61=EDGE_CURVE('',#33,#31,#60,.T.);
#62=EDGE_CURVE('',#31,#34,#53,.T.);
#63=EDGE_CURVE('',#34,#32,#53,.T.);
#70=ORIENTED_EDGE('',*,*,#52,.T.);
#71=ORIENTED_EDGE('',*,*,#54,.T.);
#72=ORIENTED_EDGE('',*,*,#61,.T.);
#73=EDGE_LOOP('',(#70,#71,#72));
#74=FACE_OUTER_BOUND('',#73,.T.);
#75=ADVANCED_FACE('',(#74),#10,.T.);
#76=ORIENTED_EDGE('',*,*,#62,.T.);
#77=ORIENTED_EDGE('',*,*,#63,.T.);
#78=ORIENTED_EDGE('',*,*,#52,.T.);
#79=ORIENTED_EDGE('',*,*,#78,.F.);
#80=EDGE_LOOP('',(#76,#77,#79));
#81=FACE_BOUND('',#80,.F.);
#82=ADVANCED_FACE('',(#81),#11,.F.);
#83=ORIENTED_FACE('',*,#82,.F.);
#84=OPEN_SHELL('',(#75,#83));
#85=SHELL_BASED_SURFACE_MODEL('',(#84));
#100=CYLINDRICAL_SURFACE('',#4,1.);
#101=CIRCLE('',#4,1.);
#102=CARTESIAN_POINT('',(0.,0.,5.));
#103=AXIS2_PLACEMENT_3D('',#102,#2,#3);
#104=CIRCLE('',#103,1.);
#105=VECTOR('',#43,360.);
#106=LINE('',#42,#105);
#107=DEFINITIONAL_REPRESENTATION('',(#106),#8);
#108=PCURVE('',#100,#107);
#109=SURFACE_CURVE('',#101,(#108),.CURVE_3D.);
#110=CARTESIAN_POINT('',(1.,0.,0.));
#111=CARTESIAN_POINT('',(1.,0.,5.));
#112=VERTEX_POINT('',#110);
#113=VERTEX_POINT('',#111);
#114=EDGE_CURVE('',#112,#112,#109,.T.);
#115=EDGE_CURVE('',#113,#113,#104,.T.);
#116=VECTOR('',#2,5.);
#117=LINE('',#110,#116);
#118=DIRECTION('',(0.,1.));
#119=VECTOR('',#118,1.);
#120=CARTESIAN_POINT('',(360.,0.));
#121=LINE('',#42,#119);
#122=LINE('',#120,#119);
#123=DEFINITIONAL_REPRESENTATION('',(#121),#8);
#124=DEFINITIONAL_REPRESENTATION('',(#122),#8);
#125=PCURVE('',#100,#123);
#126=PCURVE('',#100,#124);
#127=SEAM_CURVE('',#117,(#125,#126),.CURVE_3D.);
#128=EDGE_CURVE('',#112,#113,#127,.T.);
#129=ORIENTED_EDGE('',*,*,#114,.T.);
#130=ORIENTED_EDGE('',*,*,#128,.T.);
#131=ORIENTED_EDGE('',*,*,#115,.F.);
#132=ORIENTED_EDGE('',*,*,#128,.F.);
#133=EDGE_LOOP('',(#129,#130,#131,#132));
#134=FACE_OUTER_BOUND('',#133,.T.);
#135=ADVANCED_FACE('',(#134),#100,.T.);
#136=OPEN_SHELL('',(#135));
#137=SHELL_BASED_SURFACE_MODEL('',(#136));
#140=SPHERICAL_SURFACE('',#4,5.);
#141=SPHERICAL_SURFACE('',#4,1.);
#142=ADVANCED_FACE('',(),#140,.T.);
#143=ADVANCED_FACE('',(),#141,.T.);
#144=CLOSED_SHELL('',(#142));
#145=CLOSED_SHELL('',(#143));
#146=ORIENTED_CLOSED_SHELL('',*,#145,.F.);
#147=BREP_WITH_VOIDS('',#144,(#146));
#150=VERTEX_LOOP('',#31);
#151=VERTEX_LOOP('',#32);
#152=FACE_OUTER_BOUND('',#150,.T.);
#153=FACE_OUTER_BOUND('',#151,.T.);
#149=FACE_BOUND('',#150,.T.);
#154=ADVANCED_FACE('',(#152,#153,#149),#10,.T.);
#155=POLY_LOOP('',(#1,#21,#22));
#156=FACE_OUTER_BOUND('',#155,.T.);
#157=FACE_SURFACE('',(#156),#10,.T.);
#161=CARTESIAN_POINT('',(1.,1.,0.));
#165=VERTEX_POINT('',#161);
#166=VERTEX_POINT('',#161);
#162=POLY_LOOP('',(#22,#21,#161));
#163=FACE_OUTER_BOUND('',#162,.T.);
#164=FACE_SURFACE('',(#163),#10,.T.);
#158=ADVANCED_FACE('',(),#999,.T.);
#159=CLOSED_SHELL('',(#154,#157,#164,#158));
#160=MANIFOLD_SOLID_BREP('',#159);
#170=CONNECTED_EDGE_SET('',(#54,#62));
#171=EDGE_BASED_WIREFRAME_MODEL('',(#170));
#180=CIRCLE('',#181,1.);
#181=AXIS2_PLACEMENT_2D('',#42,#43);
#182=DEFINITIONAL_REPRESENTATION('',(#180),#8);
#183=PCURVE('',#10,#182);
#184=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#183);
#185=OUTER_BOUNDARY_CURVE('',(#184),.F.);
#186=CURVE_BOUNDED_SURFACE('',#10,(#185),.F.);
#187=GEOMETRIC_SET('',(#186,#200,#47,#42));
#86=ORIENTED_FACE('',*,#83,.F.);
#87=OPEN_SHELL('',(#86));
#88=SHELL_BASED_SURFACE_MODEL('',(#87));
#190=CONNECTED_FACE_SET('',(#142));
#191=FACE_BASED_SURFACE_MODEL('',(#190));
#193=CIRCLE('',#194,10.);
#194=AXIS2_PLACEMENT_2D('',#195,#43);
#195=CARTESIAN_POINT('',(20.,30.));
#196=DEFINITIONAL_REPRESENTATION('',(#193),#8);
#197=PCURVE('',#141,#196);
#198=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.F.,#197);
#199=BOUNDARY_CURVE('',(#198),.F.);
#200=CURVE_BOUNDED_SURFACE('',#141,(#199),.T.);
`;

test('topology: shared edges, p-curves per face, orientations, voids, loops, ids', async () => {
  const { brep: d, warnings, seams } = await convert(TOPOLOGY, [85, 88, 137, 147, 160, 171, 191, 187], DEG);
  const errors = validateBrep(d).filter((x) => x.severity === 'error');
  assert.deepEqual(errors, []);
  const faces = Array.from({ length: rowCount(d, 'face') }, (_, k) => decode.face(d, k));
  const byId = (id: number) => faces.find((f) => f.id === id)!;
  // The shared edge #52: one row, a p-curve per face; #61's only geometry is a p-curve.
  const a = byId(75), b = byId(82);
  const la = a.loops[0]!, lb = b.loops[0]!;
  assert.ok(la.kind === 'edge' && lb.kind === 'edge');
  const [ca, cb] = [la.coedges, lb.coedges];
  assert.equal(ca[0]!.edge, cb[2]!.edge);
  assert.equal(decode.edge(d, ca[0]!.edge).id, 52);
  assert.deepEqual(decode.curve(d, ca[0]!.pcurve!).id, 45);
  assert.deepEqual(decode.curve(d, cb[2]!.pcurve!).id, 48);
  // #79 is #78 (forward) reversed: a reversed use, with the outer oriented edge's id.
  assert.deepEqual([cb[2]!.orientation, cb[2]!.id], ['reversed', 79]);
  assert.deepEqual(ca.map((c) => c.orientation), ['forward', 'forward', 'forward']);
  const e61 = decode.edge(d, ca[2]!.edge);
  assert.deepEqual([e61.id, 'curve' in e61, decode.curve(d, ca[2]!.pcurve!).id], [61, false, 58]);
  assert.equal(la.bound, 'outer');
  assert.deepEqual([lb.bound, lb.sense, b.sameSense], ['unknown', false, false]);
  // The second face used reversed in its shell.
  const sheet = decode.shell(d, 0);
  assert.deepEqual(sheet.kind, 'open');
  assert.deepEqual(sheet.faces.map((u) => [faces[u.face]!.id, u.sense]), [[75, true], [82, false]]);

  // The cylinder: its bottom circle's p-curve the line u = 0..360 degrees, made radians (magnitude 2 pi); the seam's
  // two p-curves given to its uses with the face on their left: up the seam (forward) at u = 2 pi, down it at u = 0.
  const side = byId(135);
  const ls = side.loops[0]!;
  assert.ok(ls.kind === 'edge');
  const cs = ls.coedges;
  const bottom = decode.curve(d, cs[0]!.pcurve!);
  assert.ok(bottom.kind === 'line');
  assert.ok(close([...bottom.point, ...bottom.direction, bottom.magnitude], [0, 0, 1, 0, 2 * Math.PI]));
  assert.deepEqual(cs.map((c) => 'pcurve' in c), [true, true, false, true]);
  const u = (c: typeof cs[number]) => {
    const x = decode.curve(d, c.pcurve!);
    return x.kind === 'line' ? x.point[0]! : NaN;
  };
  assert.ok(close([u(cs[1]!), u(cs[3]!)], [2 * Math.PI, 0]), `${u(cs[1]!)} ${u(cs[3]!)}`);
  assert.equal(seams, 0);
  assert.ok(!warnings.some((w) => /seam/.test(w)), `${warnings}`);

  // The void: two shells, the second used reversed; natural-bound spheres.
  const solids = Array.from({ length: rowCount(d, 'body') }, (_, k) => decode.body(d, k));
  const withVoid = solids.find((x) => x.id === 147)!;
  assert.deepEqual([withVoid.kind, withVoid.members.map((m) => m.sense)], ['solid', [true, false]]);
  assert.deepEqual([byId(142).loops, byId(143).loops], [[], []]);

  // Two outer bounds: both kept, said, the other bound inner; a poly loop; the face on a missing surface left out,
  // said.
  assert.deepEqual(byId(154).loops.map((l) => [l.kind, l.bound]),
    [['vertex', 'outer'], ['vertex', 'outer'], ['vertex', 'inner']]);
  assert.ok(warnings.some((w) => /more than one outer bound .*\(#154\)/.test(w)), `${warnings}`);
  // The faceted faces' corners vertices, shared: by the faces whose loops share a point, and with the VERTEX_POINT on
  // a point (#31 to #33 on #1, #21, #22), the first in the file of several (#165 and #166 on #161, used by nothing).
  const poly = byId(157).loops[0]!, other = byId(164).loops[0]!;
  assert.ok(poly.kind === 'poly' && other.kind === 'poly');
  const corner = (v: number) => { const x = decode.vertex(d, v); return [x.id, x.point]; };
  assert.deepEqual(poly.vertices.map(corner), [[31, [0, 0, 0]], [32, [1, 0, 0]], [33, [0, 1, 0]]]);
  assert.deepEqual(other.vertices.map(corner), [[33, [0, 1, 0]], [32, [1, 0, 0]], [165, [1, 1, 0]]]);
  assert.deepEqual([other.vertices[0], other.vertices[1]], [poly.vertices[2], poly.vertices[1]]);
  assert.equal(faces.some((f) => f.id === 158), false);
  assert.ok(warnings.some((w) => /a surface missing from the file/.test(w)), `${warnings}`);
  assert.ok(warnings.some((w) => /a face whose surface can't be read \(left out\) \(#158\)/.test(w)), `${warnings}`);
  assert.equal(decode.shell(d, solids.find((x) => x.id === 160)!.members[0]!.ref).faces.length, 3);

  // The wireframe's edges, the same rows as the faces'.
  const wire = solids.find((x) => x.id === 171)!;
  assert.deepEqual(wire.members.map((m) => decode.edge(d, m.ref).id), [54, 62]);

  // The curve-bounded surface: a face item, one outer loop of one edge with no vertices or 3D curve, its p-curve the
  // 2D circle.
  const items = Array.from({ length: rowCount(d, 'item') }, (_, k) => decode.item(d, k));
  const cbs = items.find((x) => x.kind === 'face')!;
  assert.ok(cbs.kind === 'face');
  const cf = decode.face(d, cbs.ref);
  assert.equal(cf.id, 186);
  const lc = cf.loops[0]!;
  assert.ok(lc.kind === 'edge');
  assert.deepEqual([lc.bound, lc.coedges.length], ['outer', 1]);
  const ce = decode.edge(d, lc.coedges[0]!.edge);
  assert.deepEqual([ce.id, 'curve' in ce, 'start' in ce], [184, false, false]);
  assert.equal(decode.curve(d, lc.coedges[0]!.pcurve!).kind, 'circle');
  assert.deepEqual(items.map((x) => x.id), [85, 88, 137, 147, 160, 171, 191, 186, 200]);
  // A face used reversed twice over is used forward; a face set's shell.
  const shells = Array.from({ length: rowCount(d, 'shell') }, (_, k) => decode.shell(d, k));
  assert.deepEqual(shells.find((x) => x.id === 87)!.faces.map((u) => [faces[u.face]!.id, u.sense]), [[82, true]]);
  assert.equal(shells.find((x) => x.id === 190)!.kind, 'faceSet');
  // A curve-bounded sphere in degrees: its boundary an inner loop (implicit outer), its segment reversed, its circle
  // p-curve scaled to radians (a sphere's u and v are both angles).
  const sphere = decode.face(d, (items.find((x) => x.id === 200) as { ref: number }).ref);
  const ls2 = sphere.loops[0]!;
  assert.ok(ls2.kind === 'edge');
  assert.deepEqual([ls2.bound, ls2.coedges[0]!.orientation], ['inner', 'reversed']);
  const circle = decode.curve(d, ls2.coedges[0]!.pcurve!);
  assert.ok(circle.kind === 'circle');
  assert.ok(close([...circle.position.origin, circle.radius], [20 * DEG, 30 * DEG, 10 * DEG]));
  assert.ok(warnings.some((w) => /a p-curve among a representation's items .*\(#47\)/.test(w)), `${warnings}`);
  assert.ok(warnings.some((w) => /a point that isn't 3D \(#42\)/.test(w)), `${warnings}`);
});

test('importStep builds models with the representation\'s units, and says what it can\'t read', async () => {
  const data = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));
#11=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#12=(CONVERSION_BASED_UNIT('DEGREE',#13)NAMED_UNIT(#14)PLANE_ANGLE_UNIT());
#13=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#11);
#14=DIMENSIONAL_EXPONENTS(0.,0.,0.,0.,0.,0.,0.);
#15=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-5),#10,'','');
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#15))GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#12))REPRESENTATION_CONTEXT('',''));
#20=PRODUCT('P','P','',(#2));
#21=PRODUCT_DEFINITION_FORMATION('','',#20);
#22=PRODUCT_DEFINITION('','',#21,#3);
#23=PRODUCT_DEFINITION_SHAPE('','',#22);
#24=SHAPE_REPRESENTATION('',(#50),#16);
#25=SHAPE_DEFINITION_REPRESENTATION(#23,#24);
${GEOMETRY.replace(/#(\d+)/g, (_, n) => `#${Number(n) + 1000}`)}
#60=UNKNOWN_THING('');
`.replace('#24=SHAPE_REPRESENTATION(\'\',(#50),#16);', '#24=SHAPE_REPRESENTATION(\'\',(#1050,#60),#16);');
  const { scene } = await importStep(file(data));
  const d = scene.parts[0]!.brep!.model as BrepData;
  // In millimetres: lengths times 10 (the uncertainty, radii, magnitudes, a trim's v on a cylinder), angles in
  // radians, parameters as they were.
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
  assert.ok(near(decode.part(d).uncertainty!, 1e-4));
  const surfaces = Array.from({ length: rowCount(d, 'surface') }, (_, k) => decode.surface(d, k));
  const curves = Array.from({ length: rowCount(d, 'curve') }, (_, k) => decode.curve(d, k));
  const cone = surfaces.find((s) => s.kind === 'cone')!;
  assert.ok(cone.kind === 'cone' && near(cone.semiAngle, Math.PI / 6) && near(cone.radius, 10));
  const cyl = surfaces.find((s) => s.kind === 'cylinder')!;
  assert.ok(cyl.kind === 'cylinder' && near(cyl.radius, 20));
  const trim = surfaces.find((s) => s.kind === 'rectangularTrimmed')!;
  assert.ok(trim.kind === 'rectangularTrimmed' && near(trim.u1, Math.PI / 2) && near(trim.u2, Math.PI)
    && near(trim.v1, 0) && near(trim.v2, 50), JSON.stringify(trim));
  const torus = surfaces.find((s) => s.kind === 'torus')!;
  assert.ok(torus.kind === 'torus' && near(torus.majorRadius, 50) && near(torus.minorRadius, 10));
  const offset = surfaces.find((s) => s.kind === 'offset')!;
  assert.ok(offset.kind === 'offset' && near(offset.distance, 5));
  const extrusion = surfaces.find((s) => s.kind === 'extrusion')!;
  assert.ok(extrusion.kind === 'extrusion' && near(extrusion.magnitude, 30));
  const line = curves.find((c) => c.kind === 'line')!;
  assert.ok(line.kind === 'line' && near(line.magnitude, 40) && line.point.every((x) => x === 0));
  const trimmed = curves.find((c) => c.kind === 'trimmed' && c.trim1.parameter === 2)!;
  assert.ok(trimmed.kind === 'trimmed' && trimmed.trim2.point!.every((x) => x === 0));
  const arc = curves.find((c) => c.kind === 'trimmed' && c.trim1.parameter !== 2)!;
  assert.ok(arc.kind === 'trimmed' && near(arc.trim1.parameter!, Math.PI / 2));
  const bspline = curves.find((c) => c.kind === 'bspline' && c.weights)!;
  assert.ok(bspline.kind === 'bspline' && near(bspline.poles[1]![0]!, 10) && bspline.weights![1] === 0.5
    && bspline.knots[1] === 0.5);
  assert.ok(near((curves.find((c) => c.kind === 'circle') as { radius: number }).radius, 20));
  const offsetCurve = curves.find((c) => c.kind === 'offset')!;
  assert.ok(offsetCurve.kind === 'offset' && near(offsetCurve.distance, 2.5));
  assert.ok(scene.diagnostics.some((x) => x.source?.id === 24 && /^B-rep model: .*negative radius/.test(x.message)));
  assert.ok(scene.diagnostics.some((x) => x.source?.id === 24 && /^B-rep model: an item not in the B-rep model/
    .test(x.message)), JSON.stringify(scene.diagnostics));
});

test('the result counts what it made', async () => {
  const out: StepBrepResult = await convert(TOPOLOGY, [85], 1);
  assert.deepEqual([out.counts.face, out.counts.edge, out.counts.vertex, out.counts.shell, out.counts.body],
    [2, 5, 4, 1, 1]);
});

test('a seam\'s p-curves swap with the face\'s sense or the bound\'s, and come back with both', async () => {
  const seamUs = async (data: string) => {
    const { brep: d, seams } = await convert(data, [137], DEG);
    const l = decode.face(d, 0).loops[0]!;
    assert.ok(l.kind === 'edge' && seams === 0);
    return [l.coedges[1]!, l.coedges[3]!].map((c) => {
      const x = decode.curve(d, c.pcurve!);
      return x.kind === 'line' ? Math.round(x.point[0]! * 1e9) / 1e9 : NaN;
    });
  };
  const two = Math.round(2 * Math.PI * 1e9) / 1e9;
  const face = (s: string) =>
    TOPOLOGY.replace("#135=ADVANCED_FACE('',(#134),#100,.T.);", `#135=ADVANCED_FACE('',(#134),#100,${s});`);
  const bound = (data: string, s: string) =>
    data.replace("#134=FACE_OUTER_BOUND('',#133,.T.);", `#134=FACE_OUTER_BOUND('',#133,${s});`);
  assert.deepEqual(await seamUs(TOPOLOGY), [two, 0]);
  assert.deepEqual(await seamUs(face('.F.')), [0, two]);
  assert.deepEqual(await seamUs(bound(TOPOLOGY, '.F.')), [0, two]);
  assert.deepEqual(await seamUs(bound(face('.F.'), '.F.')), [two, 0]);
});

test('a seam edge against its curve gives the same p-curves; uses the rule can\'t tell apart get none', async () => {
  // The seam's vertices swapped and same_sense false, its uses turned over: the same geometry, the same p-curves.
  const against = TOPOLOGY.replace("#128=EDGE_CURVE('',#112,#113,#127,.T.);", "#128=EDGE_CURVE('',#113,#112,#127,.F.);")
    .replace("#130=ORIENTED_EDGE('',*,*,#128,.T.);", "#130=ORIENTED_EDGE('',*,*,#128,.F.);")
    .replace("#132=ORIENTED_EDGE('',*,*,#128,.F.);", "#132=ORIENTED_EDGE('',*,*,#128,.T.);");
  const pcurveU = async (data: string) => {
    const { brep: d, seams } = await convert(data, [137], DEG);
    const l = decode.face(d, 0).loops[0]!;
    assert.ok(l.kind === 'edge');
    return { seams, u: [l.coedges[1]!, l.coedges[3]!].map((c) => {
      if (c.pcurve === undefined) return undefined;
      const x = decode.curve(d, c.pcurve);
      return x.kind === 'line' ? Math.round(x.point[0]! * 1e9) / 1e9 : NaN;
    }) };
  };
  assert.deepEqual(await pcurveU(against), { seams: 0, u: [Math.round(2 * Math.PI * 1e9) / 1e9, 0] });
  // Both uses forward (no valid loop): the rule gives both one p-curve, so neither keeps it.
  const both = TOPOLOGY.replace("#132=ORIENTED_EDGE('',*,*,#128,.F.);", "#132=ORIENTED_EDGE('',*,*,#128,.T.);");
  assert.deepEqual(await pcurveU(both), { seams: 1, u: [undefined, undefined] });
});

test('two faces on one surface sharing an edge: its two p-curves, coinciding, both theirs; else told apart as a seam',
  async () => {
    // The open shell's two faces both on the plane #10, so the edge #52 they share has both p-curves on it (CATIA's
    // faces on one closed surface, pr1db.stp).
    const oneSurface = (second: string) => TOPOLOGY.replace("#50=PCURVE('',#11,#49);", "#50=PCURVE('',#10,#49);")
      .replace("#82=ADVANCED_FACE('',(#81),#11,.F.);", "#82=ADVANCED_FACE('',(#81),#10,.F.);")
      .replace("#48=LINE('',#42,#44);", second);
    const uses = async (data: string) => {
      const { brep: d, seams } = await convert(data, [85], 1);
      const pc = [0, 1].map((f) => {
        const l = decode.face(d, f).loops[0]!;
        assert.ok(l.kind === 'edge');
        const c = l.coedges.find((x) => decode.edge(d, x.edge).id === 52)!;
        if (c.pcurve === undefined) return undefined;
        const x = decode.curve(d, c.pcurve);
        return x.kind === 'line' ? [...x.point, ...x.direction] : NaN;
      });
      return { seams, pc };
    };
    // Coinciding (the same line twice): each face's use takes it.
    assert.deepEqual(await uses(oneSurface("#48=LINE('',#42,#44);")), { seams: 0, pc: [[0, 0, 1, 0], [0, 0, 1, 0]] });
    // Apart (v = 0 and v = 1): one each, as a seam's.
    const apart = await uses(oneSurface("#48=LINE('',#57,#44);"));
    assert.equal(apart.seams, 0);
    assert.notDeepEqual(apart.pc[0], apart.pc[1]);
    assert.ok(apart.pc.every((x) => Array.isArray(x)));
    // Crossing where the edge's parameter is 0 but apart elsewhere: not one curve; the rule can't tell them apart.
    const crossing = "#48=LINE('',#42,#90);\n#90=VECTOR('',#91,1.);\n#91=DIRECTION('',(1.,1.));";
    assert.deepEqual(await uses(oneSurface(crossing)), { seams: 1, pc: [undefined, undefined] });
    // Close but apart (1e-6): told apart, not taken for one.
    const close = await uses(oneSurface("#48=LINE('',#92,#44);\n#92=CARTESIAN_POINT('',(0.,1.E-6));"));
    const [c0, c1] = close.pc as number[][];
    assert.deepEqual([close.seams, Array.isArray(c0) && Array.isArray(c1), c0![1] !== c1![1]], [0, true, true]);
    // B-splines (a finite range) from (0, 0) to (1, 0) and from (0, 1) to (1, -1), crossing halfway: not one curve.
    const spline = (k: number, p: string, q: string) => `#${k}=B_SPLINE_CURVE_WITH_KNOTS('',1,(${p},${q}),`
      + `.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.);`;
    const splines = oneSurface(`${spline(48, '#57', '#94')}\n#93=CARTESIAN_POINT('',(1.,0.));`
      + `\n#94=CARTESIAN_POINT('',(1.,-1.));`).replace("#45=LINE('',#42,#44);", spline(45, '#42', '#93'));
    assert.deepEqual(await uses(splines), { seams: 1, pc: [undefined, undefined] });
    // The same B-spline twice: each face's.
    const same = await uses(oneSurface(`${spline(48, '#42', '#93')}\n#93=CARTESIAN_POINT('',(1.,0.));`)
      .replace("#45=LINE('',#42,#44);", spline(45, '#42', '#93')));
    assert.equal(same.seams, 0);
  });

test('a torus with a negative major radius: its absolute value, its faces turned over, p-curves on it not read',
  async () => {
  // The same face on a torus of major radius -5 (directly and trimmed) and of +5; the first two turned over.
  const data = `
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=TOROIDAL_SURFACE('',#4,-5.,1.);
#6=TOROIDAL_SURFACE('',#4,5.,1.);
#7=RECTANGULAR_TRIMMED_SURFACE('',#5,0.,6.,0.,6.,.T.,.T.);
#10=CARTESIAN_POINT('',(6.,0.,0.));
#11=VERTEX_POINT('',#10);
#12=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#13=CIRCLE('',#12,6.);
#14=CARTESIAN_POINT('',(0.,0.));
#15=DIRECTION('',(1.,0.));
#16=VECTOR('',#15,1.);
#17=LINE('',#14,#16);
#18=(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('',''));
#19=DEFINITIONAL_REPRESENTATION('',(#17),#18);
#20=PCURVE('',#5,#19);
#21=SURFACE_CURVE('',#13,(#20),.CURVE_3D.);
#22=EDGE_CURVE('',#11,#11,#21,.T.);
#23=ORIENTED_EDGE('',*,*,#22,.T.);
#24=EDGE_LOOP('',(#23));
#25=FACE_OUTER_BOUND('',#24,.T.);
#30=ADVANCED_FACE('',(#25),#5,.T.);
#31=FACE_SURFACE('',(#25),#7,.F.);
#32=ADVANCED_FACE('',(#25),#6,.T.);
#40=OPEN_SHELL('',(#30,#31,#32));
#41=SHELL_BASED_SURFACE_MODEL('',(#40));`;
  const { brep, warnings } = await convert(data, [41]);
  assert.deepEqual([0, 1, 2].map((f) => [brep.face.id[f], brep.face.sameSense[f]]), [[30, 0], [31, 1], [32, 1]]);
  assert.deepEqual(decode.surface(brep, brep.face.surface[0]!), { kind: 'torus', position: { origin: [0, 0, 0],
    axis: [0, 0, 1], xDir: [1, 0, 0] }, majorRadius: 5, minorRadius: 1, id: 5 });
  assert.equal(brep.coedge.pcurve[0], -1);
  assert.deepEqual(warnings, [
    'B-rep model: a torus with a negative major radius (read with its absolute value, its faces turned over) (#5)',
    'B-rep model: a p-curve on a torus with a negative major radius (not read) (#20)',
  ]);
});

test('an instance #0 in the model gets no id (its ids are 1 to 2^32 - 1, 0 for none), an error; one it doesn\'t use '
  + 'none', async () => {
  const data = `
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#0=CIRCLE('',#4,2.);
#4294967295=CIRCLE('',#4,3.);`;
  const run = async (ids: number[]) => {
    const model = await openModel(parseStep(file(data)));
    const said: [string, string | undefined][] = [];
    const out = stepBrep(new Reader(model), ids.map((id) => model.resolve(id)), { length: 1, angle: 1 },
      (m, severity) => said.push([m, severity]));
    return { d: out.brep, said };
  };
  const { d, said } = await run([0, 4294967295]);
  assert.deepEqual(Array.from(d.curve.id), [0, 4294967295]);
  assert.equal(decode.curve(d, 0).id, undefined);
  assert.equal(decode.curve(d, 1).id, 4294967295);
  // (Two rows from it: the curve, and the item placing it.)
  assert.deepEqual(Array.from(d.item.id), [0, 4294967295]);
  assert.deepEqual(said.filter(([m]) => /#0/.test(m)), [['B-rep model: 2 x an instance #0 in the model (its row '
    + 'without a source id: the model\'s ids start at 1) (#0, #0)', 'error']]);
  // (#0 in the file, not reached by the model: nothing said.)
  const other = await run([4294967295]);
  assert.deepEqual([Array.from(other.d.curve.id), other.said], [[4294967295], []]);
});

// Every kind at once, in millimetres, away from the origin (scaling 0 changes nothing): curves 3D and 2D, every
// surface, p-curves of every 2D kind on a plane, a cylinder and a sphere (curve-bounded surfaces), a face with an edge
// loop and vertices, a poly loop, a torus with a negative major radius, a loose point. (Each surface's 2D curves its
// own: in another unit, one 2D curve on surfaces that scale apart is a row per scale, and the rows wouldn't pair.)
const ALL_KINDS = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#15=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-5),#10,'','');
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#15))GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#11))REPRESENTATION_CONTEXT('',''));
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('',''));
#20=PRODUCT('P','P','',(#2));
#21=PRODUCT_DEFINITION_FORMATION('','',#20);
#22=PRODUCT_DEFINITION('','',#21,#3);
#23=PRODUCT_DEFINITION_SHAPE('','',#22);
#24=SHAPE_REPRESENTATION('',(#500,#600),#16);
#25=SHAPE_DEFINITION_REPRESENTATION(#23,#24);
#100=CARTESIAN_POINT('',(1.,2.,3.));
#101=DIRECTION('',(0.,0.,1.));
#102=DIRECTION('',(1.,0.,0.));
#103=AXIS2_PLACEMENT_3D('',#100,#101,#102);
#104=CARTESIAN_POINT('',(4.,-5.,6.));
#105=CARTESIAN_POINT('',(7.,8.,-9.));
#106=CARTESIAN_POINT('',(-2.,3.,5.));
#110=VECTOR('',#101,2.5);
#111=LINE('',#104,#110);
#112=CIRCLE('',#103,2.);
#113=ELLIPSE('',#103,3.,1.5);
#114=HYPERBOLA('',#103,1.,2.);
#115=PARABOLA('',#103,0.75);
#116=B_SPLINE_CURVE_WITH_KNOTS('',2,(#104,#105,#106),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,2.),.UNSPECIFIED.);
#117=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#104,#105,#106),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(1.,4.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,0.5,2.))REPRESENTATION_ITEM(''));
#118=POLYLINE('',(#104,#105,#106));
#119=TRIMMED_CURVE('',#111,(#104,PARAMETER_VALUE(0.)),(#105,PARAMETER_VALUE(1.5)),.T.,.PARAMETER.);
#120=COMPOSITE_CURVE('',(#121),.F.);
#121=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#116);
#122=OFFSET_CURVE_3D('',#116,0.25,.F.,#101);
#130=PLANE('',#103);
#131=CYLINDRICAL_SURFACE('',#103,4.);
#132=CONICAL_SURFACE('',#103,1.5,0.4);
#133=SPHERICAL_SURFACE('',#103,6.);
#134=TOROIDAL_SURFACE('',#103,5.,1.);
#135=TOROIDAL_SURFACE('',#103,-7.,2.);
#136=B_SPLINE_SURFACE_WITH_KNOTS('',1,1,((#104,#105),(#106,#100)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,3.),.UNSPECIFIED.);
#137=SURFACE_OF_LINEAR_EXTRUSION('',#116,#110);
#138=SURFACE_OF_REVOLUTION('',#111,#139);
#139=AXIS1_PLACEMENT('',#105,#102);
#140=OFFSET_SURFACE('',#131,0.5,.F.);
#141=RECTANGULAR_TRIMMED_SURFACE('',#130,-1.,2.,-3.,4.,.T.,.T.);
#142=RECTANGULAR_TRIMMED_SURFACE('',#131,0.5,2.,-1.,3.,.T.,.F.);
#200=CARTESIAN_POINT('',(1.,2.));
#201=DIRECTION('',(0.6,0.8));
#202=VECTOR('',#201,2.);
#203=LINE('',#200,#202);
#204=AXIS2_PLACEMENT_2D('',#200,#201);
#205=CIRCLE('',#204,1.5);
#206=ELLIPSE('',#204,2.,1.);
#207=HYPERBOLA('',#204,1.,3.);
#208=PARABOLA('',#204,-0.5);
#209=CARTESIAN_POINT('',(3.,1.));
#210=CARTESIAN_POINT('',(4.,5.));
#211=B_SPLINE_CURVE_WITH_KNOTS('',2,(#200,#209,#210),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);
#212=POLYLINE('',(#200,#209,#210));
#213=TRIMMED_CURVE('',#203,(#200,PARAMETER_VALUE(0.)),(PARAMETER_VALUE(1.)),.T.,.PARAMETER.);
#214=OFFSET_CURVE_2D('',#211,0.3,.F.);
#215=COMPOSITE_CURVE('',(#216),.F.);
#216=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#211);
#230=DEFINITIONAL_REPRESENTATION('',(#203),#17);
#231=DEFINITIONAL_REPRESENTATION('',(#205),#17);
#232=DEFINITIONAL_REPRESENTATION('',(#206),#17);
#233=DEFINITIONAL_REPRESENTATION('',(#207),#17);
#234=DEFINITIONAL_REPRESENTATION('',(#208),#17);
#235=DEFINITIONAL_REPRESENTATION('',(#211),#17);
#236=DEFINITIONAL_REPRESENTATION('',(#212),#17);
#237=DEFINITIONAL_REPRESENTATION('',(#213),#17);
#238=DEFINITIONAL_REPRESENTATION('',(#214),#17);
#239=DEFINITIONAL_REPRESENTATION('',(#215),#17);
#250=LINE('',#200,#202);
#251=B_SPLINE_CURVE_WITH_KNOTS('',2,(#200,#209,#210),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);
#252=POLYLINE('',(#200,#209,#210));
#253=TRIMMED_CURVE('',#250,(#200,PARAMETER_VALUE(0.)),(PARAMETER_VALUE(1.)),.T.,.PARAMETER.);
#254=CIRCLE('',#204,1.5);
#255=B_SPLINE_CURVE_WITH_KNOTS('',2,(#200,#209,#210),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);
#256=OFFSET_CURVE_2D('',#255,0.3,.F.);
#260=DEFINITIONAL_REPRESENTATION('',(#250),#17);
#261=DEFINITIONAL_REPRESENTATION('',(#251),#17);
#262=DEFINITIONAL_REPRESENTATION('',(#252),#17);
#263=DEFINITIONAL_REPRESENTATION('',(#253),#17);
#264=DEFINITIONAL_REPRESENTATION('',(#254),#17);
#265=DEFINITIONAL_REPRESENTATION('',(#256),#17);
#300=PCURVE('',#130,#230);
#301=PCURVE('',#130,#231);
#302=PCURVE('',#130,#232);
#303=PCURVE('',#130,#233);
#304=PCURVE('',#130,#234);
#305=PCURVE('',#130,#235);
#306=PCURVE('',#130,#236);
#307=PCURVE('',#130,#237);
#308=PCURVE('',#130,#238);
#309=PCURVE('',#130,#239);
#310=PCURVE('',#131,#260);
#311=PCURVE('',#131,#261);
#312=PCURVE('',#131,#262);
#313=PCURVE('',#131,#263);
#314=PCURVE('',#133,#264);
#315=PCURVE('',#133,#265);
${[...Array(16).keys()].map((k) => `#${320 + k}=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${300 + k});`).join('\n')}
#340=BOUNDARY_CURVE('',(#320,#321,#322,#323,#324,#325,#326,#327,#328,#329),.U.);
#341=BOUNDARY_CURVE('',(#330,#331,#332,#333),.U.);
#342=BOUNDARY_CURVE('',(#334,#335),.U.);
#350=CURVE_BOUNDED_SURFACE('',#130,(#340),.F.);
#351=CURVE_BOUNDED_SURFACE('',#131,(#341),.F.);
#352=CURVE_BOUNDED_SURFACE('',#133,(#342),.F.);
#400=VERTEX_POINT('',#104);
#401=VERTEX_POINT('',#105);
#402=EDGE_CURVE('',#400,#401,#111,.T.);
#403=EDGE_CURVE('',#401,#400,#118,.T.);
#404=ORIENTED_EDGE('',*,*,#402,.T.);
#405=ORIENTED_EDGE('',*,*,#403,.T.);
#406=EDGE_LOOP('',(#404,#405));
#407=FACE_OUTER_BOUND('',#406,.T.);
#408=ADVANCED_FACE('',(#407),#136,.T.);
#409=POLY_LOOP('',(#104,#105,#106));
#410=FACE_OUTER_BOUND('',#409,.T.);
#411=FACE_SURFACE('',(#410),#130,.T.);
#412=OPEN_SHELL('',(#408,#411));
#500=SHELL_BASED_SURFACE_MODEL('',(#412));
#600=GEOMETRIC_SET('',(#111,#112,#113,#114,#115,#116,#117,#118,#119,#120,#122,#132,#134,#135,#137,#138,#140,#141,#142,#350,#351,#352,#105));
`;

test('in a file of another unit, every length is millimetres and nothing else changes: the oracle, on every kind',
  async () => {
  // The file in millimetres, then the same text in centimetres (every length 10 times as long), and in inches.
  const inch = ALL_KINDS.replace('#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));',
    '#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));#9=(LENGTH_UNIT()CONVERSION_BASED_UNIT(\'INCH\',#8)'
    + 'NAMED_UNIT(*));#8=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#10);')
    .replace('GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#11))', 'GLOBAL_UNIT_ASSIGNED_CONTEXT((#9,#11))')
    .replace("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-5),#10,'','')",
      "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-5),#9,'','')");
  const mm = (await importStep(file(ALL_KINDS))).scene;
  const a = mm.parts[0]!.brep!.model;
  // What the model holds: 11 3D curves, the plane's 10 2D ones, the cylinder's 4 (a line, a B-spline, a polyline, a
  // trim of the line), the sphere's 3 (a circle, an offset of its own B-spline); 12 surfaces; the edge-loop face, the
  // poly-loop face and three curve-bounded ones; the edges' two vertices and the poly loop's third corner; the
  // geometric set's 23 elements and the surface model.
  assert.deepEqual([rowCount(a, 'curve'), rowCount(a, 'surface'), rowCount(a, 'face'), rowCount(a, 'vertex'),
    rowCount(a, 'item')], [28, 12, 5, 3, 24]);
  assert.deepEqual(mm.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message).filter((m) =>
    !/negative major radius/.test(m)), []);
  for (const [k, text] of [[10, ALL_KINDS.replace('.MILLI.', '.CENTI.')], [25.4, inch]] as const) {
    const scene = (await importStep(file(text))).scene;
    const problems: string[] = [];
    const r = compareScaled(a, scene.parts[0]!.brep!.model, k, `x ${k}`, (what, ex) => problems.push(
      `${what}: ${ex}`));
    assert.deepEqual(problems, [], `x ${k}`);
    assert.ok(r.ok && r.checked > 300, `x ${k}: ${r.checked}`);
    // (The origin a box's centre, from scaled ends: to the last bits.)
    scene.parts[0]!.origin.forEach((x, j) => assert.ok(Math.abs(x - mm.parts[0]!.origin[j]! * k) < 1e-12 * 100 * k));
    assert.equal(scene.sourceUnit, k);
  }
});
