import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { details } from '../src/details.ts';
import { NodeModel } from '../src/model.ts';
import { pick } from '../src/pick.ts';
import { faceOfTriangle, Highlighter, instancesOf, measure, nodeForPick, piecesOf,
  sphereOf } from '../src/selection.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { plate, scene, wire } from './fixtures.ts';

function stepModel() {
  const graph = new SceneGraph(scene(), 'model');
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

test("spheres: a face's around its vertices' box, in the world; a part and the face together", () => {
  const { model, left, partOf, find } = stepModel();
  const face = sphereOf(piecesOf(model, [find(partOf(left, 0), 'face #8')]));
  // Face 8: (0,0,0) (1,0,0) (1,1,0) inches, at the plate's origin (1 inch along x), the placement at x 100 and the
  // root occurrence at z 5: its box's centre and half diagonal.
  assert.deepEqual(face.center.toArray().map((x) => +x.toFixed(9)), [100 + 25.4 * 1.5, 25.4 * 0.5, 5]);
  assert.ok(Math.abs(face.radius - 25.4 * Math.SQRT1_2) < 1e-9);
  const both = sphereOf(piecesOf(model, [find(partOf(left, 0), 'face #8'), partOf(left, 1)]));
  const part = sphereOf(piecesOf(model, [partOf(left, 1)]));
  // A whole object's alone: around its vertices' box in its own coordinates, then placed.
  const [whole] = piecesOf(model, [partOf(left, 0)]);
  const plate = sphereOf([whole!]);
  const box = new THREE.Box3();
  const object = whole!.object;
  const pos = object.geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, i));
  object.updateWorldMatrix(true, false);
  const want = box.getBoundingSphere(new THREE.Sphere()).applyMatrix4(object.matrixWorld);
  assert.ok(object.type === 'Mesh' && plate.center.distanceTo(want.center) < 1e-9 &&
    Math.abs(plate.radius - want.radius) < 1e-9, `${plate.radius} ${want.radius}`);
  // Both: every vertex of the face and of the part inside (the boxes' corners held, not spheres around them).
  for (const { object: o } of piecesOf(model, [find(partOf(left, 0), 'face #8'), partOf(left, 1)])) {
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const w = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (o === whole!.object) continue;
      assert.ok(both.center.distanceTo(w) <= both.radius + 1e-9);
    }
  }
  assert.ok(both.radius >= Math.max(face.radius, part.radius) - 1e-9);
  assert.ok(sphereOf([]).isEmpty());
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

test("instances: a part's placements, by its scene part", () => {
  const { model, left, sub, hidden, partOf } = stepModel();
  assert.deepEqual(instancesOf(model, partOf(sub, 0)), [partOf(left, 0), partOf(sub, 0), partOf(hidden, 0)]);
  assert.deepEqual(instancesOf(model, partOf(sub, 1)), [partOf(left, 1), partOf(sub, 1), partOf(hidden, 1)]);
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
  // (Its edge its child, as the scene graph has them: at its depth, z 5.)
  const edge = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-5, 0.02, 0),
    new THREE.Vector3(5, 0.02, 0)]));
  near.add(edge);
  root.add(near, far);
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

