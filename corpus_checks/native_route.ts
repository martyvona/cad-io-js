// OCCT's two routes for a part's B-rep model over the corpus: the native route (tess-occt's builder,
// native/occt_build.cpp, then the STEP reader's healing) against the STEP route (the model written by step-export and
// read by OCCT's reader), the library's two ways of giving OCCT a model. Per part:
//   (a) both meshed by our OCCT backend (a tess-workers pool of the native route's backend, occt-native.ts, which
//       takes both; the medium profile, measures): failures, faces by id (present in one only, triangles, failed,
//       OCCT's measured area and validity, mesh area, the mesh's mean normal against the other's: inverted), wireframe
//       curves by id (points), loose points by id and position, the native route's warnings, and time;
//   (b) OCCT's points on every face's surface and every edge's curve at the same parameters, unhealed, from both
//       routes' shapes (tess-occt's probe, build-probe.sh, skipped unbuilt: the written part read without shape
//       processing, the model built by the builder), apart by bucket relative to the part's size, over 1e-9 listed.
//       The parameters are the STEP route's (each face's box from its vertices, each edge's range); the builder takes
//       OCCT's parameterizations, so equal geometry gives equal points.
// (a) differing with (b) the same points to the builder's topology or tolerances, or to healing; (b) differing to its
// geometry. Planted bugs in the native route's model only, in about one part in 10 (by a hash of its file and id):
// PLANT=angle converts the part's cones' semi-angles twice (their faces must show in (a) and (b)); PLANT=nudge moves
// the part's first elementary surface along its axis by 1e-7 of the part's size (its faces must show in (b));
// PLANT=sense turns over the part's first face (it must show in (a), as inverted, unless healing turns it back to
// agree with its closed shell). Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
// Usage: node --max-old-space-size=12000 corpus_checks/native_route.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import path from 'node:path';
import { type BrepData, openBrep, rowCount, SURFACE_KIND } from '../packages/cad-brep/src/index.ts';
import { meshDeflections, type TessellationRequest, type TessellationResult }
  from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { stepPartBytes } from '../packages/step-export/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { runFiles, type FileCheck } from './runner.ts';

const { linearDeflection: LINEAR_MM, angularDeflection: ANGULAR } = meshDeflections({ profile: 'medium' });
const PLANT_EVERY = 10;
const plant = process.env.PLANT;
if (plant && !['angle', 'nudge', 'sense'].includes(plant)) {
  throw new Error(`PLANT=${plant}: expected angle, nudge or sense`);
}
/** (b)'s buckets: the farthest apart of a point's two positions, relative to the part's size. */
const PROBE_BINS = [0, 1e-15, 1e-12, 1e-9, 1e-6, 1e-3, Infinity];

let maxBytes = 1000e6, pool: WorkerTessellator;

// tess-occt's probe (build-probe.sh), if built.
interface ProbeModule { HEAPU8: Uint8Array; HEAPF64: Float64Array; _malloc(n: number): number; _free(p: number): void;
  _occt_probe_read(p: number, n: number, root: number): number; _occt_probe_build(p: number, n: number): number;
  _occt_probe_faces(): number; _occt_probe_num_faces(): number; _occt_probe_edges(): number;
  _occt_probe_num_edges(): number; _occt_probe_diag(): number;
  _occt_probe_eval(q: number, n: number, out: number): void; UTF8ToString(p: number): string }
let probe: ProbeModule | undefined;
const PROBE = path.join(import.meta.dirname, '../packages/tess-occt/dist/occt_probe.mjs');
/** The probe on a written part (root: its representation's id) or a model (root undefined). */
const probeLoad = (bytes: Uint8Array, root?: number) => {
  const m = probe!, ptr = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, ptr);
  const rc = root === undefined ? m._occt_probe_build(ptr, bytes.length) : m._occt_probe_read(ptr, bytes.length, root);
  m._free(ptr);
  const f = m._occt_probe_faces() >> 3, e = m._occt_probe_edges() >> 3;
  return { rc, diag: m.UTF8ToString(m._occt_probe_diag()),
    faces: Array.from(m.HEAPF64.subarray(f, f + 5 * m._occt_probe_num_faces())),
    edges: Array.from(m.HEAPF64.subarray(e, e + 3 * m._occt_probe_num_edges())) };
};
const probeEval = (qs: number[]): number[] => {
  const m = probe!, n = qs.length / 4;
  if (!n) return [];
  const q = m._malloc(qs.length * 8), o = m._malloc(n * 24);
  m.HEAPF64.set(qs, q >> 3);
  m._occt_probe_eval(q, n, o);
  const out = Array.from(m.HEAPF64.subarray(o >> 3, (o >> 3) + 3 * n));
  m._free(q);
  m._free(o);
  return out;
};

