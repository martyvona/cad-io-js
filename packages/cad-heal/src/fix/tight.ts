// pcurveTight: a face whose bare uses (coedges without p-curves), projected at the face API's tolerance, give a loop
// that bounds next to nothing in (u, v) while their exact feet on the surface bound a region: the loose fit has
// collapsed the face (Kuka #4099's #28466, a strip 0.0004 mm wide whose two chains stand up to 0.00093 mm off it, the
// loose fit putting both along v = 1, its exact feet keeping one 0.00073 below). Those uses are given p-curves
// projected within the curves' fit tolerance (healCurves, as the pcurveMissing fixes make them), or tighter where the
// fit there still collapses the loop, down to MIN_FIT. Only where the loose image's (u, v) area is under LOOSE_SHARE of
// the domain's (cheap: the projections the curves' fixes make anyway) are the loop's points inverted (its exact feet);
// a face whose exact feet bound as little (a thin face along a side its surface spans, its loose fit right) is left,
// and so is one whose loop winds a period (its image doesn't close) or doesn't chain. Each loop's coedges are taken
// in the order they run (chained), whatever order the source lists them in.

import { type BrepData, LOOP_KIND, ORIENTATION, SURFACE_KIND } from 'cad-brep';
import type { Geometry } from 'cad-geom';

/** The loose image's (u, v) area at most this share of the domain's (its finite spans, else the image's): worth
 * inverting. */
export const LOOSE_SHARE = 1e-6;
/** The loose image's area under this share of the exact feet's: collapsed. */
export const COLLAPSED_SHARE = 1e-3;
/** A tighter fit's image at least this share of the exact feet's: kept. */
export const KEPT_SHARE = 0.5;
/** The tightest fit tried (mm), from the curves' fit tolerance down by tens. */
export const MIN_FIT = 1e-7;
/** Samples a coedge. */
const N = 17;

type V = [number, number, number];

export interface Tight {
  /** The faces caught, by row, with the tolerance their bare uses are to be projected within. */
  fit: Map<number, number>;
  /** Faces caught whose fit collapses the loop even at MIN_FIT, by row (left as they are). */
  left: number[];
}

/**
 * The signed (u, v) area of a closed sequence of (u, v), unwrapped across the periods (0: none); NaN where, unwrapped,
 * it doesn't close (a loop winding a period, whose area means nothing here).
 */
function uvArea(uv: Float64Array | number[], pu: number, pv: number): number {
  const n = uv.length / 2;
  let a = 0, pu0 = uv[0]!, pv0 = uv[1]!;
  const unwrap = (x: number, prev: number, p: number) => p > 0 ? x - p * Math.round((x - prev) / p) : x;
  for (let i = 1; i < n; i++) {
    const u = unwrap(uv[2 * i]!, pu0, pu), v = unwrap(uv[2 * i + 1]!, pv0, pv);
    a += pu0 * v - u * pv0, pu0 = u, pv0 = v;
  }
  // Back to the start: the same point, not a period away.
  if ((pu > 0 && Math.abs(pu0 - uv[0]!) > pu / 2) || (pv > 0 && Math.abs(pv0 - uv[1]!) > pv / 2)) return NaN;
  a += pu0 * uv[1]! - uv[0]! * pv0;
  return a / 2;
}

/**
 * Loop `l`'s coedges in the order they run, each starting where the last ended (a source may list them otherwise:
 * the builder lists them so, a source needn't); undefined where they don't make one closed chain.
 */
export function chained(d: BrepData, l: number): number[] | undefined {
  const first = d.loop.first[l]!, n = d.loop.count[l]!;
  // (An internal or external use bounds nothing on either side: no chain.)
  for (let c = first; c < first + n; c++) if (d.coedge.orientation[c]! > ORIENTATION.reversed) return undefined;
  const ends = (c: number) => {
    const e = d.coedge.edge[c]!, fwd = d.coedge.orientation[c] === ORIENTATION.forward;
    return fwd ? [d.edge.start[e]!, d.edge.end[e]!] : [d.edge.end[e]!, d.edge.start[e]!];
  };
  const left = new Set(Array.from({ length: n }, (_, i) => first + i)), out = [first];
  left.delete(first);
  while (left.size) {
    const at = ends(out[out.length - 1]!)[1]!;
    const next = [...left].find((c) => ends(c)[0] === at);
    if (next === undefined) return undefined;
    out.push(next), left.delete(next);
  }
  return ends(out[out.length - 1]!)[1] === ends(first)[0] ? out : undefined;
}

