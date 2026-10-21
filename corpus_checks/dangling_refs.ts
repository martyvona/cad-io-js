// The importer's dangling-reference warnings for every corpus file: per part, references to instances the file
// doesn't define; per file, references beyond the largest instance id (the scan). Lists each file with either, with
// the parts and ids, to compare with what OCCT reports (docs/phase4_progress.md, "Dangling references").
// Usage: node corpus_checks/dangling_refs.ts [file-list.txt]  (progress on standard error)
import fs from 'node:fs';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, shortName } from './corpus.ts';

const totals = { files: 0, filesWith: 0, parts: 0, partsWith: 0, beyond: 0 };
const t0 = Date.now();
for (const f of corpusFiles(process.argv[2])) {
  const name = shortName(f);
  process.stderr.write(`${name}\n`);
  totals.files++;
  const { scene } = await importStep(fs.readFileSync(f));
  totals.parts += scene.parts.length;
  const dangling = scene.diagnostics.filter((d) => /^\d+ references? to (an )?instances? the file doesn't define/.test(d.message));
  const beyond = scene.diagnostics.filter((d) => d.message.startsWith('reference beyond the largest instance id'));
  if (!dangling.length && !beyond.length) continue;
  totals.filesWith++;
  totals.partsWith += dangling.length;
  totals.beyond += beyond.length;
  console.log(`${name}: ${dangling.length} parts with dangling references, ${beyond.length} references beyond the largest id`);
  for (const d of [...dangling, ...beyond].slice(0, 5)) console.log(`  #${d.source?.id}: ${d.message}`);
}
console.log(`files ${totals.files}, ${totals.filesWith} with dangling references; parts ${totals.parts}, ${totals.partsWith} with dangling references; ${totals.beyond} references beyond the largest id; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
