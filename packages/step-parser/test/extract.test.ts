import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  effectiveStyle, extractSemantics, math, openModel, parseStep, placement, productInstances,
  productRepresentations, Reader,
  transformation, Units, type Mat4, type Unit, type Vec3,
} from '../src/index.ts';

const enc = new TextEncoder();
const parse = (s: string) => parseStep(enc.encode(s));
const AP214 = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }';
const file = (data: string) => parse(
  `ISO-10303-21;HEADER;FILE_SCHEMA(('${AP214}'));ENDSEC;DATA;\n${data}\nENDSEC;END-ISO-10303-21;`);
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) =>
  assert.ok(a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - b[i]!) <= eps),
    `${Array.from(a)} ≉ ${Array.from(b)}`);
const point = (m: Mat4, p: Vec3) => math.apply(m, p);

// An assembly in millimetres with:
//  - a box part in inches (#200), placed twice: once by a standard relationship, once by a swapped one, rotated 90°
//    about z and moved by 100 mm;
//  - its geometry reached through a SHAPE_REPRESENTATION_RELATIONSHIP (#205 → #210);
//  - a third component placed by a mapped item, defined in another file (external reference);
//  - styles: the solid red, one face overridden blue, transparency, an invisible styled item, and a layer;
//  - validation properties on the box part: volume (in cubic inches... via a derived unit) and centroid.
const DATA = `
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#12=(LENGTH_UNIT()CONVERSION_BASED_UNIT('INCH',#13)NAMED_UNIT(#14));
#13=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#10);
#14=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);
#15=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-03),#10,'distance_accuracy_value','');
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#15))GLOBAL_UNIT_ASSIGNED_CONTEXT((#10,#11))REPRESENTATION_CONTEXT('mm',''));
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#12,#11))REPRESENTATION_CONTEXT('inch',''));
#18=DERIVED_UNIT((#19));
#19=DERIVED_UNIT_ELEMENT(#12,3.);
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#24=CARTESIAN_POINT('',(100.,0.,0.));
#25=DIRECTION('',(0.,1.,0.));
#26=AXIS2_PLACEMENT_3D('',#24,#21,#25);
#27=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#28=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#29=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#100=PRODUCT('ASM','Assembly','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('A','',#100);
#102=PRODUCT_DEFINITION('d1','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('asm',(#23,#26,#300),#16);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#200=PRODUCT('BOX','Box','a box',(#2));
#201=PRODUCT_DEFINITION_FORMATION('B','',#200);
#202=PRODUCT_DEFINITION('d2','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#205=SHAPE_REPRESENTATION('box',(#27),#17);
#206=SHAPE_DEFINITION_REPRESENTATION(#203,#205);
#207=SHAPE_REPRESENTATION_RELATIONSHIP('','',#205,#210);
#210=ADVANCED_BREP_SHAPE_REPRESENTATION('box geometry',(#211),#17);
#211=MANIFOLD_SOLID_BREP('',#212);
#212=CLOSED_SHELL('',(#213,#214));
#213=ADVANCED_FACE('',(),#215,.T.);
#214=ADVANCED_FACE('',(),#215,.T.);
#215=PLANE('',#28);
#220=CARTESIAN_POINT('',(1.,2.,3.));
#250=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','box 1','',#102,#202,'B1');
#251=PRODUCT_DEFINITION_SHAPE('','',#250);
#252=(REPRESENTATION_RELATIONSHIP('','',#205,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#253)SHAPE_REPRESENTATION_RELATIONSHIP());
#253=ITEM_DEFINED_TRANSFORMATION('','',#27,#23);
#254=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#252,#251);
#260=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','box 2','',#102,#202,$);
#261=PRODUCT_DEFINITION_SHAPE('','',#260);
#262=(REPRESENTATION_RELATIONSHIP('','',#104,#205)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#263)SHAPE_REPRESENTATION_RELATIONSHIP());
#263=ITEM_DEFINED_TRANSFORMATION('','',#26,#27);
#264=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#262,#261);
#300=MAPPED_ITEM('',#301,#302);
#301=REPRESENTATION_MAP(#29,#405);
#302=AXIS2_PLACEMENT_3D('',#303,#21,#22);
#303=CARTESIAN_POINT('',(0.,0.,50.));
#400=PRODUCT('EXT','External','',(#2));
#401=PRODUCT_DEFINITION_FORMATION('','',#400);
#402=PRODUCT_DEFINITION('','',#401,#3);
#403=PRODUCT_DEFINITION_SHAPE('','',#402);
#404=SHAPE_DEFINITION_REPRESENTATION(#403,#405);
#405=SHAPE_REPRESENTATION('ext',(#29),#16);
#406=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','ext','',#102,#402,$);
#407=PRODUCT_DEFINITION_SHAPE('','',#406);
#408=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#409,#407);
#409=SHAPE_REPRESENTATION_RELATIONSHIP('','',#405,#104);
#410=DOCUMENT_TYPE('geometry');
#411=DOCUMENT_FILE('ext.stp','','',#410,'',$);
#412=APPLIED_DOCUMENT_REFERENCE(#411,'',(#402));
#413=PROPERTY_DEFINITION('external definition','',#411);
#500=COLOUR_RGB('',1.,0.,0.);
#501=FILL_AREA_STYLE_COLOUR('',#500);
#502=FILL_AREA_STYLE('',(#501));
#503=SURFACE_STYLE_FILL_AREA(#502);
#504=SURFACE_SIDE_STYLE('',(#503,#505));
#505=SURFACE_STYLE_RENDERING_WITH_PROPERTIES(.NORMAL_SHADING.,#540,(#506));
#540=COLOUR_RGB('',1.,0.5,0.);
#506=SURFACE_STYLE_TRANSPARENT(0.25);
#507=SURFACE_STYLE_USAGE(.BOTH.,#504);
#508=PRESENTATION_STYLE_ASSIGNMENT((#507));
#509=STYLED_ITEM('',(#508),#211);
#530=COLOUR_RGB('',0.,1.,0.);
#531=FILL_AREA_STYLE_COLOUR('',#530);
#532=FILL_AREA_STYLE('',(#531));
#533=SURFACE_STYLE_FILL_AREA(#532);
#534=SURFACE_SIDE_STYLE('',(#533));
#535=SURFACE_STYLE_USAGE(.BOTH.,#534);
#536=PRESENTATION_STYLE_ASSIGNMENT((#535));
#537=STYLED_ITEM('',(#536),#214);
#510=DRAUGHTING_PRE_DEFINED_COLOUR('blue');
#511=FILL_AREA_STYLE_COLOUR('',#510);
#512=FILL_AREA_STYLE('',(#511));
#513=SURFACE_STYLE_FILL_AREA(#512);
#514=SURFACE_SIDE_STYLE('',(#513));
#515=SURFACE_STYLE_USAGE(.POSITIVE.,#514);
#516=PRESENTATION_STYLE_ASSIGNMENT((#515));
#517=OVER_RIDING_STYLED_ITEM('',(#516),#214,#509);
#518=PRESENTATION_STYLE_ASSIGNMENT((NULL_STYLE(.NULL.)));
#519=STYLED_ITEM('',(#518),#220);
#520=INVISIBILITY((#519));
#521=PRESENTATION_LAYER_ASSIGNMENT('L1','first layer',(#211,#220));
#600=PROPERTY_DEFINITION('geometric validation property','volume of box',#203);
#601=MEASURE_REPRESENTATION_ITEM('volume measure',VOLUME_MEASURE(8.),#18);
#602=REPRESENTATION('volume',(#601),#17);
#603=PROPERTY_DEFINITION_REPRESENTATION(#600,#602);
#604=PROPERTY_DEFINITION('geometric_validation_property','centroid of box',#203);
#605=CARTESIAN_POINT('centre point',(1.,1.,1.));
#606=REPRESENTATION('centroid',(#605),#17);
#607=PROPERTY_DEFINITION_REPRESENTATION(#604,#606);
#610=SHAPE_ASPECT('','solid',#203,.F.);
#611=GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#610,#210,#211);
#612=PROPERTY_DEFINITION('geometric validation property','area of solid',#610);
#613=MEASURE_REPRESENTATION_ITEM('surface area measure',AREA_MEASURE(24.),#614);
#614=DERIVED_UNIT((#615));
#615=DERIVED_UNIT_ELEMENT(#12,2.);
#616=REPRESENTATION('surface area',(#613),#17);
#617=PROPERTY_DEFINITION_REPRESENTATION(#612,#616);`;

