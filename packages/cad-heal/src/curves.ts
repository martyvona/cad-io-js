// Curves on surfaces (T3 lane 1): each face's coedges measured against their edges' curves, and each fix decided per
// coedge. Its record is what the analysis buffer says of each p-curve and tolerance (PROVENANCE).

import { type BrepData, LOOP_KIND, PROVENANCE, rowCount } from 'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Diagnostic } from 'cad-scene';
import type { ModelEdit } from './edit.ts';
import { reparameterized } from './fix/reparam.ts';
import type { HealFix } from './index.ts';
import { edgeRange, measureGiven, tolerances } from './measure.ts';

/** What the pass did, for the analysis buffer: per coedge its p-curve's provenance and measured deviation. */
export interface CurvesRecord {
  pcurveFrom: Uint8Array;
  deviation: Float64Array;
}

/** A fix's count and up to EXAMPLES of what it changed (as the model's ids). */
const EXAMPLES = 5;
class Tally {
  n = 0;
  readonly ex: string[] = [];
  add(what: string) {
    this.n++;
    if (this.ex.length < EXAMPLES) this.ex.push(what);
  }
  more() {
    return this.n > this.ex.length ? `, ${this.n - this.ex.length} more` : '';
  }
}

export function healCurves(g: Geometry, d: BrepData, fixes: ReadonlySet<HealFix>, edit: ModelEdit,
  diagnostics: Diagnostic[]): CurvesRecord {
  const nc = rowCount(d, 'coedge'), tol = tolerances(d);
  const record: CurvesRecord = { pcurveFrom: new Uint8Array(nc), deviation: new Float64Array(nc).fill(NaN) };
  const reparam = new Tally(), reparamKind = new Tally();
  const coedgeName = (c: number) => `coedge #${d.coedge.id[c]} (edge #${d.edge.id[d.coedge.edge[c]!]})`;
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const surface = d.face.surface[f]!;
    // Each coedge's p-curve parameters along its use, where it's one piece (the face API's).
    const pieces = g.facePieces(f), travel = new Map<number, [number, number] | null>();
    if (pieces.status === 'ok') {
      for (let k = 0; k < pieces.coedge.length; k++) {
        const c = pieces.coedge[k]!;
        travel.set(c, travel.has(c) ? null : [pieces.travel[2 * k]!, pieces.travel[2 * k + 1]!]);
      }
    }
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        const e = d.coedge.edge[c]!, pc = d.coedge.pcurve[c]!;
        if (pc < 0) continue;
        record.pcurveFrom[c] = PROVENANCE.given;
        const range = d.edge.curve[e]! >= 0 ? edgeRange(d, e) : undefined;
        if (!range) continue;
        // The p-curve's own parameters at the use's ends: the source's range for the use, else the face API's
        // pieces, else the p-curve's finite domain (a B-spline's knots; a line has none).
        const r0 = d.coedge.range[2 * c]!, r1 = d.coedge.range[2 * c + 1]!, own = g.curveInfo(pc);
        const ends: [number, number] | undefined = Number.isFinite(r0) && Number.isFinite(r1) ? [r0, r1]
          : travel.get(c) ?? (Number.isFinite(own.lo) && Number.isFinite(own.hi) ? [own.lo, own.hi] : undefined);
        const m = measureGiven(g, d, c, surface, range, ends, tol.edge(e));
        if (m.kind !== 'unmeasured') record.deviation[c] = m.deviation;
        if (m.kind === 'affine' && fixes.has('pcurveReparam')) {
          const curve = reparameterized(d, pc, m.a, m.b);
          if (!curve) {
            reparamKind.add(coedgeName(c));
            continue;
          }
          edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
          // The use's range was in the p-curve's old parameter; in the new one it's the edge's.
          if (Number.isFinite(d.coedge.range[2 * c]!)) {
            edit.set('coedge', 'range', 2 * c, range[0]), edit.set('coedge', 'range', 2 * c + 1, range[1]);
          }
          record.pcurveFrom[c] = PROVENANCE.healed;
          reparam.add(coedgeName(c));
        }
      }
    }
  }
  if (reparam.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${reparam.n} p-curves given their edges' `
      + `curves' parameter (theirs an affine function of it): ${reparam.ex.join(', ')}${reparam.more()}` });
  }
  if (reparamKind.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${reparamKind.n} p-curves parameterized as an `
      + `affine function of their edges' curves left as they are (a kind other than a line or B-spline): `
      + `${reparamKind.ex.join(', ')}${reparamKind.more()}` });
  }
  return record;
}
