// Phase 1 step 5: bind every corpus instance with value checks (Layer 2), tallying how instances bind and every
// diagnostic. Also builds the reverse-reference index and type index of each file and cross-checks them against
// the forward references.
// Usage: node corpus_checks/bind_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { openModel, ParseError, parseStep } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const tally = new Map<string, { n: number; files: Set<string>; ex: string }>();
const note = (k: string, file: string, ex: string) => {
  let t = tally.get(k);
  if (!t) tally.set(k, (t = { n: 0, files: new Set(), ex }));
  t.n++;
  t.files.add(file);
};
const stats: Record<string, { files: number; inst: number; bySchema: number; byFallback: number; unbound: number }> = {};
let nInst = 0, malformed = 0, tBind = 0, tRev = 0, tTypes = 0, revEntries = 0;

for (const path of corpusFiles(process.argv[2])) {
  const f = parseStep(fs.readFileSync(path));
  const m = await openModel(f);
  const name = short(path);
  const st = (stats[m.schema?.name ?? `none (${m.fallback?.name ?? 'no fallback'})`] ??= { files: 0, inst: 0, bySchema: 0, byFallback: 0, unbound: 0 });
  st.files++;
  for (const d of m.diagnostics) note(`model ${d.severity}: ${d.message.replace(/\(.*\)/, '(…)')}`, name, name);

  let t = performance.now();
  for (let p = 0; p < f.count; p++) {
    let b;
    try {
      b = m.bind(p, { check: true });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      malformed++;
      continue;
    }
    nInst++;
    st.inst++;
    if (!b.schema) st.unbound++;
    else if (b.schema === m.schema) st.bySchema++;
    else st.byFallback++;
    for (const d of b.diagnostics) note(`${d.severity}: ${d.message}`, name, `${name} #${b.id}`);
  }
  tBind += performance.now() - t;

  // Reverse references: every resolved forward reference p → q appears exactly once in referrers(q).
  t = performance.now();
  m.referrers(0);
  tRev += performance.now() - t;
  const ix = f.index;
  let expected = 0;
  for (let p = 0; p < ix.count; p++) {
    const targets = new Set<number>();
    for (const r of ix.refsOf(p)) { const q = ix.position(r); if (q >= 0) targets.add(q); }
    expected += targets.size;
    for (const q of targets) if (!m.referrers(q).includes(p)) note('reverse index: missing referrer', name, `${name} #${ix.ids[p]}`);
  }
  let total = 0;
  for (let q = 0; q < ix.count; q++) total += m.referrers(q).length;
  if (total !== expected) note(`reverse index: ${total} entries, expected ${expected}`, name, name);
  revEntries += total;

  // instancesOf(REPRESENTATION_ITEM) agrees with isInstanceOf on every instance.
  t = performance.now();
  const items = new Set(m.instancesOf('REPRESENTATION_ITEM'));
  tTypes += performance.now() - t;
  for (let p = 0; p < ix.count; p++) if (items.has(p) !== m.isInstanceOf(p, 'REPRESENTATION_ITEM')) note('instancesOf disagrees with isInstanceOf', name, `${name} #${ix.ids[p]}`);
}

console.log(`${nInst} instances bound (${malformed} malformed); bind+check ${(tBind / 1000).toFixed(1)} s; reverse index ${(tRev / 1000).toFixed(1)} s, ${revEntries} entries; type index ${(tTypes / 1000).toFixed(1)} s`);
console.table(stats);
for (const [k, v] of [...tally].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(8), String(v.files.size).padStart(4), k, ' e.g.', v.ex);
