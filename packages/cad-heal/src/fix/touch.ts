// vertexOnEdge: two loops of one face that meet at a point, to rounding, without sharing a vertex there: a vertex of
// one lies on another's edge (ec_turbine-A #384: a hole's vertex 6e-16 mm from the outer circle, mid-span), or two
// vertex rows of different loops sit at one point (OCC8228 #75991: #75996 and #76273, 0 apart). A mesher reads such a
// face's boundary as crossing itself there, where it touches: with one vertex at the point (a pinch) it reads a touch.
// The edge is split at the vertex's foot (the vertex then the pieces' shared end, Topo.split's p-curve rules), and the
// coincident vertices are merged into one (the first loop's, its tolerance grown to reach the other's). Only where
// the loops meet to rounding (within TOUCH x the tolerance): loops near each other but apart by more than that read as
// apart and mesh (LMP1's, VW's, ohmm's and bug24383's holes, 0.0067 to 1 x their tolerance from another loop), and a
// vertex merged or an edge split there moves topology by up to the tolerance for nothing. The face API's
// self-intersection is per loop and doesn't see two loops meeting, so this is its own gate.
//
// Topology changes (an edge split adds rows, a merge drops a vertex): the result carries each row's given row, as
// coincidentEdges' does.

import { type BrepData, LOOP_KIND, rowCount } from 'cad-brep';
import { Geometry, type GeomModule } from 'cad-geom';
import { tolerances } from '../measure.ts';
import { type CoincidentResult, nearestOn, type Params, pcurveRange, Topo } from './coincident.ts';

/** Loops meet where they're within this fraction of the tolerance: rounding, not geometry. */
export const TOUCH = 1e-6;
/** The most touches one part takes (each rebuilds the model). */
export const MAX_TOUCHES = 200;

/** One touch mended, as said in the diagnostic (ids). */
export interface Touched {
  /** 'split': `vertex` lay on edge `other`, now split there; 'merged': vertex `other` merged into `vertex`. */
  kind: 'split' | 'merged';
  face: number;
  vertex: number;
  other: number;
  /** The distance mended (mm). */
  gap: number;
}

export type TouchResult = Pick<CoincidentResult, 'model' | 'pcurvesDropped' | 'vertexFrom' | 'edgeFrom' | 'coedgeFrom'
  | 'faceFrom'> & { touched: Touched[] };

/** Each row's given row (-1: made by a fix), with the model they're rows of. */
export type RowsFrom = Pick<CoincidentResult, 'model' | 'vertexFrom' | 'edgeFrom' | 'coedgeFrom' | 'faceFrom'>;

/** The rows of `then` (a fix run on `first`'s model) each mapped to `first`'s given row; either alone where the other
 * is undefined. */
export function rowsFrom(first: RowsFrom | undefined, then: RowsFrom | undefined): RowsFrom | undefined {
  if (!first || !then) return then ?? first;
  const of = (now: Int32Array, before: Int32Array) => now.map((r) => r < 0 ? -1 : before[r]!);
  return { model: then.model, vertexFrom: of(then.vertexFrom, first.vertexFrom),
    edgeFrom: of(then.edgeFrom, first.edgeFrom), coedgeFrom: of(then.coedgeFrom, first.coedgeFrom),
    faceFrom: of(then.faceFrom, first.faceFrom) };
}

const sub = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);

/** A face's edge loops: each one's vertices and edges (rows). */
function loopsOf(d: BrepData, f: number): { vs: Set<number>; es: number[] }[] {
  const out: { vs: Set<number>; es: number[] }[] = [];
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
    const vs = new Set<number>(), es: number[] = [];
    for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
      const e = d.coedge.edge[c]!;
      es.push(e);
      if (d.edge.start[e]! >= 0) vs.add(d.edge.start[e]!);
      if (d.edge.end[e]! >= 0) vs.add(d.edge.end[e]!);
    }
    out.push({ vs, es });
  }
  return out;
}

type Hit = { kind: 'merged'; f: number; u: number; w: number; gap: number }
  | { kind: 'split'; f: number; u: number; e: number; t: number; range: [number, number]; gap: number; tol: number };

