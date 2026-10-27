import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partInstances, validate, type Mat4 } from 'cad-scene';
import { parseStep } from 'step-parser';
import { importStep } from '../src/index.ts';

const enc = new TextEncoder();
const AP214 = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }';
const file = (data: string) => enc.encode(
  `ISO-10303-21;HEADER;FILE_NAME('asm.stp','',(''),(''),'pp','sys','');FILE_SCHEMA(('${AP214}'));ENDSEC;DATA;`
  + `\n${data}\nENDSEC;END-ISO-10303-21;`);
const at = (m: Mat4) => [m[12], m[13], m[14]].map((x) => Math.round(x! * 1e9) / 1e9);

// An assembly in metres holding an inch box twice (the second instance coloured by a context-dependent style), a
// styled assembly subcomponent, and an externally defined component. The box: a red solid with one face blue, a
// placement and a mapped item among its representation's items, on a layer.
const DATA = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));
#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#12=(LENGTH_UNIT()CONVERSION_BASED_UNIT('INCH',#13)NAMED_UNIT(*));
#13=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#11);
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('m',''));
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#12))REPRESENTATION_CONTEXT('in',''));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#24=CARTESIAN_POINT('',(0.1,0.,0.));
#25=AXIS2_PLACEMENT_3D('',#24,#21,#22);
#26=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#100=PRODUCT('ASM','Assembly','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('1','',#100);
#102=PRODUCT_DEFINITION('','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('asm',(#23,#25),#16);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#200=PRODUCT('BOX','Box','a box',(#2));
#201=PRODUCT_DEFINITION_FORMATION('','',#200);
#202=PRODUCT_DEFINITION('','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#205=ADVANCED_BREP_SHAPE_REPRESENTATION('box',(#26,#211,#219,#226,#240),#17);
#206=SHAPE_DEFINITION_REPRESENTATION(#203,#205);
#211=MANIFOLD_SOLID_BREP('',#212);
#212=CLOSED_SHELL('',(#213,#214));
#213=ADVANCED_FACE('',(),#215,.T.);
#214=ADVANCED_FACE('',(),#215,.T.);
#215=PLANE('',#230);
#217=ADVANCED_FACE('',(),#215,.T.);
#218=CLOSED_SHELL('',(#217));
#219=MANIFOLD_SOLID_BREP('',#218);
#224=ADVANCED_FACE('',(),#215,.T.);
#225=CLOSED_SHELL('',(#224));
#226=MANIFOLD_SOLID_BREP('',#225);
#230=AXIS2_PLACEMENT_3D('',#231,#21,#22);
#231=CARTESIAN_POINT('',(2.,4.,6.));
#232=CARTESIAN_POINT('',(4.,8.,10.));
#233=VERTEX_POINT('',#232);
#240=MAPPED_ITEM('',#241,#26);
#241=REPRESENTATION_MAP(#26,#242);
#242=SHAPE_REPRESENTATION('mapped',(#243),#17);
#243=CARTESIAN_POINT('',(1000.,0.,0.));
#250=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','box 1','',#102,#202,'B1');
#251=PRODUCT_DEFINITION_SHAPE('','',#250);
#252=(REPRESENTATION_RELATIONSHIP('','',#205,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#253)SHAPE_REPRESENTATION_RELATIONSHIP());
#253=ITEM_DEFINED_TRANSFORMATION('','',#26,#23);
#254=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#252,#251);
#260=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','box 2','',#102,#202,$);
#261=PRODUCT_DEFINITION_SHAPE('','',#260);
#262=(REPRESENTATION_RELATIONSHIP('','',#205,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#263)SHAPE_REPRESENTATION_RELATIONSHIP());
#263=ITEM_DEFINED_TRANSFORMATION('','',#26,#25);
#264=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#262,#261);
#400=PRODUCT('EXT','External','',(#2));
#401=PRODUCT_DEFINITION_FORMATION('','',#400);
#402=PRODUCT_DEFINITION('','',#401,#3);
#403=PRODUCT_DEFINITION_SHAPE('','',#402);
#404=SHAPE_DEFINITION_REPRESENTATION(#403,#405);
#405=SHAPE_REPRESENTATION('ext',(#26),#16);
#406=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','ext','',#102,#402,$);
#407=PRODUCT_DEFINITION_SHAPE('','',#406);
#408=(REPRESENTATION_RELATIONSHIP('','',#405,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#409)SHAPE_REPRESENTATION_RELATIONSHIP());
#409=ITEM_DEFINED_TRANSFORMATION('','',#26,#23);
#410=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#408,#407);
#411=DOCUMENT_FILE('ext.stp','','',#412,'',$);
#412=DOCUMENT_TYPE('geometry');
#413=APPLIED_DOCUMENT_REFERENCE(#411,'',(#402));
#414=PROPERTY_DEFINITION('external definition','',#411);
#500=COLOUR_RGB('',1.,0.,0.);
#501=FILL_AREA_STYLE_COLOUR('',#500);
#502=FILL_AREA_STYLE('',(#501));
#503=SURFACE_STYLE_FILL_AREA(#502);
#504=SURFACE_SIDE_STYLE('',(#503));
#505=SURFACE_STYLE_USAGE(.BOTH.,#504);
#506=PRESENTATION_STYLE_ASSIGNMENT((#505));
#507=STYLED_ITEM('',(#506),#211);
#510=COLOUR_RGB('',0.,0.,1.);
#511=FILL_AREA_STYLE_COLOUR('',#510);
#512=FILL_AREA_STYLE('',(#511));
#513=SURFACE_STYLE_FILL_AREA(#512);
#514=SURFACE_SIDE_STYLE('',(#513));
#515=SURFACE_STYLE_USAGE(.BOTH.,#514);
#516=PRESENTATION_STYLE_ASSIGNMENT((#515));
#517=OVER_RIDING_STYLED_ITEM('',(#516),#214,#507);
#520=COLOUR_RGB('',0.,1.,0.);
#521=FILL_AREA_STYLE_COLOUR('',#520);
#522=FILL_AREA_STYLE('',(#521));
#523=SURFACE_STYLE_FILL_AREA(#522);
#524=SURFACE_SIDE_STYLE('',(#523));
#525=SURFACE_STYLE_USAGE(.BOTH.,#524);
#526=PRESENTATION_STYLE_ASSIGNMENT((#525));
#527=CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM('',(#526),#205,#507,(#262));
#528=OVER_RIDING_STYLED_ITEM('',(#526),#214,#507);
#540=DRAUGHTING_PRE_DEFINED_COLOUR('yellow');
#541=CURVE_STYLE('',$,POSITIVE_LENGTH_MEASURE(0.1),#540);
#542=SURFACE_STYLE_BOUNDARY(#541);
#543=SURFACE_SIDE_STYLE('',(#542));
#544=SURFACE_STYLE_USAGE(.BOTH.,#543);
#545=PRESENTATION_STYLE_ASSIGNMENT((#544));
#546=STYLED_ITEM('',(#545),#219);
#531=PRESENTATION_STYLE_BY_CONTEXT((#525),#104);
#532=OVER_RIDING_STYLED_ITEM('',(#531),#213,#507);
#530=PRESENTATION_LAYER_ASSIGNMENT('L1','',(#211,#213));
#600=PRODUCT('SUB','Sub','',(#2));
#601=PRODUCT_DEFINITION_FORMATION('','',#600);
#602=PRODUCT_DEFINITION('','',#601,#3);
#603=PRODUCT_DEFINITION_SHAPE('','',#602);
#604=SHAPE_REPRESENTATION('sub',(#26),#16);
#605=SHAPE_DEFINITION_REPRESENTATION(#603,#604);
#620=NEXT_ASSEMBLY_USAGE_OCCURRENCE('4','sub','',#102,#602,$);
#621=PRODUCT_DEFINITION_SHAPE('','',#620);
#622=(REPRESENTATION_RELATIONSHIP('','',#604,#104)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#623)SHAPE_REPRESENTATION_RELATIONSHIP());
#623=ITEM_DEFINED_TRANSFORMATION('','',#26,#23);
#624=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#622,#621);
#630=NEXT_ASSEMBLY_USAGE_OCCURRENCE('5','box in sub','',#602,#202,$);
#631=PRODUCT_DEFINITION_SHAPE('','',#630);
#632=(REPRESENTATION_RELATIONSHIP('','',#205,#604)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#633)SHAPE_REPRESENTATION_RELATIONSHIP());
#633=ITEM_DEFINED_TRANSFORMATION('','',#26,#26);
#634=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#632,#631);
#640=CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM('',(#516),#205,#507,(#622,#632));`;

