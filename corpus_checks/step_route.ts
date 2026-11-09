// OCCT meshing each part from the B-rep model written as STEP (step-export) against meshing it from the file's own
// subset (cut from the file: corpus.ts's partSubset), over the corpus, with the writer checked on its own on the way.
// Per part:
//   (b) the written file bound against AP242 with every value checked: diagnostics tallied (expected: none but the
//       writer's own warnings' consequences);
//   (c) the written file read back by step-import's reader: its model against the original as walks from the items
//       (packages/step-export/test/compare.ts): equal but for the last bits of numbers, else each difference tallied;
//       rows no item reaches (not written) counted apart;
//   (d) both files meshed by our OCCT backend (a tess-workers pool, 0.1 mm, 0.5 rad, measures): failures, faces by id
//       (present in one only, triangles, failed, OCCT's measured area and validity, mesh area, the mesh's mean normal
//       against the other's: inverted), wireframe curves by id and points, and time.
// (c) passing with (d) differing points to OCCT reading the two files differently, or a misconception shared by the
// writer and the importer. PLANT=sense turns over the first face of every 10th part's model before writing (each such
// face must show inverted in (d)); PLANT=angle converts every 10th part's cones' semi-angles twice (their areas must
// differ in (d)); PLANT=text flips the first ADVANCED_FACE's same_sense in every 10th part's written text (each must
// show in (c) and in (d)).
// Usage: node --max-old-space-size=12000 corpus_checks/step_route.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import { type BrepData, openBrep, rowCount, SURFACE_KIND } from '../packages/cad-brep/src/index.ts';
import type { TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { openModel, parseStep } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { stepPartBytes } from '../packages/step-export/src/index.ts';
import { differences, walk } from '../packages/step-export/test/compare.ts';
import { readBack } from '../packages/step-export/test/readback.ts';
import { corpusFiles, partSubset, shortName } from './corpus.ts';

const LINEAR_MM = 0.1, ANGULAR = 0.5, PLANT_EVERY = 10;
const maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
const plant = process.env.PLANT;
if (plant && !['sense', 'angle', 'text'].includes(plant)) {
  throw new Error(`PLANT=${plant}: expected sense, angle or text`);
}

const pool = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
  export: 'OcctTessellator' } });
await pool.init();

const tally = new Map<string, { n: number; ex: string[] }>();
const note = (k: string, ex: string, n = 1) => {
  const t = tally.get(k) ?? { n: 0, ex: [] };
  t.n += n;
  if (t.ex.length < 4) t.ex.push(ex);
  tally.set(k, t);
};
let files = 0, parts = 0, writtenBytes = 0, subsetBytes = 0, timeSubset = 0, timeModel = 0, timeWrite = 0;
let readSame = 0, readBits = 0, worstBits = 0, facesBoth = 0, facesSameMesh = 0;
/** Faces differing in (d), by file: every one, for classifying. */
const byFile = new Map<string, string[]>();
const planted = { parts: 0, faces: new Set<string>(), seenC: new Set<string>(), seenD: new Set<string>() };

/** A part's model with a bug planted (PLANT=sense, angle), and the face ids it should show at. */
function plantModel(m: BrepData, k: number): { m: BrepData; faces: number[] } {
  if ((plant !== 'sense' && plant !== 'angle') || k % PLANT_EVERY) return { m, faces: [] };
  const c = openBrep(m.buffer.slice(0));
  const faces: number[] = [];
  if (plant === 'sense' && rowCount(c, 'face')) {
    c.face.sameSense[0] = 1 - c.face.sameSense[0]!;
    faces.push(c.face.id[0]!);
  } else if (plant === 'angle') {
    for (let s = 0; s < rowCount(c, 'surface'); s++) {
      if (c.surface.kind[s] !== SURFACE_KIND.cone) continue;
      c.pool.surfaceReal[c.surface.real[s]! + 10]! *= Math.PI / 180;
      for (let f = 0; f < rowCount(c, 'face'); f++) if (c.face.surface[f] === s) faces.push(c.face.id[f]!);
    }
  }
  return faces.length ? { m: c, faces } : { m, faces };
}

/** PLANT=text: the first ADVANCED_FACE's same_sense flipped in the written text; its id. */
function plantText(data: Uint8Array, k: number): { data: Uint8Array; face?: number } {
  if (plant !== 'text' || k % PLANT_EVERY) return { data };
  const text = new TextDecoder().decode(data);
  const m = /^#(\d+)=ADVANCED_FACE\((.*),\.([TF])\.\);$/m.exec(text);
  if (!m) return { data };
  const flipped = text.replace(m[0], `#${m[1]}=ADVANCED_FACE(${m[2]},.${m[3] === 'T' ? 'F' : 'T'}.);`);
  return { data: new TextEncoder().encode(flipped), face: Number(m[1]) };
}

