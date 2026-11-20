// cad-oracle over the corpus, face by face on each part's B-rep model, against the references it can be checked by:
//   - today's area oracle (cad-scene's area-oracle.ts, a separate implementation of the elementary closed forms):
//     where both trust a face, the areas must agree within both error estimates (plus 1e-9 of the area, plus a strip
//     as wide as the largest gap between an edge's curve's end and its vertex: today's runs through the vertices,
//     ours along the curves), OCCT's measure saying which is nearer where they don't; the perimeters within 1e-6
//     where the vertices are on the curves;
//   - OCCT's measures (tess-occt's: BRepGProp over OCCT's healed pieces), classified: where they differ by more than
//     1 %, OCCT's own mesh of the face (medium) says which side it's on (a mesh that far off its own measure is
//     OCCT measuring wrong, or meshing wrong); and plane perimeters against ours (other faces' count the edges
//     OCCT's healing split them along).
//   - free-form faces (B-splines, offsets, rectangular trims: the oracle's free-form method, which today's doesn't
//     cover), trusted and not apart, wherever the oracle computed an area: against OCCT's measure and SMLib's
//     (tess-smlib's: its own exact areas, on parts with such faces, SMLIB=0 to skip), the nearer within 1e-6, 1e-4 or
//     past, or the two within 1e-6 of each other but not of ours (a disagreement, noted where it's within the tolerance
//     strip, the perimeter times the face's tolerance: the p-curves and the edges' curves may differ by that, and the
//     measures may take the curves); past 1e-4, OCCT's mesh of the face says which side it's on (nearer ours, or nearer
//     a measure: a disagreement) where the difference is past the mesh's resolution (its perimeter times the
//     deflection), else unrefereed.
// The oracle's coverage by surface kind: trusted, flagged (by flag), unsupported (by why). Planted bugs, in about one
// part in 10 (corpus.ts's plantedPart): PLANT=area scales the oracle's area by 1 + 1e-6 (each planted face both trust
// must disagree with today's oracle, where the allowance is at most half that), PLANT=perimeter its perimeter by
// 1 + 1e-5 (against today's oracle's perimeter, within 1e-6, where both trust a face and its vertices are on its
// curves), PLANT=free a free-form face's area by 1 + 1e-5 (each planted face a measure agreed with within 1e-6 must
// no longer agree within 1e-6).
// Usage: node --max-old-space-size=8192 corpus_checks/oracle_corpus.ts [file-list.txt] [max MB, default 1000]
import fs from 'node:fs';
import { type BrepData, curveEvaluator, decode, edgeParams, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { meshDeflections, tessellateScene, type Mesh } from '../packages/cad-scene/src/index.ts';
import { modelFaceArea, trustedArea } from '../packages/cad-scene/src/area-oracle.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { StepTessellator } from '../packages/step-export/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { type FaceMeasure, init, Oracle, type OracleModule, trusted } from '../packages/cad-oracle/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const { linearDeflection: LINEAR_MM, angularDeflection: ANGULAR } = meshDeflections({ profile: 'medium' });
/** Trusted: the oracle's error within this of its area (as today's oracle's trustedArea). */
const TRUST = 1e-6;
/** OCCT's measure this far off (relative) is refereed by its mesh. */
const OFF = 0.01;
const EXAMPLES = 6;
/** Perimeters agree within this (relative; today's is extrapolated from polylines), and the plants' sizes. */
const PERIM = 1e-6, AREA_PLANT = 1e-6, PERIM_PLANT = 1e-5, FREE_PLANT = 1e-5;
/** The free-form method's surface kinds. */
const FREE_KINDS = new Set<number>([SURFACE_KIND.bspline, SURFACE_KIND.offset, SURFACE_KIND.rectangularTrimmed]);
const useSmlib = process.env.SMLIB !== '0';
const bins = [1e-12, 1e-9, 1e-6, 1e-4, 1e-2, 0.1, Infinity];
const plant = process.env.PLANT;
const kindName = (k: number) => Object.keys(SURFACE_KIND).find((n) => SURFACE_KIND[n as keyof typeof SURFACE_KIND]
  === k) ?? `kind ${k}`;

type Tally = Record<string, { n: number; ex: string[] }>;
const fresh = () => ({
  files: 0, skipped: 0, parts: 0, faces: 0, failed: [] as string[],
  coverage: {} as Tally, vsToday: {} as Tally, vsOcct: {} as Tally, refereed: {} as Tally, free: {} as Tally,
  freeHist: bins.map(() => 0), freeSlowest: 0, freeSlowestAt: '', freeMs: 0, smlibFailed: 0,
  areaHist: bins.map(() => 0), perimHist: bins.map(() => 0), worstToday: 0, worstTodayAt: '',
  planted: 0, plantedCaught: 0, plantedMissed: [] as string[], msOracle: 0, msToday: 0,
});
type Result = ReturnType<typeof fresh>;

function add(t: Tally, key: string, ex: string) {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (e.ex.length < EXAMPLES) e.ex.push(ex);
}
function bin(h: number[], x: number) {
  const k = bins.findIndex((b) => x <= b);
  h[k] = h[k]! + 1;
}

/** Each face's mesh area, by its source id. */
function meshAreas(mesh: Mesh): Map<number, number> {
  const out = new Map<number, number>(), p = mesh.positions, ix = mesh.indices;
  for (const f of mesh.faces) {
    if (f.source === null) continue;
    let a = 0;
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const A = 3 * ix[k]!, B = 3 * ix[k + 1]!, C = 3 * ix[k + 2]!;
      const u0 = p[B]! - p[A]!, u1 = p[B + 1]! - p[A + 1]!, u2 = p[B + 2]! - p[A + 2]!;
      const v0 = p[C]! - p[A]!, v1 = p[C + 1]! - p[A + 1]!, v2 = p[C + 2]! - p[A + 2]!;
      a += Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
    }
    out.set(f.source, (out.get(f.source) ?? 0) + a);
  }
  return out;
}

