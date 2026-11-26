// coincidentEdges: two consecutive edges of a loop that leave their shared vertex together and run within their
// tolerance of each other are one edge there, by the tolerance's own meaning, and a loop that runs out along one and
// back along the other has a spike of no width, which crosses itself in (u, v) wherever the two wander across each
// other (LMP1 #1035605: two B-splines leaving their vertex at 0.001 degrees, crossing 6.8 mm on, within the part's
// 0.072 mm for 80 mm; lightarm #91488, a lens of two edges crossing 1 um from its vertex; LMP1 #1085958, a sliver face
// whose two edges lie within 0.003 mm of each other end to end). Each such pair is merged up to where they truly part:
// the first point from the vertex where one is farther than PART x the tolerance from the other, or their last crossing
// in the face's (u, v) within the tolerance if that's farther (merging all of a slowly diverging wedge within the
// tolerance moves its sides by up to the tolerance over its length, which broke faces that meshed). Both edges split
// there at one new vertex (midway between the two split points; the far vertex itself where one edge lies within the
// tolerance whole), the two stretches made one edge on the first one's curve, used by the faces that used either, its
// tolerance grown to its measured distance from their surfaces, and the loop's spike removed (a loop running there and
// back along the merged edge loses both uses, its vertex with them where nothing else uses it). A loop left with no
// coedges is removed, and its face where that was the face's only loop (a sliver within PART x the tolerance end to
// end), and so is a face the merge leaves a lens of two edges within PART x the tolerance of each other. Only in a loop
// whose boundary is in trouble (the face API sees it cross or overlap itself, or one of its pairs crosses in the face's
// (u, v)): elsewhere a merge gains nothing and can break the face or a neighbour. A merge that makes another face using
// either edge cross itself in (u, v) more than before is left (crossesMore). Only pairs that leave their vertex at
// under MAX_ANGLE and stay within the tolerance for over LENGTH times it (at any corner two edges are within the
// tolerance of each other for about the tolerance over the angle's sine, which is no coincidence) and over MIN_LENGTH.
//
// Healing's only fix that changes topology: rows are added, removed and renumbered, so the analysis keeps the source
// model's buffer whole where this fix changed the model (its `source` table), and healing again starts from that. The
// split uses keep their p-curves, cut at the split (at the edge's parameter where the p-curve runs at it, else at the
// p-curve's point nearest the split's, within the tolerance; else they lose them, and the face API projects a bare
// use); the merged edge's uses from the second edge's faces are bare.

import { BODY_KIND, BOUND, type BrepData, ITEM_KIND, LOOP_KIND, ORIENTATION, rowCount, writeBrep } from 'cad-brep';
import { Geometry, type GeomModule } from 'cad-geom';
import { tolerances } from '../measure.ts';

/** The largest angle (radians) between two edges leaving their vertex that this fix considers. */
export const MAX_ANGLE = 0.1;
/** The stretch within the tolerance must be longer than this many times the tolerance. */
export const LENGTH = 10;
/**
 * And longer than this (mm): a mesher can't resolve a shorter stretch at the finest profile (the fine profile's linear
 * deflection is 0.05, and a tenth of it is about as short as a mesher's spans along an edge get: tess-cadio's
 * refinement floor), so a shorter one meshes as one point whatever healing does. Tangent cusps at a tolerance of 1e-5
 * run within it for a few microns (lightarm #3787's 200, all meshing).
 */
export const MIN_LENGTH = 0.005;
/**
 * The stretch merged ends where the two are farther apart than this fraction of the tolerance (or at their last
 * crossing, if that's farther): within the tolerance they're one, but merging all of a slowly diverging wedge moves
 * its sides by up to the tolerance over its length (LMP1 #172490's, 99 mm at 0.13 mm, which tess-cadio then failed).
 */
export const PART = 0.1;
/** Samples along an edge from the vertex, before bisecting to where they part. */
const SAMPLES = 32;
const BISECTIONS = 40;
/** The most merges one part takes (each rebuilds the model; a part needing more is left as the rest leave it). */
export const MAX_MERGES = 200;

type Vec = [number, number, number];

interface V { point: Vec; tol: number; id: number; from: number }
interface E { curve: number; start: number; end: number; sameSense: number; range: [number, number]; tol: number;
  id: number; from: number }
interface C { edge: number; orientation: number; pcurve: number; range: [number, number]; id: number; from: number }
interface L { kind: number; bound: number; coedges: number[]; vertex: number; id: number }
interface F { surface: number; sameSense: number; loops: number[]; tol: number; id: number; from: number }

/** One merge, as said in the diagnostic. */
export interface Merged {
  /** The face whose loop had the spike, and the two edges, by id (a piece of a split edge by the edge's). */
  face: number;
  edges: [number, number];
  /** The stretch's length along the second edge (mm), the largest distance between the stretches, the tolerance. */
  length: number;
  distance: number;
  tolerance: number;
  /** The merged edge's tolerance where it was grown (NaN: not). */
  grown: number;
  /** Whether the two crossed in the face's (u, v) within the stretch. */
  crossed: boolean;
}

export interface CoincidentResult {
  model: BrepData;
  merged: Merged[];
  /** Faces removed (left with no area), by id (0: none). */
  removed: number[];
  /** Split uses whose p-curves were dropped (they didn't run at their edge's parameter). */
  pcurvesDropped: number;
  /** Per row of the result, the given model's row it came from (-1: made by the fix). */
  vertexFrom: Int32Array;
  edgeFrom: Int32Array;
  coedgeFrom: Int32Array;
  faceFrom: Int32Array;
}

const sub = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);

/** The model's topology as lists, edited, then written as a model again. */
class Topo {
  v: V[] = [];
  e: E[] = [];
  c: C[] = [];
  l: L[] = [];
  f: F[] = [];
  /** Per shell, its faces (rows of f). */
  shellFaces: number[][] = [];
  removedFaces = new Set<number>();
  deadEdges = new Set<number>();
  /** The given model's vertices some edge or vertex loop used. */
  usedBefore = new Set<number>();

  readonly d: BrepData;

