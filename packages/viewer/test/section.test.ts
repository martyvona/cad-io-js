import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_SECTIONS, isClosed, partHatch, planeFor, Sections, type Hatch } from '../src/section.ts';

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
  const renderer = { clippingPlanes: [] as THREE.Plane[], getPixelRatio: () => 2 } as unknown as THREE.WebGLRenderer;
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
  // The drawing style (the default): beige, black lines at 45 degrees (the first part colour met).
  const hatch = (m: THREE.Material) => m.userData.hatch as Hatch;
  assert.equal(hatch(capX.material as THREE.Material).ground.getHex(), 0xe9d9b8);
  assert.equal(hatch(capX.material as THREE.Material).ink.getHex(), 0);
  assert.equal(hatch(capX.material as THREE.Material).angle, Math.PI / 4);
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

/** A part of six meshes, a box's faces each its own (as some glTF files are), under a part group, moved. */
function facesPart() {
  const part = new THREE.Group();
  part.position.set(0, 50, 0);
  const box = new THREE.BoxGeometry(2, 4, 6).toNonIndexed();
  const colours = [0x00ff00, 0x0000ff];
  // Each face its own vertices (its box only its own).
  const all = box.getAttribute('position');
  const faces = [0, 1, 2, 3, 4, 5].map((i) => {
    const face = new THREE.BufferGeometry();
    face.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(all.array).slice(18 * i, 18 * i + 18),
      3));
    return new THREE.Mesh(face, new THREE.MeshPhongMaterial({ color: colours[i % 2] }));
  });
  part.add(...faces);
  const root = new THREE.Group();
  root.add(part);
  root.updateWorldMatrix(true, true);
  return { root, part, faces };
}

test('caps: a part\'s meshes closed together are capped as one, none of them closed alone', () => {
  const { s } = sections();
  const { root, part, faces } = facesPart();
  const set = DEFAULT_SECTIONS();
  set.z = { on: true, at: 1, flip: false };
  s.set(set);
  // Each mesh on its own: open, no caps.
  s.update(root);
  assert.equal(s.group.children.length, 0);
  // As a part: every face's back and front in the stencil, in one render order, then one cap over the whole box (x
  // by y: 2 by 4, with the margin), in the first face's colour.
  s.invalidate();
  s.update(root, () => [part]);
  const kids = s.group.children as THREE.Mesh[];
  assert.equal(kids.length, 6 * 2 + 1);
  assert.deepEqual([...new Set(kids.slice(0, 12).map((k) => k.renderOrder))], [1000]);
  assert.deepEqual(new Set(kids.slice(0, 12).map((k) => k.geometry)), new Set(faces.map((f) => f.geometry)));
  const cap = kids[12]!;
  assert.equal(cap.renderOrder, 1001);
  assert.ok(Math.abs(cap.scale.x - 2.2) < 1e-2 && Math.abs(cap.scale.y - 4.4) < 1e-2, `${cap.scale.toArray()}`);
  assert.ok(Math.abs(cap.position.y - 50) < 1e-6);
  // The drawing style: the first beige.
  assert.equal(((cap.material as THREE.Material).userData.hatch as Hatch).ground.getHex(), 0xe9d9b8);
  // A face hidden: the rest is open.
  faces[3]!.visible = false;
  s.invalidate();
  s.update(root, () => [part]);
  assert.equal(s.group.children.length, 0);
});

test('caps: a part\'s meshes in frames of their own close up in the part\'s', () => {
  const { s } = sections();
  const { root, part, faces } = facesPart();
  // One face moved off and its mesh moved back: the same place in the part.
  const f = faces[0]!;
  f.geometry = f.geometry.clone().translate(10, 0, 0);
  f.position.set(-10, 0, 0);
  root.updateWorldMatrix(true, true);
  const set = DEFAULT_SECTIONS();
  set.z = { on: true, at: 1, flip: false };
  s.set(set);
  s.update(root, () => [part]);
  assert.equal(s.group.children.length, 6 * 2 + 1);
  // The face moved away: open, though its geometry and the count are the same.
  f.position.set(-9, 0, 0);
  root.updateWorldMatrix(true, true);
  s.invalidate();
  s.update(root, () => [part]);
  assert.equal(s.group.children.length, 0);
});

test('caps: what the source says of a mesh (userData.closed) decides over its triangles', () => {
  const { s } = sections();
  const root = new THREE.Group();
  // Open, but said to be closed (a solid whose mesher left a gap): capped. Closed, but said to be open: not.
  const open = new THREE.BoxGeometry();
  open.setIndex(Array.from(open.index!.array).slice(6));
  const said = new THREE.Mesh(open, new THREE.MeshPhongMaterial());
  said.userData.closed = true;
  const shell = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhongMaterial());
  shell.userData.closed = false;
  shell.position.set(5, 0, 0);
  root.add(said, shell);
  root.updateWorldMatrix(true, true);
  const set = DEFAULT_SECTIONS();
  set.z = { on: true, at: 0, flip: false };
  s.set(set);
  s.update(root);
  const kids = s.group.children as THREE.Mesh[];
  assert.equal(kids.length, 3);
  assert.equal(kids[0]!.geometry, open);
  // A part whose meshes don't all say: their triangles decide (a face said closed, the others silent: as before).
  const { root: r2, part, faces } = facesPart();
  faces[0]!.userData.closed = false;
  s.invalidate();
  s.update(r2, () => [part]);
  assert.equal(s.group.children.length, 6 * 2 + 1);
});

test('cap styles: drawing hatchings alternate by part colour; parts hatch each in its colour, by its name', () => {
  const { s } = sections();
  const root = new THREE.Group();
  const colours = [0xff0000, 0x00ff00, 0xff0000];
  colours.forEach((c, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhongMaterial({ color: c }));
    m.name = `part ${i}`;
    m.position.set(3 * i, 0, 0);
    root.add(m);
  });
  root.updateWorldMatrix(true, true);
  const set = DEFAULT_SECTIONS();
  set.z = { on: true, at: 0, flip: false };
  s.set(set);
  s.update(root);
  const caps = () => (s.group.children as THREE.Mesh[]).filter((k) => k.material instanceof THREE.MeshBasicMaterial &&
    (k.material as THREE.MeshBasicMaterial).colorWrite).map((k) => (k.material as THREE.Material).userData.hatch as
    Hatch);
  assert.deepEqual(caps().map((h) => [h.ground.getHex(), h.angle]), [[0xe9d9b8, Math.PI / 4],
    [0xf1e9d2, -Math.PI / 4], [0xe9d9b8, Math.PI / 4]]);
  s.setStyle('parts');
  s.update(root);
  const parts = caps();
  assert.deepEqual(parts.map((h) => h.ground.getHex()), colours.map((c) => new THREE.Color(c).getHex()));
  // A darker shade of the colour; angle and spacing as the hash of the name gives them, the same each time.
  assert.ok(parts.every((h, i) => h.ink.r <= h.ground.r && h.ink.g <= h.ground.g && h.ink.b <= h.ground.b &&
    JSON.stringify(h) === JSON.stringify(partHatch(`part ${i}`, new THREE.Color(colours[i])))));
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((n) => partHatch(n, new THREE.Color(0x808080)));
  assert.ok(new Set(all.map((h) => h.angle)).size > 2 && new Set(all.map((h) => h.spacing)).size > 1,
    'the angles and spacings vary between parts');
});