test('names: generic part names take the product\'s, blank names are missing', async () => {
  const names = async (rep: string, product = 'Box', partNumber = 'BOX', occurrence = 'box 1') => {
    const data = DATA.replace("ADVANCED_BREP_SHAPE_REPRESENTATION('box',",
      `ADVANCED_BREP_SHAPE_REPRESENTATION('${rep}',`)
      .replace("PRODUCT('BOX','Box','a box'", `PRODUCT('${partNumber}','${product}','a box'`)
      .replace("NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','box 1'", `NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','${occurrence}'`);
    const { scene } = await importStep(file(data));
    return { part: scene.parts[0]!.name, component: scene.components[1]!.name,
      occurrence: scene.components[0]!.children[0]!.name };
  };
  // Generic representation names (blank, NONE, an instance id) take the product's; others are kept.
  for (const rep of ['', ' ', 'NONE', 'none', '#205', ' #12 ']) assert.equal((await names(rep)).part, 'Box',
    `'${rep}'`);
  for (const rep of ['box', 'SOLID', 'Part 12', '#205 copy']) assert.equal((await names(rep)).part, rep);
  // A blank product name gives way to the part number, for the component and for the part.
  assert.deepEqual(await names('#205', ' '), { part: 'BOX', component: 'BOX', occurrence: 'box 1' });
  assert.deepEqual(await names('#205', '', 'BOX'), { part: 'BOX', component: 'BOX', occurrence: 'box 1' });
  // Both blank: the component keeps its blank name, the part its own.
  assert.deepEqual(await names('NONE', ' ', ''), { part: 'NONE', component: ' ', occurrence: 'box 1' });
  // A blank occurrence name is no name (the products extractor drops it).
  assert.equal((await names('box', 'Box', 'BOX', '  ')).occurrence, undefined);
});

