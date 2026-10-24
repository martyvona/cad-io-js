// Phase 1 step 4: round-trip every corpus file through raw JSON and back to Part 21:
// parse (A) -> raw JSON -> load (B) -> Part 21 -> parse (C), checking A == B and A == C instance by instance, plus the
// header and DATA sections. Also checks that the JSON is standard JSON (JSON.parse accepts it), that writing B
// again gives the same bytes, and that the NDJSON form loads back to B too.
// Usage: node corpus_checks/json_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileDocument, parseStep, readJson, readJsonLines, writeJson, writeJsonLines, writeStep, type Instance,
  type StepFile } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const p = problems.get(k); if (p) p.n++;
  else problems.set(k, { n: 1, ex }); };
let files = 0, inBytes = 0, jsonBytes = 0, nInst = 0, skipped = 0, diffB = 0, diffC = 0, tWrite = 0, tRead = 0;
const decoder = new TextDecoder();

function* decoded(f: StepFile): Generator<Instance> {
  yield* f.instances(() => {});
}

function compare(a: StepFile, b: Iterable<Instance>, what: string, path: string): number {
  let n = 0;
  const ia = decoded(a), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done || y.done) { if (!x.done || !y.done) note(`${what}: instance count differs`, short(path)); return n; }
    if (what === 'B') nInst++;
    if (!isDeepStrictEqual(x.value, y.value)) { n++;
      note(`${what}: instance differs`, `${short(path)} #${x.value.id}`); }
  }
}

for (const path of corpusFiles(process.argv[2])) {
  files++;
  const a = parseStep(fs.readFileSync(path));
  inBytes += a.bytes.length;

  let t = performance.now();
  const json = writeJson(fileDocument(a, () => skipped++));
  tWrite += performance.now() - t;
  jsonBytes += json.length;
  try {
    JSON.parse(decoder.decode(json));
  } catch (e) {
    note(`not standard JSON: ${(e as Error).message}`, short(path));
  }

  t = performance.now();
  const b = readJson(json);
  tRead += performance.now() - t;
  if (!isDeepStrictEqual(b.header, a.header)) note('B: header differs', short(path));
  if (!isDeepStrictEqual(b.data.map((d) => [d.name, d.schemas, d.instances.length]),
    a.dataSections.map((d) => [d.name, d.schemas, d.last - d.first]))) {
    // Instance counts differ by the malformed instances skipped, which the counts below report.
    if (!isDeepStrictEqual(b.data.map((d) => [d.name, d.schemas]),
      a.dataSections.map((d) => [d.name, d.schemas]))) note('B: DATA sections differ', short(path));
  }
  diffB += compare(a, b.data.flatMap((d) => d.instances), 'B', path);
  if (!isDeepStrictEqual(writeJson(b), json)) note('B: second JSON write not byte-identical', short(path));
  if (!isDeepStrictEqual(readJsonLines(writeJsonLines(fileDocument(a, () => {}))), b)) note(
    'NDJSON: loads to something other than B', short(path));

  const c = parseStep(writeStep(b));
  for (const d of c.diagnostics) if (d.severity !== 'info') note(`C: ${d.message}`, short(path));
  if (!isDeepStrictEqual(c.header, a.header)) note('C: header differs', short(path));
  if (!isDeepStrictEqual(c.dataSections.map((d) => [d.name, d.schemas]),
    a.dataSections.map((d) => [d.name, d.schemas]))) note('C: DATA sections differ', short(path));
  diffC += compare(a, decoded(c), 'C', path);
}
const mb = (b: number) => (b / 1e6).toFixed(0);
console.log(`${files} files, ${nInst} instances, ${mb(inBytes)} MB of Part 21, ${mb(jsonBytes)} MB of raw JSON; `
  + `${skipped} malformed instances skipped; A != B: ${diffB} instances, A != C: ${diffC} instances`);
console.log(`decode+write JSON ${(tWrite / 1000).toFixed(1)} s (${(jsonBytes / 1e6 / (tWrite / 1000)).toFixed(0)} MB/s `
  + `of JSON); read JSON ${(tRead / 1000).toFixed(1)} s (${(jsonBytes / 1e6 / (tRead / 1000)).toFixed(0)} MB/s)`);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k,
  ' e.g.', v.ex);
