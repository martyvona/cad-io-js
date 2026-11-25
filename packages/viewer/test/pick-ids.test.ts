import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NodeModel } from '../src/model.ts';
import { pickOfTarget } from '../src/pick.ts';
import { choose, coverRuns, faceIndexAttribute, itemIndexAttribute, mergeRuns, PICK_INDEX, PickIds,
  type IdTarget, type IdWindow } from '../src/pick-ids.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { setItems } from '../src/items.ts';
import { highlightForPick, nodeForPick } from '../src/selection.ts';
import { detailOf, plate, scene, wire } from './fixtures.ts';

test('pick ids: each vertex its face, a copy for each later face that shares it; items by their ranges', () => {
  // Two faces apart: each vertex its face's place plus one.
  assert.deepEqual([...faceIndexAttribute([0, 1, 2, 3, 4, 5], [{ start: 0, count: 3 }, { start: 3, count: 3 }], 6)
    .pickIndex], [1, 1, 1, 2, 2, 2]);
  assert.equal(faceIndexAttribute([0, 1, 2], [{ start: 0, count: 3 }], 3).split, undefined);
  // Faces sharing vertices 0 and 2 (the plate's): the second face's uses of them copies (4 and 5), the first's kept.
  const shared = faceIndexAttribute([0, 1, 2, 0, 2, 3], [{ start: 0, count: 3 }, { start: 3, count: 3 }], 4);
  assert.deepEqual([...shared.split!.index], [0, 1, 2, 4, 5, 3]);
  assert.deepEqual([...shared.split!.copies], [0, 2]);
  assert.deepEqual([...shared.pickIndex], [1, 1, 1, 2, 2, 2]);
  // A copy made once per face, used again within it.
  const twice = faceIndexAttribute([0, 1, 2, 0, 2, 3, 0, 3, 2], [{ start: 0, count: 3 }, { start: 3, count: 6 }], 4);
  assert.deepEqual([...twice.split!.index], [0, 1, 2, 4, 5, 3, 4, 3, 5]);
  // A mesh without faces: one, all of it.
  assert.deepEqual([...faceIndexAttribute([0, 1, 2], [], 3).pickIndex], [1, 1, 1]);
  // Items: the vertices of each range (a vertex no item uses: 0).
  assert.deepEqual([...itemIndexAttribute([5, 6, 6, 1, 0, 3], [{ start: 0, count: 4 }, { start: 4, count: 2 }], 7)],
    [1, 0, 0, 1, 0, 0, 0]);
});

/** The fixtures' scene meshed: the plate (faces 8 and 7, its edges) and the wireframe (a curve and a point). */
function meshed() {
  const graph = new SceneGraph(scene(), 'model');
  graph.addMesh(0, plate());
  graph.addMesh(1, wire());
  graph.root.updateMatrixWorld(true);
  const model = new NodeModel(graph.root, graph);
  const placements: THREE.Object3D[] = [];
  graph.root.traverse((o) => { if (o.userData.faceRanges !== undefined) placements.push(o); });
  return { graph, model, placements };
}

