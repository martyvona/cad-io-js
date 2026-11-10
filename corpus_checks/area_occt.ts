// Our OCCT backend's face areas against the area oracle (area_oracle.ts; its method and limits: docs/backends.md), an
// area from the file alone for faces on planes, cylinders, cones, spheres and tori. Every part of every file is
// tessellated as stepconv does it (a tess-workers pool, tessellateScene with measures, the medium profile) and each of
// its faces the oracle trusts (no flags, error estimate within 1e-6) is compared:
//   - OCCT's measured area (BRepGProp on its healed faces) against the oracle's;
//   - the mesh judged by faceFailures twice: with OCCT's measures, as the library does, and with the oracle's area and
//     perimeter in their place. Faces where only the oracle finds a failure are ones the library can't see (OCCT's
//     measure wrong with its mesh); faces where only OCCT's measures do are false alarms or OCCT measuring wrong;
//   - OCCT's perimeter against the oracle's on planes, a check of the oracle as much as of OCCT (on periodic surfaces
//     OCCT adds seam edges to the face, and counts them).
// Faces under d^2 (0.01 mm^2) are left out, as faceFailures leaves them. Also prints the oracle's coverage: faces
// trusted, untrusted (flags, error) and unsupported, by reason.
// Usage: node --max-old-space-size=8192 corpus_checks/area_occt.ts [file-list.txt] [max MB, default 2]
//   (progress on standard error; the log used 1000)
//   PLANT=measure  scale OCCT's measured area of about one compared face in 50 (corpus.ts's plantedPart) by 1.05: each
//                  must be listed as off
//   PLANT=mesh     drop the second half of the triangles of about one compared face in 50, and scale OCCT's measured
//                  area to match, so faceFailures with OCCT's measures sees nothing: each must be listed as undetected
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import { meshDeflections, BOUNDARY_SLACK, faceFailures, MISSING_FRACTION, tessellateScene, type FaceFailure, type Mesh,
  type Scene } from '../packages/cad-scene/src/index.ts';
import { parseStep, type Instance, type StepModel } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { StepTessellator } from '../packages/step-export/src/index.ts';
import { AreaOracle, trusted, type OracleResult } from './area_oracle.ts';
import { corpusFiles, partSubset, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';

// Medium, the default, as users get it.
const { linearDeflection: LINEAR_MM, angularDeflection: ANGULAR } = meshDeflections({ profile: 'medium' });
const TRUST = 1e-6, OFF = 0.01, PLANT_EVERY = 50;
// The process's own: the size limit (from its command line) and its meshing pool.
let maxBytes = 2e6, pool: WorkerTessellator;
const plant = process.env.PLANT;
if (plant && plant !== 'measure' && plant !== 'mesh') throw new Error(`PLANT=${plant}: expected measure or mesh`);

const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const bins = [1e-9, 1e-6, 1e-4, 1e-3, 1e-2, 0.1, Infinity];
const bin = (h: number[], x: number) => h[bins.findIndex((b) => x <= b)]!++;
/** A file's tallies, or the run's (addInto); `failed` the files that couldn't be imported. */
const fresh = () => ({ files: 0, skipped: 0, parts: 0, compared: 0, planted: 0, plantedSeen: 0, plantedSlack: 0,
  unmeasured: 0, coverage: new Map<string, number>(), areaHist: bins.map(() => 0), perimHist: bins.map(() => 0),
  judged: new Map<string, number>(), offRows: [] as string[], undetectedRows: [] as string[],
  alarmRows: [] as string[], failed: [] as string[], missed: [] as string[] });
type Tallies = ReturnType<typeof fresh>;
const partsOf = (i: Instance) => ('type' in i ? [{ type: i.type, attrs: i.attrs }] : i.parts);
const rel = (a: number, b: number) => Math.abs(a - b) / b;

function faceMesh(mesh: Mesh | undefined): Map<number, { area: number; ranges: { start: number; count: number }[] }> {
  const out = new Map<number, { area: number; ranges: { start: number; count: number }[] }>();
  if (!mesh) return out;
  const p = mesh.positions, ix = mesh.indices;
  for (const f of mesh.faces) {
    if (f.source === null) continue;
    const e = out.get(f.source) ?? { area: 0, ranges: [] };
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const A = 3 * ix[k]!, B = 3 * ix[k + 1]!, C = 3 * ix[k + 2]!;
      const u0 = p[B]! - p[A]!, u1 = p[B + 1]! - p[A + 1]!, u2 = p[B + 2]! - p[A + 2]!;
      const v0 = p[C]! - p[A]!, v1 = p[C + 1]! - p[A + 1]!, v2 = p[C + 2]! - p[A + 2]!;
      e.area += Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
    }
    e.ranges.push({ start: f.start, count: f.count });
    out.set(f.source, e);
  }
  return out;
}

