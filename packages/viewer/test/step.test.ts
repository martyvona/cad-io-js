import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { multiply, scaling, type Mesh } from 'cad-scene';
import { plate, scene, translation, wire } from './fixtures.ts';
import { DEFAULT_COLOR, detectEdges, polylineSegments, StepGraph } from '../src/step.ts';
import { EDGES } from '../src/style.ts';
import { workerCount } from '../src/tessellation.ts';

const close = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((x, i) => Math.abs(x - b[i]!) < 1e-9);

test('the tree: a group per component instance and placed part, with their transforms, names and visibility', () => {
  const g = new StepGraph(scene(), 'model');
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
  const g = new StepGraph(scene(), 'model');
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
});

test('meshes: wireframes as curves and points in the instance colour; no faces, no edges', () => {
  const g = new StepGraph(scene(), 'model');
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
  const g = new StepGraph(scene(), 'model');
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

test('detectEdges: meshes without lines of their own beside them; not instanced ones', () => {
  const root = new THREE.Group();
  const box = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const plain = box();
  const withChild = box();
  withChild.add(new THREE.LineSegments());
  const node = new THREE.Group();
  const withSibling = box();
  node.add(withSibling, new THREE.LineSegments());
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
  root.add(plain, withChild, node, inst);
  assert.equal(detectEdges(root), 1);
  const e = plain.children[0] as THREE.LineSegments;
  assert.ok(e.geometry instanceof THREE.EdgesGeometry);
  assert.equal(e.layers.mask, 1 << EDGES);
  assert.equal(e.geometry.getAttribute('position').count / 2, 12);
  assert.ok((plain.material as THREE.Material).polygonOffset);
  assert.equal(withChild.children.length, 1);
  assert.equal(withSibling.children.length, 0);
  assert.equal(inst.children.length, 0);
});

test('workers: one less than the cores, at most 8, at most 3 on touch devices, at least 1', () => {
  assert.equal(workerCount('desktop', 10), 8);
  assert.equal(workerCount('desktop', 6), 5);
  assert.equal(workerCount('phone', 8), 3);
  assert.equal(workerCount('tablet', 8), 3);
  assert.equal(workerCount('tablet', 2), 1);
  assert.equal(workerCount('desktop', 1), 1);
});