const EXAMPLES = 4;
interface Result {
  files: number; parts: number; built: number; facesBoth: number; facesSame: number; curvesBoth: number;
  curvesSame: number; pointParts: number; pointPartsSame: number; timeStep: number; timeNative: number;
  probeParts: number; probePoints: number; probeHist: number[]; probeFarthest: string[];
  tally: Map<string, { n: number; ex: string[] }>;
  /** Faces differing in (a), by file: every one, for classifying. */
  byFile: Map<string, string[]>;
  planted: { parts: number; faces: Set<string>; seenA: Set<string>; seenB: Set<string> };
}
const fresh = (): Result => ({ files: 0, parts: 0, built: 0, facesBoth: 0, facesSame: 0, curvesBoth: 0,
  curvesSame: 0, pointParts: 0, pointPartsSame: 0, timeStep: 0, timeNative: 0, probeParts: 0, probePoints: 0,
  probeHist: PROBE_BINS.map(() => 0), probeFarthest: [], tally: new Map(), byFile: new Map(),
  planted: { parts: 0, faces: new Set(), seenA: new Set(), seenB: new Set() } });

function merge(all: Result, r: Result): void {
  for (const k of ['files', 'parts', 'built', 'facesBoth', 'facesSame', 'curvesBoth', 'curvesSame', 'pointParts',
    'pointPartsSame', 'timeStep', 'timeNative', 'probeParts', 'probePoints'] as const) all[k] += r[k];
  r.probeHist.forEach((n, k) => (all.probeHist[k]! += n));
  all.probeFarthest.push(...r.probeFarthest);
  for (const [k, t] of r.tally) {
    const a = all.tally.get(k) ?? { n: 0, ex: [] };
    a.n += t.n;
    a.ex.push(...t.ex.slice(0, EXAMPLES - a.ex.length));
    all.tally.set(k, a);
  }
  for (const [k, xs] of r.byFile) all.byFile.set(k, [...all.byFile.get(k) ?? [], ...xs]);
  all.planted.parts += r.planted.parts;
  for (const k of ['faces', 'seenA', 'seenB'] as const) for (const x of r.planted[k]) all.planted[k].add(x);
}

/** The native route's model with a bug planted, and the face ids it should show at. */
function plantModel(m: BrepData, pick: boolean): { m: BrepData; faces: number[] } {
  if (!plant || !pick) return { m, faces: [] };
  const c = openBrep(m.buffer.slice(0));
  const surfaces = new Set<number>();
  if (plant === 'sense' && rowCount(c, 'face')) {
    c.face.sameSense[0] = 1 - c.face.sameSense[0]!;
    return { m: c, faces: [c.face.id[0]!] };
  }
  if (plant === 'angle') {
    for (let s = 0; s < rowCount(c, 'surface'); s++) {
      if (c.surface.kind[s] !== SURFACE_KIND.cone) continue;
      c.pool.surfaceReal[c.surface.real[s]! + 10]! *= Math.PI / 180;
      surfaces.add(s);
    }
  } else if (plant === 'nudge') {
    // The first face's elementary surface: its placement's location (reals 0-2) along its axis (3-5).
    const elementary: number[] = [SURFACE_KIND.plane, SURFACE_KIND.cylinder, SURFACE_KIND.cone, SURFACE_KIND.sphere,
      SURFACE_KIND.torus];
    // The part's size from its vertices and its elementary surfaces' locations (curve-bounded faces have no
    // vertices).
    let size = 1;
    for (const x of c.vertex.point) size = Math.max(size, Math.abs(x));
    for (let s = 0; s < rowCount(c, 'surface'); s++) {
      if (!elementary.includes(c.surface.kind[s]!)) continue;
      for (let k = 0; k < 3; k++) size = Math.max(size, Math.abs(c.pool.surfaceReal[c.surface.real[s]! + k]!));
    }
    for (let f = 0; f < rowCount(c, 'face'); f++) {
      const s = c.face.surface[f]!;
      if (s < 0 || !elementary.includes(c.surface.kind[s]!)) continue;
      const r = c.surface.real[s]!, R = c.pool.surfaceReal;
      for (let k = 0; k < 3; k++) R[r + k]! += 1e-7 * size * R[r + 3 + k]!;
      surfaces.add(s);
      break;
    }
  }
  const faces: number[] = [];
  for (let f = 0; f < rowCount(c, 'face'); f++) if (surfaces.has(c.face.surface[f]!)) faces.push(c.face.id[f]!);
  return faces.length ? { m: c, faces } : { m, faces };
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

/** Wireframe curves' points by id. */
function curves(r: TessellationResult): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of r.curves ?? []) m.set(String(c.entityId), (m.get(String(c.entityId)) ?? 0) + c.count);
  return m;
}

