import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { multiply, scaling, type Mesh } from 'cad-scene';
import { plate, scene, translation, wire } from './fixtures.ts';
import { DEFAULT_COLOR, polylineSegments, SceneGraph } from '../src/scene-graph.ts';
import { EDGES } from '../src/style.ts';
import { workerCount } from '../src/tessellation.ts';

const close = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((x, i) => Math.abs(x - b[i]!) < 1e-9);

test('the tree: a group per component instance and placed part, with their transforms, names and visibility', () => {
  const g = new SceneGraph(scene(), 'model');
  assert.equal(g.root.name, 'model');
  const asm = g.root.children[0]!;
  assert.equal(asm.name, 'asm');
  assert.deepEqual(asm.children.map((c) => c.name), ['left', 'sub', 'hidden']);
  assert.deepEqual(asm.children[0]!.children.map((c) => c.name), ['plate', 'wire']);
  assert.ok(close(asm.matrix.elements, translation(0, 0, 5)));
  assert.ok(close(asm.children[1]!.matrix.elements, translation(200, 0, 0)));
  assert.ok(close(asm.children[0]!.children[0]!.matrix.elements, scaling(25.4)));
  // Placements by part, in tree order; the third instance's are hidden.
  assert.equal(g.placements.get(0)!.length, 3);
  assert.deepEqual(g.placements.get(0)!.map((p) => p.group.visible), [true, true, false]);
  assert.deepEqual(g.placements.get(1)!.map((p) => p.instance.path), [[0, 0], [0, 1], [0, 2]]);
});

test('meshes: at the origin in each placement, geometry shared where the colouring is, faces as material runs', () => {
  const g = new SceneGraph(scene(), 'model');
  const made = g.addMesh(0, plate()) as THREE.Mesh[];
  assert.equal(made.length, 3);
  g.root.updateMatrixWorld(true);
  // World: the root occurrence, the instance, inches to mm, the mesh's origin.
  const expected = multiply(multiply(multiply(translation(0, 0, 5), translation(100, 0, 0)), scaling(25.4)),
    translation(1, 0, 0));
  assert.ok(close(made[0]!.matrixWorld.elements, expected));
  // The first and third instances colour alike (green, face 7 blue): one geometry; the second is all red.
  assert.equal(made[0]!.geometry, made[2]!.geometry);
  assert.notEqual(made[0]!.geometry, made[1]!.geometry);
  // ...but the same attributes.
  assert.equal(made[0]!.geometry.getAttribute('position'), made[1]!.geometry.getAttribute('position'));
  assert.deepEqual(Array.from(made[1]!.geometry.getAttribute('normal').array), Array.from(plate().normals!));
  assert.deepEqual(made[0]!.geometry.groups.map((r) => [r.start, r.count, r.materialIndex]), [[0, 3, 0], [3, 3, 1]]);
  assert.deepEqual(made[1]!.geometry.groups.map((r) => [r.start, r.count, r.materialIndex]), [[0, 6, 0]]);
  const colours = (m: THREE.Mesh) => (m.material as THREE.MeshPhongMaterial[]).map((x) =>
    [x.color.getHexString(THREE.SRGBColorSpace), x.opacity, x.transparent]);
  assert.deepEqual(colours(made[0]!), [['00ff00', 1, false], ['0000ff', 1, false]]);
  assert.deepEqual(colours(made[1]!), [['ff0000', 0.5, true]]);
  // Materials are shared too, and faces sit behind their edges.
  assert.equal((made[0]!.material as THREE.Material[])[0], (made[2]!.material as THREE.Material[])[0]);
  assert.ok((made[0]!.material as THREE.Material[]).every((m) => m.polygonOffset));
  // B-rep edges: the shared one (one segment), not the seam; shared between placements.
  const edges = made.map((m) => m.children.find((c) => c.name === 'edges') as THREE.LineSegments);
  assert.deepEqual(Array.from(edges[0]!.geometry.index!.array), [0, 1]);
  assert.equal(edges[0]!.layers.mask, 1 << EDGES);
  assert.equal(edges[0]!.geometry, edges[1]!.geometry);
  // Whether the part is closed, as the scene says (for the caps), or nothing when it doesn't.
  assert.ok(made.every((m) => !('closed' in m.userData)));
  const said = scene();
  said.parts[0]!.closed = true;
  const saidMade = new SceneGraph(said, 'model').addMesh(0, plate()) as THREE.Mesh[];
  assert.ok(saidMade.every((m) => m.userData.closed === true));
  // A mesh without faces (a foreign file's): all its triangles drawn, in the placement's colour.
  const bare = new SceneGraph(scene(), 'model').addMesh(0, { ...plate(), faces: [] }) as THREE.Mesh[];
  assert.deepEqual(bare[1]!.geometry.groups.map((r) => [r.start, r.count, r.materialIndex]), [[0, 6, 0]]);
  assert.deepEqual(colours(bare[0]!), [['00ff00', 1, false]]);
  assert.deepEqual(colours(bare[1]!), [['ff0000', 0.5, true]]);
});

