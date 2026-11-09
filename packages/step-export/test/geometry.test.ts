// The STEP geometry writer on hand-built models: each entity as Part 42 (and AP242) writes it, the expected text
// written from the standard's attribute order, not from the writer; ids; units; diagnostics; binding against AP242;
// and every model read back by step-import's reader equal to itself up to row order and what STEP can't hold.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, type Curve, rowCount, type Surface } from 'cad-brep';
import { formatValue, type Instance, openModel, parseStep, type Value } from 'step-parser';
import { cone, cube, everyKind, facetedAndWire, seamCylinder, spheres, withVoid } from '../../cad-brep/test/models.ts';
import { stepPartBytes } from '../src/index.ts';
import { differences, walk } from './compare.ts';
import { readBack } from './readback.ts';

/** A model written: its instances by id, the root, the diagnostics. */
function written(d: BrepData) {
  const w = stepPartBytes(d);
  const byId = new Map<number, Instance>();
  for (const inst of parseStep(w.data).instances()) byId.set(inst.id, inst);
  return { ...w, byId, text: new TextDecoder().decode(w.data) };
}
type Written = ReturnType<typeof written>;

/** An instance with its references written out in full, but those to `keep` (as #id). */
function render(w: Written, id: number, keep: ReadonlySet<number> = new Set()): string {
  const inst = w.byId.get(id);
  assert.ok(inst, `#${id} written`);
  const r = (x: number) => keep.has(x) ? `#${x}` : render(w, x, keep);
  const val = (v: Value): string => v.k === 'ref' ? r(v.v)
    : v.k === 'refs' ? `(${Array.from(v.v, r).join(',')})`
      : v.k === 'list' ? `(${v.v.map(val).join(',')})`
        : v.k === 'typed' ? `${v.type}(${val(v.v)})` : formatValue(v);
  const rec = (type: string, attrs: Value[]) => `${type}(${attrs.map(val).join(',')})`;
  return 'parts' in inst ? `(${inst.parts.map((p) => rec(p.type, p.attrs)).join('')})` : rec(inst.type, inst.attrs);
}

const P = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };
const A3 = 'AXIS2_PLACEMENT_3D(\'\',CARTESIAN_POINT(\'\',(1.,2.,3.)),DIRECTION(\'\',(0.,0.,1.)),'
  + 'DIRECTION(\'\',(1.,0.,0.)))';
const cp = (...x: string[]) => `CARTESIAN_POINT('',(${x.join(',')}))`;
const dir = (...x: string[]) => `DIRECTION('',(${x.join(',')}))`;
const bs = (dim: 2 | 3, rational: boolean, id?: number): Curve => ({ kind: 'bspline', degree: 2, knots: [0, 0.5, 1],
  multiplicities: [3, 1, 3], poles: [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1]].map((q) => q.slice(0, dim)),
  ...(rational ? { weights: [1, 0.5, 2, 1] } : {}), closed: false, selfIntersect: null, form: 'unspecified',
  ...(id ? { id } : {}) });