test('pick ids: numbered depth first, a placement its cap, faces, items and outlines in a run, each resolved', () => {
  const { graph, placements } = meshed();
  // The three subassemblies' plate and wireframe, in the tree's order.
  assert.deepEqual(placements.map((p) => (p as THREE.Mesh).isMesh === true), [true, false, true, false, true, false]);
  const ids = new PickIds();
  ids.assign(graph.root);
  const [plate0, wire0, plate1] = placements as [THREE.Mesh, THREE.Group, THREE.Mesh];
  const edges = plate0.children.find((c) => c.name === 'edges')!;
  // The plate: its cap 1, faces 2 and 3, its edge (the shared one; the seam isn't drawn) 4; the wireframe's cap 5, its
  // no faces 6, its curve 7, its point 8; the next plate from 9.
  assert.equal(ids.baseOf(plate0), 1);
  assert.equal(ids.baseOf(edges), 4);
  assert.equal(ids.baseOf(wire0), 5);
  assert.equal(ids.baseOf(wire0.children.find((c) => c.name === 'curves')!), 7);
  assert.equal(ids.baseOf(wire0.children.find((c) => c.name === 'points')!), 8);
  assert.equal(ids.baseOf(plate1), 9);
  const t = (id: number) => {
    const r = ids.resolve(id);
    return r && { placement: placements.indexOf(r.placement), object: r.object.name, face: r.face, item: r.item,
      cap: r.cap, line: r.line };
  };
  const none = { face: undefined, item: undefined, cap: undefined, line: undefined };
  assert.deepEqual(t(1), { ...none, placement: 0, object: plate0.name, cap: true });
  assert.deepEqual(t(2), { ...none, placement: 0, object: plate0.name, face: 0 });
  assert.deepEqual(t(3), { ...none, placement: 0, object: plate0.name, face: 1 });
  assert.deepEqual(t(4), { ...none, placement: 0, object: 'edges', item: 0, line: true });
  // (A placement without faces: its one face id stands for it, no face.)
  assert.deepEqual(t(6), { ...none, placement: 1, object: wire0.name });
  assert.deepEqual(t(8), { ...none, placement: 1, object: 'points', item: 0, line: true });
  assert.deepEqual(t(9), { ...none, placement: 2, object: plate1.name, cap: true });
  assert.equal(ids.resolve(0), undefined);
  assert.equal(ids.resolve(1000), undefined);
  // Highlight overlays (the selection's) aren't numbered.
  const overlay = new THREE.LineSegments(new THREE.BufferGeometry());
  overlay.userData.highlight = true;
  plate0.add(overlay);
  ids.assign(graph.root);
  assert.equal(ids.baseOf(overlay), undefined);
  assert.equal(ids.baseOf(wire0), 5);
});

test('pick ids: a failed face\'s outline its own id after the placement\'s items; nothing numbered without a root',
  () => {
    const graph = new SceneGraph(scene(), 'model');
    // Face 7 fails (no triangles) and has an outline.
    const p = plate();
    graph.addMesh(0, { ...p, faces: [p.faces[0]!, { source: 7, start: 3, count: 0 }],
      faceOutlinePositions: Float32Array.of(0, 0, 0, 1, 0, 0),
      faceOutlines: [{ source: 7, start: 0, count: 2 }] });
    const mesh = graph.madeFor(0)[0]!;
    const outline = mesh.children.find((c) => c.name === 'outline')!;
    const ids = new PickIds();
    ids.assign(graph.root);
    // Cap 1, faces 2 and 3, the edge 4, the outline 5.
    assert.equal(ids.baseOf(outline), 5);
    assert.deepEqual(ids.resolve(5), { placement: mesh, object: outline, line: true });
    ids.assign(undefined);
    assert.equal(ids.resolve(1), undefined);
  });

test('pick ids: pieces as runs of ids, a placement whole its block, faces and items their own, joined', () => {
  const { graph, placements } = meshed();
  const ids = new PickIds();
  ids.assign(graph.root);
  const [plate0, wire0, plate1] = placements as [THREE.Mesh, THREE.Group, THREE.Mesh];
  assert.deepEqual(ids.idsOf([{ object: plate0 }]), [[1, 5]]);
  // An assembly: its placements' blocks, one run.
  assert.deepEqual(ids.idsOf([{ object: plate0 }, { object: wire0 }]), [[1, 9]]);
  // A face: the faces its ranges overlap (face 7, the second range).
  assert.deepEqual(ids.idsOf([{ object: plate0, ranges: [{ start: 3, count: 3 }] }]), [[3, 4]]);
  assert.deepEqual(ids.idsOf([{ object: plate0, ranges: [{ start: 2, count: 2 }] }]), [[2, 4]]);
  // A line object whole, an item.
  const curves = wire0.children.find((c) => c.name === 'curves')!;
  assert.deepEqual(ids.idsOf([{ object: curves }]), [[7, 8]]);
  assert.deepEqual(ids.idsOf([{ object: curves, ranges: [{ start: 0, count: 2 }] }]), [[7, 8]]);
  // Apart, sorted.
  assert.deepEqual(ids.idsOf([{ object: plate1 }, { object: curves }]), [[7, 8], [9, 13]]);
  assert.deepEqual(ids.idsOf([{ object: new THREE.Mesh() }]), []);
});