/** Per face id: triangles, mesh area, the area-weighted normal, OCCT's measures. */
function faces(r: TessellationResult) {
  const out = new Map<number, { tris: number; area: number; n: [number, number, number]; measured?: number;
    valid?: boolean }>();
  const p = r.positions, ix = r.indices;
  for (const f of r.faces) {
    if (f.entityId === null) continue;
    const x = out.get(f.entityId) ?? { tris: 0, area: 0, n: [0, 0, 0] as [number, number, number] };
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [a, b, c] = [ix[t]! * 3, ix[t + 1]! * 3, ix[t + 2]! * 3];
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      x.area += Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
      for (let i = 0; i < 3; i++) x.n[i]! += n[i]!;
    }
    x.tris += f.count / 3;
    out.set(f.entityId, x);
  }
  for (const m of r.measures ?? []) {
    const x = out.get(m.entityId) ?? { tris: 0, area: 0, n: [0, 0, 0] as [number, number, number] };
    x.measured = m.area;
    x.valid = m.valid;
    out.set(m.entityId, x);
  }
  return out;
}

async function mesh(req: TessellationRequest): Promise<{ r?: TessellationResult; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const r = await pool.tessellate(req);
    return { r, ms: performance.now() - t0 };
  } catch (e) {
    return { error: (e as Error).message, ms: performance.now() - t0 };
  }
}

