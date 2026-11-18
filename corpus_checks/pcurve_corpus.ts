// cad-geom's projection (projectCurve, through its WebAssembly module's projectCoedge) on every coedge of every face
// of every part's B-rep model in the corpus: each coedge's edge curve projected onto its face's surface over its edge's
// range, as the face API does where the model has no p-curve, whether or not it has one.
//   - What was made: status and method by surface kind, the error against the tolerance (cad-geom's tolerance.h: the
//     largest of the part's uncertainty, the edge's and 1e-9 x the part's size, else 1e-7 mm), ambiguous feet;
//     failures listed.
//   - Against the model's own p-curve where it has one, at 7 parameters of the edge's curve: the model's p-curve off
//     its curve there (not at the curve's parameter, against Part 42, or off: the source's); else both in 3D within
//     10 x tol and in (u, v) the same, a whole number of periods apart, or neither (a pole's free parameter, a surface
//     that isn't one-to-one).
//   - Seams (an edge the face uses twice): whether each use's copy is the model's, which step-import gave it by its
//     side test (brep.ts's seamPcurve), so the rule (seamUseTakesTwin) against the importer's on the corpus. Judged
//     by the edge's two uses together: both a whole period from the model's is the face's (u, v) a period over (a
//     model's domain of [-2 pi, 0]), the same copies; only uses apart by different periods are on the other copies.
//   - OCCT=1: OCCT's p-curve of the same coedge (tess-occt's probe, the part built by the native builder, unhealed),
//     recording its route: the built shape's own (the model's p-curve: OCCT echoing the model), computed on request (a
//     plane's), or made by ShapeFix_Edge::FixAddPCurve (OCCT projecting). Each one's 3D error at OCCT's 7 parameters
//     against ours, by route; and where OCCT's (u, v) is ours or maps affinely (cones: v' = v / cos a), OCCT's points
//     against ours at the same 3D points (inverted onto our curve), seams' copies included.
// Planted bugs in about one part in 10 (corpus.ts's plantedPart; PLANT_EVERY=n one in n, 1 every part), each of
// which must show (those that don't are listed): PLANT=swap swaps the model's p-curves of the first seam's two uses
// (each use then on the other copy), PLANT=shift moves the first line p-curve 0.01 along u (off its curve);
// PLANT_FACE=id plants on that face (its source id) alone.
// Usage: node --max-old-space-size=8192 corpus_checks/pcurve_corpus.ts [file-list.txt] [max MB]
//   OCCT=1 the OCCT comparison (a native build per part). Several files at once (runner.ts: CHILDREN).
import fs from 'node:fs';
import path from 'node:path';
import { type BrepData, CURVE_KIND, LOOP_KIND, openBrep, ORIENTATION, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { Geometry, init, type GeomModule, type Pcurve } from '../packages/cad-geom/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: GeomModule;
const plant = process.env.PLANT, withOcct = process.env.OCCT === '1';
const plantEvery = Number(process.env.PLANT_EVERY ?? 10), plantFace = Number(process.env.PLANT_FACE ?? 0);
if (plant && !['swap', 'shift'].includes(plant)) throw new Error(`PLANT=${plant}: swap, shift`);
const SKIND = Object.fromEntries(Object.entries(SURFACE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;
/** The parameters compared: 7 midpoints of equal steps over the edge's range (ends left out: a pole, a joint). */
const N = 7;

/** Counts by key, and up to 5 examples each (EXAMPLES=n: n, to look into a run). */
const examples = Number(process.env.EXAMPLES ?? 5);
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, key: string, ex?: string) => {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (ex && e.ex.length < examples) e.ex.push(ex);
};
const fresh = () => ({
  files: 0, parts: 0, faces: 0, coedges: 0, planted: 0, caught: [] as string[], plantedAt: [] as string[],
  made: {} as Tally, error: {} as Tally, ambiguous: {} as Tally, model: {} as Tally, seam: {} as Tally,
  occtRoute: {} as Tally, occtError: {} as Tally, occtUv: {} as Tally, occtSeam: {} as Tally,
  occtLoop: {} as Tally, gap: {} as Gaps,
});
type Result = ReturnType<typeof fresh>;

/**
 * invalidModel uses by their gap from the surface against a reference: counts, and the parts (`file #id`) they're in,
 * to tell rounding-level gaps a tolerance floor would clear from real ones.
 */
type Gaps = Record<string, { n: number; parts: string[] }>;
const gapTally = (t: Gaps, key: string, part: string) => {
  const e = t[key] ??= { n: 0, parts: [] };
  e.n++;
  if (!e.parts.includes(part)) e.parts.push(part);
};
/** gap against ref (none: no reference) as a bucket. */
const against = (gap: number, ref: number) => !(ref > 0 && Number.isFinite(ref)) ? 'none' : gap <= ref ? 'within'
  : gap <= 10 * ref ? '1-10 x' : gap <= 100 * ref ? '10-100 x' : gap <= 1000 * ref ? '100-1000 x' : 'over 1000 x';

/** x against tol as a bucket. */
const bucket = (x: number, tol: number) => !(x <= tol) ? (x <= 10 * tol ? '1-10 x tol' : x <= 100 * tol
  ? '10-100 x tol' : 'over 100 x tol') : x <= 0.01 * tol ? 'under 0.01 x tol' : x <= 0.1 * tol ? '0.01-0.1 x tol'
  : '0.1-1 x tol';

// tess-occt's probe (build-probe.sh): a part built by the native builder, edges' p-curves on its faces.
interface ProbeModule { HEAPU8: Uint8Array; HEAPF64: Float64Array; _malloc(n: number): number; _free(p: number): void;
  _occt_probe_build(p: number, n: number): number;
  _occt_probe_pcurve(face: number, edge: number, tol: number, n: number, out: number, info: number): number;
  _occt_probe_free(): void }
let probe: ProbeModule | undefined;
const PROBE = path.join(import.meta.dirname, '../packages/tess-occt/dist/occt_probe.mjs');
const loadProbe = async () => {
  probe = await ((await import(PROBE)) as { default: () => Promise<ProbeModule> }).default();
};
const ROUTE = ['the shape\'s own (the model\'s: OCCT echoing it)', 'computed on request (a plane\'s)',
  'ShapeFix_Edge::FixAddPCurve (OCCT projecting)'];

/** OCCT's p-curves of the edge on the face (occt_probe_pcurve): its status, info and out, as the probe gives them. */
function occtPcurve(face: number, edge: number, tol: number): { r: number; info: Float64Array; out: Float64Array } {
  const m = probe!, size = 4 * N + 2 * (3 * N + 4), out = m._malloc(8 * size), info = m._malloc(32);
  try {
    const r = m._occt_probe_pcurve(face, edge, tol, N, out, info);
    return { r, info: m.HEAPF64.slice(info / 8, info / 8 + 4), out: m.HEAPF64.slice(out / 8, out / 8 + size) };
  } finally {
    m._free(out);
    m._free(info);
  }
}

/**
 * The 3D tolerance projectCoedge takes by default (cad-geom's tolerance.h): the largest of the part's uncertainty,
 * the edge's and 1e-9 x the part's size (`size`, its vertices' box diagonal), else 1e-7.
 */
function edgeTol(d: BrepData, e: number, size: number): number {
  const u = d.part.uncertainty[0], t = d.edge.tolerance[e]!;
  let best = Math.max(Number.isFinite(u) ? u! : 0, Number.isFinite(size) ? 1e-9 * size : 0);
  if (Number.isFinite(t) && t > best) best = t;
  return best > 0 ? best : 1e-7;
}

/**
 * A copy of the model with the first seam's two uses' p-curves swapped (swap), or the first line p-curve moved 0.01
 * along u (shift); undefined where it has none.
 */
function plantPart(d: BrepData, how: string): BrepData | undefined {
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    if (plantFace && d.face.id[f] !== plantFace) continue;
    const byEdge = new Map<number, number[]>();
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        if (d.coedge.pcurve[c]! < 0) continue;
        byEdge.set(d.coedge.edge[c]!, [...(byEdge.get(d.coedge.edge[c]!) ?? []), c]);
        if (how === 'shift' && d.curve.kind[d.coedge.pcurve[c]!] === CURVE_KIND.line) {
          const copy = openBrep(d.buffer.slice(0));
          copy.pool.curveReal[copy.curve.real[d.coedge.pcurve[c]!]!]! += 0.01;  // the line's point's u
          return copy;
        }
      }
    }
    if (how !== 'swap') continue;
    for (const cs of byEdge.values()) {
      if (cs.length !== 2 || d.coedge.pcurve[cs[0]!] === d.coedge.pcurve[cs[1]!]) continue;
      const copy = openBrep(d.buffer.slice(0));
      [copy.coedge.pcurve[cs[0]!], copy.coedge.pcurve[cs[1]!]] = [d.coedge.pcurve[cs[1]!]!, d.coedge.pcurve[cs[0]!]!];
      return copy;
    }
  }
  return undefined;
}