test('3D curves: each kind in Part 42\'s attribute order', () => {
  const b = new BrepBuilder({ unit: 1 });
  const curves: Curve[] = [
    { kind: 'line', point: [0, 0, 0], direction: [0, 0.6, 0.8], magnitude: 2.5, id: 11 },
    { kind: 'circle', position: P, radius: 2, id: 12 },
    { kind: 'ellipse', position: P, semiAxis1: 3, semiAxis2: 1, id: 13 },
    { kind: 'hyperbola', position: P, semiAxis: 1, semiImagAxis: 2, id: 14 },
    { kind: 'parabola', position: P, focalDist: -0.5, id: 15 },
    bs(3, false, 16), bs(3, true, 17),
    { kind: 'polyline', points: [[0, 0, 0], [1, 0, 0], [1, 1, 1]], id: 18 },
    { kind: 'trimmed', basis: 1, trim1: { parameter: 0, point: [3, 2, 3] }, trim2: { parameter: 1.5 }, sense: true,
      preference: 'parameter', id: 19 },
    { kind: 'composite', segments: [{ curve: 0, sameSense: true, transition: 'continuous' },
      { curve: 7, sameSense: false, transition: 'discontinuous' }], selfIntersect: false, id: 20 },
    { kind: 'offset', basis: 5, distance: 0.25, selfIntersect: null, refDirection: [0, 1, 0], id: 21 },
  ];
  curves.forEach((c, k) => { b.addCurve(c); b.addItem({ kind: 'curve', ref: k }); });
  const w = written(b.finish());
  const keep = new Set([11, 12, 16, 18]);
  const poles3 = `(${cp('0.', '0.', '0.')},${cp('1.', '1.', '0.')},${cp('2.', '0.', '1.')},${cp('3.', '1.', '1.')})`;
  const expected: [number, string][] = [
    [11, `LINE('',${cp('0.', '0.', '0.')},VECTOR('',${dir('0.', '0.6', '0.8')},2.5))`],
    [12, `CIRCLE('',${A3},2.)`],
    [13, `ELLIPSE('',${A3},3.,1.)`],
    [14, `HYPERBOLA('',${A3},1.,2.)`],
    [15, `PARABOLA('',${A3},-0.5)`],
    [16, `B_SPLINE_CURVE_WITH_KNOTS('',2,${poles3},.UNSPECIFIED.,.F.,.U.,(3,1,3),(0.,0.5,1.),.UNSPECIFIED.)`],
    // A complex instance: the partials in alphabetical order, each with its own attributes.
    [17, `(BOUNDED_CURVE()B_SPLINE_CURVE(2,${poles3},.UNSPECIFIED.,.F.,.U.)`
      + 'B_SPLINE_CURVE_WITH_KNOTS((3,1,3),(0.,0.5,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()'
      + 'RATIONAL_B_SPLINE_CURVE((1.,0.5,2.,1.))REPRESENTATION_ITEM(\'\'))'],
    [18, `POLYLINE('',(${cp('0.', '0.', '0.')},${cp('1.', '0.', '0.')},${cp('1.', '1.', '1.')}))`],
    [19, `TRIMMED_CURVE('',#12,(${cp('3.', '2.', '3.')},PARAMETER_VALUE(0.)),(PARAMETER_VALUE(1.5)),.T.,.PARAMETER.)`],
    [20, 'COMPOSITE_CURVE(\'\',(COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#11),'
      + 'COMPOSITE_CURVE_SEGMENT(.DISCONTINUOUS.,.F.,#18)),.F.)'],
    [21, `OFFSET_CURVE_3D('',#16,0.25,.U.,${dir('0.', '1.', '0.')})`],
  ];
  for (const [id, text] of expected) assert.equal(render(w, id, keep), text, `#${id}`);
  // Only curves: a wireframe's geometric curve set.
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION');
  assert.equal(render(w, (root.attrs[1] as { v: number[] }).v[0]!, new Set(curves.map((c) => c.id!))),
    `GEOMETRIC_CURVE_SET('',(${curves.map((c) => `#${c.id}`).join(',')}))`);
  assert.deepEqual(w.diagnostics, []);
});

test('2D curves as p-curves: each kind, through a PCURVE in the parameter space\'s context', () => {
  const b = new BrepBuilder({ unit: 1 });
  const P2 = { origin: [1, 2], xDir: [0, 1] };
  const curves: Curve[] = [
    { kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1, id: 31 },
    { kind: 'circle', position: P2, radius: 1, id: 32 },
    { kind: 'ellipse', position: P2, semiAxis1: 2, semiAxis2: 1, id: 33 },
    { kind: 'hyperbola', position: P2, semiAxis: 1, semiImagAxis: 1, id: 34 },
    { kind: 'parabola', position: P2, focalDist: 1, id: 35 },
    bs(2, false, 36), bs(2, true, 37),
    { kind: 'polyline', points: [[0, 0], [1, 1]], id: 38 },
    { kind: 'trimmed', basis: 1, trim1: { point: [2, 2] }, trim2: { point: [1, 3] }, sense: false,
      preference: 'cartesian', id: 39 },
    { kind: 'composite', segments: [{ curve: 0, sameSense: true, transition: 'cont_same_gradient' }],
      selfIntersect: null, id: 40 },
    { kind: 'offset', basis: 5, distance: -0.1, selfIntersect: false, id: 41 },
  ];
  for (const c of curves) b.addCurve(c);
  const plane = b.addSurface({ kind: 'plane', position: P, id: 50 });
  // A curve-bounded face whose boundary segments have only p-curves, one of each kind.
  const edges = curves.map((_, k) => b.addEdge({ sameSense: true, id: 61 + k }));
  const f = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: edges.map((edge, k) => ({ edge, orientation: 'forward' as const, pcurve: k })), id: 80 }], id: 90 });
  b.addItem({ kind: 'face', ref: f });
  const w = written(b.finish());
  const A2 = `AXIS2_PLACEMENT_2D('',${cp('1.', '2.')},${dir('0.', '1.')})`;
  const poles2 = `(${cp('0.', '0.')},${cp('1.', '1.')},${cp('2.', '0.')},${cp('3.', '1.')})`;
  const keep = new Set([31, 32, 36, 50, 80]);
  const expected: [number, string][] = [
    [31, `LINE('',${cp('0.', '0.')},VECTOR('',${dir('1.', '0.')},1.))`],
    [32, `CIRCLE('',${A2},1.)`],
    [33, `ELLIPSE('',${A2},2.,1.)`],
    [34, `HYPERBOLA('',${A2},1.,1.)`],
    [35, `PARABOLA('',${A2},1.)`],
    [36, `B_SPLINE_CURVE_WITH_KNOTS('',2,${poles2},.UNSPECIFIED.,.F.,.U.,(3,1,3),(0.,0.5,1.),.UNSPECIFIED.)`],
    [37, `(BOUNDED_CURVE()B_SPLINE_CURVE(2,${poles2},.UNSPECIFIED.,.F.,.U.)`
      + 'B_SPLINE_CURVE_WITH_KNOTS((3,1,3),(0.,0.5,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()'
      + 'RATIONAL_B_SPLINE_CURVE((1.,0.5,2.,1.))REPRESENTATION_ITEM(\'\'))'],
    [38, `POLYLINE('',(${cp('0.', '0.')},${cp('1.', '1.')}))`],
    [39, `TRIMMED_CURVE('',#32,(${cp('2.', '2.')}),(${cp('1.', '3.')}),.F.,.CARTESIAN.)`],
    [40, 'COMPOSITE_CURVE(\'\',(COMPOSITE_CURVE_SEGMENT(.CONT_SAME_GRADIENT.,.T.,#31)),.U.)'],
    [41, 'OFFSET_CURVE_2D(\'\',#36,-0.1,.F.)'],
  ];
  for (const [id, text] of expected) assert.equal(render(w, id, keep), text, `#${id}`);
  const context2d = '(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()'
    + 'REPRESENTATION_CONTEXT(\'2D SPACE\',\'\'))';
  const segment = (k: number) => `COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,PCURVE('',#50,`
    + `DEFINITIONAL_REPRESENTATION('',(#${31 + k}),${context2d})))`;
  assert.equal(render(w, 90, new Set([50, ...curves.map((c) => c.id!)])), 'CURVE_BOUNDED_SURFACE(\'\',#50,('
    + `OUTER_BOUNDARY_CURVE('',(${curves.map((_, k) => segment(k)).join(',')}),.U.)),.F.)`);
  // The segments are the edges, the boundary the loop.
  assert.equal(w.byId.get(61)?.['type' as never], 'COMPOSITE_CURVE_SEGMENT');
  assert.equal(w.byId.get(80)?.['type' as never], 'OUTER_BOUNDARY_CURVE');
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION');
  assert.equal(render(w, (root.attrs[1] as { v: number[] }).v[0]!, new Set([90])), 'GEOMETRIC_SET(\'\',(#90))');
});

