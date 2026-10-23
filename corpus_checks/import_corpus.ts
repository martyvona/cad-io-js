// Phase 2 step 3: import every corpus file into the scene model; check each scene structurally (cad-scene's
// validate), check that it agrees with the semantic layer (a component per product, an occurrence per placed
// occurrence, every part's payload a subset whose root is the part), and tally what the scenes hold.
// Usage: node corpus_checks/import_corpus.ts [file-list.txt] [payload checks: all | none, default all]
import fs from 'node:fs';
import { instances, partInstances, validate } from '../packages/cad-scene/src/index.ts';
import { parseStep } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string, n = 1) => { const p = problems.get(k); if (p) p.n += n;
  else problems.set(k, { n, ex }); };
const t = { files: 0, components: 0, parts: 0, partInstances: 0, hidden: 0, materials: 0, faceMaterialParts: 0,
  faceMaterials: 0, componentMaterials: 0, overrides: 0, layers: 0, external: 0, payloadBytes: 0, time: 0 };
const checkPayloads = (process.argv[3] ?? 'all') === 'all';

for (const path of corpusFiles(process.argv[2])) {
  const name = short(path);
  const start = performance.now();
  const { scene, semantics } = await importStep(fs.readFileSync(path));
  t.time += performance.now() - start;
  t.files++;
  for (const p of validate(scene)) note(`invalid scene: ${p.replace(/\d+/g, 'N')}`, name);
  if (scene.components.length !== semantics.structure.products.length) note('components ≠ products', name);
  const occurrences = scene.components.reduce((n, c) => n + c.children.length, 0);
  if (occurrences !== semantics.structure.occurrences.length) note('occurrences ≠ semantic occurrences', name);
  t.components += scene.components.length;
  t.parts += scene.parts.length;
  t.materials += scene.materials.length;
  t.overrides += scene.overrides.length;
  t.layers += scene.layers.length;
  t.external += scene.components.filter((c) => c.external).length;
  t.componentMaterials += scene.components.filter((c) => c.material !== undefined).length;
  for (const p of scene.parts) {
    if (p.faceMaterials?.length) { t.faceMaterialParts++; t.faceMaterials += p.faceMaterials.length; }
    if (p.kind === 'brep' && checkPayloads) {
      const bytes = p.payload();
      t.payloadBytes += bytes.length;
      const sub = parseStep(bytes);
      if (sub.diagnostics.length) note('payload with diagnostics', `${name} #${p.rootId}`);
      if (p.rootId === undefined || sub.index.position(p.rootId) < 0) note('payload without its root',
        `${name} #${p.rootId}`);
    }
    if (!p.origin.every(Number.isFinite)) note('non-finite origin', `${name} #${p.sources[0]?.id}`);
  }
  for (const pi of partInstances(scene)) { t.partInstances++; if (!pi.visible) t.hidden++; }
  if ([...instances(scene)].length === 0 && scene.components.length) note('no instances', name);
  for (const d of scene.diagnostics) if (
    d.message.startsWith('representation without a length unit') || d.message.startsWith('context-dependent')) note(
    `diagnostic: ${d.message}`, `${name} #${d.source?.id}`);
}
console.log(`${t.files} files imported in ${(t.time / 1000).toFixed(1)} s: ${t.components} components, ${t.parts} `
  + `parts, ${t.partInstances} part instances (${t.hidden} hidden)`);
console.log(`${t.materials} materials; ${t.componentMaterials} component materials; ${t.faceMaterialParts} parts with `
  + `per-face materials (${t.faceMaterials} faces); ${t.overrides} instance overrides; ${t.layers} layers; `
  + `${t.external} external components`);
if (checkPayloads) console.log(`payloads: ${(t.payloadBytes / 1e6).toFixed(1)} MB, all parsed`);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k,
  ' e.g.', v.ex);
