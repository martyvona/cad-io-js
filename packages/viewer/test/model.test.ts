import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NodeModel } from '../src/model.ts';
import { StepGraph } from '../src/step.ts';
import { plate, scene, wire } from './fixtures.ts';

/** The STEP fixture with its meshes, and its node model. */
function stepModel() {
  const graph = new StepGraph(scene(), 'model');
  const model = new NodeModel(graph.root, graph);
  return { graph, model };
}
const names = (m: NodeModel, ids: readonly number[]) => ids.map((i) => `${m.nodes[i]!.kind}:${m.nodes[i]!.name}`);

test('STEP: assemblies and parts, the file hidden placement hidden, no detail until asked for', () => {
  const { model } = stepModel();
  assert.deepEqual(names(model, model.roots), ['assembly:model']);
  const [asm] = model.children(model.roots[0]!);
  assert.deepEqual(names(model, model.children(asm!)), ['assembly:left', 'assembly:sub', 'assembly:hidden']);
  const [left, , hidden] = model.children(asm!);
  assert.deepEqual(names(model, model.children(left!)), ['part:plate', 'part:wire']);
  // The override hides the placed parts below that occurrence.
  assert.equal(model.nodes[hidden!]!.hidden, false);
  assert.deepEqual(model.children(hidden!).map((i) => model.nodes[i]!.hidden), [true, true]);
  assert.equal(model.hiddenInTree(model.children(hidden!)[0]!), true);
  assert.equal(model.hiddenInTree(model.children(left!)[0]!), false);
  // Parts have no children without detail, nor with it before their meshes arrive.
  const part = model.children(left!)[0]!;
  assert.deepEqual(model.children(part), []);
  model.setDetail(true);
  assert.equal(model.hasChildren(part), false);
});

test("STEP detail: a part's faces (once each), its edges, its curves and points; built again when meshes arrive",
  () => {
    const { graph, model } = stepModel();
    model.setDetail(true);
    const left = model.children(model.children(model.roots[0]!)[0]!)[0]!;
    const [platePart, wirePart] = model.children(left);
    assert.deepEqual(model.children(platePart!), []);
    graph.addMesh(0, plate());
    graph.addMesh(1, wire());
    for (const p of [...graph.placements.get(0)!, ...graph.placements.get(1)!]) model.invalidate(p.group);
    assert.equal(model.hasChildren(platePart!), true);
    assert.deepEqual(names(model, model.children(platePart!)), ['face:face #8', 'face:face #7', 'edges:edges']);
    assert.deepEqual(names(model, model.children(wirePart!)), ['curves:curves', 'points:points']);
    model.setDetail(false);
    assert.deepEqual(model.children(platePart!), []);
    assert.equal(model.hasChildren(platePart!), false);
    // A face split by the backend (two ranges, one source): one node.
    const split = plate();
    split.faces = [{ source: 8, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }];
    graph.addMesh(0, split);
    model.setDetail(true);
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
    assert.deepEqual(names(model, model.children(platePart!)).filter((n) => n.startsWith('face')), ['face:face #8',
      'face:face #7', 'face:face #8']);
  });

test('hiding: objects hidden with their subtrees, shown greyed below; show all shows the file hidden too', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  model.setDetail(true);
  const [left, sub, hidden] = model.children(model.children(model.roots[0]!)[0]!);
  model.setHidden([left!], true);
  assert.equal(model.nodes[left!]!.object!.visible, false);
  const part = model.children(left!)[0]!;
  assert.equal(model.hiddenInTree(part), true);
  assert.equal(model.nodes[part]!.hidden, false);
  // The edges node hides the edges of its placement only.
  const edges = model.children(model.children(sub!)[0]!).find((i) => model.nodes[i]!.kind === 'edges')!;
  model.setHidden([edges], true);
  assert.equal(model.nodes[edges]!.object!.visible, false);
  const otherEdges = graph.placements.get(0)![0]!.group.children[0]!.children.find((c) => c.name === 'edges')!;
  assert.equal(otherEdges.visible, true);
  const hiddenPart = model.children(hidden!)[0]!;
  model.showAll();
  assert.ok([left, sub, hidden, edges, hiddenPart].every((i) => !model.nodes[i!]!.hidden));
  assert.equal(model.nodes[hiddenPart]!.object!.visible, true);
  assert.equal(model.nodes[edges]!.object!.visible, true);
});

