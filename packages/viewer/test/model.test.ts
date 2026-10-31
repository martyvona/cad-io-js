import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NodeModel } from '../src/model.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { plate, scene, wire } from './fixtures.ts';

/** The STEP fixture with its meshes, and its node model. */
function stepModel() {
  const graph = new SceneGraph(scene(), 'model');
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
  // The file's override hides the placed parts below that occurrence: overrides of their own.
  assert.equal(model.ownOverride(hidden!), undefined);
  assert.deepEqual(model.children(hidden!).map((i) => model.ownOverride(i)), [{ hidden: true }, { hidden: true }]);
  assert.ok(model.children(hidden!).every((i) => !model.nodes[i]!.object!.visible));
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
    // A face split by the backend (two ranges, one source): one node. (The new mesh replaces the plate's first.)
    const split = plate();
    split.faces = [{ source: 8, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }];
    graph.addMesh(0, split);
    model.setDetail(true);
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
    assert.deepEqual(names(model, model.children(platePart!)).filter((n) => n.startsWith('face')), ['face:face #8']);
  });

/** A placement's mesh's faces drawn: [source, visible, opacity] in face order. */
const drawn = (m: THREE.Mesh) => (m.userData.faceRanges as { source: number; start: number }[]).map((r) => {
  const g = m.geometry.groups.find((gr) => gr.start <= r.start && r.start < gr.start + gr.count)!;
  const mat = (m.material as THREE.Material[])[g.materialIndex!]!;
  return [r.source, mat.visible, mat.visible ? mat.opacity : 0];
});

test('hiding: an override inherited below, shown within, cleared below; equal to what it inherits, none', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  const [asm] = model.children(model.roots[0]!);
  const [left] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  const group = (id: number) => model.nodes[id]!.object!;
  model.set([left!], 'hidden', true);
  assert.deepEqual(model.ownOverride(left!), { hidden: true });
  // (Assemblies' groups stay drawn: their parts' are hidden.)
  assert.ok(group(left!).visible && !group(platePart!).visible && !group(wirePart!).visible);
  assert.ok(model.hiddenInTree(platePart!) && model.ownOverride(platePart!) === undefined);
  // Shown within it: an override of its own.
  model.set([platePart!], 'hidden', false);
  assert.deepEqual(model.ownOverride(platePart!), { hidden: false });
  assert.ok(group(platePart!).visible && !group(wirePart!).visible && !model.hiddenInTree(platePart!));
  // Hiding the assembly again clears it below.
  model.set([left!], 'hidden', true);
  assert.equal(model.ownOverride(platePart!), undefined);
  assert.ok(!group(platePart!).visible);
  // Shown: what it inherits (shown), so no override at all; only the file's hidden placements' remain.
  model.set([left!], 'hidden', false);
  assert.equal(model.ownOverride(left!), undefined);
  assert.ok(group(platePart!).visible && group(wirePart!).visible);
  assert.deepEqual(model.overrides().map((o) => [o.path, o.hidden]), [['model/asm/hidden/plate', true],
    ['model/asm/hidden/wire', true]]);
  // Show all clears those too.
  model.showAll();
  assert.deepEqual(model.overrides(), []);
  assert.ok(model.nodes.filter((n) => n.kind === 'part').every((n) => n.object!.visible));
});

