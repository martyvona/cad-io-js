// Curves on surfaces (T3 lane 1): each face's coedges measured against their edges' curves, and each fix decided per
// coedge. Its record is what the analysis buffer says of each p-curve and tolerance (PROVENANCE).

import { type BrepData, CURVE_KIND, LOOP_KIND, PROVENANCE, rowCount, SURFACE_KIND, TRACE_STATUS, TRACE_STOP } from
  'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Diagnostic } from 'cad-scene';
import type { Curve2, ModelEdit } from './edit.ts';
import { reparameterize, reparameterized } from './fix/reparam.ts';
import { projected, replacement } from './fix/replace.ts';
import { planeImage } from './fix/plane.ts';
import { curveEndGaps, gapTo } from './fix/ends.ts';
import { evalCurve2, intoDomain, overshoot } from './fix/domain.ts';
import { curveOffSurface, type Grids, GROWTH } from './fix/tolerance.ts';
import { Growth, smallLimit } from './fix/growth.ts';
import { type HealFix, PCURVE_FIT_TOLERANCE } from './options.ts';
import { edgeRange, measureGiven, pcurveImage, tolerances } from './measure.ts';
import { stubTracer, type Trace, type Tracer } from './trace.ts';

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

/** The plane projection's statuses whose map stands (invalidModel: the curve off the plane, its image the foot). */
const USABLE_ON_PLANE = new Set(['ok', 'invalidModel']);
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

/**
 * A p-curve past a side of its surface's domain is placed on it (fix/domain.ts) only where that moves it at most this
 * many times its edge's tolerance (a fit's or a source's overshoot); farther, it's left as it is.
 */
const PLACE_AT_MOST = 10;
/** Samples along a placed p-curve's range where its move on the surface is measured. */
const PLACE_SAMPLES = 65;
/**
 * pcurveFitTolerance's default (PCURVE_FIT_TOLERANCE) is this times the fine profile's deflection: tess-cadio's
 * kMeshTolerance (edges.cpp) mirrored, how it projects a use the model gives no p-curve, which a stored one replaces
 * (trace.test.ts checks the two are equal). Fitted at the edge's tolerance alone (0.08 mm off on bug31711 #11), the
 * boundary's (u, v) skews against its 3D points enough to cross itself or turn small faces' triangles over.
 */
export const MESH_FIT = 0.05;

/** Coedges between progress reports. */
export const PROGRESS_EVERY = 200;

/**
 * `tracer`: what traces a bare coedge's curve where the grid can't bound it (trace.ts; its stub by default);
 * `progress`: told where the pass is, every PROGRESS_EVERY coedges and at each step after; `fitTolerance` what a
 * p-curve for a bare use is fitted within where that's tighter than its edge's tolerance (HealOptions'
 * pcurveFitTolerance).
 */