test("a part's next mesh replaces its first in every placement (the file's tessellation, then ours)", () => {
  const g = new SceneGraph(scene(), 'model');
  assert.equal(g.hasMesh(0), false);
  const first = g.addMesh(0, plate());
  assert.equal(g.hasMesh(0), true);
  const next = plate();
  next.faces = [{ source: 9, start: 0, count: next.indices.length }];
  const second = g.addMesh(0, next);
  for (const [i, p] of g.placements.get(0)!.entries()) {
    assert.deepEqual(p.group.children, [second[i]]);
    assert.equal(first[i]!.parent, null);
  }
  assert.deepEqual(second[0]!.userData.faces, [9]);
});

test('meshes: wireframes as curves and points in the instance colour; no faces, no edges', () => {
  const g = new SceneGraph(scene(), 'model');
  const [first, second] = g.addMesh(1, wire());
  assert.ok(!(first instanceof THREE.Mesh));
  assert.deepEqual(first!.children.map((c) => c.name), ['curves', 'points']);
  const curves = first!.children[0] as THREE.LineSegments;
  assert.deepEqual(Array.from(curves.geometry.index!.array), [0, 1, 1, 2]);
  const colour = (o: THREE.Object3D, i: number) => ((o.children[i] as THREE.Points).material as
    THREE.PointsMaterial).color.getHexString(THREE.SRGBColorSpace);
  // The part has no material: the default grey for the first instance, the override's red for the second.
  assert.equal(colour(first!, 0), new THREE.Color().setRGB(...DEFAULT_COLOR, THREE.SRGBColorSpace)
    .getHexString(THREE.SRGBColorSpace));
  assert.equal(colour(second!, 0), 'ff0000');
  assert.equal(colour(second!, 1), 'ff0000');
  assert.equal(g.addMesh(5, wire()).length, 0);
});

test('edges found later (setFoundEdges) for every placement of a part without B-rep edges; B-rep edges at once', () => {
  const g = new SceneGraph(scene(), 'model');
  const bare = plate();
  delete bare.edges;
  delete bare.edgePositions;
  const made = g.addMesh(0, bare);
  // None until found (model-load.ts finds them in the worker).
  assert.ok(made.length > 1 && made.every((m) => !m.children.some((c) => c.name === 'edges')));
  const segments = Float32Array.of(0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0);
  assert.deepEqual(g.setFoundEdges(0, segments), made);
  for (const m of made) {
    const e = m.children.filter((c) => c.name === 'edges') as THREE.LineSegments[];
    assert.equal(e.length, 1);
    assert.equal(e[0]!.layers.mask, 1 << EDGES);
    assert.equal(e[0]!.geometry.getAttribute('position').count, 4);
  }
  // Again: in place of the first, not beside it.
  g.setFoundEdges(0, segments);
  assert.ok(made.every((m) => m.children.filter((c) => c.name === 'edges').length === 1));
  // A part with no mesh: nothing.
  assert.deepEqual(new SceneGraph(scene(), 'model').setFoundEdges(0, segments), []);
  // Only seams: the B-rep has edges, none to draw.
  const seams = plate();
  seams.edges = [seams.edges![1]!];
  assert.equal(g.addMesh(0, seams)[0]!.children.some((c) => c.name === 'edges'), false);
});

