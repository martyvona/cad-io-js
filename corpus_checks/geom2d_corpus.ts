// cad-geom's 2D geometry (geom2d.h, through its WebAssembly module's face API) on every face of every part's B-rep
// model in the corpus, where the face's loops are all p-curves (STEP files often give none: counted by the file's
// originating system and skipped; the p-curves projected from 3D curves will bring those in):
//   - nest2 against the loops' bounds where the source gives them (outer: no parent; inner: inside an outer loop),
//     bands (loops winding around a period, no parent) apart;
//   - classify2 on points of the boundary: two per coedge on its p-curve must be on; those points moved along the
//     p-curve's left normal by 10 x the point's (u, v) tolerance (cad_geom_api.cpp: the 3D one through the surface's
//     first fundamental form) must be in on the face's side and out on the other (the left, as the API turns the
//     loops: counterclockwise about the surface's normal, where the face's sense isn't the surface's turned round);
//     outside a seam (an edge the face uses twice) the face goes on, not judged. A moved point that's on is near
//     another boundary (skipped, counted); one that disagrees but agrees at 2 x the tolerance is a narrow face
//     (another boundary within 10 x); a face whose every judged point is the wrong way round has its loops oriented
//     against its sense (the source's); the rest listed;
//   - selfIntersect2 on each edge loop: crossings and touches (pinched loops) counted, examples listed;
//   - faces classify2 calls invalidModel by their loops' widest joint in 3D over the tolerance (p-curves ending off
//     their vertices, the source's, for healing to bridge);
//   - OCCT=1: the moved points classified by OCCT's face classifier (tess-occt's probe, the part built by the native
//     builder, unhealed: its p-curves are the model's), on faces whose (u, v) OCCT's parameterization shares (planes,
//     cylinders, spheres, tori, B-splines) or maps affinely (cones: v' = v / cos a), at our (u, v) tolerance; the
//     differences classified (OCCT on: its band wider than ours; on periodic faces, whether OCCT agrees with the
//     point shifted by a period, and whether it's near the seam; the rest listed).
// Pole lines and periods: cad_geom_api.cpp's (closed forms for cones and spheres, a domain's collapsed and coinciding
// edges sampled), not yet Surface::singularities.
// Planted bugs in about one part in 10 (corpus.ts's plantedPart), on its first face the check judges, each of which
// must show (those that don't are listed), judged against the unplanted model's boundary: PLANT=orient reverses the
// orientation of the coedges of the face's first edge loop (its in and out swap), PLANT=gap moves the first line
// p-curve of a face on a plane by 10 x the face's tolerance along u (a gap in its loop).
// Usage: node --max-old-space-size=8192 corpus_checks/geom2d_corpus.ts [file-list.txt] [max MB]
//   OCCT=1 the OCCT comparison (a native build per part). Several files at once (runner.ts: CHILDREN).
import fs from 'node:fs';
import path from 'node:path';
import { type BrepData, BOUND, CURVE_KIND, LOOP_KIND, openBrep, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { Geometry, init, SIDE, STATUS, type GeomModule } from '../packages/cad-geom/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: GeomModule;
const plant = process.env.PLANT, withOcct = process.env.OCCT === '1';
if (plant && !['orient', 'gap'].includes(plant)) throw new Error(`PLANT=${plant}: orient, gap`);
const SKIND = Object.fromEntries(Object.entries(SURFACE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;

/** Counts by key, and up to 5 examples each (EXAMPLES=n: n, to look into a run). */
const examples = Number(process.env.EXAMPLES ?? 5);
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, key: string, ex?: string) => {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (ex && e.ex.length < examples) e.ex.push(ex);
};
const fresh = () => ({
  files: 0, parts: 0, faces: 0, judged: 0, planted: 0, caught: [] as string[], plantedAt: [] as string[],
  skipped: {} as Tally, nest: {} as Tally, on: {} as Tally, side: {} as Tally, faceSide: {} as Tally,
  self: {} as Tally, occt: {} as Tally, statuses: {} as Tally, gaps: {} as Tally,
});
type Result = ReturnType<typeof fresh>;

/** A source system's name without its version: the originating system up to its first digit, or "(none)". */
const systemOf = (s: unknown) => typeof s === 'string' && s.trim() ? s.replace(/[\s\-_/(v]*\d.*$/i, '').trim() || s
  : '(none)';

// tess-occt's probe (build-probe.sh): a part built by the native builder, points classified against its faces.
interface ProbeModule { HEAPU8: Uint8Array; HEAPF64: Float64Array; _malloc(n: number): number; _free(p: number): void;
  _occt_probe_build(p: number, n: number): number; _occt_probe_classify(q: number, n: number, out: number): void;
  _occt_probe_free(): void }
let probe: ProbeModule | undefined;
const PROBE = path.join(import.meta.dirname, '../packages/tess-occt/dist/occt_probe.mjs');
const loadProbe = async () => {
  probe = await ((await import(PROBE)) as { default: () => Promise<ProbeModule> }).default();
};

/** OCCT's sides for (face id, u, v, tol) queries, in OCCT's parameters; 255 where it can't. */
function occtClassify(qs: number[]): Uint8Array {
  const m = probe!, n = qs.length / 4;
  if (!n) return new Uint8Array();
  const q = m._malloc(qs.length * 8), o = m._malloc(n);
  m.HEAPF64.set(qs, q >> 3);
  m._occt_probe_classify(q, n, o);
  const out = m.HEAPU8.slice(o, o + n);
  m._free(q);
  m._free(o);
  return out;
}

/**
 * A copy of the model with the face's first edge loop's coedges reversed (orient), or the first line p-curve of a
 * face on a plane moved by `shift` along u (gap); undefined where the face has none.
 */
function plantFace(d: BrepData, f: number, how: string, shift: number): BrepData | undefined {
  if (how === 'gap' && d.surface.kind[d.face.surface[f]!] !== SURFACE_KIND.plane) return undefined;
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
    if (how === 'orient') {
      const c = openBrep(d.buffer.slice(0));
      for (let j = c.loop.first[l]!; j < c.loop.first[l]! + c.loop.count[l]!; j++) c.coedge.orientation[j]! ^= 1;
      return c;
    }
    for (let j = d.loop.first[l]!; j < d.loop.first[l]! + d.loop.count[l]!; j++) {
      const row = d.coedge.pcurve[j]!;
      if (row < 0 || d.curve.kind[row] !== CURVE_KIND.line) continue;
      const c = openBrep(d.buffer.slice(0));
      c.pool.curveReal[c.curve.real[row]!]! += shift;  // the line's point's u
      return c;
    }
  }
  return undefined;
}

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
    const system = systemOf(scene.properties?.originatingSystem);
    for (const part of scene.parts) {
      const d = part.brep?.model;
      if (!d) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      const pick = !!plant && plantedPart(where);
      let seen = false, plantedFace = -1;
      using g0 = new Geometry(module, new Uint8Array(d.buffer));
      let built = false;
      if (probe && rowCount(d, 'face')) {
        const p = probe._malloc(d.buffer.byteLength);
        probe.HEAPU8.set(new Uint8Array(d.buffer), p);
        try {
          built = probe._occt_probe_build(p, d.buffer.byteLength) === 0;
          probe._free(p);
          if (!built) tally(R.occt, 'the native builder failed on the part', where);
        } catch (e) {
          // A trap leaves the module's state unknown: counted, the part compared without OCCT, the probe reloaded.
          tally(R.occt, `the probe trapped building the part: ${(e as Error).message}`, where);
          await loadProbe();
        }
      }
      for (let f = 0; f < rowCount(d, 'face'); f++) {
        R.faces++;
        const at = `${where} face #${d.face.id[f]}`, sk = d.surface.kind[d.face.surface[f]!]!;
        const info = g0.faceInfo(f);
        if (info.status !== 'ok') {
          tally(R.skipped, info.status === 'noPcurve' ? `no p-curves: ${system}` : `${info.status} (${SKIND[sk]})`,
            info.status === 'noPcurve' ? undefined : at);
          continue;
        }
        if (!info.loops) { tally(R.skipped, 'no edge loops (natural bounds)'); continue; }
        if (info.ownRanges) {
          tally(R.skipped, `judged, with p-curves parameterized otherwise than their curves (their ranges their own, `
            + `by inverting the vertices; the source against Part 42): ${SKIND[sk]}`, at);
        }
        // The planted face: the part's first one judged.
        let g = g0, planted = false;
        if (pick && plantedFace < 0) {
          const c = plantFace(d, f, plant!, 10 * info.tolerance);
          if (c) {
            g = new Geometry(module, new Uint8Array(c.buffer));
            planted = true;
            plantedFace = f;
            R.planted++;
            R.plantedAt.push(where);
          }
        }
        R.judged++;
        try {
          // Nesting against the source's bounds.
          const nest = g.nestFace(f, d.face.loopCount[f]!);
          if (nest.nest !== 'ok') tally(R.statuses, `nest2 ${nest.nest}`, at);
          const periodic = info.uPeriod > 0 || info.vPeriod > 0;
          for (let k = 0; k < d.face.loopCount[f]!; k++) {
            const l = d.face.firstLoop[f]! + k, b = d.loop.bound[l]!, p = nest.parents[k]!;
            if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
            const parentBound = p >= 0 ? d.loop.bound[d.face.firstLoop[f]! + p]! : -1;
            tally(R.nest, b === BOUND.unknown ? `bound unknown: ${p < 0 ? 'outermost' : 'inside another'}`
              : b === BOUND.outer ? (p < 0 ? 'outer, outermost: agree' : 'outer, but inside another loop')
              : p < 0 ? (periodic ? 'inner, outermost on a periodic surface (a band\'s or a winding loop)'
                : 'inner, but outermost')
              : parentBound === BOUND.outer ? 'inner, inside an outer: agree' : 'inner, inside a loop not said outer',
              (b === BOUND.outer && p >= 0) || (b === BOUND.inner && p < 0 && !periodic) ? `${at} loop ${k}`
                : undefined);
          }
          // Boundary points: on, and moved to each side.
          // (The pieces as the API takes them, the face on each one's left: each use's p-curve parameters where it
          // starts and ends, derived from its edge where the model gives none, loops turned round where the face's
          // sense isn't its surface's.)
          const on: number[] = [], normals: number[] = [], { coedge, travel } = g0.facePieces(f), rows: number[] = [];
          const seam: boolean[] = [], uses = new Map<number, number>();
          for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
            if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
            for (let j = d.loop.first[l]!; j < d.loop.first[l]! + d.loop.count[l]!; j++) {
              uses.set(d.coedge.edge[j]!, (uses.get(d.coedge.edge[j]!) ?? 0) + 1);
            }
          }
          // A seam (an edge the face uses twice): across it the face goes on, a period on.
          for (const j of coedge) rows.push(d.coedge.pcurve[j]!), seam.push(uses.get(d.coedge.edge[j]!)! > 1);
          const onSeam: boolean[] = [];
          for (let piece = 0; piece < rows.length; piece++) {
            {
              const row = rows[piece]!, from = travel[2 * piece]!, to = travel[2 * piece + 1]!;
              const rev = to < from ? -1 : 1;
              const e = g0.evalCurve(row, [from + 0.3 * (to - from), from + 0.7 * (to - from)], 1);
              for (let s = 0; s < 2; s++) {
                const v = e.values.subarray(6 * s, 6 * s + 6), tx = rev * v[3]!, ty = rev * v[4]!;
                const n = Math.hypot(tx, ty);
                if (!(n > 0)) continue;
                on.push(v[0]!, v[1]!);
                normals.push(-ty / n, tx / n);  // the left normal, along the coedge's travel
                onSeam.push(seam[piece]!);
              }
            }
          }
          const r0 = g.classifyOnFace(f, on);
          const tolUv = r0.tolerance;
          const moved = (scale: number) => {
            const pts: number[] = [];
            for (let i = 0; i < on.length / 2; i++) {
              for (const side of [1, -1]) {
                const s = side * scale * tolUv[i]!;
                pts.push(on[2 * i]! + s * normals[2 * i]!, on[2 * i + 1]! + s * normals[2 * i + 1]!);
              }
            }
            return pts;
          };
          const p10 = moved(10), r10 = g.classifyOnFace(f, p10), r2 = g.classifyOnFace(f, moved(2));
          for (const r of [r0, r10, r2]) {
            for (const s of r.statuses) if (s) tally(R.statuses, `classify2 ${STATUS[s]}`, at);
          }
          // A face classify2 calls invalidModel: its loops' widest joint in 3D, over the 3D tolerance (the face API
          // bridges joints within it): p-curves ending that far off their vertices, for healing to count.
          if (r0.statuses.some((x) => STATUS[x] === 'invalidModel')) {
            const loopOf = new Map<number, number>();
            for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++)
              for (let j = d.loop.first[l]!; j < d.loop.first[l]! + d.loop.count[l]!; j++) loopOf.set(j, l);
            const ends: number[] = [];
            for (let k = 0; k < coedge.length; k++) {
              const v = g0.evalCurve(rows[k]!, [travel[2 * k]!, travel[2 * k + 1]!], 0).values;
              ends.push(v[0]!, v[1]!, v[3]!, v[4]!);
            }
            const xyz = g0.evalSurface(d.face.surface[f]!, ends, 0).values;
            let widest = 0;
            for (let k = 0; k < coedge.length; k++) {
              let n = k + 1;
              if (n >= coedge.length || loopOf.get(coedge[n]!) !== loopOf.get(coedge[k]!)) {
                n = k;
                while (n > 0 && loopOf.get(coedge[n - 1]!) === loopOf.get(coedge[k]!)) n--;
              }
              const a = 6 * k + 3, b = 6 * n;
              widest = Math.max(widest,
                Math.hypot(xyz[a]! - xyz[b]!, xyz[a + 1]! - xyz[b + 1]!, xyz[a + 2]! - xyz[b + 2]!));
            }
            const k = widest / info.tolerance;
            tally(R.gaps, !(k > 1) ? 'no joint past the 3D tolerance' : `p-curve ends ${k < 10 ? '1-9' : k < 100
              ? '10-99' : '100 or more'} x tol off their vertices (the widest joint)`, `${at}: ${k.toFixed(1)} x tol`);
          }
          if (planted && (r0.status !== 'ok' || [r0, r10].some((r) => r.statuses.some((s) => s !== 0)))) seen = true;
          for (let i = 0; i < on.length / 2; i++) {
            const s = SIDE[r0.sides[i]!];
            tally(R.on, s === 'on' ? 'on' : `${s} (not on)`, s === 'on' ? undefined
              : `${at}: (${on[2 * i]}, ${on[2 * i + 1]}) at tol ${tolUv[i]}`);
          }
          let right = 0, wrong = 0;
          const wrongAt: string[] = [];
          for (let i = 0; i < p10.length / 2; i++) {
            const want = i % 2 === 0 ? 'in' : 'out', got = SIDE[r10.sides[i]!];
            if (want === 'out' && onSeam[i >> 1]) {
              tally(R.side, 'across a seam: the face goes on (not judged)', got === 'in' ? undefined : `${at}: ${got}`);
              continue;
            }
            if (got === 'on') { tally(R.side, 'on: another boundary within 10 x tol (not judged)', at); continue; }
            if (got === want) { right++; tally(R.side, 'agree'); continue; }
            if (SIDE[r2.sides[i]!] === want) {
              tally(R.side, 'disagrees at 10 x tol, agrees at 2 x: a narrow face');
              continue;
            }
            wrong++;
            if (wrongAt.length < 3) wrongAt.push(`(${p10[2 * i]}, ${p10[2 * i + 1]}) ${got}, want ${want}`);
          }
          const cls = !wrong ? 'agree' : !right ? 'every point the wrong way round: loops oriented against the face\'s '
            + 'sense' : 'some points the wrong way round';
          tally(R.faceSide, `${cls} (${SKIND[sk]})`,
            wrong ? `${at}: ${wrong} of ${right + wrong}: ${wrongAt.join('; ')}` : undefined);
          if (cls !== 'agree') for (let i = 0; i < wrong; i++) tally(R.side, 'disagrees (listed by face below)');
          if (planted && wrong) seen = true;
          // Self-intersections.
          for (let k = 0; k < d.face.loopCount[f]!; k++) {
            if (d.loop.kind[d.face.firstLoop[f]! + k] !== LOOP_KIND.edge) continue;
            const s = g.selfIntersectFace(f, k);
            if (s.self !== 'ok') tally(R.statuses, `selfIntersect2 ${s.self}`, at);
            tally(R.self, s.crossings ? 'crossing itself' : s.touches ? 'touching itself (pinched)' : s.overlaps
              ? 'overlapping itself' : 'simple', s.crossings || s.touches || s.overlaps
              ? `${at} loop ${k}: ${s.points.slice(0, 2).map((x) => `(${x.u}, ${x.v})`).join(' ')}` : undefined);
            if (planted && (s.crossings || s.overlaps)) seen = true;
          }
          // OCCT on the same moved points.
          if (built && !planted) {
            const map = sk === SURFACE_KIND.cone ? 1 / Math.cos(d.pool.surfaceReal[d.surface.real[d.face.surface[f]!]!
              + 10]!) : [SURFACE_KIND.plane, SURFACE_KIND.cylinder, SURFACE_KIND.sphere, SURFACE_KIND.torus,
              SURFACE_KIND.bspline].includes(sk as never) ? 1 : 0;
            if (!map) { tally(R.occt, `not compared: OCCT's (u, v) differs on ${SKIND[sk]}`); continue; }
            const qs: number[] = [];
            for (let i = 0; i < p10.length / 2; i++)
              qs.push(d.face.id[f]!, p10[2 * i]!, map * p10[2 * i + 1]!, map * tolUv[i >> 1]!);
            const o = occtClassify(qs);
            const name = (x: number) => x === 255 ? 'failed' : ['in', 'out', 'on', 'unknown'][x]!;
            for (let i = 0; i < o.length; i++) {
              const ours = SIDE[r10.sides[i]!], theirs = name(o[i]!), u = p10[2 * i]!, v = p10[2 * i + 1]!;
              if (ours === theirs || theirs === 'on' || theirs === 'failed' || theirs === 'unknown') {
                tally(R.occt, ours === theirs ? 'agree' : theirs === 'on' ? 'OCCT on, ours not (its band wider)'
                  : `OCCT ${theirs}`, ours === theirs || theirs === 'on' ? undefined : `${at}: (${u}, ${v})`);
                continue;
              }
              // On a periodic face: OCCT again with the point a period on and back in each periodic direction. Only
              // where a shifted point agrees is the difference OCCT's classifier not reducing (u, v) by the period.
              const shifts: [number, number][] = [];
              if (info.uPeriod > 0) shifts.push([info.uPeriod, 0], [-info.uPeriod, 0]);
              if (info.vPeriod > 0) shifts.push([0, info.vPeriod], [0, -info.vPeriod]);
              const sq: number[] = [];
              for (const [du, dv] of shifts) sq.push(d.face.id[f]!, u + du, map * (v + dv), map * tolUv[i >> 1]!);
              const shifted = shifts.length ? [...occtClassify(sq)].map(name) : [];
              const seam = (x: number, period: number) => period > 0
                && Math.abs(x - period * Math.round(x / period)) <= 20 * tolUv[i >> 1]!;
              const nearSeam = seam(u, info.uPeriod) || seam(v, info.vPeriod);
              // Outside the surface's (u, v) domain in a direction without a period: not on the face whatever the
              // loops say.
              const sd = g0.surfaceInfo(d.face.surface[f]!);
              const beyond = (x: number, r: (number | null)[], period: number) => !(period > 0)
                && Number.isFinite(r[0]) && Number.isFinite(r[1]) && (x < r[0]! || x > r[1]!);
              const outside = beyond(u, sd.u, info.uPeriod) || beyond(v, sd.v, info.vPeriod);
              const why = !shifts.length ? 'not periodic'
                : shifted.includes(ours!) ? `agrees a period on (OCCT doesn't reduce (u, v) by the period)`
                  : 'not a period on either';
              tally(R.occt, `ours ${ours}, OCCT ${theirs}: ${why}${nearSeam ? ', within 20 x tol of the seam' : ''}`
                + (outside ? ', the point outside the surface\'s domain' : ''),
                `${at}: (${u}, ${v})`);
            }
          }
        } finally {
          if (g !== g0) g.dispose();
        }
      }
      if (probe) probe._occt_probe_free();
      if (seen) R.caught.push(where);
    }
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
  const caught = new Set(all.caught);
  console.log(`${all.files} files, ${all.parts} B-rep parts, ${all.faces} faces, ${all.judged} judged`
    + `${withOcct ? ', with OCCT' : ''}; ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (plant) {
    console.log(`PLANT=${plant}: ${all.planted} parts planted, ${caught.size} seen`);
    for (const w of all.plantedAt) if (!caught.has(w)) console.log(`  not seen: ${w}`);
  }
  printTally('Faces not judged', all.skipped);
  printTally('Nesting (nest2) against the source\'s bounds, by loop', all.nest);
  printTally('Points on the boundary (classify2: on)', all.on);
  printTally('Points moved off the boundary by 10 x tol (classify2: in on the face\'s side, out on the other)',
    all.side);
  printTally('Faces by their moved points, and surface', all.faceSide);
  printTally('Loops (selfIntersect2)', all.self);
  printTally('Statuses other than ok', all.statuses);
  printTally('Faces with classify2 invalidModel, by their loops\' widest joint in 3D', all.gaps);
  if (withOcct) printTally('The moved points against OCCT\'s face classifier', all.occt);
}