/**
 * How (u, v) b lies from a, sample by sample: the same (k 0), a whole number of periods apart (k per direction), or
 * neither (undefined).
 */
function periodsApart(a: ArrayLike<number>, b: ArrayLike<number>, periods: [number, number], tolUv = 1e-6):
  [number, number] | undefined {
  let k: [number, number] | undefined;
  for (let i = 0; i < a.length / 2; i++) {
    const ki: [number, number] = [0, 0];
    for (const x of [0, 1] as const) {
      const d = b[2 * i + x]! - a[2 * i + x]!, p = periods[x];
      const n = p > 0 ? Math.round(d / p) : 0;
      if (!(Math.abs(d - n * p) <= tolUv * (1 + Math.abs(a[2 * i + x]!)))) return undefined;
      ki[x] = n;
    }
    if (k && (k[0] !== ki[0] || k[1] !== ki[1])) return undefined;
    k = ki;
  }
  return k;
}

/**
 * A seam use's copy against the other side's, judged with the edge's other use on the face: both the same, both a
 * whole number of periods over by the same amount (the face's (u, v) a period over: the same copies), or apart by
 * different amounts (the other copy); a use whose pair wasn't compared by its own k alone.
 */
function settle(us: { k: [number, number] }[], u: { k: [number, number] }): string {
  const zero = !u.k[0] && !u.k[1];
  if (us.length !== 2) return zero ? 'the same copy' : 'a whole number of periods apart, its pair not compared';
  const [a, b] = us as [{ k: [number, number] }, { k: [number, number] }];
  return a.k[0] !== b.k[0] || a.k[1] !== b.k[1] ? 'the other copy' : zero ? 'the same copy'
    : 'the same copies, the face\'s (u, v) a whole number of periods over';
}

