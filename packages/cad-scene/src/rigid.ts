// Rigid placements (docs/brep-model.md): every occurrence's and part reference's transform a rotation and a
// translation. Each placement's stretch (a mirror, a scale, a shear: the polar decomposition's) is baked into what it
// places: a component copied per distinct stretch reaching it (its own placements then take the stretch in turn), a
// part per distinct stretch at its references, its meshes exactly and its B-rep where the stretch is a similarity (a
// mirror, an even scale; docs/brep-reference.md, "Transforms"). Placements that are rotations to the precision of the
// data (TRANSFORM_TOLERANCE) are left as they are: no copies for rounding.

import { faceOutlines, rowCount, transformBrep } from 'cad-brep';
import { meshBox } from './bounds.ts';
import type { Box, Mat4, Mesh, Occurrence, Part, PartRef, Scene, Vec3 } from './scene.ts';
import { TRANSFORM_TOLERANCE } from './transforms.ts';

/** A 3 x 3 matrix, column-major. */
type M3 = number[];

const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const lin = (m: Mat4): M3 => [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
const mul3 = (a: M3, b: M3): M3 => Array.from({ length: 9 }, (_, k) => {
  const i = k % 3, j = (k - i) / 3;
  return a[i]! * b[3 * j]! + a[3 + i]! * b[3 * j + 1]! + a[6 + i]! * b[3 * j + 2]!;
});
const apply3 = (a: M3, p: ArrayLike<number>): Vec3 => [0, 1, 2].map((i) => a[i]! * p[0]! + a[3 + i]! * p[1]!
  + a[6 + i]! * p[2]!) as Vec3;
const transpose = (a: M3): M3 => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const det3 = (a: M3) => a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[3]! * (a[1]! * a[8]! - a[2]! * a[7]!)
  + a[6]! * (a[1]! * a[5]! - a[2]! * a[4]!);
function inverse3(a: M3): M3 | undefined {
  const d = det3(a);
  if (!(Math.abs(d) > 0) || !Number.isFinite(d)) return undefined;
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a as [number, number, number, number, number, number, number, number,
    number];
  return [(a4 * a8 - a5 * a7) / d, (a2 * a7 - a1 * a8) / d, (a1 * a5 - a2 * a4) / d,
    (a5 * a6 - a3 * a8) / d, (a0 * a8 - a2 * a6) / d, (a2 * a3 - a0 * a5) / d,
    (a3 * a7 - a4 * a6) / d, (a1 * a6 - a0 * a7) / d, (a0 * a4 - a1 * a3) / d];
}

/**
 * A linear map as a rotation times a stretch, A = R K: R the polar decomposition's orthogonal factor, made a rotation
 * where it's a mirror (times a mirror in z, which K then holds). Undefined for a singular map.
 */
export function rigidPart(a: M3): { rotation: M3; stretch: M3 } | undefined {
  let x = a.slice();
  for (let k = 0; k < 100; k++) {
    const inv = inverse3(x);
    if (!inv) return undefined;
    const y = transpose(inv), next = x.map((v, i) => (v + y[i]!) / 2);
    const change = Math.max(...next.map((v, i) => Math.abs(v - x[i]!)));
    x = next;
    if (change <= 1e-15) break;
  }
  const rotation = det3(x) < 0 ? mul3(x, [1, 0, 0, 0, 1, 0, 0, 0, -1]) : x;
  return { rotation, stretch: mul3(transpose(rotation), a) };
}

/** Whether a stretch is the identity to the data's precision. */
const isNone = (k: M3) => k.every((v, i) => Math.abs(v - I3[i]!) <= TRANSFORM_TOLERANCE);
/** Whether a stretch is a similarity (a mirror, an even scale): what a B-rep can hold. */
function similarityScale(k: M3): number | undefined {
  const c = [0, 1, 2].map((j) => k.slice(3 * j, 3 * j + 3));
  const s2 = c[0]![0]! ** 2 + c[0]![1]! ** 2 + c[0]![2]! ** 2;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = c[i]![0]! * c[j]![0]! + c[i]![1]! * c[j]![1]! + c[i]![2]! * c[j]![2]!;
      if (Math.abs(dot - (i === j ? s2 : 0)) > 1e-9 * s2) return undefined;
    }
  }
  return Math.sqrt(s2);
}

const mat4 = (l: M3, t: ArrayLike<number>): Mat4 => Float64Array.of(l[0]!, l[1]!, l[2]!, 0, l[3]!, l[4]!, l[5]!, 0,
  l[6]!, l[7]!, l[8]!, 0, t[0]!, t[1]!, t[2]!, 1);