test("hiding detail: a placement's edges or faces only; a hidden part's edges shown, its faces drawn with nothing",
  () => {
    const { graph, model } = stepModel();
    const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
    model.setDetail(true);
    const [left, sub] = model.children(model.children(model.roots[0]!)[0]!);
    const plateOf = (a: number) => model.children(a!)[0]!;
    const child = (part: number, name: string) => model.children(part).find((i) => model.nodes[i]!.name === name)!;
    const edgesObj = (m: THREE.Mesh) => m.children.find((c) => c.name === 'edges')!;
    // Face 7 hidden under the first placement only (per placement since 2026-10-31).
    model.set([child(plateOf(left!), 'face #7')], 'hidden', true);
    assert.deepEqual(drawn(meshes[0]!), [[8, true, 1], [7, false, 0]]);
    assert.deepEqual(drawn(meshes[1]!).map((f) => f[1]), [true, true]);
    assert.equal(model.hiddenInTree(child(plateOf(sub!), 'face #7')), false);
    // The edges of the second placement only.
    model.set([child(plateOf(sub!), 'edges')], 'hidden', true);
    assert.ok(edgesObj(meshes[0]!).visible && !edgesObj(meshes[1]!).visible);
    // The first placement hidden whole clears its face's override; its edges shown within it: the group drawn, its
    // faces with nothing.
    model.set([plateOf(left!)], 'hidden', true);
    assert.equal(model.ownOverride(child(plateOf(left!), 'face #7')), undefined);
    assert.ok(!meshes[0]!.parent!.visible);
    model.set([child(plateOf(left!), 'edges')], 'hidden', false);
    assert.ok(meshes[0]!.parent!.visible && edgesObj(meshes[0]!).visible);
    assert.deepEqual(drawn(meshes[0]!).map((f) => f[1]), [false, false]);
    // A face shown within the second placement hidden: the group drawn, that face only (its edges hidden with it).
    model.set([plateOf(sub!)], 'hidden', true);
    model.set([child(plateOf(sub!), 'face #8')], 'hidden', false);
    assert.ok(meshes[1]!.parent!.visible && !edgesObj(meshes[1]!).visible);
    assert.deepEqual(drawn(meshes[1]!).map((f) => f[1]), [true, false]);
    model.set([plateOf(sub!)], 'hidden', false);
    model.set([child(plateOf(sub!), 'edges')], 'hidden', true);
    // Overrides by path: a part's detail after it, by segment.
    assert.deepEqual(model.overrides().map((o) => [o.path, o.hidden]), [['model/asm/left/plate', true],
      ['model/asm/left/plate/edges', false], ['model/asm/sub/plate/edges', true], ['model/asm/hidden/plate', true],
      ['model/asm/hidden/wire', true]]);
    // Its detail outlives a new mesh (the nodes are made again).
    graph.addMesh(0, plate());
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
    const again = graph.placements.get(0)!.map((p) => p.group.children.find((c) => c.userData.faces)! as THREE.Mesh);
    assert.ok(again[0]!.parent!.visible && edgesObj(again[0]!).visible && !edgesObj(again[1]!).visible);
  });

test('cover: every child given stands for its parent, up the tree; nothing below another given', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  model.setDetail(true);
  const [asm] = model.children(model.roots[0]!);
  const [left, sub, hidden] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  // A part's whole detail: the part.
  assert.deepEqual(model.cover(model.children(platePart!)), [platePart]);
  assert.deepEqual(model.cover(model.children(platePart!).slice(1)), model.children(platePart!).slice(1));
  // Both parts of a placement: it; all three placements: the assembly, and so the root (its only child).
  assert.deepEqual(model.cover([platePart!, wirePart!]), [left]);
  assert.deepEqual(model.cover([left!, sub!, hidden!]), [model.roots[0]]);
  // Below another given: left out.
  assert.deepEqual(model.cover([left!, platePart!, sub!]), [left, sub]);
  // Two parts of different placements: each.
  assert.deepEqual(model.cover([platePart!, model.children(sub!)[1]!]), [platePart, model.children(sub!)[1]]);
});

test('opacity: inherited below, a face\'s own winning, per placement; 1 the file\'s, cleared below', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
  model.setDetail(true);
  const [left, sub] = model.children(model.children(model.roots[0]!)[0]!);
  const platePart = model.children(left!)[0]!;
  const face8 = model.children(platePart).find((i) => model.nodes[i]!.name === 'face #8')!;
  const before = meshes.map((m) => drawn(m));
  model.set([left!], 'alpha', 0.3);
  assert.deepEqual(drawn(meshes[0]!), [[8, true, 0.3], [7, true, 0.3]]);
  assert.deepEqual(drawn(meshes[1]!), before[1]);
  model.set([face8], 'alpha', 0.6);
  assert.deepEqual(drawn(meshes[0]!), [[8, true, 0.6], [7, true, 0.3]]);
  assert.equal(model.look(face8).alpha, 0.6);
  // Restored (1, the file's) on the assembly: cleared below, and none of its own (it inherits the file's).
  model.set([left!], 'alpha', 1);
  assert.deepEqual([model.ownOverride(left!), model.ownOverride(face8)], [undefined, undefined]);
  assert.deepEqual(meshes.map((m) => drawn(m)), before);
  // Restored within a transparent assembly: 1 of its own.
  model.set([sub!], 'alpha', 0.4);
  const subPlate = model.children(sub!)[0]!;
  model.set([subPlate], 'alpha', 1);
  assert.deepEqual(model.ownOverride(subPlate), { alpha: 1 });
  assert.deepEqual(drawn(meshes[1]!), before[1]);
  // Hiding leaves opacity as it is, and show all too.
  model.set([sub!], 'hidden', true);
  model.showAll();
  assert.deepEqual(model.ownOverride(sub!), { alpha: 0.4 });
});

