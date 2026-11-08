// Faces' outlines from the B-rep model, whatever format it came from: where a face fails to mesh, or a whole part
// does, a viewer can still show where its faces are. Each face's edges (once each per face) as polylines along their
// 3D curves from start to end (`edgeParams`); circles and ellipses stepped by the deflections, other curves subdivided
// until each segment's midpoint is within the linear deflection; an edge without a 3D curve along its p-curve on the
// face's surface where both evaluate, else straight between its vertices; a poly loop's polygon. Approximate: for
// finding a face, not meshing it. The shape of Brep.outline in cad-scene.

import { type BrepData, rowCount } from './data.ts';
import { curve as decodeCurve } from './decode.ts';
import { curveEvaluator, type CurveEvaluator, edgeParams, surfaceEvaluator, type SurfaceEvaluator,
  type Vec } from './geometry.ts';
import { LOOP_KIND } from './layout.ts';

export interface OutlineOptions {
  /** Maximum distance between a polyline and its curve, in the part's units. */
  linearDeflection: number;
  /** Maximum angle a segment turns through on a circle or ellipse, radians. */
  angularDeflection: number;
}

export interface FaceOutlines {
  /** Every face's id (its row where it has none), in row order. */
  faces: number[];
  /** Polylines, minus the origin, all concatenated. */
  positions: Float32Array;
  /** One per edge of a face (or poly loop): the face's id, and its points in `positions`. */
  outlines: { source: number; start: number; count: number }[];
}

/** At most this many points a curve. */
export const MAX_OUTLINE_POINTS = 512;
/** Subdivision depth for curves other than conics. */
const MAX_DEPTH = 12;

const dist = (a: Vec, b: Vec) => Math.hypot(...a.map((x, i) => x - b[i]!));

/** Points along `at` from t0 to t1, by the deflections. */
function sample(at: (t: number) => Vec, t0: number, t1: number, conicRadius: number | undefined,
  o: OutlineOptions): Vec[] {
  if (conicRadius !== undefined) {
    const d = Math.min(o.linearDeflection, conicRadius);
    const step = Math.min(o.angularDeflection, d > 0 ? 2 * Math.acos(1 - d / conicRadius) : o.angularDeflection);
    const n = Math.min(MAX_OUTLINE_POINTS - 1, Math.max(1, Math.ceil(Math.abs(t1 - t0) / step)));
    return Array.from({ length: n + 1 }, (_, k) => at(t0 + (t1 - t0) * k / n));
  }
  // Eight pieces, each halved while its midpoint is off the chord by more than the deflection.
  const out: Vec[] = [at(t0)];
  const go = (a: number, pa: Vec, b: number, pb: Vec, depth: number) => {
    const m = (a + b) / 2, pm = at(m);
    const chord = pa.map((x, i) => (x + pb[i]!) / 2);
    if (depth < MAX_DEPTH && out.length < MAX_OUTLINE_POINTS - 2 && dist(pm, chord) > o.linearDeflection) {
      go(a, pa, m, pm, depth + 1);
      go(m, pm, b, pb, depth + 1);
    } else out.push(pb);
  };
  let prev = out[0]!;
  for (let k = 1; k <= 8; k++) {
    const t = t0 + (t1 - t0) * k / 8, p = at(t);
    go(t0 + (t1 - t0) * (k - 1) / 8, prev, t, p, 0);
    prev = p;
  }
  return out;
}

/**
 * How a curve is sampled (a trimmed curve as its basis): a line by its ends, a polyline by its corners, a circle or
 * ellipse by steps for its largest radius, anything else by subdivision.
 */
