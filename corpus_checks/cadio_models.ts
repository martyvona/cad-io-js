// The faces our own tessellator (tess-cadio) fails on the user's models (test_corpus/models.txt: files from modern CAD
// systems, every AP), and whether the user sees a hole there: each file imported, its parts healed (cad-heal's
// default fixes, in the pool's workers, as stepconv's --heal), then meshed by tessellateScene at the medium profile
// through the fallback chain the user gets: ours, then SMLib, then OCCT (cad-scene's FallbackTessellator, per face,
// with its join, fill and orient). Every face of every B-rep part is counted:
//   - ours alone: the faces ours's own result (as the chain got it, before any fallback) gives no triangles, each with
//     its cause (our "faces failed to mesh, by cause" diagnostic; a part ours failed whole: its error) in a class:
//     beyond repair (cadio_causes.ts), boundary crossing, turned (how many triangles), past deflection (how far),
//     capped, topology or sampling (the rest);
//   - after the fallback: those of them still without triangles in the mesh tessellateScene keeps (a hole the user
//     sees), and any face meshed by ours that the chain's mesh lacks (none expected);
//   - kept with defects, apart from failed: the faces ours meshes and keeps with a small defect (tess-cadio's
//     keepDefects: turned, past its deflection, at its point cap), by defect;
//   - totals per file, per class and per surface kind (the primitives apart from the rest), and every failed or kept
//     face listed (file, part, face, surface kind, class, cause or defect, whether the fallback meshes it).
// Usage: node --max-old-space-size=12000 corpus_checks/cadio_models.ts [list, default test_corpus/models.txt]
//   WORKERS=<n> workers per backend (default 4); CPU_MS=<ms> ours's limit per part in CPU time (default 600000)
//   PLANT=hole  each file's first part's first face ours meshes emptied in ours's result and in the chain's mesh: it
//               must be counted failed by ours ("not in our diagnostics") and as a hole after the fallback
//   PLANT=kept  each file's first part's first face ours meshes said kept with 3 triangles turned in ours's result: it
//               must be counted kept (turned), not failed, and not a hole
// (progress on standard error)
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Mesh, TessellationProgress, TessellationRequest, TessellationResult, Tessellator } from
  '../packages/cad-scene/src/index.ts';
import { FallbackTessellator, MESH_PROFILES, tessellateScene } from '../packages/cad-scene/src/index.ts';
import { decode } from '../packages/cad-brep/src/index.ts';
import { poolHealer } from '../packages/cad-heal/src/index.ts';
import { healImported, importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { beyondRepair, failedCauses, KEPT_HEAD, keptDefects } from './cadio_causes.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { hostLine } from '../scripts/host.ts';

const WORKERS = Number(process.env.WORKERS ?? 4);
const CPU_MS = Number(process.env.CPU_MS ?? 600000);
const PLANT = process.env.PLANT ?? '';
const PROFILE = MESH_PROFILES.medium;

/** A tessellator in front of another keeping each result (or error) it gave, by the request's payload's buffer. */
class Recorder implements Tessellator {
  readonly results = new Map<ArrayBufferLike, TessellationResult | Error>();
  readonly inner: Tessellator;
  constructor(inner: Tessellator) { this.inner = inner; }
  get info() { return this.inner.info; }
  get timeoutMs() { return this.inner.timeoutMs; }
  init(opts?: Record<string, unknown>) { return this.inner.init(opts); }
  async tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void) {
    try {
      let r = await this.inner.tessellate(req, onProgress);
      if (PLANT && this.results.size === 0) r = emptied(r);
      this.results.set(req.data.buffer, r);
      return r;
    } catch (e) {
      this.results.set(req.data.buffer, e as Error);
      throw e;
    }
  }
  dispose() { this.inner.dispose(); }
}

/** PLANT: the result with its first meshed face's triangles dropped (hole) or said kept, turned (kept); a copy. */
const planted = new Set<number>();
function emptied(r: TessellationResult): TessellationResult {
  const f = r.faces.find((x) => x.count > 0 && x.entityId !== null);
  if (!f) return r;
  planted.add(f.entityId!);
  if (PLANT === 'kept') {
    return { ...r, diagnostics: [...r.diagnostics.filter((x) => !x.message.startsWith(KEPT_HEAD)),
      { severity: 'warning', message: `${KEPT_HEAD}1 (#${f.entityId} (3 triangles turned))` }] };
  }
  return { ...r, faces: r.faces.map((x) => (x.entityId === f.entityId ? { ...x, count: 0 } : x)) };
}

/** A cause's class (a9's): beyond repair, boundary crossing, turned, past deflection, capped, topology or sampling. */
function classOf(cause: string): { cls: string; detail: string } {
  if (beyondRepair(cause)) return { cls: 'beyond repair', detail: '' };
  if (/boundary in \(u, v\) (crossing itself|through its own point)/.test(cause)) {
    return { cls: 'boundary crossing', detail: '' };
  }
  const t = /with (\d+) triangles? turned against/.exec(cause);
  if (t) return { cls: 'turned', detail: `${t[1]} ${t[1] === '1' ? 'triangle' : 'triangles'}` };
  const p = /past its deflection: at least ([\d.]+) x/.exec(cause);
  if (p) return { cls: 'past deflection', detail: `${p[1]} x d` };
  if (/point cap/.test(cause)) return { cls: 'capped', detail: '' };
  return { cls: 'topology or sampling', detail: '' };
}

