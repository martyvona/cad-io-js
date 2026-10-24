// Phase 2 step 2: build a subset for every shape representation the product structure reaches, as the importer will
// (its MAPPED_ITEMs left out, since what they map is placed separately), and check it: the subset parses without
// diagnostics, every instance in it equals the source's (the root minus its mapped items), and every reference it
// lacks is dangling in the source too.
// Usage: node corpus_checks/subset_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { buildSubset, extractSemantics, listItems, makeList, openModel, parseStep, type Instance,
  type Value } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const p = problems.get(k); if (p) p.n++;
  else problems.set(k, { n: 1, ex }); };
let files = 0, subsets = 0, instances = 0, bytes = 0, time = 0, withExclusions = 0;

// The root as the subset should have it: references to excluded ids removed from its lists.
function strip(inst: Instance, ids: Set<number>): Instance {
  const f = (v: Value): Value => {
    if (v.k === 'list' || v.k === 'refs') {
      return makeList(listItems(v).filter((e) => !(e.k === 'ref' && ids.has(e.v))).map(f));
    }
    return v.k === 'typed' ? { ...v, v: f(v.v) } : v;
  };
  return 'parts' in inst ? { id: inst.id, parts: inst.parts.map((r) => ({ type: r.type, attrs: r.attrs.map(f) })) } : {
    id: inst.id, type: inst.type, attrs: inst.attrs.map(f) };
}

for (const path of corpusFiles(process.argv[2])) {
  files++;
  const name = short(path);
  const file = parseStep(fs.readFileSync(path));
  const model = await openModel(file);
  const sem = extractSemantics(model);
  for (const rep of sem.structure.representations.values()) {
    const root = model.resolve(rep.id);
    const exclude = new Set(rep.related.filter((x) => x.via === 'mapped-item').map((x) => model.resolve(x.source)));
    // Mapped items that place occurrences are also among the items; leave out every mapped item in the root.
    for (const id of rep.items) { const q = model.resolve(id);
      if (model.isInstanceOf(q, 'MAPPED_ITEM')) exclude.add(q); }
    if (exclude.size) withExclusions++;
    const t = performance.now();
    let sub;
    try {
      sub = buildSubset(file, [root], { exclude });
    } catch (e) {
      note(`build failed: ${(e as Error).message}`, `${name} #${rep.id}`);
      continue;
    }
    time += performance.now() - t;
    subsets++;
    bytes += sub.bytes.length;
    instances += sub.positions.length;
    const parsed = parseStep(sub.bytes);
    for (const d of parsed.diagnostics) note(`subset diagnostic: ${d.message}`, `${name} #${rep.id}`);
    const excludedIds = new Set([...exclude].map((p) => file.index.ids[p]!));
    let k = 0;
    for (const inst of parsed.instances(
      (_, e) => note(`subset instance malformed: ${e.message}`, `${name} #${rep.id}`))) {
      const p = sub.positions[k++]!;
      const source = file.instanceAt(p);
      const expected = p === root ? strip(source, excludedIds) : source;
      if (!isDeepStrictEqual(inst, expected)) note('subset instance differs from the source',
        `${name} #${rep.id} -> #${inst.id}`);
    }
    if (k !== sub.positions.length) note('subset instance count differs', `${name} #${rep.id}`);
    for (const id of sub.missing) {
      if (model.resolve(id) >= 0) note(
        'missing reference that the source resolves (needed by an excluded mapped item\'s neighbour)',
        `${name} #${rep.id} -> #${id}`);
    }
  }
}
console.log(`${files} files, ${subsets} subsets (${withExclusions} with mapped items left out), ${instances} instances,`
  + ` ${(bytes / 1e6).toFixed(1)} MB; building took ${(time / 1000).toFixed(1)} s`);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k,
  ' e.g.', v.ex);
