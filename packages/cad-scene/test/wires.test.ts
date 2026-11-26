import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cube } from '../../cad-brep/test/models.ts';
import { BrepBuilder } from 'cad-brep';
import { quads } from './meshes.ts';
import { FallbackTessellator, oracleMeasures, tessellateScene, type Scene, type TessellationRequest,
  type TessellationResult, type Tessellator } from '../src/index.ts';
import { addWires, describeWires, missingWires } from '../src/wires.ts';

// The cube with a wireframe curve (#901), a point (#902) and a point with no id beside its solid.
const b = cube();
b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
  id: 901 });
b.addItem({ kind: 'point', point: [3, 0, 0], id: 902 });
b.addItem({ kind: 'point', point: [4, 0, 0] });
const model = b.finish();
const FACES = [21, 22, 23, 24, 25, 26];

/** The cube's faces, sound, with `curves` and `points` (ids) as given. */
function result(curves: (number | null)[] = [], points: (number | null)[] = []): TessellationResult {
  const r: TessellationResult = { ...quads(model), measures: FACES.map((entityId) => ({ entityId, area: 1,
    perimeter: 4, valid: true })), oracle: oracleMeasures(model) };
  if (curves.length) {
    r.curvePositions = new Float32Array(curves.flatMap((_, k) => [10 + k, 0, 0, 10 + k, 0, 1]));
    r.curves = curves.map((entityId, k) => ({ entityId, start: 2 * k, count: 2 }));
  }
  if (points.length) {
    r.points = new Float32Array(points.flatMap((_, k) => [20 + k, 0, 0]));
    r.pointIds = points;
  }
  return r;
}

/** A backend answering with `answer`, counting its requests. */
function fake(name: string, answer: () => TessellationResult | Error) {
  let calls = 0;
  const t: Tessellator & { calls: () => number } = {
    calls: () => calls,
    info: { name, version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true, supportsEdges: true,
      supportsCurves: true },
    init: async () => {},
    tessellate: async () => {
      calls++;
      const r = answer();
      if (r instanceof Error) throw r;
      return r;
    },
    dispose: () => {},
  };
  return t;
}

const request = (): TessellationRequest => ({ format: 'cad-brep', data: new Uint8Array(model.buffer),
  linearDeflection: 0.01, angularDeflection: 0.5 });

test('missingWires: the model\'s curve and point items a result has nothing for; unnamed ones fill in', () => {
  assert.deepEqual(missingWires(model, result()), { curves: [901], points: [902] });
  assert.deepEqual(missingWires(model, result([901], [902])), { curves: [], points: [] });
  // Others' ids don't count; one with no source stands for one missing.
  assert.deepEqual(missingWires(model, result([5], [6])), { curves: [901], points: [902] });
  assert.deepEqual(missingWires(model, result([null], [null])), { curves: [], points: [] });
  // Points with no ids at all are unnamed too.
  const bare = result([], [null]);
  delete bare.pointIds;
  assert.deepEqual(missingWires(model, bare), { curves: [901], points: [] });
});

test('missingWires: a wire body\'s edges, a curve each by the edge\'s id; its own id not one', () => {
  // The cube with a wire body (#70) of three edges (#71, #72 and one with no id, which can't be told).
  const w = cube();
  const at = [[5, 0, 0], [6, 0, 0], [6, 1, 0], [5, 1, 0]], v = at.map((point) => w.addVertex({ point }));
  const e = [[0, 1, [1, 0, 0]], [1, 2, [0, 1, 0]], [2, 3, [-1, 0, 0]]].map(([a, c, dir], k) => w.addEdge({
    curve: w.addCurve({ kind: 'line', point: at[a as number]!, direction: dir as number[], magnitude: 1 }),
    start: v[a as number]!, end: v[c as number]!, sameSense: true, range: [0, 1], ...(k < 2 ? { id: 71 + k } : {}) }));
  w.addItem({ kind: 'body', ref: w.addBody({ kind: 'wire', members: e.map((ref) => ({ ref, sense: true })), id: 70 }),
    id: 70 });
  const wired = w.finish();
  assert.deepEqual(missingWires(wired, result()), { curves: [71, 72], points: [] });
  assert.deepEqual(missingWires(wired, result([72])), { curves: [71], points: [] });
  assert.deepEqual(missingWires(wired, result([71, 72])), { curves: [], points: [] });
  // The cube's solid is no wire: nothing of its edges expected.
  assert.deepEqual(missingWires(cube().finish(), result()), { curves: [], points: [] });
});