test('components, parts, units and placements', async () => {
  const { scene, partOf } = await importStep(file(DATA));
  assert.deepEqual(validate(scene), []);
  assert.equal(scene.unit, 'millimetre');
  assert.deepEqual(scene.components.map(
    (c) => [c.name, c.properties, c.sources.map((x) => x.id), c.parts.length, c.children.length, c.external]), [
    ['Assembly', { partNumber: 'ASM', version: '1', lifeCycleStage: 'design' }, [102, 100], 0, 4, undefined],
    ['Box', { partNumber: 'BOX', description: 'a box', lifeCycleStage: 'design' }, [202, 200], 2, 0, undefined],
    ['External', { partNumber: 'EXT', lifeCycleStage: 'design' }, [402, 400], 0, 0, { uri: 'ext.stp', format: 'step' }],
    ['Sub', { partNumber: 'SUB', lifeCycleStage: 'design' }, [602, 600], 0, 1, undefined],
  ]);
  // Two parts: the box's representation, and the one its mapped item places (a part of its own, referenced by the box).
  assert.deepEqual([...partOf], [[205, 0], [242, 1]]);
  const box = scene.parts[0]!;
  // The origin: the centre of the points in the box's closure, (0,0,0) and (2,4,6); not the mapped item's, nor the
  // unreferenced vertex #233.
  assert.deepEqual([box.kind, box.name, box.unit, box.origin, box.sources],
    ['brep', 'box', 25.4, [1, 2, 3], [{ format: 'step', id: 205 }]]);
  assert.deepEqual(scene.parts[1]!.origin, [1000, 0, 0]);
  // The payload: a subset rooted at the box's representation, without the mapped item.
  const sub = parseStep(box.kind === 'brep' ? box.payload() : new Uint8Array());
  assert.deepEqual([...sub.index.ids].includes(240), false);
  assert.ok(sub.index.position(205) >= 0);
  // Placements, in millimetres: box 1 at the origin, box 2 at 0.1 m; an inch is 25.4 mm.
  const placed = [...partInstances(scene)].map(
    (p) => [p.path.join('/'), p.part, at(p.transform), Math.round(p.transform[0]! * 1e9) / 1e9]);
  assert.deepEqual(placed, [
    ['0/0', 0, [0, 0, 0], 25.4], ['0/0', 1, [0, 0, 0], 25.4], ['0/1', 0, [100, 0, 0], 25.4],
    ['0/1', 1, [100, 0, 0], 25.4],
    ['0/3/0', 0, [0, 0, 0], 25.4], ['0/3/0', 1, [0, 0, 0], 25.4],
  ]);
});

