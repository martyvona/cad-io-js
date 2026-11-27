import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { BrepBuilder } from 'cad-brep';
import { rangeOf } from '../src/items.ts';
import { NodeModel } from '../src/model.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { REVEAL, VERTICES } from '../src/style.ts';
import { TriangleEdges } from '../src/triangle-edges.ts';
import { plate, scene, wire } from './fixtures.ts';

/** The STEP fixture with its meshes, and its node model. */
function stepModel() {
  const graph = new SceneGraph(scene(), 'model');
  const model = new NodeModel(graph.root, graph);
  return { graph, model };
}
const names = (m: NodeModel, ids: readonly number[]) => ids.map((i) => `${m.nodes[i]!.kind}:${m.nodes[i]!.name}`);
/** A part's detail: each group, and its nodes. */
const detail = (m: NodeModel, part: number) => m.children(part).map((g) => `${m.nodes[g]!.name}: ${
  names(m, m.children(g)).join(', ')}`);
/** A part's detail node by name: a group or a node in one. */
const nodeIn = (m: NodeModel, part: number, name: string) => m.children(part).flatMap((g) => [g, ...m.children(g)])
  .find((i) => m.nodes[i]!.name === name)!;

test('STEP: assemblies and parts, the file hidden placement hidden, no detail until asked for', () => {
  const { model } = stepModel();
  assert.deepEqual(names(model, model.roots), ['assembly:asm']);
  const [asm] = model.roots;
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

test("STEP detail: a part's faces (once each), edges (curves too) and vertices (points too) in groups; built again "
  + 'when meshes arrive',
  () => {
    const { graph, model } = stepModel();
    model.setDetail(true);
    const left = model.children(model.roots[0]!)[0]!;
    const [platePart, wirePart] = model.children(left);
    assert.deepEqual(model.children(platePart!), []);
    graph.addMesh(0, plate());
    graph.addMesh(1, wire());
    for (const p of [...graph.placements.get(0)!, ...graph.placements.get(1)!]) model.invalidate(p.group);
    assert.equal(model.hasChildren(platePart!), true);
    // (The plate's seam isn't drawn: no node.)
    assert.deepEqual(detail(model, platePart!), ['faces: face:face #8, face:face #7', 'edges: edge:edge #4']);
    assert.deepEqual(detail(model, wirePart!), ['edges: curve:curve #9', 'vertices: point:point #11']);
    model.setDetail(false);
    assert.deepEqual(model.children(platePart!), []);
    assert.equal(model.hasChildren(platePart!), false);
    // A face split by the backend (two ranges, one source): one node. (The new mesh replaces the plate's first.)
    const split = plate();
    split.faces = [{ source: 8, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }];
    graph.addMesh(0, split);
    model.setDetail(true);
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
    assert.deepEqual(detail(model, platePart!)[0], 'faces: face:face #8');
  });

test("detail made again for a new mesh (Mesh again): each node keeps its id by path, the rest dead and found by "
  + 'nothing', () => {
  const { graph, model } = stepModel();
  model.setDetail(true);
  const platePart = model.children(model.children(model.roots[0]!)[0]!)[0]!;
  const again = (faces: { source: number; start: number; count: number }[], edges = true) => {
    const mesh = plate();
    mesh.faces = faces;
    if (!edges) delete mesh.edgePositions;
    graph.addMesh(0, mesh);
    for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  };
  again([{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }]);
  const all = () => model.children(platePart).flatMap((g) => [g, ...model.children(g)]);
  const first = all();
  const id = (name: string, ids = all()) => ids.find((k) => model.nodes[k]!.name === name);
  const [f8, f7, edges, edge4] = [id('face #8')!, id('face #7')!, id('edges')!, id('edge #4')!];
  const path7 = model.pathOf(f7);
  // Face 7 gone, face 9 new, the edges kept: 8, the groups and the edge keep their ids, 9 a new one, 7's dead.
  again([{ source: 8, start: 0, count: 3 }, { source: 9, start: 3, count: 3 }]);
  const second = all();
  assert.deepEqual(names(model, second), ['faces:faces', 'face:face #8', 'face:face #9', 'edges:edges',
    'edge:edge #4']);
  assert.equal(id('face #8', second), f8);
  assert.equal(id('edges', second), edges);
  assert.equal(id('edge #4', second), edge4);
  assert.ok(!first.includes(id('face #9', second)!));
  assert.equal(model.nodes[f7]!.dead, true);
  assert.equal(model.find(path7), undefined);
  assert.equal(model.nodes.filter((n) => !n.dead && n.parent === platePart).length, 2);
  // The edges group is the new line object's (a pick of it finds the group), its edge an item of it.
  const lines = graph.placements.get(0)![0]!.group.children[0]!.children.find((c) => c.name === 'edges')!;
  assert.deepEqual(model.nodes[edges]!.members, [lines]);
  assert.equal(model.nodeOf(lines), edges);
  assert.equal(model.nodes[edge4]!.item!.object, lines);
  // Before its detail is made again, the old detail is dead already; face 7 back: a new id, the dead one left so.
  for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  assert.ok(second.every((k) => model.nodes[k]!.dead));
  again([{ source: 7, start: 0, count: 3 }, { source: 8, start: 3, count: 3 }]);
  const third = all();
  assert.equal(id('face #8', third), f8);
  assert.notEqual(id('face #7', third), f7);
  assert.equal(model.nodes[f7]!.dead, true);
});

/** A placement's mesh's faces drawn: [source, visible, opacity] in face order. */
const drawn = (m: THREE.Mesh) => (m.userData.faceRanges as { source: number; start: number }[]).map((r) => {
  const g = m.geometry.groups.find((gr) => gr.start <= r.start && r.start < gr.start + gr.count)!;
  const mat = (m.material as THREE.Material[])[g.materialIndex!]!;
  return [r.source, mat.visible, mat.visible ? mat.opacity : 0];
});

test('hiding: an override inherited below, shown within, kept below; equal to what it inherits, none', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  const [asm] = model.roots;
  const [left] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  const group = (id: number) => model.nodes[id]!.object!;
  model.setHidden([left!], true);
  assert.deepEqual(model.ownOverride(left!), { hidden: true });
  // (Assemblies' groups stay drawn: their parts' are hidden.)
  assert.ok(group(left!).visible && !group(platePart!).visible && !group(wirePart!).visible);
  assert.ok(model.hiddenInTree(platePart!) && model.ownOverride(platePart!) === undefined);
  // Shown within it: an override of its own.
  model.setHidden([platePart!], false);
  assert.deepEqual(model.ownOverride(platePart!), { hidden: false });
  assert.ok(group(platePart!).visible && !group(wirePart!).visible && !model.hiddenInTree(platePart!));
  // Hiding the assembly again leaves it as it is (first cleared below).
  model.setHidden([left!], true);
  assert.deepEqual(model.ownOverride(platePart!), { hidden: false });
  assert.ok(group(platePart!).visible && !group(wirePart!).visible);
  // Shown: what it inherits (shown), so no override of its own; the part's kept, and the file's hidden placements'.
  model.setHidden([left!], false);
  assert.equal(model.ownOverride(left!), undefined);
  assert.ok(group(platePart!).visible && group(wirePart!).visible);
  assert.deepEqual(model.overrides().map((o) => [o.path, o.hidden]), [['asm/left/plate', false],
    ['asm/hidden/plate', true], ['asm/hidden/wire', true]]);
  // The part hidden: it inherits shown, so hidden is its own.
  model.setHidden([platePart!], true);
  assert.deepEqual(model.ownOverride(platePart!), { hidden: true });
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
    const [left, sub] = model.children(model.roots[0]!);
    const plateOf = (a: number) => model.children(a!)[0]!;
    const child = (part: number, name: string) => nodeIn(model, part, name);
    const edgesObj = (m: THREE.Mesh) => m.children.find((c) => c.name === 'edges')!;
    // Face 7 hidden under the first placement only (per placement since 2026-10-31).
    model.setHidden([child(plateOf(left!), 'face #7')], true);
    assert.deepEqual(drawn(meshes[0]!), [[8, true, 1], [7, false, 0]]);
    assert.deepEqual(drawn(meshes[1]!).map((f) => f[1]), [true, true]);
    assert.equal(model.hiddenInTree(child(plateOf(sub!), 'face #7')), false);
    // The edges of the second placement only.
    model.setHidden([child(plateOf(sub!), 'edges')], true);
    assert.ok(edgesObj(meshes[0]!).visible && !edgesObj(meshes[1]!).visible);
    // The first placement hidden whole keeps its face's override; its edges shown within it: the group drawn, its
    // faces with nothing.
    model.setHidden([plateOf(left!)], true);
    assert.deepEqual(model.ownOverride(child(plateOf(left!), 'face #7')), { hidden: true });
    assert.ok(!meshes[0]!.parent!.visible);
    model.setHidden([child(plateOf(left!), 'edges')], false);
    assert.ok(meshes[0]!.parent!.visible && edgesObj(meshes[0]!).visible);
    assert.deepEqual(drawn(meshes[0]!).map((f) => f[1]), [false, false]);
    // A face shown within the second placement hidden: the group drawn, that face only (its edges hidden with it).
    model.setHidden([plateOf(sub!)], true);
    model.setHidden([child(plateOf(sub!), 'face #8')], false);
    assert.ok(meshes[1]!.parent!.visible && !edgesObj(meshes[1]!).visible);
    assert.deepEqual(drawn(meshes[1]!).map((f) => f[1]), [true, false]);
    model.setHidden([plateOf(sub!)], false);
    model.setHidden([child(plateOf(sub!), 'edges')], true);
    // Overrides by path: a part's detail after it, by its path below it.
    // (The second placement's face 8 keeps the show it was given inside the hidden placement.)
    assert.deepEqual(model.overrides().map((o) => [o.path, o.hidden]), [['asm/left/plate', true],
      ['asm/left/plate/edges', false], ['asm/left/plate/faces/face#7', true],
      ['asm/sub/plate/edges', true], ['asm/sub/plate/faces/face#8', false], ['asm/hidden/plate', true],
      ['asm/hidden/wire', true]]);
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
  const [asm] = model.roots;
  const [left, sub, hidden] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  // A part's whole detail: the part; a group's every node: the group, and every group's: the part.
  const [faces, edges] = model.children(platePart!);
  assert.deepEqual(model.cover(model.children(platePart!)), [platePart]);
  assert.deepEqual(model.cover(model.children(platePart!).slice(1)), model.children(platePart!).slice(1));
  assert.deepEqual(model.cover(model.children(faces!)), [faces]);
  assert.deepEqual(model.cover([...model.children(faces!), ...model.children(edges!)]), [platePart]);
  assert.deepEqual(model.cover(model.children(faces!).slice(1)), model.children(faces!).slice(1));
  // Both parts of a placement: it; all three placements: the assembly, and so the root (its only child).
  assert.deepEqual(model.cover([platePart!, wirePart!]), [left]);
  assert.deepEqual(model.cover([left!, sub!, hidden!]), [model.roots[0]]);
  // Below another given: left out.
  assert.deepEqual(model.cover([left!, platePart!, sub!]), [left, sub]);
  // Two parts of different placements: each.
  assert.deepEqual(model.cover([platePart!, model.children(sub!)[1]!]), [platePart, model.children(sub!)[1]]);
});

test('opacity: inherited below, a face\'s own winning, per placement; default the file\'s, kept below', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
  model.setDetail(true);
  const [left, sub] = model.children(model.roots[0]!);
  const platePart = model.children(left!)[0]!;
  const face8 = nodeIn(model, platePart, 'face #8');
  const before = meshes.map((m) => drawn(m));
  model.setOpacity([left!], 0.3);
  assert.deepEqual(drawn(meshes[0]!), [[8, true, 0.3], [7, true, 0.3]]);
  assert.deepEqual(drawn(meshes[1]!), before[1]);
  model.setOpacity([face8], 0.6);
  assert.deepEqual(drawn(meshes[0]!), [[8, true, 0.6], [7, true, 0.3]]);
  assert.equal(model.look(face8).alpha, 0.6);
  // Restored on the assembly (the file's): none of its own (it inherits the file's), the face's kept.
  model.setOpacity([left!], 'default');
  assert.deepEqual([model.ownOverride(left!), model.ownOverride(face8)], [undefined, { transparent: true,
    alpha: 0.6 }]);
  assert.deepEqual(drawn(meshes[0]!), [[8, true, 0.6], before[0]![1]]);
  // Restored within a transparent assembly: the file's of its own.
  model.setOpacity([sub!], 0.4);
  const subPlate = model.children(sub!)[0]!;
  model.setOpacity([subPlate], 'default');
  assert.deepEqual(model.ownOverride(subPlate), { transparent: false });
  assert.deepEqual(drawn(meshes[1]!), before[1]);
  // Hiding leaves opacity as it is, and show all too.
  model.setHidden([sub!], true);
  model.showAll();
  assert.deepEqual(model.ownOverride(sub!), { transparent: true, alpha: 0.4 });
  // One node's override exactly (Override Appearance...): an opacity of 1 is its own, not the file's.
  model.setOverride(subPlate, { hidden: false, transparent: true, alpha: 1 });
  assert.deepEqual(model.look(subPlate), { hidden: false, alpha: 1 });
  assert.deepEqual(drawn(meshes[1]!).map((f) => f[2]), [1, 1]);
  // An alpha only with transparent: true (a recording edited by hand could give one with false).
  model.setOverride(subPlate, { transparent: false, alpha: 0.3 });
  assert.deepEqual(model.ownOverride(subPlate), { transparent: false });
  model.setOverride(subPlate, {});
  assert.equal(model.ownOverride(subPlate), undefined);
  assert.equal(model.look(subPlate).alpha, 0.4);
});