/** The mesh without each listed face's triangles, last first, until at least half its area is gone (PLANT=mesh). */
function dropHalf(mesh: Mesh, faces: Set<number>): Mesh {
  const p = mesh.positions, ix = mesh.indices;
  const tri = (k: number) => {
    const A = 3 * ix[k]!, B = 3 * ix[k + 1]!, C = 3 * ix[k + 2]!;
    const u0 = p[B]! - p[A]!, u1 = p[B + 1]! - p[A + 1]!, u2 = p[B + 2]! - p[A + 2]!;
    const v0 = p[C]! - p[A]!, v1 = p[C + 1]! - p[A + 1]!, v2 = p[C + 2]! - p[A + 2]!;
    return Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
  };
  const total = new Map<number, number>();
  for (const f of mesh.faces) if (f.source !== null && faces.has(f.source)) {
    for (let k = f.start; k < f.start + f.count; k += 3) total.set(f.source, (total.get(f.source) ?? 0) + tri(k));
  }
  const removed = new Map<number, number>();
  const drop = new Set<number>();
  for (let n = mesh.faces.length - 1; n >= 0; n--) {
    const f = mesh.faces[n]!;
    if (f.source === null || !faces.has(f.source)) continue;
    for (let k = f.start + f.count - 3; k >= f.start; k -= 3) {
      if ((removed.get(f.source) ?? 0) >= total.get(f.source)! / 2) break;
      removed.set(f.source, (removed.get(f.source) ?? 0) + tri(k));
      drop.add(k);
    }
  }
  const keep: number[] = [];
  const out: Mesh['faces'] = [];
  for (const f of mesh.faces) {
    const start = keep.length;
    for (let k = f.start; k < f.start + f.count; k += 3) if (!drop.has(k)) keep.push(ix[k]!, ix[k + 1]!, ix[k + 2]!);
    out.push({ source: f.source, start, count: keep.length - start });
  }
  return { ...mesh, indices: new Uint32Array(keep), faces: out };
}

