import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { exportView, identity, partInstances, pruneView, scaling, tessellateScene, validate, viewDifferences,
  type ExportNode, type Mat4, type Mesh, type Scene } from 'cad-scene';
import { threemf, type ThreeMfOptions } from 'export-3mf';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { import3mf } from '../src/index.ts';
import { XmlTokenizer } from '../src/xml.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
/** 90 deg about z, then a translation: (x, y, z) -> (-y + tx, x, z). */
const turn = (tx: number): Mat4 => Float64Array.of(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1);

// The unit cube, each face (sources 10-15) with vertices of its own, counter-clockwise seen from outside.
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const QUADS = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
function cube(): Mesh {
  const positions: number[] = [], indices: number[] = [];
  const faces: Mesh['faces'] = [];
  QUADS.forEach((q, f) => {
    const base = positions.length / 3;
    for (const c of q) positions.push(...CORNERS[c]!);
    faces.push({ source: 10 + f, start: indices.length, count: 6 });
    for (const t of [[0, 1, 2], [0, 2, 3]]) indices.push(...t.map((k) => base + k));
  });
  return { origin: [1, 0, 0], positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces };
}
const sheet = (): Mesh => ({ origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3), faces: [{ source: 20, start: 0, count: 6 }] });

/**
 * An assembly: two instances of a subassembly holding the cube (inches, green, face 15 blue, half opaque red face
 * 11), the second turned; a sheet (open); a hidden cube. Materials: 0 red, 1 green, 2 blue.
 */
function source(): Scene {
  const occ = (component: number, t: Mat4, name: string) => ({ component, transform: t, sources: [], properties: {},
    name });
  const part = (name: string, unit: number, mesh: Mesh, closed: boolean) => ({ name, sources: [], properties: {},
    unit, origin: [0, 0, 0] as [number, number, number], lods: [{ mesh, from: 'tessellated' as const }], closed });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [{ part: 1, transform: translation(0, 0, -10) },
        { part: 0, transform: scaling(25.4), visible: false }],
      children: [occ(1, translation(100, 0, 0), 'left'), occ(1, turn(200), 'right')] },
      { name: 'sub', sources: [], properties: {}, parts: [{ part: 0, transform: scaling(25.4) }], children: [] },
    ],
    roots: [occ(0, translation(0, 0, 5), 'top')],
    parts: [{ ...part('cube', 25.4, cube(), true), material: 1, faceMaterials: [{ face: 15, material: 2 },
      { face: 11, material: 0 }] }, part('sheet', 1, sheet(), false)],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.6, sources: [] },
      { name: 'green', color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [], overrides: [], properties: {}, diagnostics: [],
  };
}

interface Drawn { pts: number[]; colour: string }
/** Every visible placed triangle in the world with its colour (8-bit, alpha), degenerate ones left out. */
function drawn(scene: Scene, { opaque = false } = {}): Drawn[] {
  const out: Drawn[] = [];
  for (const pi of partInstances(scene)) {
    if (!pi.visible) continue;
    const mesh = scene.parts[pi.part]!.lods[0]?.mesh;
    if (!mesh) continue;
    const m = pi.transform, o = mesh.origin, p = mesh.positions;
    for (const f of mesh.faces) {
      const mi = (f.source === null ? undefined : pi.faceMaterials.get(f.source)) ?? pi.material;
      const mat = mi === undefined ? undefined : scene.materials[mi]!;
      const colour = mat ? [...mat.color, opaque ? 1 : mat.opacity].map((c) => Math.round(c * 255)).join(',')
        : 'none';
      for (let i = f.start; i < f.start + f.count; i += 3) {
        const pts = [0, 1, 2].flatMap((k) => {
          const v = mesh.indices[i + k]!, x = p[3 * v]! + o[0], y = p[3 * v + 1]! + o[1], z = p[3 * v + 2]! + o[2];
          return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
            m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        });
        out.push({ pts, colour });
      }
    }
  }
  return out;
}
/** Triangles as sorted text, each from its least corner (winding kept), to 1e-4 mm. */
const canonical = (d: Drawn[]) => d.map(({ pts, colour }) => {
  const corners = [0, 1, 2].map((k) => pts.slice(3 * k, 3 * k + 3).map((x) => (Math.round(x * 1e4) / 1e4 + 0)
    .toFixed(4)).join(' '));
  const first = corners.indexOf([...corners].sort()[0]!);
  return `${[0, 1, 2].map((k) => corners[(first + k) % 3]).join(' | ')} ${colour}`;
}).sort();

const bytesOf = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const exported = (s: Scene, o: ThreeMfOptions) => bytesOf(threemf(s, exportView(s), o).chunks);

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/'
  + '2006/content-types"><Default Extension="model" '
  + 'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/'
  + '3dmodel"/></Relationships>';
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
  + 'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" '
  + 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
