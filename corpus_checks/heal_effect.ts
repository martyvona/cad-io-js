// What healing on at import would cost and change, for the decision to flip cad-heal's HEAL_BY_DEFAULT: every file
// imported as it is and imported again then healed (step-import's healImported, cad-heal's poolHealer in a pool, each
// part within HEAL_CPU_TIMEOUT_MS of CPU time), and every B-rep part's model, as imported and healed, meshed by OCCT
// (its native route) and SMLib (each in a tess-workers pool) at the medium profile with measures:
//   - cost: healing's CPU time (the process's, its pool's threads included) and wall time per file, the slowest parts'
//     files, parts that hit the CPU cap (kept as imported);
//   - per backend: faces meshed (with triangles) as imported and healed, faces gained and lost, parts failed (an
//     error, a timeout, a crash, no triangles) either way, triangles, OCCT's measure's validity;
//   - cad-oracle: faces whose area it trusts as imported and healed;
//   - healing's diagnostics: by severity and by message (numbers and ids folded), the parts with a tolerance error;
//   - the files with the most faces lost or gained per backend, and with the largest change in triangles;
//   - the faces lost by the mesher's cause healed, and faces failed past repair, where the mesher says (tess-cadio).
// BACKENDS=occt,smlib,cadio picks the meshers (default occt,smlib; cadio: our own tessellator, tess-cadio); HEAL_ON=
// fixes on beyond the defaults (HEAL_ON=pcurveMissing,pcurveMissingOnPlane: a p-curve for every bare use; an alias,
// cad-heal's FIX_ALIASES, as its fixes).
// HYBRID=1 adds OCCT on the healed model less the p-curves healing added (coedges the source gave none), to tell
// what OCCT makes of those from what it makes of the rest of the healing.
// Usage: CHILDREN=3 MESH_WORKERS=2 IDLE_MS=0 node --max-old-space-size=8192 corpus_checks/heal_effect.ts
//   [file-list.txt] [max MB, default 1000]   (IDLE_MS=0: a part's healing tells the runner nothing for minutes)
import fs from 'node:fs';
import { MESH_PROFILES, type TessellationRequest, type TessellationResult, failedPart } from
  '../packages/cad-scene/src/index.ts';
import { openBrep, rowCount } from '../packages/cad-brep/src/index.ts';
import { healImported, importStep } from '../packages/step-import/src/index.ts';
import { fixesNamed, poolHealer } from '../packages/cad-heal/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { init, Oracle, type OracleModule, trusted } from '../packages/cad-oracle/src/index.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const EXAMPLES = 4;
const { linearDeflection: LIN, angularDeflection: ANG } = MESH_PROFILES.medium;
type Tally = Record<string, { n: number; ex: string[] }>;
const hybrid = process.env.HYBRID === '1';
type Backend = 'occt' | 'smlib' | 'cadio' | 'occtHybrid';
/** HEAL_ON=<fixes>: fixes turned on beyond the defaults (the pcurveMissing ones). */
const healOn = Object.fromEntries((process.env.HEAL_ON ?? '').split(',').filter(Boolean).flatMap((f) => {
  if (!fixesNamed(f).length) throw new Error(`HEAL_ON: no fix named ${f}`);
  return fixesNamed(f).map((x) => [x, true]);
}));
/** BACKENDS=occt,smlib,cadio (default occt,smlib): which meshers. */
const backends = [...(process.env.BACKENDS ?? 'occt,smlib').split(',') as Backend[],
  ...hybrid ? ['occtHybrid' as const] : []];
