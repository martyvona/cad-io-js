// Our own tessellator (tess-cadio) against our OCCT backend, part by part: every B-rep part of every listed file is
// meshed from its model by both (each in a tess-workers pool, so a hang costs only its timeout) at the medium
// profile, and classified:
//   - status: ours ok, failed (an error with no triangles), timed out or crashed, when OCCT meshes the part;
//   - faces ours leaves without triangles, by cause from the model (the surface kind cad-geom lacks, no loops, other),
//     and those OCCT leaves too;
//   - open model edges (cad-scene's openEdges) on each backend's mesh;
//   - each face's mesh area against cad-scene's area oracle (where it trusts its area) and against OCCT's mesh area;
//   - the deflection measured independently: points of sampled triangles (centroid, sides' middles) against the
//     face's surface by cad-brep's evaluators (not cad-geom, which ours uses), over the linear deflection asked;
//   - triangles and meshing time against OCCT's.
// Usage: node corpus_checks/cadio_corpus.ts [file-list.txt] [max MB, default 1000]   (progress on standard error)
//   WORKERS=<n> workers per backend in each process (default: half the process's share, runner.ts)
//   PLANT=<bug>  a bug planted in our results before they're judged, to prove the check sees it: area (positions
//                scaled 1% about the part's origin), open (every 7th triangle dropped), deflect (every vertex not on
//                a model edge moved 3 deflections along its normal), fail (each part's first meshed face emptied)
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import type { TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { MESH_PROFILES, openEdges } from '../packages/cad-scene/src/index.ts';
import { type BrepData, decode, nearestParams, surfaceEvaluator } from '../packages/cad-brep/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { modelFaceArea, trusted } from './area_oracle.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { addInto, division, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const EXAMPLES = 4;
/** Triangles sampled per face for the deflection, evenly through its range. */
const SAMPLES = 16;
/** The surface kinds cad-geom meshes today; a face on another is expected to fail. */
const SUPPORTED = new Set(['plane', 'cylinder', 'sphere', 'bspline']);
const { linearDeflection: LIN, angularDeflection: ANG } = MESH_PROFILES.medium;
const PLANT = process.env.PLANT ?? '';

let maxBytes = 1000e6, cadio: WorkerTessellator, occt: WorkerTessellator;
type R = TessellationResult;

/** Each face id's mesh area and triangle count, over its ranges. */
function faceAreas(r: R): Map<number, { area: number; tris: number }> {
  const out = new Map<number, { area: number; tris: number }>();
  const p = r.positions, ix = r.indices;
  for (const f of r.faces) {
    if (f.entityId === null) continue;
    const e = out.get(f.entityId) ?? { area: 0, tris: 0 };
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const A = 3 * ix[k]!, B = 3 * ix[k + 1]!, C = 3 * ix[k + 2]!;
      const u0 = p[B]! - p[A]!, u1 = p[B + 1]! - p[A + 1]!, u2 = p[B + 2]! - p[A + 2]!;
      const v0 = p[C]! - p[A]!, v1 = p[C + 1]! - p[A + 1]!, v2 = p[C + 2]! - p[A + 2]!;
      e.area += Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
    }
    e.tris += f.count / 3;
    out.set(f.entityId, e);
  }
  return out;
}

type Bin = '0.1%' | '1%' | '5%' | 'worse';
const bins = (): Record<Bin, number> => ({ '0.1%': 0, '1%': 0, '5%': 0, worse: 0 });
const bin = (rel: number): Bin => (rel <= 1e-3 ? '0.1%' : rel <= 0.01 ? '1%' : rel <= 0.05 ? '5%' : 'worse');
/** Deflection measured over asked: within, within 1.5x, 3x, worse; points that couldn't be placed on the surface. */
type DBin = 'within' | '1.5x' | '3x' | 'worse' | 'unmeasured';
const dbins = (): Record<DBin, number> => ({ within: 0, '1.5x': 0, '3x': 0, worse: 0, unmeasured: 0 });
const dbin = (ratio: number): DBin => (ratio <= 1 + 1e-6 ? 'within' : ratio <= 1.5 ? '1.5x' : ratio <= 3 ? '3x'
  : 'worse');

/** Why a face ours left without triangles: from the model alone. */
function cause(d: BrepData, row: number): string {
  const face = decode.face(d, row);
  const kind = (decode.surface(d, face.surface) as { kind: string }).kind;
  if (!SUPPORTED.has(kind)) return `surface ${kind}`;
  if (!face.loops.length) return 'no loops';
  if (face.loops.every((l) => l.kind !== 'edge')) return `only ${face.loops.map((l) => l.kind).join(', ')} loops`;
  return 'other';
}

/**
 * The largest distance from a face's sampled triangles (centroid and sides' middles) to its surface, over the
 * deflection: per face id, by cad-brep's evaluator (its closed-form params, else nearestParams); undefined where no
 * point could be placed.
 */
function deflections(d: BrepData, r: R, origin: readonly number[], rowOf: Map<number, number>):
  Map<number, number | undefined> {
  const out = new Map<number, number | undefined>();
  const evals = new Map(), curves = new Map();
  for (const f of r.faces) {
    if (f.entityId === null || f.count === 0) continue;
    const row = rowOf.get(f.entityId);
    if (row === undefined) continue;
    const ev = surfaceEvaluator(d, decode.face(d, row).surface, evals, curves);
    let worst: number | undefined = out.get(f.entityId);
    const n = Math.min(SAMPLES, f.count / 3);
    for (let s = 0; s < n && ev; s++) {
      const k = f.start + 3 * Math.floor((s * f.count) / 3 / n);
      const P = [0, 1, 2].map((j) => [0, 1, 2].map((c) => r.positions[3 * r.indices[k + j]! + c]! + origin[c]!));
      const at = (w: number[]) => [0, 1, 2].map((c) => w[0]! * P[0]![c]! + w[1]! * P[1]![c]! + w[2]! * P[2]![c]!);
      for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
        const p = at(w) as [number, number, number];
        const uv = ev.params?.(p) ?? nearestParams(ev, p);
        if (!uv) continue;
        const q = ev.point(uv[0], uv[1]);
        const dist = Math.hypot(q[0]! - p[0], q[1]! - p[1], q[2]! - p[2]);
        worst = Math.max(worst ?? 0, dist / LIN);
      }
    }
    out.set(f.entityId, worst);
  }
  return out;
}