test('polylineSegments: consecutive pairs within each polyline, none across', () => {
  assert.deepEqual(Array.from(polylineSegments([{ start: 0, count: 3 }, { start: 3, count: 1 },
    { start: 4, count: 2 }])), [0, 1, 1, 2, 4, 5]);
  assert.equal(polylineSegments([]).length, 0);
});

test('workers: one less than the cores, at most 8, at most 3 on touch devices, at least 1', () => {
  assert.equal(workerCount('desktop', 10), 8);
  assert.equal(workerCount('desktop', 6), 5);
  assert.equal(workerCount('phone', 8), 3);
  assert.equal(workerCount('tablet', 8), 3);
  assert.equal(workerCount('tablet', 2), 1);
  assert.equal(workerCount('desktop', 1), 1);
});

test('faces that failed to mesh: outlined in red per placement, marked failed, hidden with their face, picked as it',
  async () => {
    const { NodeModel } = await import('../src/model.ts');
    const { nodeForPick, piecesOf } = await import('../src/selection.ts');
    const { FAILED_COLOR } = await import('../src/scene-graph.ts');
    const graph = new SceneGraph(scene(), 'model');
    // The plate with face 7 failed (a range of none) and its outline: two polylines.
    const m: Mesh = { ...plate(), indices: Uint32Array.of(0, 1, 2), faces: [{ source: 8, start: 0, count: 3 },
      { source: 7, start: 3, count: 0 }], faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 2, 2, 2,
      3, 3, 3), faceOutlines: [{ source: 7, start: 0, count: 3 }, { source: 7, start: 3, count: 2 }] };
    const objs = graph.addMesh(0, m);
    assert.equal(objs.length, 3);
    for (const o of objs) {
      assert.deepEqual(o.userData.failedFaces, [7]);
      const lines = o.children.filter((c) => c.name === 'outline') as THREE.LineSegments[];
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.userData.outlineFace, 7);
      assert.equal((lines[0]!.material as THREE.LineBasicMaterial).color.getHex(), FAILED_COLOR);
      // Three segments: two in the first polyline, one in the second, none across.
      assert.deepEqual(Array.from(lines[0]!.geometry.index!.array), [0, 1, 1, 2, 3, 4]);
      assert.ok(lines[0]!.layers.isEnabled(0) && lines[0]!.layers.isEnabled(EDGES));
    }
    const model = new NodeModel(graph.root, graph);
    model.setDetail(true);
    const parts = model.nodes.filter((n) => n.kind === 'part' && n.name === 'plate');
    const faces = model.children(parts[0]!.id).filter((c) => model.nodes[c]!.kind === 'face');
    const failed = faces.find((c) => model.nodes[c]!.face!.source === 7)!;
    const ok = faces.find((c) => model.nodes[c]!.face!.source === 8)!;
    assert.deepEqual([model.failure(failed), model.failure(ok), model.failure(parts[0]!.id)],
      ['failed', undefined, 'partly']);
    // Hidden with its face, in every placement; shown again with all faces.
    model.setHidden([failed], true);
    assert.ok(objs.every((o) => !o.children.find((c) => c.name === 'outline')!.visible));
    graph.showAllFaces();
    assert.ok(objs.every((o) => o.children.find((c) => c.name === 'outline')!.visible));
    // Picked as its face at the detail level, as its part above; its highlight covers the outline.
    const line = objs[0]!.children.find((c) => c.name === 'outline')!;
    assert.equal(nodeForPick(model, line, undefined, 'detail'), failed);
    assert.equal(nodeForPick(model, line, undefined, 'part'), parts[0]!.id);
    assert.ok(piecesOf(model, [failed]).some((p) => p.object === line && !p.ranges));
    // A part whose faces all failed (no triangles: a group, no mesh): failed.
    const graph2 = new SceneGraph(scene(), 'model');
    graph2.addMesh(0, { origin: [0, 0, 0], positions: new Float32Array(), indices: new Uint32Array(),
      faces: [{ source: 7, start: 0, count: 0 }], faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 0, 0),
      faceOutlines: [{ source: 7, start: 0, count: 2 }] });
    const model2 = new NodeModel(graph2.root, graph2);
    const part2 = model2.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!;
    assert.equal(model2.failure(part2.id), 'failed');
  });