/** A package of the given model parts (by path), with the usual relationships unless `rels` is false. */
function pack(parts: Record<string, string>, { rels = true, level = 6 as 0 | 6 } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = { '[Content_Types].xml': strToU8(CONTENT_TYPES) };
  if (rels) files['_rels/.rels'] = strToU8(RELS);
  for (const [path, text] of Object.entries(parts)) files[path] = strToU8(text);
  return zipSync(files, { level });
}
const model = (body: string, attrs = 'unit="millimeter"') => `<?xml version="1.0" encoding="UTF-8"?>\n<model ${attrs} ${
  NS}>${body}</model>`;
/** A mesh object's XML: vertices, then triangles (each `a b c` and optional attributes). */
const mesh = (id: number, attrs: string, vertices: number[][], triangles: (number[] | string)[]) => `<object id="${id}"`
  + ` ${attrs}><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}`
  + `</vertices><triangles>${triangles.map((t) => typeof t === 'string' ? t
    : `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object>`;
/** The unit cube with 8 shared vertices, 12 triangles wound outward. */
const SHARED_CUBE: [number[][], number[][]] = [CORNERS, QUADS.flatMap(([a, b, c, d]) => [[a!, b!, c!], [a!, c!, d!]])];
/**
 * A zip rewritten in zip64 form: every entry's sizes and offset in its zip64 extra field (the 32-bit ones all ones),
 * then a zip64 end record and locator before the end record, whose counts and offset are all ones.
 */
function zip64(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true), cdOffset = view.getUint32(eocd + 16, true);
  const central: number[] = [];
  let at = cdOffset;
  for (let k = 0; k < count; k++) {
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true);
    const fixed = Array.from(zip.subarray(at, at + 46 + nameLength));
    const csize = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const local = view.getUint32(at + 42, true);
    for (const o of [20, 24, 42]) fixed.splice(o, 4, 255, 255, 255, 255);
    fixed.splice(30, 2, 28, 0); // the extra field: 4 + 24 bytes
    const u64 = (x: number) => [0, 1, 2, 3, 4, 5, 6, 7].map((b) => Math.floor(x / 2 ** (8 * b)) & 255);
    central.push(...fixed, 1, 0, 24, 0, ...u64(size), ...u64(csize), ...u64(local));
    at += 46 + nameLength + extraLength + view.getUint16(at + 32, true);
  }
  const u16 = (x: number) => [x & 255, x >> 8], u32 = (x: number) => [0, 1, 2, 3].map((b) => (x >>> (8 * b)) & 255);
  const u64 = (x: number) => [...u32(x), 0, 0, 0, 0];
  const recordAt = cdOffset + central.length;
  const record = [...u32(0x06064b50), ...u64(44), ...u16(45), ...u16(45), ...u32(0), ...u32(0), ...u64(count),
    ...u64(count), ...u64(central.length), ...u64(cdOffset)];
  const locator = [...u32(0x07064b50), ...u32(0), ...u64(recordAt), ...u32(1)];
  const end = [...u32(0x06054b50), 0, 0, 0, 0, 255, 255, 255, 255, ...u32(0xffffffff), ...u32(0xffffffff), 0, 0];
  return Uint8Array.from([...zip.subarray(0, cdOffset), ...central, ...record, ...locator, ...end]);
}
const messages = (r: { diagnostics: { severity: string; message: string }[] }) => r.diagnostics.map(
  (d) => `${d.severity}: ${d.message}`);

for (const [label, opts] of [['an item per placed part, basematerials', {}],
  ['the assembly as components', { build: 'assembly' }], ['colorgroup', { colors: 'colorgroup' }],
  ['surfaces written', { nonManifold: 'surface' }]] as [string, ThreeMfOptions][]) {
  test(`our 3MF (${label}): the same triangles and colours in the world`, () => {
    const s = source();
    const back = import3mf(exported(s, opts));
    assert.deepEqual(messages(back), []);
    assert.deepEqual(validate(back.scene), []);
    const opaque = opts.colors === 'colorgroup';
    // The sheet is open, so written only as a surface.
    const sheetLeftOut = opts.nonManifold !== 'surface';
    const expected = drawn(sheetLeftOut ? { ...s, parts: [s.parts[0]!, { ...s.parts[1]!, lods: [] }] } : s,
      { opaque });
    // Faces without a material are written in the exporter's default grey.
    assert.deepEqual(canonical(drawn(back.scene)), canonical(expected).map((t) => t.replace(/none$/,
      '204,204,204,255')));
    // Parts: the cube, closed, its faces by colour (green, blue, red); the sheet, if written, open.
    const cubePart = back.scene.parts.find((p) => p.name === 'cube')!;
    assert.equal(cubePart.closed, true);
    assert.equal(cubePart.unit, 1);
    const faces = cubePart.lods[0]!.mesh.faces;
    assert.deepEqual(faces.map((f) => f.source), [0, 1, 2]);
    assert.deepEqual(faces.map((f) => f.count / 3).sort(), [2, 2, 8]);
    assert.equal(back.scene.parts.find((p) => p.name === 'sheet')?.closed, sheetLeftOut ? undefined : false);
    if (opts.build === 'assembly') {
      // Our exporter names its component objects after the tree's nodes.
      assert.deepEqual(back.scene.components.map((c) => c.name).sort(), ['left', 'right', 'top']);
      assert.equal(back.scene.roots.length, 1);
    } else assert.deepEqual(back.scene.components.map((c) => c.name), ['build']);
  });
}

test('normals: sharp at a cube\'s edges, smooth around a 24-sided prism, by the crease angle', () => {
  const sides = 24, ring: number[][] = [];
  for (let k = 0; k < sides; k++) {
    const a = (2 * Math.PI * k) / sides;
    ring.push([Math.cos(a), Math.sin(a), 0], [Math.cos(a), Math.sin(a), 1]);
  }
  const wall = Array.from({ length: sides }, (_, k) => {
    const [a, b, c, d] = [2 * k, 2 * ((k + 1) % sides), 2 * ((k + 1) % sides) + 1, 2 * k + 1];
    return [[a, b, c], [a, c, d]];
  }).flat();
  const r = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(1, 'name="cube"', ...SHARED_CUBE)}`
    + `${mesh(2, 'name="tube" type="surface"', ring, wall)}</resources><build><item objectid="1"/>`
    + '<item objectid="2"/></build>') }));
  assert.deepEqual(messages(r), []);
  const [box, tube] = r.scene.parts.map((p) => p.lods[0]!.mesh);
  // The cube: 24 vertices, each normal along an axis, the triangle's own.
  assert.equal(box!.positions.length / 3, 24);
  for (let t = 0; t < 12; t++) {
    const n = [0, 1, 2].map((k) => Array.from(box!.normals!.subarray(3 * box!.indices[3 * t + k]!,
      3 * box!.indices[3 * t + k]! + 3)));
    assert.ok(n.every((x) => JSON.stringify(x) === JSON.stringify(n[0])), `triangle ${t}'s corners agree`);
    assert.equal(n[0]!.map(Math.abs).sort().join(), '0,0,1');
  }
  // The tube: its 48 vertices shared, each normal radial (15 degrees between sides, under 30).
  assert.equal(tube!.positions.length / 3, 48);
  for (let v = 0; v < 48; v++) {
    const [x, y] = [tube!.positions[3 * v]! + tube!.origin[0], tube!.positions[3 * v + 1]! + tube!.origin[1]];
    const n = tube!.normals!;
    assert.ok(Math.abs(n[3 * v]! - x) < 1e-6 && Math.abs(n[3 * v + 1]! - y) < 1e-6 && n[3 * v + 2] === 0, `${v}`);
  }
  // A crease angle under 15 degrees makes the tube's sides flat.
  const flat = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(2, '', ring, wall)}</resources><build>`
    + '<item objectid="2"/></build>') }), { creaseAngle: (10 * Math.PI) / 180 });
  assert.equal(flat.scene.parts[0]!.lods[0]!.mesh.positions.length / 3, 4 * sides);

  // A writer giving each triangle vertices of its own: smooth all the same (vertices at one position are one).
  const own = wall.flatMap((x) => x.map((k) => ring[k]!));
  const apart = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(2, '', own, own.map((_, k) => k)
    .filter((k) => k % 3 === 0).map((k) => [k, k + 1, k + 2]))}</resources><build><item objectid="2"/></build>`) }));
  const am = apart.scene.parts[0]!.lods[0]!.mesh;
  for (let k = 0; k < am.positions.length / 3; k++) {
    const [x, y] = [am.positions[3 * k]! + am.origin[0], am.positions[3 * k + 1]! + am.origin[1]];
    assert.ok(Math.abs(am.normals![3 * k]! - x) < 1e-6 && Math.abs(am.normals![3 * k + 1]! - y) < 1e-6, `${k}`);
  }

  // A degenerate triangle (three distinct corners in a line) takes each vertex's whole smooth normal.
  const mid = ring.length;
  const thin = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(2, '', [...ring, [1, 0, 0.5]],
    [...wall, [0, mid, 1]])}</resources><build><item objectid="2"/></build>`) }));
  const tm = thin.scene.parts[0]!.lods[0]!.mesh;
  const last = tm.indices.length - 3;
  assert.deepEqual([0, 2].map((k) => Array.from(tm.normals!.subarray(3 * tm.indices[last + k]!,
    3 * tm.indices[last + k]! + 3)).map((x) => Math.round(x * 1e6) / 1e6 + 0)), [[1, 0, 0], [1, 0, 0]]);
});

test('colours: faces by colour wherever their triangles are, per-triangle properties, alpha, closed by type', () => {
  const [v, t] = SHARED_CUBE;
  // Triangles 0-11: the object's colour (group 1, entry 0) unless p1 says, interleaved; one blends its corners.
  const tris = t.map((x, i) => i % 3 === 1 ? `<triangle v1="${x[0]}" v2="${x[1]}" v3="${x[2]}" p1="1"/>`
    : i === 5 ? `<triangle v1="${x[0]}" v2="${x[1]}" v3="${x[2]}" pid="2" p1="0" p2="1"/>` : x);
  const r = import3mf(pack({ '3D/3dmodel.model': model('<metadata name="Title">Colours &amp; things</metadata>'
    + '<resources><basematerials id="1"><base name="steel" displaycolor="#808080"/>'
    + '<base name="glass" displaycolor="#0000FF80"/></basematerials>'
    + '<m:colorgroup id="2"><m:color color="#FF0000"/><m:color color="#00FF00"/></m:colorgroup>'
    + `${mesh(3, 'name="box" pid="1" pindex="0" partnumber="B-1" p:UUID="u-3"', v, tris)}`
    + `${mesh(4, 'name="other" type="other"', v, t)}</resources>`
    + '<build><item objectid="3"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build>') }));
  assert.deepEqual(messages(r), ['info: 3D/3dmodel.model: object 3: 1 triangles with a property per corner: each '
    + 'given its first corner\'s']);
  const box = r.scene.parts[0]!;
  assert.deepEqual(box.lods[0]!.mesh.faces.map((f) => [f.source, f.count / 3]), [[0, 7], [1, 4], [2, 1]]);
  assert.deepEqual(r.scene.materials.map((m) => [m.name, m.color.map((c) => Math.round(c * 255)).join(),
    Math.round(m.opacity * 255)]), [['steel', '128,128,128', 255], ['glass', '0,0,255', 128],
    [undefined, '255,0,0', 255]]);
  assert.equal(box.material, 0);
  assert.deepEqual(box.faceMaterials, [{ face: 1, material: 1 }, { face: 2, material: 2 }]);
  assert.deepEqual(box.properties, { type: 'model', partNumber: 'B-1', uuid: 'u-3' });
  assert.equal(box.closed, true);
  assert.equal(r.scene.parts[1]!.closed, undefined);
  assert.equal(r.scene.components[0]!.name, 'Colours & things');
  assert.deepEqual(r.scene.properties, { format: '3mf', unit: 'millimeter',
    metadata: { Title: 'Colours & things' } });
  // Every triangle's world colour, against a hand count: 7 grey, 4 translucent blue, 1 red; the other object none.
  const count = new Map<string, number>();
  for (const d of drawn(r.scene)) count.set(d.colour, (count.get(d.colour) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(count), { '128,128,128,255': 7, '0,0,255,128': 4, '255,0,0,255': 1,
    none: 12 });
  // And each triangle in its own colour (its face holds those triangles, not merely as many).
  const colourOf = (i: number) => i % 3 === 1 ? '0,0,255,128' : i === 5 ? '255,0,0,255' : '128,128,128,255';
  const want = t.map((x, i) => ({ pts: x.flatMap((k) => v[k]!), colour: colourOf(i) }));
  assert.deepEqual(canonical(drawn(r.scene).filter((d) => d.colour !== 'none')), canonical(want));
});

test('structure: a components object used twice, nested; the build of one item is the root; units', () => {
  const [v, t] = SHARED_CUBE;
  const r = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(1, 'name="cube"', v, t)}`
    + '<object id="2" name="pair"><metadatagroup><metadata name="x:kind">Assembly</metadata></metadatagroup>'
    + '<components><component objectid="1"/>'
    + '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></components></object>'
    + '<object id="3" name="top"><components><component objectid="2" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>'
    + '<component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 3"/></components></object>'
    + '</resources><build><item objectid="3" partnumber="T" transform="1 0 0 0 1 0 0 0 1 0 0 1"/></build>',
  'unit="centimeter" xml:lang="en"') }));
  assert.deepEqual(messages(r), []);
  assert.deepEqual(validate(r.scene), []);
  const { scene } = r;
  assert.deepEqual(scene.components.map((c) => [c.name, c.parts.length, c.children.length]), [['top', 0, 2],
    ['pair', 2, 0]]);
  assert.equal(scene.parts.length, 1);
  assert.equal(scene.parts[0]!.unit, 10);
  assert.deepEqual(scene.roots.map((o) => [o.name, o.properties]), [['top', { partNumber: 'T' }]]);
  assert.deepEqual(scene.components[1]!.properties, { type: 'model', metadata: { 'x:kind': 'Assembly' } });
  // The four cubes' lowest corners in the world, in millimetres: the row-vector transforms composed, then x 10.
  const corners = [...partInstances(scene)].map((pi) => {
    // Where the part's (0, 0, 0), the cube's corner, goes.
    const m = pi.transform;
    return [m[12]!, m[13]!, m[14]!].map((x) => Math.round(x * 1e6) / 1e6 + 0);
  });
  // `top` turns (x, y) -> (-y, x) for the first pair: (0, 0) and (2, 0) -> (0, 0) and (0, 20) mm; then up 1 cm.
  assert.deepEqual(corners, [[0, 0, 10], [0, 20, 10], [0, 0, 40], [20, 0, 40]]);
});

