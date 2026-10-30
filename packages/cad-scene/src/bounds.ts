// Bounding volumes (the user, 2026-10-30; CLAUDE.md, "Decisions"): a box per mesh, in its own coordinates, made with
// the mesh, and one sphere for the whole model, for a viewer to fit before (and while) meshes arrive. The sphere is
// estimated from what each placed part has: its mesh's box, else its B-rep's vertices' box (Brep.vertexBox, which is
// no bound: curved faces bulge past their vertices, and meshes arriving later grow the sphere). Placed spheres are
// combined by Ritter's algorithm on their centres, then the radius grown to hold each whole: approximate, linear in
// the placements, never smaller than what it holds.

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

/** A part's sphere in its own coordinates: around its first level's mesh box, else its B-rep's vertex box. */
function partSphere(part: Part, meshesOnly: boolean): Sphere | undefined {
  const lod = part.lods.find((l) => l.mesh.box);
  if (lod) {
    const { min, max } = lod.mesh.box!, o = lod.mesh.origin;
    return around({ min: [min[0] + o[0], min[1] + o[1], min[2] + o[2]], max: [max[0] + o[0], max[1] + o[1],
      max[2] + o[2]] });
  }
  return !meshesOnly && part.brep?.vertexBox ? around(part.brep.vertexBox) : undefined;
}

/** The sphere circumscribing a box. */
export function around(b: Box): Sphere {
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  return { center: c, radius: Math.hypot(b.max[0] - c[0], b.max[1] - c[1], b.max[2] - c[2]) };
}

/** A sphere moved by a transform: its centre transformed, its radius scaled by the largest axis' scale. */
export function placeSphere(s: Sphere, m: Mat4): Sphere {
  const [x, y, z] = s.center;
  const center: Vec3 = [0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!) as Vec3;
  const scale = Math.max(...[0, 4, 8].map((c) => Math.hypot(m[c]!, m[c + 1]!, m[c + 2]!)));
  return { center, radius: s.radius * scale };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * A sphere holding every given sphere: Ritter's algorithm on their centres (from the first, the farthest centre from
 * it, the farthest from that; then each centre outside grows it), then the radius grown to hold every sphere whole,
 * the centre kept. Undefined for none.
 */
export function enclose(spheres: readonly Sphere[]): Sphere | undefined {
  if (!spheres.length) return undefined;
  const farthest = (p: Vec3) => spheres.reduce((a, s) => (dist(s.center, p) > dist(a.center, p) ? s : a)).center;
  const a = farthest(spheres[0]!.center), b = farthest(a);
  let c: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let r = dist(a, b) / 2;
  for (const s of spheres) {
    const d = dist(s.center, c);
    if (d <= r) continue;
    // The smallest sphere holding the old one and this point.
    const nr = (r + d) / 2, t = (nr - r) / d;
    c = [c[0] + (s.center[0] - c[0]) * t, c[1] + (s.center[1] - c[1]) * t, c[2] + (s.center[2] - c[2]) * t];
    r = nr;
  }
  for (const s of spheres) r = Math.max(r, dist(s.center, c) + s.radius);
  return { center: c, radius: r };
}

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
  const own = scene.parts.map((p) => partSphere(p, opts.meshesOnly ?? false));
  const placed: Sphere[] = [];
  let estimated = false;
  for (const inst of instances(scene)) {
    for (const ref of scene.components[inst.component]!.parts) {
      const s = own[ref.part];
      if (!s) continue;
      placed.push(placeSphere(s, multiply(inst.transform, ref.transform)));
      if (!scene.parts[ref.part]!.lods.some((l) => l.mesh.box)) estimated = true;
    }
  }
  const s = enclose(placed);
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