test('addWires: the other result\'s curves and points for the missing ids appended, the rest as they were', () => {
  const r = result([5, 6]), from = result([7, 901], [8, 902]);
  const { result: out, added } = addWires(r, from, { curves: [901], points: [902] });
  assert.deepEqual(added, { curves: [901], points: [902] });
  assert.deepEqual(out.curves, [{ entityId: 5, start: 0, count: 2 }, { entityId: 6, start: 2, count: 2 },
    { entityId: 901, start: 4, count: 2 }]);
  assert.deepEqual(Array.from(out.curvePositions!), [10, 0, 0, 10, 0, 1, 11, 0, 0, 11, 0, 1, 11, 0, 0, 11, 0, 1]);
  assert.deepEqual(out.pointIds, [902]);
  assert.deepEqual(Array.from(out.points!), [21, 0, 0]);
  // Nothing for them there: unchanged.
  const none = addWires(r, result([7]), { curves: [901], points: [902] });
  assert.deepEqual(none.added, { curves: [], points: [] });
  assert.equal(none.result.curves, r.curves);
  assert.equal(describeWires({ curves: [1, 2], points: [3] }), '2 wireframe curves (#1, #2) and 1 point (#3)');
  assert.equal(describeWires({ curves: [], points: [3] }), '1 point (#3)');
});

