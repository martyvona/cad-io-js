// compactCurves: the curve rows healing appended that nothing references any more dropped, so a model healed again
// and again doesn't grow (each healing appends its own p-curves, and a re-heal drops the last one's). Healing's rows
// are the model's from `sourceCurves` on: 2D curves, referenced by coedges' p-curves and by each other (a trimmed,
// composite or offset curve's basis) only, their pool data after the source's in row order (ModelEdit appends them
// so). The source's rows are kept as they are whatever references them: one a fix replaced is still referenced by the
// analysis's givenPcurve (the source's p-curve, kept for healing again), so it's live.

import { type BrepData, type ColumnSpec, CURVE_KIND, rowCount, writeBrep } from 'cad-brep';

/** The curve rows a curve row references (a trimmed or offset curve's basis, a composite's segments). */
function bases(m: BrepData, k: number): number[] {
  const I = m.pool.curveInt, at = m.curve.int[k]!;
  switch (m.curve.kind[k]) {
    case CURVE_KIND.trimmed: case CURVE_KIND.offset: return [I[at]!];
    case CURVE_KIND.composite: return Array.from({ length: I[at]! }, (_, j) => I[at + 2 + 3 * j]!);
    default: return [];
  }
}

/** The model without healing's unreferenced curve rows (itself where there are none), references renumbered. */
export function compactCurves(m: BrepData, sourceCurves: number): BrepData {
  const n = rowCount(m, 'curve'), ours = n - sourceCurves;
  if (ours <= 0) return m;
  const live = new Uint8Array(ours);
  const mark = (k: number) => {
    if (k >= sourceCurves) live[k - sourceCurves] = 1;
  };
  for (const k of m.coedge.pcurve) mark(k);
  // A row references only earlier rows, so the later ones first.
  for (let k = n - 1; k >= sourceCurves; k--) if (live[k - sourceCurves]) for (const b of bases(m, k)) mark(b);
  if (live.every(Boolean)) return m;
  const to = new Int32Array(ours).fill(-1);
  const kind: number[] = [], dim: number[] = [], real: number[] = [], int: number[] = [], id: number[] = [];
  const reals: number[] = [], ints: number[] = [];
  const R = m.pool.curveReal, I = m.pool.curveInt;
  const realEnd = (k: number) => k + 1 < n ? m.curve.real[k + 1]! : R.length;
  const intEnd = (k: number) => k + 1 < n ? m.curve.int[k + 1]! : I.length;
  const realFrom = m.curve.real[sourceCurves]!, intFrom = m.curve.int[sourceCurves]!;
  for (let k = sourceCurves; k < n; k++) {
    if (realEnd(k) < m.curve.real[k]! || intEnd(k) < m.curve.int[k]!) {
      throw new Error(`cad-heal: curve row ${k}'s pool data not after row ${k - 1}'s`);
    }
    if (!live[k - sourceCurves]) continue;
    to[k - sourceCurves] = sourceCurves + kind.length;
    kind.push(m.curve.kind[k]!), dim.push(m.curve.dim[k]!), id.push(m.curve.id[k]!);
    real.push(realFrom + reals.length), int.push(intFrom + ints.length);
    for (let i = m.curve.real[k]!; i < realEnd(k); i++) reals.push(R[i]!);
    const at = ints.length;
    for (let i = m.curve.int[k]!; i < intEnd(k); i++) ints.push(I[i]!);
    const re = (j: number) => {
      if (ints[at + j]! >= sourceCurves) ints[at + j] = to[ints[at + j]! - sourceCurves]!;
    };
    if (m.curve.kind[k] === CURVE_KIND.trimmed || m.curve.kind[k] === CURVE_KIND.offset) re(0);
    else if (m.curve.kind[k] === CURVE_KIND.composite) for (let j = 0; j < ints[at]!; j++) re(2 + 3 * j);
  }
  const pcurve = Int32Array.from(m.coedge.pcurve, (k) => k >= sourceCurves ? to[k - sourceCurves]! : k);
  const joined = (own: ArrayLike<number>, keep: number, more: number[]) => {
    const out = new Float64Array(keep + more.length);
    for (let i = 0; i < keep; i++) out[i] = own[i]!;
    out.set(more, keep);
    return out;
  };
  const columns: Record<string, ArrayLike<number>> = {
    'curve.kind': joined(m.curve.kind, sourceCurves, kind), 'curve.dim': joined(m.curve.dim, sourceCurves, dim),
    'curve.real': joined(m.curve.real, sourceCurves, real), 'curve.int': joined(m.curve.int, sourceCurves, int),
    'curve.id': joined(m.curve.id, sourceCurves, id), 'pool.curveReal': joined(R, realFrom, reals),
    'pool.curveInt': joined(I, intFrom, ints), 'coedge.pcurve': pcurve,
  };
  return writeBrep((c: ColumnSpec) => columns[`${c.table}.${c.column}`]
    ?? (m as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!);
}
