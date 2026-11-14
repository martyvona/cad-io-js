// Tessellation speed of truck against our OCCT backend over the corpus, as stepconv runs them: each file imported
// once, then every brep part through each backend's worker pool (cores - 1 workers, 120 s timeout, kept warm across
// files), OCCT then truck, back to back per file; the medium profile, no edges. Prints each backend's outcomes, run
// time (with and without the files where truck times out or fails) and time in the workers, and, over the parts both
// mesh, the time and triangles of each, by OCCT's time per part; then the slowest parts. Timings only mean something
// on AC power with low power mode off and the CPU otherwise idle. Parts truck hangs on are held out of truck's run
// (HELD_OUT), each otherwise a file's worth of waiting for the timeout; truck_occt.ts still runs them.
// Usage: node --max-old-space-size=8192 corpus_checks/backend_speed.ts [file-list.txt] [max MB, default 2]
//   (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { failedPart, meshDeflections } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { hostLine } from '../scripts/host.ts';

console.log(await hostLine());

const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
const workers = Math.max(1, os.availableParallelism() - 1);
// Medium, the default, as stepconv runs them.
const MESHING = meshDeflections({ profile: 'medium' });
const BACKENDS = ['occt', 'truck'] as const;
type Backend = (typeof BACKENDS)[number];
const pools = {
  occt: new WorkerTessellator({ backend: { module: new URL('../packages/tess-occt/src/index.ts', import.meta.url).href,
    export: 'OcctTessellator' }, workers, timeoutMs: 120_000 }),
  truck: new WorkerTessellator({ backend: { module: new URL('../packages/tess-truck/src/index.ts', import.meta.url)
    .href, export: 'TruckTessellator' }, workers, timeoutMs: 120_000 }),
};
for (const p of Object.values(pools)) await p.init();

// Parts truck doesn't finish in 15 minutes at the medium profile, by file and part index, as the log names them.
const HELD_OUT = new Set([
  'gkv311-opencascade-dataset/step/bug24055_8MTF-75LS05.step part 0',
  'gkv311-opencascade-dataset/step/nist/bug26689_nist_ctc_02_asme1_ap242-2.stp part 1',
  'gkv311-opencascade-dataset/step/nist/bug29531_nist_ctc_02_asme1_ap242-2.stp part 1',
  'gkv311-opencascade-dataset/step/trj12_b3-tu-203.stp part 0',
  'gkv311-opencascade-dataset/step/trj2_as1-id-203.stp part 2',
  'gkv311-opencascade-dataset/step/trj3_as1-id-203.stp part 2',
  'gkv311-opencascade-dataset/step/trj3_s1-id-203.stp part 0',
  'gkv311-opencascade-dataset/step/trj3_s1-id-203.stp part 5',
  'gkv311-opencascade-dataset/step/trj6_as1-id-214.stp part 3',
  'gkv311-opencascade-dataset/step/trj7_k1-id-214.stp part 0',
]);

type Status = 'ok' | 'empty' | 'error' | 'timeout' | 'throw' | 'held out';
interface Run { ms: number; status: Status; triangles: number }
const parts: { file: string; part: number; runs: Partial<Record<Backend, Run>> }[] = [];
const fileMs: { file: string; backend: Backend; ms: number }[] = [];

