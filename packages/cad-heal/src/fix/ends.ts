// vertexTolerance and pcurveEnds: a vertex's tolerance grown to cover the gaps measured at it. vertexTolerance: its
// edges' curves' ends (each edge's curve at the end of its range there); pcurveEnds: the ends of the source's
// p-curves kept on its edges (through their surfaces), which also grows the edge's tolerance, since the face API
// bridges a loop's joints within the face's tolerance widened by its edges', not its vertices'. Both to GROWTH times
// the gap, never shrunk, no cap.

import type { BrepData } from 'cad-brep';
import type { Geometry } from 'cad-geom';

/** The distance from point i of `a` (x, y, z triples) to vertex v. */
export const gapTo = (d: BrepData, v: number, a: ArrayLike<number>, i = 0) =>
  Math.hypot(a[3 * i]! - d.vertex.point[3 * v]!, a[3 * i + 1]! - d.vertex.point[3 * v + 1]!,
    a[3 * i + 2]! - d.vertex.point[3 * v + 2]!);

/** Edge e's curve's ends' gaps to its start and end vertices, over `range` (its parameters there); NaN where
 * there's no vertex or the curve can't be evaluated. */
export function curveEndGaps(g: Geometry, d: BrepData, e: number, range: [number, number]): [number, number] {
  const C = g.evalCurve(d.edge.curve[e]!, range, 0);
  if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) return [NaN, NaN];
  const s = d.edge.start[e]!, t = d.edge.end[e]!;
  return [s >= 0 ? gapTo(d, s, C.values, 0) : NaN, t >= 0 ? gapTo(d, t, C.values, 1) : NaN];
}
