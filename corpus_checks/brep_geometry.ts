// The B-rep model's geometry against itself over the corpus (cad-brep's evaluators, step-import's models): every
// edge's vertices on its 3D curve, every face's vertices on its surface, every coedge's p-curve on its surface along
// its edge (points of the 3D curve between the vertices mapped to the surface's (u, v), each matched to the nearest
// point of the p-curve, periods allowed for, and that point mapped back to 3D). Distances in millimetres, by bucket,
// with the worst. The file's own geometry decides: a conversion error (a parameterization, an angle unit, a p-curve
// on the wrong use) shows as distances far beyond the files' precision. Planted bugs, in about one part in 10
// (corpus.ts's plantedPart): PLANT=pcurve moves the part's first p-curve line on an elementary surface half a unit
// sideways, PLANT=vertex moves its first vertex by 0.01 (each must show; those that don't are listed). Several files
// at once (runner.ts: CHILDREN).
// Usage: node --max-old-space-size=12000 corpus_checks/brep_geometry.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import { type BrepData, CURVE_KIND, decode, LOOP_KIND, openBrep, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { curveEvaluator, type CurveEvaluator, edgeParams, nearestParam, nearestParams, surfaceEvaluator,
  type SurfaceEvaluator, type Vec } from '../packages/cad-brep/src/geometry.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';

// The process's own size limit (from its command line).
let maxMB = 1000;
const plant = process.env.PLANT;
const BUCKETS = [1e-7, 1e-5, 1e-3, 1e-1, Infinity];
type Hist = { counts: number[]; worst: { d: number; where: string }[]; skipped: Map<string, number> };
const hist = (): Hist => ({ counts: BUCKETS.map(() => 0), worst: [], skipped: new Map() });
const record = (h: Hist, d: number, where: string) => {
  h.counts[BUCKETS.findIndex((b) => d <= b)]!++;
  h.worst.push({ d, where });
  if (h.worst.length > 40) { h.worst.sort((a, b) => b.d - a.d); h.worst.length = 10; }
};
const skip = (h: Hist, why: string) => h.skipped.set(why, (h.skipped.get(why) ?? 0) + 1);
const ELEMENTARY = new Set<number>([SURFACE_KIND.plane, SURFACE_KIND.cylinder, SURFACE_KIND.cone, SURFACE_KIND.sphere,
  SURFACE_KIND.torus]);
const dist = (a: Vec, b: Vec) => Math.hypot(...a.map((x, i) => x - b[i]!));
/** A file's results, or the run's (addInto): `caught` the planted parts seen (a part once per file). */
const fresh = () => ({ files: 0, parts: 0, planted: 0, caught: [] as string[], plantedAt: [] as string[],
  H: { vertexCurve: hist(), vertexSurface: hist(), pcurve: hist() } });
type Result = ReturnType<typeof fresh>;