/**
 * The largest distance of an edge's curve's end from its vertex on the face (Infinity where one can't be evaluated):
 * a boundary by the curves (ours) and one through the vertices (today's oracle's lines, its samples' ends) differ by
 * at most a strip that wide along the perimeter.
 */
function vertexGap(d: BrepData, f: number): number {
  let worst = 0;
  for (const l of decode.face(d, f).loops) {
    if (l.kind !== 'edge') continue;
    for (const c of l.coedges) {
      const e = decode.edge(d, c.edge), ev = e.curve === undefined ? undefined : curveEvaluator(d, e.curve);
      const r = ev && edgeParams(d, c.edge, ev);
      if (!ev || !r || e.start === undefined || e.end === undefined) return Infinity;
      for (const [t, v] of [[r[0], e.start], [r[1], e.end]] as const) {
        const p = ev.point(t);
        worst = Math.max(worst, Math.hypot(p[0]! - d.vertex.point[3 * v]!, p[1]! - d.vertex.point[3 * v + 1]!,
          p[2]! - d.vertex.point[3 * v + 2]!));
      }
    }
  }
  return worst;
}

/**
 * The tolerance a face's boundary is known to, as the face API takes it (cad-geom's tolerance.h): the part's
 * uncertainty (1e-5 where it gives none), widened by the face's own tolerance and its edges'.
 */
function faceTolerance(d: BrepData, f: number): number {
  const u = d.part.uncertainty[0]!;
  let tol = Number.isFinite(u) && u > 0 ? u : 1e-5;
  const widen = (t: number | undefined) => { if (t !== undefined && Number.isFinite(t) && t > tol) tol = t; };
  widen(d.face.tolerance[f]);
  for (const l of decode.face(d, f).loops) {
    if (l.kind === 'edge') for (const c of l.coedges) widen(d.edge.tolerance[c.edge]);
  }
  return tol;
}

/**
 * A free-form face (the oracle's area computed) against the referees: OCCT's and SMLib's measures, the nearer of
 * them, and past 1e-4 OCCT's mesh; a plant (PLANT=free) judged where a measure agreed within 1e-6 before it.
 */
