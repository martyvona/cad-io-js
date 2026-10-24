// Loading through three.js's own loaders: glTF and GLB (with the Draco and meshopt decoders, both in the build, so
// offline too) and three.js JSON. Our extras aren't read yet, except a
// three.js root's unit and up axis (formats.ts). A model comes as its bytes plus a way to find the files it refers
// to (a .gltf's .bin and images): beside its URL, or among local files picked or dropped with it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Format } from './formats.ts';

export interface Source {
  /** The file's name (for messages and its format). */
  name: string;
  bytes: ArrayBuffer;
  /** Where relative references resolve: the file's URL, or undefined for a local file. */
  url?: string;
  /** Local files given with it, by name (a .gltf's .bin), as object URLs. */
  siblings?: Map<string, string>;
}

let draco: DRACOLoader | undefined;

function gltfLoader(src: Source): GLTFLoader {
  const manager = new THREE.LoadingManager();
  if (src.siblings) {
    const siblings = src.siblings;
    manager.setURLModifier((url) => siblings.get(decodeURIComponent(url.split('/').pop() ?? '')) ?? url);
  }
  draco ??= new DRACOLoader();
  return new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
}

/** The model's root object, as three.js's loader for its format makes it. */
export async function loadThree(src: Source, format: Exclude<Format, 'step'>): Promise<THREE.Object3D> {
  if (format === 'threejs') {
    const json = JSON.parse(new TextDecoder().decode(src.bytes));
    return new THREE.ObjectLoader().parseAsync(json);
  }
  const base = src.url ? new URL('.', src.url).href : '';
  const gltf = await gltfLoader(src).parseAsync(src.bytes, base);
  return gltf.scene;
}
