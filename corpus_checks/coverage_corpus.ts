// Coverage: every face of every B-rep part through our own tessellator (tess-cadio), with OCCT (its native route) and
// SMLib run beside it as references, each in a tess-workers pool at the medium profile. Nothing is skipped for a
// reference failing: the parts and faces where OCCT or SMLib fail are where ours must succeed without one.
//   - each backend's status per part: ok, partial (some faces without triangles), no triangles, error (thrown),
//     timeout, crash;
//   - every face of every model accounted for once: meshed by ours, or failed by ours with its cause (our part's
//     status, else our "faces failed to mesh, by cause" diagnostic, else "not in our diagnostics") and its surface
//     kind; crossed with whether OCCT and SMLib give it triangles (the matrix);
//   - each of our failures in a class: "unclassified" for every one until what counts as beyond repair is decided;
//   - every part and face ours doesn't mesh listed in full at the end, per list (the coverage's record).
// The references are the raw backends, as smlib_occt.ts runs them: no fallback, join or fill.
// Usage: node corpus_checks/coverage_corpus.ts [list[,list...]] [max MB, default 1000]   (progress on standard error)
//   lists: comma-separated, each judged and reported apart, then together (default test_corpus/files.txt and
//          test_corpus/models.txt, the user's models)
//   WORKERS=<n> workers per backend in each process (default: a third of the process's share, runner.ts)
//   PLANT=<bug>  a bug planted in about one part in 10 before it's judged, to prove the check sees it (each planted
//                case is checked for the verdict it must get, the missed ones listed): fail (our first meshed face
//                emptied: must be ours failed, "not in our diagnostics"), part (our result replaced by a crash: every
//                face ours failed, "part crash"), occt and smlib (that reference's first meshed face emptied: must be
//                counted as failed by it), cause (our first meshed face emptied and named in a by-cause
//                diagnostic of two entries: must be ours failed with the planted cause)
//   TIMEOUT_MS=<ms> each request's limit (default 120000, the pool's)
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { MESH_PROFILES } from '../packages/cad-scene/src/index.ts';
import { type BrepData, decode } from '../packages/cad-brep/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { CAUSES_HEAD, failedCauses } from './cadio_causes.ts';
import { corpusFiles, plantedPart, repoDir, shortName } from './corpus.ts';
import { addInto, division, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const EXAMPLES = 4;
const { linearDeflection: LIN, angularDeflection: ANG } = MESH_PROFILES.medium;
const PLANT = process.env.PLANT ?? '';
const PLANTS = ['fail', 'part', 'occt', 'smlib', 'cause'];
/** Each request's limit (ms; the pool's default); ours over half of it on a part it meshes is listed as near it. */
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PLANT=${PLANT}: one of ${PLANTS.join(', ')}`);
const DEFAULT_LISTS = ['test_corpus/files.txt', 'test_corpus/models.txt'];
/** What our failures are, until the user decides what counts as beyond repair. */
const UNCLASSIFIED = 'unclassified';

const BACKENDS = ['cadio', 'occt', 'smlib'] as const;
type Backend = typeof BACKENDS[number];
const LABEL: Record<Backend, string> = { cadio: 'ours', occt: 'OCCT', smlib: 'SMLib' };
type PartStatus = 'ok' | 'partial' | 'no triangles' | 'error' | 'timeout' | 'crash' | 'no faces';
const STATUSES: PartStatus[] = ['ok', 'partial', 'no triangles', 'error', 'timeout', 'crash', 'no faces'];
/** A part's statuses that are no failure: every face meshed, or no face to mesh (a part of curves or points). */
const fine = (s: PartStatus) => s === 'ok' || s === 'no faces';

let maxBytes = 1000e6;
let pools: Record<Backend, WorkerTessellator>;

/** A thrown error's status: the pool's timeout, a worker that died, or anything else. */
const thrown = (m: string): PartStatus => /timed out/.test(m) ? 'timeout'
  : /exit|crash|terminated|memory|unreachable|RuntimeError/.test(m) ? 'crash' : 'error';
/** A message with its numbers and ids made generic, for tallies. */
const generic = (m: string) => m.replace(/#\d+/g, '#N').replace(/\d+(\.\d+)?/g, 'N').slice(0, 160);

/** The face ids a result gives triangles. */
function meshedIds(r: TessellationResult): Set<number> {
  const s = new Set<number>();
  for (const f of r.faces) if (f.entityId !== null && f.count > 0) s.add(f.entityId);
  return s;
}

/** A backend's outcome for one part: its status, the faces it meshed, and why a whole part failed. */
interface Outcome { status: PartStatus; meshed: Set<number>; why: string; result?: TessellationResult }

function outcome(r: TessellationResult | Error, faceIds: readonly number[]): Outcome {
  // (A part with no faces that throws is still a failure, in the statuses; it has no face to account for.)
  if (!faceIds.length && !(r instanceof Error)) return { status: 'no faces', meshed: new Set(), why: '', result: r };
  if (r instanceof Error) {
    return { status: thrown(r.message), meshed: new Set(), why: r.message.split('\n')[0]!.slice(0, 200) };
  }
  const meshed = meshedIds(r);
  if (!r.indices.length || meshed.size === 0) {
    const errs = r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
    return { status: 'no triangles', meshed, why: (errs.join('; ') || 'no error said').slice(0, 300), result: r };
  }
  const all = faceIds.every((id) => meshed.has(id));
  return { status: all ? 'ok' : 'partial', meshed, why: '', result: r };
}

/** Whether OCCT and SMLib give a face triangles: the matrix's columns. */
function references(occt: boolean, smlib: boolean): string {
  return occt && smlib ? 'both mesh' : occt ? 'SMLib fails' : smlib ? 'OCCT fails' : 'both fail';
}
const COLUMNS = ['both mesh', 'OCCT fails', 'SMLib fails', 'both fail'];

/** Whether a planted reference failure (`expect` "OCCT fails" or "SMLib fails") shows on its face. */
const refFailed = (expect: string, occtOk: boolean, smlibOk: boolean) =>
  (expect === 'OCCT fails' && !occtOk) || (expect === 'SMLib fails' && !smlibOk);

/** PLANT's bug on one part, in place on copies; returns what the planted case must be judged as. */
function plant(o: Record<Backend, TessellationResult | Error>): { expect: string; face?: number } | undefined {
  const emptyFirst = (b: Backend) => {
    const r = o[b];
    if (r instanceof Error) return undefined;
    const faces = r.faces.map((f) => ({ ...f }));
    const f = faces.find((y) => y.entityId !== null && y.count > 0);
    if (!f) return undefined;
    // (Every range of that face emptied: a face may have several.)
    for (const y of faces) if (y.entityId === f.entityId) y.count = 0;
    o[b] = { ...r, faces };
    return f.entityId!;
  };
  if (PLANT === 'fail') {
    const id = emptyFirst('cadio');
    return id === undefined ? undefined : { expect: 'not in our diagnostics', face: id };
  }
  if (PLANT === 'occt' || PLANT === 'smlib') {
    const id = emptyFirst(PLANT);
    return id === undefined ? undefined : { expect: `${LABEL[PLANT]} fails`, face: id };
  }
  if (PLANT === 'part') {
    o.cadio = new Error('planted: worker exited with code 1');
    return { expect: 'part crash' };
  }
  if (PLANT === 'cause') {
    const id = emptyFirst('cadio');
    if (id === undefined) return undefined;
    const r = o.cadio as TessellationResult;
    // (Two entries, the planted one second, as tess-cadio joins them, with a cause holding a colon and digits.)
    o.cadio = { ...r, diagnostics: [...r.diagnostics, { severity: 'info', message: `${CAUSES_HEAD}unknown: other 2 `
      + `(#999999999, #999999998); planted: cause 3 1 (#${id})` }] };
    return { expect: 'planted: cause 3', face: id };
  }
  return undefined;
}

