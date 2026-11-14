import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, decode } from 'cad-brep';
import { box, cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { FallbackTessellator, filledMessage, fillFaces, fillResult, judgeResult, openEdges, oracleMeasures,
  tessellateScene, type Scene, type TessellationResult, type Tessellator } from '../src/index.ts';

/** A box 1 x 1 x 0.05: its four sides slivers 0.05 wide. */
function thin() {
  const b = new BrepBuilder();
  const shell = box(b, [1, 1, 0.05]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}
const d = thin();
/** A side face's id (one whose area is 0.05). */
const side = (() => {
  const o = oracleMeasures(d);
  return o.find((m) => Math.abs(m.area - 0.05) < 1e-9)!.entityId;
})();
const failed = { severity: 'error' as const, message: '1 faces failed to mesh' };
const without = (r: TessellationResult, id: number) => ({ ...r, faces: r.faces.map((f) => (f.entityId === id
  ? { ...f, count: 0 } : f)), oracle: oracleMeasures(d), diagnostics: [failed] });

/** Every mesh edge (by position) used twice, once each way: closed and oriented. */
function closedOriented(r: TessellationResult): boolean {
  const k = (i: number) => `${r.positions[3 * i]},${r.positions[3 * i + 1]},${r.positions[3 * i + 2]}`;
  const uses = new Map<string, number>();
  for (const f of r.faces) for (let t = f.start; t < f.start + f.count; t += 3) for (let j = 0; j < 3; j++) {
    const e = `${k(r.indices[t + j]!)}|${k(r.indices[t + (j + 1) % 3]!)}`;
    uses.set(e, (uses.get(e) ?? 0) + 1);
  }
  return [...uses].every(([e, n]) => n === 1 && uses.get(e.split('|').reverse().join('|')) === 1);
}

test('fill: a sliver no backend meshed made of triangles between its rim\'s points, wound as its neighbours', () => {
  const r = without(quads(d), side);
  const f = fillFaces(d, r, 0.1);
  assert.deepEqual([f.filled, [...f.skipped]], [[side], []]);
  assert.ok(closedOriented(f.result));
  assert.deepEqual(openEdges(d, f.result).open, []);
  assert.ok(judgeResult(f.result, d, 0.1).ok, JSON.stringify(judgeResult(f.result, d, 0.1)));
  // Its neighbours untouched; the faces still partition the indices.
  assert.deepEqual(Array.from(f.result.indices.subarray(0, r.indices.length)).filter((_, k) =>
    !r.faces.some((x) => x.entityId === side && k >= x.start && k < x.start + 6)),
  Array.from(r.indices).filter((_, k) => !r.faces.some((x) => x.entityId === side && k >= x.start && k < x.start + 6)));
  // One range for it (its empty one gone), its triangles each of three points.
  assert.equal(f.result.faces.filter((x) => x.entityId === side).length, 1);
  const filledRange = f.result.faces.find((x) => x.entityId === side)!;
  const P = (i: number) => Array.from(f.result.positions.subarray(3 * i, 3 * i + 3)).join();
  for (let t = filledRange.start; t < filledRange.start + filledRange.count; t += 3) {
    assert.equal(new Set([0, 1, 2].map((j) => P(f.result.indices[t + j]!))).size, 3);
  }
  assert.deepEqual([filledRange.start, filledRange.start + filledRange.count], [r.indices.length,
    f.result.indices.length]);
  // fillResult: the backend's error for it replaced by a warning naming it; nothing else.
  assert.deepEqual(fillResult(d, r, 0.1).diagnostics, [{ severity: 'warning', message: filledMessage([side]) }]);
  // Wound the other way round in the result it comes from, the fill too (still against its neighbours).
  const flipped = { ...r, indices: Uint32Array.from(r.indices, (_, k) => r.indices[k - (k % 3) + [0, 2, 1][k % 3]!]!) };
  const g = fillFaces(d, flipped, 0.1);
  assert.ok(closedOriented(g.result));
});

test('fill: not a face wider than the deflection, off its exact area, with an edge not drawn, or whose rim is no loop',
  () => {
  const c = cube().finish();
  // A face of the unit cube: 1 wide, wider than 0.1; at a deflection of 2, a sliver, filled.
  const r = { ...quads(c), faces: quads(c).faces.map((f) => (f.entityId === 23 ? { ...f, count: 0 } : f)),
    oracle: oracleMeasures(c), diagnostics: [failed] };
  assert.equal(fillFaces(c, r, 0.1).skipped.get(23), 'wider than the deflection');
  assert.deepEqual(fillFaces(c, r, 2).filled, [23]);
  // Its exact area said to be 30 (its fill's is 1): off it, beyond what faceFailures allows at a deflection of 1.5.
  const wrong = { ...r, oracle: r.oracle.map((o) => (o.entityId === 23 ? { ...o, area: 30 } : o)) };
  assert.equal(fillFaces(c, wrong, 1.5).skipped.get(23), 'its fill off its exact area');
  assert.deepEqual(fillFaces(c, r, 1.5).filled, [23]);
  // An edge of the side without its polyline.
  const base = without(quads(d), side);
  const loop = decode.face(d, [...d.face.id].indexOf(side)).loops[0]!;
  const first = loop.kind === 'edge' ? decode.edge(d, loop.coedges[0]!.edge).id : 0;
  const undrawn = { ...base, edges: base.edges!.filter((e) => e.entityId !== first) };
  assert.equal(fillFaces(d, undrawn, 0.1).skipped.get(side), 'an edge of it not drawn');
  // That polyline moved off the others' ends: the rim no loop.
  const k = base.edges!.findIndex((e) => e.entityId === first);
  const ep = Float32Array.from(base.edgePositions!);
  for (let j = 0; j < 3; j++) ep[3 * base.edges![k]!.start + j] = ep[3 * base.edges![k]!.start + j]! + 0.5;
  assert.equal(fillFaces(d, { ...base, edgePositions: ep }, 0.1).skipped.get(side), 'its rim not a loop');
  // A result with nothing to fill, or that says no face failed, comes back as it is.
  const whole = quads(d);
  assert.equal(fillFaces(d, whole, 0.1).result, whole);
  const quiet = { ...base, diagnostics: [] };
  assert.equal(fillResult(d, quiet, 0.1), quiet);
});

test('fill: normals for the new points; the faces left still said to have failed', () => {
  const r = without(quads(d), side);
  const normals = new Float32Array(r.positions.length).fill(7);
  const f = fillFaces(d, { ...r, normals }, 0.1);
  assert.equal(f.result.normals!.length, f.result.positions.length);
  const added = f.result.normals!.subarray(r.positions.length);
  assert.ok(added.length > 0 && Math.abs(Math.hypot(added[0]!, added[1]!, added[2]!) - 1) < 1e-6);
  // Two faces out, one the wide top (not filled): the error for it left.
  const top = oracleMeasures(d).find((m) => Math.abs(m.area - 1) < 1e-9)!.entityId;
  const two = { ...r, faces: r.faces.map((x) => (x.entityId === top ? { ...x, count: 0 } : x)) };
  assert.deepEqual(fillResult(d, two, 0.1).diagnostics, [{ severity: 'warning', message: filledMessage([side]) },
    { severity: 'error', message: `1 faces failed to mesh: #${top}` }]);
});

/** A backend answering with `r`. */
function backend(r: TessellationResult) {
  const t: Tessellator & { asked: number } = { asked: 0,
    info: { name: 'fake', version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {}, tessellate: async () => { t.asked++; return r; }, dispose: () => {} };
  return t;
}

test('tessellateScene fills (fill: false opts out); the fallback judges filled results', async () => {
  const r = { ...without(quads(d), side), measures: oracleMeasures(d).map((m) => ({ ...m, valid: true })) };
  const scene = (): Scene => ({ unit: 'millimetre', components: [], roots: [], materials: [], layers: [],
    overrides: [], properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }],
      properties: {}, origin: [0, 0, 0], lods: [], brep: { format: 'step', model: d } }] });
  const s = scene();
  const out = await tessellateScene(s, backend(r), { linearDeflection: 0.1 });
  assert.deepEqual(out.diagnostics.map((x) => x.message), [filledMessage([side])]);
  assert.ok(s.parts[0]!.lods[0]!.mesh.faces.some((f) => f.source === side && f.count > 0));
  const off = await tessellateScene(scene(), backend(r), { linearDeflection: 0.1, fill: false });
  assert.ok(off.diagnostics.some((x) => x.message === '1 faces failed to mesh'));
  // The primary's sliver filled, it is sound: the fallback not asked.
  const b = backend(quads(d));
  const t = new FallbackTessellator(backend(r), b);
  await t.init();
  const res = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer), linearDeflection: 0.1,
    angularDeflection: 0.5 });
  assert.equal(b.asked, 0);
  assert.ok(judgeResult(res, d, 0.1).ok);
});

