// Bounding volumes (the user, 2026-10-30; CLAUDE.md, "Decisions"): a box per mesh, in its own coordinates, made with
// the mesh, and one sphere for the whole model, for a viewer to fit before (and while) meshes arrive. The sphere is
// estimated from what each placed part has: its mesh's box, else its B-rep's vertices' box (Brep.vertexBox, which is
// no bound: curved faces bulge past their vertices, and meshes arriving later grow the sphere): every placed box's 8
// corners in the world, the centre the middle of their box, the radius the farthest corner (`boxesSphere`; the user,
// 2026-10-30, after Ritter's algorithm on the placed spheres' centres, the first choice, put rpbp's centre on a leg
// and made spheres 20-35 % larger than needed). Linear in the placements; it holds every box it's given.

import type { Box, Mat4, Mesh, Part, Scene, SceneBounds, Sphere, Vec3 } from './scene.ts';
import { instances, multiply } from './walk.ts';

/** The box of everything a mesh draws (triangles' vertices, edges, curves, points), in its coordinates; else none. */
export function meshBox(mesh: Mesh): Box | undefined {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const a of [mesh.positions, mesh.edgePositions, mesh.curvePositions, mesh.points]) {
    if (!a) continue;
    for (let i = 0; i + 2 < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const x = a[i + k]!;
        if (x < min[k]!) min[k] = x;
        if (x > max[k]!) max[k] = x;
      }
    }
  }
  return min[0] === Infinity ? undefined : { min, max };
}

/**
 * Gives every level's mesh its box (Mesh.box) where it has none: the importers call it for the levels they read, as
 * tessellateScene boxes its own. A mesh that draws nothing (only failure outlines, or empty) gets none.
 */
export function boxMeshes(scene: Scene): void {
  for (const part of scene.parts) {
    for (const lod of part.lods) {
      if (lod.mesh.box) continue;
      const box = meshBox(lod.mesh);
      if (box) lod.mesh.box = box;
    }
  }
}

/** A part's box in its own coordinates: its first level's mesh box (plus the mesh's origin), else its vertex box. */
function partBox(part: Part, meshesOnly: boolean): Box | undefined {
  const lod = part.lods.find((l) => l.mesh.box);
  if (lod) {
    const { min, max } = lod.mesh.box!, o = lod.mesh.origin;
    return { min: [min[0] + o[0], min[1] + o[1], min[2] + o[2]], max: [max[0] + o[0], max[1] + o[1], max[2] + o[2]] };
  }
  return meshesOnly ? undefined : part.brep?.vertexBox;
}

/** The sphere circumscribing a box. */
export function around(b: Box): Sphere {
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  return { center: c, radius: Math.hypot(b.max[0] - c[0], b.max[1] - c[1], b.max[2] - c[2]) };
}

/**
 * A sphere holding boxes, each placed by a matrix (column-major; absent, the identity): their 8 corners each in the
 * world, the centre the middle of the corners' box, the radius the farthest corner from it. Undefined for none.
 */
export function boxesSphere(boxes: Iterable<{ box: Box; matrix?: ArrayLike<number> }>): Sphere | undefined {
  const corners: number[] = [];
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { box: b, matrix: m } of boxes) {
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? b.max[0] : b.min[0], y = i & 2 ? b.max[1] : b.min[1], z = i & 4 ? b.max[2] : b.min[2];
      for (let r = 0; r < 3; r++) {
        const w = m ? m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]! : [x, y, z][r]!;
        corners.push(w);
        if (w < lo[r]!) lo[r] = w;
        if (w > hi[r]!) hi[r] = w;
      }
    }
  }
  if (!corners.length) return undefined;
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < corners.length; i += 3) {
    r2 = Math.max(r2, (corners[i]! - center[0]) ** 2 + (corners[i + 1]! - center[1]) ** 2 +
      (corners[i + 2]! - center[2]) ** 2);
  }
  return { center, radius: Math.sqrt(r2) };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The sphere `s` grown to hold `t`, its centre kept (how an estimate grows as meshes arrive). */
export function grow(s: Sphere, t: Sphere): Sphere {
  const r = Math.max(s.radius, dist(s.center, t.center) + t.radius);
  return r === s.radius ? s : { center: s.center, radius: r };
}

/**
 * The whole model's sphere, in the scene's millimetres, from every placed part (hidden ones too) that has a mesh box
 * or, unless `meshesOnly`, a B-rep vertex box: `from` 'meshes' when every placed part's came from a mesh, else
 * 'estimated'. Undefined when no part has either.
 */
export function sceneBounds(scene: Scene, opts: { meshesOnly?: boolean } = {}): SceneBounds | undefined {
  const own = scene.parts.map((p) => partBox(p, opts.meshesOnly ?? false));
  const placed: { box: Box; matrix: Mat4 }[] = [];
  let estimated = false;
  for (const inst of instances(scene)) {
    for (const ref of scene.components[inst.component]!.parts) {
      const box = own[ref.part];
      if (!box) continue;
      placed.push({ box, matrix: multiply(inst.transform, ref.transform) });
      if (!scene.parts[ref.part]!.lods.some((l) => l.mesh.box)) estimated = true;
    }
  }
  const s = boxesSphere(placed);
  return s && { ...s, from: estimated ? 'estimated' : 'meshes' };
}

/**
 * What an importer does last: every level's mesh boxed, and the model's sphere, unless the file gave one, estimated
 * from them and the B-reps' vertex boxes.
 */
export function boundScene(scene: Scene): void {
  boxMeshes(scene);
  const b = scene.bounds ?? sceneBounds(scene);
  if (b) scene.bounds = b;
}
