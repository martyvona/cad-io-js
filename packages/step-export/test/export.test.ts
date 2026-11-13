// The STEP exporter on hand-built scenes: the structure (products, placements, units, names, ids), the top, styles
// and per-placement overrides, layers, external references, tessellated parts, AP214, determinism; each file read
// back by step-import and compared with the scene it was written from (as the scene itself resolves it:
// partInstances), and bound against its schema with values checked. Expected text is written from the standard and
// the numbers worked out by hand, not taken from the writer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, decode, rowCount } from 'cad-brep';
import { exportView, identity, multiply, partInstances, placedName, scaling, viewDifferences, type Component, type Lod,
  type Mat4, type Part, type Scene } from 'cad-scene';
import { formatReal as real, openModel, parseStep } from 'step-parser';
import { box } from '../../cad-brep/test/models.ts';
import { importStep } from '../../step-import/src/index.ts';
import { AP214_SCHEMA, AP242_SCHEMA, exportStep, type StepExportOptions } from '../src/index.ts';

const concat = (cs: Iterable<Uint8Array>) => {
  const all = [...cs];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
};
/** A cube of side `size` (millimetres) as a solid, its faces' ids `idBase` + 21 to 26. */
function cubeModel(idBase = 0, size = 1): BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const solid = b.addBody({ kind: 'solid', members: [{ ref: box(b, [size, size, size], [0, 0, 0], idBase),
    sense: true }],
    id: idBase + 100 });
  b.addItem({ kind: 'body', ref: solid, id: idBase + 101 });
  return b.finish();
}
/** The scene written: bytes, text, diagnostics (warnings and errors: the fixtures' edge ranges are info), and the
 * scene read back. */
async function roundTrip(scene: Scene, opts: StepExportOptions = {}) {
  const x = exportStep(scene, opts);
  const bytes = concat(x.chunks);
  const back = (await importStep(bytes)).scene;
  return { bytes, text: new TextDecoder().decode(bytes),
    diagnostics: x.diagnostics.filter((d) => d.severity !== 'info'), all: x.diagnostics, back };
}
/** Diagnostics of binding every instance of a file against its schema, values checked: none expected. */
async function bindProblems(bytes: Uint8Array): Promise<string[]> {
  const m = await openModel(parseStep(bytes));
  const out = m.diagnostics.map((d) => d.message);
  for (let p = 0; p < m.file.count; p++) for (const d of m.bind(p, { check: true }).diagnostics) {
    out.push(`#${m.file.index.ids[p]}: ${d.message}`);
  }
  return out;
}

const translate = (x: number, y: number, z: number, m: Mat4 = identity()) => {
  const t = identity();
  t[12] = x; t[13] = y; t[14] = z;
  return multiply(t, m);
};
/** A turn by 90 degrees about z: x to y. */
const quarter = (): Mat4 => { const m = identity(); m[0] = 0; m[1] = 1; m[4] = -1; m[5] = 0; return m; };
const part = (name: string, model: BrepData, id: number): Part => ({ name, sources: [{ format: 'step', id }],
  properties: {}, origin: [0.5, 0.5, 0.5], brep: { model, format: 'step' }, lods: [] });
const component = (name: string, c: Partial<Component> = {}): Component => ({ name, sources: [], properties: {},
  parts: [], children: [], ...c });
const sceneOf = (s: Partial<Scene>): Scene => ({ unit: 'millimetre', components: [], roots: [], parts: [],
  materials: [], layers: [], overrides: [], properties: {}, diagnostics: [], ...s });
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) =>
  Array.from(a).every((x, k) => Math.abs(x - b[k]!) <= eps * Math.max(1, Math.abs(x)));

/** Each placed part as drawn: its path's names, world transform, visibility and every face's colour. */
function looks(s: Scene) {
  const colour = (m: number | undefined) => m === undefined ? 'none'
    : `${s.materials[m]!.color.map((c) => c.toFixed(4))}@${s.materials[m]!.opacity.toFixed(4)}`;
  return [...partInstances(s)].map((i) => {
    const p = s.parts[i.part]!;
    const ids = p.brep ? Array.from({ length: rowCount(p.brep.model, 'face') }, (_, k) => decode.face(p.brep!.model,
      k).id!) : [...new Set(p.lods[0]?.mesh.faces.map((f) => f.source) ?? [])];
    // (By order, not id: a face whose id another part's took is renumbered.)
    const faces = ids.map((f) => colour(i.faceMaterials.get(f!) ?? i.material));
    return { name: `${p.name}/${placedName(s, i.ref)}`, transform: i.transform, visible: i.visible,
      faces: faces.join(' ') };
  });
}
function sameLooks(a: Scene, b: Scene) {
  const x = looks(a), y = looks(b);
  assert.equal(y.length, x.length, 'placed parts');
  x.forEach((l, k) => {
    assert.equal(y[k]!.name, l.name);
    assert.ok(near(y[k]!.transform, l.transform), `${l.name}: transform`);
    assert.equal(y[k]!.visible, l.visible, `${l.name}: visibility`);
    assert.equal(y[k]!.faces, l.faces, `${l.name}: face colours`);
  });
}