export const check: FileCheck<undefined, Tallies> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 2) * 1e6;
    pool = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
      export: 'OcctTessellator' }, workers: meshWorkers });
    await pool.init();
  },
  async file(path) {
    const T = fresh(), { coverage, areaHist, perimHist, judged, offRows, undetectedRows, alarmRows } = T;
    const bytes = fs.readFileSync(path);
    if (bytes.length > maxBytes) { T.skipped++; return T; }
    const name = shortName(path);
    let scene: Scene, model: StepModel;
    try {
      ({ scene, model } = await importStep(bytes));
    } catch (e) {
      T.failed.push(`${name}: import failed: ${(e as Error).message}`);
      return T;
    }
    T.files++;
    const meshes = new Map<number, Mesh | undefined>();
    await tessellateScene(scene, new StepTessellator(pool), { linearDeflection: LINEAR_MM, angularDeflection: ANGULAR,
      measures: true, onPart: (i, m) => { meshes.set(i, m); } });
    for (const [i, part] of scene.parts.entries()) {
      if (!part.brep || part.brep.format !== 'step' || !meshes.has(i)) continue;
      T.parts++;
      const sub = parseStep(partSubset(model, part.sources[0]!.id));
      const oracle = new AreaOracle(sub);
      const results = new Map<number, OracleResult>();
      for (const inst of sub.instances()) {
        if (!partsOf(inst).some((q) => q.type === 'ADVANCED_FACE' || q.type === 'FACE_SURFACE')) continue;
        const r = oracle.faceArea(inst.id);
        results.set(inst.id, r);
        inc(coverage, !r.ok ? `unsupported: ${r.reason.replace(/#\d+/g, '#')}`
          : trusted(r, TRUST) ? `trusted: ${r.surface}` : r.flags.length ? `untrusted: ${r.surface}, ${r.flags.join(', ')}`
          : `untrusted: ${r.surface}, error estimate over ${TRUST}`);
      }
      const u = part.unit, d = LINEAR_MM / u;
      const occtMeasures = part.measures?.faces;
      // The faces compared, in id order (deterministic planting).
      const ids = [...results.keys()].filter((id) => { const r = results.get(id)!;
        return trusted(r, TRUST) && r.area >= d * d; }).sort((a, b) => a - b);
      let mesh = meshes.get(i);
      const plantedHere = new Set<number>();
      const measures = new Map(occtMeasures ?? []);
      for (const id of ids) {
        if (!measures.get(id)) continue;
        if (plant && plantedPart(`${name} #${id}`, PLANT_EVERY)) plantedHere.add(id);
        T.compared++;
      }
      if (plant === 'mesh' && mesh && plantedHere.size) {
        const before = faceMesh(mesh);
        mesh = dropHalf(mesh, plantedHere);
        const after = faceMesh(mesh);
        for (const id of plantedHere) {
          const m = measures.get(id)!, b = before.get(id)?.area ?? 0, a = after.get(id)?.area ?? 0;
          measures.set(id, { ...m, area: b > 0 ? m.area * (a / b) : m.area });
          // Within faceFailures' slack (a narrow face: d x P over half its area) no judge can see the loss: judged as
          // faceFailures judges by the oracle, the oracle's area less the mesh left (not the mesh before less after,
          // which differs where the mesh was over the oracle's area to start with).
          const r = results.get(id) as Extract<OracleResult, { ok: true }>;
          if (a > 0 && r.area - a <= Math.max(MISSING_FRACTION * r.area, BOUNDARY_SLACK * d * r.perimeter)) {
            T.plantedSlack++;
            plantedHere.delete(id);
          }
        }
      }
      if (plant === 'measure') for (const id of plantedHere) measures.set(id, { ...measures.get(id)!, area: measures.get(id)!.area * 1.05 });
      T.planted += plantedHere.size;
      const base: Mesh = mesh ?? { origin: part.origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [] };
      const byOcct = faceFailures(base, { expected: ids, measured: { measures: { by: 'occt', faces: measures }, deflection: d } });
      const oracleMeasures = new Map(ids.map((id) => { const r = results.get(id) as Extract<OracleResult, { ok: true }>;
        return [id, { area: r.area, perimeter: r.perimeter, valid: true }]; }));
      const byOracle = faceFailures(base, { expected: ids, measured: { measures: { by: 'oracle', faces: oracleMeasures }, deflection: d } });
      const fm = faceMesh(mesh);
      const seenHere = new Set<number>(), verdicts = new Map<number, string>();
      for (const id of ids) {
        const r = results.get(id) as Extract<OracleResult, { ok: true }>;
        const m = measures.get(id);
        if (!m) { T.unmeasured++; continue; }
        const where = `${name} #${id} (part #${part.sources[0]!.id}, ${r.surface})`;
        const mm2 = u * u;
        const ra = rel(m.area, r.area);
        bin(areaHist, ra);
        if (r.surface === 'plane' && m.perimeter >= 0) bin(perimHist, rel(m.perimeter, r.perimeter));
        const meshArea = (fm.get(id)?.area ?? 0) * mm2;
        const detail = `oracle ${(r.area * mm2).toPrecision(8)}, OCCT measured ${(m.area * mm2).toPrecision(8)}${m.valid ? '' : ' (invalid)'}, mesh ${meshArea.toPrecision(8)} mm^2`;
        if (ra > OFF) { offRows.push(`  ${where}: ${detail}`); if (plantedHere.has(id) && plant === 'measure') { T.plantedSeen++; seenHere.add(id); } }
        const o: FaceFailure | 'ok' = byOcct.get(id) ?? 'ok', q: FaceFailure | 'ok' = byOracle.get(id) ?? 'ok';
        inc(judged, `OCCT's measures: ${o.padEnd(10)} oracle: ${q}`);
        verdicts.set(id, `OCCT's measures ${o}, oracle ${q}`);
        if (q !== 'ok' && o === 'ok') { undetectedRows.push(`  ${where}: oracle ${q}; ${detail}`);
          if (plantedHere.has(id) && plant === 'mesh') { T.plantedSeen++; seenHere.add(id); } }
        if (o !== 'ok' && q === 'ok') alarmRows.push(`  ${where}: OCCT's measures ${o}; ${detail}`);
      }
      for (const id of plantedHere) {
        if (!seenHere.has(id)) {
          T.missed.push(`${name} #${id} (part #${part.sources[0]!.id}; ${verdicts.get(id) ?? 'not judged'})`);
        }
      }
    }
    return T;
  },
  teardown() {
    pool.dispose();
  },
};

