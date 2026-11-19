// Measures for the tests, independent of the pass: its own samples, cad-geom's evaluators.

import type { BrepData } from 'cad-brep';
import { Geometry, type GeomModule } from 'cad-geom';

/** The face whose loops hold coedge c. */
export function faceOf(d: BrepData, c: number): number {
  for (let f = 0; f < d.face.surface.length; f++) {
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++)
      if (c >= d.loop.first[l]! && c < d.loop.first[l]! + d.loop.count[l]!) return f;
  }
  throw new Error(`coedge ${c} in no face`);
}

/**
 * The largest distance, at 101 parameters over `range`, from coedge c's p-curve at t (through its face's surface,
 * the model's own p-curve or the face API's projection where it has none) to its edge's curve at t: the model's rule.
 */
export function sameParameterGap(module: GeomModule, d: BrepData, c: number, range: [number, number]): number {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const ci = d.edge.curve[d.coedge.edge[c]!]!, surface = d.face.surface[faceOf(d, c)]!;
  const ts = Array.from({ length: 101 }, (_, i) => range[0] + (range[1] - range[0]) * i / 100);
  const p = g.evalCoedge(c, ts, 0).values, C = g.evalCurve(ci, ts, 0).values, uv: number[] = [];
  for (let i = 0; i < ts.length; i++) uv.push(p[3 * i]!, p[3 * i + 1]!);
  const S = g.evalSurface(surface, uv, 0).values;
  let w = 0;
  for (let i = 0; i < ts.length; i++)
    w = Math.max(w, Math.hypot(S[3 * i]! - C[3 * i]!, S[3 * i + 1]! - C[3 * i + 1]!, S[3 * i + 2]! - C[3 * i + 2]!));
  return w;
}

/** Coedge c's p-curve's (u, v) at t (the model's own). */
export function uvAt(module: GeomModule, d: BrepData, c: number, t: number): [number, number] {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const v = g.evalCoedge(c, [t], 0).values;
  return [v[0]!, v[1]!];
}