test('triangle edges: inherited, a face\'s own; the placement\'s look on its group; drawn over the mode', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
  for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  model.setDetail(true);
  const [left, sub] = model.children(model.roots[0]!);
  const plateOf = (a: number) => model.children(a!)[0]!;
  const face7 = nodeIn(model, plateOf(sub!), 'face #7');
  assert.equal(model.hasTriangleEdges(), false);
  // (The file's hidden third placement shown, to be drawn.)
  model.showAll();
  model.setOverride(left!, { triangleEdges: true });
  assert.equal(model.hasTriangleEdges(), true);
  model.setOverride(face7, { triangleEdges: true });
  model.setOverride(plateOf(sub!), { triangleEdges: false });
  assert.equal(model.hasTriangleEdges(), true);
  assert.deepEqual([model.look(plateOf(left!)).triangleEdges, model.look(face7).triangleEdges], [true, true]);
  assert.deepEqual(meshes[0]!.parent!.userData.triangleEdges, { whole: true });
  assert.deepEqual(meshes[1]!.parent!.userData.triangleEdges, { whole: false, faces: new Map([[7, true]]) });
  assert.deepEqual(meshes[2]!.parent!.userData.triangleEdges, {});
  // Drawn with Rendering's Triangle edges off: the first placement whole, the second's face 7 alone, the third none;
  // with All, the third too (nothing sets it), the second still its face 7 only.
  const edges = new TriangleEdges();
  graph.root.updateWorldMatrix(true, true);
  const drawnFor = (mode: 'off' | 'all') => {
    edges.invalidate();
    edges.update(graph.root, mode, true);
    return meshes.map((m) => {
      // (Each wireframe at its mesh's place: the placements share one position buffer.)
      const wires = edges.group.children.filter((w) => w.matrixWorld.equals(m.matrixWorld)) as THREE.Mesh[];
      return wires.map((w) => (w.geometry === m.geometry ? 'whole' : Array.from(w.geometry.index!.array).join()));
    });
  };
  // (Face 7 the plate's second triangle, of vertices 0, 2, 3.)
  assert.deepEqual(drawnFor('off'), [['whole'], ['0,2,3'], []]);
  assert.deepEqual(drawnFor('all'), [['whole'], ['0,2,3'], ['whole']]);
  // Nothing set and the mode off: nothing shown.
  edges.update(graph.root, 'off', false);
  assert.equal(edges.group.visible, false);
});