test('the Production extension: objects in other model parts, in their own unit; non-root paths refused', () => {
  const [v, t] = SHARED_CUBE;
  const r = import3mf(pack({
    '3D/3dmodel.model': model('<resources><object id="1" name="holder"><components>'
      + '<component objectid="7" p:path="/3D/Other%20Part.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>'
      + '<component objectid="9" p:path="/3D/Other%20Part.model"/>'
      + '<component objectid="8" p:path="/3D/missing.model"/></components></object></resources>'
      + '<build><item objectid="1"/><item objectid="7" p:path="/3D/Other%20Part.model"/></build>'),
    '3D/Other Part.model': model(`<resources>${mesh(7, 'name="inch cube"', v, t)}<object id="9" name="nested">`
      + '<components><component objectid="7" p:path="/3D/3dmodel.model"/><component objectid="7"/></components>'
      + '</object></resources><build><item objectid="7"/><item objectid="7"/></build>', 'unit="inch"'),
  }));
  assert.deepEqual(messages(r), ['warning: 3D/Other Part.model: a component referring to another model part '
    + '(/3D/3dmodel.model), which only the root model may do: skipped',
  'warning: model part /3D/missing.model is not in the package']);
  const { scene } = r;
  assert.deepEqual(scene.parts.map((p) => [p.name, p.unit, p.sources]), [['inch cube', 25.4,
    [{ format: '3mf:/3D/Other Part.model', id: 7 }]]]);
  // The holder's cube 10 mm along (the root's unit), the nested one's at 0; the build's other item, the same cube.
  const placed = [...partInstances(scene)].map((pi) => {
    const p = [0, 0, 0].map((_, k) => pi.transform[12 + k]! + [0, 1, 2].reduce((s, j) => s + pi.transform[4 * j + k]!
      * scene.parts[pi.part]!.lods[0]!.mesh.origin[j]!, 0));
    return [pi.transform[0], ...p.map((x) => Math.round(x * 1e6) / 1e6)];
  });
  // Each placement's cube centre: (0.5, 0.5, 0.5) inches, so 12.7 mm; the holder's 10 mm along. The build's item
  // first (the root's own part), then the holder's, then the nested one's.
  assert.deepEqual(placed, [[25.4, 12.7, 12.7, 12.7], [25.4, 22.7, 12.7, 12.7], [25.4, 12.7, 12.7, 12.7]]);
});

