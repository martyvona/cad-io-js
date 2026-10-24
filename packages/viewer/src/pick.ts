// Picking in the 3D view (the user, 2026-10-24; CLAUDE.md, "The viewer"): a ray from the camera through the pointer,
// brute force over every object (three-mesh-bvh is a backlog item). What isn't drawn isn't picked: hidden objects (or
// with a hidden ancestor), parts' own drawings hidden by their layer (the raycaster's layers), hidden faces (their
// geometry group's material), and what the section planes cut away (`clipped`). Lines and points are hit within a
// few pixels; an edge or point no farther than its face (give or take those pixels) wins over the face.

import * as THREE from 'three';

export interface Pick {
  object: THREE.Object3D;
  /** The triangle, for meshes. */
  faceIndex?: number;
  point: THREE.Vector3;
  distance: number;
}

/** Pixels within which a line or point is hit. */
export const PICK_PIXELS = 4;

const raycaster = new THREE.Raycaster();

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function drawnFace(hit: THREE.Intersection): boolean {
  const m = (hit.object as THREE.Mesh).material;
  if (!Array.isArray(m)) return m.visible;
  const g = hit.face?.materialIndex ?? 0;
  return m[g]?.visible ?? false;
}

/**
 * What's under a point of the viewport (`ndc`, -1 to 1) among `root`'s descendants. `pixel` is a pixel's size in
 * world units (mm) at the camera's zoom.
 */
export function pick(camera: THREE.Camera, root: THREE.Object3D, ndc: THREE.Vector2, pixel: number,
  clipped?: (p: THREE.Vector3) => boolean): Pick | undefined {
  raycaster.setFromCamera(ndc, camera);
  // What the camera draws (edges are on a layer of their own, shown or not).
  raycaster.layers.mask = camera.layers.mask;
  raycaster.params.Line.threshold = PICK_PIXELS * pixel;
  raycaster.params.Points.threshold = PICK_PIXELS * pixel;
  const hits = raycaster.intersectObject(root, true).filter((h) => shown(h.object) && (!(h.object as THREE.Mesh).isMesh
    || drawnFace(h)) && !clipped?.(h.point));
  const nearest = hits[0];
  if (!nearest) return undefined;
  const line = hits.find((h) => !(h.object as THREE.Mesh).isMesh && h.distance <= nearest.distance +
    2 * PICK_PIXELS * pixel);
  const h = line ?? nearest;
  return { object: h.object, ...(h.faceIndex !== undefined && h.faceIndex !== null ? { faceIndex: h.faceIndex } : {}),
    point: h.point, distance: h.distance };
}