test('surfaces: each kind in Part 42\'s attribute order', () => {
  const b = new BrepBuilder({ unit: 1 });
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1, id: 1 });
  const ellipse = b.addCurve({ kind: 'ellipse', position: P, semiAxis1: 3, semiAxis2: 1, id: 2 });
  const spline = b.addCurve(bs(3, false, 3));
  const surfaces: Surface[] = [
    { kind: 'plane', position: P, id: 101 },
    { kind: 'cylinder', position: P, radius: 1, id: 102 },
    { kind: 'cone', position: P, radius: 0.5, semiAngle: Math.PI / 6, id: 103 },
    { kind: 'sphere', position: P, radius: 4, id: 104 },
    { kind: 'torus', position: P, majorRadius: 5, minorRadius: 1, id: 105 },
    { kind: 'torus', position: P, majorRadius: 1, minorRadius: 2, selectOuter: true, id: 106 },
    { kind: 'bspline', uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1], uMultiplicities: [2, 2],
      vMultiplicities: [3, 3], poles: [[[0, 0, 0], [0, 1, 1], [0, 2, 0]], [[1, 0, 0], [1, 1, 1], [1, 2, 0]]],
      uClosed: false, vClosed: null, selfIntersect: false, form: 'unspecified', id: 107 },
    { kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 2], vKnots: [-1, 1], uMultiplicities: [2, 2],
      vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
      weights: [[1, 2], [0.5, 1]], uClosed: false, vClosed: false, selfIntersect: null, form: 'plane_surf', id: 108 },
    { kind: 'extrusion', curve: spline, direction: [0, 0, 1], magnitude: 3, id: 109 },
    { kind: 'revolution', curve: line, axisOrigin: [0, 0, 0], axisDirection: [1, 0, 0], id: 110 },
    { kind: 'offset', basis: 7, distance: 0.5, selfIntersect: null, id: 111 },
    { kind: 'rectangularTrimmed', basis: 1, u1: 0, u2: Math.PI, v1: -1, v2: 2, uSense: true, vSense: false, id: 112 },
    { kind: 'curveSwept', curve: ellipse, directrix: line, referenceSurface: 0, id: 113 },
    { kind: 'fixedReferenceSwept', curve: ellipse, directrix: line, fixedReference: [0, 1, 0], id: 114 },
  ];
  surfaces.forEach((s, k) => { b.addSurface(s); b.addItem({ kind: 'surface', ref: k }); });
  const w = written(b.finish());
  const keep = new Set([1, 2, 3, 101, 102, 108]);
  const row = (...ps: string[][]) => `(${ps.map((q) => cp(...q)).join(',')})`;
  const expected: [number, string][] = [
    [101, `PLANE('',${A3})`],
    [102, `CYLINDRICAL_SURFACE('',${A3},1.)`],
    [103, `CONICAL_SURFACE('',${A3},0.5,0.5235987755982988)`],
    [104, `SPHERICAL_SURFACE('',${A3},4.)`],
    [105, `TOROIDAL_SURFACE('',${A3},5.,1.)`],
    [106, `DEGENERATE_TOROIDAL_SURFACE('',${A3},1.,2.,.T.)`],
    [107, `B_SPLINE_SURFACE_WITH_KNOTS('',1,2,(${row(['0.', '0.', '0.'], ['0.', '1.', '1.'], ['0.', '2.', '0.'])},`
      + `${row(['1.', '0.', '0.'], ['1.', '1.', '1.'], ['1.', '2.', '0.'])}),.UNSPECIFIED.,.F.,.U.,.F.,(2,2),(3,3),`
      + '(0.,1.),(0.,1.),.UNSPECIFIED.)'],
    [108, `(BOUNDED_SURFACE()B_SPLINE_SURFACE(1,1,(${row(['0.', '0.', '0.'], ['0.', '1.', '0.'])},`
      + `${row(['1.', '0.', '0.'], ['1.', '1.', '0.'])}),.PLANE_SURF.,.F.,.F.,.U.)`
      + 'B_SPLINE_SURFACE_WITH_KNOTS((2,2),(2,2),(0.,2.),(-1.,1.),.UNSPECIFIED.)GEOMETRIC_REPRESENTATION_ITEM()'
      + 'RATIONAL_B_SPLINE_SURFACE(((1.,2.),(0.5,1.)))REPRESENTATION_ITEM(\'\')SURFACE())'],
    [109, `SURFACE_OF_LINEAR_EXTRUSION('',#3,VECTOR('',${dir('0.', '0.', '1.')},3.))`],
    [110, `SURFACE_OF_REVOLUTION('',#1,AXIS1_PLACEMENT('',${cp('0.', '0.', '0.')},${dir('1.', '0.', '0.')}))`],
    [111, 'OFFSET_SURFACE(\'\',#108,0.5,.U.)'],
    [112, 'RECTANGULAR_TRIMMED_SURFACE(\'\',#102,0.,3.141592653589793,-1.,2.,.T.,.F.)'],
    [113, 'SURFACE_CURVE_SWEPT_SURFACE(\'\',#2,#1,#101)'],
    [114, `FIXED_REFERENCE_SWEPT_SURFACE('',#2,#1,${dir('0.', '1.', '0.')})`],
  ];
  for (const [id, text] of expected) assert.equal(render(w, id, keep), text, `#${id}`);
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION');
});