test('problems are diagnostics: indices, references, cycles, groups, extensions, units, XML', () => {
  const [v, t] = SHARED_CUBE;
  const r = import3mf(pack({ '3D/3dmodel.model': '<?xml version="1.0"?><!-- a comment, with > in it -->'
    + `<model unit="furlong" requiredextensions="b q" ${NS} xmlns:b="http://schemas.microsoft.com/3dmanufacturing/`
    + 'beamlattice/2017/02"><resources><m:texture2dgroup id="5" texid="9"><m:tex2coord u="0" v="0"/>'
    + '</m:texture2dgroup><m:texture2d id="9" path="/t.png"/>'
    + mesh(1, 'name="A &amp; &#x42;" pid="5" pindex="0"', [...v, [1, Number.NaN, 0]], [...t, [0, 0, 1],
      [0, 1, 99], [8, 1, 3], '<triangle v1="0" v2="1" v3="2" pid="6" p1="0"/>',
      '<triangle v1="1" v2="2" v3="3" pid="7" p1="4"/>'])
      .replace('</mesh>', '<b:beamlattice radius="1"><b:beams/></b:beamlattice></mesh>')
    + '<basematerials id="7"><base name="one" displaycolor="red"/></basematerials>'
    + '<object id="2"><components><component objectid="3"/><component objectid="42"/></components></object>'
    + '<object id="3"><components><component objectid="2"/><component objectid="1"/></components></object>'
    + '<object id="4" name="empty"><mesh><vertices/><triangles/></mesh></object>'
    + '<object id="1"><mesh/></object><object><mesh/></object>'
    + '</resources><build><item objectid="2" transform="1 2 3"/><item objectid="4"/><item objectid="66"/>'
    + '<item/></build></model>' }));
  const m = messages(r).map((x) => x.replace(/^(\w+): 3D\/3dmodel\.model: /, '$1: '));
  assert.deepEqual(m, [
    'warning: unknown unit \'furlong\': read as millimetres',
    'warning: the file requires the beam lattice extension, which isn\'t read: read without it',
    'warning: the file requires the extension \'q\' (an undeclared prefix), which isn\'t read: read without it',
    'warning: object 1: 1 vertices without three numbers, put at 0',
    'warning: object 1: 2 triangles without three distinct vertices of the mesh: left out',
    'warning: a base whose colour isn\'t #RRGGBB or #RRGGBBAA ("red"): grey',
    'warning: object 1 defined twice: the first kept',
    'warning: an object without a valid id: skipped',
    'warning: the build item of object 2\'s transform isn\'t 12 numbers ("1 2 3"): the identity',
    'warning: a build item without a valid objectid: skipped',
    'warning: textures are not supported: ignored (1 texture2dgroup element)',
    'warning: textures are not supported: ignored (1 texture2d element)',
    'warning: 1 <beamlattice> element of the beam lattice extension not read',
    'warning: a build item refers to object 66, which isn\'t defined: skipped',
    'warning: object 2 contains itself: the inner use skipped',
    'warning: colours from texture2dgroup 5 aren\'t read: no colour',
    'warning: property group 6 isn\'t defined: no colour',
    'warning: property group 7 has no entry 4: no colour',
    'warning: a component refers to object 42, which isn\'t defined: skipped',
    'warning: object 4 has no triangles',
  ]);
  assert.deepEqual(validate(r.scene), []);
  const a = r.scene.parts.find((p) => p.name === 'A & B')!;
  assert.equal(a.lods[0]!.mesh.indices.length / 3, 15);
  // The vertex without three numbers is at 0 where it isn't a number.
  assert.ok(a.lods[0]!.mesh.positions.every(Number.isFinite));
  assert.equal(a.material, undefined);
  assert.equal(a.faceMaterials, undefined);
});