function freeFace(R: Result, m: FaceMeasure, at: string, om: { area: number; valid: boolean } | undefined,
  meshArea: number | undefined, smArea: number | undefined, uncertainty: number, planted: boolean) {
  const ok = trusted(m, TRUST), a = m.area.value;
  const refs: [string, number][] = [];
  if (om && om.valid) refs.push(['OCCT', om.area]);
  if (smArea !== undefined && Number.isFinite(smArea)) refs.push(['SMLib', smArea]);
  const best = (v: number) => Math.min(...refs.map(([, x]) => Math.abs(x - v) / Math.abs(v)));
  const side = ok ? 'trusted' : `not trusted (${m.flags.join(', ') || 'its error'})`;
  if (!refs.length) {
    add(R.free, `${side}: no referee (neither measured it)`, at);
    return;
  }
  const rel = best(a), near = refs.filter(([, x]) => Math.abs(x - a) / Math.abs(a) <= 1e-6).map(([w]) => w);
  if (ok) bin(R.freeHist, rel);
  let cls: string;
  const nearest = refs.reduce((p, q) => Math.abs(q[1] - a) < Math.abs(p[1] - a) ? q : p);
  // A mesh's area is off its face's by up to about its perimeter times the deflection (an inscribed boundary).
  const resolution = m.perimeter.status === 'ok' ? m.perimeter.value * LINEAR_MM : Infinity;
  // The face's boundary is known only to its tolerance: its p-curves and its edges' curves (which the
  // measures may take instead) can differ by that strip along the perimeter.
  const strip = m.perimeter.status === 'ok' ? m.perimeter.value * uncertainty : 0;
  const inStrip = Math.abs(nearest[1] - a) <= strip ? ', within the tolerance strip' : '';
  if (rel <= 1e-6) cls = `within 1e-6 of ${near.length === refs.length && refs.length > 1 ? 'both measures'
    : `${near.join(' and ')}'s measure${refs.length > 1 ? ' only' : ''}`}`;
  else if (refs.length > 1 && Math.abs(refs[0]![1] - refs[1]![1]) <= 1e-6 * Math.abs(a)) {
    cls = `the measures within 1e-6 of each other, not of ours${inStrip}: DISAGREE`;
  } else if (rel <= 1e-4) cls = 'within 1e-4 of a measure';
  else if (meshArea === undefined || meshArea === 0) cls = 'past 1e-4 of the measures, OCCT has no mesh of it';
  else if (Math.abs(nearest[1] - a) <= resolution) {
    cls = 'past 1e-4 of the measures, within OCCT\'s mesh\'s resolution (perimeter x deflection)';
  } else {
    cls = Math.abs(meshArea - a) < Math.abs(meshArea - nearest[1])
      ? 'past 1e-4 of the measures, OCCT\'s mesh nearer ours'
      : `past 1e-4, OCCT's mesh nearer ${nearest[0]}'s measure${inStrip}: DISAGREE`;
  }
  add(R.free, `${side}: ${cls}`, `${at}: ours ${a.toPrecision(10)} (+/- ${m.area.error.toPrecision(2)}), ${refs.map(
    ([w, x]) => `${w}'s ${x.toPrecision(10)}`).join(', ')}, OCCT's mesh ${meshArea?.toPrecision(8)}`);
  if (planted && rel <= 1e-6) {
    R.planted++;
    if (best(a * (1 + FREE_PLANT)) > 1e-6) R.plantedCaught++;
    else if (R.plantedMissed.length < EXAMPLES) R.plantedMissed.push(at);
  }
}

let pool: WorkerTessellator, smlib: WorkerTessellator | undefined, module: OracleModule, maxBytes = 1e9;

export const check: FileCheck<undefined, Result> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 1000) * 1e6;
    pool = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
      export: 'OcctTessellator' }, workers: meshWorkers });
    await pool.init();
    if (useSmlib) {
      smlib = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-smlib/src/index.ts'),
        export: 'SmlibTessellator' }, workers: meshWorkers });
      await smlib.init();
    }
    module = await init();
  },
  async file(path, _job, ctx) {
    const R = fresh(), name = shortName(path);
    const bytes = fs.readFileSync(path);
    if (bytes.length > maxBytes) { R.skipped++; return R; }
    const { scene } = await importStep(new Uint8Array(bytes));
    R.files++;
    const meshes = new Map<number, Mesh | undefined>();
    await tessellateScene(scene, new StepTessellator(pool), { linearDeflection: LINEAR_MM, angularDeflection: ANGULAR,
      measures: true, oracle: false, onPart: (i, m) => { meshes.set(i, m); } });
    for (const [pi, part] of scene.parts.entries()) {
      const d = part.brep?.model;
      if (!d) continue;
      R.parts++;
      ctx.progress(`${name} #${part.sources[0]?.id}`);
      const where = `${name} #${part.sources[0]?.id}`, planted = !!plant && plantedPart(where);
      const occt = part.measures?.faces, mesh = meshes.get(pi), meshArea = mesh ? meshAreas(mesh) : new Map();
      // SMLib's exact areas, where the part has free-form faces.
      let smArea: Map<number, number> | undefined;
      let hasFree = false;
      for (let f = 0; f < rowCount(d, 'face'); f++) hasFree ||= FREE_KINDS.has(d.surface.kind[d.face.surface[f]!]!);
      if (smlib && hasFree) {
        const r = await smlib.tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer), origin: part.origin,
          linearDeflection: LINEAR_MM, angularDeflection: ANGULAR, measures: true }).catch((e: Error) => e);
        if (r instanceof Error) R.smlibFailed++;
        else smArea = new Map((r.measures ?? []).filter((x) => x.valid !== false).map((x) => [x.entityId, x.area]));
      }
      using o = new Oracle(module, d.buffer);
      const seen = new Map<number, number>();
      for (let f = 0; f < rowCount(d, 'face'); f++) seen.set(d.face.id[f]!, (seen.get(d.face.id[f]!) ?? 0) + 1);
      for (let f = 0; f < rowCount(d, 'face'); f++) {
        R.faces++;
        const id = d.face.id[f]!, kind = kindName(d.surface.kind[d.face.surface[f]!]!), at = `${where} face #${id}`;
        let t0 = performance.now();
        const m = o.face(f);
        const ms = performance.now() - t0;
        R.msOracle += ms;
        if (FREE_KINDS.has(d.surface.kind[d.face.surface[f]!]!)) {
          R.freeMs += ms;
          if (ms > R.freeSlowest) R.freeSlowest = ms, R.freeSlowestAt = at;
          if (m.area.status === 'ok' && seen.get(id)! === 1) {
            freeFace(R, m, at, occt?.get(id), meshArea.get(id), smArea?.get(id), faceTolerance(d, f),
              planted && plant === 'free');
          }
        }
        if (planted && plant === 'area') m.area.value *= 1 + AREA_PLANT;
        if (planted && plant === 'perimeter') m.perimeter.value *= 1 + PERIM_PLANT;
        const ok = trusted(m, TRUST);
        add(R.coverage, `${kind.padEnd(11)} ${m.area.status !== 'ok' ? `${m.area.status}: ${m.why}`
          : ok ? 'trusted' : m.flags.length ? `flagged ${m.flags.join(', ')}` : 'error estimate past 1e-9'}`, at);
        // Today's oracle, where it covers the face.
        t0 = performance.now();
        const t = modelFaceArea(d, f);
        R.msToday += performance.now() - t0;
        if (trustedArea(t)) {
          if (!ok) add(R.vsToday, `today's trusts, ours doesn't (${m.flags.join(', ') || m.why || m.area.status})`, at);
          else {
            // Both errors, and the strip the two boundaries may differ by where vertices are off their curves.
            const gap = vertexGap(d, f), onCurves = gap <= 1e-9 * t.perimeter;
            const diff = Math.abs(m.area.value - t.area);
            const slack = t.error + m.area.error + 1e-9 * t.area + 2 * gap * t.perimeter;
            if (!Number.isFinite(gap)) {
              add(R.vsToday, 'both trust, an edge not evaluated by cad-brep: not compared', at);
            } else {
              if (t.area > 0 && diff / t.area > R.worstToday && diff <= slack) {
                R.worstToday = diff / t.area, R.worstTodayAt = at;
              }
              // Where they disagree: whether by less than the model's own tolerance along the perimeter (a boundary
              // known no better than that: a line off its cylinder, which today's runs straight in (u, v) and ours
              // along its image), and OCCT's measure (where valid) as a third opinion.
              const om = occt?.get(id);
              const strip = (Number.isFinite(d.part.uncertainty[0]!) ? d.part.uncertainty[0]! : 1e-5) * t.perimeter;
              const third = diff <= slack ? '' : `${diff <= strip ? ' within the tolerance strip' : ''}${!om || !om.valid
                ? ', OCCT not measured' : Math.abs(om.area - m.area.value) < Math.abs(om.area - t.area)
                ? ', OCCT nearer ours' : ', OCCT nearer today\'s'}`;
              add(R.vsToday, diff <= slack ? `both trust, areas agree${onCurves ? '' : ' (vertices off their curves)'}`
                : `both trust, areas DISAGREE${third}`, `${at}: ${m.area.value} vs ${t.area} (+/- ${
                  t.error.toPrecision(2)}, vertex gap ${gap.toPrecision(2)}${om ? `, OCCT ${om.area}` : ''})`);
              const perimDiff = Math.abs(m.perimeter.value - t.perimeter);
              if (onCurves) add(R.vsToday, perimDiff <= PERIM * t.perimeter ? 'perimeters agree (vertices on curves)'
                : 'perimeters DISAGREE (vertices on curves)', `${at}: ${m.perimeter.value} vs ${t.perimeter}`);
              // A plant is judged only where it can be seen: an area's past the allowance by a factor of 2, a
              // perimeter's where the two perimeters are the same measure.
              const visible = plant === 'area' ? slack <= 0.5 * AREA_PLANT * t.area : onCurves;
              if (planted && visible && (plant === 'area' || plant === 'perimeter')) {
                R.planted++;
                const caught = plant === 'area' ? diff > slack : perimDiff > PERIM * t.perimeter;
                if (caught) R.plantedCaught++;
                else if (R.plantedMissed.length < EXAMPLES) R.plantedMissed.push(at);
              }
            }
          }
        } else if (ok && t.ok) add(R.vsToday, `ours trusts, today's doesn't (${t.flags.join(', ') || 'its error'})`,
          at);
        // OCCT's measures, where it measured the face (once: a face sharing its id with others is left out).
        const om = occt?.get(id);
        if (!ok || !om || !om.valid || seen.get(id)! > 1) continue;
        const rel = (om.area - m.area.value) / m.area.value;
        bin(R.areaHist, Math.abs(rel));
        // (Perimeters on planes only: OCCT's over its healed pieces count edges its healing split a face along.)
        if (m.perimeter.status === 'ok' && kind === 'plane') bin(R.perimHist, Math.abs(om.perimeter
          - m.perimeter.value) / m.perimeter.value);
        add(R.vsOcct, `${kind.padEnd(11)} ${Math.abs(rel) <= 1e-6 ? 'within 1e-6' : Math.abs(rel) <= 1e-4
          ? 'within 1e-4' : Math.abs(rel) <= OFF ? `within ${OFF}` : `past ${OFF}`}`, at);
        if (Math.abs(rel) > OFF) {
          const ma = meshArea.get(id);
          const side = ma === undefined || ma === 0 ? 'OCCT has no mesh of it'
            : Math.abs(ma - m.area.value) < Math.abs(ma - om.area) ? 'its mesh nearer ours'
            : 'its mesh nearer its measure';
          add(R.refereed, `${kind.padEnd(11)} ${side}`, `${at}: ours ${m.area.value.toPrecision(8)}, OCCT's ${
            om.area.toPrecision(8)}, its mesh ${ma?.toPrecision(8)}`);
        }
      }
    }
    return R;
  },
  async teardown() {
    await pool?.dispose?.();
    await smlib?.dispose?.();
  },
};