test('pick: the face under the point beats other parts\' lines near it; its own lines and wireframes may win', () => {
  // Parts as our STEP graph and found edges make them: a group holding a mesh, the mesh's edges its child. A plate
  // (x -4 to 4, y -4 to 4) with a bracket on it at the same depth (x 1 to 3, y -1 to 1, drawn in front), and a
  // wireframe part (one curve along y = 3, x -8 to 8), in front of the plate.
  const root = new THREE.Group();
  const part = (x0: number, x1: number, y0: number, y1: number, z: number) => {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, z);
    const [hx, hy] = [(x1 - x0) / 2, (y1 - y0) / 2];
    const edges = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([[-hx, -hy], [hx, -hy], [hx, -hy],
      [hx, hy], [hx, hy], [-hx, hy], [-hx, hy], [-hx, -hy]].map(([x, y]) => new THREE.Vector3(x, y, 0))));
    mesh.add(edges);
    g.add(mesh);
    root.add(g);
    return { mesh, edges };
  };
  const plate = part(-4, 4, -4, 4, 0);
  const bracket = part(1, 3, -1, 1, 0.001);
  const wire = new THREE.Group();
  const curve = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-8, 3, 0.5),
    new THREE.Vector3(8, 3, 0.5)]));
  wire.add(curve);
  root.add(wire);
  root.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // ndc is world / 10 here; a pixel 0.1, so lines are hit within 0.4.
  const at = (x: number, y: number) => pick(camera, root, new THREE.Vector2(x / 10, y / 10), 0.1)?.object;
  // On the plate, 0.3 from the bracket's edge (x = 1): the plate (the bracket's edge won before 2026-10-25).
  assert.equal(at(0.7, 0), plate.mesh);
  // On the bracket, 0.3 from its own edge: the edge, so edges can be picked.
  assert.equal(at(1.3, 0), bracket.edges);
  // On the plate, 0.3 from its own edge: the plate's edge.
  assert.equal(at(-3.7, 0), plate.edges);
  // The wireframe, in front of the plate, within reach: it wins.
  assert.equal(at(0, 2.8), curve);
  // No face under the point: the nearest line, or nothing.
  assert.equal(at(-6, 3.2), curve);
  assert.equal(at(-6, 0), undefined);
  // The wireframe behind the plate, beyond the depth tolerance (twice the reach): the plate.
  curve.position.z = -2;
  root.updateMatrixWorld(true);
  assert.equal(at(0, 2.8), plate.mesh);
});

test('pick: lines are hit within the pixels asked under a scaled parent (a file in metres)', () => {
  // three.js divides the threshold by the line's own scale only, so under a parent scaling by 1000 a line was hit
  // within 1000 times the reach: a click in empty space picked the nearest part's edges (2026-10-25).
  const root = new THREE.Group();
  const metres = new THREE.Group();
  metres.scale.setScalar(1000);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.002, 0.002));
  const edges = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.001, 0.001, 0),
    new THREE.Vector3(0.001, 0.001, 0)]));
  const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.001, -0.001, 0)]));
  mesh.add(edges, dots);
  metres.add(mesh);
  root.add(metres);
  root.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // The part spans -1 to 1 mm; a pixel 0.1 mm, so lines and points are hit within 0.4 mm.
  const at = (x: number, y: number) => pick(camera, root, new THREE.Vector2(x / 10, y / 10), 0.1)?.object;
  assert.equal(at(0, 0), mesh);
  assert.equal(at(0, 1.3), edges);
  assert.equal(at(1.2, -1.2), dots);
  // Just beyond the reach (0.5 from the line, 0.25 squared, under the reach of 0.4 itself).
  assert.equal(at(0, 1.5), undefined);
  assert.equal(at(0, 3), undefined);
  assert.equal(at(5, -5), undefined);
  // Segments are pairs: nothing joins one's end to the next one's start (a wire at x = 3 with a gap across y = 0).
  const gap = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([-0.001, -0.0006, 0.0006, 0.001]
    .map((y) => new THREE.Vector3(0.003, y, 0))));
  metres.add(gap);
  root.updateMatrixWorld(true);
  assert.equal(at(3.1, 0.8), gap);
  assert.equal(at(3.1, 0), undefined);
  metres.remove(gap);
  // Scaled on the line itself (three.js's own case) too.
  edges.scale.setScalar(2);
  edges.position.y = 0.001;
  root.updateMatrixWorld(true);
  assert.equal(at(0, 3.3), edges);
  assert.equal(at(0, 4), undefined);
});

test('pick: what\'s drawn in front of the camera\'s position (a negative near plane) is hit, nearest first', () => {
  // Zoom selected puts the camera just beyond the selection, and the near plane follows the whole model (clipTo),
  // so other parts lie between the near plane and the camera: drawn, and before 2026-10-30 not hit (three.js starts
  // an orthographic camera's ray at its position), so a click on them picked what was behind them, or nothing.
  const root = new THREE.Group();
  const plane = (z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    m.position.z = z;
    root.add(m);
    return m;
  };
  const behind = plane(-5), front = plane(5), beyond = plane(150);
  const edge = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(3, -1, 5),
    new THREE.Vector3(3, 1, 5)]));
  root.add(edge);
  root.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  const at = (x: number) => pick(camera, root, new THREE.Vector2(x / 10, 0), 0.1)?.object;
  assert.equal(at(0), front);
  assert.equal(at(3), edge);
  front.visible = false;
  assert.equal(at(0), behind);
  // Beyond the near plane: not drawn, not hit.
  behind.visible = false;
  assert.equal(at(0), undefined);
  assert.ok(beyond);
});
