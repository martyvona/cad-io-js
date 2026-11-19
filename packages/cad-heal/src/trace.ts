// Tracing a coedge's edge curve onto its face's surface (docs/own-tessellator.md, edges measured by tracing, once):
// what healing calls, as an interface, so the projection lane's API (cad-geom's project.h: a trace from given end
// feet, its stop with where and why, an end search per vertex and face) can replace the stub here without healing
// changing. Healing keeps the trace's p-curve, fitted once, in the healed model (pcurveFrom healed) and its measures in
// the analysis buffer (the coedge's traceStatus, traceTol, offSurface, stopAt, stopWhy); the end searches are a
// cache within the pass, a stored p-curve's ends giving later consumers the vertex's (u, v).

import { TRACE_STOP } from 'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Curve2 } from './edit.ts';
import { projected } from './fix/replace.ts';

export interface Trace {
  /** Whether it ran to the curve's end, stopped where it couldn't continue, or wasn't made (refused at the start). */
  status: 'ok' | 'stopped' | 'notMade';
  /** The curve's largest distance from the surface along the trace (between its feet too); NaN where not made. */
  offSurface: number;
  /** Where it couldn't continue (the curve's parameter) and why (TRACE_STOP); NaN and none where it didn't stop. */
  stopAt: number;
  stopWhy: number;
  /**
   * The p-curve fitted from it (one curve in the model's form, in the parameter of `range`, the face API's edge
   * range) with its error, |S(p(t)) - C(t)| bounded; or why there's none. `within`: its fit met the tolerance traced
   * at, or missed it only by the curve's own distance from the surface (the edge's tolerance grows to cover that).
   */
  fit: { curve: Curve2; error: number; range: [number, number]; within: boolean } | { why: string };
}

/** A global search's feet of a vertex on a face's surface: the tracer's own record, kept by the pass per pair. */
export type EndSearch = unknown;

export interface Tracer {
  /** The global search for the vertex's feet on the face's surface at tol, once per pair (the pass caches it); a
   * tracer that makes its own needn't have one. */
  endSearch?(vertex: number, face: number, tol: number): EndSearch;
  /** Coedge c's edge curve traced onto its face's surface at tol over its edge's range, from its ends' searches
   * where given (each coedge picking its own foot among them: its seam side, a pole's free coordinate). */
  trace(coedge: number, tol: number, start?: EndSearch, end?: EndSearch): Trace;
}

/**
 * The stub over cad-geom's current calls until the projection lane's lands: a trace is projectCoedge at tol (which
 * makes its own end feet, so it has no endSearch), its fit the projection's one piece. ok and invalidModel (the
 * curve off the surface by more than tol, the fit's error covering that) are a finished trace; noConvergence (a fit
 * short of tol) a finished trace whose fit missed; any other status a trace not made.
 */
export function stubTracer(g: Geometry): Tracer {
  return {
    trace(coedge, tol) {
      const p = g.projectCoedge(coedge, tol);
      if (!('pieces' in p) || !['ok', 'invalidModel', 'noConvergence'].includes(p.status)) {
        return { status: 'notMade', offSurface: NaN, stopAt: NaN, stopWhy: TRACE_STOP.none,
          fit: { why: `projection ${p.status}` } };
      }
      const f = projected(g, coedge, p);
      return { status: 'ok', offSurface: p.offSurface, stopAt: NaN, stopWhy: TRACE_STOP.none,
        fit: 'why' in f ? { why: f.why } : { ...f, within: p.status !== 'noConvergence' } };
    },
  };
}
