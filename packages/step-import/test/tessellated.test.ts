import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportView, partInstances, validate, type Mesh, type Scene } from 'cad-scene';
import { parseStep } from 'step-parser';
import { importStep } from '../src/index.ts';

const enc = new TextEncoder();
const AP242 = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }';
const file = (data: string) => parseStep(enc.encode(
  `ISO-10303-21;HEADER;FILE_NAME('t.stp','',(''),(''),'pp','sys','');FILE_SCHEMA(('${AP242}'));ENDSEC;DATA;`
  + `\n${data}\nENDSEC;END-ISO-10303-21;`));

// Contexts (millimetres; inches; millimetres with degrees), a placement, and one product whose representation `#204`
// the test's representations are related to.
const COMMON = `
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#12=(LENGTH_UNIT()CONVERSION_BASED_UNIT('INCH',#13)NAMED_UNIT(*));
#13=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#10);
#14=(CONVERSION_BASED_UNIT('DEGREE',#15)NAMED_UNIT(*)PLANE_ANGLE_UNIT());
#15=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#11);
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#11))REPRESENTATION_CONTEXT('mm',''));
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#12,#11))REPRESENTATION_CONTEXT('in',''));
#18=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#14))REPRESENTATION_CONTEXT('deg',''));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#200=PRODUCT('P','P','',(#2));
#201=PRODUCT_DEFINITION_FORMATION('','',#200);
#202=PRODUCT_DEFINITION('','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#204=SHAPE_REPRESENTATION('top',(#23),#16);
#205=SHAPE_DEFINITION_REPRESENTATION(#203,#204);`;
const related = (reps: number[]) => reps.map((r, i) => `#${300 + i}=SHAPE_REPRESENTATION_RELATIONSHIP('','',#${r},#204);`)
  .join('\n');

/** The index of the part of this name (parts come in the importer's order of representations). */
const named = (scene: Scene, name: string) => scene.parts.findIndex((p) => p.name === name);

/** A mesh's triangles as world corners of its part's placement, and the signed volume they enclose. */
function triangles(scene: Scene, part: number | string = 0) {
  if (typeof part === 'string') part = named(scene, part);
  const pi = [...partInstances(scene)].find((x) => x.part === part)!;
  const m = scene.parts[part]!.lods[0]!.mesh, t = pi.transform;
  const at = (v: number) => {
    const x = m.positions[v * 3]! + m.origin[0], y = m.positions[v * 3 + 1]! + m.origin[1];
    const z = m.positions[v * 3 + 2]! + m.origin[2];
    // (+ 0: no -0.)
    return [0, 1, 2].map((k) => Math.round((t[k]! * x + t[4 + k]! * y + t[8 + k]! * z + t[12 + k]!) * 1e6) / 1e6 + 0);
  };
  const tris: number[][][] = [];
  let volume = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [at(m.indices[i]!), at(m.indices[i + 1]!), at(m.indices[i + 2]!)] as number[][];
    tris.push([a!, b!, c!]);
    volume += (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) + a![1]! * (b![2]! * c![0]! - b![0]! * c![2]!)
      + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) / 6;
  }
  return { tris, volume };
}
const normal = (t: number[][]) => {
  const [a, b, c] = t as [number[], number[], number[]];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
};
/** A part's mesh normals turned by its placement, rounded. */
function worldNormals(scene: Scene, name: string) {
  const part = named(scene, name);
  const t = [...partInstances(scene)].find((x) => x.part === part)!.transform;
  const n = scene.parts[part]!.lods[0]!.mesh.normals!;
  const out: number[][] = [];
  for (let i = 0; i < n.length; i += 3) {
    const w = [0, 1, 2].map((k) => t[k]! * n[i]! + t[4 + k]! * n[i + 1]! + t[8 + k]! * n[i + 2]!);
    const len = Math.hypot(w[0]!, w[1]!, w[2]!);
    out.push(w.map((x) => Math.round(x / len * 1e6) / 1e6 + 0));
  }
  return out;
}
const segments = (m: Mesh, kind: string) => (m.edges ?? []).filter((e) => e.kind === kind)
  .reduce((n, e) => n + e.count - 1, 0);