test('pick ids: runs joined where they touch; covered by fewer, the narrowest gaps filled first', () => {
  assert.deepEqual(mergeRuns([[5, 7], [1, 3], [3, 4], [6, 9]]), [[1, 4], [5, 9]]);
  assert.deepEqual(mergeRuns([]), []);
  const runs: [number, number][] = [[1, 2], [3, 4], [10, 11], [12, 13], [30, 31]];
  assert.deepEqual(coverRuns(runs, 5), runs);
  assert.deepEqual(coverRuns(runs, 3), [[1, 4], [10, 13], [30, 31]]);
  assert.deepEqual(coverRuns(runs, 1), [[1, 31]]);
});

test('pick ids: the attributes the scene graph gives (faces sharing vertices drawn from a copy), items\' too', () => {
  const { placements } = meshed();
  const [plate0, wire0] = placements as [THREE.Mesh, THREE.Group];
  // The plate's faces share two vertices: its geometry has none of its own, its picking geometry's copies.
  assert.equal(plate0.geometry.getAttribute(PICK_INDEX), undefined);
  const pick = plate0.geometry.userData.pick as THREE.BufferGeometry;
  assert.deepEqual([...pick.getAttribute(PICK_INDEX).array], [1, 1, 1, 2, 2, 2]);
  assert.deepEqual([...pick.index!.array], [0, 1, 2, 4, 5, 3]);
  assert.deepEqual([...pick.getAttribute('position').array].slice(12), [0, 0, 0, 25.4, 25.4, 0].map(Math.fround));
  // Its groups as the drawn geometry's (hidden faces stay hidden in the id pass).
  assert.deepEqual(pick.groups, plate0.geometry.groups);
  // Faces apart: the drawn geometry has the attribute.
  const g = new SceneGraph(scene(), 'model');
  const p = plate();
  g.addMesh(0, { ...p, positions: Float32Array.of(...p.positions, ...p.positions.slice(0, 3), ...p.positions.slice(6,
    9)), indices: Uint32Array.of(0, 1, 2, 4, 5, 3) });
  const apart = g.madeFor(0)[0] as THREE.Mesh;
  assert.deepEqual([...apart.geometry.getAttribute(PICK_INDEX).array], [1, 1, 1, 2, 2, 2]);
  assert.equal(apart.geometry.userData.pick, undefined);
  // The wireframe's points, one each.
  const points = wire0.children.find((c) => c.name === 'points') as THREE.Points;
  assert.deepEqual([...points.geometry.getAttribute(PICK_INDEX).array], [0]);
});

/** A window of ids, rows from the bottom, the pointer at its centre. */
const win = (rows: number[][]): IdWindow => {
  const height = rows.length, width = rows[0]!.length;
  return { ids: Uint32Array.from(rows.slice().reverse().flat()), width, height, cx: width >> 1, cy: height >> 1 };
};

