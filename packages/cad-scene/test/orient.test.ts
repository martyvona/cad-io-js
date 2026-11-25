import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrepData, BrepBuilder, writeAnalysis } from 'cad-brep';
import { box } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { againstHealedMessage, FallbackTessellator, orientResult, shellsOriented, tessellateScene, turnedMessage,
  wrongShells, type Scene, type TessellationResult, type Tessellator } from '../src/index.ts';

/**
 * A 4 mm box with a 1 mm void (faces 21-26 and 1021-1026): the void's shell used as `voidSense` says (false: facing
 * into the void, as it should; true: facing into the material, as a source can give it), the outer one as
 * `outerSense` says; `kind` the body's.
 */
function model(voidSense = false, outerSense = true, kind: 'solid' | 'sheet' = 'solid'): BrepData {
  const b = new BrepBuilder();
  const outer = box(b, [4, 4, 4]);
  const inner = box(b, [1, 1, 1], [1, 1, 1], 1000);
  const body = b.addBody({ kind, members: [{ ref: outer, sense: outerSense }, { ref: inner, sense: voidSense }],
    id: 500 });
  b.addItem({ kind: 'body', ref: body });
  return b.finish();
}

/** The signed volume of `r`'s triangles of the faces `ids`. */
function volume(r: TessellationResult, ids: (id: number) => boolean): number {
  let v = 0;
  for (const f of r.faces) {
    if (f.entityId === null || !ids(f.entityId)) continue;
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => Array.from(r.positions.subarray(3 * r.indices[k + j]!,
        3 * r.indices[k + j]! + 3))) as [number[], number[], number[]];
      v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!)
        + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
  }
  return Math.round(v * 1e9) / 1e9;
}
const inVoid = (id: number) => id > 1000, outside = (id: number) => id < 1000;

test('orient: a solid whose shells face out of the material left as it is', () => {
  const d = model();
  const r = quads(d);
  assert.equal(volume(r, outside), 64);
  assert.equal(volume(r, inVoid), -1);
  assert.deepEqual(wrongShells(d, r, 0.1), []);
  assert.equal(orientResult(d, r, 0.1), r);
});

test('orient: a void facing into the material, and an outer shell facing in, turned over', () => {
  for (const [voidSense, outerSense, wrong] of [[true, true, [1]], [false, false, [0]], [true, false, [0, 1]]] as
    const) {
    const d = model(voidSense, outerSense);
    const r = quads(d);
    const w = wrongShells(d, r, 0.1);
    assert.deepEqual(w.map((x) => x.shell), wrong);
    assert.deepEqual(w.map((x) => Math.round(x.volume * 1e9) / 1e9), wrong.map((s) => (s === 0 ? -64 : 1)));
    const o = orientResult(d, r, 0.1);
    assert.equal(volume(o, outside), 64);
    assert.equal(volume(o, inVoid), -1);
    assert.deepEqual(o.diagnostics, [{ severity: 'warning', message: turnedMessage(w) }]);
    assert.deepEqual(wrongShells(d, o, 0.1), []);
    // With a degenerate triangle (two corners at one position, as backends give them) in a face: judged the same.
    const f = r.faces.find((x) => x.entityId === 1021 || (x.entityId === 21 && wrong[0] === 0))!;
    const [a, b] = [r.indices[f.start]!, r.indices[f.start + 1]!];
    const indices = [...r.indices.subarray(0, f.start + f.count), a, b, b, ...r.indices.subarray(f.start + f.count)];
    const faces = r.faces.map((x) => (x === f ? { ...x, count: x.count + 3 }
      : x.start > f.start ? { ...x, start: x.start + 3 } : x));
    assert.deepEqual(wrongShells(d, { ...r, indices: Uint32Array.from(indices), faces }, 0.1).map((x) => x.shell),
      wrong);
    // The faces' ranges and the rest of the result as they were.
    assert.deepEqual(o.faces, r.faces);
    assert.equal(o.edges, r.edges);
  }
});