// A tetrahedron (0,0,0), (10,0,0), (0,10,0), (0,0,10) as a solid of four faces sharing one coordinates list, wound
// outward: two triangulated faces (one with pnindex and a normal per point, one with one normal), a complex face as a
// strip, one as a fan (each a single triangle, given the other way round in the list, so only the right order
// faces out).
const TETRA = `
#100=COORDINATES_LIST('',4,((0.,0.,0.),(10.,0.,0.),(0.,10.,0.),(0.,0.,10.)));
#101=TRIANGULATED_FACE('bottom',#100,3,((0.,0.,-1.),(0.,0.,-1.),(0.,0.,-1.)),$,(1,3,2),((1,2,3)));
#102=TRIANGULATED_FACE('side y',#100,4,((1.,-1.,0.)),$,(),((1,2,4)));
#103=COMPLEX_TRIANGULATED_FACE('side x',#100,4,(),$,(),((3,1,4)),());
#104=COMPLEX_TRIANGULATED_FACE('slope',#100,4,(),$,(),(),((2,3,4)));
#105=TESSELLATED_SOLID('',(#101,#102,#103,#104),$);
#106=TESSELLATED_SHAPE_REPRESENTATION('tetra',(#23,#105),#16);`;

test('a tessellated solid: faces by id, wound as Part 42 says (strips, fans), normals given or computed, edges',
  async () => {
    const { scene } = await importStep(file(COMMON + TETRA + related([106])));
    assert.deepEqual(validate(scene), []);
    assert.equal(scene.parts.length, 1);
    const part = scene.parts[0]!;
    assert.equal(part.brep, undefined);
    assert.equal(part.lods[0]!.from, 'source');
    assert.equal(part.closed, true);
    const m = part.lods[0]!.mesh;
    assert.deepEqual(m.faces.map((f) => [f.source, f.count]), [[101, 3], [102, 3], [103, 3], [104, 3]]);
    // Every triangle faces out: its normal points away from the centroid (2.5, 2.5, 2.5); the volume 1000 / 6.
    const { tris, volume } = triangles(scene);
    for (const t of tris) {
      const n = normal(t), c = [0, 1, 2].map((k) => (t[0]![k]! + t[1]![k]! + t[2]![k]!) / 3 - 2.5);
      assert.ok(n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]! > 0, JSON.stringify(t));
    }
    assert.ok(Math.abs(volume - 1000 / 6) < 1e-6, `${volume}`);
    // Normals: the file's (unit length; the one for 'side y' as written, though the face's own is (0, -1, 0)), else
    // the face's own.
    const nAt = (face: number) => { const v = m.indices[m.faces[face]!.start]!;
      return [...m.normals!.slice(v * 3, v * 3 + 3)].map((x) => Math.round(x * 1e6) / 1e6); };
    assert.deepEqual(nAt(0), [0, 0, -1]);
    assert.deepEqual(nAt(1), [Math.SQRT1_2, -Math.SQRT1_2, 0].map((x) => Math.round(x * 1e6) / 1e6));
    assert.deepEqual(nAt(2), [-1, 0, 0]);
    const s = 1 / Math.sqrt(3);
    assert.deepEqual(nAt(3), [s, s, s].map((x) => Math.round(x * 1e6) / 1e6));
    // Each face's three corners its own vertices; the six edges shared, none free.
    assert.equal(m.positions.length, 4 * 3 * 3);
    assert.equal(segments(m, 'shared'), 6);
    assert.equal(segments(m, 'free'), 0);
    assert.equal(m.edges!.every((e) => e.source === null), true);
  });

test('strips alternate, fans turn about their first point, repeated corners skipped; a shell says closed or not',
  async () => {
    // A unit square as a strip (1,2,3,4) and as a fan (1,2,4,3) with a degenerate restart; an open shell's link.
    const { scene } = await importStep(file(COMMON + `
#100=COORDINATES_LIST('',4,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.,1.,0.)));
#101=COMPLEX_TRIANGULATED_FACE('strip',#100,4,(),$,(),((1,2,3,4,4)),());
#102=COMPLEX_TRIANGULATED_FACE('fan',#100,4,(),$,(),(),((1,2,4,3)));
#110=OPEN_SHELL('',());
#111=TESSELLATED_SHELL('',(#101),#110);
#112=CLOSED_SHELL('',());
#113=TESSELLATED_SHELL('',(#102),#112);
#114=TESSELLATED_SHELL('',(#102),$);
#120=TESSELLATED_SHAPE_REPRESENTATION('open',(#111),#16);
#121=TESSELLATED_SHAPE_REPRESENTATION('closed',(#113),#16);
#122=TESSELLATED_SHAPE_REPRESENTATION('unknown',(#114),#16);
#123=TESSELLATED_SHAPE_REPRESENTATION('mixed',(#113,#114),#16);
` + related([120, 121, 122, 123])));
    assert.deepEqual(Object.fromEntries(scene.parts.map((p) => [p.name, p.closed])),
      { open: false, closed: true, unknown: undefined, mixed: undefined });
    for (const part of ['open', 'closed']) {
      const { tris } = triangles(scene, part);
      assert.equal(tris.length, 2);
      for (const t of tris) assert.ok(normal(t)[2]! > 0, JSON.stringify(t));
      // The square's four sides free, its diagonal inside.
      assert.equal(segments(scene.parts[named(scene, part)]!.lods[0]!.mesh, 'free'), 4);
    }
    assert.deepEqual(triangles(scene, 'open').tris.map((t) => t.map((p) => `${p[0]}${p[1]}`).join(' ')),
      ['00 10 01', '01 10 11']);
    assert.deepEqual(triangles(scene, 'closed').tris.map((t) => t.map((p) => `${p[0]}${p[1]}`).join(' ')),
      ['00 10 11', '00 11 01']);
  });

