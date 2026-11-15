// cad-geom's curves (packages/cad-geom, its WebAssembly module) over the corpus's B-rep models (step-import's), every
// 3D and 2D curve of every part, against cad-brep's geometry.ts (a second opinion, not ground truth: its offsets'
// derivatives are central differences, its nearest points a sampled search) and, with OCCT=1, OCCT's perimeters:
//   - points and first derivatives at sample parameters (7 inside a bounded range, 5 about 0 on an unbounded one),
//     differences relative to max(1, |value|) by bucket and curve kind; derivatives at a break skipped and counted (a
//     one-sided derivative there, geometry.ts's an average), offsets' derivatives apart (geometry.ts's a difference);
//   - every edge's vertices inverted onto its curve: cad-geom's invertCurve over the curve's domain within the part's
//     uncertainty against geometry.ts's param() (closed form or sampled), classified by which found the nearer foot;
//     distances by bucket (the model's own vertex gaps), certainties, alternatives, seams flagged, statuses;
//   - every edge's range by edgeParams's rules from cad-geom's vertex parameters, against geometry.ts's own;
//   - every edge's length by arcLength over that range, statuses and estimated errors by
//     bucket; in about one edge in 20 (by a hash of where it is) the estimate's honesty against chord sums
//     (Richardson-extrapolated over 2^10, 2^11 and 2^12 chords a span);
//   - OCCT=1: each face's perimeter (tess-occt's measures: BRepGProp over OCCT's healed pieces) against the sum of
//     cad-geom's lengths over the face's coedges, differences classified by cause (docs/healing.md: a seam healing
//     adds is counted twice; a face with several outer loops is split, its pieces' perimeters summed; a face OCCT
//     finds invalid; ours incomplete).
// Planted bugs in about one part in 10 (corpus.ts's plantedPart), each of which must show (those that don't are
// listed): PLANT=curve changes cad-geom's copy of the part's first line, circle or B-spline (a line's point by
// 1e-3 mm, a radius by 1e-3 of it, the middle pole by 1e-3 mm: seen where a point differs by over 1e-5 mm),
// PLANT=vertex moves the first edge vertex by 0.01 mm in both copies, PLANT=length takes 1e-6 of a sampled edge's
// length off its estimate.
// Usage: node --max-old-space-size=8192 corpus_checks/geom_curves.ts [file-list.txt] [max MB]
//   OCCT=1 also the perimeters (a meshing pass per part). Several files at once (runner.ts: CHILDREN).
import fs from 'node:fs';
import { type BrepData, BOUND, CURVE_KIND, LOOP_KIND, openBrep, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { curveEvaluator, type CurveEvaluator, edgeParams } from '../packages/cad-brep/src/geometry.ts';
import { CERTAINTY, Geometry, init, STATUS, type GeomModule } from '../packages/cad-geom/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: GeomModule, occt: OcctTessellator | undefined;
const plant = process.env.PLANT, withOcct = process.env.OCCT === '1';
if (plant && !['curve', 'vertex', 'length'].includes(plant)) throw new Error(`PLANT=${plant}: curve, vertex, length`);
const KIND = Object.fromEntries(Object.entries(CURVE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;
const REL = [1e-14, 1e-12, 1e-10, 1e-8, 1e-6, Infinity];
const ABS = [1e-9, 1e-7, 1e-5, 1e-3, 1e-1, Infinity];
type Worst = { d: number; where: string }[];
type Hist = { counts: number[]; worst: Worst };
const hist = (n: number): Hist => ({ counts: new Array(n).fill(0), worst: [] });
const record = (h: Hist, buckets: number[], d: number, where: string) => {
  h.counts[buckets.findIndex((b) => d <= b)]!++;
  h.worst.push({ d, where });
  if (h.worst.length > 40) { h.worst.sort((a, b) => b.d - a.d); h.worst.length = 10; }
};
/** Counts by key, and up to 5 examples each. */
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, key: string, ex?: string) => {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (ex && e.ex.length < 5) e.ex.push(ex);
};
const fresh = () => ({
  files: 0, parts: 0, curves: 0, planted: 0, caught: [] as string[], plantedAt: [] as string[],
  made: {} as Tally, point: {} as Record<string, Hist>, d1: {} as Record<string, Hist>, d1Skipped: {} as Tally,
  vertexClass: {} as Tally, vertexDistance: hist(ABS.length), certainty: {} as Tally, invertStatus: {} as Tally,
  onSeam: 0, alternatives: 0, rangeAgreement: {} as Tally, lengthStatus: {} as Tally,
  lengthError: hist(REL.length),
  honesty: {} as Tally,
  honestyWorst: hist(REL.length), perimeter: {} as Tally, perimeterDiff: hist(REL.length),
});
type Result = ReturnType<typeof fresh>;
const histOf = (m: Record<string, Hist>, k: string, n = REL.length) => (m[k] ??= hist(n));
const vec3 = (v: ArrayLike<number>) => [v[0]!, v[1]!, v.length > 2 ? v[2]! : 0];
const diff = (a: ArrayLike<number>, at: number, b: number[]) =>
  Math.hypot(a[at]! - b[0]!, a[at + 1]! - b[1]!, a[at + 2]! - b[2]!);
const mag = (b: number[]) => Math.hypot(b[0]!, b[1]!, b[2]!);

/** cad-geom's copy of a planted part's model: its first line, circle or B-spline changed (PLANT=curve). */
function plantCurve(d: BrepData): { data: BrepData; row: number } | undefined {
  const c = openBrep(d.buffer.slice(0));
  for (let i = 0; i < rowCount(c, 'curve'); i++) {
    const k = c.curve.kind[i]!, dim = c.curve.dim[i]!, r = c.pool.curveReal, o = c.curve.real[i]!;
    if (k === CURVE_KIND.line) r[o]! += 1e-3;
    else if (k === CURVE_KIND.circle) r[o + (dim === 3 ? 9 : 4)]! *= 1 + 1e-3;
    else if (k === CURVE_KIND.bspline) {
      // The middle pole's x (the first one barely reaches samples inside a clamped curve).
      const n = c.pool.curveInt[c.curve.int[i]! + 1]!, nk = c.pool.curveInt[c.curve.int[i]! + 2]!;
      r[o + nk + Math.floor(n / 2) * dim]! += 1e-3;
    }
    else continue;
    return { data: c, row: i };
  }
  return undefined;
}

function plantVertex(d: BrepData): BrepData | undefined {
  for (let e = 0; e < rowCount(d, 'edge'); e++) {
    const v = d.edge.start[e]!;
    if (d.edge.curve[e]! < 0 || v < 0) continue;
    const c = openBrep(d.buffer.slice(0));
    [1, 2, 3].forEach((x, i) => { c.vertex.point[3 * v + i]! += 0.01 * x / Math.sqrt(14); });
    return c;
  }
  return undefined;
}

/** Chord sums over [a, b] split at its breaks, each span's last point its left limit; n chords a span. */
function chords(g: Geometry, row: number, a: number, b: number, n: number): number {
  const br = g.curveBreaks(row, a, b).breaks, ts: number[] = [];
  for (let s = 0; s + 1 < br.length; s++) {
    for (let i = 0; i <= n; i++) {
      const t = br[s]! + (br[s + 1]! - br[s]!) * i / n;
      ts.push(i === n ? (t > br[s]! ? t - Math.abs(t) * 4e-16 - 1e-300 : t) : t);
    }
  }
  const p = g.evalCurve(row, ts, 0).values;
  let sum = 0;
  for (let s = 0; s + 1 < br.length; s++) {
    for (let i = 0; i < n; i++) {
      const k = s * (n + 1) + i;
      sum += Math.hypot(p[3 * k + 3]! - p[3 * k]!, p[3 * k + 4]! - p[3 * k + 1]!, p[3 * k + 5]! - p[3 * k + 2]!);
    }
  }
  return sum;
}

const CONFIRMED = 'ours within 1e-9 of chord sums';
const PERIODIC = new Set<number>([SURFACE_KIND.cylinder, SURFACE_KIND.cone, SURFACE_KIND.sphere, SURFACE_KIND.torus,
  SURFACE_KIND.revolution]);

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    module = await init();
    if (withOcct) {
      occt = new OcctTessellator();
      await occt.init();
    }
  },
  async file(path) {
    const R = fresh();
    if (fs.statSync(path).size > maxMB * 1e6) return R;
    R.files++;
    const name = shortName(path);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path)));
    for (const part of scene.parts) {
      const m0 = part.brep?.model;
      if (!m0) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      const pick = !!plant && plantedPart(where);
      let d = m0, ours = m0, plantedRow = -1;
      if (pick && plant === 'curve') {
        const p = plantCurve(m0);
        if (p) ours = p.data, plantedRow = p.row;
      } else if (pick && plant === 'vertex') {
        const p = plantVertex(m0);
        if (p) d = ours = p;
      }
      const isPlanted = pick && (plant === 'length' || ours !== m0);
      if (isPlanted) { R.planted++; R.plantedAt.push(where); }
      let seen = false;
      const tol = Number.isFinite(d.part.uncertainty[0]) ? d.part.uncertainty[0]! : 1e-6;
      const evs = new Map<number, CurveEvaluator | undefined>();
      const ev = (i: number) => curveEvaluator(d, i, evs);
      using g = new Geometry(module, new Uint8Array(ours.buffer));

      // Points and derivatives.
      for (let i = 0; i < g.curves; i++) {
        R.curves++;
        const kind = `${KIND[d.curve.kind[i]!] ?? '?'} ${d.curve.dim[i]}D`, info = g.curveInfo(i), e = ev(i);
        tally(R.made, `${kind}: cad-geom ${info.status}, geometry.ts ${e ? 'evaluates' : 'doesn\'t'}`,
          info.status !== 'ok' || !e ? `${where} curve #${d.curve.id[i]}` : undefined);
        if (info.status !== 'ok' || !e) continue;
        const bounded = Number.isFinite(info.lo) && Number.isFinite(info.hi);
        const ts = bounded ? Array.from({ length: 7 }, (_, k) => info.lo + (info.hi - info.lo) * (k + 0.5) / 7)
          : [-1, -0.5, 0, 0.5, 1];
        // The interior breaks (a range's ends are breaks too, but no sample is at one).
        const r = g.evalCurve(i, ts, 1), br = g.curveBreaks(i, ts[0]!, ts.at(-1)!).breaks.slice(1, -1);
        let worstP = 0;
        ts.forEach((t, k) => {
          if (r.statuses[k] !== 0) {
            tally(R.made, `${kind}: eval ${STATUS[r.statuses[k]!]}`, `${where} at ${t}`);
            return;
          }
          const p = vec3(e.point(t)), d1 = vec3(e.d1(t)), at = `${where} curve #${d.curve.id[i]} at ${t}`;
          const da = diff(r.values, 6 * k, p), dp = da / Math.max(1, mag(p));
          record(histOf(R.point, kind), REL, dp, at);
          worstP = Math.max(worstP, da);
          const onBreak = br.some((b) => Math.abs(b - t) <= 1e-9 * Math.max(1, Math.abs(t)));
          if (onBreak) { tally(R.d1Skipped, `${kind}: at a break`); return; }
          const key = d.curve.kind[i] === CURVE_KIND.offset ? `${kind} (geometry.ts's a central difference)` : kind;
          record(histOf(R.d1, key), REL, diff(r.values, 6 * k + 3, d1) / Math.max(1, mag(d1)), at);
        });
        if (isPlanted && i === plantedRow && worstP > 1e-5) seen = true;  // in mm
      }

      // Vertices inverted onto their edges' curves; edges' lengths, grouped by curve (a batch each).
      const byCurve = new Map<number, number[]>();
      for (let e = 0; e < rowCount(d, 'edge'); e++) {
        const ci = d.edge.curve[e]!;
        if (ci >= 0) (byCurve.get(ci) ?? byCurve.set(ci, []).get(ci)!).push(e);
      }
      let sampledPlant = false;
      // Per edge its length; per vertex its largest distance from its edges' curves (the model's gaps).
      const lengths = new Map<number, number>(), gapAt = new Map<number, number>();
      const rangeOf = new Map<number, [number, number]>();
      for (const [ci, edges] of byCurve) {
        const info = g.curveInfo(ci), e = ev(ci);
        if (info.status !== 'ok') { tally(R.vertexClass, `curve not made: ${info.status}`); continue; }
        const vs: number[] = [], pts: number[] = [];
        for (const ed of edges) for (const v of new Set([d.edge.start[ed]!, d.edge.end[ed]!])) {
          if (v < 0) continue;
          vs.push(v);
          pts.push(...d.vertex.point.subarray(3 * v, 3 * v + 3));
        }
        // Each vertex's parameter by cad-geom, for the edges' ranges below (by its point, as edgeParams asks).
        const paramAt = new Map<string, number>();
        if (vs.length) {
          const inv = g.invertCurve(ci, pts, info.lo, info.hi, tol);
          vs.forEach((v, k) => {
            if (inv.statuses[k] === 0) paramAt.set(pts.slice(3 * k, 3 * k + 3).join(), inv.params[k]!);
            gapAt.set(v, Math.max(gapAt.get(v) ?? 0, inv.distance[k]!));
            const at = `${where} curve #${d.curve.id[ci]} vertex #${d.vertex.id[v]}`;
            const st = STATUS[inv.statuses[k]!]!;
            tally(R.invertStatus, st, st === 'ok' ? undefined : at);
            tally(R.certainty, CERTAINTY[inv.certainty[k]!]!, inv.certainty[k] === 1 ? at : undefined);
            R.onSeam += inv.flags[k]!;
            R.alternatives += inv.alternativeCount[k]!;
            const dg = inv.distance[k]!, p = Array.from(pts.slice(3 * k, 3 * k + 3));
            record(R.vertexDistance, ABS, dg, at);
            if (isPlanted && plant === 'vertex' && dg > 1e-3) seen = true;
            const t = e?.param(p), dt = t === undefined ? undefined : mag(vec3(e!.point(t)).map((x, i) => x - p[i]!));
            const slack = 1e-9 + 1e-13 * mag(p);
            tally(R.vertexClass, !e ? 'geometry.ts doesn\'t evaluate the curve'
              : dt === undefined ? 'geometry.ts has no parameter (unbounded, no closed form)'
              : Math.abs(dg - dt) <= slack ? 'the same foot'
              : dg < dt ? 'cad-geom nearer (geometry.ts\'s search missed)' : 'geometry.ts nearer',
              dt !== undefined && dg > dt + slack ? `${at}: ${dg} vs ${dt}` : undefined);
          });
        }
        if (!e) { tally(R.lengthStatus, 'no range: geometry.ts doesn\'t evaluate the curve'); continue; }
        // Edges' ranges by edgeParams's rules (the given range, else the vertices' parameters, a period added for the
        // edge's sense), the parameters cad-geom's; geometry.ts's own (its sampled search) compared.
        const ours = { ...e, range: [info.lo, info.hi] as [number, number], period: info.period || undefined,
          param: (p: number[]) => paramAt.get(p.join()) };
        const ranges: number[] = [], kept: number[] = [];
        for (const ed of edges) {
          const r = edgeParams(d, ed, ours), rt = edgeParams(d, ed, e);
          if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) {
            tally(R.lengthStatus, 'no finite range');
            continue;
          }
          if (rt) {
            // Up to a whole number of periods (both ranges the same arc), else by cause.
            const P = info.period, k = P ? Math.round((rt[0] - r[0]) / P) : 0;
            const off = Math.max(Math.abs(r[0] + k * P - rt[0]), Math.abs(r[1] + k * P - rt[1]));
            const same = off <= 1e-9 * Math.max(1, Math.abs(rt[0]), Math.abs(rt[1]));
            const gap = Math.max(gapAt.get(d.edge.start[ed]!) ?? 0, gapAt.get(d.edge.end[ed]!) ?? 0);
            tally(R.rangeAgreement, same ? (k ? 'the same, a whole period apart' : 'the same')
              : gap > 10 * tol ? 'differs: a vertex more than 10 x the uncertainty off its curve (feet differ)'
              : 'differs', same ? undefined : `${where} edge #${d.edge.id[ed]}: [${r}] vs [${rt}], gap ${gap}`);
          }
          ranges.push(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
          rangeOf.set(ed, [Math.min(r[0], r[1]), Math.max(r[0], r[1])]);
          kept.push(ed);
        }
        if (!kept.length) continue;
        const L = g.arcLength(ci, ranges, 1e-10);
        kept.forEach((ed, k) => {
          const at = `${where} edge #${d.edge.id[ed]}`, st = STATUS[L.statuses[k]!]!;
          // A range past a bounded domain by a few ulps: the file's own rounding (its knots and its edge's
          // parameters written apart); arcLength clamps and says so.
          const a0 = ranges[2 * k]!, b0 = ranges[2 * k + 1]!, slop = 1e-12 * Math.max(1, Math.abs(a0), Math.abs(b0));
          const ulps = st === 'outOfDomain' && a0 >= info.lo - slop && b0 <= info.hi + slop;
          tally(R.lengthStatus, ulps ? 'outOfDomain: the range a few ulps past the domain (the file\'s rounding)' : st,
            st === 'ok' ? undefined : at);
          if (st !== 'ok' && !ulps) return;
          let value = L.value[k]!;
          const err = L.error[k]!;
          lengths.set(ed, value);
          record(R.lengthError, REL, err / Math.max(value, 1e-300), at);
          const forced = isPlanted && plant === 'length' && !sampledPlant;
          if (!forced && !plantedPart(at, 20)) return;
          if (forced) { sampledPlant = true; value -= 1e-6 * value; }
          const a = ranges[2 * k]!, b = ranges[2 * k + 1]!, n = 1 << 10;
          const c1 = chords(g, ci, a, b, n), c2 = chords(g, ci, a, b, 2 * n), c4 = chords(g, ci, a, b, 4 * n);
          const r1 = c2 + (c2 - c1) / 3, r2 = c4 + (c4 - c2) / 3, unc = Math.abs(r2 - r1);
          const off = Math.abs(value - r2), rel = off / Math.max(value, 1e-300);
          const cls = unc > 1e-8 * value ? 'chords unresolved (their own uncertainty over 1e-8)'
            : off <= Math.max(10 * err, 10 * unc, 1e-12 * value) ? 'within its estimate'
              : 'outside its estimate';
          tally(R.honesty, cls, cls === 'outside its estimate' ? `${at}: off ${rel.toExponential(2)}, estimate `
            + `${(err / value).toExponential(2)}` : undefined);
          if (cls !== 'chords unresolved (their own uncertainty over 1e-8)') record(R.honestyWorst, REL, rel, at);
          if (forced && cls === 'outside its estimate') seen = true;
        });
      }

      // OCCT's perimeters against the sums of our lengths over each face's coedges.
      if (occt && rowCount(d, 'face')) {
        let res;
        try {
          res = await occt.tessellate({ format: 'cad-brep', data: new Uint8Array(m0.buffer), linearDeflection: 1,
            angularDeflection: 0.5, measures: true });
        } catch (e) {
          tally(R.perimeter, 'OCCT threw', `${where}: ${(e as Error).message.split('\n')[0]}`);
        }
        const byId = new Map((res?.measures ?? []).map((x) => [x.entityId, x]));
        for (let f = 0; f < rowCount(d, 'face'); f++) {
          const at = `${where} face #${d.face.id[f]}`, m = byId.get(d.face.id[f]!);
          if (!res) break;
          if (!m) { tally(R.perimeter, 'OCCT measured no face of its id', at); continue; }
          // A surface periodic in u: the elementary ones and revolutions, an extrusion of a periodic curve.
          const periodic = (si: number) => PERIODIC.has(d.surface.kind[si]!) || (d.surface.kind[si] ===
            SURFACE_KIND.extrusion && g.curveInfo(d.pool.surfaceInt[d.surface.int[si]!]!).period > 0);
          let sum = 0, complete = true, outer = 0, edgeLoops = 0, gap = 0;
          const faceEdges: number[] = [];
          const uses = new Map<number, number>();
          for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
            if (d.loop.bound[l] === BOUND.outer) outer++;
            if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
            edgeLoops++;
            for (let j = d.loop.first[l]!; j < d.loop.first[l]! + d.loop.count[l]!; j++) {
              const ed = d.coedge.edge[j]!, len = lengths.get(ed);
              uses.set(ed, (uses.get(ed) ?? 0) + 1);
              faceEdges.push(ed);
              for (const v of [d.edge.start[ed]!, d.edge.end[ed]!]) gap = Math.max(gap, gapAt.get(v) ?? 0);
              if (len === undefined) complete = false;
              else sum += len;
            }
          }
          const rel = Math.abs(m.perimeter - sum) / Math.max(m.perimeter, sum, 1e-300);
          // The face's perimeter again from chord sums over its edges' ranges (Richardson, 2^11 and 2^12 a span).
          const chordsConfirm = (eds: number[], ours: number) => {
            let c = 0;
            for (const ed of eds) {
              const r = rangeOf.get(ed);
              if (!r) return false;
              const ci = d.edge.curve[ed]!, c2 = chords(g, ci, r[0], r[1], 2048), c4 = chords(g, ci, r[0], r[1], 4096);
              c += c4 + (c4 - c2) / 3;
            }
            return Math.abs(c - ours) <= 1e-9 * ours;
          };
          const seamed = [...uses.values()].some((u) => u > 1);
          const cls = !m.valid ? 'OCCT finds its face invalid'
            : !edgeLoops ? 'no edge loops: OCCT bounds the face by its surface\'s natural bounds'
            : !complete ? 'ours incomplete (an edge without a length)'
            : rel <= 1e-6 ? 'agree within 1e-6'
            : m.perimeter > sum && periodic(d.face.surface[f]!) && !seamed
              ? 'a seam healing adds, counted twice (no edge used twice by the face)'
            : outer > 1 ? 'several outer loops: OCCT splits the face, its pieces summed'
            : gap > 10 * tol ? 'a vertex more than 10 x the uncertainty off its curve: healing rebuilds edges'
            : !chordsConfirm(faceEdges, sum) ? 'other'
            : rel <= 1e-4 ? `OCCT's within 1e-4 (its quadrature or healing's tolerances); ${CONFIRMED}`
            : !outer && m.perimeter > sum ? `OCCT's longer, no loop said outer (healing may add the surface's bounds); `
              + CONFIRMED
            : `OCCT's differs by more than 1e-4; ${CONFIRMED}`;
          tally(R.perimeter, cls, cls === 'agree within 1e-6' ? undefined : `${at}: OCCT ${m.perimeter}, ours ${sum}`);
          if (cls === 'agree within 1e-6' || cls === 'other') record(R.perimeterDiff, REL, rel, at);
        }
      }
      if (seen) R.caught.push(where);
    }
    return R;
  },
};

