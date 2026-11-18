// Curves on surfaces (T3 lane 1): each face's coedges measured against their edges' curves, and each fix decided per
// coedge. Its record is what the analysis buffer says of each p-curve and tolerance (PROVENANCE).

import { type BrepData, LOOP_KIND, PROVENANCE, rowCount, SURFACE_KIND } from 'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Diagnostic } from 'cad-scene';
import type { ModelEdit } from './edit.ts';
import { reparameterize, reparameterized } from './fix/reparam.ts';
import { replacement } from './fix/replace.ts';
import type { HealFix } from './index.ts';
import { edgeRange, measureGiven, tolerances } from './measure.ts';

/** What the pass did, for the analysis buffer: per coedge its p-curve's provenance and measured deviation. */
export interface CurvesRecord {
  pcurveFrom: Uint8Array;
  deviation: Float64Array;
  /** Per edge: PROVENANCE of its range (healed where the pass wrote one the source left out). */
  edgeRangeFrom: Uint8Array;
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
  const record: CurvesRecord = { pcurveFrom: new Uint8Array(nc), deviation: new Float64Array(nc).fill(NaN),
    edgeRangeFrom: new Uint8Array(rowCount(d, 'edge')) };
  for (let e = 0; e < record.edgeRangeFrom.length; e++) {
    if (Number.isFinite(d.edge.range[2 * e]!)) record.edgeRangeFrom[e] = PROVENANCE.given;
  }
  const reparam = new Tally(), reparamKind = new Tally(), replaced = new Tally(), dropped = new Tally();
  const notReplaced = new Map<string, Tally>();
  let worstGiven = 0, worstNew = 0;
  const coedgeName = (c: number) => `coedge #${d.coedge.id[c]} (edge #${d.edge.id[d.coedge.edge[c]!]})`;
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const surface = d.face.surface[f]!, onPlane = d.surface.kind[surface] === SURFACE_KIND.plane;
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
        // A p-curve the pass writes is in the parameter of `range`, so the edge gets that range where the source
        // gave none: consumers derive ranges by their own searches, which can differ by a period on a closed curve,
        // and the p-curve would be a period off for them. The use's range, in the p-curve's old parameter, becomes
        // the edge's.
        const newRange = () => {
          if (Number.isNaN(edit.get('edge', 'range', 2 * e))) {
            edit.set('edge', 'range', 2 * e, range[0]), edit.set('edge', 'range', 2 * e + 1, range[1]);
            record.edgeRangeFrom[e] = PROVENANCE.healed;
          }
          if (Number.isFinite(d.coedge.range[2 * c]!)) {
            edit.set('coedge', 'range', 2 * c, range[0]), edit.set('coedge', 'range', 2 * c + 1, range[1]);
          }
        };
        let off = m.kind === 'off';
        if (m.kind === 'affine' && fixes.has('pcurveReparam')) {
          const curve = reparameterized(d, pc, m.a, m.b);
          if (curve) {
            edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
            newRange();
            record.pcurveFrom[c] = PROVENANCE.healed;
            reparam.add(coedgeName(c));
            continue;
          }
          reparamKind.add(coedgeName(c));
          // Not representable in the curve's parameter: off for consumers that take it as the curve's.
          off = true;
        }
        if (!off || !fixes.has('pcurveReplace')) continue;
        const given = m.kind === 'off' ? Math.max(m.deviation, Number.isNaN(m.ends) ? 0 : m.ends) : Infinity;
        const r = replacement(g, c, onPlane, given);
        if (r.kind === 'none') {
          const t = notReplaced.get(r.why) ?? notReplaced.set(r.why, new Tally()).get(r.why)!;
          t.add(coedgeName(c));
          continue;
        }
        if (Number.isFinite(given)) worstGiven = Math.max(worstGiven, given);
        worstNew = Math.max(worstNew, r.error);
        record.deviation[c] = r.error;
        if (r.kind === 'drop') {
          edit.set('coedge', 'pcurve', c, -1);
          edit.set('coedge', 'range', 2 * c, NaN), edit.set('coedge', 'range', 2 * c + 1, NaN);
          record.pcurveFrom[c] = PROVENANCE.none;
          dropped.add(coedgeName(c));
        } else {
          // The projection's parameter onto `range`'s: equal, or a period apart (the face API's edge range).
          const shift = r.range[0] - range[0];
          const curve = Math.abs(r.range[1] - range[1] - shift) <= 1e-9 * Math.max(1, Math.abs(range[1] - range[0]))
            ? shift === 0 ? r.curve : reparameterize(r.curve, 1, shift) : undefined;
          if (!curve) {
            (notReplaced.get('on another range') ?? notReplaced.set('on another range', new Tally())
              .get('on another range')!).add(coedgeName(c));
            continue;
          }
          edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          replaced.add(coedgeName(c));
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
      + `affine function of their edges' curves not reparameterized (a kind other than a line or B-spline), so `
      + `replaced where they can be: ${reparamKind.ex.join(', ')}${reparamKind.more()}` });
  }
  const mm = (x: number) => `${x.toPrecision(3)} mm`;
  if (replaced.n || dropped.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReplace: ${replaced.n} p-curves replaced by their edges' `
      + `curves projected, ${dropped.n} on planes dropped (the projection nearer: the given ones up to `
      + `${mm(worstGiven)} off, the projections up to ${mm(worstNew)}): `
      + `${[...replaced.ex, ...dropped.ex].slice(0, EXAMPLES).join(', ')}` });
  }
  for (const [why, t] of notReplaced) {
    diagnostics.push({ severity: 'warning', message: `pcurveReplace: ${t.n} p-curves off their edges' curves kept `
      + `(the projection ${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  return record;
}