test('a solid: vertices, edges, oriented edges, loops, faces, a closed shell, an advanced B-rep in millimetres', () => {
  const d = cube().finish();
  const w = written(d);
  // Source ids: vertices 1-8, edges 9-20, faces 21-26, the solid 100, its item 101: new ids after 101.
  assert.equal(w.rootId, 102);
  const v = (k: number) => `VERTEX_POINT('',${cp(...[k & 1, k & 2 ? 1 : 0, k & 4 ? 1 : 0].map((x) => `${x}.`))})`;
  assert.equal(render(w, 1), v(0));
  assert.equal(render(w, 8), v(7));
  // The first edge: corner 0 to corner 2 (along y), its line's magnitude the edge's length.
  assert.equal(render(w, 9), `EDGE_CURVE('',${v(0)},${v(2)},LINE('',${cp('0.', '0.', '0.')},`
    + `VECTOR('',${dir('0.', '1.', '0.')},1.)),.T.)`);
  // The first face, the bottom (z = 0, its normal -z), corners 0, 2, 3, 1: edges 9, 10, 11, 12 forward.
  const edgeIds = new Set(Array.from({ length: 12 }, (_, k) => 9 + k));
  const oe = (e: number, f: boolean) => `ORIENTED_EDGE('',*,*,#${e},${f ? '.T.' : '.F.'})`;
  assert.equal(render(w, 21, edgeIds), `ADVANCED_FACE('',(FACE_OUTER_BOUND('',EDGE_LOOP('',(${oe(9, true)},`
    + `${oe(10, true)},${oe(11, true)},${oe(12, true)})),.T.)),PLANE('',AXIS2_PLACEMENT_3D('',`
    + `${cp('0.', '0.', '0.')},${dir('0.', '0.', '-1.')},${dir('0.', '1.', '0.')})),.T.)`);
  const faces = new Set([21, 22, 23, 24, 25, 26]);
  assert.equal(render(w, 100, faces), 'MANIFOLD_SOLID_BREP(\'\',CLOSED_SHELL(\'\',(#21,#22,#23,#24,#25,#26)))');
  const mm = '(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))';
  assert.equal(render(w, w.rootId, new Set([100])), 'ADVANCED_BREP_SHAPE_REPRESENTATION(\'\',(#100),('
    + 'GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((UNCERTAINTY_MEASURE_WITH_UNIT('
    + `LENGTH_MEASURE(0.000001),${mm},'distance_accuracy_value','confusion accuracy')))`
    + `GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.)),`
    + '(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())))REPRESENTATION_CONTEXT(\'\',\'\')))');
  assert.deepEqual(w.diagnostics.map((x) => x.message), ['12 x edge parameter ranges (not written: STEP has none) '
    + '(#9, #10, #11, #12, #13, ...)']);
  // The same model, the same bytes.
  assert.deepEqual(stepPartBytes(d).data, w.data);
  assert.match(w.text, /^ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION\(\('a B-rep model'\),'2;1'\);\nFILE_NAME\('',''/);
  assert.ok(w.text.includes('FILE_SCHEMA((\'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF '
    + '{ 1 0 10303 442 1 1 4 }\'));'));
});

test('a void: BREP_WITH_VOIDS, its void an ORIENTED_CLOSED_SHELL; inches as a conversion-based unit', () => {
  const w = written(withVoid().finish());
  const solid = [...w.byId.values()].find((x) => 'type' in x && x.type === 'BREP_WITH_VOIDS')!;
  const keep = new Set([...w.byId.values()].filter((x) => 'type' in x && x.type === 'CLOSED_SHELL').map((x) => x.id));
  const [outer, inner] = [...keep];
  assert.equal(render(w, solid.id, keep), `BREP_WITH_VOIDS('',#${outer},(ORIENTED_CLOSED_SHELL('',*,#${inner},.F.)))`);
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'ADVANCED_BREP_SHAPE_REPRESENTATION');
  // No uncertainty: no GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT.
  assert.equal(render(w, (root.attrs[2] as { v: number }).v), '(GEOMETRIC_REPRESENTATION_CONTEXT(3)'
    + 'GLOBAL_UNIT_ASSIGNED_CONTEXT(((CONVERSION_BASED_UNIT(\'INCH\',LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),'
    + '(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))))LENGTH_UNIT()NAMED_UNIT(DIMENSIONAL_EXPONENTS(1.,0.,0.,'
    + '0.,0.,0.,0.))),(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.)),(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)'
    + 'SOLID_ANGLE_UNIT())))REPRESENTATION_CONTEXT(\'\',\'\'))');
});

test('length units: SI prefixes where the unit is one, else conversion-based', () => {
  const unitOf = (mm: number) => {
    const b = new BrepBuilder({ unit: mm });
    b.addItem({ kind: 'point', point: [0, 0, 0] });
    const w = written(b.finish());
    const root = w.byId.get(w.rootId)!;
    const ctxId = ((root as { attrs: Value[] }).attrs[2] as { v: number }).v;
    const ctx = w.byId.get(ctxId) as { parts: { attrs: Value[] }[] };
    return render(w, (ctx.parts[1]!.attrs[0] as { v: number[] }).v[0]!);
  };
  const si = (p: string) => `(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${p},.METRE.))`;
  assert.equal(unitOf(1e6), si('.KILO.'));
  assert.equal(unitOf(1000), si('$'));
  assert.equal(unitOf(100), si('.DECI.'));
  assert.equal(unitOf(10), si('.CENTI.'));
  assert.equal(unitOf(1), si('.MILLI.'));
  assert.equal(unitOf(1e-3), si('.MICRO.'));
  assert.equal(unitOf(1e-6), si('.NANO.'));
  const conv = (name: string, f: string) => `(CONVERSION_BASED_UNIT('${name}',LENGTH_MEASURE_WITH_UNIT(`
    + `LENGTH_MEASURE(${f}),${si('.MILLI.')}))LENGTH_UNIT()NAMED_UNIT(DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)))`;
  assert.equal(unitOf(304.8), conv('FOOT', '304.8'));
  assert.equal(unitOf(2), conv('UNIT', '2.'));
});

