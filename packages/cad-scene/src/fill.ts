// The sliver fill: a face of the model no backend meshed, narrower than the deflection, made of triangles between its
// rim's points, which are its neighbours' (its edges' polylines: the points the meshed faces along them have, once
// joined), so the fill meets them exactly. A face that narrow lies within the deflection of its rim, so the fill is
// within it of the surface without the surface being evaluated. Faces of more than one loop, with an edge not drawn,
// wider than the deflection, or whose fill is off their exact area aren't filled (said why).

import { type BrepData, decode } from 'cad-brep';
import { faceFailures } from './mesh.ts';
import type { Diagnostic } from './scene.ts';
import type { TessellationResult } from './tessellator.ts';

/** A face is filled only where its rim's two sides are within this times the deflection of each other. */
export const FILL_WIDTH = 1;

export interface Filled {
  /** The result, filled (`r` itself where nothing was). */
  result: TessellationResult;
  /** The faces filled, by id. */
  filled: number[];
  /** Why each face without triangles wasn't filled, by id. */
  skipped: Map<number, string>;
}

type V3 = [number, number, number];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const key = (p: V3) => `${p[0] + 0},${p[1] + 0},${p[2] + 0}`;
function segDist(q: V3, a: V3, b: V3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], aq = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
  const l2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t = l2 > 0 ? Math.max(0, Math.min(1, (aq[0]! * ab[0]! + aq[1]! * ab[1]! + aq[2]! * ab[2]!) / l2)) : 0;
  return dist(q, [a[0] + t * ab[0]!, a[1] + t * ab[1]!, a[2] + t * ab[2]!]);
}
const polyDist = (q: V3, P: readonly V3[]) => {
  let d = P.length === 1 ? dist(q, P[0]!) : Infinity;
  for (let i = 0; i + 1 < P.length; i++) d = Math.min(d, segDist(q, P[i]!, P[i + 1]!));
  return d;
};

/** Faces failed to mesh, as the backends say it (the ids listed, at most 10). */
export function failedMessage(ids: readonly number[]): string {
  return `${ids.length} faces failed to mesh: ${ids.slice(0, 10).map((i) => `#${i}`).join(', ')}`
    + (ids.length > 10 ? ', ...' : '');
}

/**
 * Fills the result's faces without triangles that are slivers (see above). `deflection` the request's linear
 * deflection; a face's exact area is the result's oracle's where it has one, else its measure.
 */
