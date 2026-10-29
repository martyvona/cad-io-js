import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrepPart } from 'cad-scene';
import { importStep } from '../src/index.ts';

const enc = new TextEncoder();
const file = (data: string) => enc.encode(
  "ISO-10303-21;HEADER;FILE_NAME('o.stp','',(''),(''),'pp','sys','');FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));ENDSEC;" +
  `DATA;\n${data}\nENDSEC;END-ISO-10303-21;`);

// Faces in millimetres: #100 bounded by a line (0,0)-(10,0), a quarter circle about (10,10) to (20,10), a quadratic
// Bezier B-spline to (0,20) and a line back (against its sense); #200 by the same quarter circle against its sense
// (from (20,10) back to (10,0)); #300 by a polygon; #400 by the whole circle (a closed edge).
const DATA = `
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(10.,0.,0.));
#3=CARTESIAN_POINT('',(20.,10.,0.));
#4=CARTESIAN_POINT('',(0.,20.,0.));
#5=CARTESIAN_POINT('',(20.,20.,0.));
#11=VERTEX_POINT('',#1);
#12=VERTEX_POINT('',#2);
#13=VERTEX_POINT('',#3);
#14=VERTEX_POINT('',#4);
#20=DIRECTION('',(1.,0.,0.));
#21=VECTOR('',#20,1.);
#22=LINE('',#1,#21);
#23=CARTESIAN_POINT('',(10.,10.,0.));
#24=DIRECTION('',(0.,0.,1.));
#25=AXIS2_PLACEMENT_3D('',#23,#24,#20);
#26=CIRCLE('',#25,10.);
#27=B_SPLINE_CURVE_WITH_KNOTS('',2,(#3,#5,#4),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);
#28=DIRECTION('',(0.,1.,0.));
#29=VECTOR('',#28,1.);
#30=LINE('',#1,#29);
#31=EDGE_CURVE('',#11,#12,#22,.T.);
#32=EDGE_CURVE('',#12,#13,#26,.T.);
#33=EDGE_CURVE('',#13,#14,#27,.T.);
#34=EDGE_CURVE('',#14,#11,#30,.F.);
#35=EDGE_CURVE('',#13,#12,#26,.F.);
#36=EDGE_CURVE('',#12,#12,#26,.T.);
#41=ORIENTED_EDGE('',*,*,#31,.T.);
#42=ORIENTED_EDGE('',*,*,#32,.T.);
#43=ORIENTED_EDGE('',*,*,#33,.T.);
#44=ORIENTED_EDGE('',*,*,#34,.T.);
#45=EDGE_LOOP('',(#41,#42,#43,#44));
#46=FACE_OUTER_BOUND('',#45,.T.);
#47=PLANE('',#25);
#100=ADVANCED_FACE('',(#46),#47,.T.);
#48=ORIENTED_EDGE('',*,*,#35,.T.);
#49=EDGE_LOOP('',(#48));
#50=FACE_BOUND('',#49,.T.);
#200=ADVANCED_FACE('',(#50),#47,.T.);
#51=POLY_LOOP('',(#1,#2,#5));
#52=FACE_BOUND('',#51,.T.);
#300=FACE_SURFACE('',(#52),#47,.T.);
#53=ORIENTED_EDGE('',*,*,#36,.T.);
#54=EDGE_LOOP('',(#53));
#55=FACE_BOUND('',#54,.T.);
#400=ADVANCED_FACE('',(#55),#47,.T.);
#60=OPEN_SHELL('',(#100,#200,#300,#400));
#61=SHELL_BASED_SURFACE_MODEL('',(#60));
#70=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#71)) REPRESENTATION_CONTEXT('',''));
#71=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));
#80=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#61),#70);
#90=APPLICATION_CONTEXT('');
#91=PRODUCT_CONTEXT('',#90,'mechanical');
#92=PRODUCT_DEFINITION_CONTEXT('part definition',#90,'design');
#93=PRODUCT('P','P','',(#91));
#94=PRODUCT_DEFINITION_FORMATION('','',#93);
#95=PRODUCT_DEFINITION('','',#94,#92);
#96=PRODUCT_DEFINITION_SHAPE('','',#95);
#97=SHAPE_DEFINITION_REPRESENTATION(#96,#80);
`;