test('setOverrides: exactly these, of these slots; detail paths before the mesh arrives; paths that name nothing', () => {
  const a = stepModel();
  a.graph.addMesh(0, plate());
  a.model.setDetail(true);
  const [left, sub] = a.model.children(a.model.children(a.model.roots[0]!)[0]!);
  a.model.set([left!], 'alpha', 0.3);
  a.model.set([a.model.children(a.model.children(sub!)[0]!).find((i) => a.model.nodes[i]!.name === 'face #7')!],
    'hidden', true);
  const list = a.model.overrides();
  // A fresh model, its meshes not there yet: the same overrides, the face's drawn so once its mesh is (the second
  // placement red at 0.5 by the file's override).
  const b = stepModel();
  assert.deepEqual(b.model.setOverrides([...list, { path: 'model/nowhere', hidden: true }]), ['model/nowhere']);
  assert.deepEqual(b.model.overrides(), list);
  const meshes = b.graph.addMesh(0, plate()) as THREE.Mesh[];
  for (const p of b.graph.placements.get(0)!) b.model.invalidate(p.group);
  assert.deepEqual(meshes.slice(0, 2).map((m) => drawn(m)), [[[8, true, 0.3], [7, true, 0.3]],
    [[8, true, 0.5], [7, false, 0]]]);
  // Only one slot: the other's overrides kept.
  b.model.setOverrides([], ['hidden']);
  assert.deepEqual(b.model.overrides(), [{ path: 'model/asm/left', alpha: 0.3 }]);
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
  // (Placed parts' groups as the scene graph marks them, each with its mesh.)
  const named = (name: string) => {
    const g = new THREE.Group();
    g.name = name;
    g.userData = { cad: 'part', part: 0 };
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry()), { userData: { faces: [3] } }));
    return g;
  };
  const kids = [named('nut'), named('bolt'), named('nut'), named('a/b:c%d'), named('nut')];
  const asm = new THREE.Group();
  asm.name = 'asm';
  asm.add(...kids, new THREE.Group());
  root.add(asm, named('loose'));
  const model = new NodeModel(root);
  const paths = model.children(model.children(model.roots[0]!)[0]!).map((i) => model.pathOf(i));
  assert.deepEqual(paths.slice(0, 5), ['top/asm/nut', 'top/asm/bolt', 'top/asm/nut:2', 'top/asm/a%2Fb%3Ac%25d',
    'top/asm/nut:3']);
  for (const p of paths) assert.equal(model.pathOf(model.find(p)!), p);
  // A part's faces below it.
  const part = model.find('top/asm/bolt')!;
  model.setDetail(true);
  assert.deepEqual(model.children(part).map((i) => model.pathOf(i)), ['top/asm/bolt/face#3']);
});

test('others: the siblings of the selection and of each ancestor', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  model.setDetail(true);
  const [asm] = model.children(model.roots[0]!);
  const [left, sub, hidden] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  // A part: its sibling part, and the other placements of the subassembly.
  assert.deepEqual(model.others([platePart!]).sort(), [wirePart!, sub!, hidden!].sort());
  // A face: the part's other faces and its edges too.
  const face = model.children(platePart!).find((c) => model.nodes[c]!.name === 'face #8')!;
  const others = model.others([face]);
  assert.ok(!others.includes(face) && !others.includes(platePart!) && !others.includes(left!));
  assert.deepEqual(names(model, others.filter((c) => model.nodes[c]!.parent === platePart!)),
    ['face:face #7', 'edges:edges']);
  assert.ok(others.includes(wirePart!) && others.includes(sub!) && others.includes(hidden!));
  // Two selected under one assembly: neither the other's other.
  assert.deepEqual(model.others([platePart!, wirePart!]).sort(), [sub!, hidden!].sort());
});