test("hiding a face: its triangles drawn with nothing in every placement of the part; the other placements' nodes too",
  () => {
    const { graph, model } = stepModel();
    const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
    model.setDetail(true);
    const [left, sub] = model.children(model.children(model.roots[0]!)[0]!);
    const face7 = (placement: number) => model.children(model.children(placement)[0]!).find(
      (i) => model.nodes[i]!.name === 'face #7')!;
    const a = face7(left!);
    const b = face7(sub!);
    model.setHidden([a], true);
    assert.equal(model.nodes[b]!.hidden, true);
    for (const m of meshes) {
      const groups = m.geometry.groups.map((g) => [g.start, g.count, (m.material as THREE.Material[])[
        g.materialIndex!]!.visible]);
      // Face 8 (indices 0-2) drawn, face 7 (3-5) not.
      assert.deepEqual(groups, [[0, 3, true], [3, 3, false]]);
    }
    assert.equal(graph.isFaceHidden(0, 7), true);
    model.showAll();
    assert.equal(model.nodes[a]!.hidden, false);
    assert.equal(graph.isFaceHidden(0, 7), false);
    assert.ok(meshes.every((m) => (m.material as THREE.Material[]).every((x) => x.visible)));
    // Shown again by its own flag: the same.
    model.setHidden([a], true);
    model.setHidden([b], false);
    assert.ok(meshes.every((m) => (m.material as THREE.Material[]).every((x) => x.visible)));
  });

test("three.js graphs: parts are objects with only drawables below; a part's own drawing hides alone", () => {
  const root = new THREE.Group();
  root.name = 'scene';
  const box = (name: string) => Object.assign(new THREE.Mesh(new THREE.BoxGeometry()), { name });
  const lines = () => Object.assign(new THREE.LineSegments(), { name: 'edges' });
  const withLines = box('bracket');
  withLines.add(lines());
  const multi = Object.assign(new THREE.Group(), { name: 'two primitives' });
  multi.add(box(''), box(''));
  // A group with only a mesh below is a part (a glTF node's primitives); with a group below, an assembly.
  const sub = Object.assign(new THREE.Group(), { name: 'sub' });
  const lone = box('lone');
  lone.visible = false;
  sub.add(Object.assign(new THREE.Group(), { name: 'holder' }).add(lone));
  const empty = Object.assign(new THREE.Group(), { name: 'empty' });
  // A group whose mesh has a group below it: not only drawables below, so an assembly.
  const deep = Object.assign(new THREE.Group(), { name: 'deep' });
  deep.add(box('outer').add(Object.assign(new THREE.Group(), { name: 'inner' }).add(box('innermost'))));
  root.add(withLines, multi, sub, empty, deep);
  const m = new NodeModel(root);
  assert.deepEqual(names(m, m.roots), ['assembly:scene']);
  const top = m.children(m.roots[0]!);
  assert.deepEqual(names(m, top), ['part:bracket', 'part:two primitives', 'assembly:sub', 'assembly:empty',
    'assembly:deep']);
  assert.deepEqual(names(m, m.children(top[2]!)), ['part:holder']);
  assert.equal(m.nodes[m.children(top[2]!)[0]!]!.hidden, false);
  // Before detail: an object below a part is the part's.
  assert.equal(m.nodeOf(withLines.children[0]!), top[0]);
  m.setDetail(true);
  const detail = m.children(top[0]!);
  assert.deepEqual(names(m, detail), ['mesh:bracket (itself)', 'lines:edges']);
  assert.deepEqual(names(m, m.children(top[1]!)), ['mesh:mesh', 'mesh:mesh']);
  assert.deepEqual(names(m, m.children(m.children(top[2]!)[0]!)), ['mesh:lone']);
  assert.equal(m.nodes[m.children(m.children(top[2]!)[0]!)[0]!]!.hidden, true);
  // The part's own drawing: its layer, so its edges stay.
  m.setHidden([detail[0]!], true);
  assert.equal(withLines.layers.isEnabled(0), false);
  assert.equal(withLines.visible, true);
  assert.equal(withLines.children[0]!.layers.isEnabled(0), true);
  m.showAll();
  assert.equal(withLines.layers.isEnabled(0), true);
  assert.equal(lone.visible, true);
  // An object's node: the nearest node at or above it (its own, once detail is built; the part's own drawing has
  // no node of its own there, so the part's).
  const own = m.nodeOf(multi.children[1]!)!;
  assert.equal(m.nodes[own]!.kind, 'mesh');
  assert.equal(m.nodes[own]!.parent, top[1]);
  assert.equal(m.nodeOf(new THREE.Object3D()), undefined);
  assert.equal(m.nodeOf(withLines), top[0]);
});