/** One run's results into another: counts summed, tallies' examples kept up to EXAMPLES, the worst kept. */
function merge(all: Result, r: Result) {
  for (const k of ['files', 'skipped', 'parts', 'faces', 'planted', 'plantedCaught', 'msOracle', 'msToday', 'freeMs',
    'smlibFailed'] as const) {
    all[k] += r[k];
  }
  for (const k of ['coverage', 'vsToday', 'vsOcct', 'refereed', 'free'] as const) {
    for (const [key, e] of Object.entries(r[k])) {
      const a = all[k][key] ??= { n: 0, ex: [] };
      a.n += e.n;
      a.ex.push(...e.ex.slice(0, EXAMPLES - a.ex.length));
    }
  }
  addInto(all.areaHist, r.areaHist), addInto(all.perimHist, r.perimHist), addInto(all.freeHist, r.freeHist);
  if (r.freeSlowest > all.freeSlowest) { all.freeSlowest = r.freeSlowest; all.freeSlowestAt = r.freeSlowestAt; }
  if (r.worstToday > all.worstToday) { all.worstToday = r.worstToday; all.worstTodayAt = r.worstTodayAt; }
  all.failed.push(...r.failed);
  all.plantedMissed.push(...r.plantedMissed.slice(0, EXAMPLES - all.plantedMissed.length));
}

