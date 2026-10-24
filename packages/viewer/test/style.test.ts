import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cadStyle, EDGES, edgeLayer, phongFor } from '../src/style.ts';

test("phongFor: the material's colour, opacity, transparency, sides, vertex colours and map; behind its edges", () => {
  const map = new THREE.Texture();
  const s = new THREE.MeshStandardMaterial({ color: 0x336699, opacity: 0.4, transparent: true,
    side: THREE.DoubleSide, vertexColors: true, map, name: 'paint' });
  const p = phongFor(s, 50) as THREE.MeshPhongMaterial;
  assert.ok(p.isMeshPhongMaterial);
  assert.equal(p.color.getHex(), 0x336699);
  assert.deepEqual([p.opacity, p.transparent, p.side, p.vertexColors, p.map, p.name, p.shininess],
    [0.4, true, THREE.DoubleSide, true, map, 'paint', 50]);
  assert.ok(p.polygonOffset && p.polygonOffsetFactor > 0);
  assert.notEqual(p.color, s.color);
  // Kept as they are: Phong already, lines, points, invisible ones.
  for (const m of [new THREE.MeshPhongMaterial(), new THREE.LineBasicMaterial(), new THREE.PointsMaterial(),
    new THREE.MeshBasicMaterial({ visible: false })]) assert.equal(phongFor(m), m);
  // A material without a colour gets white.
  assert.equal((phongFor(new THREE.MeshNormalMaterial()) as THREE.MeshPhongMaterial).color.getHex(), 0xffffff);
});

test('cadStyle: Phong for every mesh, one per original material, arrays too; lines and overlays left', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const a = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const b = new THREE.Mesh(new THREE.BoxGeometry(), [shared, new THREE.MeshBasicMaterial({ color: 0x00ff00 })]);
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const overlay = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  overlay.userData.highlight = true;
  const overlayMaterial = overlay.material;
  const root = new THREE.Group().add(a, b, line, overlay);
  cadStyle(root, 12);
  const pa = a.material as unknown as THREE.MeshPhongMaterial;
  const [pb0, pb1] = b.material as unknown as THREE.MeshPhongMaterial[];
  assert.ok(pa.isMeshPhongMaterial && pb1!.isMeshPhongMaterial && pa.shininess === 12);
  assert.equal(pa, pb0);
  assert.equal(pb1!.color.getHex(), 0x00ff00);
  assert.ok((line.material as THREE.Material).type === 'LineBasicMaterial');
  assert.equal(overlay.material, overlayMaterial);
});

test("edgeLayer: lines named 'edges' drawn on the edges layer only; other lines and meshes left", () => {
  const edges = Object.assign(new THREE.LineSegments(), { name: 'edges' });
  const curves = Object.assign(new THREE.LineSegments(), { name: 'curves' });
  const mesh = Object.assign(new THREE.Mesh(), { name: 'edges' });
  edgeLayer(new THREE.Group().add(edges, curves, mesh));
  assert.equal(edges.layers.mask, 1 << EDGES);
  assert.equal(curves.layers.mask, 1);
  assert.equal(mesh.layers.mask, 1);
});