test('setOverrides: exactly these, of these slots; detail paths before the mesh arrives; paths that name nothing', () => {
  const a = stepModel();
  a.graph.addMesh(0, plate());
  a.model.setDetail(true);
  const [left, sub] = a.model.children(a.model.roots[0]!);
  a.model.setOpacity([left!], 0.3);
  a.model.setHidden([nodeIn(a.model, a.model.children(sub!)[0]!, 'face #7')], true);
  const list = a.model.overrides();
  // A fresh model, its meshes not there yet: the same overrides, the face's drawn so once its mesh is (the second
  // placement red at 0.5 by the file's override).
  const b = stepModel();
  assert.deepEqual(b.model.setOverrides([...list, { path: 'nowhere', hidden: true }]), ['nowhere']);
  assert.deepEqual(b.model.overrides(), list);
  const meshes = b.graph.addMesh(0, plate()) as THREE.Mesh[];
  for (const p of b.graph.placements.get(0)!) b.model.invalidate(p.group);
  assert.deepEqual(meshes.slice(0, 2).map((m) => drawn(m)), [[[8, true, 0.3], [7, true, 0.3]],
    [[8, true, 0.5], [7, false, 0]]]);
  // Only one slot: the other's overrides kept.
  b.model.setOverrides([], ['hidden']);
  assert.deepEqual(b.model.overrides(), [{ path: 'asm/left', transparent: true, alpha: 0.3 }]);
  // Older paths, a face's below its part and the one-node curves and points, read as they're named now; a detail
  // path of no known form names nothing.
  const c = stepModel();
  assert.deepEqual(c.model.setOverrides([{ path: 'asm/sub/plate/face#7', hidden: true },
    { path: 'asm/sub/wire/curves', hidden: true }, { path: 'asm/sub/wire/points', hidden: true },
    { path: 'asm/sub/plate/edges/edge#4', hidden: true }, { path: 'asm/sub/plate/bolts', hidden: true }]),
  ['asm/sub/plate/bolts']);
  assert.deepEqual(c.model.overrides().map((o) => o.path).filter((p) => p.startsWith('asm/sub/')), [
    'asm/sub/plate/edges/edge#4', 'asm/sub/plate/faces/face#7', 'asm/sub/wire/edges', 'asm/sub/wire/vertices']);
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
  for (const p of ['asm/left/plate/faces', 'asm/left/plate/faces/face#8', 'asm/left/plate/edges',
    'asm/left/plate/edges/edge#4', 'asm/left/wire/edges/curve#9', 'asm/left/wire/vertices/point#11']) {
    assert.ok(paths.includes(p), `${p}: ${paths.join('\n')}`);
  }
  // Without detail shown, a detail path still finds its node (built for it), and assembly paths are the same.
  const fresh = stepModel();
  fresh.graph.addMesh(0, plate());
  fresh.graph.addMesh(1, wire());
  const face = fresh.model.find('asm/left/plate/faces/face#7');
  assert.ok(face !== undefined && fresh.model.nodes[face]!.kind === 'face');
  assert.equal(fresh.model.pathOf(face), 'asm/left/plate/faces/face#7');
  assert.equal(fresh.model.find('asm/left/nothing'), undefined);
  assert.equal(fresh.model.find('asm/left/plate/faces/face#99'), undefined);
  // Older paths: a face's below its part, the one-node curves and points (their groups now).
  assert.equal(fresh.model.find('asm/left/plate/face#7'), face);
  assert.equal(fresh.model.find('asm/left/wire/curves'), fresh.model.find('asm/left/wire/edges'));
  assert.equal(fresh.model.pathOf(fresh.model.find('asm/left/wire/points')!), 'asm/left/wire/vertices');
});

