import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { exportView, identity, scaling, type Mat4, type Mesh, type Scene } from 'cad-scene';
import { float32Text, threemf, transformText, xmlText, type ThreeMfOptions } from '../src/index.ts';
import { OBJECT_TYPE, read3mf, type Read3mf } from './read3mf.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
/** 90° about z, then a translation: (x, y, z) → (−y + tx, x, z). */
const turn = (tx: number): Mat4 => Float64Array.of(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1);

// The unit cube's corners and its faces, each counter-clockwise seen from outside.
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const QUADS = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];

/**
 * A unit cube as a tessellator gives it: each face (sources 10–15) with four vertices of its own, so welding has
 * to join them; face 10's first vertex has a −0, and face 10 has a degenerate triangle (two corners at one position,
 * by distinct vertices), whose third corner, at the centre, no other triangle uses. `flip` turns triangles over (all, or those of the faces listed).
 */
function cube(flip: boolean | number[] = false): Mesh {
  const positions: number[] = [], indices: number[] = [];
  const faces: Mesh['faces'] = [];
  QUADS.forEach((q, f) => {
    const base = positions.length / 3;
    for (const c of q) positions.push(...CORNERS[c]!);
    const start = indices.length;
    const turned = flip === true || (Array.isArray(flip) && flip.includes(f));
    for (const t of [[0, 1, 2], [0, 2, 3]]) indices.push(...(turned ? [t[0]!, t[2]!, t[1]!] : t).map((k) => base + k));
    if (f === 0) {
      positions.push(0, 0, 0, 0.5, 0.5, 0.5);
      indices.push(base, base + 4, base + 5);
    }
    faces.push({ source: 10 + f, start, count: indices.length - start });
  });
  positions[0] = -0;
  return { origin: [1, 0, 0], positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces };
}
/** An open square: two triangles. */
const sheet = (): Mesh => ({
  origin: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  faces: [{ source: 20, start: 0, count: 6 }],
});

// An assembly: two instances of a subassembly holding the cube (in inches, green, face 15 blue; the second instance
// turned and, by override, 50% opaque red all over), a sheet, and a hidden cube. Materials: 0 red, 1 green, 2 blue.
function scene({ override = true } = {}): Scene {
  const occ = (component: number, t: Mat4, name?: string) => ({ component, transform: t, sources: [], properties: {}, ...(name ? { name } : {}) });
  const brep = (name: string, unit: number) => ({ kind: 'brep' as const, name, sources: [{ format: 'step', id: 50 }], properties: {}, unit, origin: [0, 0, 0] as [number, number, number], format: 'step' as const, payload: () => new Uint8Array() });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [], children: [occ(1, translation(100, 0, 0), 'left'), occ(1, turn(200)), occ(2, identity()), occ(3, identity())] },
      { name: 'sub', sources: [], properties: { partNumber: 'SUB-1' }, parts: [{ part: 0, transform: scaling(25.4) }], children: [] },
      { name: 'flat', sources: [], properties: {}, parts: [{ part: 1, transform: identity() }], children: [] },
      { name: 'hid', sources: [], properties: { partNumber: 'HID-1' }, parts: [{ part: 0, transform: identity(), visible: false }], children: [] },
    ],
    roots: [occ(0, identity())],
    parts: [{ ...brep('cube & co', 25.4), material: 1, faceMaterials: [{ face: 15, material: 2 }] }, brep('sheet', 1)],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] }, { name: 'green', color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: override ? [{ path: [0, 1], material: 0, sources: [] }] : [],
    properties: {},
    diagnostics: [],
  };
}
const meshes = () => new Map([[0, cube()], [1, sheet()]]);
const write = (s: Scene, opts: ThreeMfOptions = {}, m = meshes()) => threemf(s, exportView(s, m), opts);
const bytes = (chunks: Uint8Array[]) => Uint8Array.from(Buffer.concat(chunks));
const modelXml = (chunks: Uint8Array[]) => strFromU8(unzipSync(bytes(chunks))['3D/3dmodel.model']!);
const messages = (r: { diagnostics: { message: string }[] }) => r.diagnostics.map((d) => d.message);

