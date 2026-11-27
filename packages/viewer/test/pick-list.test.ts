import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NodeModel } from '../src/model.ts';
import { itemAt, hideItems, setItems } from '../src/items.ts';
import { hitsAlong, pickOfHit } from '../src/pick.ts';
import { listClick } from '../src/pick-list.ts';
import { nodesAlong } from '../src/selection.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { EDGES } from '../src/style.ts';
import { detailOf, plate, scene, translation, wire } from './fixtures.ts';

const IN = 25.4;
const none = { shiftKey: false, ctrlKey: false, metaKey: false };
const shift = { ...none, shiftKey: true };
const ctrl = { ...none, ctrlKey: true };
const meta = { ...none, metaKey: true };

test("Pick...'s list: clicks select as the tree's rows do, the anchor kept for shift-clicks", () => {
  const ids = [10, 11, 12, 13, 14];
  const at = (selected: number[], anchor: number | undefined, i: number, keys = none, multi = false) =>
    listClick(ids, selected, anchor, i, keys, multi);
  // A plain click: the row alone, the anchor there; on a selected row, it comes out.
  assert.deepEqual(at([99], undefined, 1), { selected: [11], anchor: 1 });
  assert.deepEqual(at([11, 12, 99], 0, 1), { selected: [12, 99], anchor: 1 });
  // Shift: the rows from the anchor, in place of the selection (with ctrl or cmd, added to it); the anchor kept.
  assert.deepEqual(at([11], 1, 3, shift), { selected: [11, 12, 13], anchor: 1 });
  assert.deepEqual(at([13], 3, 1, shift), { selected: [11, 12, 13], anchor: 3 });
  assert.deepEqual(at([99], 1, 4, { ...shift, ctrlKey: true }), { selected: [99, 11, 12, 13, 14], anchor: 1 });
  assert.deepEqual(at([99], 1, 4, { ...shift, metaKey: true }), { selected: [99, 11, 12, 13, 14], anchor: 1 });
  // Shift with nothing selected, or no anchor: a plain click.
  assert.deepEqual(at([], 1, 3, shift), { selected: [13], anchor: 3 });
  assert.deepEqual(at([99], undefined, 3, shift), { selected: [13], anchor: 3 });
  // Shift on a selected row: the span comes out (no anchor: the row alone, the anchor there).
  assert.deepEqual(at([10, 11, 12, 99], 0, 2, shift), { selected: [99], anchor: 0 });
  assert.deepEqual(at([11, 99], undefined, 1, shift), { selected: [99], anchor: 1 });
  // (With ctrl or cmd too.)
  assert.deepEqual(at([10, 11, 12, 99], 0, 2, { ...shift, ctrlKey: true }), { selected: [99], anchor: 0 });
  // Ctrl or cmd: the row added or taken out, the rest kept.
  assert.deepEqual(at([99], 0, 2, ctrl), { selected: [99, 12], anchor: 2 });
  assert.deepEqual(at([99, 12], 0, 2, meta), { selected: [99], anchor: 2 });
  // Multi-select: every click as with ctrl held.
  assert.deepEqual(at([99], undefined, 0, none, true), { selected: [99, 10], anchor: 0 });
  assert.deepEqual(at([99, 10], undefined, 0, none, true), { selected: [99], anchor: 0 });
  assert.deepEqual(at([99], 0, 2, shift, true), { selected: [99, 10, 11, 12], anchor: 0 });
});

test("items at an index: a line object's item holding a position of its index, hidden items' ranges skipped", () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 8), 3));
  g.setIndex([0, 1, 1, 2, 3, 4, 5, 6, 6, 7]);
  const o = new THREE.LineSegments(g);
  assert.equal(itemAt(o, 0), undefined);
  setItems(o, [{ source: 1, start: 0, count: 4 }, { source: 2, start: 4, count: 2 },
    { source: 3, start: 6, count: 4 }]);
  assert.deepEqual([0, 3, 4, 5, 6, 9, 10].map((i) => itemAt(o, i)), [0, 0, 1, 1, 2, 2, undefined]);
  // The second hidden: the third's segments move up to 4.
  hideItems(o, new Set([1]));
  assert.deepEqual([0, 3, 4, 7, 8].map((i) => itemAt(o, i)), [0, 0, 2, 2, undefined]);
  // The first hidden: the second starts at 0, the first (empty there too) never found.
  hideItems(o, new Set([0]));
  assert.deepEqual([0, 1, 2, 5, 6].map((i) => itemAt(o, i)), [1, 1, 2, 2, undefined]);
});