test("paths: the file's roots at the top, no node for the file; same-named siblings numbered; names escaped", () => {
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
  // Two roots, an assembly and a placed part: both at the top, the group they're in (the file) no node.
  assert.deepEqual(model.roots.map((i) => model.pathOf(i)), ['asm', 'loose']);
  assert.equal(model.nodes.some((n) => n.object === root), false);
  const paths = model.children(model.roots[0]!).map((i) => model.pathOf(i));
  assert.deepEqual(paths.slice(0, 5), ['asm/nut', 'asm/bolt', 'asm/nut:2', 'asm/a%2Fb%3Ac%25d', 'asm/nut:3']);
  for (const p of paths) assert.equal(model.pathOf(model.find(p)!), p);
  // A part's faces below it.
  const part = model.find('asm/bolt')!;
  model.setDetail(true);
  assert.deepEqual(model.children(part).map((i) => model.pathOf(i)), ['asm/bolt/faces']);
  assert.deepEqual(model.children(model.children(part)[0]!).map((i) => model.pathOf(i)), ['asm/bolt/faces/face#3']);
});

test('others: the siblings of the selection and of each ancestor', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  model.setDetail(true);
  const [asm] = model.roots;
  const [left, sub, hidden] = model.children(asm!);
  const [platePart, wirePart] = model.children(left!);
  // A part: its sibling part, and the other placements of the subassembly.
  assert.deepEqual(model.others([platePart!]).sort(), [wirePart!, sub!, hidden!].sort());
  // A face: the part's other faces and its edges too (the group, whole).
  const face = nodeIn(model, platePart!, 'face #8');
  const others = model.others([face]);
  assert.ok(!others.includes(face) && !others.includes(platePart!) && !others.includes(left!));
  assert.deepEqual(names(model, others.filter((c) => model.partOf(c) === platePart! && c !== platePart)),
    ['face:face #7', 'edges:edges']);
  assert.ok(others.includes(wirePart!) && others.includes(sub!) && others.includes(hidden!));
  // Two selected under one assembly: neither the other's other.
  assert.deepEqual(model.others([platePart!, wirePart!]).sort(), [sub!, hidden!].sort());
});