test('units and contexts', async () => {
  const m = await openModel(file(DATA));
  const r = new Reader(m);
  const u = new Units(r);
  const mm = u.context(m.resolve(16))!;
  assert.deepEqual([mm.lengthUnit?.name, mm.lengthUnit?.factor, mm.planeAngleUnit?.factor, mm.uncertainty,
    mm.dimension], ['millimetre', 0.001, 1, 1e-6, 3]);
  const inch = u.ofRepresentation(m.resolve(205))!;
  assert.deepEqual([inch.lengthUnit?.name, inch.lengthUnit?.kind], ['INCH', 'length']);
  close([inch.lengthUnit!.factor!], [0.0254]);
  const cubic = u.unit(m.resolve(18))!;
  assert.equal(cubic.kind, 'volume');
  close([cubic.factor!], [0.0254 ** 3]);
  assert.deepEqual(r.diagnostics, []);

  // Writers that declare area and volume units as length units: read as their square and cube.
  const m2 = await openModel(file(`#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#2=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#1);
#3=(AREA_UNIT()CONVERSION_BASED_UNIT('INCH',#2)NAMED_UNIT(*));
#4=(VOLUME_UNIT()CONVERSION_BASED_UNIT('INCH',#2)NAMED_UNIT(*));
#5=(AREA_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#6=(AREA_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.SQUARE_METRE.));
#7=(NAMED_UNIT(*)SI_UNIT(.MILLI.,.CUBIC_METRE.)VOLUME_UNIT());`));
  const r2 = new Reader(m2);
  const u2 = new Units(r2);
  const [area, volume, mm2] = [3, 4, 5].map((id) => u2.unit(m2.resolve(id))!) as [Unit, Unit, Unit];
  assert.deepEqual([area.kind, volume.kind, mm2.kind, mm2.name], ['area', 'volume', 'area', 'square millimetre']);
  close([area.factor!, volume.factor!, mm2.factor!], [0.0254 ** 2, 0.0254 ** 3, 1e-6], 1e-18);
  const [cm2, mm3] = [6, 7].map((id) => u2.unit(m2.resolve(id))!) as [Unit, Unit];
  assert.deepEqual([cm2.name, cm2.kind, mm3.name, mm3.kind],
    ['square centimetre', 'area', 'cubic millimetre', 'volume']);
  close([cm2.factor!, mm3.factor!], [1e-4, 1e-9], 1e-20);
  assert.deepEqual(r2.diagnostics.map((d) => d.message), [
    "area unit 'INCH' converts from a length unit; read as its square",
    "volume unit 'INCH' converts from a length unit; read as its cube",
    'area unit named .METRE.; read as square metres',
  ]);
});