/** A kept face's defect as said ("2 triangles turned, 1.3 x the larger of d and tol, at its point cap"), classed. */
function keptClass(what: string): string {
  return [/triangles? turned/.test(what) ? 'turned' : '', / x the larger of d and tol/.test(what) ? 'past deflection'
    : '', /point cap/.test(what) ? 'capped' : ''].filter(Boolean).join(' + ') || 'other';
}

const CLASSES = ['beyond repair', 'boundary crossing', 'turned', 'past deflection', 'capped', 'topology or sampling'];
const PRIMITIVES = new Set(['plane', 'cylinder', 'cone', 'sphere', 'torus']);
type Counts = { faces: number; ours: Map<string, number>; after: Map<string, number>; kept: Map<string, number> };
const counts = (): Counts => ({ faces: 0, ours: new Map(), after: new Map(), kept: new Map() });
/** Per surface kind: faces, failed by ours alone, holes after the fallback, kept with defects. */
const byKind = new Map<string, { faces: number; failed: number; holes: number; kept: number }>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

console.log(await hostLine());
console.log(`profile medium (linear ${PROFILE.linearDeflection} mm, angular ${PROFILE.angularDeflection}), healed, `
  + `chain ours -> SMLib -> OCCT; WORKERS=${WORKERS} CPU_MS=${CPU_MS}${PLANT ? ` PLANT=${PLANT}` : ''}`);
const pool = (pkg: string, cls: string, cpu?: number) => new WorkerTessellator({
  backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls }, workers: WORKERS,
  timeoutMs: 4 * 3600e3, ...(cpu ? { cpuTimeoutMs: cpu } : {}) });
const cadioPool = pool('tess-cadio', 'CadioTessellator', CPU_MS);
const ours = new Recorder(cadioPool);
const chain = new FallbackTessellator(ours, new FallbackTessellator(pool('tess-smlib', 'SmlibTessellator'),
  pool('tess-occt', 'OcctTessellator')));
await chain.init();