/** A mesh's triangles as corner positions (rotated to start at the least, so orientation counts) with a colour. */
function triangleSet(read: Read3mf, id: number): string[] {
  const m = read.meshes.get(id)!;
  const out: string[] = [];
  for (let t = 0; t < m.triangles.length; t += 3) {
    const corners = [0, 1, 2].map((k) => m.positions.slice(3 * m.triangles[t + k]!, 3 * m.triangles[t + k]! + 3).join(','));
    const [group, property] = m.properties[t / 3]!;
    out.push(`${rotate(corners)} ${read.colors.get(group)!.get(property)!.color.join(',')}`);
  }
  return out.sort();
}
function rotate(corners: string[]): string {
  const k = corners.indexOf([...corners].sort()[0]!);
  return [...corners.slice(k), ...corners.slice(0, k)].join(' ');
}
/** The cube's triangles as they should come out: degenerate ones dropped, −0 as 0, in each face's colour. */
function expectedCube(colors: (face: number) => number[]): string[] {
  const c = cube();
  const out: string[] = [];
  for (const f of c.faces) {
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const corners = [0, 1, 2].map((k) => Array.from(c.positions.slice(3 * c.indices[t + k]!, 3 * c.indices[t + k]! + 3), (x) => x + 0).join(','));
      if (new Set(corners).size < 3) continue;
      out.push(`${rotate(corners)} ${colors(f.source!).join(',')}`);
    }
  }
  return out.sort();
}
/** lib3mf reads transforms as float32. */
const f32 = (m: number[]) => m.map(Math.fround);
const GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], RED = [255, 0, 0, 128];

test('parts build: valid; an item per placed part at its world transform, welded closed meshes, colours, names', async () => {
  const s = scene();
  const out = write(s, { name: 'model & more' });
  assert.deepEqual(messages(out), [
    "part 'sheet' is not a closed, oriented manifold (4 boundary edges, 2 triangles (a solid needs 4)); left out",
    '1 hidden part instance left out (3MF has no visibility)',
    '1 degenerate triangle dropped from 1 part mesh (two corners at one position)',
  ]);
  assert.deepEqual(out.diagnostics.map((d) => d.severity), ['warning', 'warning', 'info']);
  assert.deepEqual(out.diagnostics[0]!.source, { format: 'step', id: 50 });
  const r = await read3mf(bytes(out.chunks));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.unit, 1); // millimetre
  assert.equal(r.components.size, 0);
  // Two looks of the cube (green, and red by override), each a closed model of 8 welded vertices and 12 triangles.
  assert.equal(r.meshes.size, 2);
  for (const m of r.meshes.values()) {
    assert.deepEqual([m.name, m.partNumber, m.type, m.manifold, m.positions.length / 3, m.triangles.length / 3], ['cube & co', 'SUB-1', OBJECT_TYPE.model, true, 8, 12]);
    assert.deepEqual([...m.positions].sort(), CORNERS.flat().sort());
  }
  // Items: the two cube instances (the sheet open, the hidden one left out), at their world transforms.
  assert.equal(r.items.length, 2);
  const [left, right] = r.items;
  assert.deepEqual(left!.transform, f32([25.4, 0, 0, 0, 25.4, 0, 0, 0, 25.4, 125.4, 0, 0]));
  assert.deepEqual(right!.transform, f32([0, 25.4, 0, -25.4, 0, 0, 0, 0, 25.4, 200, 25.4, 0]));
  assert.deepEqual([left!.partNumber, right!.partNumber], ['0.0:0', '0.1:0']);
  assert.deepEqual(left!.metadata, [{ name: 'path', namespace: 'urn:cad-io-js:3mf', value: 'asm / left / cube & co' }]);
  assert.deepEqual(right!.metadata[0]!.value, 'asm / sub / cube & co');
  // Triangles with their colours: face 15 blue, the rest green; the overridden instance red at 50% all over.
  assert.deepEqual(triangleSet(r, left!.object), expectedCube((f) => (f === 15 ? BLUE : GREEN)));
  assert.deepEqual(triangleSet(r, right!.object), expectedCube(() => RED));
  // The objects' defaults are their largest groups', the group's bases named after the materials.
  assert.deepEqual(r.meshes.get(left!.object)!.property, [1, 1]);
  assert.deepEqual([...r.colors.get(1)!.values()].map((c) => c.name), ['green', '#0000FF', 'red']);
  const xml = modelXml(out.chunks);
  assert.match(xml, /<metadata name="Title">model &amp; more<\/metadata>/);
  assert.doesNotMatch(xml, /requiredextensions|xmlns:m=/);
});