test('pick ids: the face under the pointer, beaten by its own lines and points near it, not by others\'', () => {
  const a = new THREE.Mesh(), b = new THREE.Mesh(), w = new THREE.Group();
  const lineA = new THREE.LineSegments(), lineB = new THREE.LineSegments(), pointA = new THREE.Points();
  const curve = new THREE.LineSegments();
  const targets: Record<number, IdTarget> = {
    1: { placement: a, object: a, face: 0 }, 2: { placement: b, object: b, face: 0 },
    11: { placement: a, object: lineA, item: 0, line: true }, 12: { placement: a, object: lineA, item: 1, line: true },
    21: { placement: b, object: lineB, item: 0, line: true }, 31: { placement: a, object: pointA, item: 0, line: true },
    41: { placement: w, object: curve, item: 0, line: true },
  };
  const resolve = (id: number) => targets[id];
  const faces = (c: number) => win([[c, c, c, c, c], [c, c, c, c, c], [c, c, c, c, c], [c, c, c, c, c],
    [c, c, c, c, c]]);
  const lines = (at: [number, number, number][]) => {
    const rows = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
    for (const [x, y, id] of at) rows[4 - y]![x] = id;
    return win(rows);
  };
  // Its own line two pixels away (reach 2): the line; at three, the face.
  assert.equal(choose(faces(1), lines([[4, 2, 11]]), 2, resolve), 11);
  assert.equal(choose(faces(1), lines([[4, 2, 11]]), 1.9, resolve), 1);
  // Another placement's line, however near: the face.
  assert.equal(choose(faces(1), lines([[2, 2, 21]]), 2, resolve), 1);
  // A wireframe's line (a placement without faces): it wins.
  assert.equal(choose(faces(1), lines([[3, 2, 41]]), 2, resolve), 41);
  // The nearest of its lines; a point within reach beats a nearer line; a tie the lower id.
  assert.equal(choose(faces(1), lines([[4, 2, 11], [3, 2, 12]]), 2, resolve), 12);
  assert.equal(choose(faces(1), lines([[2, 2, 12], [2, 4, 31]]), 2, resolve), 31);
  assert.equal(choose(faces(1), lines([[1, 2, 12], [3, 2, 11]]), 2, resolve), 11);
  // Nothing under the pointer: the nearest line or point, anyone's; or nothing.
  assert.equal(choose(faces(0), lines([[3, 3, 21], [4, 2, 11]]), 2, resolve), 21);
  assert.equal(choose(faces(0), lines([]), 2, resolve), 0);
  // The pointer at the window's edge (the buffer's corner): what's there.
  assert.equal(choose({ ...faces(2), cx: 0, cy: 0 }, { ...lines([]), cx: 0, cy: 0 }, 2, resolve), 2);
});

test('pick ids: a target\'s point where the ray meets it, a face\'s triangle its faceIndex; lines\' and points\' '
  + 'nearest the ray', () => {
  const { placements } = meshed();
  const [plate0, wire0] = placements as [THREE.Mesh, THREE.Group];
  // The plate in the world: x 125.4 to 150.8, y 0 to 25.4 (its origin, then the left placement's x 100), z 5 up to
  // 7.54 (a corner raised).
  const down = (x: number, y: number) => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1));
  // Face 8 (range 0, triangle 0): below the diagonal; face 7 (range 1, triangle 1) above it.
  const a = pickOfTarget({ placement: plate0, object: plate0, face: 0 }, down(145, 5))!;
  assert.equal(a.faceIndex, 0);
  assert.ok(a.point.distanceTo(new THREE.Vector3(145, 5, 5)) < 1e-4, `${a.point.toArray()}`);
  assert.ok(Math.abs(a.distance - 95) < 1e-4);
  const b = pickOfTarget({ placement: plate0, object: plate0, face: 1 }, down(130, 20))!;
  assert.equal(b.faceIndex, 1);
  // Missing the face (a pixel's rounding at its edge): its vertex nearest the ray.
  const c = pickOfTarget({ placement: plate0, object: plate0, face: 1 }, down(152, -1))!;
  assert.equal(c.faceIndex, 1);
  assert.ok(c.point.distanceTo(new THREE.Vector3(150.8, 25.4, 5)) < 1e-4, `${c.point.toArray()}`);
  // A line's item: the point on it nearest the ray, its item kept.
  const edges = plate0.children.find((o) => o.name === 'edges')!;
  const e = pickOfTarget({ placement: plate0, object: edges, item: 0, line: true }, down(140, 14))!;
  assert.equal(e.item, 0);
  assert.equal(e.object, edges);
  assert.ok(e.point.distanceTo(new THREE.Vector3(139.7, 14.3, 5)) < 1e-3, `${e.point.toArray()}`);
  // A point: itself (the wireframe's at 5, 5, 5, placed at x 100, z 5).
  const points = wire0.children.find((o) => o.name === 'points')!;
  const p = pickOfTarget({ placement: wire0, object: points, item: 0, line: true }, down(105.5, 5))!;
  assert.deepEqual(p.point.toArray(), [105, 5, 10]);
  // A cap: the caller's.
  assert.equal(pickOfTarget({ placement: plate0, object: plate0, cap: true }, down(130, 5)), undefined);
  // A face folded over itself: its nearer triangle (the second, z 1, over the first, z 0).
  const tri = (z: number) => [0, 0, z, 10, 0, z, 0, 10, z];
  const folded = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(
    Float32Array.from([...tri(0), ...tri(1)]), 3)).setIndex([0, 1, 2, 3, 4, 5]));
  folded.userData.faceRanges = [{ source: 1, start: 0, count: 6 }];
  const near = pickOfTarget({ placement: folded, object: folded, face: 0 }, down(1, 1))!;
  assert.equal(near.faceIndex, 1);
  assert.equal(near.point.z, 1);
  // An item of two segments apart: the point on one of them, not across the gap between them.
  const twice = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(
    Float32Array.of(0, 0, 0, 4, 0, 0, 6, 0, 0, 10, 0, 0), 3)).setIndex([0, 1, 2, 3]));
  setItems(twice, [{ source: 1, start: 0, count: 4 }]);
  assert.deepEqual(pickOfTarget({ placement: folded, object: twice, item: 0, line: true }, down(5, 1))!.point.toArray(),
    [4, 0, 0]);
});

