// Phase 1 step 3: round-trip every corpus file through the writer: parse (A) → write → parse (C), A ≡ C.
// Also re-writes C (must be byte-identical), and checks the verbatim fast path (source bytes copied) the same way.
// Usage: node corpus_checks/writer_corpus.ts [file-list.txt]
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileDocument, parseStep, writeStep, type Instance, type StepFile } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName as short } from './corpus.ts';

const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const p = problems.get(k); if (p) p.n++;
  else problems.set(k, { n: 1, ex }); };
let files = 0, inBytes = 0, outBytes = 0, nInst = 0, tDecode = 0, tWrite = 0, skipped = 0, mismatched = 0;

function* decoded(f: StepFile): Generator<Instance> {
  yield* f.instances(() => {});
}

for (const path of corpusFiles(process.argv[2])) {
  files++;
  const a = parseStep(fs.readFileSync(path));
  inBytes += a.bytes.length;
  let t = performance.now();
  let n = 0;
  for (const _ of decoded(a)) n++;
  tDecode += performance.now() - t;
  nInst += n;

  t = performance.now();
  let out: Uint8Array;
  try {
    out = writeStep(fileDocument(a, () => skipped++));
  } catch (e) {
    note(`write error: ${(e as Error).message}`, short(path));
    continue;
  }
  tWrite += performance.now() - t;
  outBytes += out.length;
  for (let i = 0; i < out.length; i++) if (out[i]! > 0x7e || (out[i]! < 0x20 && out[i] !== 0x0a)) {
    note('non-ASCII output byte', short(path)); break; }

  const c = parseStep(out);
  for (const d of c.diagnostics) if (d.severity !== 'info') note(`rewritten file: ${d.message}`, short(path));
  if (!isDeepStrictEqual(c.header, a.header)) note('header differs', short(path));
  if (!isDeepStrictEqual(c.dataSections.map((d) => [d.name, d.schemas]),
    a.dataSections.map((d) => [d.name, d.schemas]))) note('DATA sections differ', short(path));
  const ia = decoded(a), ic = decoded(c);
  for (;;) {
    const x = ia.next(), y = ic.next();
    if (x.done || y.done) { if (!x.done || !y.done) note('instance count differs', short(path)); break; }
    if (!isDeepStrictEqual(x.value, y.value)) { mismatched++;
      note('instance differs', `${short(path)} #${x.value.id}`); }
  }
  if (!isDeepStrictEqual(writeStep(fileDocument(c)), out)) note('second write not byte-identical', short(path));

  // Fast path: every instance copied verbatim from the source.
  const fast = parseStep(writeStep(
    { header: a.header, data: [{ instances: Array.from({ length: a.count }, (_, p) => a.sourceBytesAt(p)) }] }));
  const fa = decoded(a), ff = decoded(fast);
  for (;;) {
    const x = fa.next(), y = ff.next();
    if (x.done || y.done) { if (!x.done || !y.done) note('fast path: instance count differs', short(path)); break; }
    if (!isDeepStrictEqual(x.value, y.value)) note('fast path: instance differs', `${short(path)} #${x.value.id}`);
  }
}
const mb = (b: number) => (b / 1e6).toFixed(0);
console.log(`${files} files, ${nInst} instances, ${mb(inBytes)} MB in, ${mb(outBytes)} MB written; ${skipped} `
  + `malformed instances skipped; ${mismatched} instances differ`);
console.log(`decode ${(tDecode / 1000).toFixed(1)} s; decode+write ${(tWrite / 1000).toFixed(1)} s → write alone ≈ `
  + `${(outBytes / 1e6 / ((tWrite - tDecode) / 1000)).toFixed(0)} MB/s of output`);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k,
  ' e.g.', v.ex);
