import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { details } from '../src/details.ts';
import { NodeModel } from '../src/model.ts';
import { pick } from '../src/pick.ts';
import { boxOf, faceOfTriangle, Highlighter, instancesOf, measure, nodeForPick, piecesOf } from '../src/selection.ts';
import { StepGraph } from '../src/step.ts';
import { plate, scene, wire } from './fixtures.ts';

function stepModel() {
  const graph = new StepGraph(scene(), 'model');
  graph.addMesh(0, plate());
  graph.addMesh(1, wire());
  const model = new NodeModel(graph.root, graph);
  model.setDetail(true);
  graph.root.updateMatrixWorld(true);
  const [left, sub, hidden] = model.children(model.children(model.roots[0]!)[0]!);
  const partOf = (placement: number, i: number) => model.children(placement)[i]!;
  const find = (part: number, name: string) => model.children(part).find((c) => model.nodes[c]!.name === name)!;
  return { graph, model, left: left!, sub: sub!, hidden: hidden!, partOf, find };
}

test('pieces: a part whole (its mesh and lines), a face as ranges, a face inside a selected part not twice', () => {
  const { model, left, partOf, find } = stepModel();
  const plateLeft = partOf(left, 0);
  const whole = piecesOf(model, [plateLeft]);
  assert.deepEqual(whole.map((p) => [p.object.type, p.object.name, p.ranges]),
    [['Mesh', 'plate', undefined], ['LineSegments', 'edges', undefined]]);
  const face = find(plateLeft, 'face #7');
  assert.deepEqual(piecesOf(model, [face]).map((p) => p.ranges), [[{ start: 3, count: 3 }]]);
  assert.equal(piecesOf(model, [face, plateLeft]).length, 2);
  assert.ok(piecesOf(model, [face, plateLeft]).every((p) => !p.ranges));
  // A three.js part's own drawing: the object alone, not its lines.
  const root = new THREE.Group();
  const bracket = new THREE.Mesh(new THREE.BoxGeometry());
  bracket.add(new THREE.LineSegments());
  // (A group beside it, so the root is an assembly.)
  root.add(bracket, new THREE.Group().add(new THREE.Group()));
  const m = new NodeModel(root);
  m.setDetail(true);
  const own = m.children(m.children(m.roots[0]!)[0]!)[0]!;
  assert.equal(m.nodes[own]!.self, true);
  assert.deepEqual(piecesOf(m, [own]).map((p) => p.object), [bracket]);
});

test("measures in the world's millimetres: triangles' area, segments' length, points", () => {
  const { model, left, partOf, find } = stepModel();
  const plateLeft = partOf(left, 0);
  // The plate in inches: the triangle (0,0,0) (1,0,0) (1,1,0) and (0,0,0) (1,1,0) (0,1,0.1), times 25.4.
  const tri = (a: number[], b: number[], c: number[]) => {
    const u = b.map((x, i) => x - a[i]!), v = c.map((x, i) => x - a[i]!);
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    return Math.hypot(...n) / 2 * 25.4 ** 2;
  };
  const a8 = tri([0, 0, 0], [1, 0, 0], [1, 1, 0]);
  const a7 = tri([0, 0, 0], [1, 1, 0], [0, 1, 0.1]);
  const m = measure(piecesOf(model, [plateLeft]));
  assert.equal(m.meshes, 1);
  assert.equal(m.triangles, 2);
  assert.ok(Math.abs(m.area - (a8 + a7)) < 1e-6, `${m.area}`);
  // The B-rep edge drawn: (0,0,0) to (1,1,0), inches.
  assert.equal(m.segments, 1);
  assert.ok(Math.abs(m.length - Math.SQRT2 * 25.4) < 1e-6, `${m.length}`);
  const f = measure(piecesOf(model, [find(plateLeft, 'face #7')]));
  assert.equal(f.triangles, 1);
  assert.ok(Math.abs(f.area - a7) < 1e-6);
  // The wireframe (millimetres): a curve of two segments, 1 + 1 mm, and a point.
  const w = measure(piecesOf(model, [partOf(left, 1)]));
  assert.deepEqual([w.meshes, w.lines, w.segments, w.length, w.points], [0, 1, 2, 2, 1]);
});