test('paths: occurrence names with an index among same-named siblings, detail below parts, found either way', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  graph.addMesh(1, wire());
  const all = (ids: readonly number[]): number[] => ids.flatMap((i) => [i, ...all(model.children(i))]);
  model.setDetail(true);
  const ids = all(model.roots);
  const paths = ids.map((i) => model.pathOf(i));
  // Unique, and each finds its node.
  assert.equal(new Set(paths).size, paths.length);
  for (const [k, id] of ids.entries()) assert.equal(model.find(paths[k]!), id, paths[k]);
  assert.ok(paths.includes('model/asm/left/plate/face#8'), paths.join('\n'));
  assert.ok(paths.includes('model/asm/left/plate/edges'), paths.join('\n'));
  assert.ok(paths.includes('model/asm/left/wire/curves'), paths.join('\n'));
  // Without detail shown, a detail path still finds its node (built for it), and assembly paths are the same.
  const fresh = stepModel();
  fresh.graph.addMesh(0, plate());
  const face = fresh.model.find('model/asm/left/plate/face#7');
  assert.ok(face !== undefined && fresh.model.nodes[face]!.kind === 'face');
  assert.equal(fresh.model.pathOf(face), 'model/asm/left/plate/face#7');
  assert.equal(fresh.model.find('model/asm/left/nothing'), undefined);
  assert.equal(fresh.model.find('model/asm/left/plate/face#99'), undefined);
});

test('paths: same-named siblings numbered from the second; names escaped', () => {
  const root = new THREE.Group();
  root.name = 'top';
  const named = (name: string) => {
    const g = new THREE.Group();
    g.name = name;
    g.add(new THREE.Mesh(new THREE.BoxGeometry()));
    return g;
  };
  const kids = [named('nut'), named('bolt'), named('nut'), named('a/b:c%d'), named('nut')];
  const asm = new THREE.Group();
  asm.name = 'asm';
  asm.add(...kids, new THREE.Group());
  root.add(asm, new THREE.Mesh(new THREE.BoxGeometry()));
  const model = new NodeModel(root);
  const paths = model.children(model.children(model.roots[0]!)[0]!).map((i) => model.pathOf(i));
  assert.deepEqual(paths.slice(0, 5), ['top/asm/nut', 'top/asm/bolt', 'top/asm/nut:2', 'top/asm/a%2Fb%3Ac%25d',
    'top/asm/nut:3']);
  for (const p of paths) assert.equal(model.pathOf(model.find(p)!), p);
  // A three.js part's drawables below it, and its own drawing.
  const part = model.find('top/asm/bolt')!;
  model.setDetail(true);
  assert.deepEqual(model.children(part).map((i) => model.pathOf(i)), ['top/asm/bolt/mesh']);
});

test('hiddenFacePaths: a hidden face below every placement of its part, as its face nodes\' paths, made or not', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  assert.deepEqual(model.hiddenFacePaths(), []);
  // Face 7 of the plate (part 0) hidden: its part is placed three times.
  graph.setFaceHidden(0, 7, true);
  const paths = model.hiddenFacePaths();
  const placements = model.nodes.filter((n) => n.kind === 'part' && n.object?.userData.part === 0);
  assert.equal(placements.length, 3);
  assert.deepEqual(paths, placements.map((n) => `${model.pathOf(n.id)}/face#7`));
  // Each the path of the face node made for it, which is hidden.
  for (const p of paths) {
    const id = model.find(p);
    assert.ok(id !== undefined && model.nodes[id]!.kind === 'face' && model.nodes[id]!.hidden, p);
    assert.equal(model.pathOf(id!), p);
  }
  graph.setFaceHidden(0, 7, false);
  assert.deepEqual(model.hiddenFacePaths(), []);
});