/** The plate with a second B-rep edge (5, free): two edge items. */
const twoEdges = () => {
  const m = plate();
  m.edges = [...m.edges!, { source: 5, start: 3, count: 2, kind: 'free' }];
  return m;
};

test('hiding edges one by one: its placement drawn without them, the group hidden when all are; shown within a '
  + 'hidden group', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, twoEdges()) as THREE.Mesh[];
  model.setDetail(true);
  const [left, sub] = model.children(model.roots[0]!);
  const plateOf = (a: number) => model.children(a)[0]!;
  const lines = (m: THREE.Mesh) => m.children.find((c) => c.name === 'edges') as THREE.LineSegments;
  const full = lines(meshes[0]!).geometry;
  // (Each edge one segment: the index's pairs, as drawn.)
  const pairs = (l: THREE.LineSegments) => l.visible ? Array.from(l.geometry.index!.array).join() : 'hidden';
  assert.equal(pairs(lines(meshes[0]!)), '0,1,3,4');
  model.setHidden([nodeIn(model, plateOf(left!), 'edge #5')], true);
  assert.deepEqual([pairs(lines(meshes[0]!)), pairs(lines(meshes[1]!))], ['0,1', '0,1,3,4']);
  // (Its range as drawn: none while hidden; the other's where it is now.)
  const e4 = model.nodes[nodeIn(model, plateOf(left!), 'edge #4')]!.item!;
  const e5 = model.nodes[nodeIn(model, plateOf(left!), 'edge #5')]!.item!;
  assert.deepEqual([rangeOf(e4.object, e4.k), rangeOf(e5.object, e5.k)], [{ start: 0, count: 2 }, undefined]);
  // Both: the object hidden. Given together, every edge of the group: the group hidden instead (cover).
  model.setHidden([nodeIn(model, plateOf(left!), 'edge #4')], true);
  assert.equal(pairs(lines(meshes[0]!)), 'hidden');
  model.showAll();
  model.setHidden([nodeIn(model, plateOf(left!), 'edge #4'), nodeIn(model, plateOf(left!), 'edge #5')], true);
  assert.equal(pairs(lines(meshes[0]!)), 'hidden');
  assert.deepEqual(model.overrides().filter((o) => o.path.startsWith('asm/left/plate/')).map((o) => o.path),
    ['asm/left/plate/edges']);
  // One shown within the hidden group.
  model.setHidden([nodeIn(model, plateOf(left!), 'edge #5')], false);
  assert.equal(pairs(lines(meshes[0]!)), '3,4');
  // All shown again: the full geometry back.
  model.showAll();
  assert.equal(lines(meshes[0]!).geometry, full);
  // The part hidden, an edge shown within it: the placement drawn, that edge only.
  model.setHidden([plateOf(sub!)], true);
  model.setHidden([nodeIn(model, plateOf(sub!), 'edge #4')], false);
  assert.ok(meshes[1]!.parent!.visible);
  assert.equal(pairs(lines(meshes[1]!)), '0,1');
});

