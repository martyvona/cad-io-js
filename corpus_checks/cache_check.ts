// Phase 3 step 4: the tessellation cache over phase 0's subsets (test_corpus/subsets/out and out_bike, made by
// make_subsets.ts; each the model of its part as step-import reads its source file), with each backend,
// single-threaded, at 0.05 file units (0.5 rad) with edges: every result through a file store (written, then read by a
// new store) and the memory store must equal the backend's own; and the time of the backend alone, of a first run
// through the file store (key, encoding, write), and of a second (key, read, decoding). Failed parts' results
// (failedPart) are cached too, and read back with a note saying so, which the comparison ignores. Skips trj2_as1-id-203
// #891, which hangs truck (phase 0), except at the end: truck in a one-worker pool with a 10 s timeout, first through
// the file store (the timeout, cached) and then again (answered from the store). Times are only meaningful with the CPU
// otherwise idle and not in low power mode. Usage: node corpus_checks/cache_check.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failedPart, type Scene, TessellationError, type TessellationRequest, type TessellationResult,
  type Tessellator } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { CachedTessellator, FileStore, MemoryStore } from '../packages/tess-cache/src/node.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { TruckTessellator } from '../packages/tess-truck/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, repoDir } from './corpus.ts';
import { hostLine } from '../scripts/host.ts';

console.log(await hostLine());

const SKIP = /trj2_as1-id-203\.stp\.absr\.891\./;
/**
 * A subset's part as a model request: the part of its source file (the corpus file its name starts with) whose
 * representation is the one its name gives (a bare subset has no product, so isn't a part itself); undefined where
 * that representation isn't a part of its file's scene (one of several of a product's, say).
 */
const sources = new Map(corpusFiles().map((f) => [path.basename(f), f]));
const scenes = new Map<string, Promise<Scene>>();
async function request(file: string): Promise<TessellationRequest | undefined> {
  const [, source, rootText] = /^(.*)\.absr\.(\d+)\.stp$/.exec(path.basename(file))!;
  const root = Number(rootText), from = sources.get(source!);
  assert.ok(from, `${file}: no corpus file ${source}`);
  if (!scenes.has(from)) scenes.set(from, importStep(new Uint8Array(fs.readFileSync(from))).then((r) => r.scene));
  const p = (await scenes.get(from)!).parts.find((q) => q.brep && q.sources[0]?.id === root);
  if (!p?.brep) return undefined;
  return { format: 'cad-brep', data: new Uint8Array(p.brep.model.buffer), linearDeflection: 0.05,
    angularDeflection: 0.5, edges: true };
}
const files = ['out', 'out_bike'].flatMap((d) => {
  const dir = path.join(repoDir, 'test_corpus/subsets', d);
  return fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f)).sort().map((f) => path.join(dir, f));
});
const all = await Promise.all(files.filter((f) => !SKIP.test(f)).map(request));
const reqs = all.filter((r) => r !== undefined);
const hang = (await request(files.find((f) => SKIP.test(f))!))!;
/** A result read back from the cache, without the note a cached failure carries. */
const unnoted = (r: TessellationResult): TessellationResult => (
  { ...r, diagnostics: r.diagnostics.filter((d) => !/^a cached failure from /.test(d.message)) });
const payload = reqs.reduce((n, r) => n + r.data.length, 0);

async function run(t: Tessellator): Promise<{ ms: number; results: TessellationResult[] }> {
  const results: TessellationResult[] = [];
  const t0 = performance.now();
  for (const r of reqs) results.push(await t.tessellate(r));
  return { ms: performance.now() - t0, results };
}

console.log(`${reqs.length} parts, ${(payload / 2 ** 20).toFixed(1)} MB of payload (${all.length - reqs.length} `
  + 'subsets left out: their representations are no part of their files\' scenes)');
for (const C of [TruckTessellator, OcctTessellator]) {
  const backend: Tessellator = new C();
  await backend.init();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-check-'));
  try {
    const direct = await run(backend);
    const first = new CachedTessellator(backend, new FileStore({ dir }));
    const miss = await run(first);
    const store = new FileStore({ dir });
    const second = new CachedTessellator(backend, store);
    const hit = await run(second);
    const mem = new CachedTessellator(backend, new MemoryStore());
    await run(mem);
    const memHit = await run(mem);
    const errors = direct.results.filter(failedPart).length;
    for (const [i, r] of direct.results.entries()) {
      assert.deepEqual(miss.results[i], r, `part ${i}`);
      assert.deepEqual(unnoted(hit.results[i]!), r, `part ${i}`);
      assert.deepEqual(unnoted(memHit.results[i]!), r, `part ${i}`);
      assert.equal(hit.results[i]!.diagnostics.length - r.diagnostics.length,
        failedPart(r) ? 1 : 0);
    }
    const s = second.stats();
    assert.deepEqual(s, { hits: reqs.length, failureHits: errors, misses: 0, errors: 0 });
    console.log(`${backend.info.version}: results equal; ${errors} failed parts (cached too); `
      + `${((await store.size()) / 2 ** 20).toFixed(1)} MB stored`);
    console.log(`  backend ${(direct.ms / 1000).toFixed(2)} s; file store, first run ${(miss.ms / 1000).toFixed(2)} s, `
      + `second ${(hit.ms / 1000).toFixed(2)} s (${s.hits} hits); memory store, second `
      + `${(memHit.ms / 1000).toFixed(2)} s`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    backend.dispose();
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-check-'));
  const pool = new WorkerTessellator(
    { backend: { module: new URL('../packages/tess-truck/src/index.ts', import.meta.url).href,
    export: 'TruckTessellator' }, workers: 1, timeoutMs: 10_000 });
  try {
    const timed = async (t: Tessellator) => {
      const t0 = performance.now();
      const e = await t.tessellate(hang).then(() => undefined, (err: unknown) => err);
      assert.ok(e instanceof TessellationError && e.timeoutMs === 10_000, String(e));
      return { ms: performance.now() - t0, message: e.message };
    };
    await pool.init();
    const first = await timed(new CachedTessellator(pool, new FileStore({ dir })));
    const second = await timed(new CachedTessellator(pool, new FileStore({ dir })));
    assert.match(second.message, /a cached failure from/);
    console.log(`truck in a pool, trj2_as1-id-203 #891 (hangs): first run ${(first.ms / 1000).toFixed(2)} s `
      + `(${first.message}), second ${(second.ms / 1000).toFixed(3)} s, from the store`);
  } finally {
    pool.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