test('packages: no relationships, stored entries, not a zip, no model', () => {
  const [v, t] = SHARED_CUBE;
  const body = model(`<resources>${mesh(1, '', v, t)}</resources><build><item objectid="1"/></build>`);
  const r = import3mf(pack({ '3D/3dmodel.model': body }, { rels: false, level: 0 }));
  assert.deepEqual(messages(r), ['warning: the package\'s relationships name no 3D model: 3D/3dmodel.model read']);
  assert.equal(r.scene.parts[0]!.lods[0]!.mesh.indices.length, 36);
  // Part names compare without case and percent-decoded, as OPC's do; a zip64 archive reads the same.
  const rels = RELS.replace('/3D/3dmodel.model', '/3D/My%20Model.MODEL');
  const odd = import3mf(zipSync({ '_rels/.rels': strToU8(rels), '3D/my model.model': strToU8(body) }));
  assert.deepEqual(messages(odd), []);
  const plain = pack({ '3D/3dmodel.model': body });
  assert.deepEqual(import3mf(zip64(plain)).scene, import3mf(plain).scene);
  assert.deepEqual(messages(import3mf(strToU8('solid cube\nendsolid'))),
    ['error: not a 3MF package: not a zip archive (no end of central directory)']);
  assert.deepEqual(messages(import3mf(pack({ 'other.txt': 'hi' }))).slice(-1),
    ['error: no model: the package\'s model part /3D/3dmodel.model could not be read']);
  assert.deepEqual(messages(import3mf(pack({ '3D/3dmodel.model': '<root/>' }))), [
    'error: 3D/3dmodel.model: no 3MF model in it (its root element isn\'t a core <model>)',
    'warning: 3D/3dmodel.model: 1 <root> element of no namespace not read',
    'warning: the build has no items: nothing to show']);
});