const statuses = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PartStatus, number>;
const fresh = () => ({
  files: 0, skippedBig: 0, failedFiles: 0, parts: 0, faces: 0,
  status: { cadio: statuses(), occt: statuses(), smlib: statuses() },
  // Faces each backend gives no triangles (whole parts' failures included).
  facesFailed: { cadio: 0, occt: 0, smlib: 0 },
  // Key: our verdict ("ours meshes" or our cause), a tab, the references' column.
  matrix: new Map<string, number>(),
  // Our failed faces by class (every one unclassified for now) and by cause with its surface kind.
  classes: new Map<string, number>(),
  causes: new Map<string, number>(),
  // Faces in our result that the model doesn't have (ids), and per-part accounting that didn't add up.
  foreign: 0,
  mismatches: [] as string[],
  // Ours meshes where both references fail: what this tessellator exists for.
  oursAlone: 0,
  warnings: new Map<string, number>(),
  tally: new Map<string, { n: number; ex: string[] }>(),
  planted: { cases: 0, seen: 0, missed: [] as string[] },
  unmeshedParts: [] as string[],
  unmeshed: [] as string[],
  // Parts ours meshes in over half the limit (from its first progress): a loaded host can make them timeouts.
  nearLimit: [] as string[],
});
type Tallies = ReturnType<typeof fresh>;
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/** A file's bytes, gunzipped where it's gzip (.stpZ). */
function readStep(f: string): Uint8Array {
  const b = fs.readFileSync(f);
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
}