test('a seam: SEAM_CURVE with its two p-curves in row order; SURFACE_CURVEs; a sheet\'s open shell', () => {
  const w = written(seamCylinder().finish());
  const types = [...w.byId.values()].map((x) => 'type' in x ? x.type : '');
  assert.equal(types.filter((t) => t === 'SEAM_CURVE').length, 1);
  assert.equal(types.filter((t) => t === 'SURFACE_CURVE').length, 2);
  const face = w.byId.get(9)!;
  assert.ok('type' in face && face.type === 'ADVANCED_FACE');
  const edges = [...w.byId.values()].filter((x) => 'type' in x && x.type === 'EDGE_CURVE');
  const seam = edges.find((e) => render(w, e.id).includes('SEAM_CURVE'))!;
  const cyl = [...w.byId.values()].find((x) => 'type' in x && x.type === 'CYLINDRICAL_SURFACE')!.id;
  const ctx2d = [...w.byId.values()].find((x) => 'parts' in x
    && x.parts[1]?.type === 'PARAMETRIC_REPRESENTATION_CONTEXT')!.id;
  const vs = [...w.byId.values()].filter((x) => 'type' in x && x.type === 'VERTEX_POINT').map((x) => x.id);
  const keep = new Set([cyl, ctx2d, ...vs]);
  const pline = (u: string) => `PCURVE('',#${cyl},DEFINITIONAL_REPRESENTATION('',(LINE('',${cp(u, '0.')},`
    + `VECTOR('',${dir('0.', '1.')},1.))),#${ctx2d}))`;
  // Rows 5 (u = 0) before 6 (u = 2 pi).
  assert.equal(render(w, seam.id, keep), `EDGE_CURVE('',#${vs[0]},#${vs[1]},SEAM_CURVE('',LINE('',`
    + `${cp('2.', '0.', '0.')},VECTOR('',${dir('0.', '0.', '1.')},1.)),(${pline('0.')},${pline('6.283185307179586')}),`
    + '.CURVE_3D.),.T.)');
  // The coedge's own id is the oriented edge's.
  assert.equal(render(w, 77, new Set([seam.id])), `ORIENTED_EDGE('',*,*,#${seam.id},.F.)`);
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'SHAPE_REPRESENTATION');
  assert.match(render(w, (root.attrs[1] as { v: number[] }).v[0]!, new Set([9])),
    /^SHELL_BASED_SURFACE_MODEL\('',\(OPEN_SHELL\('',\(#9\)\)\)\)$/);
  assert.deepEqual(w.diagnostics.map((x) => x.message), [
    'vertex tolerances (not written: STEP has none per entity)',
    'edge parameter ranges (not written: STEP has none)',
    'edge tolerances (not written: STEP has none per entity)',
    '3 x coedge parameter ranges (not written: STEP has none) (#77, ...)',
  ]);
});

test('natural bounds, vertex loops, poly loops (FACE_SURFACE), a wire, a face set used as a sheet', () => {
  const s = written(spheres().finish());
  const faces = [...s.byId.values()].filter((x) => 'type' in x && x.type === 'ADVANCED_FACE');
  assert.equal(faces.length, 2);
  assert.match(render(s, faces[0]!.id), /^ADVANCED_FACE\('',\(\),SPHERICAL_SURFACE\(/);
  assert.match(render(s, faces[1]!.id), /^ADVANCED_FACE\('',\(FACE_OUTER_BOUND\('',EDGE_LOOP\('',\(ORIENTED_EDGE\(/);
  assert.ok(render(s, faces[1]!.id).includes(`,FACE_BOUND('',VERTEX_LOOP('',VERTEX_POINT('',${cp('10.', '0.', '1.')})),`
    + '.T.)),SPHERICAL_SURFACE('));
  assert.deepEqual(s.diagnostics.map((x) => x.message),
    ['a face without loops (written with none: STEP needs at least one)']);

  const w = written(facetedAndWire().finish());
  const tri = [...w.byId.values()].filter((x) => 'type' in x && x.type === 'FACE_SURFACE');
  assert.equal(tri.length, 4);
  assert.match(render(w, tri[0]!.id), new RegExp(`^FACE_SURFACE\\('',\\(FACE_OUTER_BOUND\\('',POLY_LOOP\\('',\\(`
    + `${[cp('0.', '0.', '0.'), cp('0.', '1.', '0.'), cp('1.', '0.', '0.')].join(',').replace(/[().]/g, '\\$&')}\\)\\),`
    + '\\.T\\.\\)\\),PLANE\\('));
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'SHAPE_REPRESENTATION');
  const items = (root.attrs[1] as { v: number[] }).v.map((id) => render(w, id, new Set([...w.byId.values()]
    .filter((x) => 'type' in x && /^(EDGE_CURVE|CLOSED_SHELL|ADVANCED_FACE)$/.test(x.type)).map((x) => x.id))));
  assert.match(items[0]!, /^MANIFOLD_SOLID_BREP\('',#\d+\)$/);
  assert.match(items[1]!, /^EDGE_BASED_WIREFRAME_MODEL\('',\(CONNECTED_EDGE_SET\('',\(#\d+,#\d+\)\)\)\)$/);
  assert.match(items[2]!, /^FACE_BASED_SURFACE_MODEL\('',\(CONNECTED_FACE_SET\('',\(#\d+\)\)\)\)$/);
  // The face set's face: against its plane, its one loop of unknown kind a FACE_BOUND.
  const flat = [...w.byId.values()].find((x) => 'type' in x && x.type === 'ADVANCED_FACE')!;
  assert.match(render(w, flat.id), /^ADVANCED_FACE\('',\(FACE_BOUND\(.*,\.T\.\)\),PLANE\(.*\),\.F\.\)$/);
});

test('ADVANCED_FACE only where Part 42 allows it, else FACE_SURFACE', () => {
  /** A square face on a plane whose first side's curve is `side`; its surface `surface` if given. */
  const square = (side: (b: BrepBuilder) => number, surface?: (b: BrepBuilder, plane: number) => number,
    pcurve?: boolean) => {
    const b = new BrepBuilder({ unit: 1 });
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = c.map((point) => b.addVertex({ point }));
    const first = side(b);
    const lines = c.map((p, k) => k === 0 ? first : b.addCurve({ kind: 'line', point: p, direction:
      [c[(k + 1) % 4]![0]! - p[0]!, c[(k + 1) % 4]![1]! - p[1]!, 0], magnitude: 1 }));
    const es = lines.map((curve, k) => b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true }));
    const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
    const p2 = pcurve ? b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line', point: [0, 0],
      direction: [1, 0], magnitude: 1 }), trim1: { parameter: 0 }, trim2: { parameter: 1 }, sense: true,
    preference: 'parameter' }) : undefined;
    const f = b.addFace({ surface: surface ? surface(b, plane) : plane, sameSense: true, loops: [{ kind: 'edge',
      bound: 'outer', sense: true, coedges: es.map((edge, k) => ({ edge, orientation: 'forward' as const,
        ...(k === 0 && p2 !== undefined ? { pcurve: p2 } : {}) })) }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
      faces: [{ face: f, sense: true }] }), sense: true }] }) });
    return written(b.finish());
  };
  const faceType = (w: Written) => [...w.byId.values()].filter((x) => 'type' in x && /FACE_SURFACE|ADVANCED_FACE/
    .test(x.type)).map((x) => 'type' in x ? x.type : '');
  const line = (b: BrepBuilder) => b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  assert.deepEqual(faceType(square(line)), ['ADVANCED_FACE']);
  // An edge's curve a trimmed curve, a composite curve, an offset curve: not an advanced face's.
  const trimmed = (b: BrepBuilder) => b.addCurve({ kind: 'trimmed', basis: line(b), trim1: { parameter: 0 },
    trim2: { parameter: 1 }, sense: true, preference: 'parameter' });
  assert.deepEqual(faceType(square(trimmed)), ['FACE_SURFACE']);
  assert.deepEqual(faceType(square((b) => b.addCurve({ kind: 'composite', segments: [{ curve: line(b),
    sameSense: true, transition: 'continuous' }], selfIntersect: false }))), ['FACE_SURFACE']);
  // A p-curve that's a trimmed curve: not either.
  assert.deepEqual(faceType(square(line, undefined, true)), ['FACE_SURFACE']);
  // Surfaces: an offset or rectangular trimmed surface isn't an advanced face's; an extrusion of a line is, of a
  // trimmed curve not.
  assert.deepEqual(faceType(square(line, (b, plane) => b.addSurface({ kind: 'offset', basis: plane, distance: 1,
    selfIntersect: false }))), ['FACE_SURFACE']);
  assert.deepEqual(faceType(square(line, (b, plane) => b.addSurface({ kind: 'rectangularTrimmed', basis: plane,
    u1: 0, u2: 1, v1: 0, v2: 1, uSense: true, vSense: true }))), ['FACE_SURFACE']);
  assert.deepEqual(faceType(square(line, (b) => b.addSurface({ kind: 'extrusion', curve: line(b),
    direction: [0, 1, 0], magnitude: 1 }))), ['ADVANCED_FACE']);
  assert.deepEqual(faceType(square(line, (b) => b.addSurface({ kind: 'extrusion', curve: trimmed(b),
    direction: [0, 1, 0], magnitude: 1 }))), ['FACE_SURFACE']);
  // An edge with only a p-curve (OCCT's degenerate edge at an apex): its geometry a PCURVE, the face FACE_SURFACE.
  const k = written(cone().finish());
  assert.deepEqual(faceType(k), ['FACE_SURFACE']);
  assert.equal([...k.byId.values()].filter((x) => 'type' in x && x.type === 'EDGE_CURVE')
    .filter((x) => render(k, x.id).includes(',PCURVE(')).length, 1);
});

test('cases the fixtures lack: two surfaces\' p-curves, edges against their curves, inner boundaries, forward voids, '
  + 'reversed wire members, curves with points, faces mixing edges with and without vertices', async () => {
  const b = new BrepBuilder({ unit: 1 });
  const v = [[0, 0, 0], [1, 0, 0]].map((point, k) => b.addVertex({ point, id: 1 + k }));
  // Edge 3 runs against its line (sense false), shared by faces on two planes, a p-curve on each.
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1, id: 10 });
  const e = b.addEdge({ curve: line, start: v[1]!, end: v[0]!, sameSense: false, id: 3 });
  const p1 = b.addCurve({ kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1, id: 11 });
  const p2 = b.addCurve({ kind: 'line', point: [0, 0], direction: [0, 1], magnitude: 1, id: 12 });
  const s1 = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    id: 20 });
  const s2 = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 1, 0], xDir: [0, 0, 1] },
    id: 21 });
  // Edge 4 has no vertices; face 31 mixes it with edge 3: not a curve-bounded surface, its edge unset at both ends.
  const bare = b.addEdge({ curve: line, sameSense: true, id: 4 });
  const f1 = b.addFace({ surface: s1, sameSense: true, id: 30, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward', pcurve: p1 }] }] });
  const f2 = b.addFace({ surface: s2, sameSense: true, id: 31, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'reversed', pcurve: p2 }, { edge: bare, orientation: 'forward' }] }] });
  // A curve-bounded face with an inner boundary only: the surface's extent is its outer one (implicit_outer).
  const hole = b.addEdge({ curve: line, sameSense: true, id: 5 });
  const f3 = b.addFace({ surface: s1, sameSense: true, id: 32, loops: [{ kind: 'edge', bound: 'inner', sense: true,
    coedges: [{ edge: hole, orientation: 'forward' }], id: 40 }] });
  const box = (k: number) => b.addShell({ kind: 'closed', faces: [{ face: f1, sense: true }], id: 50 + k });
  // A solid whose void is used forward: still an ORIENTED_CLOSED_SHELL (BREP_WITH_VOIDS' voids are).
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(0), sense: true },
    { ref: box(1), sense: true }], id: 60 }) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face: f2, sense: true }], id: 52 }), sense: true }], id: 61 }) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'wire', members: [{ ref: e, sense: false }], id: 62 }) });
  b.addItem({ kind: 'face', ref: f3 });
  const w = written(b.finish());
  const keep = new Set([1, 2, 10, 11, 12, 20, 21, 3, 4, 50, 51]);
  // Not a seam: a SURFACE_CURVE with a p-curve on each plane; the edge against its line.
  const text = render(w, 3, keep);
  assert.ok(text.startsWith('EDGE_CURVE(\'\',#2,#1,SURFACE_CURVE(\'\',#10,(PCURVE(\'\',#20,'
    + 'DEFINITIONAL_REPRESENTATION(\'\',(#11),'), text);
  assert.match(text, /\),PCURVE\('',#21,DEFINITIONAL_REPRESENTATION\('',\(#12\),.*\.CURVE_3D\.\),\.F\.\)$/);
  assert.equal(render(w, 4, keep), 'EDGE_CURVE(\'\',$,$,#10,.T.)');
  assert.equal(render(w, 31, keep), 'FACE_SURFACE(\'\',(FACE_OUTER_BOUND(\'\',EDGE_LOOP(\'\',('
    + 'ORIENTED_EDGE(\'\',*,*,#3,.F.),ORIENTED_EDGE(\'\',*,*,#4,.T.))),.T.)),#21,.T.)');
  assert.equal(render(w, 32, keep), 'CURVE_BOUNDED_SURFACE(\'\',#20,(BOUNDARY_CURVE(\'\','
    + '(COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#10)),.U.)),.T.)');
  assert.equal(render(w, 60, keep), 'BREP_WITH_VOIDS(\'\',#50,(ORIENTED_CLOSED_SHELL(\'\',*,#51,.T.)))');
  assert.equal(render(w, 62, keep), 'EDGE_BASED_WIREFRAME_MODEL(\'\',(CONNECTED_EDGE_SET(\'\','
    + '(ORIENTED_EDGE(\'\',*,*,#3,.F.)))))');
  const back = await readBack(w.data, w.rootId);
  assert.deepEqual(differences(walk(b.finish()), walk(back.brep)).filter((x) => !x.bits), []);

  // Curves and points alone: a wireframe's curve set (points are its elements too).
  const c = new BrepBuilder({ unit: 1 });
  c.addItem({ kind: 'curve', ref: c.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 }) });
  c.addItem({ kind: 'point', point: [1, 2, 3], id: 9 });
  const wc = written(c.finish());
  const root = wc.byId.get(wc.rootId)!;
  assert.ok('type' in root && root.type === 'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION');
  assert.match(render(wc, (root.attrs[1] as { v: number[] }).v[0]!, new Set([9])),
    /^GEOMETRIC_CURVE_SET\('',\(LINE\(.*\),#9\)\)$/);
});

test('an edge with p-curves on two faces and no 3D curve: a surface curve with its curve unset', async () => {
  const b = new BrepBuilder({ unit: 1 });
  const v = [[0, 0, 0], [1, 0, 0]].map((point, k) => b.addVertex({ point, id: 1 + k }));
  const e = b.addEdge({ start: v[0]!, end: v[1]!, sameSense: true, id: 3 });
  const p1 = b.addCurve({ kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1, id: 11 });
  const p2 = b.addCurve({ kind: 'line', point: [0, 0], direction: [0, 1], magnitude: 1, id: 12 });
  const s1 = b.addSurface({ kind: 'plane', position: P, id: 20 });
  const s2 = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 1, 0], xDir: [0, 0, 1] }, id: 21 });
  const faces = [[s1, p1, 'forward'], [s2, p2, 'reversed']].map(([surface, pcurve, orientation], k) => b.addFace({
    surface: surface as number, sameSense: true, id: 30 + k, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: orientation as 'forward' | 'reversed', pcurve: pcurve as number }] }] }));
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: faces.map((face) => ({ face, sense: true })) }), sense: true }] }) });
  const d = b.finish();
  const w = written(d);
  const text = render(w, 3, new Set([1, 2, 11, 12, 20, 21]));
  assert.ok(text.startsWith('EDGE_CURVE(\'\',#1,#2,SURFACE_CURVE(\'\',$,(PCURVE(\'\',#20,'), text);
  assert.ok(text.endsWith(',.PCURVE_S1.),.T.)') && text.includes('PCURVE(\'\',#21,'), text);
  assert.deepEqual(w.diagnostics.map((x) => x.message),
    ['an edge with p-curves and no 3D curve (written as a surface curve with its curve unset) (#3)']);
  const back = await readBack(w.data, w.rootId);
  assert.deepEqual(differences(walk(d), walk(back.brep)).filter((x) => !x.bits), []);
});

