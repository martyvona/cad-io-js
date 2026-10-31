import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partInstances, type Scene } from 'cad-scene';
import { shownEdits } from '../src/export-shown.ts';
import { NodeModel } from '../src/model.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { plate, scene } from './fixtures.ts';

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
  const face7 = model.children(third).find((i) => model.nodes[i]!.name === 'face #7')!;
  model.setOverride(face7, { transparent: true, alpha: 0.6 });
  const e = shownEdits(s, model, graph);
  const r = applied(s, e);
  assert.deepEqual(r.map((p) => p.visible), [true, false, true]);
  // The first at 0.3, its blue face 7 at 0.3 too (still blue); the third's face 7 at 0.6, the rest the file's.
  assert.deepEqual([r[0]!.opacity, r[0]!.face7, r[0]!.face7Color], [0.3, 0.3, [0, 0, 1]]);
  assert.deepEqual([r[2]!.opacity, r[2]!.face7, r[2]!.face7Color], [1, 0.6, [0, 0, 1]]);
  // A face back to the file's within a transparent placement: its own material.
  model.setOverride(model.children(left).find((i) => model.nodes[i]!.name === 'face #7')!, { transparent: false });
  assert.deepEqual(applied(s, shownEdits(s, model, graph))[0]!.face7, 1);
  assert.deepEqual(e.warnings, []);
});

test('shownEdits: a face hidden in a shown placement, triangle edges: written as they can be, and said', () => {
  const { s, graph, model, plates } = setup();
  const face8 = model.children(plates[0]!).find((i) => model.nodes[i]!.name === 'face #8')!;
  model.setHidden([face8], true);
  model.setOverride(plates[1]!, { triangleEdges: true });
  const e = shownEdits(s, model, graph);
  assert.deepEqual(applied(s, e)[0]!.visible, true);
  assert.equal(e.warnings.length, 2);
  assert.match(e.warnings[0]!, /^1 hidden face written shown/);
  // A placement hidden but for one face shown: drawn, its other face counted hidden.
  const b = setup();
  b.model.setHidden([b.plates[0]!], true);
  b.model.setHidden([b.model.children(b.plates[0]!).find((i) => b.model.nodes[i]!.name === 'face #8')!], false);
  const f = shownEdits(b.s, b.model, b.graph);
  assert.deepEqual([applied(b.s, f)[0]!.visible, f.warnings], [true, ['1 hidden face written shown: the formats ' +
    'have no hiding of one face of a placed part']]);
});
