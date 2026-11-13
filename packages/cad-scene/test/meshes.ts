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