test('a large model part, inflated in many pieces, the same as read whole', () => {
  // A grid of 300 x 300 vertices, two triangles a square: some 6 MB of XML.
  const n = 300, vertices: number[][] = [], triangles: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) vertices.push([i, j, Math.sin(i / 7) * Math.cos(j / 5)]);
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < n; j++) {
    const a = i * n + j;
    triangles.push([a, a + n, a + 1], [a + 1, a + n, a + n + 1]);
  }
  const text = model(`<resources>${mesh(1, 'type="surface"', vertices, triangles)}</resources><build>`
    + '<item objectid="1"/></build>');
  assert.ok(text.length > 4 << 20);
  const deflated = import3mf(pack({ '3D/3dmodel.model': text }));
  const stored = import3mf(pack({ '3D/3dmodel.model': text }, { level: 0 }));
  assert.deepEqual(messages(deflated), []);
  const m = deflated.scene.parts[0]!.lods[0]!.mesh;
  assert.equal(m.indices.length / 3, 2 * (n - 1) ** 2);
  assert.deepEqual(m, stored.scene.parts[0]!.lods[0]!.mesh);
});

test('the tokenizer: the same events however the text is cut', () => {
  const doc = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "f">]><a x="1 &gt; 0" y=\'&#65;&#x42;\'>'
    + 'text &amp; more<!-- <b> --><![CDATA[<raw> & ]]><b/><c  z = "tab\there" ></c ><d:e xmlns:d="u" d:f="2"/></a>';
  const run = (pieces: string[]) => {
    const events: string[] = [];
    const t = new XmlTokenizer({ start: (n, a, e) => events.push(`<${n} ${a.join('=')}${e ? '/' : ''}>`),
      end: (n) => events.push(`</${n}>`), text: (s) => events.push(`'${s}'`), wantText: () => true,
      problem: (p) => events.push(`! ${p}`) });
    for (const p of pieces) t.feed(p);
    t.end();
    // Text may come in several calls: joined.
    return events.join('').replace(/''/g, '');
  };
  const whole = run([doc]);
  // (Empty elements have no end event: the handler is told they're empty.)
  assert.equal(whole, '! a document type declaration, ignored<a x=1 > 0=y=AB>\'text & more<raw> & \''
    + '<b /><c z=tab here></c><d:e xmlns:d=u=d:f=2/></a>');
  for (const size of [1, 2, 3, 7, 13]) {
    const pieces: string[] = [];
    for (let i = 0; i < doc.length; i += size) pieces.push(doc.slice(i, i + size));
    assert.equal(run(pieces), whole, `pieces of ${size}`);
  }
  // Malformed markup is said and skipped; reading goes on.
  assert.equal(run(['<a><b x=1/><c/></a>']), '<a >! malformed markup at character 3: "<b x=1/>"<c /></a>');
});