export const check: FileCheck<string, Tallies> = {
  async setup({ meshWorkers }) {
    const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
    const pool = (pkg: string, cls: string) => new WorkerTessellator({
      backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls }, workers,
      timeoutMs: TIMEOUT_MS });
    pools = { cadio: pool('tess-cadio', 'CadioTessellator'), occt: pool('tess-occt', 'OcctTessellator'),
      smlib: pool('tess-smlib', 'SmlibTessellator') };
    await Promise.all(BACKENDS.map((b) => pools[b].init()));
  },
  async teardown() {
    await Promise.all(BACKENDS.map((b) => pools[b].dispose()));
  },
  async file(f, list) {
    void list;
    const T = fresh();
    const note = (k: string, ex: string) => {
      const t = T.tally.get(k) ?? { n: 0, ex: [] };
      t.n++;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      T.tally.set(k, t);
    };
    if (fs.statSync(f).size > maxBytes) { T.skippedBig++; return T; }
    T.files++;
    const name = shortName(f);
    const { scene } = await importStep(readStep(f));
    const parts = scene.parts.filter((p) => p.brep);
    const results = await Promise.all(parts.map(async (p) => {
      const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
        origin: p.origin, linearDeflection: LIN, angularDeflection: ANG, edges: true };
      // (Ours timed from its first progress, near when the pool's timer starts: the request's wall time includes its
      // wait in the queue behind the file's other parts.)
      let ms = 0, started = NaN;
      const rs = await Promise.all(BACKENDS.map(async (b) => {
        const first = () => { if (isNaN(started)) started = performance.now(); };
        const x = await pools[b].tessellate(req, b === 'cadio' ? first : undefined).catch((e: Error) => e);
        if (b === 'cadio') ms = performance.now() - started;
        return x;
      }));
      return { p, ms, r: Object.fromEntries(BACKENDS.map((b, i) => [b, rs[i]!])) as
        Record<Backend, TessellationResult | Error> };
    }));
    for (const { p, ms, r } of results) {
      T.parts++;
      const where = `${name} #${p.sources[0]!.id}`;
      const d: BrepData = p.brep!.model;
      const rows = d.face.surface.length;
      const ids = Array.from({ length: rows }, (_, i) => d.face.id[i]!);
      const planted = PLANT && plantedPart(where) ? plant(r) : undefined;
      if (planted) T.planted.cases++;
      const o = Object.fromEntries(BACKENDS.map((b) => [b, outcome(r[b], ids)])) as Record<Backend, Outcome>;
      for (const b of BACKENDS) {
        T.status[b][o[b].status]++;
        if (!fine(o[b].status) && o[b].status !== 'partial') note(`${LABEL[b]} ${o[b].status}: ${generic(o[b].why)}`,
          where);
      }
      const ours = o.cadio;
      if (ours.result) {
        for (const x of ours.result.diagnostics) {
          if (x.severity === 'warning') bump(T.warnings, generic(x.message));
        }
      }
      const partFailed = !fine(ours.status) && ours.status !== 'partial';
      if (!partFailed && ms > TIMEOUT_MS / 2) T.nearLimit.push(`${where} (${rows} faces): ${(ms / 1000).toFixed(1)} s`);
      if (partFailed) T.unmeshedParts.push(`${where} (${rows} faces): ${ours.status}: ${ours.why}`);
      const causes = ours.result ? failedCauses(ours.result) : new Map<number, string>();
      const modelIds = new Set(ids);
      for (const id of ours.meshed) if (!modelIds.has(id)) T.foreign++;
      let meshedHere = 0, failedHere = 0, plantSeen = false;
      for (let row = 0; row < rows; row++) {
        const id = ids[row]!;
        T.faces++;
        const occtOk = o.occt.meshed.has(id), smlibOk = o.smlib.meshed.has(id);
        if (!occtOk) T.facesFailed.occt++;
        if (!smlibOk) T.facesFailed.smlib++;
        const col = references(occtOk, smlibOk);
        if (ours.meshed.has(id)) {
          meshedHere++;
          bump(T.matrix, `ours meshes\t${col}`);
          if (col === 'both fail') {
            T.oursAlone++;
            note('ours meshes where OCCT and SMLib both fail', `${where} face #${id}`);
          }
          if (planted?.face === id && refFailed(planted.expect, occtOk, smlibOk)) plantSeen = true;
          continue;
        }
        failedHere++;
        T.facesFailed.cadio++;
        const why = partFailed ? `part ${ours.status}` : causes.get(id) ?? 'not in our diagnostics';
        const kind = (decode.surface(d, d.face.surface[row]!) as { kind: string }).kind;
        bump(T.matrix, `${why}\t${col}`);
        bump(T.causes, `${why} (${kind})`);
        bump(T.classes, UNCLASSIFIED);
        if (why === 'not in our diagnostics') note('face without our triangles not in our diagnostics',
          `${where} face #${id} (${kind})`);
        T.unmeshed.push(`${where} face #${id} (${kind}): ${why}; ${col}; ${UNCLASSIFIED}`);
        if (planted && planted.expect === why && (planted.face === undefined || planted.face === id)) plantSeen = true;
        if (planted?.face === id && refFailed(planted.expect, occtOk, smlibOk)) plantSeen = true;
      }
      if (meshedHere + failedHere !== rows || meshedHere !== ids.filter((id) => ours.meshed.has(id)).length) {
        T.mismatches.push(`${where}: ${rows} faces, ${meshedHere} meshed + ${failedHere} failed`);
      }
      if (planted) {
        if (plantSeen) T.planted.seen++;
        else T.planted.missed.push(`${where}${planted.face !== undefined ? ` face #${planted.face}` : ''}: `
          + `expected "${planted.expect}"`);
      }
    }
    return T;
  },
};

