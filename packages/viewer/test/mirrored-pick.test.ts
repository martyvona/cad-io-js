import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';

// A mirrored placement (a world matrix of negative determinant) is drawn with its winding turned over, and three.js's
// raycast takes the ray into the mesh's own coordinates through the same mirror, so picking meets exactly what's drawn
// with one-sided materials, as the viewer's are (nothing of ours needed: this guards it).
test('a mirrored placement is picked from the side it\'s drawn on, and not from the other', () => {
  // A square in z = 0, counter-clockwise seen from +z: its front faces +z.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const hits = (scale: [number, number, number], fromZ: number) => {
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.scale.set(...scale);
    m.updateMatrixWorld(true);
    return new THREE.Raycaster(new THREE.Vector3(0.2, 0.5, fromZ), new THREE.Vector3(0, 0, -Math.sign(fromZ)))
      .intersectObject(m).length;
  };
  // Mirrored in x: the square stays in z = 0 and its normal stays +z: drawn from +z.
  assert.deepEqual([hits([-1, 1, 1], 5), hits([-1, 1, 1], -5)], [1, 0]);
  // Mirrored in z: its normal turned to -z (the renderer's front face clockwise, so drawn from -z only).
  assert.deepEqual([hits([1, 1, -1], 5), hits([1, 1, -1], -5)], [0, 1]);
  assert.deepEqual([hits([1, 1, 1], 5), hits([1, 1, 1], -5)], [1, 0]);
});