/** The faces of `d` pcurveTight catches (`g` its geometry), and the tolerance each is to be fitted at. */
export function tightFaces(g: Geometry, d: BrepData, fitTolerance: number): Tight {
  const out: Tight = { fit: new Map(), left: [] };
  for (let f = 0; f < d.face.id.length; f++) {
    const surface = d.face.surface[f]!;
    if (d.surface.kind[surface] === SURFACE_KIND.plane) continue;
    // The face's edge loops' coedges, and whether any is bare.
    const loops: number[][] = [];
    let bare = false;
    let chains = true;
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      const cs = chained(d, l);
      if (!cs) { chains = false; break; }
      for (const c of cs) if (d.coedge.pcurve[c]! < 0) bare = true;
      loops.push(cs);
    }
    if (!chains || !bare || !loops.length) continue;
    const si = g.surfaceInfo(surface);
    if (si.status !== 'ok') continue;
    // Each coedge's samples along its use, their points and their loose (u, v).
    const ts = new Map<number, number[]>(), xyz = new Map<number, V[]>(), loose = new Map<number, Float64Array>();
    let ok = true;
    for (const c of loops.flat()) {
      const e = d.coedge.edge[c]!, r = g.edgeParams(e);
      if (r.status !== 'ok' || d.edge.curve[e]! < 0) { ok = false; break; }
      const fwd = d.coedge.orientation[c] === ORIENTATION.forward;
      const t = Array.from({ length: N }, (_, i) => fwd ? r.t0 + (r.t1 - r.t0) * i / (N - 1)
        : r.t1 + (r.t0 - r.t1) * i / (N - 1));
      const ev = g.evalCoedge(c, t, 0), p = g.evalCurve(d.edge.curve[e]!, t, 0).values;
      if (ev.status !== 'ok') { ok = false; break; }
      ts.set(c, t), loose.set(c, Float64Array.from({ length: 2 * N }, (_, i) => ev.values[3 * (i >> 1) + (i & 1)]!));
      xyz.set(c, Array.from({ length: N }, (_, i) => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!] as V));
    }
    if (!ok) continue;
    const imageArea = (uvOf: (c: number) => ArrayLike<number>) => {
      let a = 0;
      for (const cs of loops) a += uvArea(cs.flatMap((c) => Array.from(uvOf(c))), si.uPeriod, si.vPeriod);
      return Math.abs(a);
    };
    // The loose image's area against the domain's (each direction's span where finite, else the image's own).
    const looseArea = imageArea((c) => loose.get(c)!);
    const all = loops.flat().flatMap((c) => Array.from(loose.get(c)!));
    const extent = (k: number, lo: number, hi: number) => {
      if (Number.isFinite(lo) && Number.isFinite(hi)) return hi - lo;
      let a = Infinity, b = -Infinity;
      for (let i = k; i < all.length; i += 2) a = Math.min(a, all[i]!), b = Math.max(b, all[i]!);
      return b - a;
    };
    const domain = extent(0, si.u[0], si.u[1]) * extent(1, si.v[0], si.v[1]);
    if (!(looseArea <= LOOSE_SHARE * domain)) continue;
    // The exact feet: the loop's points inverted onto the surface.
    const exact = new Map<number, Float64Array>();
    const box = [si.u[0], si.u[1], si.v[0], si.v[1]];
    for (const c of loops.flat()) {
      const inv = g.invertSurface(surface, xyz.get(c)!.flat(), box, 1e-12);
      exact.set(c, Float64Array.from(inv.params));
    }
    const exactArea = imageArea((c) => exact.get(c)!);
    if (!(looseArea < COLLAPSED_SHARE * exactArea)) continue;
    // The loosest fit, from the curves' fit tolerance down, whose image keeps the area: its bare uses projected at it
    // (the given p-curves' images as they are).
    let found = NaN;
    for (let tol = fitTolerance; tol >= MIN_FIT * (1 - 1e-9) && Number.isNaN(found); tol /= 10) {
      const at = new Map<number, ArrayLike<number>>();
      let made = true;
      for (const c of loops.flat()) {
        if (d.coedge.pcurve[c]! >= 0) { at.set(c, loose.get(c)!); continue; }
        const p = g.projectCoedge(c, tol, ts.get(c)!);
        if (!('uv' in p) || p.uv.some((x) => Number.isNaN(x))) { made = false; break; }
        at.set(c, p.uv);
      }
      if (made && imageArea((c) => at.get(c)!) >= KEPT_SHARE * exactArea) found = tol;
    }
    if (Number.isNaN(found)) out.left.push(f);
    else out.fit.set(f, found);
  }
  return out;
}