/** Lists named on the command line (comma-separated), else the defaults; paths relative to the repository. */
function lists(arg: string | undefined): string[] {
  return (arg ? arg.split(',') : DEFAULT_LISTS).map((l) => path.resolve(repoDir, l));
}

function report(label: string, T: Tallies): void {
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(2) : '0'}%)`;
  console.log(`## ${label}${PLANT ? `, PLANT=${PLANT}` : ''}`);
  console.log(`${T.files} files (${T.skippedBig} over ${maxBytes / 1e6} MB skipped, ${T.failedFiles} failed), `
    + `${T.parts} B-rep parts, ${T.faces} faces`);
  for (const b of BACKENDS) {
    console.log(`  ${LABEL[b]} parts: ${STATUSES.map((s) => `${s} ${T.status[b][s]}`).join(', ')}; faces without `
      + `triangles ${pct(T.facesFailed[b], T.faces)}`);
  }
  console.log(`  ours meshes ${T.faces - T.facesFailed.cadio} faces, ${T.oursAlone} of them where OCCT and SMLib both`
    + ` fail; faces in our results the models don't have: ${T.foreign}`);
  const classes = [...T.classes].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  console.log(`  our failures by class: ${classes} (what's beyond repair not yet decided)`);
  console.log('  the matrix, faces (rows ours, columns OCCT and SMLib):');
  const rowsOf = [...new Set([...T.matrix.keys()].map((k) => k.split('\t')[0]!))]
    .sort((a, b) => (a === 'ours meshes' ? -1 : b === 'ours meshes' ? 1 : a < b ? -1 : 1));
  console.log(`    ${''.padEnd(48)}${COLUMNS.map((c) => c.padStart(12)).join('')}${'all'.padStart(10)}`);
  for (const row of rowsOf) {
    const cells = COLUMNS.map((c) => T.matrix.get(`${row}\t${c}`) ?? 0);
    console.log(`    ${row.slice(0, 47).padEnd(48)}${cells.map((n) => String(n).padStart(12)).join('')}`
      + `${String(cells.reduce((a, n) => a + n, 0)).padStart(10)}`);
  }
  const sum = [...T.matrix.values()].reduce((a, n) => a + n, 0);
  console.log(`  every face accounted for: ${sum === T.faces && !T.mismatches.length ? 'yes' : 'NO'} (${sum} in the `
    + `matrix of ${T.faces}${T.mismatches.length ? `; ${T.mismatches.length} parts don't add up` : ''})`);
  console.log(`  our failures by cause and surface: ${[...T.causes].sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`  our warnings: ${[...T.warnings].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} x "${k}"`)
    .join('; ') || 'none'}`);
  if (PLANT) {
    console.log(`  planted: ${T.planted.cases} cases, ${T.planted.seen} seen as expected, ${T.planted.missed.length} `
      + 'missed');
    for (const x of T.planted.missed) console.log(`    missed: ${x}`);
  }
  for (const x of T.mismatches) console.log(`  doesn't add up: ${x}`);
  console.log();
  for (const [k, t] of [...T.tally].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`${String(t.n).padStart(8)} ${k}  e.g. ${t.ex.join('; ')}`);
  }
  console.log(`\n### Parts ours doesn't mesh (${T.unmeshedParts.length}), each with its cause`);
  for (const x of [...T.unmeshedParts].sort()) console.log(`  ${x}`);
  console.log(`\n### Parts ours meshes in over half the ${TIMEOUT_MS / 1000} s limit (${T.nearLimit.length})`);
  for (const x of [...T.nearLimit].sort()) console.log(`  ${x}`);
  console.log(`\n### Faces without our triangles (${T.unmeshed.length}): our cause; the references; the class`);
  for (const x of [...T.unmeshed].sort()) console.log(`  ${x}`);
  console.log();
}