test('faces judged by their part\'s measures: partly, excess and unverified, all but partly red; Details', async () => {
  const { NodeModel } = await import('../src/model.ts');
  const { details } = await import('../src/details.ts');
  // The plate's faces (the part is in inches): 8 a triangle of area 0.5 (322.6 mm^2), 7 one of 0.505 (325.8); each
  // outlined. Meshed at 0.001 mm, so the boundary allowance is nothing to speak of. Details in mm^2.
  const mesh = (): Mesh => ({ ...plate(), faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0),
    faceOutlines: [{ source: 7, start: 0, count: 2 }, { source: 8, start: 2, count: 2 }] });
  const measured = (faces: [number, number, boolean][]) => {
    const sc = scene();
    sc.parts[0]!.measures = { by: 'test', faces: new Map(faces.map(([s, area, valid]) => [s, { area, perimeter: 3,
      valid }])) };
    return sc;
  };
  // 8 short of its measured area (partly), 7 well over its (excess).
  const graph = new SceneGraph(measured([[8, 1, true], [7, 0.3, true]]), 'model');
  const [obj] = graph.addMesh(0, mesh(), 0.001);
  assert.deepEqual([obj!.userData.failedFaces, obj!.userData.partlyFailedFaces], [[7], [8]]);
  assert.equal(obj!.children.filter((c) => c.name === 'outline').length, 2);
  const model = new NodeModel(graph.root, graph);
  model.setDetail(true);
  const part = model.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!.id;
  const face = (s: number) => model.children(part).find((c) => model.nodes[c]!.face?.source === s)!;
  assert.deepEqual([model.failure(face(7)), model.failure(face(8)), model.failure(part)],
    ['failed', 'partly', 'partly']);
  assert.ok(details(model, [face(8)]).includes('Part of it failed to mesh (322.6 of 645.2 mm^2 meshed): ' +
    'outlined in red'),
    details(model, [face(8)]).join('\n'));
  assert.ok(details(model, [face(7)]).includes('Its mesh is larger than the face (its mesh 325.8 mm^2, the face ' +
    '193.5 mm^2): outlined in red'), details(model, [face(7)]).join('\n'));
  assert.ok(details(model, [face(7)]).includes('Area on the exact geometry: 193.5 mm^2'));
  assert.ok(details(model, [part]).includes('Of 2 faces, 1 meshed larger than the face, 1 partly (outlined in red)'),
    details(model, [part]).join('\n'));
  // 8 unsound (unverified, red), 7 as measured; without the deflection, not judged by measures at all.
  const g2 = new SceneGraph(measured([[8, 0.5, false], [7, 0.505, true]]), 'model');
  const [o2] = g2.addMesh(0, mesh(), 0.001);
  assert.deepEqual([o2!.userData.failedFaces, o2!.userData.partlyFailedFaces], [[8], []]);
  const m2 = new NodeModel(g2.root, g2);
  m2.setDetail(true);
  const p2 = m2.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!.id;
  const f8 = m2.children(p2).find((c) => m2.nodes[c]!.face?.source === 8)!;
  assert.equal(m2.failure(f8), 'failed');
  assert.ok(details(m2, [f8]).includes("Its area couldn't be verified (its geometry is unsound): outlined in red"));
  const [o3] = new SceneGraph(measured([[8, 0.5, false], [7, 9, true]]), 'model').addMesh(0, mesh());
  assert.deepEqual([o3!.userData.failedFaces, o3!.userData.partlyFailedFaces], [[], []]);
  // The deflection is in mm, the part in inches: at 2 mm (0.079 in) the strip for face 8 (perimeter 3 in) is 0.24 in^2,
  // under its 0.5 in^2 shortfall: partly (taken as 2 inches, the strip would hide it).
  const [o5] = new SceneGraph(measured([[8, 1, true]]), 'model').addMesh(0, mesh(), 2);
  assert.deepEqual(o5!.userData.partlyFailedFaces, [8]);
  // A face with no triangles: failed, as before (its outline drawn).
  const empty: Mesh = { ...mesh(), faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 0 }] };
  const [o4] = new SceneGraph(scene(), 'model').addMesh(0, empty);
  assert.deepEqual([o4!.userData.failedFaces, o4!.userData.partlyFailedFaces], [[7], []]);
});