test('fill: a long sliver a strip of short triangles between its sides, not fans across it', () => {
  // The side face's two long edges drawn with 11 points each (every 0.1 along their 1): every triangle of the fill
  // then spans a rim segment and the width, no more.
  const r = without(quads(d), side);
  const loop = decode.face(d, [...d.face.id].indexOf(side)).loops[0]!;
  const ids = loop.kind === 'edge' ? loop.coedges.map((c) => decode.edge(d, c.edge).id!) : [];
  const ep: number[] = [];
  const edges = r.edges!.map((e) => {
    const a = Array.from(r.edgePositions!.subarray(3 * e.start, 3 * e.start + 3));
    const b = Array.from(r.edgePositions!.subarray(3 * e.start + 3, 3 * e.start + 6));
    const long = ids.includes(e.entityId!) && Math.hypot(...a.map((x, i) => x - b[i]!)) > 0.5;
    const start = ep.length / 3, n = long ? 11 : 2;
    for (let k = 0; k < n; k++) ep.push(...a.map((x, i) => x + (k / (n - 1)) * (b[i]! - x)));
    return { ...e, start, count: n };
  });
  const f = fillFaces(d, { ...r, edges, edgePositions: Float32Array.from(ep) }, 0.1);
  assert.deepEqual(f.filled, [side]);
  const range = f.result.faces.find((x) => x.entityId === side)!;
  const P = (i: number) => [0, 1, 2].map((j) => f.result.positions[3 * i + j]!);
  let longest = 0;
  for (let t = range.start; t < range.start + range.count; t += 3) for (let j = 0; j < 3; j++) {
    const a = P(f.result.indices[t + j]!), b = P(f.result.indices[t + (j + 1) % 3]!);
    longest = Math.max(longest, Math.hypot(...a.map((x, i) => x - b[i]!)));
  }
  assert.ok(longest < 0.12, String(longest));
  assert.equal(range.count, 3 * 20);
});

test('fill: a polyline of no points (an edge a backend couldn\'t draw) is none', () => {
  const r = without(quads(d), side);
  const loop = decode.face(d, [...d.face.id].indexOf(side)).loops[0]!;
  const first = loop.kind === 'edge' ? decode.edge(d, loop.coedges[0]!.edge).id : 0;
  // An empty polyline for that edge besides its own: filled all the same; in place of its own: not drawn.
  const extra = { ...r, edges: [...r.edges!, { entityId: first ?? null, start: 0, count: 0, kind: 'shared' as const }] };
  assert.deepEqual(fillFaces(d, extra, 0.1).filled, [side]);
  const only = { ...r, edges: r.edges!.map((e) => (e.entityId === first ? { ...e, count: 0 } : e)) };
  assert.equal(fillFaces(d, only, 0.1).skipped.get(side), 'an edge of it not drawn');
});
