// Phase 1 step 2: parse and fully decode every corpus file; re-run the step 1 schema slot check with the real parser.
// Usage: node corpus_checks/parser_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { parseStep, type Value } from '../packages/step-parser/src/index.ts';
import { Schema, dictionaryForFileSchema, type SchemaDictionary } from '../packages/step-schemas/src/index.ts';
import { corpusFiles, repoDir, shortName as short } from './corpus.ts';

const schemas: Record<string, Schema> = {};
for (const id of ['ap203', 'ap203e2', 'ap214e3', 'ap242'])
  schemas[id] = new Schema(JSON.parse(
    fs.readFileSync(`${repoDir}/packages/step-schemas/dict/${id}.json`, 'utf8')) as SchemaDictionary);

const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const p = problems.get(k); if (p) p.n++;
  else problems.set(k, { n: 1, ex }); };
const stats: Record<string, { files: number; inst: number; ok: number; bad: number }> = {};
let bytesTotal = 0, tScan = 0, tDec = 0, decodeErrors = 0, instTotal = 0;

for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  bytesTotal += bytes.length;
  let t = performance.now();
  const file = parseStep(bytes);
  tScan += performance.now() - t;
  for (const d of file.diagnostics) note(`diag ${d.severity}: ${d.message.replace(/#\d+/g, '#N')}`, short(f));
  const id = dictionaryForFileSchema(file.schemaNames);
  const st = (stats[id ?? 'none'] ??= { files: 0, inst: 0, ok: 0, bad: 0 });
  st.files++;
  const sch = id ? schemas[id] : undefined;
  t = performance.now();
  for (const inst of file.instances(
    (p, e) => { decodeErrors++; note(`decode error: ${e.message.replace(/ at byte \d+/, '')}`,
    `${short(f)} ${file.sourceAt(p).slice(0, 100)}`); })) {
    instTotal++;
    if (!sch) continue;
    st.inst++;
    const parts = 'parts' in inst ? inst.parts : [{ type: inst.type, attrs: inst.attrs }];
    const members = parts.map((p) => p.type);
    let good = true;
    for (const { type, attrs } of parts) {
      if (!sch.entity(type)) { note(`${id} unknown entity ${type}`, short(f)); good = false; continue; }
      if (parts.length > 1 && members.some((x) => !sch.entity(x))) { good = false; continue; }
      const slots = parts.length === 1 ? sch.instanceAttributes(type) : sch.partialAttributes(type, members);
      if (slots.length !== attrs.length) {
        note(`${id} ${parts.length > 1 ? 'partial ' : ''}${type}: expected ${slots.length} attrs, got ${attrs.length}`,
        `${short(f)} #${inst.id}`); good = false; continue; }
      slots.forEach((sl, k) => {
        const v = attrs[k] as Value;
        if (sl.derived !== (v.k === 'derived')) {
          note(`${id} ${type}.${sl.name} ${sl.derived ? 'derived but not *' : 'is * but not derived'}`,
          `${short(f)} #${inst.id}`); good = false; }
      });
    }
    good ? st.ok++ : st.bad++;
  }
  tDec += performance.now() - t;
}
console.log(`${instTotal} instances, ${(bytesTotal / 1e6).toFixed(0)} MB; scan ${(tScan / 1000).toFixed(1)} s, decode `
  + `${(tDec / 1000).toFixed(1)} s (decode time includes the schema check); ${decodeErrors} decode errors`);
console.table(stats);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k,
  ' e.g.', v.ex);
