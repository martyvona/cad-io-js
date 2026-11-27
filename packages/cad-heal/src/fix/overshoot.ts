// trimOvershoot: two consecutive edges of a loop whose curves cross each other near their shared vertex, within the
// part's uncertainty and within the vertex's tolerance of it, and run on past the crossing to ends of their own apart
// (one of them, where the other ends on it).
// A mesher snapping both ends to the vertex leaves a small loop past the crossing, which it refuses once a
// neighbour's refinement samples the edges finely. Both are trimmed at the crossing: the vertex moves there, both
// edges end there (their ranges), their uses' p-curves with them, and the vertex's tolerance is measured again over
// all its edges' ends and their uses' (it shrinks where the crossing lies nearer them than the vertex did). Only
// where each other edge at the vertex ends within its own tolerance of the crossing, and only in a loop whose boundary
// is in trouble, as coincidentEdges' gate (the face API sees it cross or overlap itself, or the pair crosses in the
// face's (u, v)). No rows change.

import { type BrepData, openBrep, rowCount } from 'cad-brep';
import { Geometry, type GeomModule } from 'cad-geom';
import { tolerances } from '../measure.ts';
import { crossTs, faceOfCoedge, fromVertex, lastCrossing, type Pair, type Params, pcurveRange } from './coincident.ts';
import { GROWTH } from './tolerance.ts';

/** Golden-section steps refining a crossing, and a p-curve's point nearest it. */
const STEPS = 60;
/** The most trims one part takes (each measured on the model the last left). */
export const MAX_TRIMS = 200;

/** One trim, as said in the diagnostic. */
export interface Trimmed {
  /** The vertex moved and the two edges trimmed, by id; the face whose loop had them. */
  vertex: number;
  edges: [number, number];
  face: number;
  /** How far the vertex moved (mm), the lengths (chords) trimmed off each edge, the curves' distance at the
   * crossing. */
  moved: number;
  tails: [number, number];
  distance: number;
  /** The vertex's tolerance before and after. */
  tolBefore: number;
  tolAfter: number;
}

export interface TrimResult {
  /** The trimmed model: the given one's rows, the trimmed edges' ranges, vertices and uses changed. */
  model: BrepData;
  trimmed: Trimmed[];
  /** The edges trimmed (rows). */
  edges: number[];
  /** The trimmed edges' uses whose p-curves were dropped (rows): neither at the edge's parameter nor trimmable. */
  dropped: number[];
  /** The candidates found whether or not their loop was in trouble (for measurements). */
  ungated: number;
}

const sub = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);
const PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Where curves ca over A and cb over B (each from vertex V's end) cross nearest V's end of B, within eps of each other
 * and within tolV of V's point (a local least of B's samples' distance from A's curve, refined): each one's parameter
 * there and their distance; undefined where they don't.
 */
function crossing(g: Geometry, ca: number, A: [number, number], cb: number, B: [number, number], V: ArrayLike<number>,
  tolV: number, eps: number): { tA: number; tB: number; distance: number } | undefined {
  const [alo, ahi] = [Math.min(A[0], A[1]), Math.max(A[0], A[1])];
  const off = (ts: number[]) => {
    const q = g.evalCurve(cb, ts, 0);
    if (q.status !== 'ok' || q.statuses.some((s) => s !== 0)) return undefined;
    const x = g.invertCurve(ca, q.values, alo, ahi, eps / 100);
    if (x.status !== 'ok') return undefined;
    return { d: Array.from(x.distance, (v) => Number.isFinite(v) ? v : Infinity), foot: x.params, at: q.values };
  };
  const ts = crossTs(B[0], B[1]), o = off(ts);
  if (!o) return undefined;
  // Each local least of the samples near V (within its tolerance and the samples' spacing there) refined, from V's
  // end out: the first within eps and within tolV of V.
  for (let k = 1; k + 1 < ts.length; k++) {
    if (!(o.d[k]! <= o.d[k - 1]! && o.d[k]! <= o.d[k + 1]!)) continue;
    const step = Math.max(sub(o.at, 3 * k, o.at, 3 * k - 3), sub(o.at, 3 * k, o.at, 3 * k + 3));
    if (sub(o.at, 3 * k, V, 0) > tolV + step) continue;
    let lo = ts[k - 1]!, hi = ts[k + 1]!, ok = true;
    for (let i = 0; i < STEPS && ok; i++) {
      const a = hi - PHI * (hi - lo), b = lo + PHI * (hi - lo), x = off([a, b]);
      if (!x) ok = false;
      else if (x.d[0]! <= x.d[1]!) hi = b;
      else lo = a;
    }
    const tB = (lo + hi) / 2, x = ok ? off([tB]) : undefined;
    if (x && x.d[0]! <= eps && sub(x.at, 0, V, 0) <= tolV) return { tA: x.foot[0]!, tB, distance: x.d[0]! };
  }
  return undefined;
}

