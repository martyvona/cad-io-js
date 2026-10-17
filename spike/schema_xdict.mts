import fs from 'node:fs';
import { Schema, type SchemaDictionary } from '/Users/vona/src/mine/step_js/packages/step-schemas/src/index.ts';
const ids = ['ap203', 'ap203e2', 'ap214e3', 'ap242'];
const sch: Record<string, Schema> = {};
for (const id of ids) sch[id] = new Schema(JSON.parse(fs.readFileSync(`/Users/vona/src/mine/step_js/packages/step-schemas/dict/${id}.json`, 'utf8')) as SchemaDictionary);
const ap242 = sch.ap242!;
for (const id of ids.slice(0, 3)) {
  const s = sch[id]!;
  let common = 0, same = 0; const diffs: string[] = [];
  for (const e of Object.keys(s.dict.entities)) {
    if (!ap242.entity(e)) continue;
    common++;
    const a = s.instanceAttributes(e).map((x) => x.name + (x.derived ? '*' : '')).join(',');
    const b = ap242.instanceAttributes(e).map((x) => x.name + (x.derived ? '*' : '')).join(',');
    if (a === b) same++; else diffs.push(`${e}: ${id}(${a}) vs ap242(${b})`);
  }
  const only = Object.keys(s.dict.entities).filter((e) => !ap242.entity(e));
  console.log(`\n${id}: ${common} entities shared with ap242, ${same} identical layouts, ${diffs.length} differ; ${only.length} not in ap242: ${only.slice(0, 40).join(' ')}`);
  for (const d of diffs) console.log('  ', d);
}
// which corpus-unknown entities exist in ap242?
const unk = fs.readFileSync(process.argv[2]!, 'utf8').matchAll(/(ap\w+) unknown entity (\w+)/g);
const res: Record<string, string[]> = { inAp242: [], notInAp242: [] };
for (const m of unk) (ap242.entity(m[2]!) ? res.inAp242 : res.notInAp242).push(`${m[1]}:${m[2]}`);
console.log('\nunknown in corpus, found in ap242:', res.inAp242.length, '\nnot found in ap242:', res.notInAp242.join(' '));