if (import.meta.main) {
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) all.failed.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      else addInto(all, out.result);
    });
  const { files, skipped, parts, compared, planted, plantedSeen, plantedSlack, unmeasured, coverage, areaHist,
    perimHist, judged, offRows, undetectedRows, alarmRows } = all;
  // (Printed as each file failed, before.)
  for (const l of all.failed) console.log(l);
  const pct = (n: number, t: number) => `${(100 * n / Math.max(t, 1)).toFixed(1)} %`;
  console.log(`${files} files (${skipped} over the size limit), ${parts} parts; ${compared} faces compared (trusted by the oracle, at least ${(LINEAR_MM ** 2).toPrecision(2)} mm^2, measured by OCCT)${unmeasured ? `; ${unmeasured} trusted faces OCCT didn't measure` : ''}`);
  if (plant) console.log(`PLANT=${plant}: ${planted} faces planted, ${plantedSeen} listed (${plantedSeen === planted ? 'all caught' : 'NOT ALL CAUGHT'})${plantedSlack ? `; ${plantedSlack} more planted within faceFailures' slack (not counted)` : ''}`);
  if (plant && all.missed.length) console.log(`  not listed: ${all.missed.slice(0, 10).join('; ')}`);
  console.log('\nThe oracle\'s coverage (every face of every part):');
  for (const [k, n] of [...coverage].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) console.log(`${String(n).padStart(8)}  ${k}`);
  const hist = (h: number[]) => bins.map((b, k) => `<= ${b === Infinity ? 'inf' : b.toExponential(0)}: ${h[k]}`).join(', ');
  const n = areaHist.reduce((a, b) => a + b, 0);
  console.log(`\nOCCT's measured area against the oracle's, relative difference: ${hist(areaHist)}`);
  console.log(`  within 1e-4: ${pct(areaHist.slice(0, 3).reduce((a, b) => a + b, 0), n)}`);
  console.log(`OCCT's perimeter against the oracle's, planes only: ${hist(perimHist)}`);
  console.log('\nfaceFailures with OCCT\'s measures (as the library judges) and with the oracle\'s:');
  for (const [k, c] of [...judged].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) console.log(`${String(c).padStart(8)}  ${k}`);
  console.log(`\nOCCT's measured area more than ${100 * OFF} % off the oracle's (${offRows.length}):`);
  for (const l of offRows) console.log(l);
  console.log(`\nFailures only the oracle finds: the library can't see them (${undetectedRows.length}):`);
  for (const l of undetectedRows) console.log(l);
  console.log(`\nFailures only OCCT's measures find (${alarmRows.length}):`);
  for (const l of alarmRows) console.log(l);
}
