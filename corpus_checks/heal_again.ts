// Healing again with other options (cad-heal's healPart given a healed model's analysis): on every B-rep part, its
// model healed by each option set (SETS), then each healed model healed again by every other set, which must give
// what healing the source with that set does, byte for byte (the model and its analysis) and saying the same (but
// where the first healing moved stray poles: said kept in strayPole's place, which the check counts apart); healed
// again by its own set, the model and analysis given back, nothing said; and no curve row healing appended left
// unreferenced. Per pair: parts compared, parts differing, and per difference (a table and column of the model or the
// analysis, or the diagnostics) its count and examples. Parts whose first healing takes over CAP_S seconds (default
// 30) are skipped and counted, so the run stays bounded (each part heals SETS^2 times).
// Usage: CHILDREN=8 IDLE_MS=0 node --max-old-space-size=8192 corpus_checks/heal_again.ts [file-list.txt] [max MB]
//   PLANT=1: every tenth part's re-heal given its analysis with one coedge's givenPcurve changed (a planted provenance
//   error), to show the check sees it.
import fs from 'node:fs';
import { ANALYSIS_TABLES, type BrepAnalysis, type BrepData, openAnalysis, rowCount, TABLES } from
  '../packages/cad-brep/src/index.ts';
import { init, type GeomModule } from '../packages/cad-geom/src/index.ts';
import { healPart, type HealOptions } from '../packages/cad-heal/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const SETS: Record<string, HealOptions> = {
  defaults: {},
  allOn: { fixes: { pcurveMissingOnPlane: true, pcurveMissingOnElementary: true, pcurveMissingOnFreeForm: true } },
  fineFit: { fixes: { pcurveMissingOnFreeForm: true }, pcurveFitTolerance: 1e-4 },
  tolerancesOff: { fixes: { edgeTolerance: false, vertexTolerance: false, pcurveEnds: false } },
  shellsOff: { fixes: { orientShells: false } },
};
const CAP_S = Number(process.env.CAP_S ?? 30), EXAMPLES = 4, plant = process.env.PLANT === '1';
let maxMB = 1000, module: GeomModule;
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, k: string, ex: string) => {
  const e = t[k] ??= { n: 0, ex: [] };
  e.n++;
  if (e.ex.length < EXAMPLES) e.ex.push(ex);
};
const fresh = () => ({ files: 0, parts: 0, healed: 0, capped: 0, cappedEx: [] as string[], heals: 0, ms: 0,
  planted: 0, plantedSeen: 0, keptSaid: 0,
  pairs: {} as Record<string, { parts: number; differ: number; why: Tally }> });
type Result = ReturnType<typeof fresh>;

/** The columns two buffers of a layout differ in, as table.column (with the rows where their counts differ). */
function differ(tables: Record<string, readonly (readonly [string, string, number])[]>, x: unknown, y: unknown,
  what: string): string[] {
  const out: string[] = [], X = x as Record<string, Record<string, ArrayLike<number>>>;
  const Y = y as Record<string, Record<string, ArrayLike<number>>>;
  for (const [t, cols] of Object.entries(tables)) {
    for (const [c] of cols) {
      const a = X[t]?.[c], b = Y[t]?.[c];
      if (!a || !b) continue;
      if (a.length !== b.length) out.push(`${what} ${t}.${c} (lengths ${a.length} and ${b.length})`);
      else for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) { out.push(`${what} ${t}.${c}`); break; }
    }
  }
  return out;
}
const said = (ds: { message: string }[], strayPoles = false) => ds.map((d) => d.message)
  .filter((m) => !strayPoles || !m.startsWith('strayPole:')).join('\n');
const KEPT = /^strayPole: \d+ stray poles moved by an earlier healing kept$/;

/** The curve rows from `from` on that no coedge references. */
function unreferenced(m: BrepData, from: number): number {
  const used = new Set(m.coedge.pcurve);
  let n = 0;
  for (let k = from; k < rowCount(m, 'curve'); k++) if (!used.has(k)) n++;
  return n;
}

