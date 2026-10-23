// Phase 1 step 4: for every int and real in the corpus, what the schema says the slot holds. Decides whether raw
// JSON could leave the int/real distinction to schema context (it can't on its own: see CLAUDE.md,
// "Decisions"), and lists the number-kind violations Layer 2's tolerance policy must absorb.
// Usage: node corpus_checks/number_kinds.ts [file-list.txt]
import fs from 'node:fs';
import { listItems, parseStep, type Value } from '../packages/step-parser/src/index.ts';
import { Schema, dictionaryForFileSchema, type SchemaDictionary,
  type TypeRef } from '../packages/step-schemas/src/index.ts';
import { corpusFiles, repoDir, shortName } from './corpus.ts';
const schemas: Record<string, Schema> = {};
for (const id of ['ap203', 'ap203e2', 'ap214e3', 'ap242']) schemas[id] = new Schema(
  JSON.parse(fs.readFileSync(`${repoDir}/packages/step-schemas/dict/${id}.json`, 'utf8')) as SchemaDictionary);
const tally = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const t = tally.get(k); if (t) t.n++; else tally.set(k, { n: 1, ex }); };
function expected(s: Schema, t: TypeRef | undefined): string {
  for (let i = 0; i < 20; i++) {
    if (t === undefined) return 'no-context';
    if (typeof t !== 'string') return 'aggregate';
    if (['INTEGER', 'REAL', 'NUMBER', 'LOGICAL', 'BOOLEAN', 'STRING', 'BINARY'].includes(t)) return t;
    const d = s.type(t);
    if (!d) return s.entity(t) ? 'entity' : 'unknown-type';
    if (d.kind !== 'defined') return d.kind;
    t = d.type;
  }
  return 'loop';
}
function walk(s: Schema | undefined, t: TypeRef | undefined, v: Value, where: string) {
  if (v.k === 'reals' || v.k === 'ints' || v.k === 'refs') v = { k: 'list', v: listItems(v) };
  if (v.k === 'list') {
    const el = s && t !== undefined && typeof t !== 'string' ? t.of : s && typeof t === 'string' ? (
      () => { let x: TypeRef | undefined = t;
      for (let i = 0; i < 20 && typeof x === 'string'; i++) { const d = s.type(x);
      if (!d || d.kind !== 'defined') return undefined;
      x = d.type; } return typeof x === 'string' ? undefined : x.of; })() : undefined;
    for (const x of v.v) walk(s, el, x, where);
  } else if (v.k === 'typed') walk(s, v.type, v.v, where);
  else if (v.k === 'int' || v.k === 'real') {
    const e = s ? expected(s, t) : 'no-context';
    note(`${v.k} where context says ${e}`, where);
  }
}
for (const f of corpusFiles(process.argv[2])) {
  const file = parseStep(fs.readFileSync(f));
  const id = dictionaryForFileSchema(file.schemaNames);
  const sch = id ? schemas[id] : undefined;
  for (const inst of file.instances(() => {})) {
    const parts = 'parts' in inst ? inst.parts : [{ type: inst.type, attrs: inst.attrs }];
    const members = parts.map((p) => p.type);
    for (const { type, attrs } of parts) {
      let slots = sch && sch.entity(type) && members.every((m) => sch.entity(m)) ? (
        parts.length === 1 ? sch.instanceAttributes(type) : sch.partialAttributes(type, members)) : undefined;
      if (slots && slots.length !== attrs.length) slots = undefined;
      attrs.forEach((a, k) => walk(slots ? sch : undefined, slots?.[k]?.type, a,
        `${shortName(f)} #${inst.id} ${type}${slots ? '.' + slots[k]!.name : '[' + k + ']'}`));
    }
  }
}
for (const [k, v] of [...tally].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(9),
  k.padEnd(40), v.ex);
