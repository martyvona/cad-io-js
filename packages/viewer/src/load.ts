// Loading through three.js's own loaders: glTF and GLB (with the Draco and meshopt decoders, both in the build, so
// offline too; Draco's glTF-only decoder, the smaller, as glTF is all it decodes here) and three.js JSON. Our extras
// aren't read yet, except a three.js root's unit and up axis (formats.ts); Onshape's glTF colours are read as the
// sRGB they are (srgbColoursFrom). A model comes as its bytes plus a way to
// find the files it refers to (a .gltf's .bin and images): beside its URL, or among local files picked or dropped with
// it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
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
  draco ??= new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
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
  if (srgbColoursFrom(gltf.asset?.generator)) {
    readColoursAsSrgb(gltf.scene);
    gltf.scene.userData.srgbColours = gltf.asset.generator;
  }
  return gltf.scene;
}

/**
 * Whether a glTF writer puts sRGB colours where glTF's are linear (baseColorFactor): Onshape does, its factors the
 * same numbers as its STEP export's COLOUR_RGB (lightarm, 2026-10-27: 0.9725, 0.5294, 0.0039 in both, the orange
 * 248, 135, 1), which three.js reads, as the specification says, as linear, so they show washed out (the user,
 * 2026-10-27: colours as Onshape shows them). By its `asset.generator`, as the STEP importer knows Alibre's placements.
 */
export function srgbColoursFrom(generator: string | undefined): boolean {
  return /^ONSHAPE\b/i.test(generator ?? '');
}

/** Reads every material colour below a root as sRGB rather than linear (once each, however many meshes share it). */
export function readColoursAsSrgb(root: THREE.Object3D): void {
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) {
      if (done.has(x)) continue;
      done.add(x);
      (x as THREE.MeshStandardMaterial).color?.convertSRGBToLinear();
    }
  });
}