/** PLANT's bug, applied to our result (a copy). */
function plant(r: R, d: BrepData): R {
  const x: R = { ...r, positions: r.positions.slice(), indices: r.indices.slice(),
    faces: r.faces.map((f) => ({ ...f })) };
  if (PLANT === 'area') for (let i = 0; i < x.positions.length; i++) x.positions[i] = x.positions[i]! * 1.01;
  if (PLANT === 'open') {
    const keep: number[] = [];
    const faces = x.faces.map((f) => {
      const start = keep.length;
      for (let t = f.start; t < f.start + f.count; t += 3) {
        if (((t / 3) | 0) % 7 !== 3) keep.push(...x.indices.slice(t, t + 3));
      }
      return { ...f, start, count: keep.length - start };
    });
    x.indices = Uint32Array.from(keep);
    x.faces = faces;
  }
  if (PLANT === 'deflect' && x.normals) {
    const onEdge = new Set<string>();
    for (let i = 0; i < (x.edgePositions?.length ?? 0); i += 3) {
      onEdge.add(`${x.edgePositions![i]},${x.edgePositions![i + 1]},${x.edgePositions![i + 2]}`);
    }
    for (let i = 0; i < x.positions.length; i += 3) {
      if (onEdge.has(`${x.positions[i]},${x.positions[i + 1]},${x.positions[i + 2]}`)) continue;
      for (let c = 0; c < 3; c++) x.positions[i + c] = x.positions[i + c]! + 3 * LIN * x.normals[i + c]!;
    }
  }
  if (PLANT === 'fail') {
    const f = x.faces.find((y) => y.count > 0);
    if (f) f.count = 0;
  }
  void d;
  return x;
}