test('placements and transformations', async () => {
  const m = await openModel(file(DATA));
  const r = new Reader(m);
  // A single placement, absolutely: #26 has x along y, so y = z × x is along -x.
  const p26 = placement(r, m.resolve(26))!;
  close(p26, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
  // #263 takes #26 (100,0,0, x along y) onto #27 (origin): the assembly to the component, in mm → inch.
  const t = transformation(r, m.resolve(263), 1 / 25.4)!;
  close(point(t, [100, 0, 0]), [0, 0, 0]);
  close(point(t, [100, 25.4, 0]), [1, 0, 0]); // the frame's x axis (assembly y) becomes the component's x
  // Pure frame maths: a frame 1.6e-8 off the x axis still gives an orthonormal matrix.
  const f = file(`#1=CARTESIAN_POINT('',(0.,0.,0.));#2=DIRECTION('',(-1.,0.,-1.6E-08));#3=AXIS2_PLACEMENT_3D('',#1,#2,`
    + `$);#5=AXIS2_PLACEMENT_3D('',#1,#2,#2);`);
  const m2 = await openModel(f);
  const r2 = new Reader(m2);
  for (const id of [3, 5]) {
    const M = placement(r2, m2.resolve(id))!;
    const cols = [0, 4, 8].map((o) => [M[o]!, M[o + 1]!, M[o + 2]!] as Vec3);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(
      Math.abs(math.dot(cols[i]!, cols[j]!) - (i === j ? 1 : 0)) < 1e-15);
  }
  assert.deepEqual(r2.diagnostics.map((d) => d.message),
    ['placement ref_direction is parallel to its axis; using the default']);
  // The inverse of an affine matrix.
  const a = math.multiply(math.fromAxes([0, 2, 0], [-3, 0, 0], [0, 0, 1], [5, 6, 7]), math.scaling(1));
  close(math.multiply(a, math.invertAffine(a)!), math.identity(), 1e-12);
});

test('product structure: occurrences, swapped relationships, units, mapped items, external files', async () => {
  const m = await openModel(file(DATA));
  const { structure: s, diagnostics } = extractSemantics(m);
  assert.deepEqual(s.products.map((p) => [p.id, p.partNumber, p.name, p.version, p.definitionId, p.shapes]), [
    [102, 'ASM', 'Assembly', 'A', 'd1', [104]], [202, 'BOX', 'Box', 'B', 'd2', [205]],
    [402, 'EXT', 'External', undefined, undefined, [405]],
  ]);
  assert.equal(s.products[1]!.description, 'a box');
  assert.deepEqual(s.products[2]!.documents, [{ id: 411, name: 'ext.stp', external: true }]);
  assert.deepEqual(s.roots, [0]);
  assert.deepEqual(s.occurrences.map(
    (o) => [o.id, o.kind, o.parent, o.child, o.name, o.referenceDesignator, o.source]), [
    [250, 'nauo', 0, 1, 'box 1', 'B1', { cdsr: 254, relationship: 252 }],
    [260, 'nauo', 0, 1, 'box 2', undefined, { cdsr: 264, relationship: 262 }],
    [406, 'nauo', 0, 2, 'ext', undefined, { cdsr: 408, relationship: 409, mappedItem: 300 }],
  ]);
  // Box 1: identity frames, inch → mm.
  close(point(s.occurrences[0]!.transform!, [1, 0, 0]), [25.4, 0, 0]);
  // Box 2: rep_1 is the assembly; the inverse of assembly → component: component x → assembly y, origin → (100,0,0).
  close(point(s.occurrences[1]!.transform!, [0, 0, 0]), [100, 0, 0]);
  close(point(s.occurrences[1]!.transform!, [1, 0, 0]), [100, 25.4, 0]);
  close(point(s.occurrences[1]!.transform!, [0, 1, 0]), [100 - 25.4, 0, 0]); // y = z × x
  close(point(s.occurrences[1]!.transform!, [0, 0, 1]), [100, 0, 25.4]);
  // The external component: by the mapped item, raised 50 mm.
  close(point(s.occurrences[2]!.transform!, [0, 0, 0]), [0, 0, 50]);
  assert.deepEqual(diagnostics.map((d) => [d.severity, d.message, d.id]), [
    ['info', 'placement relationship with rep_1 and rep_2 swapped (rep_1 is the assembly)', 262],
  ]);
  // Representations: the box's own, and its geometry through the relationship; the mapped item places an occurrence,
  // so it isn't geometry of the assembly.
  assert.deepEqual(s.representations.get(205)!.related.map((x) => [x.representation, x.via, x.source]),
    [[210, 'relationship', 207]]);
  assert.deepEqual(s.representations.get(104)!.related, []);
  assert.deepEqual(productRepresentations(s, 1).map((x) => x.representation), [205, 210]);
  const inst = productInstances(s);
  assert.deepEqual(inst.map((i) => [i.product, i.path]), [[0, []], [1, [0]], [1, [1]], [2, [2]]]);
  close(point(inst[2]!.transform, [1, 1, 0]), [100 - 25.4, 25.4, 0]);
});

test('styles: colours, overrides, transparency, invisibility, layers, inheritance', async () => {
  const m = await openModel(file(DATA));
  const { styles } = extractSemantics(m);
  assert.deepEqual(styles.styled.map((s) => [s.id, s.item, s.style, s.overrides]), [
    [509, 211, { surface: [1, 0.5, 0], transparency: 0.25 }, undefined], // the rendering colour, not the fill's
    [537, 214, { surface: [0, 1, 0] }, undefined], // before the override in file order
    [517, 214, { surfaceSide: 'positive', surface: [0, 0, 1] }, 509],
    [519, 220, { null: true, invisible: true }, undefined],
  ]);
  assert.deepEqual(styles.layers, [{ id: 521, name: 'L1', description: 'first layer', items: [211, 220] }]);
  const r = new Reader(m);
  // A face inherits the solid's style through the shell; on the other face the override (blue) beats both the face's
  // own plain style (green) and the solid's, and the transparency is still inherited.
  assert.deepEqual(effectiveStyle(r, styles, m.resolve(213)), { surface: [1, 0.5, 0], transparency: 0.25 });
  assert.deepEqual(effectiveStyle(r, styles, m.resolve(214)),
    { surfaceSide: 'positive', surface: [0, 0, 1], transparency: 0.25 });
  assert.equal(effectiveStyle(r, styles, m.resolve(20)), undefined);
});

test('validation properties, in SI units', async () => {
  const m = await openModel(file(DATA));
  const { validation } = extractSemantics(m);
  assert.deepEqual(validation.map((v) => [v.id, v.kind, v.description, v.target]), [
    [600, 'geometric', 'volume of box', { kind: 'product', product: 202 }],
    [604, 'geometric', 'centroid of box', { kind: 'product', product: 202 }],
    [612, 'geometric', 'area of solid', { kind: 'shape aspect', aspect: 610, items: [211] }],
  ]);
  const [vol, centroid, area] = validation.map((v) => v.values[0]!);
  assert.deepEqual([vol!.name, vol!.representation, vol!.unit, centroid!.name, centroid!.representation, area!.unit],
    ['volume measure', 'volume', 'volume', 'centre point', 'centroid', 'area']);
  close([vol!.measure!], [8 * 0.0254 ** 3], 1e-15);
  close(centroid!.point!, [0.0254, 0.0254, 0.0254]);
  close([area!.measure!], [24 * 0.0254 ** 2], 1e-15);
});

// Less common placements, each from a corpus file: transformation items in the opposite representations (CATIA V4,
// bug33410.step), a NAUO placed by a mapped item in its own SHAPE_DEFINITION_REPRESENTATION (tr8_ha1_db.stp), and a
// component placed only by a mapped item, with no NAUO (2.stp).
const DATA2 = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('',''));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#24=CARTESIAN_POINT('',(10.,0.,0.));
#25=AXIS2_PLACEMENT_3D('',#24,#21,#22);
#26=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#27=CARTESIAN_POINT('',(0.,20.,0.));
#28=AXIS2_PLACEMENT_3D('',#27,#21,#22);
#29=CARTESIAN_POINT('',(0.,0.,30.));
#30=AXIS2_PLACEMENT_3D('',#29,#21,#22);
#100=PRODUCT('A','A','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('','',#100);
#102=PRODUCT_DEFINITION('','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('',(#23,#25,#301,#401),#16);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#200=PRODUCT('P','P','',(#2));
#201=PRODUCT_DEFINITION_FORMATION('','',#200);
#202=PRODUCT_DEFINITION('','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#205=SHAPE_REPRESENTATION('',(#26),#16);
#206=SHAPE_DEFINITION_REPRESENTATION(#203,#205);
#250=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','swapped items','',#102,#202,$);
#251=PRODUCT_DEFINITION_SHAPE('','',#250);
#252=(REPRESENTATION_RELATIONSHIP('','',#205,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#253)SHAPE_REPRESENTATION_RELATIONSHIP());
#253=ITEM_DEFINED_TRANSFORMATION('','',#25,#26);
#254=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#252,#251);
#260=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','by its own mapped item','',#102,#202,$);
#261=PRODUCT_DEFINITION_SHAPE('','',#260);
#262=SHAPE_DEFINITION_REPRESENTATION(#261,#263);
#263=SHAPE_REPRESENTATION('',(#301),#16);
#300=REPRESENTATION_MAP(#26,#205);
#301=MAPPED_ITEM('',#300,#28);
#400=REPRESENTATION_MAP(#26,#505);
#401=MAPPED_ITEM('mapped',#400,#30);
#500=PRODUCT('Q','Q','',(#2));
#501=PRODUCT_DEFINITION_FORMATION('','',#500);
#502=PRODUCT_DEFINITION('','',#501,#3);
#503=PRODUCT_DEFINITION_SHAPE('','',#502);
#505=SHAPE_REPRESENTATION('',(#26),#16);
#506=SHAPE_DEFINITION_REPRESENTATION(#503,#505);`;

