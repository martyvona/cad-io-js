// Phase 3 step 3: tessellation speed of truck module variants (and our OCCT backend for reference), single-threaded
// on this thread, over phase 0's subsets (test_corpus/subsets/out and out_bike, made by make_subsets.ts), at
// phase 0's 0.05 file units (OCCT also 0.5 rad), without edges, as phase 0 timed them. Skips trj2_as1-id-203 #891,
// which hangs truck (phase 0). Only meaningful with the CPU otherwise idle and not in low power mode.
// Usage: node corpus_checks/truck_bench.ts [truck.wasm ...]   (default packages/tess-truck/dist/tess_truck.wasm)
import fs from 'node:fs';
import path from 'node:path';
import type { Tessellator } from '../packages/cad-scene/src/index.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { TruckTessellator } from '../packages/tess-truck/src/index.ts';
import { repoDir } from './corpus.ts';

const SKIP = /trj2_as1-id-203\.stp\.absr\.891\./;
const sets = ['out', 'out_bike'].map((d) => path.join(repoDir, 'test_corpus/subsets', d));
const subsets = sets.map((dir) => ({
  dir: path.basename(dir),
  files: fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f) && !SKIP.test(f)).sort().map(
    (f) => ({ data: fs.readFileSync(path.join(dir, f)), rootId: Number(/\.absr\.(\d+)\.stp$/.exec(f)![1]) })),
}));
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
        { format: 'step', data: f.data, rootId: f.rootId, linearDeflection: 0.05, angularDeflection: 0.5 });
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
