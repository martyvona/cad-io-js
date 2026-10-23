// Per-part subsets of one STEP file, as phase 0 cut them (CLAUDE.md, "Phase 0"), for the checks that
// tessellate parts one at a time (cache_check.ts, truck_bench.ts): for every shape representation that refers to a
// solid-bearing item, `<file>.absr.<id>.stp` (bare) and `<file>.absr+wrap.<id>.stp` (with a minimal product
// structure). The port of the spike's make_subsets.mjs to step-parser's buildSubset. Usage:
//   node corpus_checks/make_subsets.ts <file.stp> <output dir>
// The sets the checks use (test_corpus/subsets/out: 29 files, 76 parts; out_bike: the bicycle, 112 parts):
//   N=test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files
//   G=test_corpus/third_party/gkv311-opencascade-dataset/step
//   for f in $N/*.stp $G/trj2_as1-id-203.stp $G/trj2_as1-tc-214.stp $G/bug21802_as1-oc-214.stp $G/trj7_k1-*-214.stp \
//            $G/sp7_04-dx-242.stp $G/bug32049_sp7_10nx_242.stp $G/bug33569.stp; do
//     node corpus_checks/make_subsets.ts "$f" test_corpus/subsets/out
//   done
//   node corpus_checks/make_subsets.ts $G/Median_cx-fs01_bicycle.stp test_corpus/subsets/out_bike
import fs from 'node:fs';
import path from 'node:path';
import { buildSubset, parseStep } from '../packages/step-parser/src/index.ts';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) { console.error('usage: make_subsets.ts <file.stp> <output dir>'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const file = parseStep(fs.readFileSync(input));
const ix = file.index;
const types = (p: number): string[] => {
  const t = ix.typeName(p);
  if (t !== undefined) return [t];
  const inst = file.instanceAt(p);
  return 'parts' in inst ? inst.parts.map((r) => r.type) : [inst.type];
};
const SOLIDISH = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL', 'FACETED_BREP'];
let reps = 0;
for (let p = 0; p < ix.count; p++) {
  if (!types(p).some((t) => t.endsWith('SHAPE_REPRESENTATION'))) continue;
  const solid = Array.from(ix.refsOf(p)).some((id) => {
    const q = ix.position(id);
    return q >= 0 && types(q).some((t) => SOLIDISH.includes(t));
  });
  if (!solid) continue;
  reps++;
  const base = path.join(outDir, `${path.basename(input)}.absr`);
  fs.writeFileSync(`${base}.${ix.ids[p]}.stp`, buildSubset(file, [p]).bytes);
  fs.writeFileSync(`${base}+wrap.${ix.ids[p]}.stp`, buildSubset(file, [p], { wrapper: true }).bytes);
}
console.log(reps, 'reps');