  constructor(d: BrepData) {
    this.d = d;
    const p = d.vertex.point;
    for (let i = 0; i < rowCount(d, 'vertex'); i++) {
      this.v.push({ point: [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!], tol: d.vertex.tolerance[i]!, id: d.vertex.id[i]!,
        from: i });
    }
    for (let i = 0; i < rowCount(d, 'edge'); i++) {
      this.e.push({ curve: d.edge.curve[i]!, start: d.edge.start[i]!, end: d.edge.end[i]!,
        sameSense: d.edge.sameSense[i]!, range: [d.edge.range[2 * i]!, d.edge.range[2 * i + 1]!],
        tol: d.edge.tolerance[i]!, id: d.edge.id[i]!, from: i });
    }
    for (let i = 0; i < rowCount(d, 'coedge'); i++) {
      this.c.push({ edge: d.coedge.edge[i]!, orientation: d.coedge.orientation[i]!, pcurve: d.coedge.pcurve[i]!,
        range: [d.coedge.range[2 * i]!, d.coedge.range[2 * i + 1]!], id: d.coedge.id[i]!, from: i });
    }
    for (let i = 0; i < rowCount(d, 'loop'); i++) {
      const edge = d.loop.kind[i] === LOOP_KIND.edge, first = d.loop.first[i]!, n = d.loop.count[i]!;
      this.l.push({ kind: d.loop.kind[i]!, bound: d.loop.bound[i]!, id: d.loop.id[i]!, vertex: edge ? -1 : first,
        coedges: edge ? Array.from({ length: n }, (_, k) => first + k) : [] });
    }
    for (let i = 0; i < rowCount(d, 'face'); i++) {
      const first = d.face.firstLoop[i]!;
      this.f.push({ surface: d.face.surface[i]!, sameSense: d.face.sameSense[i]!, tol: d.face.tolerance[i]!,
        id: d.face.id[i]!, from: i, loops: Array.from({ length: d.face.loopCount[i]! }, (_, k) => first + k) });
    }
    for (let s = 0; s < rowCount(d, 'shell'); s++) {
      const first = d.shell.first[s]!;
      this.shellFaces.push(Array.from({ length: d.shell.count[s]! }, (_, k) => d.faceUse.face[first + k]!));
    }
    for (const e of this.e) this.usedBefore.add(e.start), this.usedBefore.add(e.end);
    this.usedBefore.delete(-1);
    for (const l of this.l) if (l.kind !== LOOP_KIND.edge) this.usedBefore.add(l.vertex);
  }

  /** A coedge's start and end vertices as it runs. */
  ends(c: number): [number, number] {
    const x = this.c[c]!, e = this.e[x.edge]!;
    return x.orientation === ORIENTATION.reversed ? [e.end, e.start] : [e.start, e.end];
  }

  /**
   * Edge e split at its curve's parameter t (its parameters from start to end t0, t1) at vertex x: e becomes the
   * piece from its start to x, a new edge the piece from x to its end; every use of e is two uses, in the order it
   * runs. A use's p-curve is cut at the split: at t where it runs at the edge's parameter, else at `pcurveAt`'s
   * parameter for it (the p-curve's nearest to the split point), else dropped. Returns the new edge's row and how many
   * p-curves were dropped.
   */
  split(e: number, t0: number, t1: number, t: number, x: number,
    pcurveAt: (c: number, loop: number, start: number) => PcurveSplit | undefined = () => undefined):
    { hi: number; dropped: number } {
    const E0 = this.e[e]!, hi = this.e.length, s0 = E0.start;
    // (Both pieces keep the edge's source id: consumers that place a mesh's edges by id (open-edges.ts, picking) see
    // the source's edge in both, as its uses' coedges keep theirs.)
    this.e.push({ ...E0, start: x, range: [t, t1], from: E0.from });
    E0.end = x, E0.range = [t0, t];
    let dropped = 0;
    for (let li = 0; li < this.l.length; li++) {
      const loop = this.l[li]!;
      for (let k = 0; k < loop.coedges.length; k++) {
        const c = loop.coedges[k]!, C0 = this.c[c]!;
        if (C0.edge !== e) continue;
        const rev = C0.orientation === ORIENTATION.reversed, c2 = this.c.length;
        // The p-curve's parameter at the split: t where it runs at the edge's parameter (its range, the p-curve's
        // parameters at the edge's start and end in that order whichever way the use runs, the edge's), else
        // pcurveAt's, strictly inside its range.
        const span = Math.abs(t1 - t0) || 1;
        let [r0, r1] = C0.range;
        const same = C0.pcurve >= 0 && Math.abs(r0 - t0) <= 1e-9 * span && Math.abs(r1 - t1) <= 1e-9 * span;
        let at = same ? t : undefined;
        if (C0.pcurve >= 0 && !same) {
          // (The edge's start: its end is x from here.)
          const q = pcurveAt(c, li, s0);
          if (q !== undefined && (q.at - q.range[0]) * (q.range[1] - q.at) > 0) [r0, r1] = q.range, at = q.at;
        }
        if (C0.pcurve >= 0 && at === undefined) dropped++;
        const pc = at === undefined ? -1 : C0.pcurve, none: [number, number] = [NaN, NaN];
        // (e's piece runs from the edge's start to x, the new one from x to its end, whichever way the use runs.)
        this.c.push({ ...C0, edge: hi, pcurve: pc, range: at === undefined ? none : [at, r1] });
        C0.pcurve = pc, C0.range = at === undefined ? none : [r0, at];
        // Forward: e's piece then the new one; reversed: the new one (run back) then e's.
        loop.coedges.splice(k, 1, ...(rev ? [c2, c] : [c, c2]));
        k++;
      }
    }
    return { hi, dropped };
  }

  /** Every use of edge `from` made a use of edge `to` (same vertices), bare, running the way it ran. */
  replace(from: number, to: number): void {
    const F0 = this.e[from]!, T = this.e[to]!;
    for (const x of this.c) {
      if (x.edge !== from) continue;
      const [s] = x.orientation === ORIENTATION.reversed ? [F0.end, F0.start] : [F0.start, F0.end];
      x.edge = to, x.pcurve = -1, x.range = [NaN, NaN];
      x.orientation = s === T.start ? ORIENTATION.forward : ORIENTATION.reversed;
    }
    this.deadEdges.add(from);
  }

  /** Each loop's consecutive uses of edge e there and back removed (repeatedly); loops left empty removed, and faces
   * left with none. */
  despike(e: number): void {
    for (let li = 0; li < this.l.length; li++) {
      const loop = this.l[li]!, cs = loop.coedges;
      let again = cs.length > 0;
      while (again && cs.length) {
        again = false;
        for (let k = 0; k < cs.length; k++) {
          const a = this.c[cs[k]!]!, b = this.c[cs[(k + 1) % cs.length]!]!;
          if (cs.length > 1 && a.edge === e && b.edge === e && a.orientation !== b.orientation) {
            if (k + 1 < cs.length) cs.splice(k, 2);
            else cs.splice(k, 1), cs.splice(0, 1);
            again = true;
            break;
          }
        }
      }
    }
    for (let f = 0; f < this.f.length; f++) {
      const face = this.f[f]!;
      face.loops = face.loops.filter((l) => this.l[l]!.kind !== LOOP_KIND.edge || this.l[l]!.coedges.length > 0);
      if (!face.loops.length && !this.removedFaces.has(f)) this.removedFaces.add(f);
    }
    if (!this.uses(e)) this.deadEdges.add(e);
  }

  uses(e: number): number {
    let n = 0;
    for (let li = 0; li < this.l.length; li++) for (const c of this.l[li]!.coedges) if (this.c[c]!.edge === e) n++;
    return n;
  }

