import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder } from 'cad-brep';
import { box, cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { areaMessage } from '../src/tessellate.ts';
import { FallbackTessellator, ORACLE_DISAGREE, oracleAreas, oracleMeasures, tessellateScene, type Scene, type TessellateOptions,
  type TessellationResult, type Tessellator } from '../src/index.ts';

const model = cube().finish();
const FACES = [21, 22, 23, 24, 25, 26];

/** A one-part scene of the cube, its measures `measures` if given (as read from one of our exports). */
function scene(measures?: Scene['parts'][number]['measures']): Scene {
  return { unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {},
    diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {}, unit: 1,
      origin: [0, 0, 0], lods: [], brep: { format: 'step', model }, ...(measures ? { measures } : {}) }] };
}

/** A backend answering with `r`, the cube's mesh (each face 1), its measures `areas` (by face; 1 if not given). */
function fake(areas: Record<number, number | [number, boolean]> = {}, extra: Partial<TessellationResult> = {}) {
  const asked: boolean[] = [];
  const t: Tessellator & { asked: boolean[] } = {
    asked,
    info: { name: 'fake', version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {},
    tessellate: async (req) => {
      asked.push(req.measures ?? false);
      return { ...quads(model), ...(req.measures ? {
        measures: FACES.map((entityId) => {
          const a = areas[entityId] ?? 1, [area, valid] = Array.isArray(a) ? a : [a, true];
          return { entityId, area, perimeter: 4, valid };
        }),
        oracle: oracleMeasures(model) } : {}), ...extra };
    },
    dispose: () => {},
  };
  return t;
}

const run = async (t: Tessellator, s = scene(), opts: TessellateOptions = {}) => {
  const r = await tessellateScene(s, t, opts);
  return { s, part: s.parts[0]!, diagnostics: r.diagnostics };
};

test('measures: the oracle\'s where the backend\'s are off by more than ORACLE_DISAGREE or unsound, with a warning',
  async () => {
  // Face 22 measured 3 (its mesh 1: the oracle's 1 kept, and the mesh sound); 23 just within the threshold (kept);
  // 24 unsound.
  const { part, diagnostics } = await run(fake({ 22: 3, 23: 1 + ORACLE_DISAGREE * 0.99, 24: [1, false] }));
  const m = part.measures!;
  assert.deepEqual([m.faces.get(22)!.area, m.faces.get(22)!.valid], [1, true]);
  assert.equal(m.faces.get(23)!.area, 1 + ORACLE_DISAGREE * 0.99);
  assert.deepEqual([m.faces.get(24)!.area, m.faces.get(24)!.valid], [1, true]);
  assert.equal(m.by, 'fake 1, the area oracle\'s for 2 faces');
  assert.deepEqual(diagnostics, [{ severity: 'warning', message: '2 faces\' measured area replaced by the area '
    + 'oracle\'s (the backend\'s more than 1% off, or unsound)', source: { format: 'step', id: 7 } }]);
  // Just past the threshold: replaced.
  const past = await run(fake({ 23: 1 + ORACLE_DISAGREE * 1.01 }));
  assert.equal(past.part.measures!.faces.get(23)!.area, 1);
  // Opted out: the backend's, and so face 22's mesh (1 of 3) is short: an error.
  const kept = await run(fake({ 22: 3 }), scene(), { oracle: false });
  assert.equal(kept.part.measures!.faces.get(22)!.area, 3);
  assert.equal(kept.part.measures!.by, 'fake 1');
  assert.deepEqual(kept.diagnostics.map((d) => d.message), [areaMessage([22])]);
});

test('measures: a backend that measures nothing gets the oracle\'s, without a warning', async () => {
  const t = fake();
  const bare: Tessellator = { ...t, tessellate: async (req) => {
    const r = await t.tessellate(req);
    delete r.measures;
    return r;
  } };
  const { part, diagnostics } = await run(bare);
  assert.deepEqual([...part.measures!.faces.keys()].sort(), FACES);
  assert.equal(part.measures!.by, 'fake 1');
  assert.deepEqual(diagnostics, []);
});

test('faces meshed short of or over their area are errors, by the measures, the oracle\'s where it replaced them',
  async () => {
  // The backend measured face 24 at 2 and meshed it at 2 (a corner pulled out along its diagonal): the oracle's 1
  // replaces the measure, and the mesh is over it.
  const plain = quads(model), r24 = plain.faces.find((f) => f.entityId === 24)!;
  const corner = (j: number) => Array.from(plain.positions.subarray(3 * plain.indices[r24.start]! + 3 * j,
    3 * plain.indices[r24.start]! + 3 * j + 3));
  const [c0, , c2] = [0, 1, 2].map(corner);
  const by = [0, 1, 2].map((i) => c0![i]! - c2![i]!) as [number, number, number];
  const big = quads(model, { face: 24, corner: 0, by });
  const { part, diagnostics } = await run(fake({ 24: 2 }, { positions: big.positions }));
  assert.equal(part.measures!.faces.get(24)!.area, 1);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [{ severity: 'error', message: '1 face meshed short of or over its measured area: #24',
    source: { format: 'step', id: 7 } }]);
  // Measures from the source (an export's) judge the mesh too; this run measures nothing.
  const t = fake();
  const given = scene({ by: 'source', faces: new Map(FACES.map((id) => [id, { area: id === 21 ? 0.5 : 1,
    perimeter: 4, valid: true }])) });
  const g = await run(t, given);
  assert.deepEqual(t.asked, [false]);
  assert.deepEqual(g.diagnostics.map((d) => d.message), [areaMessage([21])]);
});