test("vertices: a part's B-rep vertices once the page holds its model, a node each by id; the same model again "
  + 'changes nothing', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
  model.setDetail(true);
  const platePart = model.children(model.children(model.roots[0]!)[0]!)[0]!;
  assert.deepEqual(detail(model, platePart).map((g) => g.split(':')[0]), ['faces', 'edges']);
  const held = () => {
    const b = new BrepBuilder();
    b.addVertex({ point: [25.4, 0, 0], id: 21 });
    b.addVertex({ point: [50.8, 25.4, 0], id: 22 });
    return { model: b.finish().buffer };
  };
  const changed = graph.holdModel(0, held());
  assert.equal(changed.length, meshes.length);
  for (const p of graph.placements.get(0)!) model.invalidate(p.group);
  assert.deepEqual(detail(model, platePart)[2], 'vertices: vertex:vertex #21, vertex:vertex #22');
  assert.equal(model.pathOf(nodeIn(model, platePart, 'vertex #22')), 'asm/left/plate/vertices/vertex#22');
  // The dots: in the mesh's coordinates (minus its origin, 25.4 along x), on their layer.
  const dots = meshes[0]!.children.find((c) => c.name === 'vertices') as THREE.Points;
  assert.deepEqual(Array.from(dots.geometry.getAttribute('position').array), [0, 0, 0, 25.4, 25.4, 0].map(Math.fround));
  assert.equal(dots.layers.mask, 1 << VERTICES);
  // Hiding one: its dot gone from its placement.
  model.setHidden([nodeIn(model, platePart, 'vertex #21')], true);
  assert.deepEqual(Array.from(dots.geometry.index!.array), [1]);
  // A model with the same vertices (back from an export): nothing changed.
  assert.deepEqual(graph.holdModel(0, held()), []);
  assert.equal(meshes[0]!.children.find((c) => c.name === 'vertices'), dots);
});

test('loading: a part still to be meshed (every placement of it) and what holds it; none once done, its detail never',
  () => {
  const { graph, model } = stepModel();
  const [asm] = model.roots;
  const [left, sub] = model.children(asm!);
  const [plateNode, wireNode] = model.children(left!);
  const index = (id: number) => model.nodes[id]!.object!.userData.part as number;
  assert.equal(model.loading(asm!), false, 'no parts given: none');
  const parts = new Set([index(plateNode!)]);
  let version = 1;
  model.loadingParts = () => ({ parts, version });
  const all = model.nodes.filter((n) => model.loading(n.id)).map((n) => n.id);
  // Every placement of the plate, and their assemblies up to the root; the wire not.
  const plates = model.nodes.filter((n) => n.kind === 'part' && index(n.id) === index(plateNode!)).map((n) => n.id);
  const expected = new Set<number>();
  for (const p of plates) for (let k = p; k >= 0; k = model.nodes[k]!.parent) expected.add(k);
  assert.deepEqual(new Set(all), expected);
  assert.ok(plates.length > 1 && all.includes(asm!) && all.includes(left!) && !all.includes(wireNode!));
  // A change seen by its version; the same version kept as it was; none left, none.
  parts.clear();
  parts.add(index(wireNode!));
  assert.equal(model.loading(wireNode!), false);
  version++;
  assert.deepEqual([model.loading(wireNode!), model.loading(plateNode!)], [true, false]);
  parts.clear();
  assert.equal(model.loading(asm!), false);
  // The part's detail, once it has a mesh: not loading, the part is.
  graph.addMesh(index(plateNode!), plate());
  model.setDetail(true);
  parts.add(index(plateNode!));
  version++;
  const faces = model.children(plateNode!).flatMap((g) => [g, ...model.children(g)]);
  assert.ok(faces.length > 0 && faces.every((f) => !model.loading(f)) && model.loading(plateNode!));
  void sub;
});

