// Edges found from a mesh's triangles, for meshes with no edges of their own (a file's meshes without B-rep edges, a
// backend's without them): three.js's EdgesGeometry (0.186; MIT license, Copyright 2010-2026 three.js authors, which
// applies to this file's algorithm, as in the build's licenses.md), ported, with its welding precision a grid in the
// world (the user, 2026-10-31: from their cadrender prototype's MyEdgesGeometry, 5 decimal places rather than
// three.js's fixed 4, which gave spurious edges; then a fixed distance whatever the file's unit, as fine as quality
// asks, off the page's thread). Vertices are one where their positions round to the same grid point; an edge is kept
// where its two triangles' normals differ by more than the threshold angle, or where it has only one triangle. Each
// vertex is rounded once and edges are keyed by numbers (three.js rounds every triangle's corners into strings):
// the same edges, in the same order, several times faster. Run in the import worker (model-load.ts), part by part.

/** Positions closer than this, in world millimetres, are one vertex (1 um: 6 decimal places of a file in metres). */
export const EDGE_GRID_MM = 0.001;

/** Edges kept where the faces meet at more than this, in degrees (cadrender's). */
export const EDGE_ANGLE = 10;

/**
 * The edges of a triangle mesh (indexed, or every three positions a triangle) as line segments, pairs of positions
 * in the mesh's coordinates: `scale` grid steps a mesh unit (1 / the grid in the mesh's units; three.js's 10^4).
 */
export function findEdges(positions: ArrayLike<number>, indices: ArrayLike<number> | undefined,
  thresholdAngle: number, scale: number): Float32Array {
  const n = Math.floor(positions.length / 3);
  // Each vertex's grid point, numbered.
  const canon = new Int32Array(n);
  const ids = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(positions[3 * i]! * scale)},${Math.round(positions[3 * i + 1]! * scale)},${
      Math.round(positions[3 * i + 2]! * scale)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    canon[i] = id;
  }
  const m = ids.size;
  const thresholdDot = Math.cos(thresholdAngle * Math.PI / 180);
  const count = indices ? indices.length : n;
  // An edge met once so far, by its grid points in its triangle's order; null once met from the other side.
  const open = new Map<number, { i0: number; i1: number; nx: number; ny: number; nz: number } | null>();
  const out: number[] = [];
  const corner = [0, 0, 0], grid = [0, 0, 0];
  const push = (i: number) => out.push(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
  for (let t = 0; t + 2 < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      corner[k] = indices ? indices[t + k]! : t + k;
      grid[k] = canon[corner[k]!]!;
    }
    if (grid[0] === grid[1] || grid[1] === grid[2] || grid[2] === grid[0]) continue;
    // The normal as three.js's Triangle.getNormal makes it: (c - b) x (a - b), normalized.
    const [a, b, c] = corner as [number, number, number];
    const ux = positions[3 * c]! - positions[3 * b]!, uy = positions[3 * c + 1]! - positions[3 * b + 1]!,
      uz = positions[3 * c + 2]! - positions[3 * b + 2]!;
    const vx = positions[3 * a]! - positions[3 * b]!, vy = positions[3 * a + 1]! - positions[3 * b + 1]!,
      vz = positions[3 * a + 2]! - positions[3 * b + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len2 = nx * nx + ny * ny + nz * nz;
    if (len2 > 0) {
      const f = 1 / Math.sqrt(len2);
      nx *= f; ny *= f; nz *= f;
    } else nx = ny = nz = 0;
    for (let j = 0; j < 3; j++) {
      const next = (j + 1) % 3;
      const key = grid[j]! * m + grid[next]!, reverse = grid[next]! * m + grid[j]!;
      const sibling = open.get(reverse);
      if (sibling) {
        if (nx * sibling.nx + ny * sibling.ny + nz * sibling.nz <= thresholdDot) {
          push(corner[j]!);
          push(corner[next]!);
        }
        open.set(reverse, null);
      } else if (!open.has(key)) {
        open.set(key, { i0: corner[j]!, i1: corner[next]!, nx, ny, nz });
      }
    }
  }
  // Edges met only once: boundaries.
  for (const e of open.values()) {
    if (!e) continue;
    push(e.i0);
    push(e.i1);
  }
  return Float32Array.from(out);
}