  /** The model as edited: dead rows dropped, the rest renumbered (coedges in their loops' order). */
  write(): Omit<CoincidentResult, 'merged' | 'removed' | 'pcurvesDropped'> {
    const d = this.d;
    // Vertices and edges still used; one unused in the given model too isn't this fix's to drop.
    const usedV = new Set<number>(), usedE = new Set<number>();
    for (let f = 0; f < this.f.length; f++) {
      if (this.removedFaces.has(f)) continue;
      for (const l of this.f[f]!.loops) {
        const loop = this.l[l]!;
        if (loop.kind !== LOOP_KIND.edge) usedV.add(loop.vertex);
        for (const c of loop.coedges) usedE.add(this.c[c]!.edge);
      }
    }
    const keepE = (e: number) => usedE.has(e) || !this.deadEdges.has(e);
    for (let e = 0; e < this.e.length; e++) if (keepE(e)) usedV.add(this.e[e]!.start), usedV.add(this.e[e]!.end);
    const keepV = (v: number) => usedV.has(v) || !this.usedBefore.has(v);
    const vTo = new Int32Array(this.v.length).fill(-1), eTo = new Int32Array(this.e.length).fill(-1);
    // (-1, none, stays none: an edge of a curve-bounded surface has no vertices.)
    const V = (v: number) => v < 0 ? -1 : vTo[v]!, Ed = (e: number) => e < 0 ? -1 : eTo[e]!;
    const vs: V[] = [], es: E[] = [];
    this.v.forEach((x, i) => { if (keepV(i)) vTo[i] = vs.length, vs.push(x); });
    this.e.forEach((x, i) => { if (keepE(i)) eTo[i] = es.length, es.push(x); });
    const fTo = new Int32Array(this.f.length).fill(-1), fs: F[] = [];
    this.f.forEach((x, i) => { if (!this.removedFaces.has(i)) fTo[i] = fs.length, fs.push(x); });
    const cs: C[] = [], loops: { kind: number; bound: number; first: number; count: number; id: number }[] = [];
    const faceFirst: number[] = [], faceCount: number[] = [];
    for (const face of fs) {
      faceFirst.push(loops.length), faceCount.push(face.loops.length);
      for (const l of face.loops) {
        const loop = this.l[l]!;
        if (loop.kind !== LOOP_KIND.edge) {
          loops.push({ kind: loop.kind, bound: loop.bound, first: V(loop.vertex), count: 1, id: loop.id });
          continue;
        }
        loops.push({ kind: loop.kind, bound: loop.bound, first: cs.length, count: loop.coedges.length, id: loop.id });
        for (const c of loop.coedges) cs.push(this.c[c]!);
      }
    }
    const faceUse: number[] = [], shellFirst: number[] = [], shellCount: number[] = [];
    for (const faces of this.shellFaces) {
      const live = faces.filter((f) => fTo[f]! >= 0).map((f) => fTo[f]!);
      shellFirst.push(faceUse.length), shellCount.push(live.length), faceUse.push(...live);
    }
    const member = Int32Array.from(d.member.ref);
    for (let b = 0; b < rowCount(d, 'body'); b++) {
      if (d.body.kind[b] !== BODY_KIND.wire) continue;
      for (let m = d.body.first[b]!; m < d.body.first[b]! + d.body.count[b]!; m++) member[m] = Ed(member[m]!);
    }
    const itemRef = Int32Array.from(d.item.ref);
    for (let i = 0; i < itemRef.length; i++) {
      if (d.item.kind[i] === ITEM_KIND.face && itemRef[i]! >= 0) itemRef[i] = fTo[itemRef[i]!]!;
    }
    const col = <T>(xs: T[], f: (x: T) => number | number[]) => xs.flatMap((x) => f(x));
    const columns: Record<string, ArrayLike<number>> = {
      'vertex.point': col(vs, (x) => x.point), 'vertex.tolerance': col(vs, (x) => x.tol),
      'vertex.id': col(vs, (x) => x.id),
      'edge.curve': col(es, (x) => x.curve), 'edge.start': col(es, (x) => V(x.start)),
      'edge.end': col(es, (x) => V(x.end)), 'edge.sameSense': col(es, (x) => x.sameSense),
      'edge.range': col(es, (x) => x.range), 'edge.tolerance': col(es, (x) => x.tol), 'edge.id': col(es, (x) => x.id),
      'coedge.edge': col(cs, (x) => Ed(x.edge)), 'coedge.orientation': col(cs, (x) => x.orientation),
      'coedge.pcurve': col(cs, (x) => x.pcurve), 'coedge.range': col(cs, (x) => x.range),
      'coedge.id': col(cs, (x) => x.id),
      'loop.kind': loops.map((x) => x.kind), 'loop.bound': loops.map((x) => x.bound),
      'loop.first': loops.map((x) => x.first), 'loop.count': loops.map((x) => x.count),
      'loop.id': loops.map((x) => x.id),
      'face.surface': col(fs, (x) => x.surface), 'face.sameSense': col(fs, (x) => x.sameSense),
      'face.firstLoop': faceFirst, 'face.loopCount': faceCount, 'face.tolerance': col(fs, (x) => x.tol),
      'face.id': col(fs, (x) => x.id),
      'shell.first': shellFirst, 'shell.count': shellCount, 'faceUse.face': faceUse, 'member.ref': member,
      'item.ref': itemRef,
    };
    const model = writeBrep((c) => columns[`${c.table}.${c.column}`]
      ?? (d as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!);
    return { model, vertexFrom: Int32Array.from(vs, (x) => x.from), edgeFrom: Int32Array.from(es, (x) => x.from),
      coedgeFrom: Int32Array.from(cs, (x) => x.from), faceFrom: Int32Array.from(fs, (x) => x.from) };
  }
}

/** A pair to merge: coedge a runs into vertex v, b out of it, in one loop of face f. */
interface Pair {
  f: number;
  /** The loop's row. */
  l: number;
  a: number;
  b: number;
  v: number;
}

/** What the measure found of a pair: where each edge parts from the other (its curve's parameter), and whether that's
 * its far end. */
interface Stretch {
  tA: number;
  tB: number;
  wholeA: boolean;
  wholeB: boolean;
  length: number;
  distance: number;
  tol: number;
  crossed: boolean;
}

/** An edge's curve parameters at its start and end as the face API takes them (or undefined). */
type Params = (e: number) => [number, number] | undefined;

/** An edge's parameters at its vertex v's end and at its far end. */
function fromVertex(params: Params, d: BrepData, e: number, v: number): [number, number] | undefined {
  const r = params(e);
  return !r ? undefined : d.edge.start[e] === v ? r : [r[1], r[0]];
}

/** Measures one pair (rows of d): undefined where it isn't one to merge. */
function measure(g: Geometry, params: Params, d: BrepData, p: Pair, tolOf: (e: number) => number):
  Stretch | undefined {
  const ea = d.coedge.edge[p.a]!, eb = d.coedge.edge[p.b]!, ca = d.edge.curve[ea]!, cb = d.edge.curve[eb]!;
  if (ca < 0 || cb < 0) return undefined;
  const A = fromVertex(params, d, ea, p.v), B = fromVertex(params, d, eb, p.v);
  if (!A || !B) return undefined;
  // The directions leaving v.
  const da = g.evalCurve(ca, [A[0]], 1), db = g.evalCurve(cb, [B[0]], 1);
  if (da.status !== 'ok' || db.status !== 'ok' || da.statuses[0] || db.statuses[0]) return undefined;
  const sa = Math.sign(A[1] - A[0]), sb = Math.sign(B[1] - B[0]);
  const ta = [3, 4, 5].map((k) => sa * da.values[k]!), tb = [3, 4, 5].map((k) => sb * db.values[k]!);
  const na = Math.hypot(...ta), nb = Math.hypot(...tb);
  if (!(na > 0 && nb > 0)) return undefined;
  const cos = (ta[0]! * tb[0]! + ta[1]! * tb[1]! + ta[2]! * tb[2]!) / (na * nb);
  if (!(Math.acos(Math.min(1, cos)) < MAX_ANGLE)) return undefined;
  const tol = Math.max(tolOf(ea), tolOf(eb));
  // How far the points of one curve at parameters ts are from the other over its range.
  const off = (row: number, ts: number[], other: number, [lo, hi]: [number, number]) => {
    const q = g.evalCurve(row, ts, 0);
    if (q.status !== 'ok' || q.statuses.some((s) => s !== 0)) return undefined;
    const x = g.invertCurve(other, q.values, Math.min(lo, hi), Math.max(lo, hi), tol / 100);
    if (x.status !== 'ok') return undefined;
    return { d: Array.from(x.distance, (v) => Number.isFinite(v) ? v : Infinity), foot: x.params, at: q.values };
  };
  // Where curve `row` from t0 toward t1 first gets farther than `limit` from the other: its parameter, or t1.
  const parting = (row: number, [t0, t1]: [number, number], other: number, range: [number, number],
    limit = tol) => {
    const ts = Array.from({ length: SAMPLES + 1 }, (_, i) => t0 + (t1 - t0) * i / SAMPLES);
    const o = off(row, ts, other, range);
    if (!o) return undefined;
    const k = o.d.findIndex((x) => x > limit);
    if (k === 0) return undefined;
    if (k < 0) return { t: t1, whole: true, max: Math.max(...o.d) };
    let lo = ts[k - 1]!, hi = ts[k]!, max = Math.max(...o.d.slice(0, k));
    for (let i = 0; i < BISECTIONS; i++) {
      const m = (lo + hi) / 2, x = off(row, [m], other, range);
      if (!x) return undefined;
      if (x.d[0]! > limit) hi = m;
      else lo = m, max = Math.max(max, x.d[0]!);
    }
    return { t: lo, whole: false, max };
  };
  // The stretch within the tolerance (B's, then A's up to its foot): what the gates measure.
  const pb = parting(cb, B, ca, A);
  if (!pb) return undefined;
  const fb = off(cb, [pb.t], ca, A);
  if (!fb) return undefined;
  let tA = fb.foot[0]!;
  const pa = parting(ca, [A[0], tA], cb, B);
  if (!pa) return undefined;
  let tB = pb.t;
  if (!pa.whole) {
    tA = pa.t;
    const fa = off(ca, [tA], cb, B);
    if (!fa) return undefined;
    tB = fa.foot[0]!;
  }
  const lenOf = (t: number) => {
    const len = g.arcLength(cb, [Math.min(B[0], t), Math.max(B[0], t)], 1e-6);
    return len.status === 'ok' ? len.value[0]! : NaN;
  };
  if (!(lenOf(tB) > Math.max(LENGTH * tol, MIN_LENGTH))) return undefined;
  // Where they truly part, the stretch merged: past PART x the tolerance apart, or their last crossing in the face's
  // (u, v) within the stretch, whichever is farther from v (a wedge within the tolerance whose sides diverge slowly
  // keeps the rest of its width).
  const whole = pb.whole && pa.whole;
  const pf = parting(cb, [B[0], tB], ca, A, PART * tol);
  if (!pf) return undefined;
  const crossing = lastCrossing(g, params, d, p, A, B, tA, tB);
  const farther = (x: number, y: number) => Math.abs(x - B[0]) >= Math.abs(y - B[0]) ? x : y;
  const tBc = pf.whole ? tB : crossing === undefined ? pf.t : farther(pf.t, crossing);
  if (tBc !== tB) {
    const f = off(cb, [tBc], ca, A);
    if (!f) return undefined;
    tB = tBc, tA = f.foot[0]!;
  }
  // Each end snapped to its edge's far vertex where the stretch reaches its end within the tolerance.
  const ends = g.evalCurve(ca, [tA, A[1]], 0), endsB = g.evalCurve(cb, [tB, B[1]], 0);
  if (ends.status !== 'ok' || endsB.status !== 'ok') return undefined;
  const wholeA = sub(ends.values, 0, ends.values, 3) <= (whole || pf.whole ? tol : PART * tol);
  const wholeB = sub(endsB.values, 0, endsB.values, 3) <= (whole || pf.whole ? tol : PART * tol);
  // Where one is within the tolerance whole, the other is split at the foot of its far vertex: the vertex stays, and
  // the split point is as near it as the curve comes.
  if (wholeA !== wholeB) {
    const far = wholeA ? A : B, other = wholeA ? cb : ca, range = wholeA ? B : A;
    const f = off(wholeA ? ca : cb, [far[1]], other, range);
    if (!f) return undefined;
    if (wholeA) tB = f.foot[0]!;
    else tA = f.foot[0]!;
  }
  // (The stretch merged past MIN_LENGTH too: else the pair, meeting again at the new vertex up to PART x the
  // tolerance apart, would be merged again by nothing.)
  const length = lenOf(tB);
  if (!(length > MIN_LENGTH)) return undefined;
  // (A split point must lie strictly inside its edge's range, in the edge's direction.)
  const inside = (t: number, [t0, t1]: [number, number]) => (t - t0) * (t1 - t) > 0;
  if (!wholeA && !inside(tA, A)) return undefined;
  if (!wholeB && !inside(tB, B)) return undefined;
  // The stretches' distance as merged, sampled both ways.
  const ss = (t0: number, t1: number) => Array.from({ length: SAMPLES + 1 }, (_, i) => t0 + (t1 - t0) * i / SAMPLES);
  const db2 = off(cb, ss(B[0], tB), ca, A), da2 = off(ca, ss(A[0], tA), cb, B);
  if (!db2 || !da2) return undefined;
  const distance = Math.max(...db2.d, ...da2.d);
  if (!(distance <= tol)) return undefined;
  return { tA, tB, wholeA, wholeB, length, distance, tol, crossed: crossing !== undefined };
}

/** Uniform samples of a stretch from its vertex, and geometric ones toward the vertex (a crossing can be a micron
 * from it in a stretch of millimetres). */
const CROSS_UNIFORM = 128, CROSS_GEOMETRIC = 30;

/**
 * Where the two uses last cross each other in the face's (u, v) within the stretch (from v to tA along A, to tB along
 * B), as B's parameter (the crossing farthest from v): their (u, v) as the face API takes them (p-curves, else
 * projections), sampled, unwrapped across the face's periods, a proper crossing of their polylines anywhere but at
 * their shared start. Undefined where they don't.
 */
function lastCrossing(g: Geometry, params: Params, d: BrepData, p: Pair, A: [number, number],
  B: [number, number], tA: number, tB: number): number | undefined {
  // A use whose p-curve doesn't run at its edge's parameter is taken as the face API's projection of its curve (its
  // (u, v) at the edge's parameters); the rest by the face API's own (their p-curves, else projections).
  // (A coedge's range is in its edge's start-to-end order, whichever way it runs.)
  const atEdge = (c: number) => {
    if (d.coedge.pcurve[c]! < 0) return true;
    const r = params(d.coedge.edge[c]!)!, [a, b] = r, span = Math.abs(r[1] - r[0]);
    return Math.abs(d.coedge.range[2 * c]! - a) <= 1e-9 * span
      && Math.abs(d.coedge.range[2 * c + 1]! - b) <= 1e-9 * span;
  };
  const ts = (t0: number, t1: number) => {
    const xs = Array.from({ length: CROSS_UNIFORM + 1 }, (_, i) => i / CROSS_UNIFORM);
    for (let k = 1; k <= CROSS_GEOMETRIC; k++) xs.push(2 ** -k / CROSS_UNIFORM);
    return [...new Set(xs)].sort((x, y) => x - y).map((x) => t0 + (t1 - t0) * x);
  };
  const info = g.faceInfo(p.f), pu = info.uPeriod, pv = info.vPeriod;
  const uv = (c: number, t: number[]) => {
    let at: (i: number) => [number, number];
    if (atEdge(c)) {
      const r = g.evalCoedge(c, t, 0);
      if (r.status !== 'ok' || r.statuses.some((x) => x !== 0)) return undefined;
      at = (i) => [r.values[3 * i]!, r.values[3 * i + 1]!];
    } else {
      const r = g.projectCoedge(c, NaN, t);
      if (r.status !== 'ok' || !('uv' in r)) return undefined;
      const q = r.takesTwin ? r.twinUv : r.uv;
      if (q.some((x) => !Number.isFinite(x))) return undefined;
      at = (i) => [q[2 * i]!, q[2 * i + 1]!];
    }
    const out: [number, number][] = [];
    for (let i = 0; i < t.length; i++) {
      let [u, v] = at(i);
      const ref = out.length ? out[out.length - 1]! : undefined;
      if (ref && pu > 0) u -= pu * Math.round((u - ref[0]) / pu);
      if (ref && pv > 0) v -= pv * Math.round((v - ref[1]) / pv);
      out.push([u, v]);
    }
    return out;
  };
  const tsB = ts(B[0], tB), a = uv(p.a, ts(A[0], tA)), b = uv(p.b, tsB);
  if (!a || !b) return undefined;
  // B's start onto A's: the same point, not a period away.
  const du = pu > 0 ? pu * Math.round((b[0]![0] - a[0]![0]) / pu) : 0;
  const dv = pv > 0 ? pv * Math.round((b[0]![1] - a[0]![1]) / pv) : 0;
  for (const q of b) q[0] -= du, q[1] -= dv;
  let last: number | undefined;
  for (let i = 0; i + 1 < a.length; i++) {
    const [p0, p1] = [a[i]!, a[i + 1]!], rx = p1[0] - p0[0], ry = p1[1] - p0[1];
    const ulo = Math.min(p0[0], p1[0]), uhi = Math.max(p0[0], p1[0]);
    const vlo = Math.min(p0[1], p1[1]), vhi = Math.max(p0[1], p1[1]);
    for (let j = 0; j + 1 < b.length; j++) {
      if (i === 0 && j === 0) continue;
      const [q0, q1] = [b[j]!, b[j + 1]!];
      if (Math.max(q0[0], q1[0]) < ulo || Math.min(q0[0], q1[0]) > uhi || Math.max(q0[1], q1[1]) < vlo
        || Math.min(q0[1], q1[1]) > vhi) continue;
      const sx = q1[0] - q0[0], sy = q1[1] - q0[1], den = rx * sy - ry * sx;
      if (den === 0) continue;
      const wx = q0[0] - p0[0], wy = q0[1] - p0[1], x = (wx * sy - wy * sx) / den, y = (wx * ry - wy * rx) / den;
      if (x > 0 && x < 1 && y > 0 && y < 1) {
        const t = tsB[j]! + y * (tsB[j + 1]! - tsB[j]!);
        if (last === undefined || Math.abs(t - B[0]) > Math.abs(last - B[0])) last = t;
      }
    }
  }
  return last;
}

/** The pairs of d's loops that could merge: consecutive uses, forward or reversed, of two different edges with 3D
 * curves, neither used twice in the face. */
function pairs(d: BrepData): Pair[] {
  const out: Pair[] = [];
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const inFace = new Map<number, number>();
    const loops: number[] = [];
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      loops.push(l);
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        inFace.set(d.coedge.edge[c]!, (inFace.get(d.coedge.edge[c]!) ?? 0) + 1);
      }
    }
    for (const l of loops) {
      const first = d.loop.first[l]!, n = d.loop.count[l]!;
      if (n < 2) continue;
      for (let k = 0; k < n; k++) {
        const a = first + k, b = first + (k + 1) % n, ea = d.coedge.edge[a]!, eb = d.coedge.edge[b]!;
        if (ea === eb || inFace.get(ea)! > 1 || inFace.get(eb)! > 1) continue;
        if (d.coedge.orientation[a]! > ORIENTATION.reversed || d.coedge.orientation[b]! > ORIENTATION.reversed) {
          continue;
        }
        const v = d.coedge.orientation[a] === ORIENTATION.reversed ? d.edge.start[ea]! : d.edge.end[ea]!;
        const vb = d.coedge.orientation[b] === ORIENTATION.reversed ? d.edge.end[eb]! : d.edge.start[eb]!;
        if (v !== vb || v < 0) continue;
        // (Closed edges, start and end one vertex, have no far end to part toward.)
        if (d.edge.start[ea] === d.edge.end[ea] || d.edge.start[eb] === d.edge.end[eb]) continue;
        out.push({ f, l, a, b, v });
      }
    }
  }
  return out;
}

