// Picking in the 3D view (the user, 2026-10-24; CLAUDE.md, "The viewer"): a ray from the camera through the pointer,
// brute force over every object (three-mesh-bvh is a backlog item). What isn't drawn isn't picked: hidden objects (or
// with a hidden ancestor), parts' own drawings hidden by their layer (the raycaster's layers), hidden faces (their
// geometry group's material), and what the section planes cut away (`clipped`). Lines and points are hit within a
// few pixels. The face under the point wins, except over its own part's edges, curves and points near it (no farther,
// give or take those pixels), so they can be picked on it; another part's lines never beat it, however close (they
// did until 2026-10-25, so on dense models a click picked whatever part had an edge within 4 pixels). Lines and points
// of parts with no faces (wireframes) win when not behind the face, as nothing else would pick them; with no face
// under the point, the nearest line or point.

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

const isMesh = (o: THREE.Object3D | null | undefined) => !!(o as THREE.Mesh | undefined)?.isMesh;

/** A line or point drawn with a mesh: its child (our edges, curves, points), or its sibling (a glTF node's). */
function ownLine(line: THREE.Object3D, mesh: THREE.Object3D): boolean {
  return line.parent === mesh || (!!line.parent && line.parent === mesh.parent);
}

/** A line or point of a part with no faces: neither its parent nor its siblings are meshes. */
function faceless(line: THREE.Object3D): boolean {
  return !isMesh(line.parent) && !line.parent?.children.some(isMesh);
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
  const face = hits.find((h) => isMesh(h.object));
  const line = face ? hits.find((h) => !isMesh(h.object) && h.distance <= face.distance + 2 * PICK_PIXELS * pixel &&
    (ownLine(h.object, face.object) || faceless(h.object))) : hits[0];
  const h = line ?? face;
  if (!h) return undefined;
  return { object: h.object, ...(h.faceIndex !== undefined && h.faceIndex !== null ? { faceIndex: h.faceIndex } : {}),
    point: h.point, distance: h.distance };
}