test("boxes: a face's by its vertices, in the world", () => {
  const { model, left, partOf, find } = stepModel();
  const box = boxOf(piecesOf(model, [find(partOf(left, 0), 'face #8')]));
  // Face 8: (0,0,0) (1,0,0) (1,1,0) inches, at the plate's origin (1 inch along x), the placement at x 100 and the
  // root occurrence at z 5.
  const at = (x: number, y: number) => [100 + 25.4 * (1 + x), 25.4 * y, 5];
  assert.deepEqual(box.min.toArray().map((x) => +x.toFixed(9)), at(0, 0));
  assert.deepEqual(box.max.toArray().map((x) => +x.toFixed(9)), at(1, 1));
});

test('faceOfTriangle: the range holding a triangle, at the boundaries; none past the end', () => {
  const ranges = [{ source: 1, start: 0, count: 6 }, { source: 2, start: 6, count: 3 }, { source: 1, start: 9,
    count: 9 }];
  assert.deepEqual([0, 1, 2, 3, 5].map((t) => faceOfTriangle(ranges, t)?.source), [1, 1, 2, 1, 1]);
  assert.equal(faceOfTriangle(ranges, 6), undefined);
  assert.equal(faceOfTriangle([], 0), undefined);
});

test('the node a pick stands for: the part, its assembly, or the face, edges or curves hit', () => {
  const { model, left, partOf, find } = stepModel();
  const plateLeft = partOf(left, 0);
  const mesh = model.nodes[plateLeft]!.object!.children[0]!;
  assert.equal(nodeForPick(model, mesh, 1, 'part'), plateLeft);
  assert.equal(nodeForPick(model, mesh, 1, 'assembly'), left);
  assert.equal(nodeForPick(model, mesh, 1, 'detail'), find(plateLeft, 'face #7'));
  assert.equal(nodeForPick(model, mesh, 0, 'detail'), find(plateLeft, 'face #8'));
  const edges = mesh.children.find((c) => c.name === 'edges')!;
  assert.equal(nodeForPick(model, edges, undefined, 'detail'), find(plateLeft, 'edges'));
  assert.equal(nodeForPick(model, edges, undefined, 'part'), plateLeft);
  const curves = model.nodes[partOf(left, 1)]!.object!.children[0]!.children[0]!;
  assert.equal(nodeForPick(model, curves, undefined, 'detail'), find(partOf(left, 1), 'curves'));
  assert.equal(nodeForPick(model, new THREE.Object3D(), undefined, 'part'), undefined);
  // An object above any part (the root): its own node, at every level.
  assert.equal(nodeForPick(model, model.nodes[left]!.object!, undefined, 'part'), left);
});

test("instances: a STEP part's placements; a three.js part's by its geometries", () => {
  const { model, left, sub, hidden, partOf } = stepModel();
  assert.deepEqual(instancesOf(model, partOf(sub, 0)), [partOf(left, 0), partOf(sub, 0), partOf(hidden, 0)]);
  const g = new THREE.BoxGeometry();
  const root = new THREE.Group();
  const a = new THREE.Group().add(new THREE.Mesh(g));
  const b = new THREE.Group().add(new THREE.Mesh(g));
  const c = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry()));
  root.add(a, b, c);
  const m = new NodeModel(root);
  const parts = m.children(m.roots[0]!);
  assert.deepEqual(instancesOf(m, parts[0]!), [parts[0], parts[1]]);
  assert.deepEqual(instancesOf(m, parts[2]!), [parts[2]]);
});