test('surface sets, curve sets, wires, edges and points; a repositioned set moved; the file\'s edges in a shell',
  async () => {
    const { scene } = await importStep(file(COMMON + `
#100=COORDINATES_LIST('',4,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.,1.,0.)));
#101=TRIANGULATED_SURFACE_SET('set',#100,4,((0.,0.,1.)),(),((1,2,3),(3,2,4)));
#102=TESSELLATED_CURVE_SET('curves',#100,((1,2,4),(3,1)));
#103=TESSELLATED_EDGE('e',#100,$,(1,4));
#104=TESSELLATED_VERTEX('v',#100,$,3);
#105=TESSELLATED_WIRE('',(#103,#104),$);
#106=TESSELLATED_POINT_SET('pts',#100,(2,4));
#110=CARTESIAN_POINT('',(100.,0.,0.));
#113=DIRECTION('',(1.,0.,0.));
#114=DIRECTION('',(0.,1.,0.));
#111=AXIS2_PLACEMENT_3D('',#110,#113,#114);
#112=(GEOMETRIC_REPRESENTATION_ITEM()REPOSITIONED_TESSELLATED_ITEM(#111)REPRESENTATION_ITEM('')`
      + `TESSELLATED_GEOMETRIC_SET((#101,#106))TESSELLATED_ITEM());
#120=TESSELLATED_SHAPE_REPRESENTATION('all',(#101,#102,#105,#112),#16);
#130=COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#131=TRIANGULATED_FACE('',#130,3,(),$,(),((1,2,3)));
#132=TESSELLATED_EDGE('free edge',#130,$,(1,2));
#133=TESSELLATED_CONNECTING_EDGE('joined',#130,$,(2,3),.T.,#131,#131,(2,3),(2,3));
#134=TESSELLATED_SHELL('',(#131,#132,#133),$);
#135=TESSELLATED_SHAPE_REPRESENTATION('edges',(#134),#16);
` + related([120, 135])));
    assert.deepEqual(validate(scene), []);
    const all = scene.parts[named(scene, 'all')]!.lods[0]!.mesh;
    // The surface set twice (its own, and in the repositioned set moved 100 mm along x and turned, its z to x and its
    // x to y), one face each, its normal turned with it.
    assert.deepEqual(all.faces.map((f) => [f.source, f.count]), [[101, 6], [101, 6]]);
    const xs = triangles(scene, 'all').tris.map((t) => Math.min(...t.map((p) => p[0]!)));
    assert.deepEqual(xs, [0, 0, 100, 100]);
    const firstNormal = (face: number) => { const v = all.indices[all.faces[face]!.start]!;
      return [...all.normals!.slice(v * 3, v * 3 + 3)].map((x) => Math.round(x * 1e6) / 1e6); };
    assert.deepEqual(firstNormal(0), [0, 0, 1]);
    assert.deepEqual(firstNormal(1), [1, 0, 0]);
    assert.deepEqual(all.curves!.map((c) => [c.source, c.count]), [[102, 3], [102, 2], [103, 2]]);
    // Points: the wire's vertex, then the point set's two, moved too.
    const p = [...all.points!].map((x, i) => Math.round(x + all.origin[i % 3]!));
    assert.deepEqual(p, [0, 1, 0, 100, 1, 0, 100, 1, 1]);
    assert.deepEqual(all.pointSources, [104, 106, 106]);
    // A shell with edges of its own: those, not its faces' boundary.
    const e = scene.parts[named(scene, 'edges')]!.lods[0]!.mesh;
    assert.deepEqual(e.edges!.map((x) => [x.source, x.kind, x.count]), [[132, 'free', 2], [133, 'shared', 2]]);
  });