// An assembly in inches (`top`, holding its own part, an unnamed reference) with a sub-assembly moved and turned,
// which places a leaf product (`cube_1` of `cubeprod`) moved by (1, 2, 3) mm.
function assembly(): Scene {
  const a = part('block', cubeModel(), 300);
  const b = part('plate', cubeModel(1000), 301);
  return sceneOf({
    sourceUnit: 25.4,
    parts: [a, b],
    components: [
      component('top', { sources: [{ format: 'step', id: 400 }, { format: 'step', id: 401 }],
        properties: { partNumber: 'P-100', version: 'B', description: 'the top' },
        parts: [{ part: 1, transform: identity() }],
        children: [{ component: 1, transform: translate(10, 20, 30, quarter()), name: 'sub_1',
          sources: [{ format: 'step', id: 610 }], properties: { occurrenceId: 'SUB1' } }] }),
      component('sub', { parts: [{ part: 0, transform: translate(1, 2, 3), name: 'cube_1',
        sources: [{ format: 'step', id: 600 }],
        product: { name: 'cubeprod', sources: [{ format: 'step', id: 500 }, { format: 'step', id: 501 }],
          properties: {} } }] }),
    ],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }],
  });
}

test('structure: products, placements as NAUOs with item-defined transformations in the assembly\'s unit, ids kept',
  async () => {
    const s = assembly();
    const { text, diagnostics, back, bytes } = await roundTrip(s);
    assert.deepEqual(diagnostics, []);
    assert.match(text, new RegExp(`FILE_SCHEMA\\(\\('${AP242_SCHEMA.replace(/[{}]/g, '\\$&')}'\\)\\)`));
    assert.match(text, /APPLICATION_CONTEXT\('managed model based 3d engineering'\)/);
    // PRODUCT(id, name, description, contexts), its formation's version, the definition's id; source ids kept.
    assert.match(text, /#401=PRODUCT\('P-100','top','the top',\(#\d+\)\)/);
    assert.match(text, /PRODUCT_DEFINITION_FORMATION\('B','',#401\)/);
    assert.match(text, /#400=PRODUCT_DEFINITION\('design',''/);
    assert.match(text, /#501=PRODUCT\('cubeprod','cubeprod',''/);
    // NAUO(id, name, description, relating, related, designator): the sub-assembly in top, the cube in sub.
    assert.match(text, /#610=NEXT_ASSEMBLY_USAGE_OCCURRENCE\('SUB1','sub_1','',#400,#\d+,\$\)/);
    assert.match(text, /#600=NEXT_ASSEMBLY_USAGE_OCCURRENCE\('cube_1','cube_1','',#\d+,#500,\$\)/);
    // The sub-assembly's placement in top, in inches: (10, 20, 30) mm / 25.4, turned a quarter (x to y).
    const at = (x: number) => String(x / 25.4);
    assert.ok(text.includes(`CARTESIAN_POINT('',(${at(10)},${at(20)},${at(30)}))`), 'placement in inches');
    assert.match(text, /#300=ADVANCED_BREP_SHAPE_REPRESENTATION\('block',\(#\d+,#\d+\)/);
    // The parts' faces keep their ids.
    for (const f of [21, 22, 23, 24, 25, 26]) assert.match(text, new RegExp(`#${f}=ADVANCED_FACE\\(`));
    assert.match(text, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
    assert.match(text, /CONVERSION_BASED_UNIT\('INCH'/);
    assert.deepEqual(await bindProblems(bytes), []);
    // Read back: the same tree, names and placements.
    sameLooks(s, back);
    assert.deepEqual(back.components.map((c) => c.name), ['top', 'sub']);
    assert.equal(back.components[0]!.properties.partNumber, 'P-100');
    assert.equal(back.components[0]!.properties.version, 'B');
    assert.equal(back.components[0]!.children[0]!.name, 'sub_1');
    assert.equal(back.components[0]!.children[0]!.properties.occurrenceId, 'SUB1');
    const leaf = back.components[1]!.parts[0]!;
    assert.equal(leaf.name, 'cube_1');
    assert.equal(leaf.product?.name, 'cubeprod');
    assert.deepEqual(back.parts.map((p) => p.sources[0]!.id).sort(), [300, 301]);
    assert.equal(back.sourceUnit, 25.4);
  });

test('the same scene gives the same bytes; a time stamp only when given', async () => {
  const a = concat(exportStep(assembly()).chunks), b = concat(exportStep(assembly()).chunks);
  assert.deepEqual(a, b);
  assert.match(new TextDecoder().decode(a), /FILE_NAME\('',''/);
  assert.match(new TextDecoder().decode(concat(exportStep(assembly(), { timeStamp: '2026-11-10T12:00:00',
    name: 'x.stp' }).chunks)), /FILE_NAME\('x.stp','2026-11-10T12:00:00'/);
});

test('the top: roots and root parts as top products; moved, inside one assembly made for them, named after the file',
  async () => {
    const s = sceneOf({ parts: [part('block', cubeModel(), 300)],
      rootParts: [{ part: 0, transform: identity(), name: 'b_1' }], properties: { name: 'scene.stp' } });
    const plain = await roundTrip(s);
    assert.deepEqual(plain.diagnostics, []);
    assert.equal(plain.back.roots.length, 0);
    assert.equal(plain.back.rootParts?.length, 1);
    sameLooks(s, plain.back);
    s.rootParts![0]!.transform = translate(5, 0, 0);
    const moved = await roundTrip(s);
    assert.match(moved.all.map((d) => d.message).join('\n'), /top of the tree is moved/);
    assert.equal(moved.back.roots.length, 1);
    assert.equal(moved.back.components[moved.back.roots[0]!.component]!.name, 'scene.stp');
    sameLooks(s, moved.back);
    // Inside it, the placement's name on its NAUO, the product the part's.
    const placed = moved.back.components[moved.back.roots[0]!.component]!.parts[0]!;
    assert.equal(placed.name, 'b_1');
    assert.equal(placed.product?.name, 'block');
  });

test('a placement that mirrors or scales: written as its rotation, with a warning', async () => {
  const s = assembly();
  const m = identity();
  m[0] = -1;
  s.components[0]!.children[0]!.transform = m;
  const { diagnostics } = await roundTrip(s);
  assert.match(diagnostics.map((d) => d.message).join('\n'), /mirrors; written as its rotation/);
  m[0] = 2;
  assert.match((await roundTrip(s)).diagnostics.map((d) => d.message).join('\n'), /scales; written as its rotation/);
});

/** The assembly with colours: the block red with one face blue, the plate half transparent and hidden everywhere. */
function styled(): Scene {
  const s = assembly();
  s.materials = [{ color: [1, 0, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] },
    { color: [0, 1, 0], opacity: 0.5, sources: [] }, { color: [1, 1, 0], opacity: 1, sources: [] }];
  s.parts[0]!.material = 0;
  s.parts[0]!.faceMaterials = [{ face: 22, material: 1 }];
  s.parts[1]!.material = 2;
  s.components[0]!.parts[0]!.visible = false;
  return s;
}

test('styles: a part\'s colour, a face\'s, transparency, a part hidden wherever it\'s placed', async () => {
  const s = styled();
  const { text, back, bytes, diagnostics } = await roundTrip(s);
  assert.deepEqual(diagnostics, []);
  sameLooks(s, back);
  assert.match(text, /COLOUR_RGB\('',1\.,0\.,0\.\)/);
  assert.match(text, /SURFACE_STYLE_TRANSPARENT\(0\.5\)/);
  assert.match(text, /STYLED_ITEM\('color',\(#\d+\),#22\)/);
  assert.match(text, /INVISIBILITY\(\(#\d+\)\)/);
  assert.doesNotMatch(text, /CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM/);
  assert.match(text, /MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION\(/);
  assert.deepEqual(await bindProblems(bytes), []);
});

test('per placement: a reference\'s own colour and visibility, and the scene\'s overrides, as context-dependent styles',
  async () => {
    const s = styled();
    // The sub-assembly placed twice: the second time its cube is green (its reference's colour) in one, and an
    // override colours the first instance yellow and hides the plate's... (the plate is top's own part, at path [0]).
    s.components[0]!.children.push({ component: 1, transform: translate(100, 0, 0), name: 'sub_2', sources: [],
      properties: {} });
    s.components.push(component('other', { parts: [{ part: 0, transform: identity(), name: 'cube_g', material: 2 }] }));
    s.components[0]!.children.push({ component: 2, transform: translate(0, 100, 0), name: 'other_1', sources: [],
      properties: {} });
    s.components[1]!.parts.push({ part: 1, transform: translate(0, 0, 5), name: 'plate_s', sources: [] });
    s.overrides = [{ path: [0, 0], material: 3, sources: [] },
      { path: [0, 1], ref: 0, faceMaterials: [{ part: 0, face: 23, material: 1 }], sources: [] },
      { path: [0, 1], ref: 0, visible: false, sources: [] }];
    const { back, bytes, diagnostics, text } = await roundTrip(s);
    assert.deepEqual(diagnostics, []);
    assert.match(text, /CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM\('color',\(#\d+\),#\d+,#\d+,\(#\d+(,#\d+)*\)\)/);
    sameLooks(s, back);
    assert.deepEqual(await bindProblems(bytes), []);
  });

test('layers: their parts\' items and faces, an invisible one by INVISIBILITY', async () => {
  const s = styled();
  s.layers = [{ name: 'L1', description: 'first', visible: false, parts: [0], faces: [{ part: 1, face: 1024 }],
    sources: [] }];
  const { back, bytes } = await roundTrip(s);
  assert.equal(back.layers.length, 1);
  const l = back.layers[0]!;
  assert.equal(l.name, 'L1');
  assert.equal(l.description, 'first');
  assert.equal(l.visible, false);
  assert.deepEqual(l.parts.map((i) => back.parts[i]!.name), ['block']);
  assert.deepEqual(l.faces.map((f) => [back.parts[f.part]!.name, f.face]), [['plate', 1024]]);
  assert.deepEqual(await bindProblems(bytes), []);
});

test('a component defined in another file: its external reference read back', async () => {
  const s = assembly();
  s.components[1]!.external = { uri: 'sub.stp', format: 'step' };
  const { back, bytes } = await roundTrip(s);
  assert.deepEqual(back.components.find((c) => c.name === 'sub')?.external, { uri: 'sub.stp', format: 'step' });
  assert.deepEqual(await bindProblems(bytes), []);
});

test('ids: a source id two parts share is kept by the first, renumbered in the second, and styles follow', async () => {
  // Both parts the same cube model, so their faces' ids (21-26) collide; the plate's face 22 blue.
  const s = styled();
  s.parts[1] = { ...part('plate', cubeModel(), 301), material: 2, faceMaterials: [{ face: 22, material: 1 }] };
  const { back, text } = await roundTrip(s);
  assert.equal(text.match(/#21=ADVANCED_FACE\(/g)?.length, 1);
  sameLooks(s, back);
});

/** A mesh-only part: two faces with ids 7 and 8 and one without, a curve, two points. */
function meshPart(): Part {
  const lod: Lod = { from: 'source', linearDeflection: 0.2, angularDeflection: 0.5, mesh: {
    origin: [100, 0, 0],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 2, 0, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 1, 3, 1, 4, 2, 1, 5, 4]),
    faces: [{ source: 7, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }, { source: 7, start: 6, count: 3 },
      { source: null, start: 9, count: 3 }],
    curvePositions: new Float32Array([0, 0, 5, 1, 0, 5, 1, 1, 5]), curves: [{ source: 9, start: 0, count: 3 }],
    points: new Float32Array([3, 3, 3, 4, 4, 4]), pointSources: [10, 10],
  } };
  return { name: 'mesh', sources: [{ format: 'step', id: 50 }], properties: {}, origin: [100, 0, 0],
    lods: [lod] };
}

test('a part without a B-rep: AP242 tessellated geometry, its faces by id, curves and points, accuracy', async () => {
  const s = sceneOf({ parts: [meshPart()], rootParts: [{ part: 0, transform: identity() }] });
  const { back, text, bytes, diagnostics } = await roundTrip(s);
  assert.deepEqual(diagnostics, []);
  assert.match(text, /#7=TRIANGULATED_FACE\(/);
  assert.match(text, /#8=TRIANGULATED_FACE\(/);
  assert.match(text, /TESSELLATED_SHELL\('mesh',\(#7,#8,#\d+\),\$\)/);
  assert.match(text, /#9=TESSELLATED_CURVE_SET\(/);
  assert.match(text, /#10=TESSELLATED_POINT_SET\(/);
  assert.match(text, new RegExp(String.raw`TESSELLATED_SHAPE_REPRESENTATION_WITH_ACCURACY_PARAMETERS\('mesh',.*`
    + String.raw`\(CHORDAL_DEVIATION\(0\.2\),ANGULAR_DEVIATION\(0\.5\)\)\)`));
  // Positions with the origin: a corner at (100, 0, 0) + (2, 0, 0).
  assert.ok(text.includes('(102.,0.,0.)'));
  assert.deepEqual(await bindProblems(bytes), []);
  const l = back.parts[0]!.lods[0]!;
  assert.equal(l.linearDeflection, 0.2);
  assert.equal(l.angularDeflection, 0.5);
  const o = { linearDeflection: 0.2, angularDeflection: 0.5, curves: true };
  // The face without a source gets the written face's id; the rest compare exactly.
  const diffs = viewDifferences({ scene: s, view: exportView(s, o) }, { scene: back, view: exportView(back, o) });
  assert.equal(diffs.filter((d) => !/face -/.test(d)).length, 0, diffs.join('\n'));
  assert.deepEqual(viewDifferences({ scene: s, view: exportView(s, o) }, { scene: back, view: exportView(back, o) },
    { faceIds: false }), []);
  assert.deepEqual([...new Set(l.mesh.faces.map((f) => f.source))].slice(0, 2), [7, 8]);
});

test('a part without a B-rep in another unit: its positions and chordal deviation in it, read back the same',
  async () => {
  const s = sceneOf({ parts: [meshPart()], rootParts: [{ part: 0, transform: identity() }] });
  const { back, text, diagnostics } = await roundTrip(s, { unit: 25.4 });
  assert.deepEqual(diagnostics, []);
  // The tessellated representation's context (the file's only: a root part unmoved has no assembly) in inches, its
  // corner (102, 0, 0) mm and its deviation in them.
  assert.equal(text.match(/CONVERSION_BASED_UNIT\('INCH'/g)?.length, 1);
  assert.ok(text.includes(`(${real(102 / 25.4)},0.,0.)`), 'corner');
  assert.ok(text.includes(`CHORDAL_DEVIATION(${real(0.2 / 25.4)})`), 'deviation');
  const l = back.parts[0]!.lods[0]!;
  assert.ok(Math.abs(l.linearDeflection! - 0.2) < 1e-12);
  const m = back.parts[0]!.lods[0]!.mesh, src = s.parts[0]!.lods[0]!.mesh;
  // The same points, in millimetres (the origins added back; once each: the reader gives each face its own), to 1e-4.
  const world = (x: typeof m) => [...new Set(Array.from({ length: x.positions.length / 3 }, (_, v) => [0, 1, 2]
    .map((k) => (Math.round((x.positions[3 * v + k]! + x.origin[k]!) * 1e4) / 1e4 + 0).toFixed(4)).join(' ')))]
    .sort();
  assert.deepEqual(world(m), world(src));
});

test('a closed mesh part as a TESSELLATED_SOLID; a mesh without face ranges as one face', async () => {
  const p = meshPart();
  p.closed = true;
  p.lods[0]!.mesh.faces = [];
  const s = sceneOf({ parts: [p], rootParts: [{ part: 0, transform: identity() }] });
  const { back, text } = await roundTrip(s);
  assert.match(text, /TESSELLATED_SOLID\('mesh',\(#\d+\),\$\)/);
  assert.equal(back.parts[0]!.closed, true);
  assert.equal(back.parts[0]!.lods[0]!.mesh.indices.length, 12);
});

test('meshes beside B-reps by option: the reader gets both, the mesh\'s faces as the B-rep\'s', async () => {
  const s = assembly();
  // The block's mesh: one triangle on face 21.
  const tri = (face: number) => ({ origin: [0, 0, 0] as [number, number, number],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
    faces: [{ source: face, start: 0, count: 3 }] });
  s.parts[0]!.lods = [{ from: 'source', mesh: tri(22) }, { from: 'tessellated', mesh: tri(21) }];
  const { back, text, bytes } = await roundTrip(s, { meshes: true });
  const block = back.parts.find((q) => q.name === 'block')!;
  assert.ok(block.brep);
  assert.equal(block.lods.length, 1);
  assert.deepEqual(block.lods[0]!.mesh.faces.map((f) => f.source), [21]);
  assert.match(text, /TRIANGULATED_FACE\('',#\d+,3,\(\),#21,\(\),/);
  assert.deepEqual(await bindProblems(bytes), []);
  // Without the option, none.
  assert.doesNotMatch((await roundTrip(s)).text, /TRIANGULATED_FACE/);
});

test('AP214: its schema; a component\'s colour as overrides; mesh-only parts left out with a warning', async () => {
  const s = styled();
  s.materials.push({ color: [0.5, 0.5, 0.5], opacity: 1, sources: [] });
  s.components[1]!.material = 4;
  s.parts.push(meshPart());
  s.components[0]!.parts.push({ part: 2, transform: identity() });
  s.parts[1] = { ...part('plate', cubeModel(1000, 25.4), 301), material: 2 };
  const { text, back, bytes, diagnostics } = await roundTrip(s, { schema: 'ap214' });
  assert.match(text, new RegExp(`FILE_SCHEMA\\(\\('${AP214_SCHEMA.replace(/[{}]/g, '\\$&')}'\\)\\)`));
  assert.match(text, /APPLICATION_PROTOCOL_DEFINITION\('international standard','automotive_design'/);
  assert.match(diagnostics.map((d) => d.message).join('\n'), /part 2 \(mesh\).*AP214 has no tessellated geometry/);
  assert.doesNotMatch(text, /TRIANGULATED_FACE/);
  assert.deepEqual(await bindProblems(bytes), []);
  // What the AP242 file shows, without the mesh part.
  s.components[0]!.parts.pop();
  sameLooks(s, back);
});

test('AP242: a component\'s colour on its representation', async () => {
  const s = styled();
  s.materials.push({ color: [0.5, 0.5, 0.5], opacity: 1, sources: [] });
  s.components[1]!.material = 4;
  const { back, bytes } = await roundTrip(s);
  sameLooks(s, back);
  assert.deepEqual(await bindProblems(bytes), []);
});

test('a scene from a mesh format: named references, a part placed twice in a component, as placed products',
  async () => {
    const s = sceneOf({ parts: [meshPart()], components: [component('asm', { parts: [
      { part: 0, transform: identity(), name: 'm_1' }, { part: 0, transform: translate(10, 0, 0), name: 'm_2' }] })],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }] });
    const { back } = await roundTrip(s);
    assert.deepEqual([...partInstances(back)].map((i) => i.ref.name), ['m_1', 'm_2']);
    assert.ok(near([...partInstances(back)][1]!.transform, translate(10, 0, 0)));
  });

test('the unit written: the source\'s by default, else the one asked for; every length in it, read back the same',
  async () => {
  const s = assembly();
  // A cube 25.4 mm (an inch) on a side, placed 7 mm along.
  s.parts[1] = part('plate', cubeModel(1000, 25.4), 301);
  s.components[0]!.parts[0]!.transform = translate(7, 0, 0);
  for (const [unit, name] of [[undefined, 'INCH'], [1, '.MILLI.'], [1000, '$,.METRE.'], [304.8, 'FOOT']] as const) {
    const { back, diagnostics, text } = await roundTrip(s, unit === undefined ? {} : { unit });
    assert.deepEqual(diagnostics, [], `${unit}`);
    sameLooks(s, back);
    assert.equal(back.sourceUnit, unit ?? 25.4);
    assert.ok(text.includes(name), `${unit}: ${name}`);
    // The plate's far corner, (1, 1, 1) inches, in the unit written; the placement's 7 mm likewise.
    const k = 25.4 / (unit ?? 25.4);
    assert.ok(text.includes(`CARTESIAN_POINT('',(${[k, k, k].map(real).join(',')}))`), `${unit}: corner`);
    assert.ok(text.includes(`CARTESIAN_POINT('',(${[7 / (unit ?? 25.4), 0, 0].map(real).join(',')}))`),
      `${unit}: placement`);
    // Each part's geometry read back in millimetres: its vertices where they were.
    const plate = back.parts.find((p) => p.name === 'plate')!.brep!.model;
    const far = Math.max(...plate.vertex.point);
    assert.ok(Math.abs(far - 25.4) < 1e-12, `${unit}: ${far}`);
  }
  // A source unit within 1e-9 of a named one written as that (a file's inches, from 0.0254 m, are 25.400000000000002).
  const t = assembly();
  t.sourceUnit = 25.400000000000002;
  assert.ok((await roundTrip(t)).text.includes("CONVERSION_BASED_UNIT('INCH'"));
  assert.throws(() => exportStep(s, { unit: 0 }), /unit 0/);
});

test('a part whose every reference has the same colour: that colour as the part\'s style, no override', async () => {
  const s = styled();
  s.parts[0]!.material = undefined;
  s.parts[0]!.faceMaterials = undefined;
  s.components[1]!.parts[0]!.material = 3;
  const { text, back } = await roundTrip(s);
  assert.doesNotMatch(text, /CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM/);
  assert.match(text, /COLOUR_RGB\('',1\.,1\.,0\.\)/);
  sameLooks(s, back);
});

test("an override of a component's own part reference (no product): the reference written as a placed product",
  async () => {
    const s = styled();
    s.components[0]!.parts[0]!.visible = undefined;
    s.overrides = [{ path: [0], ref: 0, material: 3, sources: [] }, { path: [0], ref: 0, visible: false, sources: [] }];
    const { back, diagnostics } = await roundTrip(s);
    assert.deepEqual(diagnostics, []);
    sameLooks(s, back);
  });

test("a geometric set's part: its colour on the set's elements (a set's style isn't its elements' to OCCT)",
  async () => {
    const b = new BrepBuilder();
    const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
    b.addItem({ kind: 'surface', ref: b.addSurface({ kind: 'plane', position, id: 40 }) });
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'circle', position, radius: 1, id: 41 }) });
    const s = sceneOf({ parts: [{ ...part('set', b.finish(), 30), material: 0 }],
      materials: [{ color: [1, 0, 0], opacity: 1, sources: [] }], rootParts: [{ part: 0, transform: identity() }] });
    const { text } = await roundTrip(s);
    assert.match(text, /STYLED_ITEM\('color',\(#\d+\),#40\)/);
    // An element with a colour of its own styled once, with that.
    s.materials.push({ color: [0, 0, 1], opacity: 1, sources: [] });
    s.parts[0]!.faceMaterials = [{ face: 40, material: 1 }];
    const own = await roundTrip(s);
    assert.equal(own.text.match(/STYLED_ITEM\('color',\(#\d+\),#40\)/g)?.length, 1);
    sameLooks(s, own.back);
    assert.match(text, /STYLED_ITEM\('color',\(#\d+\),#41\)/);
    const set = /#(\d+)=GEOMETRIC_SET\(/.exec(text)![1];
    assert.doesNotMatch(text, new RegExp(`STYLED_ITEM\\('color',\\(#\\d+\\),#${set}\\)`));
  });

test("a sheet's part: its colour on its surface model and on each face without its own (OCCT passes only a solid's "
  + 'down)', async () => {
  const b = new BrepBuilder();
  const sheet = b.addBody({ kind: 'sheet', members: [{ ref: box(b, [1, 1, 1]), sense: true }], id: 100 });
  b.addItem({ kind: 'body', ref: sheet, id: 101 });
  const s = sceneOf({ parts: [{ ...part('sheet', b.finish(), 30), material: 0, faceMaterials: [{ face: 22,
    material: 1 }] }], materials: [{ color: [1, 0, 0], opacity: 1, sources: [] },
    { color: [0, 0, 1], opacity: 1, sources: [] }], rootParts: [{ part: 0, transform: identity() }] });
  const { text, back } = await roundTrip(s);
  for (const f of [21, 22, 23, 24, 25, 26]) {
    assert.equal(text.match(new RegExp(`STYLED_ITEM\\('color',\\(#\\d+\\),#${f}\\)`, 'g'))?.length, 1, `face ${f}`);
  }
  assert.match(text, /STYLED_ITEM\('color',\(#\d+\),#100\)/);
  sameLooks(s, back);
});

test('a face used both ways (two sheets, one using it reversed): written twice, both copies styled and layered',
  async () => {
  const b = new BrepBuilder();
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point, k) => b.addVertex({ point, id: 1 + k }));
  const coedges = corners.map((p, k) => {
    const q = corners[(k + 1) % 4]!;
    const line = b.addCurve({ kind: 'line', point: p, direction: q.map((x, j) => x - p[j]!), magnitude: 1 });
    return { edge: b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, id: 5 + k }),
      orientation: 'forward' as const };
  });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] } }), sameSense: true, id: 10, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
  for (const sense of [true, false]) {
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  }
  const s = sceneOf({ parts: [{ ...part('sheets', b.finish(), 300), faceMaterials: [{ face: 10, material: 0 }] }],
    materials: [{ color: [0, 0, 1], opacity: 1, sources: [] }] });
  s.components = [component('top', { parts: [{ part: 0, transform: identity() }] })];
  s.roots = [{ component: 0, transform: identity(), sources: [], properties: {} }];
  s.layers = [{ name: 'L', visible: true, parts: [], faces: [{ part: 0, face: 10 }], sources: [] }];
  const { text, back, bytes, all } = await roundTrip(s);
  const faces = [...text.matchAll(/#(\d+)=ADVANCED_FACE\('',\(#\d+\),#\d+,\.([TF])\.\)/g)].map((m) => [+m[1]!, m[2]]);
  assert.deepEqual(faces.map(([, sense]) => sense), ['T', 'F']);
  assert.equal(faces[0]![0], 10);
  for (const [id] of faces) assert.match(text, new RegExp(`STYLED_ITEM\\('color',\\(#\\d+\\),#${id}\\)`));
  assert.match(text, new RegExp(`PRESENTATION_LAYER_ASSIGNMENT\\('L','',\\(#10,#${faces[1]![0]}\\)\\)`));
  assert.ok(all.some((d) => /a face used both ways/.test(d.message)));
  assert.deepEqual(await bindProblems(bytes), []);
  // Read back: two faces, both blue (by their own colour or, every face's being one, the part's), both in the layer.
  const p = back.parts[0]!, model = p.brep!.model;
  const ids = Array.from({ length: rowCount(model, 'face') }, (_, k) => decode.face(model, k).id!);
  assert.deepEqual(ids, [10, faces[1]![0]]);
  for (const id of ids) {
    const m = p.faceMaterials?.find((f) => f.face === id)?.material ?? p.material;
    assert.deepEqual(back.materials[m!]?.color, [0, 0, 1], `face #${id}`);
  }
  assert.deepEqual(back.layers[0]!.faces.map((f) => f.face).sort((x, y) => x - y), [10, faces[1]![0]]);
});

test('a mesh\'s edges as the tessellation practice has them: connecting edges between faces, the rest plain; read '
  + 'back with their ids and points', async () => {
  // Faces 7 (corners 0, 1, 2 and 1, 4, 2), 8 (0, 1, 3) and one without an id (1, 5, 4): 21 between 7 and 8, 22 between
  // 7 and the unnamed, 23 on 7's free boundary, 24 a seam on 7, 25 degenerate at corner 3, 26 on no face.
  const p = meshPart(), mesh = p.lods[0]!.mesh;
  const corner = (v: number) => Array.from(mesh.positions.subarray(3 * v, 3 * v + 3));
  const runs: [number, 'shared' | 'seam' | 'free' | 'degenerate', number[][]][] = [
    [21, 'shared', [corner(0), corner(1)]], [22, 'shared', [corner(1), corner(4)]],
    [23, 'free', [corner(0), corner(2)]], [24, 'seam', [corner(2), corner(4)]],
    [25, 'degenerate', [corner(3), corner(3)]], [26, 'free', [[5, 5, 5], [6, 6, 6]]]];
  mesh.edgePositions = Float32Array.from(runs.flatMap(([, , pts]) => pts.flat()));
  mesh.edges = runs.map(([source, kind], k) => ({ source, kind, start: 2 * k, count: 2,
    ...(kind === 'shared' ? { dihedral: 0.5 } : {}) }));
  const s = sceneOf({ parts: [p], rootParts: [{ part: 0, transform: identity() }] });
  const { back, text, bytes, diagnostics } = await roundTrip(s);
  assert.deepEqual(diagnostics, []);
  for (const id of [21, 22, 24]) assert.match(text, new RegExp(`#${id}=TESSELLATED_CONNECTING_EDGE\\('',#\\d+,\\$,`));
  for (const id of [23, 25, 26]) assert.match(text, new RegExp(`#${id}=TESSELLATED_EDGE\\('',#\\d+,\\$,`));
  // Between 7 and 8, on 7's list (its first face's), unknown smoothness.
  assert.match(text, /#21=TESSELLATED_CONNECTING_EDGE\('',#\d+,\$,\(\d+,\d+\),\.U\.,#7,#8,\(\d+,\d+\),\(\d+,\d+\)\)/);
  // Each face's strip into its own list: 22's corners are 7's points 2 and 4, the unnamed face's 1 and 3.
  assert.match(text, /#22=TESSELLATED_CONNECTING_EDGE\('',#\d+,\$,\(2,4\),\.U\.,#7,#\d+,\(2,4\),\(1,3\)\)/);
  // A seam: its face twice.
  assert.match(text, /#24=TESSELLATED_CONNECTING_EDGE\('',#\d+,\$,\(\d+,\d+\),\.U\.,#7,#7,/);
  assert.match(text, /TESSELLATED_SHELL\('mesh',\(#7,#8,#\d+,#21,#22,#23,#24,#25,#26\),\$\)/);
  assert.deepEqual(await bindProblems(bytes), []);
  // Read back: each edge with its id and points, seams as shared and degenerate edges as free (STEP has no kinds for
  // them).
  const m = back.parts[0]!.lods[0]!.mesh;
  // (In the part's coordinates: each mesh has its own origin.)
  const placed = (xs: ArrayLike<number>, o: number[]) => Array.from(xs, (x, k) => x + o[k % 3]!);
  const got = (m.edges ?? []).map((e) => [e.source, e.kind,
    placed(m.edgePositions!.subarray(3 * e.start, 3 * (e.start + e.count)), m.origin)]);
  assert.deepEqual(got, runs.map(([source, kind, pts]) => [source,
    kind === 'seam' ? 'shared' : kind === 'degenerate' ? 'free' : kind, placed(pts.flat(), mesh.origin)]));
});
