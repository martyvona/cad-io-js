// Phase 3 step 3: tessellation speed of truck module variants (and our OCCT backend for reference), single-threaded on
// this thread, over phase 0's subsets (test_corpus/subsets/out and out_bike, made by make_subsets.ts; each the model of
// its part as step-import reads its source file, those whose representation is no part left out), at phase 0's 0.05
// file units (OCCT also 0.5 rad), without edges, as phase 0 timed them. Skips trj2_as1-id-203 #891, which hangs truck
// (phase 0). Only meaningful with the CPU otherwise idle and not in low power mode.
// Usage: node corpus_checks/truck_bench.ts [truck.wasm ...]   (default packages/tess-truck/dist/tess_truck.wasm)
import fs from 'node:fs';
import path from 'node:path';
import type { Scene, Tessellator } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { TruckTessellator } from '../packages/tess-truck/src/index.ts';
import { corpusFiles, repoDir } from './corpus.ts';

const SKIP = /trj2_as1-id-203\.stp\.absr\.891\./;
const sets = ['out', 'out_bike'].map((d) => path.join(repoDir, 'test_corpus/subsets', d));
/** A subset's part in its source file (the corpus file its name starts with): its model's bytes, if it's a part. */
const sources = new Map(corpusFiles().map((f) => [path.basename(f), f]));
const scenes = new Map<string, Promise<Scene>>();
async function model(name: string): Promise<Uint8Array | undefined> {
  const [, source, root] = /^(.*)\.absr\.(\d+)\.stp$/.exec(name)!;
  const from = sources.get(source!);
  if (!from) throw new Error(`${name}: no corpus file ${source}`);
  if (!scenes.has(from)) scenes.set(from, importStep(new Uint8Array(fs.readFileSync(from))).then((r) => r.scene));
  const p = (await scenes.get(from)!).parts.find((q) => q.brep && q.sources[0]?.id === Number(root));
  return p?.brep ? new Uint8Array(p.brep.model.buffer) : undefined;
}
const subsets = await Promise.all(sets.map(async (dir) => ({
  dir: path.basename(dir),
  files: (await Promise.all(fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f) && !SKIP.test(f)).sort()
    .map(model))).flatMap((data) => (data ? [{ data }] : [])),
})));
const variants = process.argv.slice(2);
if (!variants.length) variants.push(path.join(repoDir, 'packages/tess-truck/dist/tess_truck.wasm'));

async function bench(name: string, make: () => Promise<Tessellator>) {
  const t0 = performance.now();
  const t = await make();
  const startup = performance.now() - t0;
  const cols: string[] = [];
  for (const s of subsets) {
    let ms = 0, tris = 0, failed = 0;
    for (const f of s.files) {
      const t1 = performance.now();
      const r = await t.tessellate(
        { format: 'cad-brep', data: f.data, linearDeflection: 0.05, angularDeflection: 0.5 });
      ms += performance.now() - t1;
      tris += r.indices.length / 3;
      if (!r.indices.length) failed++;
    }
    cols.push(`${s.dir} (${s.files.length}): ${(ms / 1000).toFixed(2)} s, ${tris} triangles, ${failed} empty`);
  }
  console.log(`${name}: startup ${startup.toFixed(0)} ms; ${cols.join('; ')}`);
  t.dispose();
}

for (const v of variants) {
  const size = fs.statSync(v).size;
  await bench(`truck ${path.basename(v)} (${size} bytes)`,
    async () => { const t = new TruckTessellator(); await t.init({ wasm: fs.readFileSync(v) }); return t; });
}
await bench('occt', async () => { const t = new OcctTessellator(); await t.init(); return t; });