function sampling(d: BrepData, c: number): { kind: 'line' | 'polyline' | 'other' } | { kind: 'conic'; radius: number } {
  const x = decodeCurve(d, c);
  if (x.kind === 'trimmed') return sampling(d, x.basis);
  if (x.kind === 'line' || x.kind === 'polyline') return { kind: x.kind };
  if (x.kind === 'circle') return { kind: 'conic', radius: x.radius };
  if (x.kind === 'ellipse') return { kind: 'conic', radius: Math.max(x.semiAxis1, x.semiAxis2) };
  return { kind: 'other' };
}

/** The outlines of the faces whose ids `only` holds (all if absent), in the part's coordinates minus `origin`. */
export function faceOutlines(d: BrepData, origin: Vec, o: OutlineOptions, only?: ReadonlySet<number>):
  FaceOutlines {
  const curves = new Map<number, CurveEvaluator | undefined>();
  const surfaces = new Map<number, SurfaceEvaluator | undefined>();
  const flat: number[] = [], outlines: FaceOutlines['outlines'] = [], faces: number[] = [];
  const push = (source: number, pts: Vec[]) => {
    if (pts.length < 2) return;
    outlines.push({ source, start: flat.length / 3, count: pts.length });
    for (const q of pts) flat.push(q[0]! - origin[0]!, q[1]! - origin[1]!, q[2]! - origin[2]!);
  };
  const vertex = (v: number) => Array.from(d.vertex.point.subarray(3 * v, 3 * v + 3));
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const id = Number.isNaN(d.face.id[f]!) ? f : d.face.id[f]!;
    faces.push(id);
    if (only && !only.has(id)) continue;
    const seen = new Set<number>();
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] === LOOP_KIND.poly) {
        const pts = Array.from({ length: d.loop.count[l]! }, (_, k) =>
          Array.from(d.pool.loopReal.subarray(d.loop.first[l]! + 3 * k, d.loop.first[l]! + 3 * k + 3)));
        push(id, [...pts, pts[0]!]);
        continue;
      }
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let k = d.loop.first[l]!; k < d.loop.first[l]! + d.loop.count[l]!; k++) {
        const e = d.coedge.edge[k]!;
        if (seen.has(e)) continue;
        seen.add(e);
        const c = d.edge.curve[e]!, s = d.edge.start[e]!, t = d.edge.end[e]!;
        const ev = c >= 0 ? curveEvaluator(d, c, curves) : undefined;
        const r = ev && edgeParams(d, e, ev);
        if (ev && r && r.every(Number.isFinite)) {
          const how = sampling(d, c);
          let pts: Vec[];
          if (how.kind === 'line') pts = [ev.point(r[0]), ev.point(r[1])];
          else if (how.kind === 'polyline') {
            // Its corners at whole parameters between the ends, in the edge's direction.
            const [a, b] = r, step = a <= b ? 1 : -1;
            pts = [ev.point(a)];
            for (let k = step > 0 ? Math.floor(a) + 1 : Math.ceil(a) - 1; step > 0 ? k < b : k > b; k += step) {
              pts.push(ev.point(k));
            }
            pts.push(ev.point(b));
          } else pts = sample(ev.point, r[0], r[1], how.kind === 'conic' ? how.radius : undefined, o);
          // The vertices themselves at the ends, where there are some.
          if (s >= 0) pts[0] = vertex(s);
          if (t >= 0) pts[pts.length - 1] = vertex(t);
          push(id, pts);
          continue;
        }
        const p = d.coedge.pcurve[k]!, pe = p >= 0 ? curveEvaluator(d, p, curves) : undefined;
        const se = pe ? surfaceEvaluator(d, d.face.surface[f]!, surfaces, curves) : undefined;
        if (pe && se && pe.range.every(Number.isFinite)) {
          const at = (x: number) => { const uv = pe.point(x); return se.point(uv[0]!, uv[1]!); };
          push(id, sample(at, pe.range[0], pe.range[1], undefined, o));
        } else if (s >= 0 && t >= 0 && s !== t) push(id, [vertex(s), vertex(t)]);
      }
    }
  }
  return { faces, positions: Float32Array.from(flat), outlines };
}