/** One merge applied to d (rows of d): the edited topology, or undefined where it can't be (said nowhere: left). */
function apply(g: Geometry, params: Params, d: BrepData, p: Pair, s: Stretch, part: number):
  { t: Topo; merged: Merged; dropped: number; near: Vec[] } | undefined {
  const t = new Topo(d), ea = d.coedge.edge[p.a]!, eb = d.coedge.edge[p.b]!;
  const A = fromVertex(params, d, ea, p.v)!, B = fromVertex(params, d, eb, p.v)!;
  const farA = d.edge.start[ea] === p.v ? d.edge.end[ea]! : d.edge.start[ea]!;
  const farB = d.edge.start[eb] === p.v ? d.edge.end[eb]! : d.edge.start[eb]!;
  if (s.wholeA && s.wholeB && farA !== farB) return undefined;
  const at = (row: number, x: number) => {
    const q = g.evalCurve(row, [x], 0).values;
    return [q[0]!, q[1]!, q[2]!] as Vec;
  };
  const qa = at(d.edge.curve[ea]!, s.tA), qb = at(d.edge.curve[eb]!, s.tB);
  // The vertex where they part, with the tolerance it needs to reach both split points.
  let x: number;
  const reach = (v: number, ...qs: Vec[]) => {
    const pt = t.v[v]!.point, need = Math.max(...qs.map((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1], q[2] - pt[2])));
    const has = Number.isFinite(t.v[v]!.tol) ? t.v[v]!.tol : part;
    if (need > has) t.v[v]!.tol = need;
  };
  if (s.wholeB && !s.wholeA) x = farB, reach(x, qa);
  else if (s.wholeA && !s.wholeB) x = farA, reach(x, qb);
  else if (s.wholeA && s.wholeB) x = farA;
  else {
    x = t.v.length;
    t.v.push({ point: [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2, (qa[2] + qb[2]) / 2], tol: NaN, id: 0, from: -1 });
    reach(x, qa, qb);
  }
  let dropped = 0;
  // Each edge split where it parts (its parameters from its start to its end): the piece toward v is the stretch.
  const cut = (e: number, [tv, tfar]: [number, number], ts: number, whole: boolean) => {
    if (whole) return e;
    const startAtV = d.edge.start[e] === p.v, [t0, t1] = startAtV ? [tv, tfar] : [tfar, tv];
    const r = t.split(e, t0, t1, ts, x, nearestOn(g, t, t.e[e]!.curve, ts, s.tol));
    dropped += r.dropped;
    // split keeps e as the start's piece: the stretch is e where v is the start, else the new one.
    return startAtV ? e : r.hi;
  };
  const pa = cut(ea, A, s.tA, s.wholeA), pb = cut(eb, B, s.tB, s.wholeB);
  // The merged edge on whichever stretch's curve lies nearer the surfaces of the other's faces (an edge can lie off its
  // own face by up to the tolerance, and the other's curve then lies that far off it: LMP1 #172522's #531308, 0.13
  // off #1049747, which OCCT failed on #530798's curve, 0.145 off it); its tolerance grown to that distance where
  // that's past its own (the other's tolerance plus the stretches' distance where it can't be measured).
  const needA = offFaces(g, d, d.edge.curve[ea]!, [A[0], s.tA], eb, B, p.b, s);
  const needB = offFaces(g, d, d.edge.curve[eb]!, [B[0], s.tB], ea, A, p.a, s);
  // (The first's, unless it would need its tolerance grown and the other's lies nearer.)
  const ownOf = (e: number) => Number.isFinite(t.e[e]!.tol) ? t.e[e]!.tol : part;
  const [sa, sb, need] = needA > ownOf(pa) && needB < needA ? [pb, pa, needB] : [pa, pb, needA];
  const SA = t.e[sa]!, own = ownOf(sa);
  let grown = NaN;
  if (need > own) SA.tol = grown = need;
  // Both stretches must join the same two vertices.
  const vsA = [SA.start, SA.end].sort(), vsB = [t.e[sb]!.start, t.e[sb]!.end].sort();
  if (vsA[0] !== vsB[0] || vsA[1] !== vsB[1]) return undefined;
  t.replace(sb, sa);
  const outer = t.f.map((face) => face.loops.some((l) => t.l[l]!.bound === BOUND.outer));
  t.despike(sa);
  // The face left a lens of two edges within PART x the tolerance of each other end to end (a sliver the stretch cut
  // off: trj12_b3 #23876, 0.13 mm of a triangle 1 mm long whose third side was the stretch) has no area: its edges
  // one, as a sliver's.
  const F = t.f[p.f]!;
  if (!t.removedFaces.has(p.f) && F.loops.length === 1 && t.l[F.loops[0]!]!.coedges.length === 2) {
    const [c1, c2] = t.l[F.loops[0]!]!.coedges.map((c) => t.c[c]!), [e1, e2] = [c1!.edge, c2!.edge];
    if (e1 !== e2 && within(g, params, d, t, e1, e2, PART * s.tol)) t.replace(e2, e1), t.despike(e1);
  }
  // A face that lost its outer loop but kept others: not this fix's to make.
  for (let f = 0; f < t.f.length; f++) {
    if (outer[f] && !t.removedFaces.has(f) && !t.f[f]!.loops.some((l) => t.l[l]!.bound === BOUND.outer)) {
      return undefined;
    }
  }
  // Spikes can only be where the merged edge's uses run there and back; v goes where nothing uses it.
  const merged: Merged = { face: d.face.id[p.f]!, edges: [ea, eb], length: s.length,
    distance: s.distance, tolerance: s.tol, grown, crossed: s.crossed };
  // A shell left with no faces, or an item naming a removed face: not this fix's to make.
  for (const faces of t.shellFaces) if (faces.length && faces.every((f) => t.removedFaces.has(f))) return undefined;
  for (let i = 0; i < d.item.kind.length; i++) {
    if (d.item.kind[i] === ITEM_KIND.face && t.removedFaces.has(d.item.ref[i]!)) return undefined;
  }
  // The merged edge used at most once each way (a shell's faces agreeing on it).
  let fwd = 0, back = 0;
  for (const loop of t.l) for (const c of loop.coedges) {
    if (t.c[c]!.edge !== sa) continue;
    if (t.c[c]!.orientation === ORIENTATION.forward) fwd++;
    else back++;
  }
  if (fwd > 1 || back > 1) return undefined;
  return { t, merged, dropped, near: [[...t.v[x]!.point] as Vec, [...t.v[p.v]!.point] as Vec] };
}

