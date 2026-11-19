// Curves on surfaces (T3 lane 1): each face's coedges measured against their edges' curves, and each fix decided per
// coedge. Its record is what the analysis buffer says of each p-curve and tolerance (PROVENANCE).

import { type BrepData, CURVE_KIND, LOOP_KIND, PROVENANCE, rowCount, SURFACE_KIND, TRACE_STATUS, TRACE_STOP } from
  'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Diagnostic } from 'cad-scene';
import type { Curve2, ModelEdit } from './edit.ts';
import { reparameterize, reparameterized } from './fix/reparam.ts';
import { projected, replacement } from './fix/replace.ts';
import { curveEndGaps, gapTo } from './fix/ends.ts';
import { curveOffSurface, type Grids, GROWTH } from './fix/tolerance.ts';
import { Growth } from './fix/growth.ts';
import type { HealFix } from './index.ts';
import { edgeRange, measureGiven, pcurveImage, tolerances } from './measure.ts';
import { stubTracer, type Tracer } from './trace.ts';

/** What the pass did, for the analysis buffer: per coedge its p-curve's provenance and measured deviation. */
export interface CurvesRecord {
  pcurveFrom: Uint8Array;
  deviation: Float64Array;
  /** Per edge: PROVENANCE of its range (healed where the pass wrote one the source left out). */
  edgeRangeFrom: Uint8Array;
  /** The coedges traced, as the analysis buffer's trace rows (TRACE_STATUS, TRACE_STOP), in the order traced. */
  traces: { coedge: number; status: number; tol: number; offSurface: number; stopAt: number; stopWhy: number }[];
}

/** The surface kinds whose inversion is closed form. */
const CLOSED_FORM = new Set<number>([SURFACE_KIND.plane, SURFACE_KIND.cylinder, SURFACE_KIND.cone, SURFACE_KIND.sphere,
  SURFACE_KIND.torus]);

const STOP_NAME = Object.fromEntries(Object.entries(TRACE_STOP).map(([k, v]) => [v, k])) as Record<number, string>;

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

/** Coedges between progress reports. */
export const PROGRESS_EVERY = 200;

/**
 * `tracer`: what traces a bare coedge's curve where the grid can't bound it (trace.ts; its stub by default);
 * `progress`: told where the pass is, every PROGRESS_EVERY coedges and at each step after.
 */