test('less common placements: swapped items, mapped items without CDSR or NAUO', async () => {
  const m = await openModel(file(DATA2));
  const { structure: s, diagnostics } = extractSemantics(m);
  assert.deepEqual(s.occurrences.map((o) => [o.id, o.kind, o.parent, o.child, o.name, o.source]), [
    [250, 'nauo', 0, 1, 'swapped items', { cdsr: 254, relationship: 252 }],
    [260, 'nauo', 0, 1, 'by its own mapped item', { mappedItem: 301 }],
    [401, 'mapped-item', 0, 2, 'mapped', { mappedItem: 401 }],
  ]);
  // Items swapped back: the component's frame #26 onto the assembly's #25 at (10,0,0).
  close(point(s.occurrences[0]!.transform!, [0, 0, 0]), [10, 0, 0]);
  close(point(s.occurrences[1]!.transform!, [0, 0, 0]), [0, 20, 0]);
  close(point(s.occurrences[2]!.transform!, [0, 0, 0]), [0, 0, 30]);
  assert.deepEqual(s.roots, [0]); // Q is a component, through the mapped item
  // The mapped items place occurrences, so they aren't geometry of the assembly.
  assert.deepEqual(s.representations.get(104)!.related, []);
  assert.deepEqual(diagnostics.map((d) => [d.severity, d.message, d.id]), [
    ['info', 'transformation items are in the opposite representations; swapped back', 253],
  ]);
});

test('Alibre: transformation items in the opposite representations are kept in the order written', async () => {
  const header = (system: string) => `ISO-10303-21;HEADER;FILE_NAME('a.stp','',(''),(''),'ST-DEVELOPER v7','${system}',`
    + `'');FILE_SCHEMA(('${AP214}'));ENDSEC;DATA;\n${DATA2}\nENDSEC;END-ISO-10303-21;`;
  for (const [system, x, message] of [
    ['Alibre', -10, 'transformation items are in the opposite representations; kept as written (Alibre)'],
    ['CATIA SOLUTIONS V4', 10, 'transformation items are in the opposite representations; swapped back'],
  ] as const) {
    const { structure: s, diagnostics } = extractSemantics(await openModel(parse(header(system))));
    close(point(s.occurrences[0]!.transform!, [0, 0, 0]), [x, 0, 0]);
    close(point(s.occurrences[1]!.transform!, [0, 0, 0]), [0, 20, 0]); // other placements are unaffected
    assert.deepEqual(diagnostics.map((d) => d.message), [message]);
  }
});