/** The point of use c's p-curve at its parameter s, on face f; undefined where the face API can't say. */
function imageAt(g: Geometry, d: BrepData, c: number, f: number, s: number): ArrayLike<number> | undefined {
  const uv = g.evalCurve(d.coedge.pcurve[c]!, [s], 0);
  if (uv.status !== 'ok' || uv.statuses[0]) return undefined;
  const S = g.faceEval(f, [uv.values[0]!, uv.values[1]!], 0);
  return S.status !== 'ok' || S.statuses[0] ? undefined : S.values;
}

/**
 * For a use c of edge e with a p-curve on face f, e's range E trimmed to E2 at its end `atStart` or not: the
 * p-curve's parameters at the edge's new start and end (in that order): E2 where it runs at the edge's parameter, else
 * its own with the moved end at its point nearest X on the face. Undefined where neither.
 */
function trimmedRange(g: Geometry, d: BrepData, params: Params, c: number, f: number, E: [number, number],
  E2: [number, number], atStart: boolean, X: ArrayLike<number>): [number, number] | undefined {
  const R = pcurveRange(g, d, params, c);
  if (!R) return undefined;
  const span = Math.abs(E[1] - E[0]);
  if (Math.abs(R[0] - E[0]) <= 1e-9 * span && Math.abs(R[1] - E[1]) <= 1e-9 * span) return E2;
  let lo = atStart ? R[0] : R[1], hi = atStart ? R[1] : R[0];
  for (let i = 0; i < STEPS; i++) {
    const a = hi - PHI * (hi - lo), b = lo + PHI * (hi - lo), pa = imageAt(g, d, c, f, a), pb = imageAt(g, d, c, f, b);
    if (!pa || !pb) return undefined;
    if (sub(pa, 0, X, 0) <= sub(pb, 0, X, 0)) hi = b;
    else lo = a;
  }
  const at = (lo + hi) / 2;
  return atStart ? [at, R[1]] : [R[0], at];
}