const norm = (s: string) => s.replace(/#\d+/g, '#').replace(/^\d+ x /, '').replace(/\[\d+\]/g, '[]');
for (const path of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(path);
  if (bytes.length > maxBytes) continue;
  files++;
  const name = shortName(path);
  process.stderr.write(`${files} ${name}\n`);
  const { scene, model } = await importStep(new Uint8Array(bytes));
  for (const part of scene.parts) {
    const m0 = part.brep?.model;
    if (!m0 || part.brep!.format !== 'step') continue;
    parts++;
    const repId = part.sources[0]!.id, where = `${name} #${repId}`;
    const { m, faces: plantedFaces } = plantModel(m0, parts);
    const t0 = performance.now();
    const w = stepPartBytes(m);
    timeWrite += performance.now() - t0;
    const { data, face: textFace } = plantText(w.data, parts);
    const plantedHere = [...plantedFaces, ...(textFace !== undefined ? [textFace] : [])];
    if (plantedHere.length) planted.parts++;
    for (const f of plantedHere) planted.faces.add(`${where} #${f}`);
    writtenBytes += data.length;
    for (const x of w.diagnostics) note(`writer ${x.severity}: ${norm(x.message)}`, where);

    // (b) Bound against AP242, values checked.
    const bound = await openModel(parseStep(data));
    for (const x of bound.diagnostics) note(`bind: ${norm(x.message)}`, where);
    for (let p = 0; p < bound.file.count; p++) {
      for (const x of bound.bind(p, { check: true }).diagnostics) {
        note(`bind ${x.severity}: ${norm(x.message)}`, `${where} #${bound.file.index.ids[p]}`);
      }
    }

    // (c) Read back.
    const back = await readBack(data, w.rootId);
    for (const x of back.warnings) note(`read back: ${norm(x)}`, where);
    const diffs = differences(walk(m0), walk(back.brep));
    if (!diffs.length) readSame++;
    else if (diffs.every((x) => x.bits)) readBits++;
    for (const x of diffs) {
      if (x.bits) worstBits = Math.max(worstBits, x.rel ?? 0);
      else note(`read back differs: ${norm(x.path)}`, where);
    }
    if (plantedHere.length && diffs.some((x) => !x.bits)) planted.seenC.add(where);
    // Rows no item reaches aren't written: fewer rows read back.
    for (const t of ['curve', 'surface', 'vertex', 'edge', 'face', 'shell', 'body'] as const) {
      const n = rowCount(m0, t) - rowCount(back.brep, t);
      if (n > 0) note(`${t} rows no item reaches (not written)`, where, n);
      if (n < 0) note(`${t} rows: more read back`, where, -n);
    }

    // (d) OCCT on both.
    const unit = part.unit;
    const base = { format: 'step' as const, origin: part.origin, linearDeflection: LINEAR_MM / unit,
      angularDeflection: ANGULAR, measures: true };
    const subset = partSubset(model, repId);
    subsetBytes += subset.length;
    const a = await mesh({ ...base, data: subset, rootId: repId });
    const b = await mesh({ ...base, data, rootId: w.rootId });
    timeSubset += a.ms;
    timeModel += b.ms;
    if (a.error || b.error) {
      note(`OCCT failed: subset ${a.error ?? 'ok'}, model ${b.error ?? 'ok'}`.slice(0, 160), where);
      continue;
    }
    const fa = faces(a.r!), fb = faces(b.r!);
    const nullA = a.r!.faces.filter((f) => f.entityId === null).length, nullB = b.r!.faces.filter((f) =>
      f.entityId === null).length;
    if (nullA !== nullB) note('ranges with no face id: counts differ', `${where}: ${nullA}, ${nullB}`);
    // Wireframe curves and points (a geometric set's): counts by id.
    const ids = (xs: (number | null)[] | undefined) => JSON.stringify([...xs ?? []].sort());
    if (ids(a.r!.curves?.map((c) => c.entityId)) !== ids(b.r!.curves?.map((c) => c.entityId))) {
      note('wireframe curves differ', `${where}: ${a.r!.curves?.length ?? 0}, ${b.r!.curves?.length ?? 0}`);
    }
    if ((a.r!.points?.length ?? 0) !== (b.r!.points?.length ?? 0)) {
      note('points differ', `${where}: ${(a.r!.points?.length ?? 0) / 3}, ${(b.r!.points?.length ?? 0) / 3}`);
    }
    for (const [id, x] of fa) {
      const y = fb.get(id);
      const at = `${where} face #${id}`;
      const isPlanted = planted.faces.has(`${where} #${id}`);
      if (!y) { note('face meshed from the subset only', at); continue; }
      facesBoth++;
      const kinds: string[] = [];
      if ((x.tris > 0) !== (y.tris > 0)) {
        kinds.push(x.tris > 0 ? 'failed from the model only' : 'failed from the subset only');
      }
      if (x.measured !== undefined && y.measured !== undefined
        && Math.abs(x.measured - y.measured) > 1e-6 * Math.max(x.measured, y.measured, 1e-12)) {
        kinds.push('OCCT\'s measured area differs (over 1e-6)');
      }
      if (x.valid !== y.valid) kinds.push(`validity: subset ${x.valid}, model ${y.valid}`);
      const la = Math.hypot(...x.n), lb = Math.hypot(...y.n);
      if (la > 1e-3 * x.area && lb > 1e-3 * y.area && x.n[0] * y.n[0] + x.n[1] * y.n[1] + x.n[2] * y.n[2] < 0) {
        kinds.push('inverted');
      }
      if (x.tris !== y.tris) kinds.push('triangle counts differ');
      else if (Math.abs(x.area - y.area) > 1e-6 * Math.max(x.area, y.area, 1e-12)) kinds.push('mesh areas differ');
      if (!kinds.length) facesSameMesh++;
      if (isPlanted && kinds.some((k) => k !== 'triangle counts differ')) planted.seenD.add(`${where} #${id}`);
      for (const k of kinds) if (!isPlanted) note(k, at);
      if (kinds.length && !isPlanted) byFile.set(name, [...byFile.get(name) ?? [], `#${id} ${kinds.join(', ')}`]);
    }
    for (const id of fb.keys()) if (!fa.has(id)) note('face meshed from the model only', `${where} face #${id}`);
  }
}
pool.dispose();

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`${files} files, ${parts} parts; written ${mb(writtenBytes)} MB (subsets ${mb(subsetBytes)} MB) in `
  + `${(timeWrite / 1000).toFixed(1)} s`);
console.log(`(c) read back: ${readSame} parts the same, ${readBits} more but for last bits (largest ${worstBits
  .toExponential(2)} relative)`);
console.log(`(d) OCCT: ${facesBoth} faces meshed from both, ${facesSameMesh} with the same triangles, areas, measures, `
  + `validity and orientation; meshing ${(timeSubset / 1000).toFixed(1)} s from subsets, ${(timeModel / 1000)
    .toFixed(1)} s from models`);
if (plant) {
  console.log(`PLANT=${plant}: ${planted.parts} parts, ${planted.faces.size} faces planted; seen by (c) in `
    + `${planted.seenC.size} parts, by (d) at ${planted.seenD.size} faces`);
}
for (const [k, v] of [...tally].sort((x, y) => y[1].n - x[1].n)) {
  console.log(String(v.n).padStart(8), k, ' e.g.', v.ex.join('; '));
}
console.log('\n(d) faces differing, by file:');
for (const [f, xs] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(String(xs.length).padStart(8), f);
  for (const x of xs) console.log('           ', x);
}