test('accuracy parameters as the level\'s deflections; bad indices warned of; items not read go to the backend',
  async () => {
    const { scene } = await importStep(file(COMMON + `
#100=COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#101=TRIANGULATED_FACE('',#100,3,(),$,(),((1,2,3),(1,2,9)));
#102=TESSELLATED_SHELL('',(#101),$);
#103=TESSELLATED_SHAPE_REPRESENTATION_WITH_ACCURACY_PARAMETERS('acc',(#102),#18,
  (CHORDAL_DEVIATION(0.5),ANGULAR_DEVIATION(30.)));
#104=TESSELLATED_SHAPE_REPRESENTATION_WITH_ACCURACY_PARAMETERS('inch',(#102),#17,(CHORDAL_DEVIATION(0.01)));
#110=CUBIC_BEZIER_TRIANGULATED_FACE('',#100,3,(),$,((1,1,1,1,1,1,1,1,1,1)));
#111=TESSELLATED_SHELL('',(#110),$);
#112=TESSELLATED_SHAPE_REPRESENTATION('bezier',(#111),#16);
` + related([103, 104, 112])));
    const [acc, inch, bezier] = ['acc', 'inch', 'bezier'].map((n) => scene.parts[named(scene, n)]);
    assert.equal(acc!.lods[0]!.linearDeflection, 0.5);
    assert.ok(Math.abs(acc!.lods[0]!.angularDeflection! - Math.PI / 6) < 1e-12);
    assert.ok(Math.abs(inch!.lods[0]!.linearDeflection! - 0.254) < 1e-12);
    assert.equal(acc!.lods[0]!.mesh.indices.length, 3);
    assert.ok(scene.diagnostics.some((d) => d.source?.id === 101 && /index 9 outside its coordinates list/.test(
      d.message)));
    // Curved triangles aren't read: the representation goes to the backend, as before.
    assert.equal(bezier!.brep?.format, 'step');
    assert.deepEqual(bezier!.lods, []);
    assert.ok(scene.diagnostics.some((d) => d.source?.id === 112 && /CUBIC_BEZIER_TRIANGULATED_FACE/.test(d.message)));
  });

test('far from the origin, the mesh keeps its precision (positions less the centre of its box)', async () => {
  const { scene } = await importStep(file(COMMON + `
#100=COORDINATES_LIST('',3,((10000000.,0.,0.),(10000000.01,0.,0.),(10000000.,0.01,0.)));
#101=TRIANGULATED_FACE('',#100,3,(),$,(),((1,2,3)));
#102=TESSELLATED_SHAPE_REPRESENTATION('far',(#101),#16);
` + related([102])));
  assert.deepEqual(triangles(scene).tris[0], [[1e7, 0, 0], [1e7 + 0.01, 0, 0], [1e7, 0.01, 0]]);
});

test("tessellated: 'backend' keeps the old path: a B-rep part from the subset", async () => {
  const { scene } = await importStep(file(COMMON + TETRA + related([106])), { tessellated: 'backend' });
  assert.equal(scene.parts[0]!.brep?.format, 'step');
  assert.deepEqual(scene.parts[0]!.lods, []);
});

// A box's B-rep (two of its faces, enough to pair by) in millimetres, and its tessellation in inches placed 1 inch up
// by a transformation; the tessellated faces linked to the B-rep's (one not, and coloured blue).
const PAIR = `
#30=PLANE('',#23);
#31=ADVANCED_FACE('a',(),#30,.T.);
#32=ADVANCED_FACE('b',(),#30,.T.);
#33=CLOSED_SHELL('',(#31,#32));
#34=MANIFOLD_SOLID_BREP('',#33);
#35=ADVANCED_BREP_SHAPE_REPRESENTATION('box',(#34),#16);
#100=COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#101=TRIANGULATED_FACE('',#100,3,(),#31,(),((1,2,3)));
#102=TRIANGULATED_FACE('',#100,3,(),#32,(),((1,3,2)));
#103=TRIANGULATED_FACE('',#100,3,(),$,(),((1,2,3)));
#104=TESSELLATED_SOLID('',(#101,#102,#103),#34);
#105=TESSELLATED_SHAPE_REPRESENTATION('box tess',(#104),#17);
#110=CARTESIAN_POINT('',(0.,0.,1.));
#114=DIRECTION('',(0.,1.,0.));
#115=DIRECTION('',(1.,0.,0.));
#111=AXIS2_PLACEMENT_3D('',#110,#115,#114);
#112=ITEM_DEFINED_TRANSFORMATION('','',#111,#23);
#113=(REPRESENTATION_RELATIONSHIP('','',#105,#35)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#112)`
  + `SHAPE_REPRESENTATION_RELATIONSHIP());
#120=COLOUR_RGB('',0.,0.,1.);
#121=FILL_AREA_STYLE_COLOUR('',#120);
#122=FILL_AREA_STYLE('',(#121));
#123=SURFACE_STYLE_FILL_AREA(#122);
#124=SURFACE_SIDE_STYLE('',(#123));
#125=SURFACE_STYLE_USAGE(.BOTH.,#124);
#126=PRESENTATION_STYLE_ASSIGNMENT((#125));
#127=STYLED_ITEM('',(#126),#103);
#130=PRESENTATION_LAYER_ASSIGNMENT('L','',(#103));`;