/** A mesh with a linear map applied (about the part's origin, which the caller maps): exact. */
export function stretchMesh(mesh: Mesh, k: M3): Mesh {
  const map = (a: Float32Array) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) out.set(apply3(k, a.subarray(i, i + 3)), i);
    return out;
  };
  const out: Mesh = { ...mesh, origin: apply3(k, mesh.origin), positions: map(mesh.positions) };
  delete out.box;
  if (mesh.normals) {
    // (Normals by the inverse transpose, made unit again.)
    const nt = transpose(inverse3(k)!), n = new Float32Array(mesh.normals.length);
    for (let i = 0; i < n.length; i += 3) {
      const v = apply3(nt, mesh.normals.subarray(i, i + 3)), len = Math.hypot(...v) || 1;
      n[i] = v[0] / len; n[i + 1] = v[1] / len; n[i + 2] = v[2] / len;
    }
    out.normals = n;
  }
  if (det3(k) < 0) {
    // A mirror turns every triangle over: their order reversed to face out again.
    const ix = mesh.indices.slice();
    for (let t = 0; t + 2 < ix.length; t += 3) { const b = ix[t + 1]!; ix[t + 1] = ix[t + 2]!; ix[t + 2] = b; }
    out.indices = ix;
  }
  if (mesh.edgePositions) out.edgePositions = map(mesh.edgePositions);
  if (mesh.curvePositions) out.curvePositions = map(mesh.curvePositions);
  if (mesh.points) out.points = map(mesh.points);
  if (mesh.faceOutlinePositions) out.faceOutlinePositions = map(mesh.faceOutlinePositions);
  const box = meshBox(out);
  if (box) out.box = box;
  return out;
}

/** A part stretched: a copy with its meshes, B-rep (a similarity only) and measures baked; what it said. */
function stretchPart(part: Part, of: number, k: M3, keepMeasures: boolean): { part: Part; notes: string[] } {
  const notes: string[] = [];
  const origin = apply3(k, part.origin);
  const out: Part = { ...part, origin, lods: part.lods.map((l) => ({ ...l, mesh: stretchMesh(l.mesh, k) })),
    properties: { ...part.properties }, stretched: { stretch: mat4(k, [0, 0, 0]), of } };
  delete out.brep;
  if (!keepMeasures) delete out.measures;
  const s = similarityScale(k);
  if (part.brep) {
    if (s === undefined) {
      notes.push('placed sheared or scaled unevenly, which its B-rep can\'t hold exactly: its exact geometry left out');
    } else {
      const { data, diagnostics } = transformBrep(part.brep.model, [...k, 0, 0, 0]);
      for (const d of diagnostics) notes.push(d.message);
      let vertexBox: Box | undefined;
      if (rowCount(data, 'vertex')) {
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < data.vertex.point.length; i += 3) {
          for (let c = 0; c < 3; c++) {
            min[c] = Math.min(min[c]!, data.vertex.point[i + c]!);
            max[c] = Math.max(max[c]!, data.vertex.point[i + c]!);
          }
        }
        vertexBox = { min, max };
      }
      out.brep = { ...part.brep, model: data, ...(vertexBox ? { vertexBox } : {}),
        outline: ({ faces: only, ...o }) => faceOutlines(data, origin, o, only) };
      if (!vertexBox) delete out.brep.vertexBox;
    }
  }
  if (part.measures && s !== undefined && !keepMeasures) {
    out.measures = { ...part.measures, faces: new Map([...part.measures.faces].map(([f, x]) =>
      [f, { ...x, area: x.area * s * s, perimeter: x.perimeter * s }])) };
  }
  return { part: out, notes };
}

/**
 * Makes every placement in the scene rigid, baking stretches into copies of what they place. Parts and
 * components keep their indices; copies are added after them. `keepMeasures`: parts' measures are of the parts as
 * placed already, the stretches the file's artifacts (our extras: written from a rigid scene, the stretch a format's
 * dequantization or frame), so copies keep them as they are rather than scaled.
 */
