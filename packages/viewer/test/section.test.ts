import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_SECTIONS, isClosed, planeFor, Sections } from '../src/section.ts';

test('planes: the side above the position cut away, or below it when flipped', () => {
  const p = planeFor('y', { on: true, at: 5, flip: false });
  assert.ok(p.distanceToPoint(new THREE.Vector3(0, 4, 0)) > 0);
  assert.ok(p.distanceToPoint(new THREE.Vector3(0, 6, 0)) < 0);
  const f = planeFor('z', { on: true, at: -2, flip: true });
  assert.ok(f.distanceToPoint(new THREE.Vector3(0, 0, -1)) > 0);
  assert.ok(f.distanceToPoint(new THREE.Vector3(0, 0, -3)) < 0);
});

test('closed: a box (faces apart, vertices welded), inside out too; not a plane, nor a box missing a face',
  () => {
    assert.equal(isClosed(new THREE.BoxGeometry(1, 2, 3)), true);
    const inside = new THREE.BoxGeometry();
    const ix = inside.index!.array as Uint16Array;
    for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2]!, ix[i + 1]!];
    assert.equal(isClosed(inside), true);
    assert.equal(isClosed(new THREE.PlaneGeometry()), false);
    const open = new THREE.BoxGeometry();
    open.setIndex(Array.from(open.index!.array).slice(6));
    assert.equal(isClosed(open), false);
    // Non-indexed, as some loaders give them.
    assert.equal(isClosed(new THREE.BoxGeometry().toNonIndexed()), true);
    // Cached on the geometry, and the cache believed.
    const g = new THREE.BoxGeometry();
    isClosed(g);
    assert.equal(g.userData.closed, true);
    g.userData.closed = false;
    assert.equal(isClosed(g), false);
  });

/** Sections on a stand-in renderer (only its clipping planes are used, and clearStencil when drawing). */
function sections() {
  const renderer = { clippingPlanes: [] as THREE.Plane[] } as unknown as THREE.WebGLRenderer;
  return { renderer, s: new Sections(renderer) };
}

function model() {
  const root = new THREE.Group();
  const red = new THREE.MeshPhongMaterial({ color: 0xff0000 });
  const solid = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30), red);
  solid.position.set(100, 0, 0);
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), red);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), red);
  hidden.visible = false;
  const ownHidden = new THREE.Mesh(new THREE.BoxGeometry(), red);
  ownHidden.layers.disable(0);
  const overlay = new THREE.Mesh(new THREE.BoxGeometry(), red);
  overlay.userData.highlight = true;
  root.add(solid, sheet, hidden, ownHidden, overlay);
  return { root, solid };
}

test('caps: per visible closed mesh and plane, a back, a front and a quad, each pair in its own render order', () => {
  const { renderer, s } = sections();
  const { root, solid } = model();
  const set = DEFAULT_SECTIONS();
  set.x = { on: true, at: 101, flip: false };
  set.z = { on: true, at: 2, flip: true };
  s.set(set);
  assert.equal(renderer.clippingPlanes.length, 2);
  s.update(root);
  const kids = s.group.children as THREE.Mesh[];
  assert.equal(kids.length, 2 * 3);
  assert.ok(kids.every((k) => k.geometry === solid.geometry || k.geometry.type === 'PlaneGeometry'));
  const orders = kids.map((k) => k.renderOrder);
  assert.deepEqual(orders, [1000, 1000, 1001, 1002, 1002, 1003]);
  // Stencil passes at the solid's place; the X cap on x = 101, a hair on the kept side, over the solid's box across
  // the plane (z by y: 30 by 20, with a 10% margin); the Z cap on z = 2, flipped (x by y: 10 by 20).
  assert.ok(kids[0]!.matrix.equals(solid.matrixWorld.clone().makeTranslation(100, 0, 0)));
  const capX = kids[2]!;
  assert.ok(capX.position.x < 101 && capX.position.x > 100.99);
  assert.ok(Math.abs(capX.scale.x - 33) < 1e-2 && Math.abs(capX.scale.y - 22) < 1e-2, `${capX.scale.toArray()}`);
  const capZ = kids[5]!;
  assert.ok(capZ.position.z > 2 && capZ.position.z < 2.01);
  assert.ok(Math.abs(capZ.scale.x - 11) < 1e-2 && Math.abs(capZ.scale.y - 22) < 1e-2, `${capZ.scale.toArray()}`);
  assert.equal((capX.material as THREE.MeshBasicMaterial).color.getHex(), 0xff0000);
  // Each cap clears the stencil after it's drawn, for the next part's count.
  let cleared = 0;
  const r = { clearStencil: () => { cleared++; } } as unknown as THREE.WebGLRenderer;
  capX.onAfterRender(r, new THREE.Scene(), new THREE.Camera(), capX.geometry, capX.material as THREE.Material,
    null as unknown as THREE.Group);
  assert.equal(cleared, 1);
  assert.equal(capX.material, capZ.material);
  // Moving a plane moves its caps, without making them again.
  set.x.at = 103;
  s.set(set);
  assert.equal(s.group.children[2], capX);
  assert.ok(capX.position.x < 103 && capX.position.x > 102.99);
  // Caps off, or no plane on: none.
  s.set({ ...set, caps: false });
  s.update(root);
  assert.equal(s.group.children.length, 0);
  s.set(DEFAULT_SECTIONS());
  s.update(root);
  assert.equal(s.group.children.length, 0);
  assert.equal(renderer.clippingPlanes.length, 0);
});

test('caps are made again only when invalidated or planes turned on or off', () => {
  const { s } = sections();
  const { root, solid } = model();
  const set = DEFAULT_SECTIONS();
  set.y = { on: true, at: 0, flip: false };
  s.set(set);
  s.update(root);
  const first = s.group.children[0];
  s.update(root);
  assert.equal(s.group.children[0], first);
  solid.visible = false;
  s.update(root);
  assert.equal(s.group.children.length, 3);
  s.invalidate();
  s.update(root);
  assert.equal(s.group.children.length, 0);
});

test('clipped: points on a cut-away side', () => {
  const { s } = sections();
  const set = DEFAULT_SECTIONS();
  set.x = { on: true, at: 0, flip: false };
  s.set(set);
  assert.equal(s.clipped(new THREE.Vector3(-1, 0, 0)), false);
  assert.equal(s.clipped(new THREE.Vector3(1, 0, 0)), true);
  s.set(DEFAULT_SECTIONS());
  assert.equal(s.clipped(new THREE.Vector3(1, 0, 0)), false);
});
