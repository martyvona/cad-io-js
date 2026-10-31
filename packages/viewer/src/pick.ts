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
  /** On a section's cap (the plane across this axis), not a face: the part cut. */
  cap?: 'x' | 'y' | 'z';
}

/** What else a ray meets that raycasting doesn't see: section caps (Sections.capHits). */
export type ExtraHits = (ray: THREE.Ray) => { object: THREE.Object3D; point: THREE.Vector3; distance: number;
  cap?: 'x' | 'y' | 'z' }[];

/** Pixels within which a line or point is hit. */
export const PICK_PIXELS = 4;

const raycaster = new THREE.Raycaster();

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

const isMesh = (o: THREE.Object3D | null | undefined) => !!(o as THREE.Mesh | undefined)?.isMesh;

/** A line or point drawn with a mesh: its child (the part's edges, curves, points; scene-graph.ts). */
function ownLine(line: THREE.Object3D, mesh: THREE.Object3D): boolean {
  return line.parent === mesh;
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

const sphere = new THREE.Sphere();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();

/**
 * The hits on a line or points within `reach` of the ray, measured in the world. three.js's own raycasting turns its
 * threshold into the object's units by the object's own scale alone, not its ancestors', so under a part scaled from
 * metres lines were hit 1000 times too far away, and a click in empty space picked the nearest part's edges
 * (2026-10-25); one threshold can't serve both its culling (in the world) and its test (in the object's units).
 */
function hitsNear(o: THREE.Line | THREE.Points, ray: THREE.Ray, reach: number, near: number, far: number,
  out: THREE.Intersection[]): void {
  const g = o.geometry;
  const pos = g.attributes.position;
  if (!pos) return;
  if (!g.boundingSphere) g.computeBoundingSphere();
  sphere.copy(g.boundingSphere!).applyMatrix4(o.matrixWorld);
  sphere.radius += reach;
  if (!ray.intersectsSphere(sphere)) return;
  const index = g.index;
  const start = Math.max(0, g.drawRange.start);
  const end = Math.min(index ? index.count : pos.count, g.drawRange.start + g.drawRange.count);
  const at = (i: number, v: THREE.Vector3) => v.fromBufferAttribute(pos, index ? index.getX(i) : i)
    .applyMatrix4(o.matrixWorld);
  const push = (onRay: THREE.Vector3, point: THREE.Vector3, index: number) => {
    const distance = ray.origin.distanceTo(onRay);
    if (distance >= near && distance <= far) out.push({ distance, point, index, object: o });
  };
  if ((o as THREE.Points).isPoints) {
    for (let i = start; i < end; i++) {
      at(i, va);
      if (ray.distanceSqToPoint(va) <= reach * reach) push(ray.closestPointToPoint(va, new THREE.Vector3()),
        ray.closestPointToPoint(va, new THREE.Vector3()), i);
    }
    return;
  }
  const step = (o as THREE.LineSegments).isLineSegments ? 2 : 1;
  const segment = (i: number, j: number) => {
    const onRay = new THREE.Vector3();
    const onSegment = new THREE.Vector3();
    if (ray.distanceSqToSegment(at(i, va), at(j, vb), onRay, onSegment) <= reach * reach) push(onRay, onSegment, i);
  };
  for (let i = start; i < end - 1; i += step) segment(i, i + 1);
  if ((o as THREE.LineLoop).isLineLoop && end - start > 1) segment(end - 1, start);
}

/**
 * What's under a point of the viewport (`ndc`, -1 to 1) among `root`'s descendants. `pixel` is a pixel's size in
 * world units (mm) at the camera's zoom.
 */
export function pick(camera: THREE.Camera, root: THREE.Object3D, ndc: THREE.Vector2, pixel: number,
  clipped?: (p: THREE.Vector3) => boolean, extra?: ExtraHits): Pick | undefined {
  const { hits: kept } = hitsAlong(camera, root, ndc, pixel, clipped, extra);
  const face = kept.find((h) => isMesh(h.object));
  const line = face ? kept.find((h) => !isMesh(h.object) && h.distance <= face.distance + 2 * PICK_PIXELS * pixel &&
    (ownLine(h.object, face.object) || faceless(h.object))) : kept[0];
  const h = line ?? face;
  if (!h) return undefined;
  const cap = (h as { cap?: Pick['cap'] }).cap;
  return { object: h.object, ...(h.faceIndex !== undefined && h.faceIndex !== null ? { faceIndex: h.faceIndex } : {}),
    point: h.point, distance: h.distance, ...(cap ? { cap } : {}) };
}

/**
 * Everything drawn along the ray through a point of the view (normalized device coordinates), nearest first: shown,
 * a face's triangles only where the face is drawn, nothing cut away (`clipped`); lines and points within reach of
 * the ray; and `extra`'s hits (section caps). With the ray (zooming at the cursor, viewer.ts, takes the nearest and
 * the farthest).
 */
export function hitsAlong(camera: THREE.Camera, root: THREE.Object3D, ndc: THREE.Vector2, pixel: number,
  clipped?: (p: THREE.Vector3) => boolean, extra?: ExtraHits): { hits: THREE.Intersection[]; ray: THREE.Ray } {
  raycaster.setFromCamera(ndc, camera);
  // three.js starts an orthographic camera's ray at its position and hits nothing behind it, but our near plane is
  // often negative (clipTo: zoom selected puts the camera just beyond the selection), so what's drawn between the
  // near plane and the camera wasn't hit (the user's recording, 2026-10-30): the ray starts at the near plane.
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    raycaster.ray.origin.addScaledVector(raycaster.ray.direction, ortho.near);
    raycaster.near = 0;
    raycaster.far = ortho.far - ortho.near;
  } else {
    raycaster.near = 0;
    raycaster.far = Infinity;
  }
  // What the camera draws (edges are on a layer of their own, shown or not).
  raycaster.layers.mask = camera.layers.mask;
  const hits: THREE.Intersection[] = [];
  root.traverseVisible((o) => {
    if (!raycaster.layers.test(o.layers)) return;
    if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints) {
      hitsNear(o as THREE.Line | THREE.Points, raycaster.ray, PICK_PIXELS * pixel, raycaster.near, raycaster.far, hits);
    } else raycaster.intersectObject(o, false, hits);
  });
  const kept = hits.filter((h) => shown(h.object) && (!(h.object as THREE.Mesh).isMesh || drawnFace(h)) &&
    !clipped?.(h.point));
  // (Caps lie on their plane, which clipping would count as cut away: not filtered.)
  kept.push(...(extra?.(raycaster.ray) ?? []) as THREE.Intersection[]);
  kept.sort((a, b) => a.distance - b.distance);
  return { hits: kept, ray: raycaster.ray.clone() };
}