function printHist(title: string, h: Hist, buckets: number[], unit: string) {
  const total = h.counts.reduce((a, b) => a + b, 0);
  console.log(`  ${title}: ${total}`);
  buckets.forEach((b, i) => {
    if (h.counts[i]) console.log(`    ${b === Infinity ? 'more' : `<= ${b}`}${unit}: ${h.counts[i]}`);
  });
  h.worst.sort((a, b) => b.d - a.d);
  for (const w of h.worst.slice(0, 3)) {
    if (w.d > buckets[0]!) console.log(`    worst ${w.d.toExponential(3)}  ${w.where}`);
  }
}
function printTally(title: string, t: Tally) {
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.n}  ${k}`);
    for (const e of v.ex) console.log(`      ${e}`);
  }
}

if (import.meta.main) {
  console.log(await hostLine());
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else addInto(all, out.result);
    });
  const caught = new Set(all.caught);
  console.log(`${all.files} files, ${all.parts} B-rep parts, ${all.curves} curves${withOcct ? ', with OCCT' : ''}`);
  if (plant) {
    console.log(`PLANT=${plant}: ${all.planted} parts planted, ${caught.size} seen`);
    for (const w of all.plantedAt) if (!caught.has(w)) console.log(`  not seen: ${w}`);
  }
  printTally('Curves made (cad-geom\'s status, geometry.ts\'s evaluator), by kind', all.made);
  console.log('\n## Points against geometry.ts, relative to max(1, |p|), by kind');
  for (const [k, h] of Object.entries(all.point).sort()) printHist(k, h, REL, '');
  console.log('\n## First derivatives against geometry.ts, relative to max(1, |d1|), by kind');
  for (const [k, h] of Object.entries(all.d1).sort()) printHist(k, h, REL, '');
  printTally('First derivatives not compared', all.d1Skipped);
  printTally('Vertices inverted: cad-geom against geometry.ts', all.vertexClass);
  console.log('\n## Vertices\' distances from their curves (cad-geom)');
  printHist('measured', all.vertexDistance, ABS, ' mm');
  printTally('Inversion statuses', all.invertStatus);
  printTally('Inversion certainties', all.certainty);
  console.log(`  on a seam: ${all.onSeam}; alternatives given: ${all.alternatives}`);
  printTally('Edge ranges: cad-geom\'s vertex parameters against geometry.ts\'s', all.rangeAgreement);
  printTally('Edge lengths: statuses', all.lengthStatus);
  console.log('\n## Edge lengths: estimated errors, relative');
  printHist('estimated', all.lengthError, REL, '');
  printTally('Edge lengths sampled against chord sums', all.honesty);
  console.log('\n## Sampled lengths\' differences from the chord sums, relative');
  printHist('compared', all.honestyWorst, REL, '');
  if (withOcct) {
    printTally('Face perimeters: OCCT\'s against the sum of ours', all.perimeter);
    console.log('\n## Perimeter differences (agreeing and unclassified), relative');
    printHist('compared', all.perimeterDiff, REL, '');
  }
}