const outline = async (faces?: number[]) => {
  const { scene } = await importStep(file(DATA));
  const part = scene.parts[0] as BrepPart;
  const o = part.outline!({ linearDeflection: 0.01, angularDeflection: 0.1, ...(faces ? { faces: new Set(faces) } :
    {}) });
  // Back in the file's coordinates.
  const pts = (k: number) => Array.from({ length: o.outlines[k]!.count }, (_, i) => [0, 1, 2].map((j) =>
    o.positions[(o.outlines[k]!.start + i) * 3 + j]! + part.origin[j]!));
  return { o, pts, part };
};
const near = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-4;
const r10 = (p: number[]) => Math.hypot(p[0]! - 10, p[1]! - 10);

test('outlines: every face listed; a face\'s edges in loop order, each from its start vertex to its end', async () => {
  const { o, pts } = await outline([100]);
  assert.deepEqual(o.faces, [100, 200, 300, 400]);
  assert.deepEqual(o.outlines.map((x) => x.source), [100, 100, 100, 100]);
  // The line: its two ends.
  assert.deepEqual(pts(0).length, 2);
  assert.ok(near(pts(0)[0]!, [0, 0, 0]) && near(pts(0)[1]!, [10, 0, 0]));
  // The quarter circle: on the circle, from (10,0) to (20,10) the short way (x >= 10, y <= 10), finely.
  const arc = pts(1);
  assert.ok(arc.length > 10 && near(arc[0]!, [10, 0, 0]) && near(arc.at(-1)!, [20, 10, 0]));
  assert.ok(arc.every((p) => Math.abs(r10(p) - 10) < 1e-4 && p[0]! >= 10 - 1e-4 && p[1]! <= 10 + 1e-4));
  // The Bezier: from (20,10) to (0,20) through its curve's points (B(1/2) = (15, 17.5)).
  const bez = pts(2);
  assert.ok(near(bez[0]!, [20, 10, 0]) && near(bez.at(-1)!, [0, 20, 0]));
  assert.ok(bez.some((p) => Math.hypot(p[0]! - 15, p[1]! - 17.5) < 0.2), 'passes near B(1/2)');
  // The line against its sense: still from the edge's start to its end.
  assert.ok(near(pts(3)[0]!, [0, 20, 0]) && near(pts(3)[1]!, [0, 0, 0]));
});

test('outlines: an arc against its curve\'s sense, a polygon closed, a whole circle; only the faces asked for',
  async () => {
    const { o, pts } = await outline([200, 300, 400]);
    assert.deepEqual(o.outlines.map((x) => x.source), [200, 300, 400]);
    const back = pts(0);
    assert.ok(near(back[0]!, [20, 10, 0]) && near(back.at(-1)!, [10, 0, 0]));
    assert.ok(back.every((p) => Math.abs(r10(p) - 10) < 1e-4 && p[0]! >= 10 - 1e-4 && p[1]! <= 10 + 1e-4),
      'the short way back');
    assert.deepEqual(pts(1).map((p) => p.map((x) => Math.round(x))), [[0, 0, 0], [10, 0, 0], [20, 20, 0], [0, 0, 0]]);
    const round = pts(2);
    assert.ok(near(round[0]!, [10, 0, 0]) && near(round.at(-1)!, [10, 0, 0]) && round.length > 40);
    assert.ok(round.some((p) => near(p, [10, 20, 0]) || Math.hypot(p[0]! - 10, p[1]! - 20) < 0.5), 'all round');
    // None asked for: the face list alone.
    const none = (await outline([])).o;
    assert.deepEqual([none.faces.length, none.outlines.length, none.positions.length], [4, 0, 0]);
  });