/** The first touch in d (rows), merges before splits per face, or undefined. */
function firstTouch(g: Geometry, d: BrepData, params: Params): Hit | undefined {
  const tol = tolerances(d);
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    if (d.face.loopCount[f]! < 2) continue;
    const loops = loopsOf(d, f);
    if (loops.length < 2) continue;
    // Two vertex rows of different loops at one point (neither in the other's loop, no edge joining them).
    for (let i = 0; i < loops.length; i++) for (let j = i + 1; j < loops.length; j++) {
      for (const u of loops[i]!.vs) for (const w of loops[j]!.vs) {
        if (u === w || loops[i]!.vs.has(w) || loops[j]!.vs.has(u)) continue;
        const gap = sub(d.vertex.point, 3 * u, d.vertex.point, 3 * w);
        if (gap > TOUCH * Math.max(tol.vertex(u), tol.vertex(w))) continue;
        let joined = false;
        for (let e = 0; e < rowCount(d, 'edge') && !joined; e++) {
          const s = d.edge.start[e]!, x = d.edge.end[e]!;
          joined = s === u && x === w || s === w && x === u;
        }
        if (!joined) return { kind: 'merged', f, u, w, gap };
      }
    }
    // A vertex of one loop on an edge of another, away from the edge's ends: one inversion per edge.
    for (let j = 0; j < loops.length; j++) {
      const others = new Set<number>();
      for (let i = 0; i < loops.length; i++) if (i !== j) for (const u of loops[i]!.vs) others.add(u);
      for (const u of loops[j]!.vs) others.delete(u);
      if (!others.size) continue;
      for (const e of new Set(loops[j]!.es)) {
        const cv = d.edge.curve[e]!, r = params(e);
        if (cv < 0 || !r) continue;
        const lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]);
        // Only the vertices in the curve's box (one that certainly holds it), grown by the gate: a face with many
        // holes otherwise inverts every hole's vertices on every other hole's edges.
        const bx = g.curveBound(cv, [lo, hi]);
        const box = bx.status === 'ok' && bx.statuses[0] === 0 ? bx.boxes : undefined;
        const us = [...others].filter((u) => {
          if (u === d.edge.start[e] || u === d.edge.end[e]) return false;
          if (!box) return true;
          const grow = TOUCH * Math.max(tol.edge(e), tol.vertex(u));
          for (let a = 0; a < 3; a++) {
            const p = d.vertex.point[3 * u + a]!;
            if (!(p >= box[2 * a]! - grow && p <= box[2 * a + 1]! + grow)) return false;
          }
          return true;
        });
        if (!us.length) continue;
        const pts = us.flatMap((u) => [d.vertex.point[3 * u]!, d.vertex.point[3 * u + 1]!, d.vertex.point[3 * u + 2]!]);
        const x = g.invertCurve(cv, pts, lo, hi, TOUCH * tol.part);
        if (x.status !== 'ok') continue;
        for (let k = 0; k < us.length; k++) {
          const u = us[k]!, near = Math.max(tol.edge(e), tol.vertex(u)), t = x.params[k]!, gap = x.distance[k]!;
          if (x.statuses[k] !== 0 || !(gap <= TOUCH * near) || !(t > lo && t < hi)) continue;
          // (Near an end it's that vertex's to merge, not this edge's to split.)
          const s = d.edge.start[e]!, en = d.edge.end[e]!;
          if (s >= 0 && sub(x.foot, 3 * k, d.vertex.point, 3 * s) <= near) continue;
          if (en >= 0 && sub(x.foot, 3 * k, d.vertex.point, 3 * en) <= near) continue;
          return { kind: 'split', f, u, e, t, range: r, gap, tol: near };
        }
      }
    }
  }
  return undefined;
}

/**
 * vertexOnEdge on a model: every touch mended (one at a time, the model written again after each), or undefined
 * where there's none. `ranges` the given model's edges' parameters at start and end where known (NaN: not known).
 */
export function mendTouches(module: GeomModule, given: BrepData, ranges?: Float64Array): TouchResult | undefined {
  let d = given, dropped = 0;
  const touched: Touched[] = [];
  let maps: RowsFrom | undefined;
  const known = new Map<number, [number, number] | undefined>();
  for (let round = 0; round < MAX_TOUCHES; round++) {
    const g = new Geometry(module, new Uint8Array(d.buffer));
    let w: ReturnType<Topo['write']> | undefined;
    try {
      const params: Params = (e) => {
        const r0 = d.edge.range[2 * e]!, r1 = d.edge.range[2 * e + 1]!;
        if (Number.isFinite(r0) && Number.isFinite(r1)) return r0 !== r1 ? [r0, r1] : undefined;
        const from = maps ? maps.edgeFrom[e]! : e;
        const k0 = ranges?.[2 * from], k1 = ranges?.[2 * from + 1];
        if (from >= 0 && Number.isFinite(k0) && Number.isFinite(k1)) return k0 !== k1 ? [k0!, k1!] : undefined;
        if (from >= 0 && known.has(from)) return known.get(from);
        const r = g.edgeParams(e);
        const out: [number, number] | undefined = r.status === 'ok' && Number.isFinite(r.t0) && Number.isFinite(r.t1)
          && r.t0 !== r.t1 ? [r.t0, r.t1] : undefined;
        if (from >= 0) known.set(from, out);
        return out;
      };
      const hit = firstTouch(g, d, params);
      if (!hit) break;
      const t = new Topo(d), tol = tolerances(d);
      const has = (v: number) => Number.isFinite(t.v[v]!.tol) ? t.v[v]!.tol : tol.part;
      if (hit.kind === 'merged') {
        // Every use of w made u's; u's tolerance to reach w's points.
        const { u, w: x } = hit;
        for (const e of t.e) {
          if (e.start === x) e.start = u;
          if (e.end === x) e.end = u;
        }
        for (const l of t.l) if (l.kind !== LOOP_KIND.edge && l.vertex === x) l.vertex = u;
        const need = hit.gap + tol.vertex(x);
        if (need > has(u)) t.v[u]!.tol = need;
        touched.push({ kind: 'merged', face: d.face.id[hit.f]!, vertex: d.vertex.id[u]!, other: d.vertex.id[x]!,
          gap: hit.gap });
      } else {
        const { u, e, t: at, range: [t0, t1] } = hit;
        const r = t.split(e, t0, t1, at, u, nearestOn(g, t, d.edge.curve[e]!, at, hit.tol),
          (c) => pcurveRange(g, d, params, c));
        dropped += r.dropped;
        if (hit.gap > has(u)) t.v[u]!.tol = hit.gap;
        touched.push({ kind: 'split', face: d.face.id[hit.f]!, vertex: d.vertex.id[u]!,
          other: d.edge.id[e] || given.edge.id[maps ? maps.edgeFrom[e]! : e] || 0, gap: hit.gap });
      }
      w = t.write();
    } finally {
      g.dispose();
    }
    if (!w) break;
    maps = rowsFrom(maps, w);
    d = w.model;
  }
  if (!touched.length) return undefined;
  return { ...maps!, model: d, touched, pcurvesDropped: dropped };
}