/** One trim of d where there's one (the first found in a loop in trouble), on a copy; else undefined. */
function trimOne(module: GeomModule, d: BrepData, params: (g: Geometry) => Params, done: Set<number>,
  ungated: Set<string>): { model: BrepData; trimmed: Trimmed; edges: number[]; dropped: number[] } | undefined {
  const tol = tolerances(d), g = new Geometry(module, new Uint8Array(d.buffer)), P = params(g);
  try {
    // Each vertex's edges and each edge's uses (rows).
    const atV = new Map<number, number[]>(), usesOf = new Map<number, number[]>();
    for (let e = 0; e < rowCount(d, 'edge'); e++) {
      for (const v of new Set([d.edge.start[e]!, d.edge.end[e]!])) {
        if (v >= 0) (atV.get(v) ?? atV.set(v, []).get(v)!).push(e);
      }
    }
    for (let c = 0; c < rowCount(d, 'coedge'); c++) {
      const e = d.coedge.edge[c]!;
      if (e >= 0) (usesOf.get(e) ?? usesOf.set(e, []).get(e)!).push(c);
    }
    for (let f = 0; f < rowCount(d, 'face'); f++) {
      for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
        const n = d.loop.count[l]!, first = d.loop.first[l]!;
        if (n < 2) continue;
        for (let k = 0; k < n; k++) {
          const a = first + k, b = first + (k + 1) % n, ea = d.coedge.edge[a]!, eb = d.coedge.edge[b]!;
          if (ea < 0 || eb < 0 || ea === eb || d.edge.curve[ea]! < 0 || d.edge.curve[eb]! < 0) continue;
          const v = d.coedge.orientation[a] ? d.edge.start[ea]! : d.edge.end[ea]!;
          if (v < 0 || done.has(v) || d.edge.start[ea] === d.edge.end[ea] || d.edge.start[eb] === d.edge.end[eb]) {
            continue;
          }
          const A = fromVertex(P, d, ea, v), B = fromVertex(P, d, eb, v);
          if (!A || !B) continue;
          const ca = d.edge.curve[ea]!, cb = d.edge.curve[eb]!;
          // (Curves that end together at v don't overshoot each other: a cheap refusal first.)
          const ends = [g.evalCurve(ca, [A[0]], 0), g.evalCurve(cb, [B[0]], 0)];
          if (ends.some((q) => q.status !== 'ok' || q.statuses[0])
            || !(sub(ends[0]!.values, 0, ends[1]!.values, 0) > tol.part)) continue;
          const V = d.vertex.point.subarray(3 * v, 3 * v + 3), tolV = tol.vertex(v);
          const x = crossing(g, ca, A, cb, B, V, tolV, tol.part);
          if (!x) continue;
          // (Each crossing within its curve's range, its vertex's end included: one curve's end on the other, a T,
          // trims the other alone.)
          const inside = (t: number, [t0, t1]: [number, number]) => (t - t0) * (t1 - t) >= 0 && t !== t1;
          if (!inside(x.tA, A) || !inside(x.tB, B)) continue;
          const pa = g.evalCurve(ca, [x.tA, A[0]], 0), pb = g.evalCurve(cb, [x.tB, B[0]], 0);
          if (pa.status !== 'ok' || pb.status !== 'ok' || pa.statuses.some((s) => s) || pb.statuses.some((s) => s)) {
            continue;
          }
          // A tail past the crossing (an end there not already within the uncertainty of it).
          const X = [0, 1, 2].map((i) => (pa.values[i]! + pb.values[i]!) / 2);
          const tails: [number, number] = [sub(pa.values, 3, X, 0), sub(pb.values, 3, X, 0)];
          if (!(tails[0] > tol.part || tails[1] > tol.part)) continue;
          // Every other edge at v ending within its own tolerance of the crossing.
          let need = Math.max(sub(pa.values, 0, X, 0), sub(pb.values, 0, X, 0)), fits = true;
          for (const e of atV.get(v) ?? []) {
            if (e === ea || e === eb) continue;
            const r = fromVertex(P, d, e, v), c = d.edge.curve[e]!;
            let end: ArrayLike<number> = V;
            if (r && c >= 0) {
              const q = g.evalCurve(c, [r[0]], 0);
              if (q.status === 'ok' && !q.statuses[0]) end = q.values;
            }
            const gap = sub(end, 0, X, 0);
            if (gap > tol.edge(e)) fits = false;
            need = Math.max(need, gap);
          }
          if (!fits) continue;
          ungated.add(`${v}:${ea}:${eb}`);
          const self = g.selfIntersectFace(f, l - d.face.firstLoop[f]!);
          const pair: Pair = { f, l, a, b, v };
          const troubled = self.status === 'ok' && (self.crossings > 0 || self.overlaps > 0)
            || lastCrossing(g, P, d, pair, A, B, A[1], B[1]) !== undefined;
          if (!troubled) continue;
          // The trim, on a copy: the two edges' ranges and their uses' p-curves', the vertex to X, its tolerance over
          // every end there (the edges' and their uses' images).
          const m = openBrep(d.buffer.slice(0)), dropped: number[] = [];
          for (const [e, tNew] of [[ea, x.tA], [eb, x.tB]] as const) {
            const E = P(e)!, atStart = d.edge.start[e] === v;
            const E2: [number, number] = atStart ? [tNew, E[1]] : [E[0], tNew];
            for (const c of usesOf.get(e) ?? []) {
              if (d.coedge.pcurve[c]! < 0) continue;
              const fc = faceOfCoedge(d, c), r = fc < 0 ? undefined : trimmedRange(g, d, P, c, fc, E, E2, atStart, X);
              const end = r && imageAt(g, d, c, fc, atStart ? r[0] : r[1]);
              if (r && end) {
                m.coedge.range[2 * c] = r[0], m.coedge.range[2 * c + 1] = r[1];
                need = Math.max(need, sub(end, 0, X, 0));
              } else {
                m.coedge.pcurve[c] = -1, m.coedge.range[2 * c] = NaN, m.coedge.range[2 * c + 1] = NaN;
                dropped.push(c);
              }
            }
            m.edge.range[2 * e] = E2[0], m.edge.range[2 * e + 1] = E2[1];
          }
          for (const e of atV.get(v) ?? []) {
            if (e === ea || e === eb) continue;
            for (const c of usesOf.get(e) ?? []) {
              const fc = faceOfCoedge(d, c), R = fc < 0 || d.coedge.pcurve[c]! < 0 ? undefined
                : pcurveRange(g, d, P, c);
              const end = R && imageAt(g, d, c, fc, d.edge.start[e] === v ? R[0] : R[1]);
              if (end) need = Math.max(need, sub(end, 0, X, 0));
            }
          }
          m.vertex.point[3 * v] = X[0]!, m.vertex.point[3 * v + 1] = X[1]!, m.vertex.point[3 * v + 2] = X[2]!;
          m.vertex.tolerance[v] = GROWTH * need;
          done.add(v);
          return { model: m, edges: [ea, eb], dropped,
            trimmed: { vertex: d.vertex.id[v]!, edges: [d.edge.id[ea]!, d.edge.id[eb]!], face: d.face.id[f]!,
              moved: sub(V, 0, X, 0), tails, distance: x.distance, tolBefore: tolV, tolAfter: GROWTH * need } };
        }
      }
    }
  } finally {
    g.dispose();
  }
  return undefined;
}

