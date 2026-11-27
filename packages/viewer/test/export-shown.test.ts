import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partInstances, type Scene } from 'cad-scene';
import { shownEdits } from '../src/export-shown.ts';
import { NodeModel } from '../src/model.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { detailOf, plate, scene } from './fixtures.ts';

/** The fixture meshed, its node model, its plate's three placements' nodes (left, the second, the file's hidden). */
function setup() {
  const s = scene();
  const graph = new SceneGraph(s, 'model');
  graph.addMesh(0, plate());
  const model = new NodeModel(graph.root, graph);
  for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  model.setDetail(true);
  const plates = model.nodes.filter((n) => n.kind === 'part' && n.name === 'plate').map((n) => n.id);
  return { s, graph, model, plates };
}

/** The scene with the edits applied, its plate placements as partInstances resolves them. */
function applied(s: Scene, e: ReturnType<typeof shownEdits>) {
  const t: Scene = { ...s, materials: [...s.materials, ...e.materials], overrides: e.overrides };
  return [...partInstances(t)].filter((p) => p.part === 0).map((p) => ({ visible: p.visible,
    opacity: p.material === undefined ? 1 : t.materials[p.material]!.opacity,
    face7: t.materials[p.faceMaterials.get(7)!]?.opacity, face7Color: t.materials[p.faceMaterials.get(7)!]?.color }));
}

test('shownEdits: nothing changed, the scene as it is (the file\'s hidden placement kept hidden)', () => {
  const { s, graph, model } = setup();
  const e = shownEdits(s, model, graph);
  assert.deepEqual([e.materials, e.warnings], [[], []]);
  // (The second recoloured red at 0.5 by the file's override, whole: no face colour of its own.)
  assert.deepEqual(applied(s, e).map((p) => [p.visible, p.opacity, p.face7]), [[true, 1, 1], [true, 0.5, undefined],
    [false, 1, 1]]);
});

test('shownEdits: hidden and shown placements, opacity of a placement and a face, as partInstances reads them', () => {
  const { s, graph, model, plates } = setup();
  const [left, second, third] = plates as [number, number, number];
  model.setOpacity([left], 0.3);
  model.setHidden([second], true);
  model.setHidden([third], false);
  const face7 = detailOf(model, third).find((i) => model.nodes[i]!.name === 'face #7')!;
  model.setOverride(face7, { transparent: true, alpha: 0.6 });
  const e = shownEdits(s, model, graph);
  const r = applied(s, e);
  assert.deepEqual(r.map((p) => p.visible), [true, false, true]);
  // The first at 0.3, its blue face 7 at 0.3 too (still blue); the third's face 7 at 0.6, the rest the file's.
  assert.deepEqual([r[0]!.opacity, r[0]!.face7, r[0]!.face7Color], [0.3, 0.3, [0, 0, 1]]);
  assert.deepEqual([r[2]!.opacity, r[2]!.face7, r[2]!.face7Color], [1, 0.6, [0, 0, 1]]);
  // A face back to the file's within a transparent placement: its own material.
  model.setOverride(detailOf(model, left).find((i) => model.nodes[i]!.name === 'face #7')!, { transparent: false });
  assert.deepEqual(applied(s, shownEdits(s, model, graph))[0]!.face7, 1);
  assert.deepEqual(e.warnings, []);
});

test('shownEdits: a face hidden in a shown placement, triangle edges: written as they can be, and said', () => {
  const { s, graph, model, plates } = setup();
  const face8 = detailOf(model, plates[0]!).find((i) => model.nodes[i]!.name === 'face #8')!;
  model.setHidden([face8], true);
  model.setOverride(plates[1]!, { triangleEdges: true });
  const e = shownEdits(s, model, graph);
  assert.deepEqual(applied(s, e)[0]!.visible, true);
  assert.equal(e.warnings.length, 2);
  assert.match(e.warnings[0]!, /^1 hidden face written shown/);
  // A placement hidden but for one face shown: drawn, its other face counted hidden.
  const b = setup();
  b.model.setHidden([b.plates[0]!], true);
  b.model.setHidden([detailOf(b.model, b.plates[0]!).find((i) => b.model.nodes[i]!.name === 'face #8')!], false);
  const f = shownEdits(b.s, b.model, b.graph);
  assert.deepEqual([applied(b.s, f)[0]!.visible, f.warnings], [true, ['1 hidden face written shown: the formats ' +
    'have no hiding of one face of a placed part']]);
  // Its faces group hidden, its edges shown: drawn, both faces counted hidden (the group's, not the part's).
  const c = setup();
  c.model.setHidden([detailOf(c.model, c.plates[0]!).find((i) => c.model.nodes[i]!.kind === 'faces')!], true);
  const g = shownEdits(c.s, c.model, c.graph);
  assert.deepEqual([applied(c.s, g)[0]!.visible, g.warnings], [true, ['2 hidden faces written shown: the formats ' +
    'have no hiding of one face of a placed part']]);
});

test('shownEdits: a root part hidden and made transparent, by its reference among the root parts', () => {
  const s = scene();
  s.rootParts = [{ part: 0, transform: s.components[1]!.parts[0]!.transform, name: 'loose' }];
  const graph = new SceneGraph(s, 'model');
  graph.addMesh(0, plate());
  const model = new NodeModel(graph.root, graph);
  for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  const loose = model.nodes.find((n) => n.kind === 'part' && n.name === 'loose')!.id;
  model.setOpacity([loose], 0.25);
  const t = (e: ReturnType<typeof shownEdits>): Scene => ({ ...s, materials: [...s.materials, ...e.materials],
    overrides: e.overrides });
  const top = (sc: Scene) => [...partInstances(sc)].find((p) => !p.path.length)!;
  const faded = t(shownEdits(s, model, graph));
  assert.equal(faded.materials[top(faded).material!]!.opacity, 0.25);
  assert.ok(faded.overrides.some((o) => !o.path.length && o.ref === 0));
  model.setHidden([loose], true);
  assert.equal(top(t(shownEdits(s, model, graph))).visible, false);
});

test("shownEdits: while something's revealed, what isn't at Reveal alpha whatever its own; a revealed face kept",
  () => {
  const { s, graph, model, plates } = setup();
  const [left, second] = plates as [number, number];
  model.setOpacity([second], 0.6);
  model.setOverride(left, { reveal: true });
  const r = applied(s, shownEdits(s, model, graph, 0.2));
  // The revealed as it was; the second (overridden 0.6) at 0.2 (recoloured whole by the file: no face colour); the
  // file's hidden one hidden.
  assert.deepEqual(r.map((p) => [p.visible, p.opacity, p.face7]), [[true, 1, 1], [true, 0.2, undefined],
    [false, 1, 1]]);
  // A face of the ghost revealed: its own (the placement's override, 0.6); a face of the revealed not: at 0.2.
  const face7 = (part: number) => detailOf(model, part).find((i) => model.nodes[i]!.name === 'face #7')!;
  model.setOverride(face7(second), { reveal: true });
  model.setOverride(face7(left), { reveal: false });
  const t = applied(s, shownEdits(s, model, graph, 0.2));
  assert.deepEqual(t.slice(0, 2).map((p) => [p.opacity, p.face7]), [[1, 0.2], [0.2, 0.6]]);
  // Nothing revealed: as before.
  model.clearReveal();
  assert.deepEqual(applied(s, shownEdits(s, model, graph, 0.2)).map((p) => p.opacity), [1, 0.6, 1]);
});