type Status = 'ok' | 'error' | 'timeout' | 'crash';
const fresh = () => ({
  files: 0, skippedBig: 0, parts: 0, occtEmpty: 0, compared: 0,
  status: { ok: 0, error: 0, timeout: 0, crash: 0 } as Record<Status, number>,
  faces: 0, faceless: 0, facelessOcctToo: 0, occtFaceless: 0,
  causes: new Map<string, number>(),
  open: { cadio: { parts: 0, edges: 0, unjudged: 0 }, occt: { parts: 0, edges: 0, unjudged: 0 } },
  oracle: { faces: 0, cadio: bins(), occt: bins() },
  meshArea: bins(),
  deflection: { cadio: dbins(), occt: dbins() },
  trisCadio: 0, trisOcct: 0, msCadio: 0, msOcct: 0,
  refused: { faces: 0, triangles: 0, poleSlivers: 0 },
  warnings: new Map<string, number>(),
  tally: new Map<string, { n: number; ex: string[] }>(),
});
type Tallies = ReturnType<typeof fresh>;
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

export const check: FileCheck<undefined, Tallies> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 1000) * 1e6;
    const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 2)));
    const pool = (pkg: string, cls: string) => new WorkerTessellator({
      backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls }, workers });
    cadio = pool('tess-cadio', 'CadioTessellator');
    occt = pool('tess-occt', 'OcctTessellator');
    await Promise.all([cadio.init(), occt.init()]);
  },
  async teardown() {
    await Promise.all([cadio.dispose(), occt.dispose()]);
  },
  async file(f) {
    const T = fresh();
    const note = (k: string, ex: string) => {
      const t = T.tally.get(k) ?? { n: 0, ex: [] };
      t.n++;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      T.tally.set(k, t);
    };
    const bytes = fs.readFileSync(f);
    if (bytes.length > maxBytes) { T.skippedBig++; return T; }
    T.files++;
    const name = shortName(f);
    const { scene } = await importStep(new Uint8Array(bytes));
    const parts = scene.parts.filter((p) => p.brep);
    const run = async (t: WorkerTessellator, req: TessellationRequest) => {
      const t0 = performance.now();
      const r = await t.tessellate(req).catch((e: Error) => e);
      return { r, ms: performance.now() - t0 };
    };
    const results = await Promise.all(parts.map(async (p) => {
      const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
        origin: p.origin, linearDeflection: LIN, angularDeflection: ANG, edges: true };
      const [a, b] = await Promise.all([run(cadio, req), run(occt, req)]);
      return { p, a, b };
    }));
    for (const { p, a, b } of results) {
      T.parts++;
      const where = `${name} #${p.sources[0]!.id}`;
      if (b.r instanceof Error || !b.r.indices.length) { T.occtEmpty++; continue; }
      T.compared++;
      T.msOcct += b.ms;
      T.msCadio += a.ms;
      const ob = b.r, d = p.brep!.model;
      T.trisOcct += ob.indices.length / 3;
      if (a.r instanceof Error) {
        const m = a.r.message;
        const k: Status = /timed out/.test(m) ? 'timeout' : /exit|crash|terminated|memory/.test(m) ? 'crash' : 'error';
        T.status[k]++;
        note(`ours ${k}: ${m.replace(/\d+/g, 'N').slice(0, 120)}`, where);
        continue;
      }
      const ca = PLANT ? plant(a.r, d) : a.r;
      for (const x of ca.diagnostics) {
        if (x.severity !== 'warning') continue;
        // Refused triangles, and of them the slivers in a pole's fan (lane 3's fans are measured by this).
        const m = /^(\d+) faces meshed with triangles .*: (\d+) triangles, (\d+) of them slivers/.exec(x.message);
        if (m) {
          T.refused.faces += Number(m[1]);
          T.refused.triangles += Number(m[2]);
          T.refused.poleSlivers += Number(m[3]);
          if (Number(m[2]) > Number(m[3])) note('triangles refused away from a pole', where);
          continue;
        }
        bump(T.warnings, x.message.replace(/\d+/g, 'N'));
      }
      if (!ca.indices.length) {
        T.status.error++;
        note(`ours no triangles: ${ca.diagnostics.map((x) => x.message.replace(/\d+/g, 'N')).join('; ')
          .slice(0, 120)}`, where);
        continue;
      }
      T.status.ok++;
      T.trisCadio += ca.indices.length / 3;
      const rowOf = new Map<number, number>();
      for (let fr = 0; fr < d.face.surface.length; fr++) rowOf.set(d.face.id[fr]!, fr);
      // Faces without triangles, by cause; and whether OCCT leaves them too.
      const ours = faceAreas(ca), theirs = faceAreas(ob);
      // Each failed face's status, as our backend says it.
      const statusOf = new Map<number, string>();
      for (const x of ca.diagnostics) {
        if (!x.message.startsWith('faces failed to mesh, by status: ')) continue;
        for (const m of x.message.matchAll(/(\w+) \d+ \(([^)]*)\)/g)) {
          for (const id of m[2]!.matchAll(/#(\d+)/g)) statusOf.set(Number(id[1]), m[1]!);
        }
      }
      for (let fr = 0; fr < d.face.surface.length; fr++) {
        const id = d.face.id[fr]!;
        T.faces++;
        const o = ours.get(id), t = theirs.get(id);
        if (!t || !t.tris) T.occtFaceless++;
        if (o && o.tris) continue;
        T.faceless++;
        if (!t || !t.tris) T.facelessOcctToo++;
        let c = cause(d, fr);
        if (c.startsWith('other')) c = `other: ${statusOf.get(id) ?? 'status unlisted'}`;
        bump(T.causes, c);
        note(`face without our triangles: ${c}${!t || !t.tris ? ' (OCCT neither)' : ''}`, `${where} face #${id}`);
      }
      for (const [who, r] of [['cadio', ca], ['occt', ob]] as const) {
        const n = openEdges(d, r);
        if (n.open.length) {
          T.open[who].parts++;
          T.open[who].edges += n.open.length;
          if (who === 'cadio') note('open edges in our mesh', `${where} edges ${n.open.slice(0, 3).join(', ')}`);
        }
        T.open[who].unjudged += n.unjudged.length;
      }
      // Areas: against the oracle where it trusts its own, and against OCCT's mesh.
      for (const [id, o] of ours) {
        if (!o.tris) continue;
        const t = theirs.get(id);
        if (t && t.tris) {
          const k = bin(Math.abs(o.area - t.area) / Math.max(t.area, 1e-12));
          T.meshArea[k]++;
          if (k === 'worse') note('mesh area off OCCT\'s by over 5%', `${where} face #${id}`);
        }
        const row = rowOf.get(id);
        if (row === undefined) continue;
        const z = modelFaceArea(d, row);
        if (!z.ok || !trusted(z) || !(z.area > 0)) continue;
        T.oracle.faces++;
        const k = bin(Math.abs(o.area - z.area) / z.area);
        T.oracle.cadio[k]++;
        if (k === 'worse') note('mesh area off the oracle\'s by over 5%', `${where} face #${id}`);
        T.oracle.occt[bin(t && t.tris ? Math.abs(t.area - z.area) / z.area : Infinity)]++;
      }
      // The deflection, both backends, by the same independent measure.
      for (const [who, r] of [['cadio', ca], ['occt', ob]] as const) {
        for (const [id, ratio] of deflections(d, r, p.origin, rowOf)) {
          const k = ratio === undefined ? 'unmeasured' : dbin(ratio);
          T.deflection[who][k]++;
          if (who === 'cadio' && (k === '3x' || k === 'worse')) {
            note(`deflection over ${k === 'worse' ? '3x' : '1.5x'} asked`,
              `${where} face #${id} (${ratio!.toFixed(2)}x)`);
          }
        }
      }
    }
    return T;
  },
};

