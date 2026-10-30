// Mesh topology shared by the exporters: vertices welded by position, whether a welded mesh is a closed, oriented
// manifold of positive volume (what 3MF's model objects must be), triangles with two corners at one position
// dropped, and closed shells turned outward when they are inside out and can't be the boundaries of voids (the last
// two are input fixes made in memory: CLAUDE.md, "Decisions").

import type { Mesh } from './scene.ts';

/** Welded vertices: each vertex's index among the distinct positions, and those positions. */
export function weld(positions: Float32Array): { remap: Uint32Array; positions: Float32Array } {
  const n = positions.length / 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  // -0 and 0 are one position.
  const key = (i: number) => (positions[i] === 0 ? 0 : bits[i]!);
  let size = 1;
  while (size < 2 * n) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const remap = new Uint32Array(n);
  const out: number[] = [];
  for (let v = 0; v < n; v++) {
    const x = key(3 * v), y = key(3 * v + 1), z = key(3 * v + 2);
    let slot = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) & (size - 1);
    for (;;) {
      const w = table[slot]!;
      if (w < 0) {
        table[slot] = v;
        remap[v] = out.length / 3;
        out.push(positions[3 * v]! + 0, positions[3 * v + 1]! + 0, positions[3 * v + 2]! + 0);
        break;
      }
      if (key(3 * w) === x && key(3 * w + 1) === y && key(3 * w + 2) === z) { remap[v] = remap[w]!; break; }
      slot = (slot + 1) & (size - 1);
    }
  }
  return { remap, positions: Float32Array.from(out) };
}

/**
 * What keeps a welded mesh from being a closed, oriented manifold of positive volume (a 3MF `model`); none if it is.
 */
