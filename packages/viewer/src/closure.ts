// Whether a mesh closes up well enough to cap where a section plane cuts it (section.ts; the user, 2026-10-27: caps
// missing on parts of the lightarm assembly). Vertices at one position are one; then every edge must be used twice,
// once each way (an inside-out shell counts: the stencil count works either way), except along gaps too narrow to
// see. Meshers leave such gaps: OCCT gave lightarm's planet_pulley 14 boundary edges, slivers 18 um wide between faces
// whose nodes don't meet, and its stiffener inserts T-junctions (a vertex partway along another face's edge), each a
// gap of no width. A gap's sides run opposite ways, so each boundary edge's width is its distance to the nearest
// boundary edge running against it, and their mean, weighted by length, must be under WIDTH of the mesh's size. An
// opening wide enough to see through has its opposite side across it, and fails. (Per loop of boundary edges, area
// over perimeter was tried first: a slit joining two openings, a tube's unwelded seam, makes them one loop whose areas
// cancel.) The stencil can leak only within the gaps.

import { weld } from 'cad-scene';

/** The widest gap allowed (the mean over its edges), as a fraction of the mesh's bounding box's diagonal. */
export const WIDTH = 1e-3;
/** More boundary edges than this, and a mesh counts as open. */
export const MAX_BOUNDARY = 4000;

/** Whether triangles (indices into positions, xyz) close up, up to gaps narrower than WIDTH of their size. */
export function closesUp(positions: Float32Array, triangles: Uint32Array): boolean {
  const n = triangles.length - (triangles.length % 3);
  if (n < 12) return false;
  const { remap, positions: p } = weld(positions);
  // Each half-edge (a, b) as (lower x count + higher) x 2 + (1 if a is the higher), sorted so an edge's uses are
  // adjacent (exact in a double for fewer than 6.7e7 vertices), as cad-scene's manifoldProblems does.
  const nv = p.length / 3;
  const keys = new Float64Array(n);
  let m = 0;
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = remap[triangles[t + k]!]!, b = remap[triangles[t + (k + 1) % 3]!]!;
      if (a !== b) keys[m++] = a < b ? (a * nv + b) * 2 : (b * nv + a) * 2 + 1;
    }
  }
  const sorted = keys.subarray(0, m).sort();
  // Boundary half-edges by their start; anything used more than twice, or twice the same way, is no solid.
  const out = new Map<number, number[]>();
  let boundary = 0;
  for (let i = 0; i < m;) {
    const edge = Math.floor(sorted[i]! / 2);
    let j = i;
    while (j < m && Math.floor(sorted[j]! / 2) === edge) j++;
    if (j - i > 2 || (j - i === 2 && sorted[i] === sorted[i + 1])) return false;
    if (j - i === 1) {
      const lo = Math.floor(edge / nv), hi = edge % nv;
      const [a, b] = sorted[i]! % 2 ? [hi, lo] : [lo, hi];
      const list = out.get(a);
      if (list) list.push(b);
      else out.set(a, [b]);
      boundary++;
    }
    i = j;
  }
  if (!boundary) return true;
  // Comparing every pair: gaps have few edges (planet_pulley 14); so many is no near-solid.
  if (boundary > MAX_BOUNDARY) return false;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[i + k]!);
      max[k] = Math.max(max[k]!, p[i + k]!);
    }
  }
  const size = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  const edges: [number, number][] = [];
  for (const [a, ends] of out) for (const b of ends) edges.push([a, b]);
  const at = (i: number) => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
  let weighted = 0, length = 0;
  for (const [a, b] of edges) {
    const pa = at(a), pb = at(b);
    const d = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const mid = [(pa[0]! + pb[0]!) / 2, (pa[1]! + pb[1]!) / 2, (pa[2]! + pb[2]!) / 2];
    let width = Infinity;
    for (const [c, e] of edges) {
      const pc = at(c), pe = at(e);
      const f = [pe[0]! - pc[0]!, pe[1]! - pc[1]!, pe[2]! - pc[2]!];
      if (d[0]! * f[0]! + d[1]! * f[1]! + d[2]! * f[2]! >= 0) continue;
      width = Math.min(width, toSegment(mid, pc, f));
    }
    weighted += len * width;
    length += len;
  }
  return weighted <= WIDTH * size * length;
}

/** The distance from a point to the segment from `c` along `f`. */
function toSegment(m: number[], c: number[], f: number[]): number {
  const ff = f[0]! * f[0]! + f[1]! * f[1]! + f[2]! * f[2]!;
  const t = ff ? Math.max(0, Math.min(1, ((m[0]! - c[0]!) * f[0]! + (m[1]! - c[1]!) * f[1]! + (m[2]! - c[2]!) * f[2]!)
    / ff)) : 0;
  return Math.hypot(c[0]! + t * f[0]! - m[0]!, c[1]! + t * f[1]! - m[1]!, c[2]! + t * f[2]! - m[2]!);
}
