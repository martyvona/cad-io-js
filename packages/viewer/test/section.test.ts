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
  // The counting passes: shaders of ours (the renderer's planes don't reach them), each clipped by its own plane only.
  const planeOf = (k: THREE.Mesh) => ((k.material as THREE.ShaderMaterial).uniforms.plane!.value as THREE.Vector4)
    .toArray();
  const vector = (p: THREE.Plane) => [p.normal.x, p.normal.y, p.normal.z, p.constant];
  assert.ok(kids.slice(0, 2).every((k) => (k.material as THREE.ShaderMaterial).isShaderMaterial &&
    !(k.material as THREE.ShaderMaterial).clipping));
  assert.deepEqual(planeOf(kids[0]!), vector(planeFor('x', set.x)));
  assert.deepEqual(planeOf(kids[1]!), vector(planeFor('x', set.x)));
  assert.deepEqual(planeOf(kids[3]!), vector(planeFor('z', set.z)));
  assert.equal(((kids[0]!.material as THREE.Material).side), THREE.BackSide);
  assert.ok(capX.position.x < 101 && capX.position.x > 100.99);
  assert.ok(Math.abs(capX.scale.x - 33) < 1e-2 && Math.abs(capX.scale.y - 22) < 1e-2, `${capX.scale.toArray()}`);
  const capZ = kids[5]!;
  assert.ok(capZ.position.z > 2 && capZ.position.z < 2.01);
  assert.ok(Math.abs(capZ.scale.x - 11) < 1e-2 && Math.abs(capZ.scale.y - 22) < 1e-2, `${capZ.scale.toArray()}`);
  // The parts style (the default): the part's colour, lines a darker shade of it, at the part's angle.
  const hatch = (m: THREE.Material) => m.userData.hatch as Hatch;
  assert.deepEqual(hatch(capX.material as THREE.Material),
    partHatch(solid.name, (solid.material as THREE.MeshPhongMaterial).color));
  assert.equal(hatch(capX.material as THREE.Material).ground.getHex(), 0xff0000);
  // Each cap clears the stencil after it's drawn, for the next part's count.
  let cleared = 0;
  const r = { clearStencil: () => { cleared++; } } as unknown as THREE.WebGLRenderer;
  capX.onAfterRender(r, new THREE.Scene(), new THREE.Camera(), capX.geometry, capX.material as THREE.Material,
    null as unknown as THREE.Group);
  assert.equal(cleared, 1);
  // The same hatching on both planes, a material each (the lines lie in the plane).
  assert.notEqual(capX.material, capZ.material);
  assert.deepEqual(hatch(capX.material as THREE.Material), hatch(capZ.material as THREE.Material));
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
  s.setStyle('drawing');
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
  s.setStyle('drawing');
  s.update(root);
  const caps = () => (s.group.children as THREE.Mesh[]).filter((k) => k.material instanceof THREE.MeshBasicMaterial &&
    (k.material as THREE.MeshBasicMaterial).colorWrite).map((k) => (k.material as THREE.Material).userData.hatch as
    Hatch);
  // The drawing style: the beiges alternate by colour, black lines; the angle and spacing as in the parts style.
  const drawn = caps();
  assert.deepEqual(drawn.map((h) => [h.ground.getHex(), h.ink.getHex()]), [[0xe9d9b8, 0], [0xf1e9d2, 0],
    [0xe9d9b8, 0]]);
  assert.deepEqual(drawn.map((h) => [h.angle, h.spacing]), colours.map((c, i) => {
    const p = partHatch(`part ${i}`, new THREE.Color(c));
    return [p.angle, p.spacing];
  }));
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