const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
  Math.hypot(a[3 * i]! - b[3 * i]!, a[3 * i + 1]! - b[3 * i + 1]!, a[3 * i + 2]! - b[3 * i + 2]!);

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    module = await init();
    if (withOcct) {
      if (!fs.existsSync(PROBE)) throw new Error(`OCCT=1 needs tess-occt's probe: ${PROBE} (build-probe.sh)`);
      await loadProbe();
    }
  },
  async file(file) {
    const R = fresh();
    if (fs.statSync(file).size > maxMB * 1e6) return R;
    R.files++;
    const name = shortName(file);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(file)));
    for (const part of scene.parts) {
      const d = part.brep?.model;
      if (!d) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      using g = new Geometry(module, new Uint8Array(d.buffer));
      // The part's size: its vertices' box diagonal.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < rowCount(d, 'vertex'); v++)
        for (let k = 0; k < 3; k++) {
          const x = d.vertex.point[3 * v + k]!;
          if (Number.isFinite(x)) lo[k] = Math.min(lo[k]!, x), hi[k] = Math.max(hi[k]!, x);
        }
      const size = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!), unc = d.part.uncertainty[0]!;
      // The planted copy: its p-curves compared in place of the model's (the projection doesn't read them).
      const planted = plant && plantedPart(where, plantEvery) ? plantPart(d, plant) : undefined;
      using gm = planted ? new Geometry(module, new Uint8Array(planted.buffer)) : undefined;
      if (planted) R.planted++, R.plantedAt.push(where);
      const dm = planted ?? d, gModel = gm ?? g;
      let seen = false, built = false;
      if (probe) {
        try {
          const p = probe._malloc(d.buffer.byteLength);
          probe.HEAPU8.set(new Uint8Array(d.buffer), p);
          built = probe._occt_probe_build(p, d.buffer.byteLength) === 0;
          probe._free(p);
          if (!built) tally(R.occtRoute, 'the native builder failed on the part', where);
        } catch (e) {
          // A trap leaves the module's state unknown: counted, the part compared without OCCT, the probe reloaded.
          tally(R.occtRoute, `the probe trapped building the part: ${(e as Error).message}`, where);
          await loadProbe();
        }
      }
      for (let f = 0; f < rowCount(d, 'face'); f++) {
        R.faces++;
        const sr = d.face.surface[f]!, sk = SKIND[d.surface.kind[sr]!]!, at = `${where} face #${d.face.id[f]}`;
        const info = g.faceInfo(f), si = g.surfaceInfo(sr);
        const periods: [number, number] = info.status === 'ok' ? [info.uPeriod, info.vPeriod]
          : [si.uPeriod, si.vPeriod];
        const uses = new Map<number, number>();
        // Seam uses whose (u, v) is comparable, by edge: how ours lies from the model's (pairs) and from OCCT's
        // (occtPairs), each use's label; tallied once the face's loops are done (settle), as are OCCT's loops.
        const pairs = new Map<number, { c: number; k: [number, number]; ce: string }[]>();
        const occtPairs = new Map<number, { c: number; k: [number, number]; ce: string; label: string }[]>();
        const occtCopy = new Map<number, string>(), loopTallies: (() => void)[] = [];
        for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
          if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
          for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++)
            uses.set(d.coedge.edge[c]!, (uses.get(d.coedge.edge[c]!) ?? 0) + 1);
        }
        for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
          if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
          // OCCT's loop: each use's (u, v) where it starts and ends, the way it runs (undefined: none made), its route,
          // and whether a seam use of it is on the other copy than ours.
          const occtLoop: ({ s: [number, number]; e: [number, number]; route: number } | undefined)[] = [];
          const seamUses: number[] = [];
          for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
            let occtUse: (typeof occtLoop)[number];
            try {
              R.coedges++;
              const e = d.coedge.edge[c]!, ci = d.edge.curve[e]!, ce = `${at} coedge ${c}`, tol = edgeTol(d, e, size);
              const seam = uses.get(e)! > 1;
              if (ci < 0) { tally(R.made, 'not made: no 3D curve'); continue; }
              const p0 = g.projectCoedge(c);
              if (!('pieces' in p0)) { tally(R.made, `not made: ${p0.status} (${sk})`, ce); continue; }
              const [t0, t1] = p0.range, ts = Array.from({ length: N }, (_, i) => t0 + (t1 - t0) * (i + 0.5) / N);
              const p = g.projectCoedge(c, NaN, ts) as Pcurve, ours = p.takesTwin ? p.twinUv : p.uv;
              tally(R.made, `${p.status}: ${p.method} (${sk})`, p.status === 'ok' ? undefined
                : `${ce}: error ${p.error.toPrecision(3)}, off the surface ${p.offSurface.toPrecision(3)}, tol ${tol}`);
              if (p.status === 'ok') tally(R.error, `${bucket(p.error, tol)} (${p.method})`);
              if (p.status === 'invalidModel') {
                // The gap: how far the curve is off the surface, against the floors a tolerance could take.
                const gap = p.offSurface, ftol = d.face.tolerance[f]!;
                const bySize = against(gap, 1e-9 * size), byUnc = against(gap, unc), byFace = against(gap, ftol);
                gapTally(R.gap, `1e-9 x the part's size: ${bySize}`, where);
                gapTally(R.gap, `the part's uncertainty: ${byUnc}`, where);
                gapTally(R.gap, `the face's tolerance: ${byFace}`, where);
                gapTally(R.gap, !(gap > tol) ? 'within the edge\'s tolerance (invalid for another reason)'
                  : `cleared by: ${[bySize === 'within' ? '1e-9 x size' : '', byUnc === 'within' ? 'uncertainty' : '',
                    byFace === 'within' ? 'face tolerance' : ''].filter(Boolean).join(', ') || 'none'}`, where);
              }
              if (p.certainty === 'ambiguous') tally(R.ambiguous, `${p.method} (${sk})`, ce);
              const ok = p.status === 'ok';
              const curve3 = g.evalCurve(ci, ts, 0).values, s3 = g.evalSurface(sr, ours, 0).values;
              // Against the model's p-curve.
              const row = dm.coedge.pcurve[c]!;
              if (row >= 0) {
                const muv: number[] = [], me = gModel.evalCurve(row, ts, 0).values;
                for (let i = 0; i < N; i++) muv.push(me[3 * i]!, me[3 * i + 1]!);
                const m3 = g.evalSurface(sr, muv, 0).values;
                let mOff = 0, apart = 0;
                for (let i = 0; i < N; i++) {
                  const x = dist3(m3, curve3, i), y = dist3(m3, s3, i);
                  mOff = Math.max(mOff, Number.isFinite(x) ? x : Infinity);
                  apart = Math.max(apart, Number.isFinite(y) ? y : Infinity);
                }
                let cls: string;
                if (!ok) cls = 'ours not ok (above)';
                else if (!(mOff <= 10 * tol)) cls = `the model's p-curve off its curve at the curve's parameters `
                  + `(${bucket(mOff, tol)}): not at its parameter, or off`;
                else if (!(apart <= 10 * tol)) cls = 'ours and the model\'s apart in 3D by over 10 x tol';
                else {
                  const k = periodsApart(muv, ours, periods);
                  cls = !k ? 'within 10 x tol in 3D, not a whole number of periods apart in (u, v)'
                    : k[0] || k[1] ? (seam ? 'a seam\'s use a whole number of periods apart (below)'
                      : 'the same, a whole number of periods apart') : 'the same';
                }
                tally(R.model, `${cls} (${sk})`, cls.startsWith('the same') ? undefined
                  : `${ce}: ${mOff.toPrecision(3)} off its curve, ${apart.toPrecision(3)} from ours`);
                if (planted && !cls.startsWith('the same')) seen = true;
                if (seam) {
                  const k = ok && mOff <= 10 * tol && apart <= 10 * tol ? periodsApart(muv, ours, periods) : undefined;
                  const sc = !ok ? 'ours not ok' : !(p.seamU || p.seamV) ? 'not on a seam by the projection'
                    : !(mOff <= 10 * tol) ? 'the model\'s p-curve off its curve' : !k ? 'not comparable in (u, v)'
                      : undefined;
                  if (sc) tally(R.seam, `${sc} (${sk})`, ce);
                  else pairs.set(e, [...pairs.get(e) ?? [], { c, k: k!, ce }]);
                }
              } else if (seam) tally(R.seam, `no model p-curve: not compared (${sk})`);
              // OCCT.
              if (!built || planted) continue;
              const o = occtPcurve(d.face.id[f]!, d.edge.id[e]!, tol);
              const route = o.info[3]!;
              tally(R.occtRoute, o.r === 0 ? `${ROUTE[route]} (${sk})` : `failed: ${o.r === -1 ? 'not kept' : o.r === -2
                ? 'no p-curve made' : 'an exception'}${route >= 0 ? `, ${ROUTE[route]}` : ''} (${sk})`,
              o.r === 0 ? undefined : ce);
              if (o.r !== 0) continue;
              // The OCCT use that's ours: the face in its surface's sense, a use oriented forward running with t.
              const useForward = (d.coedge.orientation[c] === ORIENTATION.forward) === !!d.edge.sameSense[e];
              const surfaceForward = useForward === !!d.face.sameSense[f];
              const k = o.info[0] === 1 ? 0 : o.info[1] === (surfaceForward ? 1 : 0) ? 0 : 1;
              const base = 4 * N + (3 * N + 4) * k, ends = o.out.subarray(base + 3 * N, base + 3 * N + 4);
              const a: [number, number] = [ends[0]!, ends[1]!], b: [number, number] = [ends[2]!, ends[3]!];
              occtUse = { s: useForward ? a : b, e: useForward ? b : a, route };
              const ouv: number[] = [], pts: number[] = [];
              let oErr = 0;
              for (let i = 0; i < N; i++) {
                const q = o.out.subarray(base + 3 * i, base + 3 * i + 3);
                ouv.push(q[0]!, q[1]!), pts.push(o.out[4 * i + 1]!, o.out[4 * i + 2]!, o.out[4 * i + 3]!);
                oErr = Math.max(oErr, Number.isFinite(q[2]) ? q[2]! : Infinity);
              }
              const both = `${!(oErr <= tol) ? 'OCCT over tol' : 'OCCT within tol'}, ${ok ? 'ours ok' : 'ours not ok'}`;
              tally(R.occtError, `${ROUTE[route]}: ${both}`, oErr <= tol || !ok ? undefined
                : `${ce}: OCCT ${oErr.toPrecision(3)} (${bucket(oErr, tol)})`);
              // (u, v) at the same 3D points, where OCCT's parameterization is ours or maps affinely.
              const map = sk === 'cone' ? 1 / Math.cos(d.pool.surfaceReal[d.surface.real[sr]! + 10]!)
                : ['plane', 'cylinder', 'sphere', 'torus', 'bspline'].includes(sk) ? 1 : 0;
              if (!map || !ok) {
                tally(R.occtUv, !ok ? 'ours not ok: not compared' : `not compared: OCCT's (u, v) differs on ${sk}`);
                continue;
              }
              const inv = g.invertCurve(ci, pts, Math.min(t0, t1), Math.max(t0, t1), tol);
              const q = g.projectCoedge(c, NaN, [...inv.params]) as Pcurve, at2 = q.takesTwin ? q.twinUv : q.uv;
              const mine: number[] = [];
              for (let i = 0; i < N; i++) mine.push(at2[2 * i]!, map * at2[2 * i + 1]!);
              const kk = periodsApart(mine, ouv, [periods[0], map * periods[1]]);
              // Not periods apart: how far OCCT's (u, v) lands from ours through the surface, against tol.
              let far = 0;
              if (!kk) {
                const back: number[] = [];
                for (let i = 0; i < N; i++) back.push(ouv[2 * i]!, ouv[2 * i + 1]! / map);
                const so = g.evalSurface(sr, back, 0).values, sm = g.evalSurface(sr, at2, 0).values;
                for (let i = 0; i < N; i++) far = Math.max(far, Number.isFinite(dist3(so, sm, i)) ? dist3(so, sm, i)
                  : Infinity);
              }
              const cls = !kk ? `not a whole number of periods apart, ${bucket(far, tol)} apart in 3D`
                : !(kk[0] || kk[1]) ? 'the same' : seam ? 'a seam\'s use a whole number of periods apart (below)'
                  : 'the same, a whole number of periods apart';
              tally(R.occtUv, `${cls}: ${ROUTE[route]} (${sk})`, cls === 'the same' ? undefined
                : `${ce}: ours (${mine[0]}, ${mine[1]}), OCCT (${ouv[0]}, ${ouv[1]}), tol ${tol}`);
              if (seam) {
                // By the face's, the edge's and the use's senses, to tell which OCCT's choice follows.
                const senses = `face ${d.face.sameSense[f] ? '+' : '-'}, edge ${d.edge.sameSense[e] ? '+' : '-'}, use `
                  + (d.coedge.orientation[c] === ORIENTATION.forward ? 'forward' : 'reversed');
                const label = `${ROUTE[route]}; ${senses} (${sk})`;
                if (!kk) tally(R.occtSeam, `not comparable: ${label}`, ce);
                else occtPairs.set(e, [...occtPairs.get(e) ?? [], { c, k: kk, ce, label }]);
                seamUses.push(c);
              }
            } finally {
              occtLoop.push(occtUse);
            }
          }
          // OCCT's loop, joint by joint: meeting in (u, v), a whole number of periods apart, a jump along a pole line
          // (OCCT's parameters: a cone's v scaled), or apart (by how much, the widest).
          if (built && !planted && occtLoop.length) {
            let cls: string;
            if (occtLoop.some((x) => !x)) cls = 'not every use\'s p-curve made or compared';
            else {
              const map = sk === 'cone' ? 1 / Math.cos(d.pool.surfaceReal[d.surface.real[sr]! + 10]!) : 1;
              const poles = info.status === 'ok' ? info.poles : [];
              let scale = 1, period = false, pole = false, widest = 0;
              for (const u of occtLoop) scale = Math.max(scale, Math.abs(u!.e[0]), Math.abs(u!.e[1]));
              const eps = 1e-6 * scale;
              for (let i = 0; i < occtLoop.length; i++) {
                const x = occtLoop[i]!.e, y = occtLoop[(i + 1) % occtLoop.length]!.s;
                const du = y[0] - x[0], dv = y[1] - x[1];
                if (Math.hypot(du, dv) <= eps) continue;
                const ru = periods[0] > 0 ? du - periods[0] * Math.round(du / periods[0]) : du;
                const rv = periods[1] > 0 ? dv - map * periods[1] * Math.round(dv / (map * periods[1])) : dv;
                if (Math.hypot(ru, rv) <= eps) { period = true; continue; }
                const on = (z: [number, number], q: { isoU: boolean; at: number }) =>
                  Math.abs((q.isoU ? z[0] : z[1] / map) - q.at) <= eps;
                if (poles.some((q) => on(x, q) && on(y, q))) { pole = true; continue; }
                widest = Math.max(widest, Math.hypot(ru, rv));
              }
              cls = widest > 0 ? `with joints apart in (u, v) (the widest ${widest < 1e-4 ? 'under 1e-4'
                : widest < 1e-2 ? '1e-4 to 1e-2' : 'over 1e-2'})` : [period ? 'joints a whole period apart' : '',
                pole ? 'jumps along a pole line' : ''].filter(Boolean).join(' and ') || 'continuous';
              if (cls !== 'continuous' && !widest) cls = `continuous but for ${cls}`;
            }
            const routes = occtLoop.some((x) => x?.route === 2) ? 'some uses by FixAddPCurve' : 'none by FixAddPCurve';
            const ex = `${at} loop ${l - d.face.firstLoop[f]!}`;
            loopTallies.push(() => {
              const otherCopy = seamUses.some((c) => occtCopy.get(c) === 'the other copy');
              tally(R.occtLoop, `${cls}; ${otherCopy ? 'a seam use on the other copy than ours' : seamUses.length
                ? 'seam uses on our copies' : 'no seam'}; ${routes} (${sk})`, cls === 'continuous' && !otherCopy
                ? undefined : ex);
            });
          }
        }
        for (const [, us] of pairs)
          for (const u of us) {
            const sc = settle(us, u);
            tally(R.seam, `${sc}: the rule ${sc === 'the other copy' ? 'against' : 'agrees with'} step-import's `
              + `side test (${sk})`, sc.startsWith('the same') ? undefined : u.ce);
          }
        for (const [, us] of occtPairs)
          for (const u of us) {
            const sc = settle(us, u);
            occtCopy.set(u.c, sc);
            tally(R.occtSeam, `${sc}: ${u.label}`, sc.startsWith('the same') ? undefined : u.ce);
          }
        for (const t of loopTallies) t();
      }
      if (probe) probe._occt_probe_free();
      if (seen) R.caught.push(where);
    }
    return R;
  },
};