test('detected mesh edges: a node of their own beside the edges group, shown and hidden apart from the B-rep edges; '
  + 'the older path read', () => {
  const { graph, model } = stepModel();
  const [asm] = model.roots;
  const [left] = model.children(asm!);
  const [plateNode] = model.children(left!);
  const part = model.nodes[plateNode!]!.object!.userData.part as number;
  graph.addMesh(part, plate());
  graph.setFoundEdges(part, Float32Array.of(0, 0, 0, 1, 0, 0));
  for (const p of graph.placements.get(part)!) model.invalidate(p.group);
  model.setDetail(true);
  const kids = model.children(plateNode!);
  assert.deepEqual(kids.map((k) => `${model.nodes[k]!.kind}:${model.nodes[k]!.name}`),
    ['faces:faces', 'edges:edges', 'edge:detected mesh edges', 'vertices:vertices'].filter((x) =>
      kids.some((k) => `${model.nodes[k]!.kind}:${model.nodes[k]!.name}` === x)));
  const detected = kids.find((k) => model.nodes[k]!.name === 'detected mesh edges')!;
  const edges = kids.find((k) => model.nodes[k]!.kind === 'edges')!;
  assert.ok(kids.indexOf(detected) === kids.indexOf(edges) + 1);
  const path = model.pathOf(detected);
  assert.ok(path.endsWith('/detected'), path);
  assert.equal(model.find(path), detected);
  assert.equal(model.find(path.replace(/detected$/, 'edges/found')), detected);
  // Its line object picks it.
  const line = model.nodes[detected]!.item!.object;
  assert.equal(model.nodeOf(line), detected);
  const brep = (model.nodes[edges]!.members ?? [])[0]!;
  // The edges group hidden: the detected edges still drawn; they hidden: the B-rep edges drawn.
  model.setHidden([edges], true);
  assert.deepEqual([brep.visible, line.visible], [false, true]);
  model.setHidden([edges], false);
  model.setHidden([detected], true);
  assert.deepEqual([brep.visible, line.visible, model.hiddenInTree(detected)], [true, false, true]);
  model.setHidden([detected], false);
  // The part hidden: both.
  model.setHidden([plateNode!], true);
  assert.deepEqual([line.visible, model.hiddenInTree(detected)], [false, true]);
  // Set by path before the detail is made again (a new mesh), kept.
  model.setHidden([plateNode!], false);
  assert.deepEqual(model.setOverrides([{ path, hidden: true }], ['hidden']), []);
  graph.setFoundEdges(part, Float32Array.of(0, 0, 0, 0, 1, 0));
  for (const p of graph.placements.get(part)!) model.invalidate(p.group);
  const again = model.find(path)!;
  assert.equal(again, detected, 'the same id by path');
  assert.equal(model.nodes[again]!.item!.object.visible, false);
  // A new mesh with none: the node dead, its line object finding nothing.
  const old = model.nodes[again]!.item!.object;
  graph.addMesh(part, plate());
  for (const p of graph.placements.get(part)!) model.invalidate(p.group);
  assert.equal(model.nodeOf(old), undefined);
  assert.equal(model.find(path), undefined);
  // An override by its path before any detail is made: taken.
  const fresh = stepModel();
  const freshPart = fresh.model.children(fresh.model.children(fresh.model.roots[0]!)[0]!)[0]!;
  assert.deepEqual(fresh.model.setOverrides([{ path: `${fresh.model.pathOf(freshPart)}/detected`, hidden: true }],
    ['hidden']), []);
});