if (import.meta.main) {
  console.log(await hostLine());
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) all.failed.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      else merge(all, out.result);
    });
  for (const l of all.failed) console.log(l);
  const show = (title: string, t: Tally, examples = true) => {
    console.log(`\n${title}`);
    for (const [k, e] of Object.entries(t).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))) {
      console.log(`${String(e.n).padStart(8)}  ${k}`);
      if (examples && (/DISAGREE|past/.test(k) || !/trusted$|agree$|within/.test(k))) {
        for (const x of e.ex) console.log(`            ${x}`);
      }
    }
  };
  const hist = (h: number[]) => bins.map((b, k) => `<= ${b === Infinity ? 'inf' : b.toExponential(0)}: ${h[k]}`)
    .join(', ');
  console.log(`${all.files} files (${all.skipped} over the size limit), ${all.parts} parts, ${all.faces} faces; `
    + `the oracle ${(all.msOracle / 1000).toFixed(1)} s, today's ${(all.msToday / 1000).toFixed(1)} s`);
  if (plant) console.log(`PLANT=${plant}: ${all.planted} planted faces compared, ${all.plantedCaught} caught (${
    all.plantedCaught === all.planted ? 'all' : `NOT ALL; missed ${all.plantedMissed.join('; ')}`})`);
  show('Coverage (every face of every part), by surface kind:', all.coverage);
  show('Against today\'s area oracle (area-oracle.ts):', all.vsToday);
  console.log(`  the largest agreeing difference: ${all.worstToday.toExponential(2)} (${all.worstTodayAt})`);
  show('Against OCCT\'s measures, where ours is trusted and OCCT\'s valid:', all.vsOcct, false);
  console.log(`  relative difference of the area: ${hist(all.areaHist)}`);
  console.log(`  of the perimeter, planes only: ${hist(all.perimHist)}`);
  show(`OCCT's measure more than ${OFF * 100} % off ours, by its own mesh:`, all.refereed);
  show(`Free-form faces against OCCT's and SMLib's measures${useSmlib ? '' : ' (SMLIB=0: OCCT\'s only)'}, past 1e-4 by `
    + `OCCT's mesh:`, all.free);
  console.log(`  trusted, the nearer measure's relative difference: ${hist(all.freeHist)}`);
  console.log(`  the free-form faces' oracle time ${(all.freeMs / 1000).toFixed(1)} s, the slowest ${
    all.freeSlowest.toFixed(0)} ms (${all.freeSlowestAt}); SMLib failed on ${all.smlibFailed} parts`);
}