/** The analysis with one coedge's givenPcurve changed (a planted provenance error), or none where nothing changes. */
function plantedAnalysis(a: BrepAnalysis, m: BrepData): BrepAnalysis | undefined {
  const b = openAnalysis(new Uint8Array(a.buffer.slice(0)));
  for (let c = 0; c < rowCount(m, 'coedge'); c++) {
    if (b.coedge.givenPcurve[c]! >= 0) {
      b.coedge.givenPcurve[c] = -1;
      return b;
    }
  }
  return undefined;
}

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    module = await init();
  },
  async file(file, _job, ctx) {
    const R = fresh();
    if (fs.statSync(file).size > maxMB * 1e6) return R;
    R.files++;
    const started = Date.now(), name = shortName(file);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(file)), { heal: { heal: false } });
    for (const part of scene.parts) {
      const m = part.brep?.model;
      if (!m) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`, at = (what: string) => ctx.progress(`${where}: ${what}`);
      const once: Record<string, Awaited<ReturnType<typeof healPart>>> = {};
      let capped = false;
      for (const [k, o] of Object.entries(SETS)) {
        at(`healing (${k})`);
        const t = Date.now();
        once[k] = await healPart(m, o, module);
        R.heals++;
        if (k === 'defaults' && (Date.now() - t) / 1000 > CAP_S) {
          capped = true;
          break;
        }
      }
      if (capped) {
        R.capped++;
        if (R.cappedEx.length < EXAMPLES) R.cappedEx.push(where);
        continue;
      }
      if (!Object.values(once).some((h) => h.changed)) continue;
      R.healed++;
      const planting = plant && plantedPart(where);
      for (const [A, a] of Object.entries(once)) {
        for (const [B, b] of Object.entries(once)) {
          at(`healing (${A}) again (${B})`);
          let analysis = a.analysis;
          if (planting && A !== B && A === 'defaults' && analysis) {
            analysis = plantedAnalysis(analysis, a.model);
            if (analysis) R.planted++;
          }
          const twice = await healPart(a.model, SETS[B]!, module, undefined, analysis);
          R.heals++;
          const key = `h(h(m, ${A}), ${B})`, P = R.pairs[key] ??= { parts: 0, differ: 0, why: {} };
          P.parts++;
          const why: string[] = [];
          if (A === B) {
            if (twice.model !== a.model || twice.analysis !== a.analysis) why.push('the same options: not given back');
            if (twice.diagnostics.length) why.push('the same options: something said');
          } else {
            why.push(...differ(TABLES, twice.model, b.model, 'model'));
            why.push(...differ(ANALYSIS_TABLES, twice.analysis, b.analysis, 'analysis'));
            const moved = (a.analysis?.healing.strayPoles[0] ?? 0) > 0;
            if (said(twice.diagnostics, moved) !== said(b.diagnostics, moved)) why.push('the diagnostics');
            if (moved) {
              R.keptSaid++;
              if (twice.diagnostics.filter((d) => KEPT.test(d.message)).length !== 1) {
                why.push('stray poles moved before not said kept');
              }
            }
          }
          if (unreferenced(twice.model, rowCount(m, 'curve'))) why.push('curve rows healing appended unreferenced');
          if (why.length) {
            P.differ++;
            for (const w of why) tally(P.why, w, where);
            if (planting && A === 'defaults' && A !== B && analysis !== a.analysis) R.plantedSeen++;
          }
        }
      }
    }
    R.ms = Date.now() - started;
    return R;
  },
};

if (import.meta.main) {
  console.log(await hostLine());
  const started = Date.now();
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else addInto(all, out.result);
    });
  console.log(`${all.files} files, ${all.parts} B-rep parts; ${all.healed} changed by some set, ${all.capped} skipped `
    + `(the defaults' healing over ${CAP_S} s: ${all.cappedEx.join(', ')}); ${all.heals} healings, `
    + `${((Date.now() - started) / 1000).toFixed(0)} s wall, ${(all.ms / 1000).toFixed(0)} s in files`);
  console.log(`Sets: ${Object.entries(SETS).map(([k, o]) => `${k} ${JSON.stringify(o)}`).join('; ')}`);
  if (plant) console.log(`PLANT=1: ${all.planted} planted, ${all.plantedSeen} seen`);
  console.log(`${all.keptSaid} healings again of parts whose stray poles an earlier healing moved (said kept, their `
    + 'diagnostics compared but for strayPole\'s)');
  for (const [k, P] of Object.entries(all.pairs)) {
    console.log(`  ${k}: ${P.differ} of ${P.parts} parts differ`);
    for (const [w, e] of Object.entries(P.why).sort((x, y) => y[1].n - x[1].n)) {
      console.log(`    ${String(e.n).padStart(5)}  ${w}  (${e.ex.join('; ')})`);
    }
  }
}
