// Phase 1 step 6: run the Layer 3 extractors on every corpus file and tally what they find and every diagnostic.
// The geometric checks against OCCT are in products_occt.ts and validation_occt.ts.
// Usage: node corpus_checks/semantic_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { extractSemantics, openModel, parseStep } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const tally = new Map<string, { n: number; files: Set<string>; ex: string }>();
const note = (k: string, file: string, ex: string, n = 1) => {
  let t = tally.get(k);
  if (!t) tally.set(k, (t = { n: 0, files: new Set(), ex }));
  t.n += n;
  t.files.add(file);
};
let files = 0, time = 0;
const totals = { products: 0, roots: 0, nauo: 0, mapped: 0, placed: 0, reps: 0, styled: 0, layers: 0, validation: 0,
  external: 0 };

for (const path of corpusFiles(process.argv[2])) {
  files++;
  const name = short(path);
  const m = await openModel(parseStep(fs.readFileSync(path)));
  const t = performance.now();
  const s = extractSemantics(m);
  time += performance.now() - t;
  const st = s.structure;
  totals.products += st.products.length;
  totals.roots += st.roots.length;
  totals.reps += st.representations.size;
  for (const o of st.occurrences) {
    if (o.kind === 'nauo') totals.nauo++;
    else totals.mapped++;
    if (o.transform) totals.placed++;
    else note('occurrence without a placement', name, `${name} #${o.id}`);
  }
  for (const p of st.products) {
    if (!p.shapes.length) note('product without a shape representation', name, `${name} #${p.id}`);
    totals.external += p.documents.filter((d) => d.external).length;
  }
  if (st.roots.length !== 1) note(`files with ${st.roots.length === 0 ? 'no' : 'several'} roots`, name, name);
  totals.styled += s.styles.styled.length;
  totals.layers += s.styles.layers.length;
  totals.validation += s.validation.length;
  for (const d of s.diagnostics) note(`${d.severity}: ${d.message}`, name, `${name} #${d.id}`);
}

console.log(`${files} files; extraction ${(time / 1000).toFixed(1)} s`);
console.log(`${totals.products} product definitions, ${totals.roots} roots, ${totals.reps} shape `
  + `representations reached`);
console.log(`${totals.nauo} NAUO occurrences + ${totals.mapped} mapped-item occurrences, ${totals.placed} with a `
  + `placement; ${totals.external} external documents`);
console.log(`${totals.styled} styled items, ${totals.layers} layers, ${totals.validation} validation properties`);
for (const [k, v] of [...tally].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7),
  String(v.files.size).padStart(4), k, ' e.g.', v.ex);