function printGaps(title: string, t: Gaps) {
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(t).sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const files = new Set(v.parts.map((w) => w.slice(0, w.lastIndexOf(' #'))));
    console.log(`  ${v.n} uses, ${v.parts.length} parts, ${files.size} files  ${k}`);
  }
}

function printTally(title: string, t: Tally) {
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.n}  ${k}`);
    for (const e of v.ex.slice(0, examples)) console.log(`      ${e}`);
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
  const caught = new Set(all.caught);
  console.log(`${all.files} files, ${all.parts} B-rep parts, ${all.faces} faces, ${all.coedges} coedges`
    + `${withOcct ? ', with OCCT' : ''}; ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (plant) {
    console.log(`PLANT=${plant}: ${all.planted} parts planted, ${caught.size} seen`);
    for (const w of all.plantedAt) if (!caught.has(w)) console.log(`  not seen: ${w}`);
  }
  printTally('Projections made, by status, method and surface', all.made);
  printTally('The error of those ok, against the tolerance', all.error);
  printTally('Ambiguous feet', all.ambiguous);
  printGaps('invalidModel: the gap off the surface against 1e-9 x the part\'s size (its vertices\' box), its '
    + 'uncertainty and the face\'s tolerance', all.gap);
  printTally('Against the model\'s p-curves, at the curve\'s parameters', all.model);
  printTally('Seams: each use\'s copy against the model\'s (step-import\'s side test)', all.seam);
  if (withOcct) {
    printTally('OCCT: the route its p-curve took', all.occtRoute);
    printTally('OCCT: its 3D error at its parameters against the tolerance, and ours', all.occtError);
    printTally('OCCT: its (u, v) against ours at the same 3D points', all.occtUv);
    printTally('OCCT: seams\' copies against ours, by the face\'s, edge\'s and use\'s senses', all.occtSeam);
    printTally('OCCT: its loops in (u, v), joint to joint', all.occtLoop);
  }
}