/**
 * trimOvershoot on a model (healed by the curves' fixes; `ranges` their edge ranges, by row, NaN where not asked):
 * undefined where nothing's trimmed and nothing found.
 */
export function trimOvershoots(module: GeomModule, given: BrepData, ranges?: Float64Array): TrimResult | undefined {
  let d = given;
  const trimmed: Trimmed[] = [], edges = new Set<number>(), dropped = new Set<number>(), done = new Set<number>();
  const ungated = new Set<string>();
  const params = (g: Geometry): Params => (e) => {
    const r0 = d.edge.range[2 * e]!, r1 = d.edge.range[2 * e + 1]!;
    if (Number.isFinite(r0) && Number.isFinite(r1)) return r0 !== r1 ? [r0, r1] : undefined;
    const k0 = ranges?.[2 * e], k1 = ranges?.[2 * e + 1];
    if (Number.isFinite(k0) && Number.isFinite(k1)) return k0 !== k1 ? [k0!, k1!] : undefined;
    const r = g.edgeParams(e);
    return r.status === 'ok' && Number.isFinite(r.t0) && Number.isFinite(r.t1) && r.t0 !== r.t1 ? [r.t0, r.t1]
      : undefined;
  };
  for (let i = 0; i < MAX_TRIMS; i++) {
    const t = trimOne(module, d, params, done, ungated);
    if (!t) break;
    d = t.model, trimmed.push(t.trimmed);
    for (const e of t.edges) edges.add(e);
    for (const c of t.dropped) dropped.add(c);
  }
  if (!trimmed.length && !ungated.size) return undefined;
  return { model: d, trimmed, edges: [...edges], dropped: [...dropped], ungated: ungated.size };
}
