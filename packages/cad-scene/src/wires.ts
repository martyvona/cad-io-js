// A part's wireframe curves and points (a model's curve and point items: STEP's geometric sets' curves and points),
// which a tessellation result carries beside its triangles: the ones a result lacks, the fallback's added for them
// (FallbackTessellator), and what no backend delivered said (tessellateScene).

import { type BrepData, ITEM_KIND } from 'cad-brep';
import type { TessellationResult } from './tessellator.ts';

/** Ids of the curve and point items a result should carry and doesn't. */
export interface MissingWires {
  curves: number[];
  points: number[];
}

/**
 * The model's curve and point items (by id) that `r` has no curve or point for. A result's curves or points with no
 * source (null) are no one item's: as many missing ids as there are such are taken as delivered, since they can't
 * be told apart. Items with no id (0: a model built without one) can't be matched and aren't counted.
 */
export function missingWires(model: BrepData, r: TessellationResult): MissingWires {
  const want = { curves: [] as number[], points: [] as number[] };
  for (let k = 0; k < model.item.kind.length; k++) {
    const id = model.item.id[k]!;
    if (!id) continue;
    if (model.item.kind[k] === ITEM_KIND.curve) want.curves.push(id);
    else if (model.item.kind[k] === ITEM_KIND.point) want.points.push(id);
  }
  const lacking = (ids: number[], got: (number | null)[]) => {
    const have = new Set(got);
    const unnamed = got.filter((x) => x === null).length;
    const out = [...new Set(ids)].filter((id) => !have.has(id));
    return out.slice(Math.min(unnamed, out.length));
  };
  return { curves: lacking(want.curves, (r.curves ?? []).map((c) => c.entityId)),
    points: lacking(want.points, r.pointIds ?? new Array<null>((r.points?.length ?? 0) / 3).fill(null)) };
}

/** Whether nothing is missing. */
export const noneMissing = (m: MissingWires): boolean => !m.curves.length && !m.points.length;

/**
 * `r` with `from`'s curves and points for the ids in `missing` added (both results of one request, so in the same
 * coordinates), and the ids added.
 */
export function addWires(r: TessellationResult, from: TessellationResult, missing: MissingWires):
  { result: TessellationResult; added: MissingWires } {
  const added: MissingWires = { curves: [], points: [] };
  const wantCurves = new Set(missing.curves), wantPoints = new Set(missing.points);
  const out: TessellationResult = { ...r };
  const fromCurves = (from.curves ?? []).filter((c) => c.entityId !== null && wantCurves.has(c.entityId));
  if (fromCurves.length && from.curvePositions) {
    const old = r.curvePositions ?? new Float32Array(0), curves = [...(r.curves ?? [])];
    let n = old.length / 3;
    for (const c of fromCurves) n += c.count;
    const pos = new Float32Array(3 * n);
    pos.set(old);
    let at = old.length / 3;
    for (const c of fromCurves) {
      pos.set(from.curvePositions.subarray(3 * c.start, 3 * (c.start + c.count)), 3 * at);
      curves.push({ entityId: c.entityId, start: at, count: c.count });
      at += c.count;
      if (!added.curves.includes(c.entityId!)) added.curves.push(c.entityId!);
    }
    out.curvePositions = pos;
    out.curves = curves;
  }
  const ids = from.pointIds ?? [];
  const take = ids.map((id, i) => [id, i] as const).filter(([id]) => id !== null && wantPoints.has(id));
  if (take.length && from.points) {
    const old = r.points ?? new Float32Array(0), oldIds = r.pointIds ?? [];
    const pos = new Float32Array(old.length + 3 * take.length);
    pos.set(old);
    const pointIds = [...oldIds];
    take.forEach(([id, i], k) => {
      pos.set(from.points!.subarray(3 * i, 3 * i + 3), old.length + 3 * k);
      pointIds.push(id);
      if (!added.points.includes(id!)) added.points.push(id!);
    });
    out.points = pos;
    out.pointIds = pointIds;
  }
  return { result: out, added };
}

/** "2 curves (#10, #11) and 1 point (#12)", at most `max` ids each. */
export function describeWires(m: MissingWires, max = 10): string {
  const one = (ids: number[], what: string) => !ids.length ? '' : `${ids.length} ${what}${ids.length === 1 ? '' : 's'}`
    + ` (${ids.slice(0, max).map((x) => `#${x}`).join(', ')}${ids.length > max ? ', ...' : ''})`;
  return [one(m.curves, 'wireframe curve'), one(m.points, 'point')].filter(Boolean).join(' and ');
}