test('the area error names at most 10 faces, in order', () => {
  assert.equal(areaMessage([5]), '1 face meshed short of or over its measured area: #5');
  assert.equal(areaMessage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), '11 faces meshed short of or over their measured '
    + 'area: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, ...');
});

test('the oracle on a disc bounded by two arcs of one circle: each edge its own parameters', () => {
  const b = new BrepBuilder({ unit: 1 });
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const circle = b.addCurve({ kind: 'circle', position, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [-2, 0, 0] });
  const upper = b.addEdge({ curve: circle, start: v0, end: v1, sameSense: true, id: 1 });
  const lower = b.addEdge({ curve: circle, start: v1, end: v0, sameSense: true, id: 2 });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position }), sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: upper, orientation: 'forward' },
      { edge: lower, orientation: 'forward' }] }], id: 3 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  const a = oracleAreas(b.finish()).get(3)!;
  assert.ok(Math.abs(a.area - 4 * Math.PI) < 1e-6 * 4 * Math.PI, JSON.stringify(a));
  assert.ok(Math.abs(a.perimeter - 4 * Math.PI) < 1e-6 * 4 * Math.PI, JSON.stringify(a));
});

test('the oracle leaves out faces sharing an id (which of them it measured can\'t be told)', () => {
  const b = new BrepBuilder({ unit: 1 });
  for (const x of [0, 3]) {
    const shell = box(b, [1, 1, 1], [x, 0, 0]);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  }
  assert.equal(oracleAreas(b.finish()).size, 0);
  assert.equal(oracleAreas(model).size, 6);
});

test('the measures name the backend that made the result, the oracle with it where it replaced any', async () => {
  // The primary leaves face 23 out; the fallback ("b") measures face 22 at 3, which the oracle replaces.
  const named = (name: string, t: Tessellator): Tessellator => ({ ...t, info: { ...t.info, name } });
  const a = named('a', fake({}, { faces: quads(model).faces.filter((f) => f.entityId !== 23) }));
  const t = new FallbackTessellator(a, named('b', fake({ 22: 3 })));
  await t.init();
  const { part } = await run(t);
  assert.equal(part.measures!.by, 'b 1, the area oracle\'s for 1 face');
  assert.equal(part.lods[0]!.backend, 'b 1');
});

test('a face without triangles isn\'t an area error (the backend says it failed to mesh)', async () => {
  const { diagnostics } = await run(fake({}, { faces: quads(model).faces.map((f) => (f.entityId === 23
    ? { ...f, count: 0 } : f)) }));
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
});