test('geometry beside bodies: each run of it a geometric set (a curve set for curves and points), in order', () => {
  const b = new BrepBuilder({ unit: 1 });
  const line = (y: number) => b.addCurve({ kind: 'line', point: [0, y, 0], direction: [1, 0, 0], magnitude: 1,
    id: 10 + y });
  const plane = b.addSurface({ kind: 'plane', position: P, id: 20 });
  b.addItem({ kind: 'curve', ref: line(0) });
  b.addItem({ kind: 'point', point: [1, 2, 3], id: 30 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'wire', members: [{ ref: b.addEdge({ curve: line(1),
    start: b.addVertex({ point: [0, 1, 0], id: 40 }), end: b.addVertex({ point: [1, 1, 0], id: 41 }), sameSense: true,
    id: 42 }), sense: true }], id: 50 }) });
  b.addItem({ kind: 'surface', ref: plane });
  b.addItem({ kind: 'curve', ref: line(2) });
  const w = written(b.finish());
  const root = w.byId.get(w.rootId)!;
  assert.ok('type' in root && root.type === 'SHAPE_REPRESENTATION');
  const keep = new Set([10, 12, 20, 30, 42]);
  assert.deepEqual((root.attrs[1] as { v: number[] }).v.map((id) => render(w, id, keep)), [
    'GEOMETRIC_CURVE_SET(\'\',(#10,#30))', 'EDGE_BASED_WIREFRAME_MODEL(\'\',(CONNECTED_EDGE_SET(\'\',(#42))))',
    'GEOMETRIC_SET(\'\',(#20,#12))']);
});