/** The fixture with its third placement shown, 50 above the first: a ray down there meets both. */
function stacked() {
  const s = scene();
  s.components[0]!.children[2]!.transform = translation(100, 0, 50);
  s.overrides = s.overrides.slice(0, 1);
  const graph = new SceneGraph(s, 'model');
  graph.addMesh(0, plate());
  graph.addMesh(1, wire());
  const model = new NodeModel(graph.root, graph);
  model.setDetail(true);
  graph.root.updateMatrixWorld(true);
  const [left, , above] = model.children(model.roots[0]!);
  const plateOf = (placement: number) => model.children(placement)[0]!;
  const find = (part: number, name: string) => detailOf(model, part).find((c) => model.nodes[c]!.name === name)!;
  // Straight down through a point of the plate (in its own coordinates), lines within 0.04 of the ray.
  const along = (x: number, y: number) => {
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -1000, 1000);
    camera.layers.enable(EDGES);
    camera.position.set(100 + IN + x, y, 500);
    camera.lookAt(100 + IN + x, y, 0);
    camera.updateMatrixWorld();
    return hitsAlong(camera, graph.root, new THREE.Vector2(0, 0), 0.01).hits.map(pickOfHit);
  };
  return { model, left: left!, above: above!, plateOf, find, along };
}

test('the nodes along a ray: at each level, each once, nearest first', () => {
  const { model, left, above, plateOf, find, along } = stacked();
  // Inside face 8 (the triangle below the diagonal), away from the edges.
  const picks = along(0.75 * IN, 0.25 * IN);
  assert.ok(picks.length >= 2 && picks.every((p, i) => i === 0 || p.distance >= picks[i - 1]!.distance));
  assert.deepEqual(nodesAlong(model, picks, 'detail'), [find(plateOf(above), 'face #8'),
    find(plateOf(left), 'face #8')]);
  assert.deepEqual(nodesAlong(model, picks, 'part'), [plateOf(above), plateOf(left)]);
  assert.deepEqual(nodesAlong(model, picks, 'assembly'), [above, left]);
  // The same objects again, nearest first still: each node at its nearest.
  assert.deepEqual(nodesAlong(model, [...picks, picks[0]!], 'part'), [plateOf(above), plateOf(left)]);
  assert.deepEqual(nodesAlong(model, [{ object: new THREE.Object3D() }, ...picks], 'part'),
    [plateOf(above), plateOf(left)]);
  // Just inside face 8 beside the diagonal: the edge there too, its own node by the item the hit's index is in.
  const beside = nodesAlong(model, along(0.5 * IN + 0.02, 0.5 * IN), 'detail');
  const of = (placement: number, name: string) => find(plateOf(placement), name);
  assert.equal(beside.length, 4);
  assert.deepEqual(new Set(beside.slice(0, 2)), new Set([of(above, 'face #8'), of(above, 'edge #4')]));
  assert.deepEqual(new Set(beside.slice(2)), new Set([of(left, 'face #8'), of(left, 'edge #4')]));
  // Farther from it than the lines' reach: the face alone.
  assert.deepEqual(nodesAlong(model, along(0.5 * IN + 0.1, 0.5 * IN), 'detail'), [of(above, 'face #8'),
    of(left, 'face #8')]);
});

test('a hit as a pick: a triangle, an item, a cap', () => {
  const mesh = new THREE.Mesh();
  const point = new THREE.Vector3(1, 2, 3);
  assert.deepEqual(pickOfHit({ object: mesh, point, distance: 4, faceIndex: 5 }),
    { object: mesh, point, distance: 4, faceIndex: 5 });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4), 3));
  g.setIndex([0, 1, 2, 3]);
  const lines = new THREE.LineSegments(g);
  setItems(lines, [{ source: 1, start: 0, count: 2 }, { source: 2, start: 2, count: 2 }]);
  assert.deepEqual(pickOfHit({ object: lines, point, distance: 4, index: 2, faceIndex: 0 }),
    { object: lines, point, distance: 4, item: 1 });
  const group = new THREE.Group();
  assert.deepEqual(pickOfHit({ object: group, point, distance: 4, cap: 'x' } as THREE.Intersection & { cap: 'x' }),
    { object: group, point, distance: 4, cap: 'x' });
});