test('picks of single edges, vertices and points name their nodes; the hover highlights by level', () => {
  const { model, placements } = meshed();
  const [plate0, wire0] = placements as [THREE.Mesh, THREE.Group];
  const part = model.nodeOf(plate0)!;
  model.setDetail(true);
  detailOf(model, part);
  const edges = plate0.children.find((o) => o.name === 'edges')!;
  const points = wire0.children.find((o) => o.name === 'points')!;
  const path = (id: number | undefined) => id === undefined ? undefined : model.pathOf(id);
  assert.match(path(nodeForPick(model, edges, undefined, 'detail', 0))!, /\/edges\/edge#4$/);
  // Without its item, its group, as before.
  assert.match(path(nodeForPick(model, edges, undefined, 'detail'))!, /\/edges$/);
  assert.equal(nodeForPick(model, edges, undefined, 'part', 0), part);
  detailOf(model, model.nodeOf(wire0)!);
  assert.match(path(nodeForPick(model, points, undefined, 'detail', 0))!, /\/vertices\/point#11$/);
  // An item no node has (past the end): the group.
  assert.match(path(nodeForPick(model, edges, undefined, 'detail', 5))!, /\/edges$/);
  // Highlights: a part outlined at the part and assembly levels (its objects whole).
  const forPart = highlightForPick(model, { object: plate0, faceIndex: 1 }, 'part');
  assert.ok(forPart.outline.some((p) => p.object === plate0 && !p.ranges) && forPart.marks.length === 0);
  const forAsm = highlightForPick(model, { object: plate0, faceIndex: 1 }, 'assembly');
  assert.ok(forAsm.outline.some((p) => p.object === wire0.children[0]) && forAsm.outline.length >
    forPart.outline.length);
  // Detail: the face's ranges outlined (triangle 1, face 7), an edge's range marked, a point's.
  assert.deepEqual(highlightForPick(model, { object: plate0, faceIndex: 1 }, 'detail'),
    { outline: [{ object: plate0, ranges: [{ start: 3, count: 3 }] }], marks: [] });
  // A face in two ranges: both.
  const twice = new THREE.Mesh();
  twice.userData.faceRanges = [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 },
    { source: 8, start: 6, count: 3 }];
  assert.deepEqual(highlightForPick(model, { object: twice, faceIndex: 2 }, 'detail').outline,
    [{ object: twice, ranges: [{ start: 0, count: 3 }, { start: 6, count: 3 }] }]);
  assert.deepEqual(highlightForPick(model, { object: edges, item: 0 }, 'detail'),
    { outline: [], marks: [{ object: edges, ranges: [{ start: 0, count: 2 }] }] });
  assert.deepEqual(highlightForPick(model, { object: points, item: 0 }, 'detail').marks,
    [{ object: points, ranges: [{ start: 0, count: 1 }] }]);
  // A cap (a pick without a face index): its part.
  assert.deepEqual(highlightForPick(model, { object: plate0 }, 'detail').outline, forPart.outline);
  // Detail with the tree's detail off: the face still (no nodes needed).
  model.setDetail(false);
  assert.equal(highlightForPick(model, { object: plate0, faceIndex: 0 }, 'detail').outline[0]!.ranges?.[0]?.start,
    0);
});