const total = counts(), perFile = new Map<string, Counts>();
const listed: string[] = [], keptListed: string[] = [];
let plantMissed = 0;
for (const f of corpusFiles(process.argv[2] ?? 'test_corpus/models.txt')) {
  const name = shortName(f);
  const t0 = performance.now();
  process.stderr.write(`${name}: importing\n`);
  let bytes = new Uint8Array(fs.readFileSync(f));
  if (/\.stpZ$/i.test(f)) bytes = new Uint8Array(zlib.gunzipSync(bytes));
  const { scene } = await importStep(bytes, { heal: { heal: false } });
  await healImported(scene, { heal: { heal: true, concurrency: WORKERS,
    healer: poolHealer(cadioPool, import.meta.resolve('../packages/cad-heal/src/index.ts')) } });
  process.stderr.write(`${name}: healed, meshing ${scene.parts.filter((p) => p.brep).length} parts\n`);
  ours.results.clear();
  planted.clear();
  const res = await tessellateScene(scene, chain, { profile: 'medium', concurrency: WORKERS,
    onPart: (_i, _m, done, n) => {
      if (done % 50 === 0 || done === n) process.stderr.write(`  ${name}: ${done}/${n}\n`);
    } });
  const C = counts();
  perFile.set(name, C);
  for (let i = 0; i < scene.parts.length; i++) {
    const p = scene.parts[i]!;
    if (!p.brep) continue;
    const d = p.brep.model;
    const r = ours.results.get(d.buffer);
    const mesh: Mesh | undefined = res.meshes.get(i);
    if (PLANT === 'hole' && mesh && planted.size) {
      for (const fc of mesh.faces) if (fc.source !== null && planted.has(fc.source)) fc.count = 0;
    }
    const kept = new Set(mesh ? mesh.faces.filter((x) => x.count > 0).map((x) => x.source) : []);
    const oursMeshed = new Set(r && !(r instanceof Error) ? r.faces.filter((x) => x.count > 0).map((x) => x.entityId)
      : []);
    const causes = r && !(r instanceof Error) ? failedCauses(r) : new Map<number, string>();
    const keptBy = r && !(r instanceof Error) ? keptDefects(r) : new Map<number, string>();
    const whole = !r ? 'not meshed by ours (no request)'
      : r instanceof Error ? `part failed: ${r.message.split('\n')[0]}`
      : !r.indices.length ? 'part failed: no triangles' : undefined;
    for (let row = 0; row < d.face.surface.length; row++) {
      const id = d.face.id[row]!;
      C.faces++;
      const hole = !kept.has(id);
      const kind = (decode.surface(d, decode.face(d, row).surface) as { kind: string }).kind;
      let K = byKind.get(kind);
      if (!K) byKind.set(kind, K = { faces: 0, failed: 0, holes: 0, kept: 0 });
      K.faces++;
      if (oursMeshed.has(id) && keptBy.has(id)) {
        const what = keptBy.get(id)!;
        bump(C.kept, keptClass(what));
        if (PLANT === 'kept' && planted.has(id) && (what !== '3 triangles turned' || hole)) plantMissed++;
        K.kept++;
        keptListed.push(`${name}\t#${p.sources[0]!.id}\t#${id}\t${kind}\t${keptClass(what)}: ${what}`
          + `${hole ? '\tHOLE (missing after the chain)' : ''}`);
      }
      if (oursMeshed.has(id)) {
        if (PLANT === 'kept' && planted.has(id) && !keptBy.has(id)) plantMissed++;
        if (hole) {
          bump(C.ours, 'meshed by ours, missing after'), bump(C.after, 'meshed by ours, missing after');
          listed.push(`${name}\t#${p.sources[0]!.id}\t#${id}\t-\tmeshed by ours, missing after the chain\t-\thole`);
        }
        continue;
      }
      const cause = whole ?? causes.get(id) ?? 'not in our diagnostics';
      const { cls, detail } = whole ? { cls: 'topology or sampling', detail: 'whole part' } : classOf(cause);
      bump(C.ours, cls);
      K.failed++;
      if (hole) bump(C.after, cls), K.holes++;
      if (PLANT === 'hole' && planted.has(id) && !(cause === 'not in our diagnostics' && hole)) plantMissed++;
      listed.push(`${name}\t#${p.sources[0]!.id}\t#${id}\t${kind}\t${cls}${detail ? ` (${detail})` : ''}: `
        + `${cause.slice(0, 200)}\t${hole ? 'HOLE' : 'fallback meshes it'}`);
    }
  }
  for (const [k, v] of C.ours) total.ours.set(k, (total.ours.get(k) ?? 0) + v);
  for (const [k, v] of C.after) total.after.set(k, (total.after.get(k) ?? 0) + v);
  for (const [k, v] of C.kept) total.kept.set(k, (total.kept.get(k) ?? 0) + v);
  total.faces += C.faces;
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  process.stderr.write(`${name}: ${C.faces} faces, ours failed ${sum(C.ours)}, holes ${sum(C.after)}, `
    + `kept with defects ${sum(C.kept)}, `
    + `${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
}
chain.dispose();

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const byClass = (m: Map<string, number>) => [...CLASSES, 'meshed by ours, missing after'].filter((k) => m.get(k))
  .map((k) => `${k} ${m.get(k)}`).join(', ') || 'none';
const byDefect = (m: Map<string, number>) => [...m].sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
console.log('\nper file: faces; failed by ours alone (by class); holes after the fallback (by class); kept with '
  + 'defects by ours, meshed (by defect)');
for (const [name, C] of perFile) {
  console.log(`  ${name}: ${C.faces} faces; ours ${sum(C.ours)} (${byClass(C.ours)}); after ${sum(C.after)}`
    + ` (${byClass(C.after)}); kept ${sum(C.kept)} (${byDefect(C.kept)})`);
}
console.log(`\ntotal: ${total.faces} faces; ours alone failed ${sum(total.ours)}; holes after the fallback `
  + `${sum(total.after)}`);
console.log(`  ours alone by class: ${byClass(total.ours)}`);
console.log(`  after the fallback by class: ${byClass(total.after)}`);
console.log(`  kept with defects by ours (meshed, not failed): ${sum(total.kept)}; by defect: `
  + `${byDefect(total.kept)}`);
console.log('\nper surface kind: faces, failed by ours alone, holes after the fallback, kept with defects');
for (const prim of [true, false]) {
  const ks = [...byKind].filter(([k]) => PRIMITIVES.has(k) === prim).sort((a, b) => b[1].faces - a[1].faces);
  const all = ks.reduce((a, [, x]) => ({ faces: a.faces + x.faces, failed: a.failed + x.failed,
    holes: a.holes + x.holes, kept: a.kept + x.kept }), { faces: 0, failed: 0, holes: 0, kept: 0 });
  const line = (k: string, x: typeof all) => `    ${k}: ${x.faces} faces, failed ${x.failed}, holes ${x.holes}, `
    + `kept ${x.kept}`;
  console.log(line(prim ? 'primitives (plane, cylinder, cone, sphere, torus)' : 'the rest (free-form, swept, '
    + 'offset)', all).slice(2));
  for (const [k, x] of ks) console.log(line(k, x));
}
console.log('\nevery face ours fails: file, part, face, surface, class: cause, after the fallback');
for (const l of listed) console.log(`  ${l}`);
console.log('\nevery face ours keeps with a defect: file, part, face, surface, defect: as said');
for (const l of keptListed) console.log(`  ${l}`);
if (PLANT) {
  console.log(`\nPLANT=${PLANT}: ${plantMissed} planted faces miscounted`);
  if (plantMissed) process.exitCode = 1;
}