export function manifoldProblems(positions: Float32Array, triangles: Uint32Array): string[] {
  const nv = positions.length / 3;
  const n = triangles.length;
  // Each edge as (lower vertex x count + higher) x 2 + direction, sorted so an edge's uses are adjacent (exact in
  // a double below 2^53, so for fewer than 6.7e7 vertices).
  const keys = new Float64Array(n);
  let volume = 0;
  for (let t = 0; t < n; t += 3) {
    const a = triangles[t]!, b = triangles[t + 1]!, c = triangles[t + 2]!;
    keys[t] = a < b ? (a * nv + b) * 2 : (b * nv + a) * 2 + 1;
    keys[t + 1] = b < c ? (b * nv + c) * 2 : (c * nv + b) * 2 + 1;
    keys[t + 2] = c < a ? (c * nv + a) * 2 : (a * nv + c) * 2 + 1;
    const ax = positions[3 * a]!, ay = positions[3 * a + 1]!, az = positions[3 * a + 2]!;
    const bx = positions[3 * b]!, by = positions[3 * b + 1]!, bz = positions[3 * b + 2]!;
    const cx = positions[3 * c]!, cy = positions[3 * c + 1]!, cz = positions[3 * c + 2]!;
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  keys.sort();
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (let i = 0; i < n;) {
    const edge = Math.floor(keys[i]! / 2);
    let forward = 0, back = 0;
    for (; i < n && Math.floor(keys[i]! / 2) === edge; i++) if (keys[i]! % 2) back++; else forward++;
    if (forward + back === 1) boundary++;
    else if (forward + back > 2) nonManifold++;
    else if (forward !== 1) misoriented++;
  }
  const problems: string[] = [];
  const count = (k: number, what: string) => { if (k) problems.push(`${k} ${what} ${k === 1 ? 'edge' : 'edges'}`); };
  count(boundary, 'boundary');
  count(nonManifold, 'non-manifold');
  count(misoriented, 'misoriented');
  if (n / 3 < 4) problems.push(`${n / 3} triangles (a solid needs 4)`);
  else if (!problems.length && !(volume > 0)) problems.push(INSIDE_OUT);
  return problems;
}

/** The message `manifoldProblems` gives for a closed, oriented mesh of negative volume. */
export const INSIDE_OUT = 'inside out (negative volume)';

/**
 * A failed piece counts only past this fraction of its face's area (the meshed pieces' triangles and the failed
 * pieces' B-rep areas): shape healing can split a face into pieces of which a sliver, rightly, meshes to nothing (the
 * user, 2026-10-28: no false alarms).
 */
export const FAILED_PIECE_FRACTION = 0.01;

/** The diagnostic's message for `n` triangles dropped by dropDegenerate. */
export const degenerateMessage = (n: number) =>
  `${n} degenerate ${n === 1 ? 'triangle' : 'triangles'} dropped (two corners at one position)`;

/**
 * Faces that failed to mesh, by source id: `failed` with no triangles in any range (or, `expected`, the part's face
 * list from the source, given, none at all: a backend may leave a face out), `partly` when a range has none and is
 * more than FAILED_PIECE_FRACTION of the face's area (its `area`, from the backend; a range without one counts).
 */
export function faceFailures(mesh: Mesh, expected?: readonly number[]): Map<number, 'failed' | 'partly'> {
  const p = mesh.positions, ix = mesh.indices;
  const triangleArea = (start: number, count: number) => {
    let a = 0;
    for (let t = start; t < start + count; t += 3) {
      const [i, j, k] = [3 * ix[t]!, 3 * ix[t + 1]!, 3 * ix[t + 2]!];
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
      a += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    }
    return a;
  };
  const byFace = new Map<number, { meshed: number; empty: (number | undefined)[]; triangles: number }>();
  for (const f of mesh.faces) {
    if (f.source === null) continue;
    let e = byFace.get(f.source);
    if (!e) byFace.set(f.source, (e = { meshed: 0, empty: [], triangles: 0 }));
    if (f.count) {
      e.triangles += f.count;
      e.meshed += triangleArea(f.start, f.count);
    } else e.empty.push(f.area);
  }
  const out = new Map<number, 'failed' | 'partly'>();
  for (const s of expected ?? []) if (!byFace.has(s)) out.set(s, 'failed');
  for (const [s, e] of byFace) {
    if (!e.triangles) {
      // (Emptied of degenerate triangles only, every range of it: nothing to draw, nothing missing.)
      if (!e.empty.every((a) => a === 0)) out.set(s, 'failed');
      continue;
    }
    const total = e.meshed + e.empty.reduce<number>((t, a) => t + (a ?? 0), 0);
    if (e.empty.some((a) => a === undefined || a > FAILED_PIECE_FRACTION * total)) out.set(s, 'partly');
  }
  return out;
}

/**
 * The mesh without its triangles that have two corners at one position (exactly, -0 as 0), decided by the user,
 * 2026-10-22: they cover nothing, and in a welded mesh they would join pieces that only touch there. Removing one
 * never opens the mesh, since its two other edges are one edge both ways. Slivers with three distinct corners on a
 * line stay: their long edge is a neighbour's too. Faces keep their entries (with fewer triangles, perhaps none);
 * vertices, normals and edges are shared with the original. Returns the same mesh if nothing was dropped.
 */
export function dropDegenerate(mesh: Mesh): { mesh: Mesh; dropped: number } {
  const ix = mesh.indices, p = mesh.positions;
  const same = (a: number, b: number) => a === b || (
    p[3 * a] === p[3 * b] && p[3 * a + 1] === p[3 * b + 1] && p[3 * a + 2] === p[3 * b + 2]);
  const degenerate = (t: number) => same(ix[t]!, ix[t + 1]!) || same(ix[t + 1]!, ix[t + 2]!) || same(
    ix[t + 2]!, ix[t]!);
  let dropped = 0;
  for (let t = 0; t < ix.length; t += 3) if (degenerate(t)) dropped++;
  if (!dropped) return { mesh, dropped };
  const indices = new Uint32Array(ix.length - 3 * dropped);
  let at = 0;
  const keep = (start: number, end: number) => {
    const from = at;
    for (let t = start; t < end; t += 3) if (!degenerate(t)) { indices.set(ix.subarray(t, t + 3), at); at += 3; }
    return at - from;
  };
  // Faces partition the indices, in order or not; each keeps its place among them.
  // (A range emptied here meshed, with nothing but degenerate triangles: an area of none, not a failure.)
  const faces = mesh.faces.map((f) => {
    const start = at;
    const count = keep(f.start, f.start + f.count);
    return { ...f, start, count, ...(f.count && !count ? { area: 0 } : {}) };
  });
  if (!mesh.faces.length) keep(0, ix.length);
  return { mesh: { ...mesh, indices, faces }, dropped };
}

/** Directions for the enclosure test's rays: unlikely to run along a CAD model's edges or faces. */
const RAYS = [[0.5773, 0.5774, 0.5775], [-0.6123, 0.3521, 0.7081], [0.2281, -0.8467, 0.4806]].map((d) => {
  const n = Math.hypot(d[0]!, d[1]!, d[2]!);
  return d.map((x) => x / n);
});

/**
 * The mesh with its inside-out closed shells turned over: each connected piece of the welded mesh that is closed and
 * oriented with negative volume, and that no other piece encloses, so can't be a void's boundary (decided by the
 * user, 2026-10-22). Its triangles' winding is reversed, and its normals too if they followed the winding. A piece
 * counts as enclosed if a ray from one of its vertices crosses a closed piece an odd number of times in any of three
 * directions, or if an open piece's bounding box contains its own; those are left as they are. Returns the same mesh
 * if nothing was turned.
 */
export function orientShells(mesh: Mesh): { mesh: Mesh; turned: number } {
  const ix = mesh.indices;
  if (!ix.length) return { mesh, turned: 0 };
  const { remap, positions: p } = weld(mesh.positions);
  const nv = p.length / 3;
  // Pieces: connected by the welded vertices of triangles that aren't degenerate.
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const welded = (t: number) => [remap[ix[t]!]!, remap[ix[t + 1]!]!, remap[ix[t + 2]!]!] as const;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = welded(t);
    if (a === b || b === c || c === a) continue;
    parent[find(a)] = find(b);
    parent[find(b)] = find(c);
  }
  interface Piece { triangles: number[]; volume: number; lo: number[]; hi: number[] }
  const pieces = new Map<number, Piece>();
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = welded(t);
    if (a === b || b === c || c === a) continue;
    const root = find(a);
    let piece = pieces.get(root);
    if (!piece) pieces.set(root,
      (piece = { triangles: [], volume: 0, lo: [Infinity, Infinity, Infinity],
      hi: [-Infinity, -Infinity, -Infinity] }));
    piece.triangles.push(a, b, c);
    piece.volume += triple(p, a, b, c);
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) {
      piece.lo[k] = Math.min(piece.lo[k]!, p[3 * v + k]!);
      piece.hi[k] = Math.max(piece.hi[k]!, p[3 * v + k]!);
    }
  }
  const candidates = [...pieces].filter(([, piece]) => piece.volume < 0);
  if (!candidates.length) return { mesh, turned: 0 };
  const closed = new Map<number, boolean>();
  const isClosed = (root: number) => {
    let c = closed.get(root);
    if (c === undefined) {
      const problems = manifoldProblems(p, Uint32Array.from(pieces.get(root)!.triangles));
      closed.set(root, (c = !problems.length || (problems.length === 1 && problems[0] === INSIDE_OUT)));
    }
    return c;
  };
  const turn = new Set<number>();
  for (const [root, piece] of candidates) {
    if (!isClosed(root)) continue;
    const v = piece.triangles[0]!;
    const origin = [p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!];
    let enclosed = false;
    for (const [other, q] of pieces) {
      if (other === root) continue;
      if (isClosed(other)) enclosed = RAYS.some((d) => crossings(p, q.triangles, origin, d) % 2 === 1);
      else enclosed = [0, 1, 2].every((k) => q.lo[k]! <= piece.lo[k]! && q.hi[k]! >= piece.hi[k]!);
      if (enclosed) break;
    }
    if (!enclosed) turn.add(root);
  }
  if (!turn.size) return { mesh, turned: 0 };

  const indices = Uint32Array.from(ix);
  const normals = mesh.normals ? Float32Array.from(mesh.normals) : undefined;
  // Per piece turned: whether its normals followed its winding (then they're turned too).
  const agree = new Map<number, number>();
  const n = mesh.normals, q = mesh.positions;
  for (let t = 0; t < ix.length; t += 3) {
    const root = find(remap[ix[t]!]!);
    if (!turn.has(root)) continue;
    indices[t + 1] = ix[t + 2]!;
    indices[t + 2] = ix[t + 1]!;
    if (!n) continue;
    const [a, b, c] = [ix[t]!, ix[t + 1]!, ix[t + 2]!];
    const u = [0, 1, 2].map((k) => q[3 * b + k]! - q[3 * a + k]!),
      w = [0, 1, 2].map((k) => q[3 * c + k]! - q[3 * a + k]!);
    const g = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += g[k]! * (n[3 * a + k]! + n[3 * b + k]! + n[3 * c + k]!);
    agree.set(root, (agree.get(root) ?? 0) + Math.sign(dot));
  }
  if (normals) {
    const flipped = new Uint8Array(mesh.positions.length / 3);
    for (let t = 0; t < ix.length; t++) {
      const v = ix[t]!;
      const root = find(remap[v]!);
      if (!turn.has(root) || !((agree.get(root) ?? 0) > 0) || flipped[v]) continue;
      flipped[v] = 1;
      for (let k = 0; k < 3; k++) normals[3 * v + k] = -normals[3 * v + k]!;
    }
  }
  const out: Mesh = { ...mesh, indices };
  if (normals) out.normals = normals;
  return { mesh: out, turned: turn.size };
}

/** Six times the signed volume of the tetrahedron from the origin to a triangle. */
function triple(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[3 * a]!, ay = p[3 * a + 1]!, az = p[3 * a + 2]!;
  const bx = p[3 * b]!, by = p[3 * b + 1]!, bz = p[3 * b + 2]!;
  const cx = p[3 * c]!, cy = p[3 * c + 1]!, cz = p[3 * c + 2]!;
  return ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
}

/** How many of these triangles a ray crosses (Moeller-Trumbore), not counting hits behind its origin or at it. */
function crossings(p: Float32Array, triangles: number[], o: number[], d: number[]): number {
  let n = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = 3 * triangles[t]!, b = 3 * triangles[t + 1]!, c = 3 * triangles[t + 2]!;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const h = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (det === 0) continue;
    const s = [o[0]! - p[a]!, o[1]! - p[a + 1]!, o[2]! - p[a + 2]!];
    const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
    if (u < 0 || u > 1) continue;
    const r = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = (d[0]! * r[0]! + d[1]! * r[1]! + d[2]! * r[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0]! * r[0]! + e2[1]! * r[1]! + e2[2]! * r[2]!) / det > 0) n++;
  }
  return n;
}