if (import.meta.main) {
  console.log(await hostLine());
  maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
  const all = fresh();
  const { children, meshWorkers } = division();
  const perBackend = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 2)));
  const rows: string[] = [];
  const t0 = performance.now();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) { rows.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`); return; }
      const r = out.result;
      for (const [k, t] of r.tally) {
        const u = all.tally.get(k) ?? { n: 0, ex: [] };
        u.n += t.n;
        for (const e of t.ex) if (u.ex.length < EXAMPLES) u.ex.push(e);
        all.tally.set(k, u);
      }
      for (const [k, n] of r.causes) bump(all.causes, k, n);
      for (const [k, n] of r.warnings) bump(all.warnings, k, n);
      r.tally = new Map();
      r.causes = new Map();
      r.warnings = new Map();
      addInto(all, r);
    });
  const T = all;
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(2) : '0'}%)`;
  const show = (b: Record<string, number>) => Object.entries(b).map(([k, n]) =>
    `${k === 'worse' ? ('3x' in b ? '> 3x' : '> 5%') : /%$/.test(k) ? `within ${k}` : k} ${n}`).join(', ');
  console.log(`tess-cadio against OCCT (native route), medium profile${PLANT ? `, PLANT=${PLANT}` : ''}: ${T.files} `
    + `files (${T.skippedBig} over ${maxBytes / 1e6} MB skipped), ${T.parts} B-rep parts; OCCT meshes ${T.compared} `
    + `(${T.occtEmpty} empty or failed, not compared)`);
  console.log('  (Triangles and time against OCCT wait for lane 3\'s local criteria: the provisional ones size a whole '
    + 'face by its sharpest curvature, so ours are no measure of either yet.)');
  console.log(`  our status: ${Object.entries(T.status).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  faces without our triangles: ${pct(T.faceless, T.faces)} (OCCT leaves ${T.facelessOcctToo} of them `
    + `too, ${T.occtFaceless} in all); by cause: ${[...T.causes].sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  open model edges: ours ${T.open.cadio.edges} in ${T.open.cadio.parts} parts, OCCT `
    + `${T.open.occt.edges} in ${T.open.occt.parts}; not judged (no polyline): ours ${T.open.cadio.unjudged}, OCCT `
    + `${T.open.occt.unjudged}`);
  console.log(`  mesh area against the oracle (${T.oracle.faces} faces we mesh it trusts): ours `
    + `${show(T.oracle.cadio)}; `
    + `OCCT ${show(T.oracle.occt)}`);
  console.log(`  mesh area against OCCT's (faces both mesh): ${show(T.meshArea)}`);
  console.log(`  deflection measured (faces, worst sampled point over ${LIN} mm): ours ${show(T.deflection.cadio)}; `
    + `OCCT ${show(T.deflection.occt)}`);
  console.log(`  triangles: ours ${T.trisCadio}, OCCT ${T.trisOcct}; meshing ${(T.msCadio / 1000).toFixed(1)} s ours, `
    + `${(T.msOcct / 1000).toFixed(1)} s OCCT (wall time per request, summed)`);
  console.log(`  triangles our criteria still refuse: ${T.refused.triangles} in ${T.refused.faces} faces, `
    + `${T.refused.poleSlivers} of them slivers in a pole's fan`);
  console.log(`  our warnings: ${[...T.warnings].map(([k, n]) => `${n} x "${k}"`).join('; ') || 'none'}`);
  console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s, ${children || 1} processes x ${perBackend} workers `
    + 'per backend');
  console.log();
  for (const [k, t] of [...T.tally].sort((x, y) => y[1].n - x[1].n)) console.log(
    `${String(t.n).padStart(8)} ${k}  e.g. ${t.ex.join('; ')}`);
  for (const r of rows) console.log(r);
}