const side = () => ({ parts: 0, failed: 0, faces: 0, triangles: 0, measuresValid: 0, ms: 0 });
const fresh = () => ({
  files: 0, skipped: 0, parts: 0, faces: 0, healCpuMs: 0, healWallMs: 0, importCpuMs: 0,
  slowest: [] as { ms: number; file: string }[], capped: 0,
  mesh: Object.fromEntries(backends.map((b) => [b as string, { before: side(), after: side(), gained: 0, lost: 0,
    partsGained: 0, partsLost: 0, gainedEx: [] as string[], lostEx: [] as string[], lostBy: {} as Tally,
    pastRepair: { before: 0, after: 0 } }])) as Record<Backend, {
    before: ReturnType<typeof side>; after: ReturnType<typeof side>; gained: number; lost: number;
    partsGained: number; partsLost: number; gainedEx: string[]; lostEx: string[]; lostBy: Tally;
    pastRepair: { before: number; after: number } }>,
  trusted: { before: 0, after: 0 },
  /** Per backend and file: faces lost, gained, triangles before and after. */
  perFile: {} as Record<string, Record<string, { lost: number; gained: number; tb: number; ta: number }>>,
  severity: {} as Record<string, number>, messages: {} as Tally, errorParts: [] as string[],
});
type Result = ReturnType<typeof fresh>;
const add = (t: Tally, k: string, ex: string) => {
  const e = t[k] ??= { n: 0, ex: [] };
  e.n++;
  if (e.ex.length < EXAMPLES) e.ex.push(ex);
};
/** A diagnostic's message with its numbers, ids and lists folded, so like messages tally together. */
const fold = (m: string) => m.replace(/#\d+/g, '#N').replace(/\d+(\.\d+)?(e[-+]?\d+)?/g, 'N')
  .replace(/: (coedge|edge|vertex|face|curve) #.*$/, '')
  .slice(0, 200);

let maxBytes = 1e9, module: OracleModule;
const pools = {} as Partial<Record<Backend | 'heal', WorkerTessellator>> & { heal: WorkerTessellator };
let workers = 1;

/** The mesher's cause for a face failed, where it says (tess-cadio's "faces failed to mesh, by cause" info). */
function causes(r: TessellationResult | Error): Map<number, string> {
  const out = new Map<number, string>();
  if (r instanceof Error) return out;
  for (const d of r.diagnostics) {
    if (!d.message.startsWith(BY_CAUSE)) continue;
    for (const k of d.message.slice(BY_CAUSE.length).split('; ')) {
      const m = /^(.*) \d+ \((#\d+(?:, #\d+)*)\)$/.exec(k);
      if (m) for (const id of m[2]!.split(', ')) out.set(Number(id.slice(1)), m[1]!);
    }
  }
  return out;
}
const BY_CAUSE = 'faces failed to mesh, by cause: ';
/** tess-cadio's cause for a face through an edge or vertex whose healed tolerance is past repair (toleranceError). */
const PAST_REPAIR = 'past repair';

/** Each source face's triangle count in a result. */
function facesMeshed(r: TessellationResult): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of r.faces) {
    if (f.count > 0 && f.entityId !== null) out.set(f.entityId, (out.get(f.entityId) ?? 0) + f.count / 3);
  }
  return out;
}

export const check: FileCheck<undefined, Result> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 1000) * 1e6;
    workers = meshWorkers;
    const pool = (pkg?: string, cls?: string) => new WorkerTessellator({ ...pkg ? { backend: {
      module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls! } } : {}, workers: meshWorkers });
    if (backends.includes('occt') || hybrid) pools.occt = pool('tess-occt', 'OcctTessellator');
    if (backends.includes('smlib')) pools.smlib = pool('tess-smlib', 'SmlibTessellator');
    if (backends.includes('cadio')) pools.cadio = pool('tess-cadio', 'CadioTessellator');
    if (hybrid) pools.occtHybrid = pools.occt;
    pools.heal = pool();
    await Promise.all([...new Set(Object.values(pools))].map((p) => p!.init()));
    module = await init();
  },
  async teardown() {
    await Promise.all([...new Set(Object.values(pools))].map((p) => p!.dispose()));
  },
  async file(path, _job, ctx) {
    const R = fresh(), name = shortName(path);
    const bytes = fs.readFileSync(path);
    if (bytes.length > maxBytes) { R.skipped++; return R; }
    R.files++;
    let c0 = process.cpuUsage();
    const { scene: before } = await importStep(new Uint8Array(bytes), { heal: { heal: false } });
    R.importCpuMs += (process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000;
    const { scene: after } = await importStep(new Uint8Array(bytes), { heal: { heal: false } });
    const nDiag = after.diagnostics.length;
    ctx.progress(`${name}: healing`);
    c0 = process.cpuUsage();
    const w0 = performance.now();
    await healImported(after, { heal: { heal: true, concurrency: workers, fixes: healOn,
      healer: poolHealer(pools.heal, import.meta.resolve('../packages/cad-heal/src/index.ts')) },
      onProgress: (p) => ctx.progress(`${name}: healing ${p.done}/${p.total}`) });
    const cpu = process.cpuUsage(c0), wall = performance.now() - w0;
    R.healCpuMs += (cpu.user + cpu.system) / 1000, R.healWallMs += wall;
    R.slowest.push({ ms: wall, file: name });
    for (const d of after.diagnostics.slice(nDiag)) {
      R.severity[d.severity] = (R.severity[d.severity] ?? 0) + 1;
      const where = `${name}${d.source ? ` ${JSON.stringify(d.source).slice(0, 80)}` : ''}`;
      add(R.messages, `${d.severity}: ${fold(d.message)}`, where);
      if (/healing (failed|stopped)|timed out|CPU/.test(d.message)) R.capped++;
      if (d.severity === 'error' && R.errorParts.length < EXAMPLES) {
        R.errorParts.push(`${where}: ${d.message.slice(0, 160)}`);
      }
    }
    for (let pi = 0; pi < before.parts.length; pi++) {
      const pb = before.parts[pi]!, pa = after.parts[pi]!;
      const db = pb.brep?.model, da = pa.brep?.model;
      if (!db || !da) continue;
      R.parts++;
      R.faces += rowCount(db, 'face');
      const where = `${name} #${pb.sources[0]?.id}`;
      ctx.progress(where);
      // The healed model with its analysis, as tessellateScene sends it to a backend that reads one (tess-cadio: its
      // healed p-curves placed as projected, faces past repair failed).
      const req = (d: typeof db): TessellationRequest => ({ format: 'cad-brep', data: new Uint8Array(d.buffer),
        origin: pb.origin, linearDeflection: LIN, angularDeflection: ANG, measures: true,
        ...d === da && pa.brep?.analysis ? { analysis: new Uint8Array(pa.brep.analysis.buffer) } : {} });
      // The hybrid: the healed model with the p-curves healing added taken out again.
      const lessAdded = () => {
        const copy = new Uint8Array(da.buffer.byteLength);
        copy.set(new Uint8Array(da.buffer));
        const h = openBrep(copy.buffer);
        for (let c = 0; c < rowCount(db, 'coedge'); c++) {
          if (db.coedge.pcurve[c]! < 0 && h.coedge.pcurve[c]! >= 0) {
            h.coedge.pcurve[c] = -1, h.coedge.range[2 * c] = NaN, h.coedge.range[2 * c + 1] = NaN;
          }
        }
        return h;
      };
      const times: number[] = [];
      const runs = await Promise.all(backends.flatMap((b) => [db, b === 'occtHybrid' ? lessAdded() : da].map((d, j) => {
        const t0 = performance.now(), k = 2 * backends.indexOf(b) + j;
        return pools[b]!.tessellate(req(d)).catch((e: Error) => e)
          .finally(() => { times[k] = performance.now() - t0; });
      })));
      for (const [k, b] of backends.entries()) {
        const M = R.mesh[b], rb = runs[2 * k]!, ra = runs[2 * k + 1]!;
        const meshed = (r: TessellationResult | Error, s: ReturnType<typeof side>) => {
          s.parts++;
          if (r instanceof Error || failedPart(r) || !r.indices.length) {
            s.failed++;
            return new Map<number, number>();
          }
          const m = facesMeshed(r);
          s.faces += m.size, s.triangles += r.indices.length / 3;
          s.measuresValid += (r.measures ?? []).filter((x) => x.valid).length;
          return m;
        };
        const mb = meshed(rb, M.before), ma = meshed(ra, M.after);
        M.before.ms += times[2 * k]!, M.after.ms += times[2 * k + 1]!;
        const partFailedBefore = rb instanceof Error || failedPart(rb) || !rb.indices.length;
        const partFailedAfter = ra instanceof Error || failedPart(ra) || !ra.indices.length;
        if (partFailedBefore && !partFailedAfter) M.partsGained++;
        if (!partFailedBefore && partFailedAfter) M.partsLost++;
        const pf = (R.perFile[b] ??= {})[name] ??= { lost: 0, gained: 0, tb: 0, ta: 0 };
        pf.tb += rb instanceof Error ? 0 : rb.indices.length / 3;
        pf.ta += ra instanceof Error ? 0 : ra.indices.length / 3;
        for (const id of ma.keys()) if (!mb.has(id)) pf.gained++;
        for (const id of mb.keys()) if (!ma.has(id)) pf.lost++;
        for (const id of ma.keys()) if (!mb.has(id)) {
          M.gained++;
          if (M.gainedEx.length < EXAMPLES) M.gainedEx.push(`${where} face #${id}`);
        }
        const ca = causes(ra), cb = causes(rb);
        for (const id of mb.keys()) if (!ma.has(id)) {
          M.lost++;
          if (M.lostEx.length < EXAMPLES) M.lostEx.push(`${where} face #${id}`);
          const why = ra instanceof Error ? `the part: ${fold(ra.message)}` : partFailedAfter ? 'the part failed'
            : ca.has(id) ? fold(ca.get(id)!) : 'no cause given';
          const t = M.lostBy[why] ??= { n: 0, ex: [] };
          t.n++;
          if (t.ex.length < 2) t.ex.push(`${where} face #${id}`);
        }
        for (const c of cb.values()) if (c.includes(PAST_REPAIR)) M.pastRepair.before++;
        for (const c of ca.values()) if (c.includes(PAST_REPAIR)) M.pastRepair.after++;
      }
      using ob = new Oracle(module, db.buffer);
      using oa = new Oracle(module, da.buffer);
      for (let f = 0; f < rowCount(db, 'face'); f++) {
        if (trusted(ob.face(f), 1e-6)) R.trusted.before++;
        if (trusted(oa.face(f), 1e-6)) R.trusted.after++;
      }
    }
    return R;
  },
};