/** Loose points as ids and positions (to 1e-4 of the part's unit), sorted. */
function points(r: TessellationResult): string {
  const ids = r.pointIds ?? [], p = r.points ?? new Float32Array();
  return Array.from({ length: ids.length }, (_, k) => `${ids[k]} ${[0, 1, 2].map((c) => p[3 * k + c]!.toFixed(4))
    .join(',')}`).sort().join(';');
}

async function mesh(req: TessellationRequest): Promise<{ r?: TessellationResult; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const r = await pool.tessellate(req);
    const e = r.diagnostics.find((d) => d.severity === 'error');
    return e ? { error: e.message, ms: performance.now() - t0 } : { r, ms: performance.now() - t0 };
  } catch (e) {
    return { error: (e as Error).message, ms: performance.now() - t0 };
  }
}

const norm = (s: string) => s.replace(/#\d+/g, '#').replace(/\d+(\.\d+)?(e[-+]?\d+)?/g, 'N').slice(0, 120);
export const check: FileCheck<undefined, Result> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 1000) * 1e6;
    pool = new WorkerTessellator({ backend: { module: import.meta.resolve('./occt-native.ts'),
      export: 'OcctNativeTessellator' }, workers: meshWorkers });
    await pool.init();
    if (fs.existsSync(PROBE)) {
      probe = await ((await import(PROBE)) as { default: () => Promise<ProbeModule> }).default();
    }
  },
  async file(file) {
    const R = fresh();
    const note = (k: string, ex: string, n = 1) => {
      const t = R.tally.get(k) ?? { n: 0, ex: [] };
      t.n += n;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      R.tally.set(k, t);
    };
    const bytes = fs.readFileSync(file);
    if (bytes.length > maxBytes) return R;
    R.files++;
    const name = shortName(file);
    const { scene } = await importStep(new Uint8Array(bytes));
    for (const part of scene.parts) {
      const m0 = part.brep?.model;
      if (!m0) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      const { m, faces: plantedFaces } = plantModel(m0, plantedPart(where, PLANT_EVERY));
      if (plantedFaces.length) R.planted.parts++;
      for (const f of plantedFaces) R.planted.faces.add(`${where} #${f}`);
      const w = stepPartBytes(m0);
      const native = new Uint8Array(m.buffer);

      // (a) Both meshed.
      const base = { origin: part.origin, linearDeflection: LINEAR_MM / part.unit, angularDeflection: ANGULAR,
        measures: true };
      const a = await mesh({ ...base, format: 'step', data: w.data, rootId: w.rootId });
      const b = await mesh({ ...base, format: 'cad-brep', data: native });
      R.timeStep += a.ms;
      R.timeNative += b.ms;
      if (b.error && !a.error) note(`native route fails: ${norm(b.error)}`, where);
      else if (a.error && !b.error) note(`STEP route fails: ${norm(a.error)}`, where);
      else if (a.error) note(`both fail: STEP route ${norm(a.error)}; native ${norm(b.error!)}`, where);
      if (!b.error) R.built++;
      for (const d of b.r?.diagnostics ?? []) if (d.severity === 'warning') note(`native warning: ${norm(d.message)}`,
        where);
      if (a.r && b.r) {
        const fa = faces(a.r), fb = faces(b.r);
        for (const [id, x] of fa) {
          const y = fb.get(id);
          const at = `${where} face #${id}`;
          const isPlanted = R.planted.faces.has(`${where} #${id}`);
          if (!y) { note('face from the STEP route only', at); continue; }
          R.facesBoth++;
          const kinds: string[] = [];
          if ((x.tris > 0) !== (y.tris > 0)) kinds.push(x.tris > 0 ? 'failed natively only' : 'failed by STEP only');
          if (x.measured !== undefined && y.measured !== undefined
            && Math.abs(x.measured - y.measured) > 1e-6 * Math.max(x.measured, y.measured, 1e-12)) {
            kinds.push('OCCT\'s measured area differs (over 1e-6)');
          }
          if (x.valid !== y.valid) kinds.push(`validity: STEP route ${x.valid}, native ${y.valid}`);
          const la = Math.hypot(...x.n), lb = Math.hypot(...y.n);
          if (la > 1e-3 * x.area && lb > 1e-3 * y.area && x.n[0] * y.n[0] + x.n[1] * y.n[1] + x.n[2] * y.n[2] < 0) {
            kinds.push('inverted');
          }
          if (x.tris !== y.tris) {
            kinds.push(Math.abs(x.area - y.area) > 1e-3 * Math.max(x.area, y.area, 1e-12)
              ? 'triangle counts and mesh areas (over 1e-3) differ'
              : 'triangle counts differ (mesh areas within 1e-3)');
          } else if (Math.abs(x.area - y.area) > 1e-6 * Math.max(x.area, y.area, 1e-12)) {
            kinds.push('mesh areas differ');
          }
          if (!kinds.length) R.facesSame++;
          if (isPlanted && kinds.some((k) => !k.startsWith('triangle counts differ'))) {
            R.planted.seenA.add(`${where} #${id}`);
          }
          for (const k of kinds) if (!isPlanted) note(k, at);
          if (kinds.length && !isPlanted) {
            R.byFile.set(name, [...R.byFile.get(name) ?? [], `#${id} ${kinds.join(', ')}`]);
          }
        }
        for (const id of fb.keys()) if (!fa.has(id)) note('face from the native route only', `${where} face #${id}`);
        const nullA = a.r.faces.filter((f) => f.entityId === null).length;
        const nullB = b.r.faces.filter((f) => f.entityId === null).length;
        if (nullA !== nullB) note('ranges with no face id: counts differ', `${where}: ${nullA}, ${nullB}`);
        const ca = curves(a.r), cb = curves(b.r);
        for (const [id, n] of ca) {
          const n2 = cb.get(id);
          if (n2 === undefined) { note('curve from the STEP route only', `${where} curve #${id}`); continue; }
          R.curvesBoth++;
          if (n2 === n) R.curvesSame++;
          else note('curves with other points', `${where} curve #${id}: ${n}, ${n2}`);
        }
        for (const id of cb.keys()) if (!ca.has(id)) note('curve from the native route only', `${where} curve #${id}`);
        if (a.r.pointIds?.length || b.r.pointIds?.length) {
          R.pointParts++;
          if (points(a.r) === points(b.r)) R.pointPartsSame++;
          else note('loose points differ', `${where}: ${a.r.pointIds?.length ?? 0}, ${b.r.pointIds?.length ?? 0}`);
        }
      }

      // (b) The probe's points at the same parameters.
      if (!probe) continue;
      const pr = probeLoad(w.data, w.rootId);
      if (pr.rc !== 0) { note(`(b) the probe can't read the written part: ${norm(pr.diag)}`, where); continue; }
      const qs: number[] = [];
      for (let k = 0; k < pr.faces.length; k += 5) {
        const [f, u0, u1, v0, v1] = pr.faces.slice(k, k + 5) as number[];
        for (const x of [0.2, 0.5, 0.8]) for (const y of [0.3, 0.7]) {
          qs.push(0, f!, u0! + x * (u1! - u0!), v0! + y * (v1! - v0!));
        }
      }
      for (let k = 0; k < pr.edges.length; k += 3) {
        const [e, t0, t1] = pr.edges.slice(k, k + 3) as number[];
        for (const x of [0.1, 0.5, 0.9]) qs.push(1, e!, t0! + x * (t1! - t0!), 0);
      }
      const pa = probeEval(qs);
      const pn = probeLoad(native);
      if (pn.rc !== 0) continue;
      // What each has that the other hasn't (ids the written file made up aside: they're in the read only).
      const readIds = (xs: number[], step: number, kind: number) => new Set(xs.filter((_, k) => k % step === 0)
        .map((id) => kind * 1e12 + id));
      const ra = new Set([...readIds(pr.faces, 5, 0), ...readIds(pr.edges, 3, 1)]);
      const rb = new Set([...readIds(pn.faces, 5, 0), ...readIds(pn.edges, 3, 1)]);
      const pb = probeEval(qs);
      R.probeParts++;
      let size = 0;
      for (const v of pa) if (Number.isFinite(v)) size = Math.max(size, Math.abs(v));
      let over = 0, worst = 0, worstAt = '', missing = 0;
      for (let k = 0; k < pa.length; k += 3) {
        if (![0, 1, 2].every((c) => Number.isFinite(pa[k + c]!))) continue;
        const kind = qs[(k / 3) * 4]!, id = qs[(k / 3) * 4 + 1]!;
        if (![0, 1, 2].every((c) => Number.isFinite(pb[k + c]!))) {
          if (rb.has(kind * 1e12 + id)) note('(b) a point the native route\'s shape can\'t evaluate', `${where} `
            + `${kind ? 'edge' : 'face'} #${id}`);
          else missing++;
          continue;
        }
        R.probePoints++;
        const rel = Math.hypot(pa[k]! - pb[k]!, pa[k + 1]! - pb[k + 1]!, pa[k + 2]! - pb[k + 2]!) / Math.max(size, 1);
        R.probeHist[PROBE_BINS.findIndex((x) => rel <= x)]!++;
        if (rel > 1e-9) {
          const isPlanted = kind === 0 && R.planted.faces.has(`${where} #${id}`);
          if (isPlanted) { R.planted.seenB.add(`${where} #${id}`); continue; }
          over++;
          if (rel > worst) { worst = rel; worstAt = `${kind ? 'edge' : 'face'} #${id}`; }
        }
      }
      if (worst > 0) R.probeFarthest.push(`${worst.toExponential(1)} ${where} ${worstAt}`);
      if (over) note('(b) points at the same parameters over 1e-9 of the part\'s size apart', `${where}: ${over} `
        + `(the farthest ${worst.toExponential(1)} on ${worstAt})`);
      if (missing) note('(b) faces or edges the STEP route\'s shape has that the native route\'s hasn\'t (points)',
        `${where}: ${missing}`, missing);
      // A curve-bounded face's edges (without vertices in the model) have their segments' ids natively; OCCT's reader
      // binds no shape to a segment.
      const bare = new Set<number>();
      for (let e = 0; e < rowCount(m, 'edge'); e++) if (m.edge.start[e]! < 0) bare.add(1e12 + m.edge.id[e]!);
      let only = 0, boundary = 0;
      for (const x of rb) if (!ra.has(x)) bare.has(x) ? boundary++ : only++;
      if (only) note('(b) faces or edges the native route\'s shape has that the STEP route\'s hasn\'t', where, only);
      if (boundary) note('(b) curve-bounded faces\' edges, by their segments\' ids natively (none read)', where,
        boundary);
    }
    return R;
  },
  teardown() {
    pool.dispose();
  },
};

