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

test('edges found from the triangles only for parts without B-rep edges', () => {
  const g = new SceneGraph(scene(), 'model');
  const bare = plate();
  delete bare.edges;
  delete bare.edgePositions;
  const [m] = g.addMesh(0, bare);
  const e = m!.children.find((c) => c.name === 'edges') as THREE.LineSegments;
  assert.ok(e.geometry instanceof THREE.EdgesGeometry);
  assert.equal(e.layers.mask, 1 << EDGES);
  // The square's outline; not the diagonal, where its two triangles fold by about 8 degrees, under EDGE_ANGLE.
  assert.equal(e.geometry.getAttribute('position').count / 2, 4);
  // Only seams: the B-rep has edges, none to draw; none found either.
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

test('a split face with a piece that failed (not a sliver): partly, outlined; a sliver: nothing', async () => {
  const { NodeModel } = await import('../src/model.ts');
  const { details } = await import('../src/details.ts');
  // The plate's face 7 (a triangle of area 0.5) split: a piece of none, area 0.4, its outline; face 8 split with a
  // sliver of 1e-9.
  const mesh = (area7: number): Mesh => ({ ...plate(), faces: [{ source: 8, start: 0, count: 3 },
    { source: 8, start: 3, count: 0, area: 1e-9 }, { source: 7, start: 3, count: 3 },
    { source: 7, start: 6, count: 0, area: area7 }],
    faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 1, 0), faceOutlines: [{ source: 7, start: 0, count: 2 }] });
  const graph = new SceneGraph(scene(), 'model');
  const [obj] = graph.addMesh(0, mesh(0.4));
  assert.deepEqual([obj!.userData.failedFaces, obj!.userData.partlyFailedFaces], [[], [7]]);
  assert.equal(obj!.children.filter((c) => c.name === 'outline').length, 1);
  const model = new NodeModel(graph.root, graph);
  model.setDetail(true);
  const part = model.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!.id;
  const face = (s: number) => model.children(part).find((c) => model.nodes[c]!.face?.source === s)!;
  assert.deepEqual([model.failure(face(7)), model.failure(face(8)), model.failure(part)],
    ['partly', undefined, 'partly']);
  assert.ok(details(model, [face(7)]).includes('Part of it failed to mesh: outlined in red'));
  assert.ok(details(model, [part]).includes('Of 2 faces, 1 partly (outlined in red)'));
  // The piece a sliver too: nothing failed.
  const g2 = new SceneGraph(scene(), 'model');
  const [o2] = g2.addMesh(0, mesh(0.001));
  assert.deepEqual([o2!.userData.failedFaces, o2!.userData.partlyFailedFaces], [[], []]);
  assert.equal(o2!.children.filter((c) => c.name === 'outline').length, 0);
});