test('hatching: on the plane, spaced by the model\'s size; size, width and pixel ratio shared', () => {
  const { s } = sections();
  const root = new THREE.Group();
  root.position.set(7, -3, 2);
  const m = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 4), new THREE.MeshPhongMaterial({ color: 0x00ff00 }));
  root.add(m);
  root.updateWorldMatrix(true, true);
  const set = DEFAULT_SECTIONS();
  set.x = { on: true, at: 7, flip: false };
  set.z = { on: true, at: 2, flip: false };
  s.set(set);
  s.setHatchWidth(2.5);
  s.update(root);
  const quads = (s.group.children as THREE.Mesh[]).filter((k) => k.geometry.type === 'PlaneGeometry');
  const compiled = quads.map((q) => {
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader:
      'void main() {\n#include <project_vertex>\n}', fragmentShader: 'void main() {\n#include <color_fragment>\n}' };
    (q.material as THREE.Material).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer);
    return shader;
  });
  const [x, z] = compiled as [typeof compiled[0], typeof compiled[0]];
  assert.ok(x.vertexShader.includes('hatchWorld =') && x.fragmentShader.includes('dFdx(hatchT)'));
  // The bounding sphere of the 6 x 8 x 4 box: half its diagonal.
  assert.ok(Math.abs((x.uniforms.hatchSize!.value as number) - Math.sqrt(36 + 64 + 16) / 2) < 1e-9);
  assert.equal(x.uniforms.hatchWidth!.value, 2.5);
  assert.equal(x.uniforms.hatchPixelRatio!.value, 2);
  // Shared, so the width changes without new materials.
  s.setHatchWidth(1);
  assert.equal(z.uniforms.hatchWidth!.value, 1);
  assert.equal(x.uniforms.hatchSize, z.uniforms.hatchSize);
  // The lines' normal in each plane at the part's angle: across x from y towards z, across z from x towards y.
  const a = partHatch(m.name, new THREE.Color(0x00ff00)).angle;
  const near = (v: unknown, w: number[]) => (v as THREE.Vector3).toArray().every((c, i) =>
    Math.abs(c - w[i]!) < 1e-12);
  assert.ok(near(x.uniforms.hatchDir!.value, [0, Math.cos(a), Math.sin(a)]));
  assert.ok(near(z.uniforms.hatchDir!.value, [Math.cos(a), Math.sin(a), 0]));
  assert.equal(x.uniforms.hatchSpacing!.value, partHatch(m.name, new THREE.Color(0x00ff00)).spacing);
});

test('capHits: a ray into the kept side through a cap, inside the part cut; not elsewhere, nor where cut away', () => {
  const { s } = sections();
  const { root, solid } = model();
  // The solid: x 95..105, y -10..10, z -15..15; cut at x 101 (above cut away), and at z 2 flipped (below cut away).
  const set = DEFAULT_SECTIONS();
  set.x = { on: true, at: 101, flip: false };
  s.set(set);
  root.updateWorldMatrix(true, true);
  s.update(root);
  const ray = (o: number[], d: number[]) => new THREE.Ray(new THREE.Vector3(...o), new THREE.Vector3(...d));
  // Through the middle of the far face, along the edge its two triangles share: one crossing, a hit.
  assert.equal(s.capHits(ray([200, 0, 0], [-1, 0, 0])).length, 1);
  const hits = s.capHits(ray([200, 0, 5], [-1, 0, 0]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.object, solid);
  assert.equal(hits[0]!.cap, 'x');
  assert.deepEqual([hits[0]!.point.toArray(), hits[0]!.distance], [[101, 0, 5], 99]);
  // Beside the part, from the other side (into the cut-away side), along the plane: none.
  assert.equal(s.capHits(ray([200, 15, 5], [-1, 0, 0])).length, 0);
  assert.equal(s.capHits(ray([0, 0, 5], [1, 0, 0])).length, 0);
  assert.equal(s.capHits(ray([101, 50, 5], [0, -1, 0])).length, 0);
  // Slanting in: where it crosses the plane.
  const slant = s.capHits(ray([111, 0, 5], [-1, 0.5, 0].map((x) => x / Math.hypot(1, 0.5))));
  assert.equal(slant.length, 1);
  assert.ok(Math.abs(slant[0]!.point.x - 101) < 1e-9 && Math.abs(slant[0]!.point.y - 5) < 1e-9);
  // With z cut below 2 too: z 5 still a hit, z 0 cut away by the other plane.
  set.z = { on: true, at: 2, flip: true };
  s.set(set);
  s.update(root);
  assert.equal(s.capHits(ray([200, 0, 5], [-1, 0, 0])).length, 1);
  assert.equal(s.capHits(ray([200, 0, 0], [-1, 0, 0])).filter((h) => h.cap === 'x').length, 0);
  // Caps off: none.
  s.set({ ...set, caps: false });
  s.update(root);
  assert.equal(s.capHits(ray([200, 0, 5], [-1, 0, 0])).length, 0);
});

test('capHits: inside the part\'s box but not its solid (a ring\'s hole), no hit; in its tube, a hit', () => {
  const { s } = sections();
  const root = new THREE.Group();
  // A ring about z, radius 10, its tube 2; cut across x at 0, looking along -x.
  root.add(new THREE.Mesh(new THREE.TorusGeometry(10, 2, 16, 48), new THREE.MeshPhongMaterial()));
  root.updateWorldMatrix(true, true);
  const set = DEFAULT_SECTIONS();
  set.x = { on: true, at: 0, flip: false };
  s.set(set);
  s.update(root);
  const ray = (y: number) => new THREE.Ray(new THREE.Vector3(50, y, 0), new THREE.Vector3(-1, 0, 0));
  assert.equal(s.capHits(ray(0)).length, 0);
  assert.equal(s.capHits(ray(10)).length, 1);
});
