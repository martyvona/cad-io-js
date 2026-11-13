// Hand-made backend results for the tests' models.

import { type BrepData, decode } from 'cad-brep';
import type { TessellationResult } from '../src/index.ts';

/**
 * A result for a model of plane quads (cad-brep's test cube: faces 21-26, edges 9-20, each edge two faces'), as a
 * backend gives one: each face two triangles of its own four vertices (faces share none, only positions), and each
 * edge's polyline its two vertices' points. `move` shifts one face's copy of one corner (by face id, corner index).
 */
export function quads(d: BrepData, move?: { face: number; corner: number; by: [number, number, number] }):
  TessellationResult {
  const positions: number[] = [], indices: number[] = [], faces: TessellationResult['faces'] = [];
  const point = (v: number) => Array.from(d.vertex.point.subarray(3 * v, 3 * v + 3));
  for (let row = 0; row < d.face.surface.length; row++) {
    const f = decode.face(d, row), loop = f.loops[0]!;
    if (loop.kind !== 'edge') throw new Error('edge loops only');
    const base = positions.length / 3;
    loop.coedges.forEach((c, k) => {
      const e = decode.edge(d, c.edge);
      const p = point(c.orientation === 'forward' ? e.start! : e.end!);
      if (move && move.face === f.id && move.corner === k) for (let j = 0; j < 3; j++) p[j]! += move.by[j]!;
      positions.push(...p);
    });
    faces.push({ entityId: f.id!, start: indices.length, count: 6 });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const edgePositions: number[] = [], edges: NonNullable<TessellationResult['edges']> = [];
  for (let row = 0; row < d.edge.curve.length; row++) {
    const e = decode.edge(d, row);
    edges.push({ entityId: e.id!, start: edgePositions.length / 3, count: 2, kind: 'shared' });
    edgePositions.push(...point(e.start!), ...point(e.end!));
  }
  return { origin: [0, 0, 0], positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces,
    edgePositions: Float32Array.from(edgePositions), edges, diagnostics: [] };
}

/**
 * `r` with face `face`'s side from its corner `corner` to the next given a point of its own, `at` (a fraction along
 * the side, then an offset), the face's quad made a fan from it: three triangles, wound as the quad. Its neighbour
 * along that side and the side's polyline keep the side as one segment (a T-junction).
 */
export function withPoint(r: TessellationResult, face: number, corner: number, at = 0.5,
  offset: [number, number, number] = [0, 0, 0]): TessellationResult {
  const f = r.faces.find((x) => x.entityId === face)!;
  const base = r.indices[f.start]!;
  const c = (k: number) => Array.from(r.positions.subarray(3 * (base + k % 4), 3 * (base + k % 4) + 3));
  const a = c(corner), b = c(corner + 1);
  const m = a.map((x, i) => x + at * (b[i]! - x) + offset[i]!);
  const positions = new Float32Array(r.positions.length + 3);
  positions.set(r.positions);
  const mi = r.positions.length / 3;
  positions.set(m, 3 * mi);
  const q = (k: number) => base + (corner + k) % 4;
  const fan = [mi, q(1), q(2), mi, q(2), q(3), mi, q(3), q(0)];
  const indices: number[] = [];
  const faces = r.faces.map((x) => {
    const start = indices.length;
    if (x.entityId === face) indices.push(...fan);
    else indices.push(...r.indices.subarray(x.start, x.start + x.count));
    return { ...x, start, count: indices.length - start };
  });
  return { ...r, positions, indices: Uint32Array.from(indices), faces };
}

/**
 * `r` with face `face` the polygon `pts` (its corners in the face's winding, as new vertices), a fan from its first
 * corner.
 */
export function withPolygon(r: TessellationResult, face: number, pts: number[][]): TessellationResult {
  const base = r.positions.length / 3;
  const positions = Float32Array.from([...r.positions, ...pts.flat()]);
  const fan: number[] = [];
  for (let k = 1; k + 1 < pts.length; k++) fan.push(base, base + k, base + k + 1);
  const indices: number[] = [];
  const faces = r.faces.map((x) => {
    const start = indices.length;
    if (x.entityId === face) indices.push(...fan);
    else indices.push(...r.indices.subarray(x.start, x.start + x.count));
    return { ...x, start, count: indices.length - start };
  });
  return { ...r, positions, indices: Uint32Array.from(indices), faces };
}