function merge(all: Result, r: Result) {
  for (const k of ['files', 'skipped', 'parts', 'faces', 'healCpuMs', 'healWallMs', 'importCpuMs', 'capped'] as const) {
    all[k] += r[k];
  }
  all.slowest.push(...r.slowest);
  all.slowest.sort((a, b) => b.ms - a.ms).splice(10);
  for (const b of backends) {
    const A = all.mesh[b], B = r.mesh[b];
    for (const s of ['before', 'after'] as const) for (const k of Object.keys(A[s]) as (keyof typeof A.before)[]) {
      A[s][k] += B[s][k];
    }
    for (const k of ['gained', 'lost', 'partsGained', 'partsLost'] as const) A[k] += B[k];
    A.gainedEx.push(...B.gainedEx.slice(0, EXAMPLES - A.gainedEx.length));
    A.lostEx.push(...B.lostEx.slice(0, EXAMPLES - A.lostEx.length));
    for (const [k, t] of Object.entries(B.lostBy)) {
      const x = A.lostBy[k] ??= { n: 0, ex: [] };
      x.n += t.n, x.ex.push(...t.ex.slice(0, 2 - x.ex.length));
    }
    A.pastRepair.before += B.pastRepair.before, A.pastRepair.after += B.pastRepair.after;
  }
  all.trusted.before += r.trusted.before, all.trusted.after += r.trusted.after;
  for (const [b, files] of Object.entries(r.perFile)) Object.assign(all.perFile[b] ??= {}, files);
  for (const [k, v] of Object.entries(r.severity)) all.severity[k] = (all.severity[k] ?? 0) + v;
  for (const [k, v] of Object.entries(r.messages)) {
    const a = all.messages[k] ??= { n: 0, ex: [] };
    a.n += v.n, a.ex.push(...v.ex.slice(0, EXAMPLES - a.ex.length));
  }
  all.errorParts.push(...r.errorParts.slice(0, EXAMPLES - all.errorParts.length));
}