test('orient: shells not judged', () => {
  const d = model(true);
  const r = quads(d);
  // A sheet's shells.
  assert.deepEqual(wrongShells(model(true, true, 'sheet'), r, 0.1), []);
  // A face of the void without triangles: its mesh open.
  const without = { ...r, faces: r.faces.map((f) => (f.entityId === 1021 ? { ...f, count: 0 } : f)) };
  assert.deepEqual(wrongShells(d, without, 0.1), []);
  // A face of the void's triangles wound the other way: closed, but not consistently wound.
  const one = r.faces.find((f) => f.entityId === 1022)!;
  const indices = Uint32Array.from(r.indices);
  for (let k = one.start; k < one.start + one.count; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2]!,
    indices[k + 1]!];
  assert.deepEqual(wrongShells(d, { ...r, indices }, 0.1), []);
  // A face of the void's corner moved off: its mesh open there.
  assert.deepEqual(wrongShells(d, quads(d, { face: 1021, corner: 0, by: [0, 0, 0.01] }), 0.1), []);
  // A volume no larger than the shell's area times the deflection: its sign not sure (the void's area 6).
  assert.deepEqual(wrongShells(d, r, 1 / 6).map((x) => x.shell), []);
  assert.deepEqual(wrongShells(d, r, 0.16).map((x) => x.shell), [1]);
  // A face the void shares with another shell (a sheet of it alone): turning the void would turn the sheet's.
  const b = new BrepBuilder();
  const outer = box(b, [4, 4, 4]);
  const inner = box(b, [1, 1, 1], [1, 1, 1], 1000);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: inner, sense: true }] }) });
  // (Face rows in order: the outer box's 0-5, the void's 6-11.)
  const sheet = b.addShell({ kind: 'open', faces: [{ face: 6, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: sheet, sense: true }] }) });
  const shared = b.finish();
  assert.equal(shared.face.id[6], 1021);
  assert.deepEqual(wrongShells(shared, quads(shared), 0.1), []);
  // The same model without the sheet: the void judged.
  assert.deepEqual(wrongShells(d, quads(d), 0.1).map((x) => x.shell), [1]);
  // A solid's second shell beside its first, not inside it (a source's two lumps in one solid): no void, not judged;
  // inside the first's box, even only just, judged.
  for (const [at, wrong] of [[[5, 1, 1], []], [[1, 1, 3.5], []], [[1, 1, 3], [1]], [[0, 1, 1], [1]],
    [[-0.5, 1, 1], []]] as const) {
    const c = new BrepBuilder();
    const one = box(c, [4, 4, 4]);
    const two = box(c, [1, 1, 1], [...at], 1000);
    c.addItem({ kind: 'body', ref: c.addBody({ kind: 'solid', members: [{ ref: one, sense: true },
      { ref: two, sense: true }] }) });
    const beside = c.finish();
    assert.deepEqual(wrongShells(beside, quads(beside), 0.1).map((x) => x.shell), wrong);
  }
});

test('orient: normals negated; a vertex a turned face shares with another copied', () => {
  const d = model(true);
  const q = quads(d);
  // One of the outer faces' triangles made to use a void corner too (its shell then not judged; the void still is).
  const f = q.faces.find((x) => x.entityId === 21)!;
  const v = q.indices[q.faces.find((x) => x.entityId === 1021)!.start]!;
  const indices = Uint32Array.from(q.indices);
  indices[f.start] = v;
  const n = q.positions.length / 3;
  const normals = new Float32Array(3 * n);
  for (let k = 0; k < n; k++) normals.set([k, 2, 1], 3 * k);
  const r = { ...q, indices, normals };
  const o = orientResult(d, r, 0.1);
  assert.deepEqual(wrongShells(d, r, 0.1).map((x) => x.shell), [1]);
  assert.equal(o.positions.length, q.positions.length + 3);
  assert.deepEqual(Array.from(o.positions.subarray(3 * n)), Array.from(q.positions.subarray(3 * v, 3 * v + 3)));
  // The outer face keeps the vertex and its normal; the void's faces use the copy, its normal negated.
  assert.equal(o.indices[f.start], v);
  assert.deepEqual(Array.from(o.normals!.subarray(3 * v, 3 * v + 3)), [v, 2, 1]);
  assert.deepEqual(Array.from(o.normals!.subarray(3 * n)), [-v, -2, -1]);
  const g = o.faces.find((x) => x.entityId === 1021)!;
  assert.ok(Array.from(o.indices.subarray(g.start, g.start + g.count)).includes(n));
  assert.ok(!Array.from(o.indices.subarray(g.start, g.start + g.count)).includes(v));
  // A vertex only the void uses: negated in place; one only the outer shell uses kept.
  const w = o.indices[g.start + 1]!;
  assert.ok(w < n);
  assert.deepEqual(Array.from(o.normals!.subarray(3 * w, 3 * w + 3)), [-w, -2, -1]);
  const u = o.indices[o.faces.find((x) => x.entityId === 22)!.start]!;
  assert.deepEqual(Array.from(o.normals!.subarray(3 * u, 3 * u + 3)), [u, 2, 1]);
  assert.equal(volume(o, inVoid), -1);
});

