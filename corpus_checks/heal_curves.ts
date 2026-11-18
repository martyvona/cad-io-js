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
//   SAMPLES=n points per piece (default 17), DENSE=n points per piece of the p-curve's image (default 129). Several files at once (runner.ts: CHILDREN).
import fs from 'node:fs';
import { CURVE_KIND, LOOP_KIND, rowCount, SURFACE_KIND } from '../packages/cad-brep/src/index.ts';
import { Geometry, init, type GeomModule, type Pcurve } from '../packages/cad-geom/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: GeomModule;
const SAMPLES = Number(process.env.SAMPLES ?? 17), DENSE = Number(process.env.DENSE ?? 129);
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
  files: 0, parts: 0, faces: 0, coedges: 0, edges: 0, ms: 0, slowest: [] as string[],
  projection: {} as Tally, given: {} as Tally, ends: {} as Tally, vertices: {} as Tally, faceStatus: {} as Tally,
  keep: {} as Tally, replace: {} as Tally, keepMm: {} as Tally, replaceMm: {} as Tally, planes: {} as Tally,
  better: {} as Tally, degenerate: {} as Tally, cause: {} as Tally, backward: {} as Tally,
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
      const d = part.brep?.model;
      if (!d) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      using g = new Geometry(module, new Uint8Array(d.buffer));
      // tolerance.h's rule.
      const nv = rowCount(d, 'vertex'), p = d.vertex.point;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 3 * nv; i++) lo[i % 3] = Math.min(lo[i % 3]!, p[i]!), hi[i % 3] = Math.max(hi[i % 3]!, p[i]!);
      const floor = nv ? 1e-9 * Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) : 0;
      const unc = d.part.uncertainty[0]!, partTol = Math.max(Number.isFinite(unc) ? unc : 1e-5, floor);
      const edgeTol = (e: number) => {
        const t = d.edge.tolerance[e]!;
        return Number.isFinite(t) && t > partTol ? t : partTol;
      };
      // Per edge: the worst of each kind over its coedges.
      const ne = rowCount(d, 'edge');
      // An edge with any coedge not measured (a projection not ok, a given p-curve not sampled) has NaN for good.
      const off = new Float64Array(ne), keep = new Float64Array(ne), repl = new Float64Array(ne);
      const used = new Uint8Array(ne), cause: string[] = [];
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
              why(e, { 'vertex off its curve': vgap, 'curve off its surface': proj?.offSurface ?? 0,
                'projection error past offSurface': projErr });
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
            if (back > dev) tally(R.backward, `the curve's points farther than the p-curve's (${sk})`,
              back > tol ? `${cat}: ${back.toExponential(2)} back, ${dev.toExponential(2)} forward, chords `
              + `${chordErr.toExponential(1)}` : undefined);
            dev = Math.max(dev, back);
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
        if (keep[e]! > tol) tally(R.keepMm, mmBin(keep[e]!)), tally(R.cause, `${cause[e] ?? '?'}: ${mmBin(keep[e]!)}`,
          ex(keep[e]!));
        if (repl[e]! > tol) tally(R.replaceMm, mmBin(repl[e]!));
      }
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
  console.log('Slowest files: ' + all.slowest.sort((a, b) => parseFloat(b) - parseFloat(a)).slice(0, 8).join('; '));
  printTally('Faces by the face API\'s status and surface', all.faceStatus);
  printTally('Projection of each coedge\'s 3D curve (status, method; p-curve given or missing; surface)',
    all.projection);
  printTally('Missing p-curves on planes', all.planes);
  printTally('Given p-curves: deviation from the 3D curve (sampled), by surface', all.given);
  printTally('Given p-curves: ends against the edge\'s vertices', all.ends);
  printTally('Given p-curves farther the other way (the curve\'s points from the p-curve\'s image)', all.backward);
  printTally('Edges\' vertices against their 3D curves (per coedge)', all.vertices);
  printTally('Given p-curves off their curve or vertices: is the projection better?', all.better);
  printTally('Coedges projected singular or without a range: classified', all.degenerate);
  printTally('Edges: tolerance needed keeping the source\'s p-curves (grow)', all.keep);
  printTally('Edges: tolerance needed replacing given p-curves where the projection is nearer', all.replace);
  printTally('Edges needing growth (keep), by the tolerance they need', all.keepMm);
  printTally('Edges needing growth (keep), by what sets it and the tolerance needed', all.cause);
  printTally('Edges needing growth (replace), by the tolerance they need', all.replaceMm);
}