test("reveal: inherited, a face's own; while something's revealed, what isn't a ghost: its faces drawn by a twin at "
  + 'Reveal alpha, its lines not; none revealed, no ghosts', () => {
  const { graph, model } = stepModel();
  const meshes = graph.addMesh(0, plate()) as THREE.Mesh[];
  graph.addMesh(1, wire());
  model.setDetail(true);
  const [left, sub] = model.children(model.roots[0]!) as [number, number];
  const [leftPlate, leftWire] = model.children(left) as [number, number];
  const [subPlate, subWire] = model.children(sub) as [number, number];
  const curves = (part: number) => model.nodes[part]!.object!.getObjectByName('curves')!;
  const twinOf = (mesh: THREE.Mesh) => {
    graph.placeTwins();
    mesh.updateWorldMatrix(true, false);
    return graph.twins.children.find((t) => t.matrix.equals(mesh.matrixWorld)) as THREE.Mesh | undefined;
  };
  // (Each face's material in a mesh: visible, and its opacity.)
  // (A twin's faces as its mesh's: `of`.)
  const faces = (m: THREE.Mesh, of = m) => drawn(Object.assign(Object.create(m) as THREE.Mesh,
    { userData: of.userData })).map(([s, v, a]) => `${s}:${v ? a : '-'}`).join(' ');
  const before = [faces(meshes[0]!), faces(meshes[1]!)];
  assert.ok(!model.revealing && !graph.twins.children.length && curves(subWire).visible);
  model.setOverride(left, { reveal: true });
  assert.ok(model.revealing && model.look(leftPlate).reveal === true && model.look(subPlate).reveal === undefined);
  assert.deepEqual([model.ghost(leftPlate), model.ghost(subPlate), model.ghost(sub)], [false, true, true]);
  // The revealed placement as it was, its lines drawn; the other's faces in its twin alone, at Reveal alpha, blended.
  assert.deepEqual([faces(meshes[0]!), curves(leftWire).visible], [before[0], true]);
  assert.equal(faces(meshes[1]!), '8:- 7:-');
  assert.ok(meshes[1]!.userData.ghost && !meshes[0]!.userData.ghost && !curves(subWire).visible);
  const twin = twinOf(meshes[1]!)!;
  assert.ok(twin && twin.geometry === meshes[1]!.geometry && twin.layers.mask === 1 << REVEAL);
  assert.deepEqual(faces(twin, meshes[1]), '8:0.25 7:0.25');
  assert.ok((twin.material as THREE.Material[]).every((m) => m.transparent));
  // (The file's hidden placement, not drawn: no twin drawn either.)
  assert.equal(graph.twins.children.filter((t) => t.visible).length, 1);
  // A face of the ghost revealed: drawn as it is, the other still the twin's.
  const subFace7 = nodeIn(model, subPlate, 'face #7');
  model.setOverride(subFace7, { reveal: true });
  assert.equal(faces(meshes[1]!), `8:- ${before[1]!.split(' ')[1]}`);
  assert.equal(faces(twinOf(meshes[1]!)!, meshes[1]), '8:0.25 7:-');
  assert.ok(!meshes[1]!.userData.ghost);
  // Not revealed within something revealed: a ghost (`reveal: false`).
  const leftFace8 = nodeIn(model, leftPlate, 'face #8');
  model.setOverride(leftFace8, { reveal: false });
  assert.equal(faces(twinOf(meshes[0]!)!, meshes[0]), '8:0.25 7:-');
  // Reveal alpha; the two draws' depth settings.
  graph.setRevealAlpha(0.3);
  const ghostMaterial = (twinOf(meshes[0]!)!.material as THREE.Material[])[0]!;
  assert.equal(ghostMaterial.opacity, 0.3);
  graph.ghostPass(true);
  assert.deepEqual([ghostMaterial.colorWrite, ghostMaterial.depthWrite, ghostMaterial.depthFunc],
    [false, true, THREE.LessDepth]);
  graph.ghostPass(false);
  assert.deepEqual([ghostMaterial.colorWrite, ghostMaterial.depthWrite, ghostMaterial.depthFunc],
    [true, false, THREE.EqualDepth]);
  // A ghost hidden: its twin not drawn.
  model.setHidden([sub], true);
  graph.placeTwins();
  assert.equal(graph.twins.children.filter((t) => t.visible).length, 1);
  model.setHidden([sub], false);
  // Every reveal cleared: no ghosts, each drawn as before, every line again.
  model.clearReveal();
  graph.placeTwins();
  assert.ok(!model.revealing && !graph.twins.children.length && curves(subWire).visible);
  assert.deepEqual([faces(meshes[0]!), faces(meshes[1]!)], before);
  // In the overrides and in a state's: exactly these.
  model.setOverride(left, { reveal: true });
  assert.deepEqual(model.overrides().filter((o) => o.reveal !== undefined).map((o) => [o.path, o.reveal]),
    [['asm/left', true]]);
  model.setOverrides([{ path: 'asm/left/plate', reveal: false }], ['reveal']);
  assert.ok(!model.revealing && model.ownOverride(left) === undefined);
  assert.equal(faces(meshes[1]!), before[1]);
});

test('setRevealed: the nodes covering these revealed; one revealed through an ancestor left without its own', () => {
  const { graph, model } = stepModel();
  graph.addMesh(0, plate());
  const [left, sub] = model.children(model.roots[0]!) as [number, number];
  const [leftPlate, leftWire] = model.children(left) as [number, number];
  model.setRevealed([leftPlate, leftWire]);
  // (Both of left's parts: left itself.)
  assert.deepEqual([model.ownOverride(left), model.ownOverride(leftPlate)], [{ reveal: true }, undefined]);
  model.setRevealed([model.children(sub)[0]!]);
  assert.deepEqual(model.ownOverride(model.children(sub)[0]!), { reveal: true });
  // Within something revealed: nothing of its own.
  model.setRevealed([leftPlate]);
  assert.equal(model.ownOverride(leftPlate), undefined);
  assert.ok(model.revealing && !model.ghost(leftPlate));
});
