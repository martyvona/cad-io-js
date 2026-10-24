// Which loader a file goes to, and how its frame maps to the viewer's world, Z up in millimetres (the user,
// 2026-10-24; CLAUDE.md, "The viewer"): STEP loads as it is; glTF is metres and Y up; a three.js JSON file is
// metres and Y up at its root (ours are, by the root's matrix, with extras or without), except files written
// before that change with our extras, whose root says millimetres and has no up axis: those are millimetres, Z up.

import * as THREE from 'three';
import { Y_UP_METRES } from 'cad-scene';

export type Format = 'step' | 'gltf' | 'glb' | 'threejs';

export const EXTENSIONS: Record<string, Format> = {
  '.stp': 'step', '.step': 'step', '.stpz': 'step', '.glb': 'glb', '.gltf': 'gltf', '.json': 'threejs',
};

/** The format a file name's extension says, or undefined. */
export function formatOf(name: string): Format | undefined {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : EXTENSIONS[name.slice(dot).toLowerCase()];
}

/** Metres and Y up to millimetres and Z up: (x, y, z) m -> (x, -z, y) mm. */
export const FROM_Y_UP_METRES = new THREE.Matrix4().fromArray(Y_UP_METRES).invert();

/** The matrix from a loaded model's frame (its root's parent) to the world. */
export function nativeFrame(format: Format, root: THREE.Object3D): THREE.Matrix4 {
  if (format === 'step') return new THREE.Matrix4();
  if (format === 'threejs' && root.userData.unit === 'millimetre' && root.userData.up === undefined) {
    return new THREE.Matrix4();
  }
  return FROM_Y_UP_METRES.clone();
}
