// Rays in the 3D view (docs/viewer.md). Picking itself is by ids drawn off screen (pick-ids.ts); here, what a pick
// of an id comes to (pickOfTarget: its point, where the pointer's ray meets it), and everything drawn along a ray,
// brute force over every object (hitsAlong: where a zoom gesture turns about; three-mesh-bvh is a backlog item). What
// isn't drawn isn't hit: hidden objects (or with a hidden ancestor), parts' own drawings hidden by their layer (the
// raycaster's layers), hidden faces (their geometry group's material), and what the section planes cut away
// (`clipped`). Lines and points are hit within a few pixels.

import * as THREE from 'three';
import { rangeOf } from './items.ts';
import type { IdTarget } from './pick-ids.ts';

export interface Pick {
  object: THREE.Object3D;
  /** The triangle, for meshes. */
  faceIndex?: number;
  /** A line's or point object's item (items.ts) picked: its place in the object's items. */
  item?: number;
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
 * metres lines were hit 1000 times too far away, and a click in empty space picked the nearest part's edges; one
 * threshold can't serve both its culling (in the world) and its test (in the object's units).
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
 * The ray through a point of the view (normalized device coordinates), set on the module's raycaster, with its range.
 * three.js starts an orthographic camera's ray at its position and hits nothing behind it, but our near plane is
 * often negative (clipTo: zoom selected puts the camera just beyond the selection), so what's drawn between the near
 * plane and the camera wasn't hit (the user's recording): the ray starts at the near plane.
 */
export function viewRay(camera: THREE.Camera, ndc: THREE.Vector2): THREE.Ray {
  raycaster.setFromCamera(ndc, camera);
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    raycaster.ray.origin.addScaledVector(raycaster.ray.direction, ortho.near);
    raycaster.near = 0;
    raycaster.far = ortho.far - ortho.near;
  } else {
    raycaster.near = 0;
    raycaster.far = Infinity;
  }
  return raycaster.ray;
}

const vc = new THREE.Vector3();

/**
 * The pick an id stands for (pick-ids.ts), its point where `ray` (the pixel's: viewRay) meets it: a face's triangles
 * (both sides; the first triangle hit its faceIndex, else the face's first), or, missing them by a pixel's rounding,
 * the face's vertex nearest the ray; an item's segments' or points' nearest the ray; a failed face's outline's. Not a
 * cap: the caller has the planes.
 */
export function pickOfTarget(t: IdTarget, ray: THREE.Ray): Pick | undefined {
  const o = t.object as THREE.Mesh | THREE.LineSegments | THREE.Points;
  o.updateWorldMatrix(true, false);
  const pos = o.geometry.getAttribute('position');
  const index = o.geometry.index;
  if (!pos) return undefined;
  const at = (i: number, v: THREE.Vector3) => v.fromBufferAttribute(pos, index ? index.getX(i) : i)
    .applyMatrix4(o.matrixWorld);
  const n = index ? index.count : pos.count;
  let best: { point: THREE.Vector3; d: number; i: number } | undefined;
  // (The point on what's picked nearest the ray.)
  const near = (point: THREE.Vector3, i: number) => {
    const d = ray.distanceSqToPoint(point);
    if (!best || d < best.d) best = { point: point.clone(), d, i };
  };
  if (t.cap) return undefined;
  if ((o as THREE.Mesh).isMesh) {
    const ranges = (o.userData.faceRanges ?? []) as { start: number; count: number }[];
    const r = t.face !== undefined ? ranges[t.face] : undefined;
    const [start, end] = r ? [r.start, r.start + r.count] : [0, n];
    let hit: { point: THREE.Vector3; i: number } | undefined;
    const p = new THREE.Vector3();
    for (let i = start; i + 2 < end; i += 3) {
      if (!ray.intersectTriangle(at(i, va), at(i + 1, vb), at(i + 2, vc), false, p)) continue;
      if (!hit || ray.origin.distanceToSquared(p) < ray.origin.distanceToSquared(hit.point)) hit = { point: p.clone(),
        i };
    }
    if (!hit) {
      for (let i = start; i < end; i++) near(at(i, va), i);
      if (best) hit = { point: best.point, i: start };
    }
    if (!hit) return undefined;
    return { object: o, faceIndex: Math.floor(hit.i / 3), point: hit.point,
      distance: ray.origin.distanceTo(hit.point) };
  }
  const r = t.item !== undefined ? rangeOf(o, t.item) : { start: 0, count: n };
  if (!r) return undefined;
  if ((o as THREE.Points).isPoints) {
    for (let i = r.start; i < r.start + r.count; i++) near(at(i, va), i);
  } else {
    for (let i = r.start; i + 1 < r.start + r.count; i += 2) {
      const onRay = new THREE.Vector3(), onSegment = new THREE.Vector3();
      ray.distanceSqToSegment(at(i, va), at(i + 1, vb), onRay, onSegment);
      near(onSegment, i);
    }
  }
  const found = best as { point: THREE.Vector3; d: number; i: number } | undefined;
  if (!found) return undefined;
  return { object: o, ...(t.item !== undefined ? { item: t.item } : {}), point: found.point,
    distance: ray.origin.distanceTo(found.point) };
}

/**
 * Everything drawn along the ray through a point of the view (normalized device coordinates), nearest first: shown,
 * a face's triangles only where the face is drawn, nothing cut away (`clipped`); lines and points within reach of
 * the ray; and `extra`'s hits (section caps). With the ray (zooming at the cursor, viewer.ts, takes the nearest and
 * the farthest).
 */
export function hitsAlong(camera: THREE.Camera, root: THREE.Object3D, ndc: THREE.Vector2, pixel: number,
  clipped?: (p: THREE.Vector3) => boolean, extra?: ExtraHits): { hits: THREE.Intersection[]; ray: THREE.Ray } {
  viewRay(camera, ndc);
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