test('materials: part, face, instance override; layers', async () => {
  const { scene } = await importStep(file(DATA));
  const color = (m: number | undefined) => (m === undefined ? undefined : scene.materials[m]!.color);
  const box = scene.parts[0]!;
  // The red solid's faces red (face 213's green override applies only in a presentation context, so not by default),
  // except face 214, which has two overrides, blue then green: the later wins. The second solid (#219) has only a
  // boundary colour, yellow, which its face #217 shows. The third (#226) is unstyled, so the part has no material of
  // its own and its face #224 stays unstyled.
  assert.equal(box.material, undefined);
  assert.deepEqual(box.faceMaterials?.map((f) => [f.face, color(f.material)]),
    [[213, [1, 0, 0]], [214, [0, 1, 0]], [217, [1, 1, 0]]]);
  // The second box instance is green as a whole, by the context-dependent style on relationship #262; the box in the
  // subassembly blue, by one whose context goes two levels down (the occurrence's index among its parent's children,
  // 0, isn't its index in the file's occurrences, 4).
  assert.deepEqual(scene.overrides.map((o) => [o.path, color(o.material), o.sources]), [
    [[0, 1], [0, 1, 0], [{ format: 'step', id: 527 }]], [[0, 3, 0], [0, 0, 1], [{ format: 'step', id: 640 }]],
  ]);
  const looks = [...partInstances(scene)].filter((p) => p.part === 0).map(
    (p) => [p.path.join('/'), color(p.material), [...p.faceMaterials]]);
  const faces = box.faceMaterials!.map((f) => [f.face, f.material]);
  assert.deepEqual(looks, [['0/0', undefined, faces], ['0/1', [0, 1, 0], []], ['0/3/0', [0, 0, 1], []]]);
  assert.deepEqual(scene.layers.map((l) => [l.name, l.visible, l.parts, l.faces]),
    [['L1', true, [0], [{ part: 0, face: 213 }]]]);
  assert.deepEqual(scene.properties,
    { format: 'step', name: 'asm.stp', originatingSystem: 'sys', preprocessorVersion: 'pp', schemas: AP214 });
});

// A product whose representation holds only an annotation (text and a placement) and, related to it, a geometrically
// bounded surface representation: a geometric set of a red curve-bounded surface, an unstyled plane and a point.
const SURFACES = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#11))REPRESENTATION_CONTEXT('mm',''));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#30=TEXT_LITERAL('note','a note',#23,'baseline left',.RIGHT.);
#100=PRODUCT('P','P','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('','',#100);
#102=PRODUCT_DEFINITION('','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('notes',(#23,#30),#16);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#110=PLANE('',#23);
#111=PLANE('',#23);
#112=CURVE_BOUNDED_SURFACE('',#110,(),.T.);
#113=CARTESIAN_POINT('',(1.,2.,3.));
#114=GEOMETRIC_SET('',(#112,#111,#113));
#115=GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION('gbssr',(#114),#16);
#116=SHAPE_REPRESENTATION_RELATIONSHIP('','',#115,#104);
#500=COLOUR_RGB('',1.,0.,0.);
#501=FILL_AREA_STYLE_COLOUR('',#500);
#502=FILL_AREA_STYLE('',(#501));
#503=SURFACE_STYLE_FILL_AREA(#502);
#504=SURFACE_SIDE_STYLE('',(#503));
#505=SURFACE_STYLE_USAGE(.BOTH.,#504);
#506=PRESENTATION_STYLE_ASSIGNMENT((#505));
#507=STYLED_ITEM('',(#506),#112);`;