export function fillFaces(d: BrepData, r: TessellationResult, deflection: number): Filled {
  const skipped = new Map<number, string>();
  if (!r.edges || !r.edgePositions) return { result: r, filled: [], skipped };
  const meshed = new Set(r.faces.filter((f) => f.count > 0).map((f) => f.entityId));
  const rows = new Map<number, number[]>();
  d.face.id.forEach((id, row) => { if (id) (rows.get(id) ?? rows.set(id, []).get(id)!).push(row); });
  const todo = [...rows.keys()].filter((id) => !meshed.has(id)).sort((a, b) => a - b);
  if (!todo.length) return { result: r, filled: [], skipped };
  const polylines = new Map<number, V3[][]>();
  for (const e of r.edges) {
    if (e.entityId === null) continue;
    const pts: V3[] = [];
    for (let k = e.start; k < e.start + e.count; k++) {
      pts.push([r.edgePositions[3 * k]!, r.edgePositions[3 * k + 1]!, r.edgePositions[3 * k + 2]!]);
    }
    // (A polyline of no points, as a backend gives for an edge it couldn't draw, is none.)
    if (pts.length) (polylines.get(e.entityId) ?? polylines.set(e.entityId, []).get(e.entityId)!).push(pts);
  }
  // The result's directed mesh edges by position, to wind a fill against its neighbours.
  const at = (i: number): V3 => [r.positions[3 * i]!, r.positions[3 * i + 1]!, r.positions[3 * i + 2]!];
  let directed: Set<string> | undefined;
  const uses = () => {
    if (!directed) {
      directed = new Set();
      for (const f of r.faces) for (let t = f.start; t + 2 < f.start + f.count; t += 3) for (let j = 0; j < 3; j++) {
        directed.add(`${key(at(r.indices[t + j]!))}|${key(at(r.indices[t + (j + 1) % 3]!))}`);
      }
    }
    return directed;
  };
  const exact = new Map<number, { area: number; perimeter: number; valid: boolean }>();
  for (const m of r.measures ?? []) if (m.valid) exact.set(m.entityId, m);
  for (const o of r.oracle ?? []) exact.set(o.entityId, { area: o.area, perimeter: o.perimeter, valid: true });
  const snap = 0.01 * deflection;
  const added: { id: number; pts: V3[]; tris: number[]; normal: V3 }[] = [];
  for (const id of todo) {
    const rs = rows.get(id)!;
    if (rs.length > 1) { skipped.set(id, 'several faces with its id'); continue; }
    const face = decode.face(d, rs[0]!);
    if (face.loops.length !== 1 || face.loops[0]!.kind !== 'edge') {
      skipped.set(id, 'not one loop of edges');
      continue;
    }
    // Its rim: its edges' polylines chained end to end into one loop.
    const pieces: V3[][] = [];
    let drawn = true;
    for (const c of face.loops[0]!.coedges) {
      const e = decode.edge(d, c.edge).id;
      const ps = e ? polylines.get(e) : undefined;
      if (!ps) { drawn = false; break; }
      pieces.push(...ps);
    }
    if (!drawn || !pieces.length) { skipped.set(id, 'an edge of it not drawn'); continue; }
    let rim = pieces[0]!;
    const rest = pieces.slice(1);
    while (rest.length) {
      const end = rim[rim.length - 1]!;
      let best: { k: number; flip: boolean; d: number } | undefined;
      rest.forEach((q, k) => {
        for (const [flip, p] of [[false, q[0]!], [true, q[q.length - 1]!]] as const) {
          const dq = dist(p, end);
          if (!best || dq < best.d) best = { k, flip, d: dq };
        }
      });
      if (!best || best.d > snap) break;
      const q = rest.splice(best.k, 1)[0]!;
      rim = [...rim, ...(best.flip ? [...q].reverse() : q).slice(1)];
    }
    if (rest.length || dist(rim[0]!, rim[rim.length - 1]!) > snap) { skipped.set(id, 'its rim not a loop'); continue; }
    // (Its points once each, in order: repeats single precision makes, and the closing point, dropped.)
    const loop: V3[] = [];
    for (const p of rim.slice(0, -1)) if (!loop.length || key(loop[loop.length - 1]!) !== key(p)) loop.push(p);
    if (loop.length > 1 && key(loop[0]!) === key(loop[loop.length - 1]!)) loop.pop();
    if (loop.length < 3) { skipped.set(id, 'its rim of fewer than 3 points'); continue; }
    if (loop.length > 4096) { skipped.set(id, 'its rim of too many points'); continue; }
    // Its two sides: the rim split at its two points farthest apart.
    let i0 = 0, j0 = 1, far = -1;
    for (let i = 0; i < loop.length; i++) for (let j = i + 1; j < loop.length; j++) {
      const dd = dist(loop[i]!, loop[j]!);
      if (dd > far) { far = dd; i0 = i; j0 = j; }
    }
    const one = loop.slice(i0, j0 + 1), two = [...loop.slice(j0), ...loop.slice(0, i0 + 1)].reverse();
    let width = 0;
    for (const p of one) width = Math.max(width, polyDist(p, two));
    for (const p of two) width = Math.max(width, polyDist(p, one));
    if (width > FILL_WIDTH * deflection) { skipped.set(id, 'wider than the deflection'); continue; }
    // A strip between the sides, both from the first split point to the second: each step on along the side whose
    // next point makes the shorter diagonal.
    const tris: V3[][] = [];
    let p = 0, q = 0;
    while (p < one.length - 1 || q < two.length - 1) {
      const onOne = q === two.length - 1 || (p < one.length - 1
        && dist(one[p + 1]!, two[q]!) <= dist(one[p]!, two[q + 1]!));
      if (onOne) { tris.push([one[p]!, one[p + 1]!, two[q]!]); p++; }
      else { tris.push([one[p]!, two[q + 1]!, two[q]!]); q++; }
    }
    const kept = tris.filter((t) => new Set(t.map(key)).size === 3);
    if (!kept.length) { skipped.set(id, 'no area'); continue; }
    // Wound against its neighbours: a rim segment of theirs runs the other way in the fill.
    const ring = new Set(loop.map((x, k) => `${key(x)}|${key(loop[(k + 1) % loop.length]!)}`)
      .concat(loop.map((x, k) => `${key(loop[(k + 1) % loop.length]!)}|${key(x)}`)));
    let same = 0, against = 0;
    for (const t of kept) for (let k = 0; k < 3; k++) {
      const e = `${key(t[k]!)}|${key(t[(k + 1) % 3]!)}`;
      if (!ring.has(e)) continue;
      if (uses().has(e)) same++;
      else if (uses().has(`${key(t[(k + 1) % 3]!)}|${key(t[k]!)}`)) against++;
    }
    if (same > against) for (const t of kept) t.reverse();
    // Kept only where its area agrees with the face's exact one (as faceFailures judges a mesh).
    const flat: V3[] = [], idx: number[] = [];
    const slot = new Map<string, number>();
    for (const t of kept) for (const x of t) {
      const k = key(x);
      if (!slot.has(k)) { slot.set(k, flat.length); flat.push(x); }
      idx.push(slot.get(k)!);
    }
    const m = exact.get(id);
    if (m) {
      const mesh = { origin: r.origin, positions: Float32Array.from(flat.flat()), indices: Uint32Array.from(idx),
        faces: [{ source: id, start: 0, count: idx.length }] };
      const v = faceFailures(mesh, { measured: { measures: { by: '', faces: new Map([[id, m]]) }, deflection } });
      if (v.get(id) === 'partly' || v.get(id) === 'excess') {
        skipped.set(id, 'its fill off its exact area');
        continue;
      }
    }
    const n: V3 = [0, 0, 0];
    for (const [a, b, c] of kept) {
      const u = [b![0] - a![0], b![1] - a![1], b![2] - a![2]], w = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
      n[0] += u[1]! * w[2]! - u[2]! * w[1]!;
      n[1] += u[2]! * w[0]! - u[0]! * w[2]!;
      n[2] += u[0]! * w[1]! - u[1]! * w[0]!;
    }
    const ln = Math.hypot(...n) || 1;
    added.push({ id, pts: flat, tris: idx, normal: [n[0] / ln, n[1] / ln, n[2] / ln] });
  }
  if (!added.length) return { result: r, filled: [], skipped };
  // Appended: each fill's points as new vertices (the same numbers as the rim's), its triangles a range of its face's
  // (in place of a range without triangles).
  const base = r.positions.length / 3, more = added.reduce((s, a) => s + a.pts.length, 0);
  const positions = new Float32Array(r.positions.length + 3 * more);
  positions.set(r.positions);
  const normals = r.normals ? new Float32Array(positions.length) : undefined;
  if (normals) normals.set(r.normals!);
  const indices = Array.from(r.indices);
  const ids = new Set(added.map((a) => a.id));
  const faces = r.faces.filter((f) => !(f.entityId !== null && ids.has(f.entityId) && f.count === 0));
  let v = base;
  for (const a of added) {
    positions.set(a.pts.flat(), 3 * v);
    if (normals) for (let k = 0; k < a.pts.length; k++) normals.set(a.normal, 3 * (v + k));
    faces.push({ entityId: a.id, start: indices.length, count: a.tris.length });
    for (const i of a.tris) indices.push(v + i);
    v += a.pts.length;
  }
  const result: TessellationResult = { ...r, positions, indices: Uint32Array.from(indices), faces,
    ...(normals ? { normals } : {}) };
  return { result, filled: added.map((a) => a.id), skipped };
}