test('a product\'s B-rep and its tessellation: one part, the triangles a level in the B-rep\'s coordinates',
  async () => {
    const { scene, partOf } = await importStep(file(COMMON + PAIR + related([35])));
    assert.deepEqual(validate(scene), []);
    assert.equal(scene.parts.length, 1);
    const part = scene.parts[0]!;
    assert.equal(part.brep?.rootId, 35);
    assert.deepEqual(part.sources.map((x) => x.id), [35, 105]);
    assert.equal(part.lods.length, 1);
    const m = part.lods[0]!.mesh;
    // Linked faces as the B-rep's, the other its own; placed once.
    assert.deepEqual(m.faces.map((f) => f.source), [31, 32, 103]);
    assert.equal([...partInstances(scene)].length, 1);
    assert.equal(partOf.has(105), false);
    // Inches to millimetres, moved by the transformation, which takes transform_item_1's frame (1 inch up, its x along
    // y, its z along x) to transform_item_2's, as the importer reads every relationship: (x, y, z) in -> (y, z - 1, x)
    // in. (The next test checks the merged level against the same tessellation placed as a part of its own.)
    const { tris } = triangles(scene);
    assert.deepEqual(tris[0], [[0, -25.4, 0], [0, -25.4, 25.4], [25.4, -25.4, 0]]);
    // The unlinked face's colour and layer carried over.
    const blue = scene.materials.findIndex((x) => x.color.join() === '0,0,1');
    assert.deepEqual(part.faceMaterials, [{ face: 103, material: blue }]);
    assert.deepEqual(scene.layers[0]!.faces, [{ part: 0, face: 103 }]);
    // The export draws the source level (nothing meshed yet).
    assert.equal(exportView(scene).looks.length, 1);
  });

test('pairing: by links among several B-rep parts; none without links (a warning); kept apart when asked',
  async () => {
    const other = `
#40=ADVANCED_FACE('c',(),#30,.T.);
#41=CLOSED_SHELL('',(#40));
#42=MANIFOLD_SOLID_BREP('',#41);
#43=ADVANCED_BREP_SHAPE_REPRESENTATION('other',(#42),#16);`;
    const linked = await importStep(file(COMMON + PAIR + other + related([35, 43])));
    const lods = (sc: Scene) => Object.fromEntries(sc.parts.map((p) => [p.name, p.lods.length]));
    assert.deepEqual(lods(linked.scene), { box: 1, other: 0 });
    // Without links (the solid's and faces' dropped), two B-rep parts leave it a part of its own.
    const unlinked = PAIR.replace('#104=TESSELLATED_SOLID(\'\',(#101,#102,#103),#34)',
      '#104=TESSELLATED_SOLID(\'\',(#101,#102,#103),$)').replace(/\(\),#3[12],\(\)/g, '(),$,()');
    const apart = await importStep(file(COMMON + unlinked + other + related([35, 43])));
    assert.deepEqual(lods(apart.scene), { 'box': 0, 'box tess': 1, 'other': 0 });
    // Where it lies on its own is where the merged level lies.
    assert.deepEqual(triangles(linked.scene, 'box').tris, triangles(apart.scene, 'box tess').tris);
    assert.deepEqual(worldNormals(linked.scene, 'box'), worldNormals(apart.scene, 'box tess'));
    assert.ok(apart.scene.diagnostics.some((d) => d.source?.id === 105 && /beside 2 B-rep parts/.test(d.message)));
    // With only the box, it pairs by being the one.
    const one = await importStep(file(COMMON + unlinked + related([35])));
    assert.deepEqual(lods(one.scene), { box: 1 });
    assert.deepEqual(one.scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source), [101, 102, 103]);
    // The backend path keeps both.
    const kept = await importStep(file(COMMON + PAIR + related([35])), { tessellated: 'backend' });
    assert.equal(kept.scene.parts.length, 2);
  });