/** A use's p-curve's parameter at a split, and its range as the use runs (its own where the use gave none). */
interface PcurveSplit {
  at: number;
  range: [number, number];
}

/** Samples along a p-curve for its parameter nearest a point, before refining. */
const NEAR_SAMPLES = 64;

/**
 * For a use of an edge of curve `row` split at its parameter t: the parameter of the use's p-curve whose point on its
 * face's surface is nearest the curve's at t (sampled over the use's range, then refined by golden section), where
 * that's within tol of it; else undefined. A use without a range takes its p-curve's own, the end nearer the edge's
 * `start` vertex first (a coedge's range is in its edge's start-to-end order).
 */
function nearestOn(g: Geometry, topo: Topo, row: number, t: number, tol: number):
  (c: number, loop: number, start: number) => PcurveSplit | undefined {
  return (c, loop, start) => {
    const f = topo.f.findIndex((F) => F.loops.includes(loop)), C0 = topo.c[c]!;
    const P = g.evalCurve(row, [t], 0);
    if (f < 0 || P.status !== 'ok' || P.statuses[0]) return undefined;
    const surface = topo.f[f]!.surface;
    let [r0, r1] = C0.range;
    const dist = (ss: number[], Q: ArrayLike<number> = P.values) => {
      const uv = g.evalCurve(C0.pcurve, ss, 0);
      if (uv.status !== 'ok' || uv.statuses.some((v) => v !== 0)) return undefined;
      const pts: number[] = [];
      for (let i = 0; i < ss.length; i++) pts.push(uv.values[3 * i]!, uv.values[3 * i + 1]!);
      const S = g.evalSurface(surface, pts, 0);
      if (S.status !== 'ok' || S.statuses.some((v) => v !== 0)) return undefined;
      return ss.map((_, i) => sub(S.values, 3 * i, Q, 0));
    };
    // A use without a range: the p-curve's own, its end nearer the edge's start first.
    if (!Number.isFinite(r0) || !Number.isFinite(r1)) {
      const info = g.curveInfo(C0.pcurve);
      if (info.status !== 'ok' || !Number.isFinite(info.lo) || !Number.isFinite(info.hi) || start < 0) return undefined;
      const d = dist([info.lo, info.hi], topo.v[start]!.point);
      if (!d) return undefined;
      [r0, r1] = d[0]! <= d[1]! ? [info.lo, info.hi] : [info.hi, info.lo];
    }
    const ss = Array.from({ length: NEAR_SAMPLES + 1 }, (_, i) => r0 + (r1 - r0) * i / NEAR_SAMPLES);
    const d0 = dist(ss);
    if (!d0) return undefined;
    const k = d0.indexOf(Math.min(...d0));
    let lo = ss[Math.max(k - 1, 0)]!, hi = ss[Math.min(k + 1, NEAR_SAMPLES)]!;
    const phi = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 60; i++) {
      const a = hi - phi * (hi - lo), b = lo + phi * (hi - lo), d = dist([a, b]);
      if (!d) return undefined;
      if (d[0]! <= d[1]!) hi = b;
      else lo = a;
    }
    const at = (lo + hi) / 2, d = dist([at]);
    return d && d[0]! <= tol ? { at, range: [r0, r1] } : undefined;
  };
}