test("an annotation-only representation isn't a part; a geometric set's surfaces take their styles as faces",
  async () => {
  const { scene } = await importStep(file(SURFACES));
  assert.deepEqual(scene.parts.map((p) => (p.kind === 'brep' ? p.rootId : undefined)), [115]);
  const part = scene.parts[0]!;
  assert.equal(part.material, undefined);
  assert.deepEqual(part.faceMaterials?.map((f) => [f.face, scene.materials[f.material]!.color]), [[112, [1, 0, 0]]]);
  assert.deepEqual([...partInstances(scene)].map((p) => p.part), [0]);
});

// A product whose representation holds a placement, with two representations related to it: a two-dimensional drawing
// (a point in a curve set) and a three-dimensional wireframe (a line segment).
const DRAWING = `
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#11))REPRESENTATION_CONTEXT('mm',''));
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(2)GLOBAL_UNIT_ASSIGNED_CONTEXT((#11))REPRESENTATION_CONTEXT('sheet',''));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#100=PRODUCT('P','P','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('','',#100);
#102=PRODUCT_DEFINITION('','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('',(#23),#16);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#110=CARTESIAN_POINT('',(5.,5.));
#111=GEOMETRIC_CURVE_SET('',(#110));
#112=GEOMETRICALLY_BOUNDED_2D_WIREFRAME_REPRESENTATION('sheet',(#111),#17);
#113=SHAPE_REPRESENTATION_RELATIONSHIP('','',#112,#104);
#120=CARTESIAN_POINT('',(1.,0.,0.));
#121=VECTOR('',#22,1.);
#122=LINE('',#20,#121);
#123=TRIMMED_CURVE('',#122,(#20),(#120),.T.,.CARTESIAN.);
#124=GEOMETRIC_CURVE_SET('',(#123));
#125=GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION('wire',(#124),#16);
#126=SHAPE_REPRESENTATION_RELATIONSHIP('','',#125,#104);`;

test("a two-dimensional drawing isn't a part, and says so; a wireframe is", async () => {
  const { scene } = await importStep(file(DRAWING));
  assert.deepEqual(scene.parts.map((p) => (p.kind === 'brep' ? p.rootId : undefined)), [125]);
  assert.deepEqual(scene.diagnostics.filter((d) => /drawing/.test(d.message)),
    [{ severity: 'info', message: 'a two-dimensional drawing; not imported', source: { format: 'step', id: 112 } }]);
  assert.deepEqual([...partInstances(scene)].map((p) => p.part), [0]);
});

test('dangling references: a warning per part naming them, at most 10; one beyond the largest id, from the scan',
  async () => {
  const ctx = "#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21))REPRESENTATION_CONTEXT('',"
    + "''));\n#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));";
  const many = Array.from({ length: 12 }, (_, i) => `#${912 - i}`).join(',');
  const { scene } = await importStep(file(`${ctx}
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#5=CARTESIAN_POINT('',(0.,0.,0.));
#6=AXIS2_PLACEMENT_3D('',#5,$,$);
#100=PRODUCT('P','P','',(#2));
#101=PRODUCT_DEFINITION_FORMATION('','',#100);
#102=PRODUCT_DEFINITION('','',#101,#3);
#103=PRODUCT_DEFINITION_SHAPE('','',#102);
#104=SHAPE_REPRESENTATION('',(#6),#20);
#105=SHAPE_DEFINITION_REPRESENTATION(#103,#104);
#106=SHAPE_REPRESENTATION_RELATIONSHIP('','',#10,#104);
#107=SHAPE_REPRESENTATION_RELATIONSHIP('','',#30,#104);
#108=SHAPE_REPRESENTATION_RELATIONSHIP('','',#40,#104);
#10=ADVANCED_BREP_SHAPE_REPRESENTATION('many',(#11),#20);
#11=MANIFOLD_SOLID_BREP('',#12);
#12=CLOSED_SHELL('',(${many},#901));
#30=ADVANCED_BREP_SHAPE_REPRESENTATION('one',(#31),#20);
#31=MANIFOLD_SOLID_BREP('',#32);
#32=CLOSED_SHELL('',(#0,#18446744073709551615));
#40=ADVANCED_BREP_SHAPE_REPRESENTATION('sound',(#41),#20);
#41=MANIFOLD_SOLID_BREP('',#42);
#42=CLOSED_SHELL('',());`));
  assert.equal(scene.parts.length, 3);
  const step = (id: number) => ({ format: 'step', id });
  assert.deepEqual(scene.diagnostics.filter((d) => /define|beyond/.test(d.message)), [
    { severity: 'warning', message: 'reference beyond the largest instance id (2^32 - 1) read as $', source: step(32) },
    { severity: 'warning', message: "1 reference to an instance the file doesn't define: #0", source: step(30) },
    { severity: 'warning', message: "12 references to instances the file doesn't define: #901, #902, #903, #904, #905, "
      + "#906, #907, #908, #909, #910, ...", source: step(10) },
  ]);
});

