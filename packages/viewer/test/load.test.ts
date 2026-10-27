import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { readColoursAsSrgb, srgbColoursFrom } from '../src/load.ts';

test('srgbColoursFrom: Onshape\'s glTF files (sRGB factors), not others', () => {
  assert.equal(srgbColoursFrom('ONSHAPE BY PTC INC, 1.222'), true);
  assert.equal(srgbColoursFrom('Onshape'), true);
  for (const g of ['Khronos glTF Blender I/O v4.2.0', 'glTF-Transform v4.5.1', 'cad-io-js', 'OnshapeLike', undefined]) {
    assert.equal(srgbColoursFrom(g), false, String(g));
  }
});

test('readColoursAsSrgb: each material once, its colour the sRGB value it holds', () => {
  const shared = new THREE.MeshStandardMaterial();
  // Onshape's orange as glTF holds it, which three.js took as linear.
  shared.color.setRGB(0.9725, 0.5294, 0.0039, THREE.LinearSRGBColorSpace);
  const other = new THREE.MeshStandardMaterial();
  other.color.setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), shared), new THREE.Mesh(new THREE.BoxGeometry(), [shared, other]));
  readColoursAsSrgb(root);
  // Shown as 248, 135, 1 (sRGB), as Onshape shows it; converted once though used twice.
  assert.equal(shared.color.getHexString(THREE.SRGBColorSpace), 'f88701');
  assert.equal(other.color.getHexString(THREE.SRGBColorSpace), '808080');
});