test("an object's property is its largest group's; the others' triangles name theirs", async () => {
  // Face 10 blue too: the look's groups are blue (faces 10, first) and green (the 8 triangles of 4 faces), so the
  // default is green, the second.
  const s = scene({ override: false });
  s.parts[0]!.faceMaterials!.push({ face: 10, material: 2 });
  const out = write(s);
  const r = await read3mf(bytes(out.chunks));
  const m = r.meshes.get(r.items[0]!.object)!;
  assert.equal(r.colors.get(m.property![0])!.get(m.property![1])!.name, 'green');
  assert.deepEqual(triangleSet(r, r.items[0]!.object), expectedCube((f) => (f === 15 || f === 10 ? BLUE : GREEN)));
  // Each of the 4 blue triangles names its property, the green ones don't (one object, for both instances).
  assert.equal(modelXml(out.chunks).match(/ pid="1" p1="/g)!.length, 4);
});

test('assembly build: one item, components following the tree, identical subtrees shared', async () => {
  // Without the override and the first one's name the two subassembly instances are alike: one object for both.
  const alike = scene({ override: false });
  delete alike.components[0]!.children[0]!.name;
  let r = await read3mf(bytes(write(alike, { build: 'assembly' }).chunks));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.meshes.size, 1);
  const cubeId = [...r.meshes.keys()][0]!;
  assert.equal(r.items.length, 1);
  const top = r.components.get(r.items[0]!.object)!;
  assert.equal(r.items[0]!.transform, undefined);
  assert.equal(top.name, 'asm');
  // asm: the two sub instances (the sheet and the hidden cube left out, so their nodes have nothing).
  assert.deepEqual(top.components.map((c) => c.transform), [[1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 0, 0], [0, 1, 0, -1, 0, 0, 0, 0, 1, 200, 0, 0]]);
  assert.equal(top.components[0]!.object, top.components[1]!.object);
  const sub = r.components.get(top.components[0]!.object)!;
  assert.deepEqual(sub, { name: 'sub', components: [{ object: cubeId, transform: f32([25.4, 0, 0, 0, 25.4, 0, 0, 0, 25.4, 25.4, 0, 0]) }] });
  assert.equal(r.components.size, 2);

  // Named, two objects (an object has one name).
  r = await read3mf(bytes(write(scene({ override: false }), { build: 'assembly' }).chunks));
  assert.deepEqual([...r.components.values()].map((c) => c.name), ['left', 'sub', 'asm']);
  // With the override, two looks, so two sub objects; and with surfaces, the sheet's node too.
  r = await read3mf(bytes(write(scene(), { build: 'assembly', nonManifold: 'surface' }).chunks));
  assert.equal(r.meshes.size, 3);
  const asm = r.components.get(r.items[0]!.object)!;
  assert.equal(asm.components.length, 3);
  assert.notEqual(asm.components[0]!.object, asm.components[1]!.object);
  assert.equal(r.components.get(asm.components[2]!.object)!.name, 'flat');

  // Two roots: an object over both, named after the model.
  const two = alike;
  two.roots.push({ component: 1, transform: translation(0, 0, 5), sources: [], properties: {} });
  const out = write(two, { build: 'assembly', name: 'both' });
  r = await read3mf(bytes(out.chunks));
  assert.equal(r.items.length, 1);
  const both = r.components.get(r.items[0]!.object)!;
  assert.equal(both.name, 'both');
  assert.deepEqual(both.components.map((c) => c.transform), [undefined, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 5]]);
  // The second root is the subassembly alone: the same object as asm's children.
  assert.equal(both.components[1]!.object, r.components.get(both.components[0]!.object)!.components[0]!.object);
});

test('meshes that are not closed manifolds: left out, or written as surface objects', async () => {
  const s = scene();
  const out = write(s, { nonManifold: 'surface' });
  assert.equal(messages(out)[0], "part 'sheet' is not a closed, oriented manifold (4 boundary edges, 2 triangles (a solid needs 4)); written as a surface object");
  const r = await read3mf(bytes(out.chunks));
  assert.equal(r.items.length, 3);
  const flat = r.meshes.get(r.items[2]!.object)!;
  assert.deepEqual([flat.name, flat.type, flat.manifold, flat.triangles.length], ['sheet', OBJECT_TYPE.surface, false, 6]);
  // A cube with a face turned over: left out.
  const o = write(scene(), {}, new Map([[0, cube([2])], [1, sheet()]]));
  assert.equal(messages(o)[0], "part 'cube & co' is not a closed, oriented manifold (4 misoriented edges); left out");
  assert.equal((await read3mf(bytes(o.chunks))).items.length, 0);
  // One inside out, handed over as it is (tessellateScene would have turned it over): left out.
  const inside = write(scene(), {}, new Map([[0, cube(true)], [1, sheet()]]));
  assert.equal(messages(inside)[0], "part 'cube & co' is not a closed, oriented manifold (inside out (negative volume)); left out");
  assert.equal((await read3mf(bytes(inside.chunks))).items.length, 0);
});