/** Samples along each of two edges, for whether they lie within the tolerance of each other. */
const WITHIN_SAMPLES = 17;

/**
 * Whether edges x and y of t (rows of d, or pieces the edit made, with their own ranges) lie within tol of each other
 * both ways (sampled) and join the same two vertices.
 */
function within(g: Geometry, params: Params, d: BrepData, t: Topo, x: number, y: number, tol: number): boolean {
  const X = t.e[x]!, Y = t.e[y]!;
  if ([X.start, X.end].sort().join() !== [Y.start, Y.end].sort().join() || X.curve < 0 || Y.curve < 0) return false;
  const range = (e: number): [number, number] | undefined => {
    const r = t.e[e]!.range;
    return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? r : e < rowCount(d, 'edge') ? params(e) : undefined;
  };
  const rx = range(x), ry = range(y);
  if (!rx || !ry) return false;
  const far = (a: E, [a0, a1]: [number, number], b: E, [b0, b1]: [number, number]) => {
    const ts = Array.from({ length: WITHIN_SAMPLES }, (_, i) => a0 + (a1 - a0) * i / (WITHIN_SAMPLES - 1));
    const q = g.evalCurve(a.curve, ts, 0);
    if (q.status !== 'ok' || q.statuses.some((v) => v !== 0)) return Infinity;
    const f = g.invertCurve(b.curve, q.values, Math.min(b0, b1), Math.max(b0, b1), tol / 100);
    return f.status !== 'ok' ? Infinity : Math.max(...Array.from(f.distance, (v) => Number.isFinite(v) ? v : Infinity));
  };
  return far(X, rx, Y, ry) <= tol && far(Y, ry, X, rx) <= tol;
}