/** The note for faces filled. */
export function filledMessage(ids: readonly number[]): string {
  const n = ids.length;
  return `${n} ${n === 1 ? 'face' : 'faces'} no backend meshed filled from ${n === 1 ? 'its' : 'their'} neighbours' `
    + `points along ${n === 1 ? 'its' : 'their'} edges (narrower than the deflection): `
    + ids.slice(0, 10).map((i) => `#${i}`).join(', ') + (n > 10 ? ', ...' : '');
}

/**
 * fillFaces on a result, its diagnostics made to say what is left: its errors for faces that failed to mesh replaced by
 * one for those still without triangles, and a warning naming those filled. Others as they are.
 */
export function fillResult(d: BrepData, r: TessellationResult, deflection: number): TessellationResult {
  if (!r.diagnostics.some((x) => x.severity === 'error' && /^\d+ faces failed to mesh/.test(x.message))) return r;
  const f = fillFaces(d, r, deflection);
  if (!f.filled.length) return r;
  const meshed = new Set(f.result.faces.filter((x) => x.count > 0).map((x) => x.entityId));
  const left = [...new Set(d.face.id)].filter((id) => id && !meshed.has(id)).sort((a, b) => a - b);
  const diagnostics: Diagnostic[] = [{ severity: 'warning', message: filledMessage(f.filled) },
    ...r.diagnostics.filter((x) => !(x.severity === 'error' && /^\d+ faces failed to mesh/.test(x.message)))];
  if (left.length) diagnostics.push({ severity: 'error', message: failedMessage(left) });
  return { ...f.result, diagnostics };
}
