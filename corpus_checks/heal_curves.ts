// Curves on surfaces, as healing (T3, lane 1) will find them: on every coedge of every face of every part's B-rep
// model, how far the geometry disagrees and what each healing policy would make of it, measured, nothing changed.
// Per coedge with a 3D curve:
//   - the 3D curve projected onto the face's surface (cad-geom's projectCoedge at the edge's tolerance): its status,
//     method, offSurface (the 3D curve's distance from the surface, which no p-curve can make up) and error;
//   - where the model gives a p-curve: its deviation from the 3D curve (S(p(s)) at SAMPLES points per piece of the
//     use, each point's distance to the 3D curve over the edge's range: sampled, not bounded), and its ends' gaps to
//     the edge's vertices;
//   - the edge's vertices' distances to its 3D curve.
// Per edge, the tolerance each policy needs, against the tolerance it's judged by (tolerance.h's rule: the largest of
// the part's uncertainty (else 1e-5 mm), the edge's own and 1e-9 x the part's size):
//   - keep: the source's p-curves kept, the tolerance grown to cover them (max of offSurface, given deviations, end
//     gaps, vertex gaps);
//   - replace: a given p-curve replaced by the projection where the projection is ok and nearer; missing ones made by
//     projection (max of offSurface, the chosen p-curves' errors, vertex gaps).
// Usage: node --max-old-space-size=8192 corpus_checks/heal_curves.ts [file-list.txt] [max MB]
//   SAMPLES=n points per piece (default 17), DENSE=n points per piece of the p-curve's image (default 129).
//   HEAL=1: each part's model healed first by cad-heal (HEAL=fix,...: those fixes only), its diagnostics counted.
//   FOCUS=mm: every edge needing more than its tolerance and that, with its coedges' curves and projections.
//   Several files at once (runner.ts: CHILDREN).
import fs from 'node:fs';
import { type BrepData, CURVE_KIND, LOOP_KIND, openBrep, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { Geometry, init, type GeomModule, type Pcurve } from '../packages/cad-geom/src/index.ts';
import { healPart, HEAL_FIXES, type HealFix } from '../packages/cad-heal/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: GeomModule;
const SAMPLES = Number(process.env.SAMPLES ?? 17), DENSE = Number(process.env.DENSE ?? 129);
const plant = process.env.PLANT, focus = Number(process.env.FOCUS ?? Infinity);
/** HEAL=1: each part's model healed first (cad-heal, every fix), HEAL=<fix,...>: only those fixes. */
const heal = process.env.HEAL;
const healFixes = !heal || heal === '1' ? undefined : Object.fromEntries(HEAL_FIXES.map((f) =>
  [f, heal.split(',').includes(f)])) as Partial<Record<HealFix, boolean>>;
if (plant && !['vertex', 'curve', 'pcurve'].includes(plant)) throw new Error(`PLANT=${plant}: vertex, curve, pcurve`);
const SKIND = Object.fromEntries(Object.entries(SURFACE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;
const CKIND = Object.fromEntries(Object.entries(CURVE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;

const examples = Number(process.env.EXAMPLES ?? 5);
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, key: string, ex?: string) => {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (ex && e.ex.length < examples) e.ex.push(ex);
};
const fresh = () => ({
  files: 0, parts: 0, faces: 0, coedges: 0, edges: 0, ms: 0, slowest: [] as string[], planted: [] as string[],
  missed: [] as string[],
  projection: {} as Tally, given: {} as Tally, ends: {} as Tally, vertices: {} as Tally, faceStatus: {} as Tally,
  keep: {} as Tally, replace: {} as Tally, keepMm: {} as Tally, replaceMm: {} as Tally, planes: {} as Tally,
  better: {} as Tally, degenerate: {} as Tally, cause: {} as Tally, backward: {} as Tally,
  sameParameter: {} as Tally, focus: [] as string[], healed: {} as Tally, healMs: 0,
});
type Result = ReturnType<typeof fresh>;

/** A ratio to the tolerance, binned. */
const ratioBin = (k: number) => !(k <= 1e300) ? 'not measured' : k <= 1 ? '<= 1 x tol' : k <= 10 ? '1-10 x tol'
  : k <= 100 ? '10-100 x tol' : k <= 1000 ? '100-1000 x tol' : '> 1000 x tol';
/** A length in mm, binned against candidate caps (0.1 mm the medium profile's deflection; 1 mm OCCT's maximum). */
const mmBin = (x: number) => !(x <= 1e300) ? 'not measured' : x <= 1e-3 ? '<= 0.001 mm' : x <= 1e-2 ? '0.001-0.01 mm'
  : x <= 0.1 ? '0.01-0.1 mm' : x <= 1 ? '0.1-1 mm' : '> 1 mm';
const dist = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);
/** The distance from point a[i] to the segment b[j]-b[k]. */
function segDist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number, k: number) {
  const dx = b[k]! - b[j]!, dy = b[k + 1]! - b[j + 1]!, dz = b[k + 2]! - b[j + 2]!;
  const px = a[i]! - b[j]!, py = a[i + 1]! - b[j + 1]!, pz = a[i + 2]! - b[j + 2]!;
  const l2 = dx * dx + dy * dy + dz * dz, t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / l2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
}

/**
 * Measures one part's model into R (its tallies), and gives per edge the tolerance needed keeping the source's
 * p-curves (NaN: not measured) and the tolerance it's judged by.
 */
function measurePart(d: BrepData, where: string, R: Result): { keep: Float64Array; edgeTol: (e: number) => number } {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const p = d.vertex.point, { edgeTol } = measureTolerances(d);
  // Per edge: the worst of each kind over its coedges.
  const ne = rowCount(d, 'edge');
  // An edge with any coedge not measured (a projection not ok, a given p-curve not sampled) has NaN for good.
  const off = new Float64Array(ne), keep = new Float64Array(ne), repl = new Float64Array(ne);
  const used = new Uint8Array(ne), cause: string[] = [], detail: string[][] = [];
  // What sets an edge's tolerance under keep: the largest term over its coedges.
  const why = (e: number, terms: Record<string, number>) => {
    let top = '', at = 0;
    for (const [k, x] of Object.entries(terms)) if (x > at) top = k, at = x;
    if (top && at > keep[e]!) cause[e] = top;
  };
  const max = (a: Float64Array, e: number, x: number) => {
    a[e] = Number.isNaN(x) || Number.isNaN(a[e]!) ? NaN : Math.max(a[e]!, x);
  };
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    R.faces++;
    const sf = d.face.surface[f]!, sk = SKIND[d.surface.kind[sf]!] ?? `kind ${d.surface.kind[sf]}`;
    const at = `${where} face #${d.face.id[f]}`;
    const info = g.faceInfo(f);
    tally(R.faceStatus, `${info.status} (${sk})`, info.status === 'ok' ? undefined : at);
    const pieces = info.status === 'ok' ? g.facePieces(f) : undefined;
    const travel = new Map<number, number[]>();
    if (pieces?.status === 'ok') {
      for (let k = 0; k < pieces.coedge.length; k++) {
        const c = pieces.coedge[k]!;
        (travel.get(c) ?? travel.set(c, []).get(c)!).push(pieces.travel[2 * k]!, pieces.travel[2 * k + 1]!);
      }
    }
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        R.coedges++;
        const e = d.coedge.edge[c]!, ci = d.edge.curve[e]!, tol = edgeTol(e), cat = `${at} coedge ${c}`;
        if (ci < 0) {
          tally(R.projection, 'no 3D curve (not measured)', cat);
          continue;
        }
        used[e] = 1;
        const given = d.coedge.pcurve[c]! >= 0;
        // The edge's vertices against its curve.
        const vs = [d.edge.start[e]!, d.edge.end[e]!].filter((v) => v >= 0);
        const ci3 = g.curveInfo(ci);
        const pr = g.projectCoedge(c);
        const proj = 'pieces' in pr ? pr as Pcurve : undefined;
        const [t0, t1] = proj ? proj.range : [ci3.lo, ci3.hi];
        const rlo = Math.min(t0, t1), rhi = Math.max(t0, t1);
        let vgap = 0;
        if (vs.length && Number.isFinite(rlo) && Number.isFinite(rhi)) {
          const pts = vs.flatMap((v) => [p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!]);
          const inv = g.invertCurve(ci, pts, rlo, rhi, tol);
          for (const x of inv.distance) vgap = Math.max(vgap, x);
          tally(R.vertices, ratioBin(vgap / tol));
        }
        let need = vgap;
        if (Number.isFinite(focus)) {
          (detail[e] ??= []).push(`  coedge ${c} face #${d.face.id[f]} (${sk}`
            + `${d.face.sameSense[f] ? '' : ', reversed'}): curve ${CKIND[d.curve.kind[ci]!]} ${ci} [${ci3.lo}, `
            + `${ci3.hi}] period ${ci3.period}, edge range given [${d.edge.range[2 * e]}, ${d.edge.range[2 * e + 1]}], `
            + `vertices ${vs.join(' ')} gap ${vgap.toExponential(2)}, `
            + `pcurve ${given ? d.coedge.pcurve[c] : 'missing'}; ` + (proj ? `projection ${proj.status} ${proj.method} `
            + `${proj.certainty} range [${proj.range}] off ${proj.offSurface.toExponential(2)} error `
            + `${proj.error.toExponential(2)} pieces ${proj.pieces.length}${proj.seamU || proj.seamV ? ' seam' : ''}`
            + `${proj.tAmbiguous.length ? ` ambiguous at ${[...proj.tAmbiguous]}` : ''}` : `projection ${pr.status}`));
        }
        // Coedges whose projection is singular (the whole range at one singular point) or whose range can't be
        // derived: classified for whoever takes degenerate edges (T3 lane 2).
        if ((!proj && pr.status === 'noPcurveRange') || proj?.status === 'singular') {
          const ck = CKIND[d.curve.kind[ci]!] ?? `kind ${d.curve.kind[ci]}`;
          const verts = vs.length === 2 ? vs[0] === vs[1] ? 'one vertex (closed)' : 'two vertices'
            : `${vs.length} vertices`;
          const rangeGiven = Number.isFinite(d.edge.range[2 * e]!) && Number.isFinite(d.edge.range[2 * e + 1]!);
          const [a, b] = Number.isFinite(rlo) && Number.isFinite(rhi) ? [rlo, rhi] : [ci3.lo, ci3.hi];
          const len = Number.isFinite(a) && Number.isFinite(b) && a < b ? g.arcLength(ci, [a, b], 1e-6).value[0]!
            : NaN;
          const sing = g.surfaceSingularities(sf).singularities;
          let near = Infinity, nearKind = '';
          for (const v of vs) {
            for (const q of sing) {
              const x = Math.hypot(p[3 * v]! - q.point[0], p[3 * v + 1]! - q.point[1], p[3 * v + 2]! - q.point[2]);
              if (x < near) near = x, nearKind = q.kind;
            }
          }
          const lenBin = !Number.isFinite(len) ? 'length unknown' : len <= tol ? 'length <= tol' : 'length > tol';
          tally(R.degenerate, `${proj ? 'singular' : 'noPcurveRange'}: ${ck}, ${verts}, range ${rangeGiven ? 'given'
            : 'not given'}, ${lenBin}, ${near <= tol ? `vertex at the surface's ${nearKind}` : sing.length
            ? 'vertices off its singularities' : 'surface without singularities'} (${sk})`,
            `${cat}: length ${len.toExponential(2)}, nearest singularity ${near.toExponential(2)}`);
        }
        if (!proj) {
          tally(R.projection, `not made: ${pr.status} (${given ? 'given' : 'missing'}, ${sk})`, cat);
        } else {
          tally(R.projection, `${proj.status} ${proj.method} (${given ? 'given' : 'missing'}, ${sk})`,
            proj.status === 'ok' ? undefined : `${cat}: off ${proj.offSurface.toExponential(2)}, error `
            + `${proj.error.toExponential(2)}, tol ${tol.toExponential(1)}`);
          max(off, e, proj.offSurface);
          need = Math.max(need, proj.offSurface);
          if (sk === 'plane' && !given) tally(R.planes, `missing: ${proj.status} ${proj.method}`);
        }
        // A projection that isn't ok (its curve off the surface, or a fit that didn't reach tol) still gives a
        // p-curve, with its error measured: what a tolerance grown to cover it must reach.
        const projErr = proj && ['ok', 'invalidModel', 'noConvergence'].includes(proj.status) ? proj.error : NaN;
        if (!given) {
          // The projection's error is at least offSurface: where the curve is off its surface (invalidModel)
          // that's the cause, where it isn't (noConvergence) the fit's own limit.
          why(e, { 'vertex off its curve': vgap,
            [proj?.status === 'noConvergence' ? 'the projection\'s fit short of tol' : 'curve off its surface']:
              Math.max(proj?.offSurface ?? 0, Number.isNaN(projErr) ? 0 : projErr) });
          max(keep, e, Math.max(need, projErr));
          max(repl, e, Math.max(need, projErr));
          continue;
        }
        // The given p-curve against the 3D curve.
        const tr = travel.get(c);
        if (!tr || !Number.isFinite(rlo) || !Number.isFinite(rhi)) {
          tally(R.given, `not measured: face ${info.status}${pieces && pieces.status !== 'ok'
            ? `, pieces ${pieces.status}` : ''} (${sk})`, cat);
          max(keep, e, NaN), max(repl, e, Math.max(need, projErr));
          continue;
        }
        const ts: number[] = [];
        for (let k = 0; k < tr.length; k += 2)
          for (let i = 0; i < SAMPLES; i++) ts.push(tr[k]! + (tr[k + 1]! - tr[k]!) * i / (SAMPLES - 1));
        const ev = g.evalCoedge(c, ts, 0), uv: number[] = [];
        for (let i = 0; i < ts.length; i++) uv.push(ev.values[3 * i]!, ev.values[3 * i + 1]!);
        const xyz = g.evalSurface(sf, uv, 0).values;
        const inv = g.invertCurve(ci, xyz, rlo, rhi, tol);
        let dev = 0;
        for (const x of inv.distance) dev = Math.max(dev, Number.isFinite(x) ? x : Infinity);
        // The other way: the 3D curve's points against the p-curve's image, a polyline of DENSE points per piece
        // (a p-curve collapsed onto one point while its curve isn't passes the first way). Each point's distance
        // to the polyline less the polyline's own error (its chords' midpoints off the image) is a lower bound.
        const dense: number[] = [], mids: number[] = [];
        for (let k = 0; k < tr.length; k += 2) {
          for (let i = 0; i <= 2 * (DENSE - 1); i++) {
            (i % 2 ? mids : dense).push(tr[k]! + (tr[k + 1]! - tr[k]!) * i / (2 * (DENSE - 1)));
          }
        }
        const img = (ts2: number[]) => {
          const e2 = g.evalCoedge(c, ts2, 0).values, q: number[] = [];
          for (let i = 0; i < ts2.length; i++) q.push(e2[3 * i]!, e2[3 * i + 1]!);
          return g.evalSurface(sf, q, 0).values;
        };
        const P = img(dense), M = img(mids);
        let chordErr = 0;
        const segs: number[] = [];
        for (let k = 0, j = 0; k < tr.length / 2; k++) {
          for (let i = 0; i < DENSE - 1; i++, j++) {
            const a = 3 * (k * DENSE + i);
            segs.push(a);
            chordErr = Math.max(chordErr, segDist(M, 3 * j, P, a, a + 3));
          }
        }
        const cts: number[] = [];
        for (let i = 0; i < SAMPLES; i++) cts.push(rlo + (rhi - rlo) * i / (SAMPLES - 1));
        const C = g.evalCurve(ci, cts, 0).values;
        let back = 0;
        for (let i = 0; i < SAMPLES; i++) {
          let best = Infinity;
          for (const a of segs) best = Math.min(best, segDist(C, 3 * i, P, a, a + 3));
          back = Math.max(back, best - chordErr);
        }
        if (back > dev) tally(R.backward, `${ratioBin(back / tol)}, ${mmBin(back)}, forward ${ratioBin(dev / tol)} `
          + `(${sk})`,
          back > tol ? `${cat}: ${back.toExponential(2)} back, ${dev.toExponential(2)} forward, chords `
          + `${chordErr.toExponential(1)}` : undefined);
        dev = Math.max(dev, back);
        // Same parameter: the p-curve at the parameter an affine map of the edge's range onto its own gives, through
        // the surface, against the curve at t (the map either way round: the use's direction aside). Where the image
        // is within tol and this isn't, the p-curve is right but parameterized otherwise (healing's to
        // reparameterize, not to replace or grow). Single-piece uses only.
        if (tr.length === 2) {
          let sp = Infinity;
          for (const flip of [false, true]) {
            const sts = cts.map((t) => {
              const k = (t - rlo) / (rhi - rlo);
              return flip ? tr[1]! + (tr[0]! - tr[1]!) * k : tr[0]! + (tr[1]! - tr[0]!) * k;
            });
            const Q = img(sts);
            let worst = 0;
            for (let i = 0; i < SAMPLES; i++) worst = Math.max(worst, dist(Q, 3 * i, C, 3 * i));
            sp = Math.min(sp, worst);
          }
          // And with no map at all: the p-curve's own parameter is the curve's (Part 42's surface curve as the
          // tessellator takes it).
          const Q0 = img(cts);
          let sp0 = 0;
          for (let i = 0; i < SAMPLES; i++) sp0 = Math.max(sp0, dist(Q0, 3 * i, C, 3 * i));
          const kind = !(dev <= tol) ? 'image off' : sp0 <= tol ? 'image within tol, the same parameter'
            : sp <= tol ? 'image within tol, an affine reparameterization' : 'image within tol, not affine';
          tally(R.sameParameter, `${kind} (${sk})`, kind.endsWith('the same parameter') || kind === 'image off'
            ? undefined : `${cat}: identical ${sp0.toExponential(2)}, affine ${sp.toExponential(2)} at tol `
            + `${tol.toExponential(1)}`);
        } else {
          tally(R.sameParameter, `several pieces, not measured (${sk})`);
        }
        tally(R.given, `${ratioBin(dev / tol)} (${sk})`, dev > tol ? `${cat}: ${dev.toExponential(2)} at tol `
          + `${tol.toExponential(1)}` : undefined);
        // Its ends (the first and last sample) against the edge's vertices, matched either way round.
        let egap = 0;
        if (vs.length === 2) {
          const n = ts.length - 1, a = 3 * vs[0]!, b = 3 * vs[1]!;
          const x = Math.max(dist(xyz, 0, p, a), dist(xyz, 3 * n, p, b));
          const y = Math.max(dist(xyz, 0, p, b), dist(xyz, 3 * n, p, a));
          egap = Math.min(x, y);
          tally(R.ends, `${ratioBin(egap / tol)} (${sk})`, egap > tol ? `${cat}: ${egap.toExponential(2)}`
            : undefined);
        }
        const keepNeed = Math.max(need, dev, egap);
        why(e, { 'vertex off its curve': vgap, 'curve off its surface': proj?.offSurface ?? 0,
          'given p-curve off its curve': dev, 'given p-curve ends off its vertices': egap });
        max(keep, e, keepNeed);
        const better = projErr < Math.max(dev, egap);
        if (dev > tol || egap > tol) {
          tally(R.better, !proj || Number.isNaN(projErr) ? `given off, projection ${proj?.status ?? pr.status}`
            : `given off, projection ${proj.status} and ${better ? 'nearer' : 'not nearer'}`, cat);
        }
        max(repl, e, better ? Math.max(need, projErr) : keepNeed);
      }
    }
  }
  for (let e = 0; e < ne; e++) {
    if (!used[e]) continue;
    R.edges++;
    const tol = edgeTol(e);
    const ex = (x: number) => x > tol ? `${where} edge ${e}: ${x.toExponential(2)} at tol ${tol.toExponential(1)}`
      : undefined;
    tally(R.keep, ratioBin(keep[e]! / tol), ex(keep[e]!));
    tally(R.replace, ratioBin(repl[e]! / tol), ex(repl[e]!));
    if (!(keep[e]! <= Math.max(tol, focus))) {
      R.focus.push(`${where} edge ${e} (id ${d.edge.id[e]}): needs ${keep[e]!.toExponential(2)} at tol `
        + `${tol.toExponential(1)}, by ${cause[e]}\n${(detail[e] ?? []).join('\n')}`);
    }
    if (keep[e]! > tol) tally(R.keepMm, mmBin(keep[e]!)), tally(R.cause, `${cause[e] ?? '?'}: ${mmBin(keep[e]!)}`,
      ex(keep[e]!));
    if (repl[e]! > tol) tally(R.replaceMm, mmBin(repl[e]!));
  }
  return { keep, edgeTol };
}

const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];
/** A unit vector perpendicular to t (non-zero). */
function perpendicular(t: number[]): number[] {
  const axis = Math.abs(t[0]!) <= Math.abs(t[1]!) && Math.abs(t[0]!) <= Math.abs(t[2]!) ? [1, 0, 0]
    : Math.abs(t[1]!) <= Math.abs(t[2]!) ? [0, 1, 0] : [0, 0, 1];
  const c = cross(t, axis), n = Math.hypot(c[0]!, c[1]!, c[2]!);
  return c.map((x) => x / n);
}

/**
 * A planted bug in a copy of the part's model, on its first edge within its tolerance that the plant applies to, by
 * 10 x the edge's tolerance: PLANT=vertex moves the edge's start vertex off its curve (perpendicular to the curve's
 * tangent there); PLANT=curve moves a line edge's curve off its face's surface (along the surface's normal at the
 * line's foot of its point, less any part along the line); PLANT=pcurve moves a given line p-curve sideways in (u, v)
 * by as much in 3D. Each must make the edge need more than its tolerance (listed where it doesn't).
 */
function plantPart(d: BrepData, where: string, keep: Float64Array, R: Result) {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const { edgeTol } = measureTolerances(d);
  for (let c = 0; c < rowCount(d, 'coedge'); c++) {
    const e = d.coedge.edge[c]!, ci = d.edge.curve[e]!, tol = edgeTol(e);
    if (ci < 0 || !(keep[e]! <= tol)) continue;
    const shift = 10 * tol, copy = openBrep(d.buffer.slice(0));
    if (plant === 'vertex') {
      const v = d.edge.start[e]!;
      if (v < 0 || v === d.edge.end[e]) continue;
      const pt = [...d.vertex.point.subarray(3 * v, 3 * v + 3)], info = g.curveInfo(ci);
      const lo = Number.isFinite(info.lo) ? info.lo : -1e9, hi = Number.isFinite(info.hi) ? info.hi : 1e9;
      const t = g.invertCurve(ci, pt, lo, hi, tol).params[0]!;
      const dv = [...g.evalCurve(ci, [t], 1).values.subarray(3, 6)], n = perpendicular(dv);
      for (let k = 0; k < 3; k++) copy.vertex.point[3 * v + k] = pt[k]! + shift * n[k]!;
    } else if (plant === 'curve') {
      if (d.curve.kind[ci] !== CURVE_KIND.line || d.curve.dim[ci] !== 3) continue;
      const r = d.curve.real[ci]!, pt = [...d.pool.curveReal.subarray(r, r + 3)];
      const dir = [...d.pool.curveReal.subarray(r + 3, r + 6)];
      let f = -1;
      for (let l = 0; l < rowCount(d, 'loop') && f < 0; l++) {
        if (c >= d.loop.first[l]! && c < d.loop.first[l]! + d.loop.count[l]! && d.loop.kind[l] === LOOP_KIND.edge) {
          for (let x = 0; x < rowCount(d, 'face'); x++)
            if (l >= d.face.firstLoop[x]! && l < d.face.firstLoop[x]! + d.face.loopCount[x]!) f = x;
        }
      }
      if (f < 0) continue;
      const sf = d.face.surface[f]!, si = g.surfaceInfo(sf);
      const box = [si.u[0], si.u[1], si.v[0], si.v[1]].map((x, i) => Number.isFinite(x) ? x : i % 2 ? 1e9 : -1e9);
      const uv = g.invertSurface(sf, pt, box, tol).params;
      const nrm = [...g.surfaceNormal(sf, [uv[0]!, uv[1]!]).values.subarray(0, 3)];
      const along = nrm[0]! * dir[0]! + nrm[1]! * dir[1]! + nrm[2]! * dir[2]!;
      const m = nrm.map((x, k) => x - along * dir[k]!), mn = Math.hypot(m[0]!, m[1]!, m[2]!);
      if (!(mn > 0.5)) continue;
      for (let k = 0; k < 3; k++) copy.pool.curveReal[r + k] = pt[k]! + shift * m[k]! / mn;
    } else {
      const pc = d.coedge.pcurve[c]!;
      if (pc < 0 || d.curve.kind[pc] !== CURVE_KIND.line || d.curve.dim[pc] !== 2) continue;
      const r = d.curve.real[pc]!, [pu, pv, du, dv] = [...d.pool.curveReal.subarray(r, r + 4)] as number[];
      let sf = -1;
      for (let x = 0; x < rowCount(d, 'face') && sf < 0; x++) {
        for (let l = d.face.firstLoop[x]!; l < d.face.firstLoop[x]! + d.face.loopCount[x]!; l++)
          if (c >= d.loop.first[l]! && c < d.loop.first[l]! + d.loop.count[l]!) sf = d.face.surface[x]!;
      }
      if (sf < 0) continue;
      const ev = g.evalSurface(sf, [pu!, pv!], 1).values;
      const side = [0, 1, 2].map((k) => -dv! * ev[3 + k]! + du! * ev[6 + k]!), sn = Math.hypot(...side);
      if (!(sn > 0)) continue;
      copy.pool.curveReal[r] = pu! - dv! * shift / sn, copy.pool.curveReal[r + 1] = pv! + du! * shift / sn;
    }
    const at = `${where} PLANT=${plant} edge ${e} (coedge ${c})`;
    R.planted.push(at);
    const got = measurePart(copy, where, fresh()).keep[e]!;
    if (!(got > tol)) R.missed.push(`${at}: needs ${got.toExponential(2)} at tol ${tol.toExponential(1)}`);
    return;
  }
}

/**
 * tolerance.h's rule for a part's model: an edge's tolerance, the largest of the part's uncertainty (else 1e-5 mm),
 * its own and 1e-9 x the part's size.
 */
function measureTolerances(d: BrepData) {
  const nv = rowCount(d, 'vertex'), p = d.vertex.point;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 3 * nv; i++) lo[i % 3] = Math.min(lo[i % 3]!, p[i]!), hi[i % 3] = Math.max(hi[i % 3]!, p[i]!);
  const floor = nv ? 1e-9 * Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) : 0;
  const unc = d.part.uncertainty[0]!, partTol = Math.max(Number.isFinite(unc) ? unc : 1e-5, floor);
  const edgeTol = (e: number) => {
    const t = d.edge.tolerance[e]!;
    return Number.isFinite(t) && t > partTol ? t : partTol;
  };
  return { edgeTol };
}

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    module = await init();
  },
  async file(file) {
    const R = fresh();
    if (fs.statSync(file).size > maxMB * 1e6) return R;
    R.files++;
    const started = Date.now(), name = shortName(file);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(file)));
    for (const part of scene.parts) {
      const source = part.brep?.model;
      if (!source) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      let d = source;
      if (heal) {
        const t = Date.now(), h = await healPart(source, { fixes: healFixes }, module);
        R.healMs += Date.now() - t;
        d = h.model;
        for (const x of h.diagnostics) tally(R.healed, x.message.replace(/:.*/, '') + ` (${x.severity})`, `${where}: `
          + x.message.slice(0, 300));
      }
      const { keep } = measurePart(d, where, R);
      if (plant && plantedPart(where)) plantPart(d, where, keep, R);
    }
    R.ms = Date.now() - started;
    R.slowest.push(`${(R.ms / 1000).toFixed(1)} s ${name}`);
    return R;
  },
};

function printTally(title: string, t: Tally) {
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.n}  ${k}`);
    for (const e of v.ex) console.log(`      ${e}`);
  }
}

if (import.meta.main) {
  console.log(await hostLine());
  const started = Date.now();
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else addInto(all, out.result);
    });
  console.log(`${all.files} files, ${all.parts} B-rep parts, ${all.faces} faces, ${all.coedges} coedges, `
    + `${all.edges} edges with 3D curves; ${((Date.now() - started) / 1000).toFixed(0)} s wall, `
    + `${(all.ms / 1000).toFixed(0)} s in files; SAMPLES=${SAMPLES}`);
  if (plant) {
    console.log(`PLANT=${plant}: ${all.planted.length} parts planted, ${all.planted.length - all.missed.length} seen`);
    for (const m of all.missed) console.log(`  not seen: ${m}`);
  }
  console.log('Slowest files: ' + all.slowest.sort((a, b) => parseFloat(b) - parseFloat(a)).slice(0, 8).join('; '));
  if (heal) {
    console.log(`HEAL=${heal}: healing took ${(all.healMs / 1000).toFixed(1)} s in files`);
    printTally('Healing\'s diagnostics (cad-heal), by fix', all.healed);
  }
  printTally('Faces by the face API\'s status and surface', all.faceStatus);
  printTally('Projection of each coedge\'s 3D curve (status, method; p-curve given or missing; surface)',
    all.projection);
  printTally('Missing p-curves on planes', all.planes);
  printTally('Given p-curves: deviation from the 3D curve (sampled), by surface', all.given);
  printTally('Given p-curves: ends against the edge\'s vertices', all.ends);
  printTally('Given p-curves: same parameter (an affine map of the ranges), by the image', all.sameParameter);
  printTally('Given p-curves farther the other way (the curve\'s points from the p-curve\'s image)', all.backward);
  printTally('Edges\' vertices against their 3D curves (per coedge)', all.vertices);
  printTally('Given p-curves off their curve or vertices: is the projection better?', all.better);
  printTally('Coedges projected singular or without a range: classified', all.degenerate);
  printTally('Edges: tolerance needed keeping the source\'s p-curves (grow)', all.keep);
  printTally('Edges: tolerance needed replacing given p-curves where the projection is nearer', all.replace);
  printTally('Edges needing growth (keep), by the tolerance they need', all.keepMm);
  if (Number.isFinite(focus)) {
    console.log(`\n## Edges needing more than their tolerance and ${focus} mm (FOCUS), in detail`);
    for (const x of all.focus) console.log(x);
  }
  printTally('Edges needing growth (keep), by what sets it and the tolerance needed', all.cause);
  printTally('Edges needing growth (replace), by the tolerance they need', all.replaceMm);
}