/** Samples along a stretch, for the merged edge's distance from the other edge's faces. */
const OFF_SAMPLES = 17;

/**
 * How far one stretch (curve row ca over [a0, a1], from the vertex) lies from the surfaces of the faces the other edge
 * eb's uses but `skip` bound (local feet from eb's (u, v) there; eb's parameters B, from the vertex), at OFF_SAMPLES
 * points (sampled, not bounded).
 */
function offFaces(g: Geometry, d: BrepData, ca: number, [a0, a1]: [number, number], eb: number,
  B: [number, number], skip: number, s: Stretch): number {
  const cb = d.edge.curve[eb]!;
  const fallback = Math.max(Number.isFinite(d.edge.tolerance[eb]!) ? d.edge.tolerance[eb]! : 0, s.tol) + s.distance;
  const ts = Array.from({ length: OFF_SAMPLES }, (_, i) => a0 + (a1 - a0) * i / (OFF_SAMPLES - 1));
  const q = g.evalCurve(ca, ts, 0);
  if (q.status !== 'ok' || q.statuses.some((x) => x !== 0)) return fallback;
  const feet = g.invertCurve(cb, q.values, Math.min(...B), Math.max(...B), s.tol / 100);
  if (feet.status !== 'ok') return fallback;
  let need = 0;
  for (let c = 0; c < rowCount(d, 'coedge'); c++) {
    if (d.coedge.edge[c] !== eb || c === skip) continue;
    const f = faceOfCoedge(d, c);
    if (f < 0) continue;
    const uv = g.evalCoedge(c, feet.params, 0);
    if (uv.status !== 'ok' || uv.statuses.some((x) => x !== 0)) return fallback;
    const starts: number[] = [];
    for (let i = 0; i < OFF_SAMPLES; i++) starts.push(uv.values[3 * i]!, uv.values[3 * i + 1]!);
    const x = g.faceLocalFoot(f, q.values, starts);
    if (x.status !== 'ok') return fallback;
    // (A point whose foot is past the surface's domain, near a face's corner on its surface's side: bounded by its
    // distance to B plus B's tolerance.)
    for (let i = 0; i < OFF_SAMPLES; i++) {
      const y = x.statuses[i] === 0 && Number.isFinite(x.distance[i]!) ? x.distance[i]! : s.tol + feet.distance[i]!;
      need = Math.max(need, y);
    }
  }
  return need;
}

/** The face whose loops hold coedge c (-1: none). */
function faceOfCoedge(d: BrepData, c: number): number {
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] === LOOP_KIND.edge && c >= d.loop.first[l]! && c < d.loop.first[l]! + d.loop.count[l]!) {
        return f;
      }
    }
  }
  return -1;
}

/**
 * The self-crossings of each of a face's loops in (u, v), summed (the face API's; Infinity where it can't tell), but
 * those within r of a point of `near` (the merge's vertices, where its pieces meet up to the tolerance apart, which the
 * face API's joints count as crossings).
 */