export function healCurves(g: Geometry, d: BrepData, fixes: ReadonlySet<HealFix>, edit: ModelEdit,
  diagnostics: Diagnostic[], tracer: Tracer = stubTracer(g), progress: (what: string) => void = () => {},
  fitTolerance: number = PCURVE_FIT_TOLERANCE, tight: ReadonlyMap<number, number> = new Map()): CurvesRecord {
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
  // pcurveMissingOnElementary's and pcurveMissingOnFreeForm's p-curves made, and the uses left without (by why).
  const made = new Map<HealFix, { t: Tally; worst: number }>(), notMade = new Map<HealFix, Map<string, Tally>>();
  // (Kept off their edges' curves by at most smallLimit both ways: an info apart from the warning.)
  const notReplaced = new Map<string, Tally>(), notReplacedSmall = new Map<string, Tally>();
  const small = smallLimit(tol.part);
  const madeOnPlane = new Tally(), notMadeOnPlane = new Map<string, Tally>();
  let worstOnPlane = 0;
  const add = (m: Map<string, Tally>, why: string, c: number) =>
    (m.get(why) ?? m.set(why, new Tally()).get(why)!).add(coedgeName(c));
  // Per fix that wrote a p-curve: those put on their surface's domain, and how far.
  const onDomain = new Map<HealFix, { t: Tally; past: number; moved: number }>();
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
    // The fix that makes the face's bare uses a p-curve: by its surface's kind.
    const missing: HealFix = onPlane ? 'pcurveMissingOnPlane' : closedForm ? 'pcurveMissingOnElementary'
      : 'pcurveMissingOnFreeForm';
    // Each coedge's p-curve parameters along its use, where it's one piece, and the face's periods: the face API's,
    // asked only where needed, since the face API's first query on a face projects every coedge of it that has no
    // p-curve (the cost the pcurveMissing fixes' switches are for).
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
    // A p-curve the pass writes, placed on the surface's domain (fix/domain.ts): poles past a side of a direction that
    // isn't periodic on the face clamped, the 3D move that makes (by the surface's first derivatives over the poles'
    // box) added to what its edge needs. The face's periods asked only where a pole is past a side.
    let surfInfo: ReturnType<Geometry['surfaceInfo']> | undefined;
    const placed = (curve: Curve2, c: number, by: HealFix, range: [number, number]):
      { curve: Curve2; moved: number } => {
      surfInfo ??= g.surfaceInfo(surface);
      const u: [number, number] = [surfInfo.u[0], surfInfo.u[1]], v: [number, number] = [surfInfo.v[0], surfInfo.v[1]];
      // Past by rounding is fine: the face API takes an end within 1e-12 of a bound as on it.
      const slack = (r: [number, number]) => 1e-12 * (1 + Math.max(Math.abs(r[0]), Math.abs(r[1])));
      const [ou, ov] = overshoot(curve, u, v, range);
      if (!(ou > slack(u) || ov > slack(v))) return { curve, moved: 0 };
      // The face's periods (a direction closed in fact; none where the face API can't take the face yet, as before
      // healing on a face whose projections fail: the cap below keeps a curve a period off from being moved).
      const [pu, pv] = periodsOf();
      const p = intoDomain(curve, u, v, ou > slack(u) && !(pu > 0) && !(surfInfo.uPeriod > 0),
        ov > slack(v) && !(pv > 0) && !(surfInfo.vPeriod > 0), range);
      if (!(p.du > 0 || p.dv > 0)) return { curve, moved: 0 };
      // How far that moves it on the surface as consumers see it (an evaluation past a side is clamped onto it):
      // the surface at the new p-curve against at the old, sampled along the range, as the other measures here are.
      const uv: number[] = [];
      for (const cv of [curve, p.curve]) {
        for (let i = 0; i < PLACE_SAMPLES; i++) {
          const q = evalCurve2(cv, range[0] + (range[1] - range[0]) * i / (PLACE_SAMPLES - 1));
          if (!q) return { curve, moved: 0 };
          uv.push(q[0], q[1]);
        }
      }
      const S = g.evalSurface(surface, uv, 0).values;
      let moved = 0;
      for (let i = 0; i < PLACE_SAMPLES; i++) {
        const a = 3 * i, b = 3 * (i + PLACE_SAMPLES);
        moved = Math.max(moved, Math.hypot(S[b]! - S[a]!, S[b + 1]! - S[a + 1]!, S[b + 2]! - S[a + 2]!));
      }
      // A hair past, not a curve elsewhere: within PLACE_AT_MOST of its edge's tolerance.
      if (!(moved <= PLACE_AT_MOST * tol.edge(d.coedge.edge[c]!))) return { curve, moved: 0 };
      const o = onDomain.get(by) ?? onDomain.set(by, { t: new Tally(), past: 0, moved: 0 }).get(by)!;
      o.t.add(coedgeName(c)), o.past = Math.max(o.past, p.du, p.dv), o.moved = Math.max(o.moved, moved);
      return { curve: p.curve, moved };
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
        // past it). `traceable` false: a projection already tried and failed (a pcurveMissing fix's).
        const bare = (traceable = true) => {
          if (!fixes.has('edgeTolerance')) return;
          const tolE = tol.edge(e), curve = d.edge.curve[e]!;
          // First the face API's own projection of the use (made at the edge's tolerance when the face is first
          // asked, and kept): where it finds the curve within the tolerance, the edge needs nothing and the use stays
          // bare, as imported (the healed model stores a p-curve only where healing changes the edge: grown, or the
          // mesher's own projection failing; the pcurveMissing fixes make them all), without the grid or a trace (on
          // a large surface the grid is too coarse to bound a correct curve, and every such use was traced: LMP1's).
          // Not on a closed-form surface, measured exactly. Where that projection measured the curve farther than the
          // tolerance from the surface, the grid's bound (an upper bound on the distance) can't be within it: traced
          // without the grid (building a fine one over a large surface is most of the bound's cost).
          if (!closedForm && traceable) {
            const p = g.projectCoedge(c);
            const within = withinAsProjected(p, tolE);
            if (within !== undefined) return needs(e, within);
            if ('offSurface' in p && p.offSurface > tolE) return needs(e, traced(tolE));
          }
          needs(e, curveOffSurface(g, curve, range, surface, tolE, grids,
            closedForm || !traceable ? undefined : () => traced(tolE)));
        };
        /** The curve's distance from the surface by the face API's projection, where that's within tolE; else none. */
        const withinAsProjected = (p: ReturnType<Geometry['projectCoedge']>, tolE: number): number | undefined => {
          // (Its fit's error within the edge's tolerance as the pass judges it, which covers the curve's distance from
          // the surface: the face API projects at its own edge tolerance, the same today, so this only guards them
          // drifting apart.)
          return 'pieces' in p && p.status === 'ok' && p.error <= tolE ? p.offSurface : undefined;
        };
        const traced = (tolE: number) => {
          const fine = Math.min(tolE, fitTolerance);
          let tr = tracer.trace(c, fine), at = fine;
          if (fine < tolE && (tr.status !== 'ok' || 'why' in tr.fit || !tr.fit.within)) {
            tr = tracer.trace(c, tolE), at = tolE;
          }
          return keepTrace(tr, at, tolE);
        };
        // A trace's outcome recorded, its p-curve kept where its fit is within: the need it measures.
        const keepTrace = (tr: Trace, at: number, tolE: number) => {
          record.traces.push({ coedge: c, status: TRACE_STATUS[tr.status], tol: at, offSurface: tr.offSurface,
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
          const pl = placed(made, c, 'edgeTolerance', range);
          edit.set('coedge', 'pcurve', c, edit.addCurve2(pl.curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = fit.error + pl.moved;
          const need = Math.max(fit.error + pl.moved, Number.isNaN(tr.offSurface) ? 0 : tr.offSurface);
          (need > tolE ? tracedGrown : tracedAtTol).add(coedgeName(c));
          worstTraced = Math.max(worstTraced, need);
          return need;
        };
        // (pcurveTight's faces' bare uses made p-curves as the pcurveMissing fixes make them, within its fit.)
        const tightFit = fixes.has(missing) ? undefined : tight.get(f), by: HealFix = tightFit === undefined ? missing
          : 'pcurveTight';
        if (pc < 0 && !fixes.has(missing) && tightFit === undefined) {
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
        if (pc < 0 && onPlane) {
          // pcurveMissingOnPlane: the curve's image by the plane's map, exact (the face API's projection on a plane:
          // the image in the model's form where it has one, else the map, which fix/plane.ts applies; its error the
          // curve's distance from the plane), in the edge's parameter.
          const p = g.projectCoedge(c), q = 'pieces' in p && USABLE_ON_PLANE.has(p.status) && p.pieces.length === 1
            ? p.pieces[0]! : undefined;
          const own = q?.kind ? projected(g, c, p) : undefined;
          const image = own && !('why' in own) ? onRange(own.curve, own.range) ?? { why: 'on another range' }
            : q ? planeImage(d, d.edge.curve[e]!, q.affine) : { why: 'not made' };
          if ('why' in image) {
            add(notMadeOnPlane, image.why, c);
            bare(false);
            continue;
          }
          const error = (p as { error: number }).error;
          edit.set('coedge', 'pcurve', c, edit.addCurve2(image));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = error;
          needs(e, error);
          worstOnPlane = Math.max(worstOnPlane, error);
          madeOnPlane.add(coedgeName(c));
          continue;
        }
        if (pc < 0) {
          // Fitted as a trace is, as the mesher projects a use it isn't given (within fitTolerance where that's
          // tighter than the edge's tolerance), else at the edge's (the face API's own projection).
          const tolE = tol.edge(e), fine = Math.min(tolE, fitTolerance, tightFit ?? Infinity);
          let p = fine < tolE ? projected(g, c, g.projectCoedge(c, fine)) : undefined;
          if (!p || 'why' in p) p = projected(g, c);
          const curve = 'why' in p ? undefined : onRange(p.curve, p.range);
          if (!curve) {
            add(notMade.get(by) ?? notMade.set(by, new Map()).get(by)!, 'why' in p ? p.why
              : 'on another range', c);
            bare(false);
            continue;
          }
          const pl = placed(curve, c, by, range), error = p.error + pl.moved;
          edit.set('coedge', 'pcurve', c, edit.addCurve2(pl.curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = error;
          needs(e, error);
          const t = made.get(by) ?? made.set(by, { t: new Tally(), worst: 0 }).get(by)!;
          t.worst = Math.max(t.worst, error);
          t.t.add(coedgeName(c));
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
            const pl = placed(curve, c, 'pcurveReparam', range);
            edit.set('coedge', 'pcurve', c, edit.addCurve2(pl.curve));
            newRange();
            record.pcurveFrom[c] = PROVENANCE.healed;
            reparam.add(coedgeName(c));
            needs(e, m.deviation + pl.moved);
            continue;
          }
          reparamKind.add(coedgeName(c));
          // Not representable in the curve's parameter: off for consumers that take it as the curve's.
          off = true;
        }
        if (!off || !fixes.has('pcurveReplace')) {
          // A source's p-curve in the curve's parameter whose ends (or poles) lie past a side of the domain, by its
          // rounding or more: placed on the domain (pcurveEnds'), so the face API and consumers can evaluate its ends.
          if (m.kind === 'same' && fixes.has('pcurveEnds')) {
            const own: Curve2 = { kind: d.curve.kind[pc]!, reals: d.pool.curveReal.subarray(d.curve.real[pc]!),
              ints: d.pool.curveInt.subarray(d.curve.int[pc]!) };
            const pl = placed(own, c, 'pcurveEnds', range);
            if (pl.moved > 0) {
              edit.set('coedge', 'pcurve', c, edit.addCurve2(pl.curve));
              record.pcurveFrom[c] = PROVENANCE.healed;
              record.deviation[c] = kept + pl.moved;
              needs(e, kept + pl.moved);
            }
          }
          keep();
          continue;
        }
        const given = m.kind === 'off' ? Math.max(m.deviation, Number.isNaN(m.ends) ? 0 : m.ends) : Infinity;
        const r = replacement(g, c, onPlane, given);
        // Where it's kept: an info within smallLimit, else a warning.
        const keptBy = given <= small ? notReplacedSmall : notReplaced;
        if (r.kind === 'none') {
          add(keptBy, r.why, c);
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
            add(keptBy, 'on another range', c);
            keep();
            continue;
          }
          const pl = placed(curve, c, 'pcurveReplace', range);
          edit.set('coedge', 'pcurve', c, edit.addCurve2(pl.curve));
          newRange();
          record.pcurveFrom[c] = PROVENANCE.healed;
          record.deviation[c] = r.error + pl.moved;
          replaced.add(coedgeName(c));
          needs(e, r.error + pl.moved);
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
  // The tolerances grown, edges' and vertices', in the part's diagnostics (growth.ts's rule for their severities).
  const growth = new Growth(tol.size, tol.part);
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
  diagnostics.push(...growth.diagnostics());
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
  for (const [fix, { t, worst }] of made) {
    diagnostics.push({ severity: 'warning', message: `${fix}: ${t.n} p-curves made by projecting their edges' `
      + `curves (off by up to ${worst.toPrecision(3)} mm): ${t.ex.join(', ')}${t.more()}` });
  }
  for (const [fix, why, t] of [...notMade].flatMap(([fix, m]) => [...m].map(([w, t]) => [fix, w, t] as const))) {
    diagnostics.push({ severity: 'warning', message: `${fix}: ${t.n} coedges left without a p-curve (the `
      + `projection ${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  if (madeOnPlane.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveMissingOnPlane: ${madeOnPlane.n} p-curves made on planes, `
      + `their edges' curves' images by the planes' maps (the curves off their planes by up to `
      + `${worstOnPlane.toPrecision(3)} mm): ${madeOnPlane.ex.join(', ')}${madeOnPlane.more()}` });
  }
  for (const [why, t] of notMadeOnPlane) {
    diagnostics.push({ severity: 'warning', message: `pcurveMissingOnPlane: ${t.n} coedges on planes left without a `
      + `p-curve (${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  if (reparam.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${reparam.n} p-curves given their edges' `
      + `curves' parameter (theirs an affine function of it): ${reparam.ex.join(', ')}${reparam.more()}` });
  }
  if (toRange.n) {
    diagnostics.push({ severity: 'warning', message: `pcurveReparam: ${toRange.n} p-curves' edges' ranges put on their `
      + `domains (past them by rounding): ${toRange.ex.join(', ')}${toRange.more()}` });
  }
  for (const [by, o] of onDomain) {
    diagnostics.push({ severity: 'warning', message: `${by}: ${o.t.n} of its p-curves put on their surfaces' `
      + `domains (poles past a side by up to ${o.past.toPrecision(3)} in (u, v), moving them up to `
      + `${o.moved.toPrecision(3)} mm, which their edges' tolerances cover): ${o.t.ex.join(', ')}${o.t.more()}` });
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
  for (const [why, t] of notReplacedSmall) {
    diagnostics.push({ severity: 'info', message: `pcurveReplace: ${t.n} p-curves off their edges' curves by at most `
      + `${small.toPrecision(3)} mm kept (the projection ${why}): ${t.ex.join(', ')}${t.more()}` });
  }
  return record;
}
