// The viewer's look, apart from how frames are composed (render.ts): Phong faces for models loaded by three.js's
// loaders (ours are Phong already), edges on a layer of their own, and the rendering settings (the user,
// 2026-10-24; CLAUDE.md, "The viewer"). Kept apart from render.ts, which imports N8AO and postprocessing, so the rest
// can run in Node's tests.

import * as THREE from 'three';
import type { EdgeStyle } from './fat-edges.ts';
import { HATCH_WIDTH, type CapStyle } from './section.ts';
import type { TriangleEdgesMode } from './triangle-edges.ts';

/** The layer edges are drawn on (and only on). */
export const EDGES = 1;

export interface RenderSettings {
  /** Ambient occlusion. */
  ao: boolean;
  /** How dark, 0 to 10. */
  aoIntensity: number;
  /** Pixels. */
  aoRadius: number;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  smaa: boolean;
  edges: boolean;
  /** Triangles' edges over the faces (triangle-edges.ts), to inspect the tessellation: none, the selection's, all. */
  triangleEdges: TriangleEdgesMode;
  /** Edges as WebGL lines (one device pixel), or fat lines (fat-edges.ts) `edgeWidth` CSS pixels wide. */
  edgeStyle: EdgeStyle;
  edgeWidth: number;
  /** Phong shininess of faces. */
  shininess: number;
  /** Phong specular colour of faces, a grey from 0 (none) to 1 (white). */
  specular: number;
  /** The ambient light's intensity, and the headlight's. */
  ambient: number;
  light: number;
  /** How section caps are drawn (section.ts). */
  capStyle: CapStyle;
  /** The caps' hatching lines' width, CSS pixels at half their ink. */
  hatchWidth: number;
  /** Models loaded by three.js's loaders get Phong materials like ours (from the next file loaded). */
  cadMaterials: boolean;
}

export const DEFAULT_RENDER: RenderSettings = { ao: true, aoIntensity: 5, aoRadius: 32, aoQuality: 'High',
  smaa: true, edges: true, edgeStyle: 'fat', edgeWidth: 1.5, triangleEdges: 'off', shininess: 30, specular: 0.4,
  ambient: 1, light: 2.5, capStyle: 'parts', hatchWidth: HATCH_WIDTH,
  cadMaterials: true };

/**
 * A Phong material standing for another: its colour, opacity and transparency, sides, vertex colours and colour map;
 * faces a little behind their edges. Lines, points and Phong materials are kept as they are.
 */
export function phongFor(m: THREE.Material, shininess = DEFAULT_RENDER.shininess,
  specular = DEFAULT_RENDER.specular): THREE.Material {
  if ((m as THREE.MeshPhongMaterial).isMeshPhongMaterial || (m as THREE.LineBasicMaterial).isLineBasicMaterial ||
    (m as THREE.PointsMaterial).isPointsMaterial || !m.visible) return m;
  const s = m as THREE.MeshStandardMaterial;
  const p = new THREE.MeshPhongMaterial({ color: s.color ?? new THREE.Color(1, 1, 1), opacity: m.opacity,
    transparent: m.transparent, side: m.side, vertexColors: m.vertexColors, map: s.map ?? null,
    specular: new THREE.Color().setScalar(specular), shininess, polygonOffset: true, polygonOffsetFactor: 1,
    polygonOffsetUnits: 1 });
  p.name = m.name;
  return p;
}

/** Puts a loaded model's lines named 'edges' (as our exporters name them) on EDGES. */
export function edgeLayer(root: THREE.Object3D): void {
  root.traverse((o) => { if ((o as THREE.Line).isLine && o.name === 'edges') o.layers.set(EDGES); });
}

/** Gives a loaded model's meshes Phong materials (one per original). */
export function cadStyle(root: THREE.Object3D, shininess = DEFAULT_RENDER.shininess,
  specular = DEFAULT_RENDER.specular): void {
  const made = new Map<THREE.Material, THREE.Material>();
  const convert = (m: THREE.Material) => {
    let p = made.get(m);
    if (!p) made.set(m, (p = phongFor(m, shininess, specular)));
    return p;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !o.userData.highlight) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    }
  });
}