/** A backend answering with `r`. */
function backend(r: TessellationResult) {
  const t: Tessellator & { asked: number } = { asked: 0,
    info: { name: 'fake', version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {}, tessellate: async () => { t.asked++; return r; }, dispose: () => {} };
  return t;
}

test('tessellateScene and the fallback orient (orient: false opts out)', async () => {
  const d = model(true);
  const scene = (): Scene => ({ unit: 'millimetre', components: [], roots: [], materials: [], layers: [],
    overrides: [], properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }],
      properties: {}, origin: [0, 0, 0], lods: [], brep: { format: 'step', model: d } }] });
  const message = turnedMessage(wrongShells(d, quads(d), 0.1));
  const s = scene();
  const out = await tessellateScene(s, backend(quads(d)), { linearDeflection: 0.1 });
  assert.deepEqual(out.diagnostics.map((x) => x.message), [message]);
  const mesh = s.parts[0]!.lods[0]!.mesh;
  const asResult = { ...quads(d), positions: mesh.positions, indices: mesh.indices,
    faces: mesh.faces.map((f) => ({ entityId: f.source, start: f.start, count: f.count })) };
  assert.equal(volume(asResult, inVoid), -1);
  const off = scene();
  const kept = await tessellateScene(off, backend(quads(d)), { linearDeflection: 0.1, orient: false });
  assert.deepEqual(kept.diagnostics, []);
  const m2 = off.parts[0]!.lods[0]!.mesh;
  assert.equal(volume({ ...asResult, positions: m2.positions, indices: m2.indices }, inVoid), 1);
  const req = { format: 'cad-brep' as const, data: new Uint8Array(d.buffer), linearDeflection: 0.1,
    angularDeflection: 0.5 };
  for (const orient of [true, false]) {
    const t = new FallbackTessellator(backend(quads(d)), backend(quads(d)), { orient });
    await t.init();
    const res = await t.tessellate(req);
    assert.equal(volume(res, inVoid), orient ? -1 : 1);
    assert.equal(res.diagnostics.some((x) => x.message === message), orient);
  }
});

test('a healed model whose shells healing oriented: a mesh turned is the backend\'s doing, said as such', async () => {
  // The model's shells as healing recorded them (analysis shell rows, facing found by the volume); the backend's mesh
  // of the void facing into the material all the same.
  const d = model(true), r = quads(d);
  const head = { analysis: { model: new Array(8).fill(0), uncertainty: [1e-6], measureRelTol: [NaN], measureProject: [0] } };
  const analysis = writeAnalysis({ ...head, shell: { volume: [64, 0, 1, 0], facing: [1, 1], facingFrom: [1, 1],
    turned: [0, 0] } });
  assert.ok(shellsOriented(analysis) && shellsOriented(new Uint8Array(analysis.buffer)));
  assert.ok(!shellsOriented(undefined) && !shellsOriented(writeAnalysis(head)));
  const w = wrongShells(d, r, 0.1), message = againstHealedMessage(w, 'fake 1');
  assert.match(message, /^1 shell of solids meshed by fake 1 facing into the material, against the healed model's /);
  const o = orientResult(d, r, 0.1, { backend: 'fake 1' });
  assert.equal(volume(o, inVoid), -1);
  assert.deepEqual(o.diagnostics, [{ severity: 'warning', message }]);
  // tessellateScene names its backend; the fallback the tessellator that meshed it.
  const s: Scene = { unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [],
    properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {},
      origin: [0, 0, 0], lods: [], brep: { format: 'step', model: d, analysis } }] };
  const b = backend(quads(d));
  const out = await tessellateScene(s, b, { linearDeflection: 0.1 });
  assert.deepEqual(out.diagnostics.map((x) => x.message),
    [againstHealedMessage(w, `${b.info.name} ${b.info.version}`)]);
  const t = new FallbackTessellator(backend(quads(d)), backend(quads(d)));
  await t.init();
  const res = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer), linearDeflection: 0.1,
    angularDeflection: 0.5, analysis: new Uint8Array(analysis.buffer) });
  assert.ok(res.diagnostics.some((x) => x.message === message.replace('fake 1', `${b.info.name} ${b.info.version}`)),
    JSON.stringify(res.diagnostics));
});