test('fallback: curves and points the primary left out taken from the fallback, asked once; said', async () => {
  // The primary sound for the faces, no wires: the fallback asked for them alone.
  const a = fake('a', () => result()), f = fake('f', () => result([901], [902]));
  const t = new FallbackTessellator(a, f);
  const r = await t.tessellate(request());
  assert.equal(f.calls(), 1);
  assert.deepEqual(missingWires(model, r), { curves: [], points: [] });
  assert.deepEqual(r.diagnostics.map((d) => [d.severity, d.message]), [
    ['warning', 'wireframe curve #901 meshed by the fallback backend (f), which a\'s result left out'],
    ['warning', 'point #902 meshed by the fallback backend (f), which a\'s result left out']]);
  // A model of wires alone, all of them the fallback's: one warning, for the part.
  const w = new BrepBuilder({ uncertainty: 1e-6 });
  w.addItem({ kind: 'curve', ref: w.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
    id: 901 });
  w.addItem({ kind: 'point', point: [3, 0, 0], id: 902 });
  const wires = w.finish(), bare = (): TessellationResult => ({ origin: [0, 0, 0], positions: new Float32Array(),
    indices: new Uint32Array(), faces: [], diagnostics: [] });
  const wireResult = (): TessellationResult => ({ ...result([901], [902]), positions: new Float32Array(),
    indices: new Uint32Array(), faces: [], measures: [], oracle: [] });
  const wr = await new FallbackTessellator(fake('a', bare), fake('f', wireResult))
    .tessellate({ ...request(), data: new Uint8Array(wires.buffer) });
  assert.deepEqual(missingWires(wires, wr), { curves: [], points: [] });
  assert.deepEqual(wr.diagnostics.map((d) => [d.severity, d.message]), [['warning', 'meshed by the fallback '
    + 'backend (f), 1 wireframe curve (#901) and 1 point (#902) left out of a\'s result']]);
  // The primary with one of them: the other said alone.
  const one = await new FallbackTessellator(fake('a', () => ({ ...wireResult(), ...result([901]), positions:
    new Float32Array(), indices: new Uint32Array(), faces: [], measures: [], oracle: [], points: undefined,
    pointIds: undefined })), fake('f', wireResult))
    .tessellate({ ...request(), data: new Uint8Array(wires.buffer) });
  assert.deepEqual(one.diagnostics.map((d) => d.message), ['point #902 meshed by the fallback backend (f), which '
    + 'a\'s result left out']);
  const curveOnly = await new FallbackTessellator(fake('a', () => ({ ...wireResult(), curves: undefined,
    curvePositions: undefined })), fake('f', wireResult))
    .tessellate({ ...request(), data: new Uint8Array(wires.buffer) });
  assert.deepEqual(curveOnly.diagnostics.map((d) => d.message), ['wireframe curve #901 meshed by the fallback backend '
    + '(f), which a\'s result left out']);
  // A model of nothing: nothing said.
  const empty = new BrepBuilder({ uncertainty: 1e-6 }).finish();
  const nothing = await new FallbackTessellator(fake('a', bare), fake('f', bare))
    .tessellate({ ...request(), data: new Uint8Array(empty.buffer) });
  assert.deepEqual(nothing.diagnostics, []);
  // The primary with both: nothing said.
  const neither = await new FallbackTessellator(fake('a', wireResult), fake('f', wireResult))
    .tessellate({ ...request(), data: new Uint8Array(wires.buffer) });
  assert.deepEqual(neither.diagnostics, []);
  // The primary failing a face: the fallback's result for the faces reused for the wires, not asked again.
  const a2 = fake('a', () => ({ ...result(), faces: result().faces.map((x) => x.entityId === 23 ? { ...x, count: 0 }
    : x) })), f2 = fake('f', () => result([901], [902]));
  const r2 = await new FallbackTessellator(a2, f2).tessellate(request());
  assert.equal(f2.calls(), 1);
  assert.deepEqual(missingWires(model, r2), { curves: [], points: [] });
  // Nothing missing: the fallback not asked. The fallback failing, or without them: the primary's as it was.
  const f3 = fake('f', () => result());
  assert.equal((await new FallbackTessellator(fake('a', () => result([901], [902])), f3).tessellate(request()))
    .diagnostics.length, 0);
  assert.equal(f3.calls(), 0);
  for (const f4 of [fake('f', () => new Error('down')), fake('f', () => result())]) {
    const r4 = await new FallbackTessellator(fake('a', () => result()), f4).tessellate(request());
    assert.deepEqual(missingWires(model, r4), { curves: [901], points: [902] });
    assert.ok(!r4.diagnostics.some((d) => /fallback/.test(d.message)));
  }
});

test('tessellateScene: the curves and points no backend delivered said, per part; none where all are', async () => {
  const scene = (): Scene => ({ unit: 'millimetre', components: [], roots: [], materials: [], layers: [],
    overrides: [], properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }],
      properties: {}, origin: [0, 0, 0], lods: [], brep: { format: 'step', model } }] });
  const lacking = await tessellateScene(scene(), fake('a', () => result([], [902])));
  const said = lacking.diagnostics.filter((d) => /not meshed/.test(d.message));
  assert.deepEqual(said.map((d) => [d.severity, d.message, d.source]), [['warning',
    '1 wireframe curve (#901) not meshed by a (left out of its result)', { format: 'step', id: 7 }]]);
  const whole = await tessellateScene(scene(), fake('a', () => result([901], [902])));
  assert.ok(!whole.diagnostics.some((d) => /not meshed/.test(d.message)));
  // Behind a fallback that has none of them either: said once, by the chain's name.
  const chain = new FallbackTessellator(fake('a', () => result()), fake('f', () => result()));
  const both = await tessellateScene(scene(), chain);
  assert.deepEqual(both.diagnostics.filter((d) => /not meshed/.test(d.message)).map((d) => d.message),
    ['1 wireframe curve (#901) and 1 point (#902) not meshed by a+f (left out of its result)']);
});