test('highlighting: tinted materials swapped in and back, shared; faces as an overlay; other instances lighter', () => {
  const { model, left, sub, partOf, find } = stepModel();
  const h = new Highlighter();
  const mesh = model.nodes[partOf(left, 0)]!.object!.children[0] as THREE.Mesh;
  const other = model.nodes[partOf(sub, 0)]!.object!.children[0] as THREE.Mesh;
  const before = mesh.material as THREE.MeshPhongMaterial[];
  h.apply(piecesOf(model, [partOf(left, 0)]), piecesOf(model, [partOf(sub, 0)]));
  const lit = mesh.material as THREE.MeshPhongMaterial[];
  assert.ok(lit.every((m, i) => m !== before[i] && m.emissive.getHex() !== 0 && m.color.equals(before[i]!.color)));
  const lighter = other.material as THREE.MeshPhongMaterial[];
  assert.notEqual(lighter[0]!.emissive.getHex(), lit[0]!.emissive.getHex());
  assert.equal(h.original(mesh), before);
  h.clear();
  assert.equal(mesh.material, before);
  // The same original material gets the same tinted copy each time.
  h.apply(piecesOf(model, [partOf(left, 0)]));
  assert.equal((mesh.material as THREE.Material[])[0], lit[0]);
  h.clear();
  // A face: an overlay of its triangles under the mesh, not a node, not pickable; gone when cleared.
  h.apply(piecesOf(model, [find(partOf(left, 0), 'face #7')]));
  const overlay = mesh.children.find((c) => c.userData.highlight) as THREE.Mesh;
  assert.deepEqual(Array.from(overlay.geometry.index!.array), [0, 2, 3]);
  // Not pickable: a ray through the face hits the mesh, not the overlay.
  overlay.updateMatrixWorld(true);
  const hit = new THREE.Vector3(0.2, 0.8, 0.05).applyMatrix4(mesh.matrixWorld);
  const ray = new THREE.Raycaster(hit.clone().add(new THREE.Vector3(0, 0, 50)), new THREE.Vector3(0, 0, -1));
  assert.ok(ray.intersectObject(mesh, false).length > 0);
  assert.equal(ray.intersectObject(overlay, false).length, 0);
  assert.equal(mesh.material, before);
  h.clear();
  assert.equal(mesh.children.some((c) => c.userData.highlight), false);
});

test("details: counts by kind; one node's name, place, placement; totals", () => {
  const { model, left, sub, partOf } = stepModel();
  assert.deepEqual(details(model, []), ['Nothing selected.']);
  const lines = details(model, [partOf(sub, 0)]);
  assert.equal(lines[0], 'Selected: 1 part');
  assert.equal(lines[1], 'Name: plate (part)');
  assert.equal(lines[2], 'In: model / asm / sub');
  assert.equal(lines[3], 'Placement 2 of 3 of this part');
  assert.match(lines[4]!, /^Triangles: 2 in 1 mesh, area [\d,.]+ mm\^2$/);
  assert.match(lines[5]!, /^Segments: 1 in 1 line object, length 35\.9 mm$/);
  assert.deepEqual(details(model, [left, partOf(left, 0), partOf(sub, 1)]).slice(0, 1),
    ['Selected: 1 assembly, 2 parts']);
});

test('pick: the nearest drawn thing under a point; hidden things, hidden faces and clipped points not', () => {
  const root = new THREE.Group();
  const near = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), [new THREE.MeshBasicMaterial()]);
  near.geometry.addGroup(0, 6, 0);
  near.position.z = 5;
  const far = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  const edge = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-5, 0.02, 5),
    new THREE.Vector3(5, 0.02, 5)]));
  root.add(near, far, edge);
  root.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const at = (y = 0.3, pixel = 0.01) => pick(camera, root, new THREE.Vector2(0, y / 10), pixel)?.object;
  assert.equal(at(), near);
  // An edge within a few pixels of the point, at the face's depth, wins.
  assert.equal(at(0.05), edge);
  assert.equal(at(0.3, 0.1), edge);
  near.visible = false;
  assert.equal(at(), far);
  near.visible = true;
  // Hidden through an ancestor.
  const holder = new THREE.Group();
  root.add(holder);
  holder.add(near);
  holder.visible = false;
  holder.updateMatrixWorld(true);
  assert.equal(at(), far);
  holder.visible = true;
  (near.material as THREE.Material[])[0]!.visible = false;
  assert.equal(at(), far);
  (near.material as THREE.Material[])[0]!.visible = true;
  near.layers.disable(0);
  assert.equal(at(), far);
  near.layers.enable(0);
  assert.equal(pick(camera, root, new THREE.Vector2(0, 0.03), 0.01, (p) => p.z > 1)?.object, far);
  assert.equal(pick(camera, root, new THREE.Vector2(0.9, 0.9), 0.01, () => true), undefined);
});