function plantIn(d: BrepData, pick: boolean): BrepData {
  if (!plant || !pick) return d;
  const c = openBrep(d.buffer.slice(0));
  if (plant === 'vertex' && rowCount(c, 'vertex')) {
    // Off any line or plane through it along the axes, where a move along them would stay on its geometry.
    [1, 2, 3].forEach((x, i) => { c.vertex.point[i]! += 0.01 * x / Math.sqrt(14); });
    return c;
  }
  if (plant === 'pcurve') {
    // Across the line (along it, an unbounded line is the same line), on a surface with closed-form parameters (the
    // others' p-curves are skipped).
    for (let f = 0; f < rowCount(c, 'face'); f++) {
      if (!ELEMENTARY.has(c.surface.kind[c.face.surface[f]!]!)) continue;
      for (let l = c.face.firstLoop[f]!; l < c.face.firstLoop[f]! + c.face.loopCount[f]!; l++) {
        if (c.loop.kind[l] !== LOOP_KIND.edge) continue;
        for (let j = c.loop.first[l]!; j < c.loop.first[l]! + c.loop.count[l]!; j++) {
          const p = c.coedge.pcurve[j]!;
          if (p < 0 || c.curve.kind[p] !== CURVE_KIND.line || c.edge.curve[c.coedge.edge[j]!]! < 0) continue;
          const r = c.pool.curveReal, o = c.curve.real[p]!;
          r[o]! -= 0.5 * r[o + 3]!;
          r[o + 1]! += 0.5 * r[o + 2]!;
          return c;
        }
      }
    }
  }
  return d;
}

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
  },
  async file(path) {
    const R = fresh(), { H } = R;
    const caught = new Set<string>();
    if (fs.statSync(path).size > maxMB * 1e6) return R;
    R.files++;
    const name = shortName(path);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path)));
    for (const part of scene.parts) {
      const m0 = part.brep?.model;
      if (!m0) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      const d = plantIn(m0, plantedPart(where)), mm = d.part.unit[0]!, isPlanted = d !== m0;
      if (isPlanted) { R.planted++; R.plantedAt.push(where); }
      const curves = new Map<number, CurveEvaluator | undefined>(), surfaces = new Map<number, SurfaceEvaluator |
        undefined>();
      const cur = (i: number) => curveEvaluator(d, i, curves), surf = (i: number) => surfaceEvaluator(d, i, surfaces,
        curves);
      const vtx = (v: number) => Array.from(d.vertex.point.subarray(3 * v, 3 * v + 3));
      const off = (h: Hist, x: number, at: string) => {
        record(h, x * mm, at);
        if (isPlanted && x * mm > 1e-3) caught.add(where);
      };

      // Vertices on their edges' curves.
      const ranges = new Map<number, [number, number] | undefined>();
      for (let e = 0; e < rowCount(d, 'edge'); e++) {
        const ci = d.edge.curve[e]!;
        if (ci < 0) continue;
        const c = cur(ci);
        if (!c) { skip(H.vertexCurve, 'curve not evaluated'); continue; }
        for (const v of [d.edge.start[e]!, d.edge.end[e]!]) {
          if (v < 0) continue;
          const t = c.param(vtx(v));
          if (t === undefined) { skip(H.vertexCurve, 'no parameter (unbounded curve, no closed form)'); continue; }
          off(H.vertexCurve, dist(c.point(t), vtx(v)), `${where} edge #${d.edge.id[e]}`);
        }
        ranges.set(e, edgeParams(d, e, c));
      }

      // Vertices on their faces' surfaces; p-curves along their edges.
      for (let f = 0; f < rowCount(d, 'face'); f++) {
        const s = surf(d.face.surface[f]!);
        const first = d.face.firstLoop[f]!, nl = d.face.loopCount[f]!;
        const fwhere = `${where} face #${d.face.id[f]}`;
        for (let l = first; l < first + nl; l++) {
          // A vertex loop's vertex (a pole, an apex) on the surface too.
          if (d.loop.kind[l] === LOOP_KIND.vertex) {
            const v = d.loop.first[l]!, uv = s && (s.params?.(vtx(v)) ?? nearestParams(s, vtx(v)));
            if (!s) skip(H.vertexSurface, 'surface not evaluated');
            else if (!uv) skip(H.vertexSurface, 'no parameters (unbounded, no closed form)');
            else off(H.vertexSurface, dist(s.point(uv[0], uv[1]), vtx(v)), fwhere);
          }
          if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
          for (let k = d.loop.first[l]!; k < d.loop.first[l]! + d.loop.count[l]!; k++) {
            const e = d.coedge.edge[k]!, v = d.edge.start[e]!;
            if (!s) { skip(H.vertexSurface, 'surface not evaluated'); continue; }
            if (v >= 0) {
              const uv = s.params?.(vtx(v)) ?? nearestParams(s, vtx(v));
              if (!uv) skip(H.vertexSurface, 'no parameters (unbounded, no closed form)');
              else off(H.vertexSurface, dist(s.point(uv[0], uv[1]), vtx(v)), fwhere);
            }
            const pi = d.coedge.pcurve[k]!;
            if (pi < 0) continue;
            const p = cur(pi), ci = d.edge.curve[e]!, c = ci >= 0 ? cur(ci) : undefined, range = ranges.get(e);
            if (!p || !c || !range) { skip(H.pcurve, 'p-curve, 3D curve or edge range not evaluated'); continue; }
            if (!s.params) { skip(H.pcurve, 'surface without closed-form parameters'); continue; }
            // The p-curve's extent in (u, v), for the periods it may be shifted by (a p-curve can lie any whole number
            // of periods from the surface's own range).
            const span = Number.isFinite(p.range[0]) && Number.isFinite(p.range[1]) ? p.range : range;
            const box = [[Infinity, -Infinity], [Infinity, -Infinity]];
            for (let j = 0; j <= 32; j++) {
              const x = p.point(span[0] + (span[1] - span[0]) * j / 32);
              for (const i of [0, 1]) box[i] = [Math.min(box[i]![0]!, x[i]!), Math.max(box[i]![1]!, x[i]!)];
            }
            const shifts = (w: number, i: 0 | 1, P: number | undefined) => {
              if (!P) return [0];
              const out: number[] = [];
              const lo = Math.floor((box[i]![0]! - w) / P) - 1, hi = Math.ceil((box[i]![1]! - w) / P) + 1;
              for (let k = lo; k <= hi; k++) out.push(k);
              return out;
            };
            // A point of a sphere or torus has a second pair of parameters, beyond the axis: (u + pi, pi - v) on a
            // sphere (whose v is 2 pi periodic too, as a point), (u + pi, atan2(z, -rho - R)) on a torus (another point
            // but on a spindle torus); p-curves may use either.
            const sd = decode.surface(d, d.face.surface[f]!);
            const vPeriod = s.vPeriod ?? (sd.kind === 'sphere' ? 2 * Math.PI : undefined);
            const branches = (q: Vec, uv: [number, number]): [number, number][] => {
              if (sd.kind === 'sphere') return [uv, [uv[0] + Math.PI, Math.PI - uv[1]]];
              if (sd.kind !== 'torus') return [uv];
              // (The model's placements are complete.)
              const origin = sd.position.origin, axis = sd.position.axis!, xDir = sd.position.xDir!;
              const y = [axis[1]! * xDir[2]! - axis[2]! * xDir[1]!,
                axis[2]! * xDir[0]! - axis[0]! * xDir[2]!, axis[0]! * xDir[1]! - axis[1]! * xDir[0]!];
              const r = q.map((x, i) => x - origin[i]!), dot = (a: number[]) => a.reduce((t, x, i) => t + x * r[i]!, 0);
              const rho = Math.hypot(dot(xDir), dot(y));
              return [uv, [uv[0] + Math.PI, Math.atan2(dot(axis), -rho - sd.majorRadius)]];
            };
            let worst = 0;
            for (const f01 of [0.1, 0.3, 0.5, 0.7, 0.9]) {
              const q = c.point(range[0] + (range[1] - range[0]) * f01), uv0 = s.params(q);
              if (!uv0) continue;
              // The nearest point of the p-curve to (u, v), allowing for periods and both branches.
              let best = Infinity;
              for (const uv of branches(q, uv0)) for (const du of shifts(uv[0], 0, s.uPeriod))
              for (const dv of shifts(uv[1], 1, vPeriod)) {
                const w = [uv[0] + du * (s.uPeriod ?? 0), uv[1] + dv * (vPeriod ?? 0)];
                const t = Number.isFinite(p.range[0]) && Number.isFinite(p.range[1]) ? nearestParam(p, w, p.range)
                  : p.param(w);
                if (t === undefined) continue;
                const x = p.point(t);
                best = Math.min(best, dist(s.point(x[0]!, x[1]!), q));
              }
              worst = Math.max(worst, best);
            }
            off(H.pcurve, worst, `${fwhere} coedge #${d.coedge.id[k]} edge #${d.edge.id[e]}`);
          }
        }
      }
    }
    R.caught.push(...caught);
    return R;
  },
};

if (import.meta.main) {
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else addInto(all, out.result);
    });
  const { files, parts, planted, plantedAt, H } = all, caught = new Set(all.caught);
  console.log(`${files} files, ${parts} B-rep parts`);
  if (plant) {
    console.log(`PLANT=${plant}: ${planted} parts planted, ${caught.size} with a distance over 1e-3 mm`);
    for (const w of plantedAt) if (!caught.has(w)) console.log(`  not seen: ${w}`);
  }
  for (const [k, h] of Object.entries(H)) {
    const total = h.counts.reduce((a, b) => a + b, 0);
    console.log(`\n## ${k}: ${total} measured`);
    BUCKETS.forEach((b, i) => console.log(`  ${b === Infinity ? '  more' : `<= ${b}`} mm: ${h.counts[i]}`));
    for (const [why, n] of h.skipped) console.log(`  skipped: ${n} ${why}`);
    h.worst.sort((a, b) => b.d - a.d);
    for (const w of h.worst.slice(0, 10)) console.log(`  worst ${w.d.toExponential(3)} mm  ${w.where}`);
  }
}