if (import.meta.main) {
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) {
        const t = all.tally.get('failed') ?? { n: 0, ex: [] };
        t.n++;
        if (t.ex.length < EXAMPLES) t.ex.push(`${shortName(f)}: ${out.error.split('\n')[0]}`);
        all.tally.set('failed', t);
      } else merge(all, out.result);
    });
  const r = all;
  console.log(`${r.files} files, ${r.parts} B-rep parts, ${r.built} built by the native route`);
  console.log(`(a) ${r.facesBoth} faces meshed by both routes, ${r.facesSame} with the same triangles, areas, `
    + `measures, validity and orientation; ${r.curvesBoth} curves, ${r.curvesSame} with the same points; `
    + `${r.pointParts} parts with loose points, ${r.pointPartsSame} the same; meshing `
    + `${(r.timeStep / 1000).toFixed(1)} s by the STEP route, ${(r.timeNative / 1000).toFixed(1)} s natively`);
  if (probe || r.probeParts) {
    const hist = r.probeHist.map((n, k) => `<= ${PROBE_BINS[k] === Infinity ? 'inf' : PROBE_BINS[k]}: ${n}`).join(', ');
    console.log(`(b) OCCT's points at the same parameters: ${r.probeParts} parts, ${r.probePoints} points; apart by `
      + `(relative to the part's size) ${hist}; the farthest ${r.probeFarthest.sort((x, y) => parseFloat(y)
        - parseFloat(x)).slice(0, 5).join('; ') || 'none'}`);
  } else console.log('(b) skipped: the probe isn\'t built (packages/tess-occt/build-probe.sh)');
  if (plant) {
    const { parts, faces: fs_, seenA, seenB } = r.planted;
    console.log(`PLANT=${plant}: ${parts} parts, ${fs_.size} faces planted; seen by (a) at ${seenA.size} faces, by (b) `
      + `at ${seenB.size}, by either at ${[...fs_].filter((x) => seenA.has(x) || seenB.has(x)).length}`);
    console.log(`  not seen by (a): ${[...fs_].filter((x) => !seenA.has(x)).slice(0, 10).join('; ') || 'none'}`);
    console.log(`  not seen by (b): ${[...fs_].filter((x) => !seenB.has(x)).slice(0, 10).join('; ') || 'none'}`);
  }
  for (const [k, v] of [...r.tally].sort((x, y) => y[1].n - x[1].n)) {
    console.log(String(v.n).padStart(8), k, ' e.g.', v.ex.join('; '));
  }
  console.log('\n(a) faces differing, by file:');
  for (const [f, xs] of [...r.byFile].sort((x, y) => y[1].length - x[1].length)) {
    console.log(String(xs.length).padStart(8), f);
    for (const x of xs) console.log('           ', x);
  }
}