// Parts' closed, as the file states it: solids (with voids too) and surface models of closed shells are closed; an
// open shell, a solid beside one, aren't; a geometric set's surfaces, tessellated faces and parts without faces say
// nothing; a face shared with another part counts by its shells in each part.
test('closed: every face in a closed shell; not with an open shell; unknown for a set\'s surfaces or tessellated',
  async () => {
    const { scene } = await importStep(parseStep(file(`
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('mm',''));
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=DIRECTION('',(1.,0.,0.));
#23=AXIS2_PLACEMENT_3D('',#20,#21,#22);
#30=PLANE('',#23);
#31=ADVANCED_FACE('',(),#30,.T.);
#32=ADVANCED_FACE('',(),#30,.T.);
#33=ADVANCED_FACE('',(),#30,.T.);
#34=ADVANCED_FACE('',(),#30,.T.);
#35=ADVANCED_FACE('',(),#30,.T.);
#36=ADVANCED_FACE('',(),#30,.T.);
#40=CLOSED_SHELL('',(#31,#32));
#41=MANIFOLD_SOLID_BREP('',#40);
#42=ADVANCED_BREP_SHAPE_REPRESENTATION('solid',(#41),#16);
#50=CLOSED_SHELL('',(#33));
#51=ORIENTED_CLOSED_SHELL('',*,#50,.F.);
#52=BREP_WITH_VOIDS('',#40,(#51));
#53=ADVANCED_BREP_SHAPE_REPRESENTATION('voids',(#52),#16);
#60=CLOSED_SHELL('',(#34));
#61=SHELL_BASED_SURFACE_MODEL('',(#60));
#62=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('closed surface',(#61),#16);
#70=OPEN_SHELL('',(#35));
#71=SHELL_BASED_SURFACE_MODEL('',(#70));
#72=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('open surface',(#71),#16);
#80=OPEN_SHELL('',(#36));
#81=SHELL_BASED_SURFACE_MODEL('',(#80));
#82=SHAPE_REPRESENTATION('mixed',(#41,#81),#16);
#90=GEOMETRIC_SET('',(#30));
#91=GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION('set',(#90),#16);
#100=COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#101=TRIANGULATED_FACE('',#100,3,(),$,(),((1,2,3)));
#102=TESSELLATED_SHELL('',(#101),$);
#103=TESSELLATED_SHAPE_REPRESENTATION('tessellated',(#102),#16);
#110=GEOMETRIC_SET('',(#20));
#111=GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION('points',(#110),#16);
#120=CLOSED_SHELL('',(#35));
#121=MANIFOLD_SOLID_BREP('',#120);
#122=ADVANCED_BREP_SHAPE_REPRESENTATION('sharing a face',(#121),#16);
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#200=PRODUCT('P','P','',(#2));
#201=PRODUCT_DEFINITION_FORMATION('','',#200);
#202=PRODUCT_DEFINITION('','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#204=SHAPE_REPRESENTATION('top',(#23),#16);
#205=SHAPE_DEFINITION_REPRESENTATION(#203,#204);
${[42, 53, 62, 72, 82, 91, 103, 111, 122].map((r, i) =>
  `#${300 + i}=SHAPE_REPRESENTATION_RELATIONSHIP('','',#${r},#204);`)
  .join('\n')}`)));
    const closed = Object.fromEntries(scene.parts.map((p) => [p.name, p.closed]));
    assert.deepEqual(closed, { 'solid': true, 'voids': true, 'closed surface': true, 'open surface': false,
      'mixed': false, 'set': undefined, 'tessellated': undefined, 'points': undefined, 'sharing a face': true });
  });