function crossings(g: Geometry, d: BrepData, f: number, near: Vec[], r: number): number {
  let n = 0;
  for (let k = 0; k < d.face.loopCount[f]!; k++) {
    if (d.loop.kind[d.face.firstLoop[f]! + k] !== LOOP_KIND.edge) continue;
    const x = g.selfIntersectFace(f, k);
    if (x.status !== 'ok') return Infinity;
    const pts = x.points.filter((p) => !p.tangent);
    if (!pts.length) continue;
    const q = g.faceEval(f, pts.flatMap((p) => [p.u, p.v]), 0);
    if (q.status !== 'ok') return Infinity;
    for (let i = 0; i < pts.length; i++) {
      const x0 = q.values[3 * i]!, y0 = q.values[3 * i + 1]!, z0 = q.values[3 * i + 2]!;
      if (!near.some((c) => Math.hypot(x0 - c[0], y0 - c[1], z0 - c[2]) <= r)) n++;
    }
  }
  return n;
}

/**
 * Whether the merge written as `w` makes any face of d but `spike` using one of `edges` cross itself in (u, v) more
 * than it did (a face it removes counts none), crossings within r of `near` not counted.
 */
function crossesMore(module: GeomModule, g: Geometry, d: BrepData, w: ReturnType<Topo['write']>, edges: number[],
  spike: number, near: Vec[], r: number): boolean {
  const faces = new Set<number>();
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        if (f !== spike && edges.includes(d.coedge.edge[c]!)) faces.add(f);
      }
    }
  }
  const g2 = new Geometry(module, new Uint8Array(w.model.buffer));
  try {
    for (let k = 0; k < w.faceFrom.length; k++) {
      const f = w.faceFrom[k]!;
      if (!faces.has(f)) continue;
      const before = crossings(g, d, f, near, r), after = crossings(g2, w.model, k, near, r);
      if (after > before) return true;
    }
    return false;
  } finally {
    g2.dispose();
  }
}

/**
 * coincidentEdges on a model: every pair merged (one at a time, the model written and measured again after each), or
 * undefined where there's none. `ranges` the given model's edges' parameters at start and end where known (the curves
 * step's, which the face API takes a while to derive for an edge whose range the source leaves out; NaN: not known).
 */
export function mergeCoincident(module: GeomModule, given: BrepData, ranges?: Float64Array):
  CoincidentResult | undefined {
  let d = given;
  const merged: Merged[] = [], removed: number[] = [];
  let dropped = 0;
  // Each row's given row, composed over the merges.
  let maps: Pick<CoincidentResult, 'vertexFrom' | 'edgeFrom' | 'coedgeFrom' | 'faceFrom'> | undefined;
  const tried = new Set<string>(), troubledLoops = new Set<string>();
  // Each given edge's parameters as derived once (rows of the given model).
  const known = new Map<number, [number, number] | undefined>();
  for (let round = 0; round < MAX_MERGES; round++) {
    const tol = tolerances(d), g = new Geometry(module, new Uint8Array(d.buffer));
    let done: ReturnType<typeof apply>, w: ReturnType<Topo['write']> | undefined;
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
    // A loop is merged in only where its boundary is in trouble: the face API sees it cross or overlap itself, or one
    // of its pairs crosses in the face's (u, v) (the face API's own test leaves out the stretch beside each vertex,
    // where these cusps are). Once in trouble, a loop stays so (keyed by its face's given row and its index there), so
    // its other cusps merge too (lightarm #91488's second, which doesn't cross). Elsewhere a merge gains nothing, and
    // can break the face or a neighbour (projector-lift #1685's #12900, which meshed).
    const loopKey = (p: Pair) => `${maps ? maps.faceFrom[p.f]! : p.f}:${p.l - d.face.firstLoop[p.f]!}`;
    const askedApi = new Set<number>();
    const inTrouble = (p: Pair) => {
      const k = loopKey(p);
      if (troubledLoops.has(k)) return true;
      if (askedApi.has(p.l)) return false;
      askedApi.add(p.l);
      const r = g.selfIntersectFace(p.f, p.l - d.face.firstLoop[p.f]!);
      if (r.status === 'ok' && (r.crossings > 0 || r.overlaps > 0)) troubledLoops.add(k);
      return troubledLoops.has(k);
    };
    try {
      const candidates: { p: Pair; s: Stretch; key: string }[] = [];
      for (const p of pairs(d)) {
        // (A pair measured and left before is left again: keyed by its edges' ids and the vertex's point.)
        const ea = d.coedge.edge[p.a]!, eb = d.coedge.edge[p.b]!;
        const key = `${d.edge.id[ea]}:${d.edge.id[eb]}:${d.edge.curve[ea]}:${d.edge.curve[eb]}:`
          + `${d.vertex.point[3 * p.v]},${d.vertex.point[3 * p.v + 1]},${d.vertex.point[3 * p.v + 2]}`;
        if (tried.has(key)) continue;
        const st = measure(g, params, d, p, tol.edge);
        if (!st) {
          tried.add(key);
          continue;
        }
        if (st.crossed) troubledLoops.add(loopKey(p));
        candidates.push({ p, s: st, key });
      }
      for (const { p, s: st, key } of candidates) {
        // (Not in trouble: left for now, not tried, as a later merge in its loop can put it there.)
        if (!inTrouble(p)) continue;
        const ea = d.coedge.edge[p.a]!, eb = d.coedge.edge[p.b]!;
        const x = apply(g, params, d, p, st, tol.part);
        if (x) {
          const wx = x.t.write();
          // (Left where it makes another face using either edge cross itself in (u, v) more than before: the merged
          // edge on the first one's curve can run across a neighbour of the second one's in that face's (u, v), LMP1
          // #172490's #1048071. The spike's own face isn't asked: its two pieces now meet at the parting vertex up to
          // the tolerance apart, which the face API counts as a crossing at their joint.)
          if (!crossesMore(module, g, d, wx, [ea, eb], p.f, x.near, 2 * st.tol)) {
            done = x, w = wx;
            break;
          }
        }
        tried.add(key);
      }
    } finally {
      g.dispose();
    }
    if (!done) break;
    const removedIds = [...done.t.removedFaces].map((f) => d.face.id[f]!);
    const idOf = (e: number) => d.edge.id[e] || given.edge.id[maps ? maps.edgeFrom[e]! : e] || 0;
    done.merged.edges = [idOf(done.merged.edges[0]), idOf(done.merged.edges[1])];
    if (!w) break;
    const compose = (now: Int32Array, before: Int32Array | undefined) =>
      before ? now.map((r) => r < 0 ? -1 : before[r]!) : now;
    maps = { vertexFrom: compose(w.vertexFrom, maps?.vertexFrom), edgeFrom: compose(w.edgeFrom, maps?.edgeFrom),
      coedgeFrom: compose(w.coedgeFrom, maps?.coedgeFrom), faceFrom: compose(w.faceFrom, maps?.faceFrom) };
    d = w.model, merged.push(done.merged), removed.push(...removedIds), dropped += done.dropped;
  }
  if (!merged.length) return undefined;
  return { model: d, merged, removed, pcurvesDropped: dropped, ...maps! };
}