test('colorgroup: the Materials extension, not required; colours opaque, with a warning', async () => {
  const out = write(scene(), { colors: 'colorgroup' });
  assert.equal(messages(out)[2], '1 transparent material written opaque (colorgroup colours are opaque)');
  const xml = modelXml(out.chunks);
  assert.match(xml, /xmlns:m="http:\/\/schemas.microsoft.com\/3dmanufacturing\/material\/2015\/02"/);
  assert.doesNotMatch(xml, /requiredextensions|basematerials/);
  const r = await read3mf(bytes(out.chunks));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([...r.colors.get(1)!.values()].map((c) => c.color), [GREEN, BLUE, [255, 0, 0, 255]]);
  assert.deepEqual(triangleSet(r, r.items[0]!.object), expectedCube((f) => (f === 15 ? BLUE : GREEN)));
  assert.deepEqual(triangleSet(r, r.items[1]!.object), expectedCube(() => [255, 0, 0, 255]));
});

test('hidden: keep writes hidden instances as ordinary parts', async () => {
  const out = write(scene(), { hidden: 'keep' });
  assert.ok(!messages(out).some((m) => m.includes('hidden')));
  const r = await read3mf(bytes(out.chunks));
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items[2]!.metadata[0]!.value, 'asm / hid / cube & co');
  const a = await read3mf(bytes(write(scene({ override: false }), { hidden: 'keep', build: 'assembly' }).chunks));
  assert.equal(a.components.get(a.items[0]!.object)!.components.length, 3);
});

test('a scene with nothing to draw, many vertices (written in pieces), the same bytes twice', async () => {
  const s = scene();
  s.roots = [];
  const empty = await read3mf(bytes(write(s).chunks));
  assert.deepEqual([empty.items.length, empty.meshes.size, empty.warnings], [0, 0, []]);
  // A closed strip of 2 × 40,000 quads around a square tube: past the piece size in vertices and in triangles.
  const n = 40000, positions: number[] = [], indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    positions.push(Math.cos(a) * 100, Math.sin(a) * 100, 0, Math.cos(a) * 100, Math.sin(a) * 100, 10);
  }
  // A ring's wall, closed by a top and a bottom fan around two centre vertices.
  positions.push(0, 0, 0, 0, 0, 10);
  const bottom = 2 * n, topc = 2 * n + 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1, bottom, 2 * j, 2 * i, topc, 2 * i + 1, 2 * j + 1);
  }
  const big: Mesh = { origin: [0, 0, 0], positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces: [{ source: 1, start: 0, count: indices.length }] };
  const t = scene({ override: false });
  t.components[0]!.children = [t.components[0]!.children[0]!];
  const out = write(t, {}, new Map([[0, big]]));
  assert.deepEqual(messages(out), []);
  const r = await read3mf(bytes(out.chunks), { full: false });
  assert.equal(r.meshes.size, 1);
  assert.equal([...r.meshes.values()][0]!.manifold, true);
  const xml = modelXml(out.chunks);
  assert.equal(xml.match(/<vertex /g)!.length, 2 * n + 2);
  assert.equal(xml.match(/<triangle /g)!.length, 4 * n);
  assert.deepEqual(bytes(write(t, {}, new Map([[0, big]])).chunks), bytes(out.chunks));
});

test('float32Text, transformText, xmlText', () => {
  assert.equal(float32Text(Math.fround(0.1)), '0.1');
  assert.equal(float32Text(Math.fround(1 / 3)), '0.33333334');
  assert.equal(float32Text(Math.fround(-1e-7)), '-1e-7');
  assert.equal(float32Text(16777216), '16777216');
  const a = new Float32Array(1000);
  for (let i = 0; i < a.length; i++) a[i] = Math.fround(Math.sin(i) * 10 ** ((i % 13) - 6));
  for (const x of a) {
    const s = float32Text(x);
    assert.equal(Math.fround(Number(s)), x);
    // The shortest: one digit fewer doesn't read back.
    const digits = s.replace(/^-|e.*$|\./g, '').replace(/^0+/, '').replace(/0+$/, '').length;
    if (digits > 1) assert.notEqual(Math.fround(Number(x.toPrecision(digits - 1))), x, s);
  }
  // Rows of the row-vector matrix: the images of x, y and z, then the translation.
  assert.equal(transformText(turn(200)), '0 1 0 -1 0 0 0 0 1 200 0 0');
  assert.equal(transformText(Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0, 0, 0, 1)), '1 0 0 0 1 0 0 0 1 0 0 0');
  assert.equal(xmlText('a&b<c>"d\'\te\n\u0001\ud800x\u{1f600}'), 'a&amp;b&lt;c&gt;&quot;d\' e x\u{1f600}');
  assert.equal(xmlText('a&b\te\r\n\u0001', true), 'a&amp;b\te\r\n');
});