if (import.meta.main) {
  console.log(await hostLine());
  const all = fresh(), failed: string[] = [];
  const t0 = performance.now();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((p) => ({ path: p, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) failed.push(`${shortName(f)}: ${out.error.split('\n')[0]}`);
      else merge(all, out.result);
    });
  for (const l of failed) console.log(`failed: ${l}`);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  console.log(`${all.files} files (${all.skipped} over the size limit), ${all.parts} B-rep parts, ${all.faces} faces; `
    + `the run ${s(performance.now() - t0)}`);
  const on = Object.keys(healOn);
  console.log(`\nHealing with cad-heal's default fixes${on.length ? `, and ${on.join(', ')} on` : ''}.`);
  console.log(`Cost: healing ${s(all.healCpuMs)} of CPU (the importing process's, its healing pool included), `
    + `${s(all.healWallMs)} of wall time summed over files; importing (without healing) ${s(all.importCpuMs)} of CPU; `
    + `${all.capped} diagnostics of healing cut short`);
  console.log('  the slowest files to heal (wall):');
  for (const x of all.slowest) console.log(`    ${s(x.ms).padStart(8)}  ${x.file}`);
  for (const b of backends) {
    const M = all.mesh[b];
    console.log(`\n${b}: as imported / healed: parts failed ${M.before.failed} / ${M.after.failed} `
      + `(of ${M.before.parts}),`
      + ` faces meshed ${M.before.faces} / ${M.after.faces}, triangles ${M.before.triangles} / ${M.after.triangles},`
      + ` valid measures ${M.before.measuresValid} / ${M.after.measuresValid}, meshing ${s(M.before.ms)} / `
      + `${s(M.after.ms)} (each request's wall time, summed)`);
    console.log(`  faces gained ${M.gained}, lost ${M.lost}; parts gained ${M.partsGained}, lost ${M.partsLost}`);
    for (const x of M.gainedEx) console.log(`    gained: ${x}`);
    for (const x of M.lostEx) console.log(`    lost:   ${x}`);
    const by = Object.entries(M.lostBy).sort((p, q) => q[1].n - p[1].n);
    if (by.length) console.log('  the faces lost, by the mesher\'s cause healed (where it gives one):');
    for (const [k, t] of by) console.log(`    ${String(t.n).padStart(6)}  ${k}  (${t.ex.join('; ')})`);
    if (M.pastRepair.before || M.pastRepair.after) {
      console.log(`  faces failed past repair (a tolerance healing grew past its error limit): as imported `
        + `${M.pastRepair.before}, healed ${M.pastRepair.after}`);
    }
    const files = Object.entries(all.perFile[b] ?? {});
    console.log('  the files losing the most faces (lost, gained, triangles as imported -> healed):');
    for (const [f, x] of files.filter(([, x]) => x.lost).sort((p, q) => q[1].lost - p[1].lost).slice(0, 12)) {
      console.log(`    ${String(x.lost).padStart(6)} ${String(x.gained).padStart(5)}  ${x.tb} -> ${x.ta}  ${f}`);
    }
    console.log('  the files changing most in triangles:');
    for (const [f, x] of files.sort((p, q) => Math.abs(q[1].ta - q[1].tb) - Math.abs(p[1].ta - p[1].tb)).slice(0, 8)) {
      console.log(`    ${x.tb} -> ${x.ta}  ${f}`);
    }
  }
  console.log(`\ncad-oracle: faces trusted (1e-6) as imported / healed: ${all.trusted.before} / ${all.trusted.after}`);
  console.log(`\nHealing's diagnostics: ${Object.entries(all.severity).map(([k, v]) => `${v} ${k}s`).join(', ')}`);
  for (const [k, e] of Object.entries(all.messages).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(e.n).padStart(8)}  ${k}`);
    for (const x of e.ex) console.log(`            ${x}`);
  }
  if (all.errorParts.length) console.log('  errors, for example:');
  for (const x of all.errorParts) console.log(`    ${x}`);
}