if (import.meta.main) {
  console.log(await hostLine());
  maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
  const ls = lists(process.argv[2]);
  const label = (l: string) => (l.startsWith(repoDir + path.sep) ? path.relative(repoDir, l) : path.basename(l));
  const files = ls.flatMap((l) => corpusFiles(l).map((f) => ({ path: f, job: label(l) })));
  const listOf = new Map(files.map((f) => [f.path, f.job]));
  const per = new Map(ls.map((l) => [label(l), fresh()]));
  const errors: string[] = [];
  const t0 = performance.now();
  // (A tally's examples are capped when merged; addInto would append them all.)
  const merge = (into: Tallies, r: Tallies) => {
    for (const [k, t] of r.tally) {
      const u = into.tally.get(k) ?? { n: 0, ex: [] };
      u.n += t.n;
      for (const e of t.ex) if (u.ex.length < EXAMPLES) u.ex.push(e);
      into.tally.set(k, u);
    }
    addInto(into, { ...r, tally: new Map() });
  };
  await runFiles(import.meta.url, check, files, process.argv.slice(2), (f, out) => {
    const into = per.get(listOf.get(f)!)!;
    if ('error' in out) {
      into.failedFiles++;
      errors.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      return;
    }
    merge(into, out.result);
  });
  const { children, meshWorkers } = division();
  const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
  console.log(`coverage: tess-cadio against OCCT (native route) and SMLib, medium profile (${LIN} mm, ${ANG} rad), `
    + `${TIMEOUT_MS / 1000} s limit; `
    + `${((performance.now() - t0) / 1000).toFixed(0)} s, ${children || 1} processes x ${workers} workers per backend`);
  console.log();
  for (const [l, T] of per) report(l, T);
  if (per.size > 1) {
    const all = fresh();
    for (const T of per.values()) merge(all, T);
    report('all lists', all);
  }
  for (const e of errors) console.log(e);
}