test('ids: kept, a repeated one renumbered, rows without one given new ones after the largest', () => {
  const b = new BrepBuilder({ unit: 1 });
  b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1, id: 7 });
  b.addCurve({ kind: 'line', point: [0, 1, 0], direction: [1, 0, 0], magnitude: 1, id: 7 });
  b.addCurve({ kind: 'line', point: [0, 2, 0], direction: [1, 0, 0], magnitude: 1 });
  b.addSurface({ kind: 'plane', position: P, id: 40 });
  for (let k = 0; k < 3; k++) b.addItem({ kind: 'curve', ref: k });
  b.addItem({ kind: 'surface', ref: 0 });
  const w = written(b.finish());
  // The root and its context first, then new entities in order.
  assert.equal(w.rootId, 41);
  assert.match(render(w, 7), /^LINE\('',CARTESIAN_POINT\('',\(0\.,0\.,0\.\)\)/);
  const lines = [...w.byId.values()].filter((x) => 'type' in x && x.type === 'LINE').map((x) => x.id);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 7);
  assert.ok(lines[1]! > 42 && lines[2]! > lines[1]!, `${lines}`);
  assert.match(render(w, lines[1]!), /\(0\.,1\.,0\.\)/);
  assert.ok(w.byId.has(40));
  // Every id once.
  assert.equal(w.byId.size, (w.text.match(/^#\d+=/gm) ?? []).length);
});

test('what STEP can\'t hold: diagnostics, and what can\'t be written left out', () => {
  const b = new BrepBuilder({ unit: 1 });
  const v = [b.addVertex({ point: [0, 0, 0], tolerance: 1e-3, id: 1 }), b.addVertex({ point: [1, 0, 0], id: 2 })];
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const e = b.addEdge({ curve: line, start: v[0]!, end: v[1]!, sameSense: true, degenerate: true, id: 3 });
  const bare = b.addEdge({ start: v[1]!, end: v[0]!, sameSense: true, id: 4 });
  const plane = b.addSurface({ kind: 'plane', position: P });
  const f1 = b.addFace({ surface: plane, sameSense: true, tolerance: 1e-3, id: 5, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'internal', id: 6 }] }] });
  const f2 = b.addFace({ surface: plane, sameSense: true, id: 7, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward' }, { edge: bare, orientation: 'forward' }] }] });
  const sh = b.addShell({ kind: 'open', faces: [{ face: f1, sense: true }, { face: f2, sense: false }] });
  const body = b.addBody({ kind: 'sheet', members: [{ ref: sh, sense: true }] });
  const it = b.addItem({ kind: 'body', ref: body, id: 8 });
  b.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0], id: 9 });
  b.addItem({ kind: 'point', point: [1, 1, 1], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0], id: 10 });
  const w = written(b.finish());
  assert.deepEqual(w.diagnostics, [
    { severity: 'info', message: 'vertex tolerances (not written: STEP has none per entity) (#1)' },
    { severity: 'info', message: 'degenerate edges (written as edges: STEP doesn\'t mark them) (#3)' },
    { severity: 'warning', message: 'an edge with neither a curve nor a p-curve (written unset) (#4)' },
    { severity: 'info', message: 'face tolerances (not written: STEP has none per entity) (#5)' },
    { severity: 'warning', message: 'internal coedges (written as forward) (#6)' },
    { severity: 'error', message: 'an instance item (left out: not written yet) (#9)' },
    { severity: 'error', message: 'an item with a transform (left out: not written yet) (#10)' },
  ]);
  // What the source lacked written unset, not repaired; the face using it kept (FACE_SURFACE: not advanced).
  assert.equal(render(w, 4, new Set([1, 2])), 'EDGE_CURVE(\'\',#2,#1,$,.T.)');
  assert.match(render(w, 7, new Set([3, 4])), /^FACE_SURFACE\(/);
  assert.equal(render(w, 6, new Set([3])), 'ORIENTED_EDGE(\'\',*,*,#3,.T.)');
  const shell = [...w.byId.values()].find((x) => 'type' in x && x.type === 'OPEN_SHELL')!;
  assert.match(render(w, shell.id, new Set([5, 7])), /^OPEN_SHELL\('',\(#5,ORIENTED_FACE\('',\*,#7,\.F\.\)\)\)$/);
  // An edge with one vertex: the other unset.
  const b2 = new BrepBuilder({ unit: 1 });
  const v0 = b2.addVertex({ point: [0, 0, 0], id: 1 });
  const l = b2.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  b2.addBody({ kind: 'wire', members: [{ ref: b2.addEdge({ curve: l, start: v0, sameSense: true, id: 2 }),
    sense: true }] });
  b2.addItem({ kind: 'body', ref: 0 });
  const w2 = written(b2.finish());
  assert.match(render(w2, 2, new Set([1])), /^EDGE_CURVE\('',#1,\$,LINE\(/);
  assert.deepEqual(w2.diagnostics.map((x) => x.message),
    ['an edge without its start or end vertex (written unset) (#2)']);
});

test('read back by step-import, each model is itself up to row order and what STEP can\'t hold', async () => {
  for (const [name, make] of Object.entries({ cube, withVoid, seamCylinder, spheres, facetedAndWire, cone,
    everyKind })) {
    const d = make().finish();
    const w = stepPartBytes(d);
    const back = await readBack(w.data, w.rootId);
    assert.deepEqual(back.warnings, [], name);
    // Units and uncertainties pass through metres, directions are normalized again: only last bits may differ.
    assert.deepEqual(differences(walk(d), walk(back.brep)).filter((x) => !x.bits), [], name);
  }
  // everyKind's instance is left out.
  const d = everyKind().finish();
  const w = stepPartBytes(d);
  assert.equal(rowCount((await readBack(w.data, w.rootId)).brep, 'item'), rowCount(d, 'item') - 1);
});

test('every written model binds against AP242 with its values checked, without a diagnostic', async () => {
  for (const [name, make] of Object.entries({ cube, withVoid, seamCylinder, spheres, facetedAndWire, cone,
    everyKind })) {
    const w = stepPartBytes(make().finish());
    const m = await openModel(parseStep(w.data));
    assert.equal(m.schema?.name, 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF', name);
    assert.deepEqual(m.diagnostics, [], name);
    const found: string[] = [];
    for (let p = 0; p < m.file.count; p++) {
      for (const x of m.bind(p, { check: true }).diagnostics) found.push(`#${m.file.index.ids[p]}: ${x.message}`);
    }
    // A face bounded by its surface's extent has no form in STEP (FACE.bounds is SET [1:?]): written with no bounds,
    // as the corpus's sources of such faces have them, with the writer's warning.
    assert.deepEqual(found, name === 'spheres' ? ['#23: FACE.bounds: SET of 0 elements, expected [1:?]'] : [], name);
  }
});

test('the comparison sees what it should: a real difference, last bits, new ids', () => {
  const a = [{ unit: 1 }, { kind: 'curve', ref: { kind: 'line', point: [1, 2, 3], direction: [0.6, 0.8, 0], id: 4 } }];
  const same = JSON.parse(JSON.stringify(a));
  assert.deepEqual(differences(a, same), []);
  const moved = JSON.parse(JSON.stringify(a));
  moved[1].ref.point[0] = 1 + 1e-12;
  assert.deepEqual(differences(a, moved).map((x) => [x.path, x.bits]), [['[1].ref.point[0]', false]]);
  const bits = JSON.parse(JSON.stringify(a));
  bits[1].ref.direction[1] = 0.8 + 2 * Number.EPSILON;
  assert.deepEqual(differences(a, bits).map((x) => [x.path, x.bits]), [['[1].ref.direction[1]', true]]);
  // A direction's small component: its last bits measured against the vector's length, 1.
  const small = JSON.parse(JSON.stringify(a));
  small[1].ref.direction[2] = 1e-17;
  assert.deepEqual(differences(a, small).map((x) => x.bits), [true]);
  const lost = JSON.parse(JSON.stringify(a));
  delete lost[1].ref.id;
  assert.deepEqual(differences(a, lost).map((x) => x.path), ['[1].ref.id']);
  const added = JSON.parse(JSON.stringify(a));
  added[0].id = 9;
  assert.deepEqual(differences(a, added), []);
  assert.deepEqual(differences(a, [a[0]]).map((x) => x.path), ['.length']);
});