// Our files with extras (phase 2): the tree, components, placements, faces and colours as written.

/** What a 3MF of ours holds of a view: placements written (hidden ones only if kept), parts with triangles. */
const held = (s: Scene, o: ThreeMfOptions) => {
  const view = exportView(s);
  const keep = (p: ExportNode['parts'][number]) => (p.visible || o.hidden === 'keep')
    && view.looks[p.look]!.groups.length > 0
    && (o.nonManifold === 'surface' || s.parts[view.looks[p.look]!.part]!.closed !== false);
  // (pruneView leaves out nodes with nothing kept; the parts not kept, here.)
  const only = (n: ExportNode): ExportNode => ({ ...n, parts: n.parts.filter(keep), children: n.children.map(only) });
  return pruneView({ ...view, roots: view.roots.map(only) }, keep);
};
const placed = (sc: Scene) => [...partInstances(sc)].map((p) => `${sc.parts[p.part]!.name}${p.visible ? ''
  : ' (hidden)'}`).sort();

for (const hidden of ['omit', 'keep'] as const) {
  for (const recoloured of [0, 1]) {
    test(`our 3MF with extras, hidden ${hidden === 'omit' ? 'left out' : 'kept'}, instance ${recoloured} `
      + 'recoloured: the scene written', () => {
      const s = source();
      s.overrides = [{ path: [0, recoloured], material: 0, sources: [] }];
      const o: ThreeMfOptions = { extras: true, hidden };
      const back = import3mf(exported(s, o));
      assert.deepEqual(messages(back), []);
      assert.deepEqual(validate(back.scene), []);
      // Drawn the same, faces by their ids, colours by override where the source has one.
      assert.deepEqual(viewDifferences({ scene: s, view: held(s, o) }, { scene: back.scene,
        view: exportView(back.scene) }, { lines: false, skipHidden: hidden === 'omit' }), []);
      assert.deepEqual(back.scene.components.map((c) => c.name), ['asm', 'sub']);
      assert.deepEqual(back.scene.roots.map((r) => r.name), ['top']);
      assert.deepEqual(placed(back.scene), hidden === 'keep' ? ['cube', 'cube', 'cube (hidden)'] : ['cube', 'cube']);
      const cubePart = back.scene.parts.find((p) => p.name === 'cube')!;
      assert.equal(cubePart.closed, true);
      assert.deepEqual(cubePart.lods[0]!.mesh.faces.map((f) => f.source).sort(), [10, 11, 12, 13, 14, 15]);
      // The source's colours where the first placement is the part's own; else the recoloured one's, the other's
      // by override.
      if (recoloured === 1) {
        assert.equal(cubePart.material, 1);
        assert.deepEqual(cubePart.faceMaterials?.sort((x, y) => x.face - y.face), [{ face: 11, material: 0 },
          { face: 15, material: 2 }]);
      }
    });
  }
}

test('our 3MF with extras as components: read as written, with its faces', () => {
  const s = source();
  const back = import3mf(exported(s, { extras: true, build: 'assembly' }));
  assert.deepEqual(messages(back), []);
  const cubePart = back.scene.parts.find((p) => p.name === 'cube')!;
  assert.deepEqual(cubePart.lods[0]!.mesh.faces.map((f) => f.source).sort(), [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(viewDifferences({ scene: s, view: held(s, {}) }, { scene: back.scene,
    view: exportView(back.scene) }, { lines: false, skipHidden: true }), []);
});

test('our 3MF with extras as components: two roots (one named ""), a part without a material: as written', () => {
  const s = source();
  // A second root placing the subassembly again, named "", and the cube without a material of its own.
  s.roots.push({ component: 1, transform: translation(0, 500, 0), sources: [], properties: {}, name: '' });
  delete s.parts[0]!.material;
  for (const o of [{ extras: true, build: 'assembly' }, { extras: true }] as ThreeMfOptions[]) {
    const back = import3mf(exported(s, o));
    assert.deepEqual(messages(back), [], JSON.stringify(o));
    assert.deepEqual(viewDifferences({ scene: s, view: held(s, o) }, { scene: back.scene,
      view: exportView(back.scene) }, { lines: false, skipHidden: true }), [], JSON.stringify(o));
    assert.equal(back.scene.roots.length, 2);
  }
  // Without extras, the default colour is a colour, and the wrapper an object of its own.
  const plain = import3mf(exported(s, { build: 'assembly' }));
  assert.equal(plain.scene.roots.length, 1);
  assert.ok(plain.scene.materials.some((m) => m.name === 'default'));
});

test('our 3MF without extras: read as anyone\'s, the placed parts flat under the root', () => {
  const back = import3mf(exported(source(), {}));
  assert.deepEqual(back.scene.components.map((c) => [c.name, c.parts.length, c.children.length]), [['build', 2, 0]]);
  assert.deepEqual(back.scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source), [0, 1, 2]);
});

test('our faces that don\'t match the triangles: faces by colour, said', () => {
  const [v, t] = SHARED_CUBE;
  const r = import3mf(pack({ '3D/3dmodel.model': model(`<resources>${mesh(1, 'name="c"', v, t).replace('><mesh>',
    '><metadatagroup><metadata name="cadio:faces">[[7,5]]</metadata></metadatagroup><mesh>')}</resources>`
    + '<build><item objectid="1"/></build>') }));
  assert.deepEqual(messages(r), ['warning: 3D/3dmodel.model: object 1: our faces (cadio:faces) don\'t match its '
    + 'triangles: faces by colour']);
  assert.deepEqual(r.scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source), [0]);
});