export function healCurves(g: Geometry, d: BrepData, fixes: ReadonlySet<HealFix>, edit: ModelEdit,
  diagnostics: Diagnostic[], tracer: Tracer = stubTracer(g), progress: (what: string) => void = () => {}):
  CurvesRecord {
  const nc = rowCount(d, 'coedge'), tol = tolerances(d), nan = () => new Float64Array(nc).fill(NaN);
  const record: CurvesRecord = { pcurveFrom: new Uint8Array(nc), deviation: nan(),
    edgeRangeFrom: new Uint8Array(rowCount(d, 'edge')), traces: [] };
  // The traces: p-curves kept at the edge's tolerance, kept with it grown, none kept (by why), stops (where, why).
  const tracedAtTol = new Tally(), tracedGrown = new Tally(), tracedBare = new Map<string, Tally>();
  const stopped = new Tally();
  let worstTraced = 0;
  for (let e = 0; e < record.edgeRangeFrom.length; e++) {
    if (Number.isFinite(d.edge.range[2 * e]!)) record.edgeRangeFrom[e] = PROVENANCE.given;
  }
  const reparam = new Tally(), reparamKind = new Tally(), replaced = new Tally(), dropped = new Tally();
  const toRange = new Tally();
  // Per edge: the interval its kept p-curves' domains allow its range, where one misses it by rounding.
  const clampTo = new Map<number, [number, number]>();
  const made = new Tally(), notReplaced = new Map<string, Tally>(), notMade = new Map<string, Tally>();
  const add = (m: Map<string, Tally>, why: string, c: number) =>
    (m.get(why) ?? m.set(why, new Tally()).get(why)!).add(coedgeName(c));
  let worstMade = 0;
  // Per edge: the largest disagreement measured along it (edgeTolerance's).
  const need = new Float64Array(rowCount(d, 'edge')), grids: Grids = new Map();
  const needs = (e: number, x: number) => {
    if (x > need[e]!) need[e] = x;
  };
  // Per vertex and per edge: the largest gap from a kept source p-curve's end to its vertex (pcurveEnds').
  const endNeedV = new Float64Array(rowCount(d, 'vertex')), endNeedE = new Float64Array(rowCount(d, 'edge'));
  let worstGiven = 0, worstNew = 0;
  let visited = 0;
  const coedgeName = (c: number) => `coedge #${d.coedge.id[c]} (edge #${d.edge.id[d.coedge.edge[c]!]})`;
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const surface = d.face.surface[f]!, onPlane = d.surface.kind[surface] === SURFACE_KIND.plane;
    const closedForm = CLOSED_FORM.has(d.surface.kind[surface]!);
    // Each coedge's p-curve parameters along its use, where it's one piece, and the face's periods: the face API's,
    // asked only where needed, since the face API's first query on a face projects every coedge of it that has no
    // p-curve (the cost pcurveMissing's switch is for).
    let travel: Map<number, [number, number] | null> | undefined, periods: [number, number] | undefined;
    const travelOf = (c: number) => {
      if (!travel) {
        travel = new Map();
        const pieces = g.facePieces(f);
        if (pieces.status === 'ok') {
          for (let k = 0; k < pieces.coedge.length; k++) {
            const x = pieces.coedge[k]!;
            travel.set(x, travel.has(x) ? null : [pieces.travel[2 * k]!, pieces.travel[2 * k + 1]!]);
          }
        }
      }
      return travel.get(c) ?? undefined;
    };
    const periodsOf = () => {
      if (!periods) {
        const info = g.faceInfo(f);
        periods = info.status === 'ok' ? [info.uPeriod, info.vPeriod] : [0, 0];
      }
      return periods;
    };
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        if (++visited % PROGRESS_EVERY === 0) {
          progress(`curves: coedge ${visited} of ${nc} (face ${f}, ${coedgeName(c)})`);
        }
        const e = d.coedge.edge[c]!, pc = d.coedge.pcurve[c]!;
        if (pc >= 0) record.pcurveFrom[c] = PROVENANCE.given;
        const range = d.edge.curve[e]! >= 0 ? edgeRange(g, e) : undefined;
        if (!range) continue;
        const newRange = () => {
          if (Number.isNaN(edit.get('edge', 'range', 2 * e))) {
            edit.set('edge', 'range', 2 * e, range[0]), edit.set('edge', 'range', 2 * e + 1, range[1]);
            record.edgeRangeFrom[e] = PROVENANCE.healed;
          }
          if (Number.isFinite(d.coedge.range[2 * c]!)) {
            edit.set('coedge', 'range', 2 * c, range[0]), edit.set('coedge', 'range', 2 * c + 1, range[1]);
          }
        };
        // A projection's parameter onto `range`'s: equal, or a period apart (the face API's edge range may be).
        const onRange = (curve: Curve2, from: [number, number]) => {
          const shift = from[0] - range[0];
          return Math.abs(from[1] - range[1] - shift) <= 1e-9 * Math.max(1, Math.abs(range[1] - range[0]))
            ? reparameterize(curve, 1, shift, range) ?? (shift === 0 ? curve : undefined) : undefined;
        };
        // A coedge left without a p-curve: its curve's distance from the surface is what its edge's tolerance needs,
        // bounded on a grid where it can be, else traced (on a surface whose inversion is closed form, a plane, a
        // cylinder, a cone, a sphere or a torus, that inversion instead: no global search to replace), the trace's
        // p-curve kept where its fit is within the tolerance (grown to cover the curve's own distance where that's
        // past it). `traceable` false: a projection already tried and failed (pcurveMissing's).
        const bare = (traceable = true) => {
          if (!fixes.has('edgeTolerance')) return;
          const tolE = tol.edge(e), curve = d.edge.curve[e]!;
          needs(e, curveOffSurface(g, curve, range, surface, tolE, grids,
            closedForm || !traceable ? undefined : () => traced(tolE)));
        };
        const traced = (tolE: number) => {
          const tr = tracer.trace(c, tolE);
          record.traces.push({ coedge: c, status: TRACE_STATUS[tr.status], tol: tolE, offSurface: tr.offSurface,
            stopAt: tr.stopAt, stopWhy: tr.stopWhy });
          if (tr.status === 'stopped') {
            stopped.add(`${coedgeName(c)} at t = ${tr.stopAt.toPrecision(6)} (${STOP_NAME[tr.stopWhy]})`);
          }
          const fit = tr.fit, made = 'why' in fit ? undefined : onRange(fit.curve, fit.range);
          if (!made || 'why' in fit || !fit.within || tr.status !== 'ok') {
            add(tracedBare, 'why' in fit ? fit.why : !made ? 'on another range' : tr.status !== 'ok' ? 'stopped'
              : 'its fit short of the tolerance', c);
            return tr.offSurface;
          }
          edit.set('coedge', 'pcurve', c, edit.addCurve2(made));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = fit.error;
          const need = Math.max(fit.error, Number.isNaN(tr.offSurface) ? 0 : tr.offSurface);
          (need > tolE ? tracedGrown : tracedAtTol).add(coedgeName(c));
          worstTraced = Math.max(worstTraced, need);
          return need;
        };
        if (pc < 0 && (onPlane || !fixes.has('pcurveMissing'))) {
          bare();
          continue;
        }
        // The p-curve's own parameters at the use's ends: the source's range for the use; else the p-curve's finite
        // domain (a B-spline's knots: usually the use's), then the face API's pieces (which can cost the face's
        // projections), a line having no domain to offer.
        const r0 = d.coedge.range[2 * c]!, r1 = d.coedge.range[2 * c + 1]!;
        function* candidates(): Generator<[number, number]> {
          if (Number.isFinite(r0) && Number.isFinite(r1)) return yield [r0, r1];
          const own = g.curveInfo(pc);
          if (Number.isFinite(own.lo) && Number.isFinite(own.hi)) yield [own.lo, own.hi];
          const t = travelOf(c);
          if (t) yield t;
        }
        const ends = () => {
          let last: [number, number] | undefined;
          for (const x of candidates()) last = x;
          return last;
        };
        const m = pc >= 0 ? measureGiven(g, d, c, surface, range, candidates, tol.edge(e), periodsOf)
          : { kind: 'unmeasured' as const, why: 'none' };
        if (m.kind !== 'unmeasured') record.deviation[c] = m.deviation;
        // What the coedge's p-curve needs if it's kept; a fix that changes it says what the new one needs.
        const kept = m.kind === 'unmeasured' ? NaN : m.deviation;
        const keep = () => {
          needs(e, kept);
          if (!fixes.has('pcurveEnds') || m.kind === 'unmeasured') return;
          // Its ends through the surface against the edge's vertices: at the edge's range where it's the curve's
          // parameter (or its affine map), else at its own ends along the use, each vertex taking the nearer.
          const vs = [d.edge.start[e]!, d.edge.end[e]!];
          const at = m.kind === 'same' ? range : m.kind === 'affine' ? range.map((t) => m.a * t + m.b) : ends();
          const P = at && pcurveImage(g, d, c, surface, at, periodsOf);
          if (!P) return;
          for (const v of vs) {
            if (v < 0) continue;
            const gap = m.kind === 'off' ? Math.min(gapTo(d, v, P, 0), gapTo(d, v, P, 1))
              : gapTo(d, v, P, vs.indexOf(v));
            if (gap > endNeedV[v]!) endNeedV[v] = gap;
            if (gap > endNeedE[e]!) endNeedE[e] = gap;
          }
        };
        // A p-curve the pass writes is in the parameter of `range`, so the edge gets that range where the source
        // gave none: consumers derive ranges by their own searches, which can differ by a period on a closed curve,
        // and the p-curve would be a period off for them. The use's range, in the p-curve's old parameter, becomes
        // the edge's.
        if (pc < 0) {
          const p = projected(g, c);
          const curve = 'why' in p ? undefined : onRange(p.curve, p.range);
          if (!curve) {
            add(notMade, 'why' in p ? p.why : 'on another range', c);
            bare(false);
            continue;
          }
          edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = p.error;
          needs(e, p.error);
          worstMade = Math.max(worstMade, p.error);
          made.add(coedgeName(c));
          continue;
        }
        // The same parameter, but its domain short of the edge's range by rounding (vertices a hair off the curve
        // put the range's end past the p-curve's): evaluation at the range's end is refused as outside the domain,
        // for the face API and every consumer. The edge's range is written onto its p-curves' domains after the loop
        // (a change of at most 1e-9 of its span), any kind of p-curve (a trimmed curve can't take a knot snap).
        if (m.kind === 'same' && fixes.has('pcurveReparam')) {
          const own = g.curveInfo(pc), lo = Math.min(...range), hi = Math.max(...range), sl = 1e-9 * (hi - lo);
          if ((lo < own.lo && lo >= own.lo - sl) || (hi > own.hi && hi <= own.hi + sl)) {
            const [cl, ch] = clampTo.get(e) ?? [lo, hi];
            clampTo.set(e, [Math.max(cl, own.lo), Math.min(ch, own.hi)]);
            toRange.add(coedgeName(c));
          }
        }
        let off = m.kind === 'off';
        if (m.kind === 'affine' && fixes.has('pcurveReparam')) {
          const curve = reparameterized(d, pc, m.a, m.b, range);
          if (curve) {
            edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
            newRange();
            record.pcurveFrom[c] = PROVENANCE.healed;
            reparam.add(coedgeName(c));
            needs(e, m.deviation);
            continue;
          }
          reparamKind.add(coedgeName(c));
          // Not representable in the curve's parameter: off for consumers that take it as the curve's.
          off = true;
        }
        if (!off || !fixes.has('pcurveReplace')) {
          keep();
          continue;
        }
        const given = m.kind === 'off' ? Math.max(m.deviation, Number.isNaN(m.ends) ? 0 : m.ends) : Infinity;
        const r = replacement(g, c, onPlane, given);
        if (r.kind === 'none') {
          add(notReplaced, r.why, c);
          keep();
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
          needs(e, r.error);
        } else {
          const curve = onRange(r.curve, r.range);
          if (!curve) {
            add(notReplaced, 'on another range', c);
            keep();
            continue;
          }
          edit.set('coedge', 'pcurve', c, edit.addCurve2(curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          replaced.add(coedgeName(c));
          needs(e, r.error);
        }
      }
    }
  }
  // The edges whose kept p-curves' domains miss their ranges by rounding: their ranges written onto the domains (in the
  // edge's own order, start to end).
  for (const [e, [lo, hi]] of clampTo) {
    const r0 = edit.get('edge', 'range', 2 * e), r1 = edit.get('edge', 'range', 2 * e + 1);
    const range = Number.isFinite(r0) && Number.isFinite(r1) ? [r0, r1] as [number, number] : edgeRange(g, e);
    if (!range || !(lo < hi)) continue;
    const up = range[1] >= range[0];
    edit.set('edge', 'range', 2 * e, up ? lo : hi), edit.set('edge', 'range', 2 * e + 1, up ? hi : lo);
    record.edgeRangeFrom[e] = PROVENANCE.healed;
  }
  progress('ranges and vertexTolerance');
  // vertexTolerance: each edge's curve's ends against its vertices, over the range its p-curves are in.
  const vNeed = new Float64Array(rowCount(d, 'vertex')), vNeedE = new Float64Array(rowCount(d, 'edge'));
  if (fixes.has('vertexTolerance')) {
    for (let e = 0; e < need.length; e++) {
      if (d.edge.curve[e]! < 0) continue;
      const r0 = edit.get('edge', 'range', 2 * e), r1 = edit.get('edge', 'range', 2 * e + 1);
      const range = Number.isFinite(r0) && Number.isFinite(r1) ? [r0, r1] as [number, number] : edgeRange(g, e);
      if (!range) continue;
      const [a, b] = curveEndGaps(g, d, e, range), [s0, s1] = [d.edge.start[e]!, d.edge.end[e]!];
      if (a > vNeed[s0]!) vNeed[s0] = a;
      if (b > vNeed[s1]!) vNeed[s1] = b;
      // The edge's too: the face API and the tessellator judge a vertex's gaps by its edges' tolerances.
      const gap = Math.max(Number.isNaN(a) ? 0 : a, Number.isNaN(b) ? 0 : b);
      if (gap > vNeedE[e]!) vNeedE[e] = gap;
    }
  }
  // The tolerances grown, edges' and vertices', in one diagnostic for the part (growth.ts's rule for its severity).
  const growth = new Growth(tol.size);
  for (let v = 0; v < vNeed.length; v++) {
    const byV = fixes.has('vertexTolerance') && vNeed[v]! > tol.vertex(v);
    const byEnds = fixes.has('pcurveEnds') && endNeedV[v]! > tol.vertex(v);
    if (!byV && !byEnds) continue;
    const grown = GROWTH * Math.max(byV ? vNeed[v]! : 0, byEnds ? endNeedV[v]! : 0);
    edit.set('vertex', 'tolerance', v, grown);
    growth.add('vertex', d.vertex.id[v]!, tol.vertex(v), grown,
      [...byV ? ['vertexTolerance' as const] : [], ...byEnds ? ['pcurveEnds' as const] : []]);
  }
  // edgeTolerance: grown where what's measured is past what the edge is judged by; pcurveEnds' and vertexTolerance's
  // gaps grow the edges at them too, since the face API and the tessellator judge a vertex's gaps by its edges'.
  for (let e = 0; e < need.length; e++) {
    const byE = fixes.has('edgeTolerance') && need[e]! > tol.edge(e);
    const byEnds = fixes.has('pcurveEnds') && endNeedE[e]! > tol.edge(e);
    const byV = fixes.has('vertexTolerance') && vNeedE[e]! > tol.edge(e);
    if (!byE && !byEnds && !byV) continue;
    const grown = GROWTH * Math.max(byE ? need[e]! : 0, byEnds ? endNeedE[e]! : 0, byV ? vNeedE[e]! : 0);
    edit.set('edge', 'tolerance', e, grown);
    growth.add('edge', d.edge.id[e]!, tol.edge(e), grown, [...byE ? ['edgeTolerance' as const] : [],
      ...byV ? ['vertexTolerance' as const] : [], ...byEnds ? ['pcurveEnds' as const] : []]);
  }
  const grownDiagnostic = growth.diagnostic();
  if (grownDiagnostic) diagnostics.push(grownDiagnostic);
  if (tracedAtTol.n || tracedGrown.n) {
    const ex = [...tracedAtTol.ex, ...tracedGrown.ex].slice(0, EXAMPLES);
    diagnostics.push({ severity: 'warning', message: `edgeTolerance: ${tracedAtTol.n + tracedGrown.n} coedges' curves `
      + `traced onto their surfaces (the grid not bounding them within the tolerance) given the trace's p-curve, `
      + `${tracedGrown.n} of them with their edges' tolerances grown to cover it (up to ${worstTraced.toPrecision(3)} `
      + `mm): ${ex.join(', ')}${tracedAtTol.n + tracedGrown.n > ex.length
        ? `, ${tracedAtTol.n + tracedGrown.n - ex.length} more` : ''}` });
  }
  for (const [why, t] of tracedBare) {
    diagnostics.push({ severity: 'warning', message: `edgeTolerance: ${t.n} coedges' curves traced onto their `
      + `surfaces left without a p-curve (${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  if (stopped.n) {
    diagnostics.push({ severity: 'warning', message: `edgeTolerance: ${stopped.n} traces stopped before their `
      + `curves' ends: ${stopped.ex.join(', ')}${stopped.more()}` });
  }
  if (made.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveMissing: ${made.n} p-curves made by projecting their `
      + `edges' curves (off by up to ${worstMade.toPrecision(3)} mm): ${made.ex.join(', ')}${made.more()}` });
  }
  for (const [why, t] of notMade) {
    diagnostics.push({ severity: 'warning', message: `pcurveMissing: ${t.n} coedges left without a p-curve (the `
      + `projection ${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  if (reparam.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${reparam.n} p-curves given their edges' `
      + `curves' parameter (theirs an affine function of it): ${reparam.ex.join(', ')}${reparam.more()}` });
  }
  if (toRange.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${toRange.n} p-curves' edges' ranges put on their `
      + `domains (past them by rounding): ${toRange.ex.join(', ')}${toRange.more()}` });
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