const files = corpusFiles(process.argv[2]);
for (const [n, f] of files.entries()) {
  if (fs.statSync(f).size > maxBytes) continue;
  const file = shortName(f);
  const { scene } = await importStep(fs.readFileSync(f));
  // Each part's model, what both backends read (OCCT's native route, truck's).
  const brep = scene.parts.flatMap((p, i) => (p.brep ? [{ p, i, b: new Uint8Array(p.brep.model.buffer) }] : []));
  if (!brep.length) continue;
  const rows = brep.map(({ i }) => ({ file, part: i, runs: {} as Partial<Record<Backend, Run>> }));
  parts.push(...rows);
  for (const backend of BACKENDS) {
    const t0 = performance.now();
    let next = 0;
    const worker = async () => {
      while (next < brep.length) {
        const k = next++;
        const { p, b } = brep[k]!;
        if (backend === 'truck' && HELD_OUT.has(`${file} part ${rows[k]!.part}`)) {
          rows[k]!.runs[backend] = { ms: 0, status: 'held out', triangles: 0 };
          continue;
        }
        const t = performance.now();
        let status: Status = 'ok', triangles = 0;
        try {
          const r = await pools[backend].tessellate({ format: 'cad-brep', data: b, origin: p.origin,
            linearDeflection: MESHING.linearDeflection, angularDeflection: MESHING.angularDeflection });
          triangles = r.indices.length / 3;
          if (failedPart(r)) status = 'error';
          else if (!triangles) status = 'empty';
        } catch (e) {
          status = /timed out/.test(String(e)) ? 'timeout' : 'throw';
        }
        rows[k]!.runs[backend] = { ms: performance.now() - t, status, triangles };
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    const ms = performance.now() - t0;
    fileMs.push({ file, backend, ms });
    process.stderr.write(`${n + 1}/${files.length} ${file} ${backend}: ${brep.length} parts, `
      + `${(ms / 1000).toFixed(1)} s\n`);
  }
}
for (const p of Object.values(pools)) p.dispose();

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };
const failedFiles = new Set(parts.filter((p) => ['timeout', 'error', 'throw', 'held out']
  .includes(p.runs.truck?.status ?? ''))
  .map((p) => p.file));
console.log(`${workers} workers; ${new Set(parts.map((p) => p.file)).size} files with brep parts, `
  + `${parts.length} parts; the medium profile`);
for (const b of BACKENDS) {
  const runs = parts.flatMap((p) => (p.runs[b] ? [p.runs[b]!] : []));
  const statuses = Object.entries(Object.groupBy(runs, (r) => r.status)).map(([k, v]) => `${k} ${v!.length}`);
  const own = fileMs.filter((x) => x.backend === b);
  console.log(`${b}: ${statuses.join(', ')}; run ${s(sum(own.map((x) => x.ms)))}, without the ${failedFiles.size} `
    + `files where truck times out, fails or is held out `
    + `${s(sum(own.filter((x) => !failedFiles.has(x.file)).map((x) => x.ms)))}; in the workers ${s(sum(runs.map((r) => r.ms)))}; ${sum(runs.map((r) => r.triangles))} triangles`);
}
const both = parts.filter((p) => p.runs.occt?.status === 'ok' && p.runs.truck?.status === 'ok');
const line = (label: string, g: typeof both) => {
  const o = sum(g.map((p) => p.runs.occt!.ms)), t = sum(g.map((p) => p.runs.truck!.ms));
  console.log(`  ${label}: ${g.length} parts; OCCT ${s(o)}, truck ${s(t)}: ${(o / t).toFixed(2)}x, per part median `
    + `${median(g.map((p) => p.runs.occt!.ms / Math.max(p.runs.truck!.ms, 1e-3))).toFixed(2)}x; truck faster on `
    + `${g.filter((p) => p.runs.truck!.ms < p.runs.occt!.ms).length}; triangles OCCT `
    + `${sum(g.map((p) => p.runs.occt!.triangles))}, truck ${sum(g.map((p) => p.runs.truck!.triangles))}`);
};
console.log(`both mesh (ok): OCCT's time against truck's`);
line('all', both);
for (const [lo, hi] of [[0, 10], [10, 100], [100, 1000], [1000, 10000], [10000, Infinity]] as const) {
  const g = both.filter((p) => p.runs.occt!.ms >= lo && p.runs.occt!.ms < hi);
  if (g.length) line(`OCCT ${lo}-${hi} ms`, g);
}
console.log(`OCCT ok and truck not: ${parts.filter((p) => p.runs.occt?.status === 'ok' && p.runs.truck?.status !== 'ok')
  .length}; truck ok and OCCT not: ${parts.filter((p) => p.runs.truck?.status === 'ok' && p.runs.occt?.status !== 'ok')
  .length}`);
const missing = [...HELD_OUT].filter((k) => !parts.some((p) => `${p.file} part ${p.part}` === k));
if (missing.length) console.log(`held out but not in this run: ${missing.join('; ')}`);
console.log('slowest parts:');
const worst = (p: (typeof parts)[number]) => Math.max(...Object.values(p.runs).map((r) => r.ms));
for (const p of [...parts].sort((a, b) => worst(b) - worst(a)).slice(0, 12)) {
  console.log(`  ${p.file} part ${p.part}: ${BACKENDS.map((b) => `${b} ${s(p.runs[b]?.ms ?? 0)} ${p.runs[b]?.status}`)
    .join(', ')}`);
}
