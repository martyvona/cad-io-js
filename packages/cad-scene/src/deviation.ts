// The deviation judge: how far a result's mesh of a face strays from the face's exact surface, for the per-face
// fallback (fallback.ts, with judgeDeviation on: off by default, a backend's own deflection trusted) to take another
// backend's mesh of a face only where it's within the deflection. cad-scene has no surface inversion of its own, so a
// judge is set per thread (setDeviationJudge: cad-geom's meshDeviationJudge, on the thread the fallback runs on);
// without one, faces are judged by their area alone, and the fallback says so.

import type { BrepData } from 'cad-brep';
import type { TessellationResult } from './tessellator.ts';

export interface DeviationJudge {
  readonly name: string;
  /**
   * A face's (by id) mesh in `r`, its triangles' worst sampled distance from the face's surface in model units (a
   * lower bound on the worst: only sampled points), or undefined where it can't say (no such face, no triangles, its
   * surface not evaluated).
   */
  worst(model: BrepData, r: TessellationResult, face: number): number | undefined;
}

let current: DeviationJudge | undefined;

/** Sets this thread's deviation judge; none: faces judged by area alone. */
export function setDeviationJudge(j: DeviationJudge | undefined): void {
  current = j;
}

/** This thread's deviation judge, if one is set. */
export function deviationJudge(): DeviationJudge | undefined {
  return current;
}