const assembly = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
test('a STEP assembly through 3MF with extras and back: the same drawing, tree and faces',
  { skip: fs.existsSync(assembly) ? false : 'corpus not fetched' }, async () => {
    const { scene: s } = await importStep(fs.readFileSync(assembly));
    const occt = new OcctTessellator();
    await occt.init();
    await tessellateScene(s, occt);
    occt.dispose();
    for (const o of [{ extras: true, nonManifold: 'surface' }, { extras: true, nonManifold: 'surface',
      colors: 'colorgroup' }] as ThreeMfOptions[]) {
      const back = import3mf(exported(s, o));
      assert.deepEqual(messages(back), [], JSON.stringify(o));
      assert.deepEqual(validate(back.scene), []);
      // (colorgroup's colours are opaque: compared where the source's are.)
      if (s.materials.every((m) => m.opacity === 1) || !o.colors) assert.deepEqual(viewDifferences({ scene: s,
        view: held(s, o) }, { scene: back.scene, view: exportView(back.scene) }, { lines: false, skipHidden: true }),
      [], JSON.stringify(o));
      assert.deepEqual(back.scene.components.map((c) => c.name), s.components.map((c) => c.name));
      assert.deepEqual(placed(back.scene), placed(s).filter((p) => !p.endsWith('(hidden)')));
    }
  });

test('triangles with two corners at one position dropped, said; kept on request', () => {
  // A tetrahedron's four faces and a triangle whose third corner is vertex 4, at vertex 1's position.
  const bytes = pack({ '3D/3dmodel.model': model(`<resources>${mesh(1, 'type="model"',
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2], [0, 1, 4]])
  }</resources><build><item objectid="1"/></build>`) });
  const count = (r: { scene: Scene }) => r.scene.parts[0]!.lods[0]!.mesh.indices.length / 3;
  const info = (r: { diagnostics: { severity: string; message: string }[] }) => r.diagnostics.filter(
    (d) => d.severity === 'info').map((d) => d.message);
  const dropped = import3mf(bytes);
  assert.equal(count(dropped), 4);
  assert.deepEqual(info(dropped), ['1 degenerate triangle dropped (two corners at one position)']);
  const kept = import3mf(bytes, { dropDegenerate: false });
  assert.equal(count(kept), 5);
  assert.deepEqual(info(kept), []);
});

test('our 3MF with extras carries a part\'s measures, its level\'s settings and its unit back (an item per part)',
  () => {
  const s = source();
  const cube = s.parts[0]!;
  cube.measures = { by: 'OCCT test', faces: new Map([[10, { area: 1, perimeter: 4, valid: true }],
    [11, { area: 1.5, perimeter: 5, valid: false }]]) };
  Object.assign(cube.lods[0]!, { linearDeflection: 0.1, angularDeflection: 0.25, backend: 'OCCT test' });
  const back = import3mf(exported(s, { extras: true, nonManifold: 'surface' })).scene;
  const c = back.parts.find((p) => p.name === 'cube')!, sheet = back.parts.find((p) => p.name === 'sheet')!;
  assert.deepEqual(c.measures, cube.measures);
  assert.equal(c.unit, 25.4);
  assert.deepEqual([c.lods[0]!.linearDeflection, c.lods[0]!.angularDeflection, c.lods[0]!.backend],
    [0.1, 0.25, 'OCCT test']);
  // The sheet: no measures, millimetres, its level without settings.
  assert.deepEqual([sheet.measures, sheet.unit, sheet.lods[0]!.linearDeflection], [undefined, 1, undefined]);
});

test('the model\'s sphere in our tree metadata, read back as the file\'s; without extras from the meshes', () => {
  const s = source();
  s.bounds = { center: [1, 2, 3], radius: 9, from: 'meshes' };
  for (const o of [{ extras: true }, { extras: true, build: 'assembly' }] as ThreeMfOptions[]) {
    const back = import3mf(exported(s, o)).scene;
    assert.deepEqual(back.bounds, o.build ? { ...back.bounds, from: 'meshes' } : { center: [1, 2, 3], radius: 9,
      from: 'source' });
  }
  const plain = import3mf(exported(s, {})).scene;
  assert.equal(plain.bounds?.from, 'meshes');
  assert.ok(plain.parts.every((p) => p.lods.every((l) => l.mesh.box)));
});