export function rigidPlacements(scene: Scene, opts: { keepMeasures?: boolean } = {}): void {
  const keyOf = (k: M3) => k.map((v) => v.toPrecision(12)).join();
  // The tree as it was: copies are made from the originals, never from what this pass already changed.
  const original = scene.components.map((c) => ({ parts: c.parts.map((r) => ({ ...r })),
    children: c.children.map((o) => ({ ...o })) }));
  const parts = new Map<string, number>(), components = new Map<string, number>();
  const originalParts = scene.parts.length;
  let baked = 0;
  const say = (severity: 'error' | 'warning' | 'info', message: string, part: Part) =>
    scene.diagnostics.push({ severity, message, ...(part.sources[0] ? { source: part.sources[0] } : {}) });

  /** A placement under an incoming stretch: its rigid transform, and the stretch it passes on. */
  const place = (m: Mat4, k: M3): { transform: Mat4; stretch: M3 } => {
    const l = mul3(k, lin(m)), t = apply3(k, [m[12]!, m[13]!, m[14]!]);
    const split = rigidPart(l);
    if (!split || isNone(split.stretch)) return { transform: isNone(k) ? m : mat4(l, t), stretch: I3 };
    baked++;
    return { transform: mat4(split.rotation, t), stretch: split.stretch };
  };
  const partFor = (p: number, k: M3): number => {
    if (isNone(k)) return p;
    const key = `${p}|${keyOf(k)}`;
    const known = parts.get(key);
    if (known !== undefined) return known;
    const { part, notes } = stretchPart(scene.parts[p]!, p, k, opts.keepMeasures ?? false);
    for (const n of notes) say(n.includes('left out') ? 'error' : 'warning', n, part);
    scene.parts.push(part);
    parts.set(key, scene.parts.length - 1);
    return scene.parts.length - 1;
  };
  const refs = (c: number, k: M3): { parts: PartRef[]; children: Occurrence[] } => ({
    parts: original[c]!.parts.map((r) => {
      const { transform, stretch } = place(r.transform, k);
      return { ...r, transform, part: partFor(r.part, stretch) };
    }),
    children: original[c]!.children.map((o) => {
      const { transform, stretch } = place(o.transform, k);
      return { ...o, transform, component: componentFor(o.component, stretch) };
    }),
  });
  // A component's first stretch is made in place, later ones in copies (no original left behind unused). (Indices
  // taken before recursing, so a component that contains itself ends the walk there.)
  const used = new Set<number>();
  const componentFor = (c: number, k: M3): number => {
    const key = `${c}|${isNone(k) ? '' : keyOf(k)}`;
    const known = components.get(key);
    if (known !== undefined) return known;
    let index = c;
    if (used.has(c)) {
      scene.components.push({ ...scene.components[c]!, parts: [], children: [] });
      index = scene.components.length - 1;
    }
    used.add(c);
    components.set(key, index);
    Object.assign(scene.components[index]!, refs(c, k));
    return index;
  };
  scene.roots = scene.roots.map((o) => {
    const { transform, stretch } = place(o.transform, I3);
    return { ...o, transform, component: componentFor(o.component, stretch) };
  });
  if (scene.rootParts) {
    scene.rootParts = scene.rootParts.map((r) => {
      const { transform, stretch } = place(r.transform, I3);
      return { ...r, transform, part: partFor(r.part, stretch) };
    });
  }
  // Components no root reaches: their own placements made rigid too.
  for (let c = 0; c < original.length; c++) if (!used.has(c)) componentFor(c, I3);
  foldBack(scene, originalParts);
  // (Said where copies were needed: a stretch every reference shares, a file's unit say, is only a conversion.)
  if (baked && (scene.parts.length > originalParts || scene.components.length > original.length)) {
    scene.diagnostics.push({ severity: 'info', message: `${baked} placements mirrored, scaled or sheared: their `
      + `stretches baked into ${scene.parts.length - originalParts} copies of parts and `
      + `${scene.components.length - original.length} of components` });
  }
}

/**
 * A part placed at one stretch only: its copy takes its place (no original left unplaced), stretched but no copy (an
 * even scale, a conversion, not even that). Parts after it renumbered, every reference with them.
 */
function foldBack(scene: Scene, originals: number): void {
  const placed = new Set<number>();
  for (const c of scene.components) for (const r of c.parts) placed.add(r.part);
  for (const r of scene.rootParts ?? []) placed.add(r.part);
  const copies = new Map<number, number[]>();
  for (let k = originals; k < scene.parts.length; k++) {
    const of = scene.parts[k]!.stretched!.of!;
    copies.set(of, [...(copies.get(of) ?? []), k]);
  }
  const into = new Map<number, number>();
  for (const [of, list] of copies) {
    if (placed.has(of) || list.length !== 1) continue;
    const part = scene.parts[list[0]!]!;
    const k = lin(part.stretched!.stretch), s = similarityScale(k);
    if (s !== undefined && det3(k) > 0) delete part.stretched;
    else part.stretched = { stretch: part.stretched!.stretch };
    scene.parts[of] = part;
    into.set(list[0]!, of);
  }
  if (!into.size) return;
  const index = new Map<number, number>();
  const kept: Part[] = [];
  scene.parts.forEach((p, k) => {
    if (into.has(k)) return;
    index.set(k, kept.length);
    kept.push(p);
  });
  const to = (k: number) => into.get(k) ?? index.get(k)!;
  for (const p of kept) if (p.stretched?.of !== undefined) p.stretched = { ...p.stretched, of: to(p.stretched.of) };
  scene.parts = kept;
  for (const c of scene.components) for (const r of c.parts) r.part = to(r.part);
  for (const r of scene.rootParts ?? []) r.part = to(r.part);
}
