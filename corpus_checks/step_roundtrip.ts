// The STEP exporter's round trip over the corpus (docs/brep-model.md, phase 6): every file imported (A), written by
// step-export (AP242, or SCHEMA=ap214), the file bound against its schema with every value checked, and read back (B);
// then checked in three layers, since a check of the model against itself is blind to what the importer and the
// writer get wrong alike:
//   (1) the scenes: every placed part at the same path with the same names and world transform (within 1e-12 of its
//       largest entry), visibility and every face's colour; the components; each part's model, paired by its source
//       id, the same walk but for last bits and ids renumbered where two parts share one;
//   (2) OCCT, independent of our importer (occt-import-js, its XCAF reader), on the written file: (a) every B-rep
//       vertex of every placed part, moved to world millimetres by the scene's transforms, among OCCT's mesh vertices
//       (to 1e-5 of the model's size), as products_occt.ts checks the importer; (b) each mesh's faces' colours (their
//       own, else the mesh's; linear, as OCCT gives them) the scene's for the part of that name (for a mesh OCCT names
//       otherwise, colours the scene has); (c) OCCT's readings of the two files compared, told apart rather than
//       failed (OCCT reads some files' placements and colours otherwise than step-import: docs/step.md); files up to
//       OCCT_MB (default 30); (d) OCCT's points on every face's surface and every edge's curve at the same parameters
//       from each B-rep part's representation in both files (tess-occt's probe, build-probe.sh: read without shape
//       processing, OCCT's parameterizations applying to both alike), the parameters a grid in each face's box (its
//       vertices projected) and along each edge's range on the original; their distances by bucket, relative to the
//       part's size, those over 1e-9 listed: this is what sees a geometry the importer and the writer get wrong alike
//       on surfaces the area oracle doesn't take (B-splines, sweeps). A face or edge whose geometry's placement has no
//       ref_direction in the original is told apart: OCCT takes its own x axis there, the writer Part 42's
//       (docs/backends.md), so the same geometry starts its parameters elsewhere;
//   (3) the area oracle (area_oracle.ts, step-parser alone) on both files, face by face where both trust it.
// Expected differences are counted apart, not failed: parts without a B-rep in AP214 (no tessellated geometry), what
// the model doesn't keep (faces the importer drops, which their face colours then name), ids renumbered.
// PLANT=move moves a placement 1 mm, PLANT=colour changes a part's colour, PLANT=angle converts cones' semi-angles
// twice, each in about one file in 10 (corpus.ts's plantedPart): each must be seen (by (1) and (2); (1), (2) and (3)
// for angle where there are trusted cones), and the files planted but not seen are listed.
// Usage: node --max-old-space-size=12000 corpus_checks/step_roundtrip.ts [file-list.txt] [max MB, default 1000]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { decode, openBrep, rowCount, SURFACE_KIND, type BrepData } from '../packages/cad-brep/src/index.ts';
import { partInstances, placedName, type Mat4, type Scene } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { exportStep, type StepSchema } from '../packages/step-export/src/index.ts';
import { openModel, parseStep, Reader, type StepModel } from '../packages/step-parser/src/index.ts';
import { differences, walk } from '../packages/step-export/test/compare.ts';
import { AreaOracle, trusted } from './area_oracle.ts';
import { corpusDir, corpusFiles, partSubset, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';

const EXAMPLES = 3;
const plant = process.env.PLANT;
const schema = (process.env.SCHEMA ?? 'ap242') as StepSchema;
const occtMb = Number(process.env.OCCT_MB ?? 30);
let maxMB = 1000;

type Tally = Map<string, { n: number; ex: string[] }>;
const PROBE_BINS = [1e-12, 1e-9, 1e-6, 1e-3, Infinity];
// (probeFarthest: each part's farthest point apart and where, as rows: merged by appending.)
const fresh = () => ({ probeParts: 0, probePoints: 0, probeHist: PROBE_BINS.map(() => 0),
  probeFarthest: [] as string[], files: 0, skipped: 0, placed: 0, same: 0, parts: 0, modelsSame: 0, bytes: 0,
  exportMs: 0,
  occtFiles: 0, occtVertices: 0, occtFound: 0, occtMeshes: 0, occtSame: 0, oracleBoth: 0, oracleAgree: 0, planted: 0,
  plantedSeen: [0, 0, 0], plantedMissed: [] as string[], tally: new Map() as Tally });
type Result = ReturnType<typeof fresh>;

const concat = (cs: Iterable<Uint8Array>) => {
  const all = [...cs];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
};
const norm = (m: string) => m.replace(/#\d+/g, '#').replace(/\d+(\.\d+)?(e-?\d+)?/g, 'N');

/** Each placed part: path, names, world transform, and how it's drawn (visibility, each face's colour in order). */
function placements(s: Scene) {
  const colour = (m: number | undefined) => m === undefined ? '-'
    : `${s.materials[m]!.color.map((c) => c.toFixed(6))}@${s.materials[m]!.opacity.toFixed(6)}`;
  return [...partInstances(s)].map((i) => {
    const p = s.parts[i.part]!;
    const ids = p.brep ? Array.from({ length: rowCount(p.brep.model, 'face') }, (_, k) => decode.face(p.brep!.model,
      k).id) : [...new Set(p.lods[0]?.mesh.faces.map((f) => f.source) ?? [])];
    return { path: i.path.join('/'), names: `${p.name}|${placedName(s, i.ref)}`, transform: Array.from(i.transform),
      look: `${i.visible ? 'shown' : 'hidden'} ${ids.map((f) => colour(i.faceMaterials.get(f ?? NaN) ?? i.material))
        .join(' ')}` };
  });
}

/** sRGB to linear, as occt-import-js gives colours. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Each part's faces' colours as step-import reads them, by part name, and all of them under '*': linear, 3 decimals,
 * sorted, distinct.
 */
function colours(s: Scene): Map<string, string> {
  const out = new Map<string, Set<string>>();
  for (const i of partInstances(s)) {
    const p = s.parts[i.part]!;
    const ids = p.brep ? Array.from({ length: rowCount(p.brep.model, 'face') }, (_, k) => decode.face(p.brep!.model,
      k).id) : [];
    const set = out.get(p.name) ?? new Set<string>();
    for (const f of ids) {
      const m = i.faceMaterials.get(f ?? NaN) ?? i.material;
      set.add(m === undefined ? '-' : s.materials[m]!.color.map((c) => linear(c).toFixed(3)).join(','));
    }
    out.set(p.name, set);
  }
  const every = new Set([...out.values()].flatMap((v) => [...v]));
  return new Map([...[...out].map(([k, v]) => [k, [...v].sort().join(' ')] as const), ['*', [...every].sort()
    .join(' ')]]);
}

/**
 * Whether a face's surface or an edge's curve (through surface curves and trimmed curves) is placed by an
 * AXIS2_PLACEMENT without a ref_direction in the original: OCCT's default x axis differs from Part 42's there.
 */
function defaultRef(model: StepModel, r: Reader, id: number, face: boolean): boolean {
  let q = model.resolve(id);
  if (q < 0) return false;
  q = r.ref(q, face ? 'face_geometry' : 'edge_geometry');
  for (let k = 0; k < 4 && q >= 0; k++) {
    if (r.is(q, 'SURFACE_CURVE')) q = r.ref(q, 'curve_3d');
    else if (r.is(q, 'TRIMMED_CURVE')) q = r.ref(q, 'basis_curve');
    else break;
  }
  if (q < 0) return false;
  const pos = r.is(q, 'CONIC') || r.is(q, 'ELEMENTARY_SURFACE') ? r.ref(q, 'position') : -1;
  return pos >= 0 && r.ref(pos, 'ref_direction') < 0;
}

/** PLANT=angle: a model's cones' semi-angles converted again. */
function angled(m: BrepData): BrepData {
  const c = openBrep(m.buffer.slice(0));
  for (let s = 0; s < rowCount(c, 'surface'); s++) {
    if (c.surface.kind[s] === SURFACE_KIND.cone) c.pool.surfaceReal[c.surface.real[s]! + 10]! *= Math.PI / 180;
  }
  return c;
}

/** The planted bug in the scene to be written, in place; whether there was something to plant it in. */
function planting(s: Scene): boolean {
  if (plant === 'move') {
    const t: Mat4 | undefined = s.components[s.roots[0]?.component ?? -1]?.children[0]?.transform
      ?? s.components.find((c) => c.parts.length)?.parts[0]?.transform ?? s.rootParts?.[0]?.transform;
    if (!t) return false;
    t[12]! += 1;
    return true;
  }
  if (plant === 'colour') {
    const p = s.parts.find((q) => q.material !== undefined);
    if (!p) return false;
    s.materials.push({ color: [0.123, 0.456, 0.789], opacity: 1, sources: [] });
    p.material = s.materials.length - 1;
    return true;
  }
  if (plant === 'angle') {
    let any = false;
    for (const p of s.parts) {
      if (!p.brep) continue;
      const m = p.brep.model;
      if (![...Array(rowCount(m, 'surface')).keys()].some((k) => m.surface.kind[k] === SURFACE_KIND.cone)) continue;
      p.brep = { ...p.brep, model: angled(m) };
      any = true;
    }
    return any;
  }
  return false;
}

// occt-import-js, loaded once per process (again after a WebAssembly exception: its state is suspect then).
const require = createRequire(import.meta.url);
let occt: { ReadStepFile(b: Uint8Array, o: unknown): OcctResult } | undefined;
const loadOcct = async () => (occt = await require(path.join(corpusDir, 'occt-import-js/dist/occt-import-js.js'))());
interface OcctMesh { name: string; color?: number[]; brep_faces: { first: number; last: number; color?: number[] }[];
  attributes: { position: { array: number[] } }; index: { array: number[] } }
interface OcctResult { success: boolean; meshes: OcctMesh[] }

// tess-occt's probe (build-probe.sh), if built: OCCT's points on a representation's faces and edges.
interface ProbeModule { HEAPU8: Uint8Array; HEAPF64: Float64Array; _malloc(n: number): number; _free(p: number): void;
  _occt_probe_read(p: number, n: number, root: number): number; _occt_probe_faces(): number;
  _occt_probe_num_faces(): number; _occt_probe_edges(): number; _occt_probe_num_edges(): number;
  _occt_probe_diag(): number; _occt_probe_eval(q: number, n: number, out: number): void;
  UTF8ToString(p: number): string }
let probe: ProbeModule | undefined;
const PROBE = path.join(import.meta.dirname, '../packages/tess-occt/dist/occt_probe.mjs');
const loadProbe = async () => {
  if (fs.existsSync(PROBE)) probe = await ((await import(PROBE)) as { default: () => Promise<ProbeModule> }).default();
};
const probeRead = (bytes: Uint8Array, root: number) => {
  const m = probe!, ptr = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, ptr);
  const rc = m._occt_probe_read(ptr, bytes.length, root);
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
const readOcct = async (bytes: Uint8Array): Promise<OcctResult> => {
  try {
    return occt!.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001 });
  } catch {
    await loadOcct();
    return { success: false, meshes: [] };
  }
};

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    await loadOcct();
    await loadProbe();
  },
  async file(file) {
    const R = fresh();
    const note = (k: string, ex: string) => {
      const t = R.tally.get(k) ?? { n: 0, ex: [] };
      t.n++;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      R.tally.set(k, t);
    };
    const bytes = new Uint8Array(fs.readFileSync(file));
    if (bytes.length > maxMB * 1e6) { R.skipped++; return R; }
    R.files++;
    const name = shortName(file);
    const { scene: a, model: modelA } = await importStep(bytes);
    const before = placements(a), ours = colours(a);
    const models = new Map(a.parts.flatMap((p) => p.brep ? [[p.sources[0]?.id, p.brep.model] as const] : []));
    const planted = plant !== undefined && plantedPart(name) && planting(a);
    if (planted) R.planted++;
    const seen = [false, false, false];

    const t0 = performance.now();
    const x = exportStep(a, { schema });
    const written = concat(x.chunks);
    R.exportMs += performance.now() - t0;
    R.bytes += written.length;
    for (const d of x.diagnostics) note(`export ${d.severity}: ${norm(d.message)}`, name);
    const bound = await openModel(parseStep(written));
    for (const d of bound.diagnostics) note(`bind: ${norm(d.message)}`, name);
    for (let p = 0; p < bound.file.count; p++) for (const d of bound.bind(p, { check: true }).diagnostics) {
      note(`bind ${d.severity}: ${norm(d.message)}`, `${name} #${bound.file.index.ids[p]}`);
    }
    const { scene: b, model: modelB } = await importStep(written);
    for (const d of b.diagnostics) if (d.severity !== 'info') note(`read back ${d.severity}: ${norm(d.message)}`, name);

    // (1) The scenes.
    const after = placements(b);
    R.placed += before.length;
    const fail1 = (k: string, ex: string) => { if (planted) seen[0] = true; else note(`(1) ${k}`, ex); };
    if (after.length !== before.length) {
      fail1('placed part counts differ', `${name}: ${before.length}, ${after.length}`);
    }
    for (let k = 0; k < Math.min(before.length, after.length); k++) {
      const p = before[k]!, q = after[k]!;
      const scale = Math.max(1, ...p.transform.map(Math.abs));
      const dt = Math.max(...p.transform.map((v, j) => Math.abs(v - q.transform[j]!))) / scale;
      if (p.path !== q.path) fail1('paths differ', `${name} ${p.path} against ${q.path}`);
      else if (p.names !== q.names) fail1('names differ', `${name} ${p.names} against ${q.names}`);
      else if (!(dt <= 1e-12)) fail1('world transforms differ', `${name} ${p.path} by ${dt.toExponential(1)}`);
      else if (p.look !== q.look) fail1('visibility or face colours differ', `${name} ${p.path} ${p.names}`);
      else R.same++;
    }
    if (a.components.length !== b.components.length) fail1('component counts differ', name);
    else if (a.components.some((c, i) => c.name !== b.components[i]!.name)) fail1('components differ', name);
    const byId = new Map(b.parts.map((q) => [q.sources[0]?.id, q]));
    for (const [id, m] of models) {
      R.parts++;
      const q = byId.get(id)?.brep?.model;
      if (!q) { fail1('a part not read back by its id', `${name} #${id}`); continue; }
      const d = differences(walk(m), walk(q)).filter((y) => !y.bits);
      const ids = d.filter((y) => /\.id$/.test(y.path));
      if (d.length === ids.length) R.modelsSame++;
      if (ids.length && ids.length === d.length) note('(1) model the same but for ids renumbered (shared with another '
        + 'part)', `${name} #${id}`);
      else if (d.length) fail1('models differ', `${name} #${id}: ${d.find((y) => !/\.id$/.test(y.path))!.path}`);
    }

    // (2) OCCT: the written file as our scene has it (vertices placed, colours); its two readings compared.
    if (bytes.length <= occtMb * 1e6) {
      const [oa, ob] = [await readOcct(bytes), await readOcct(written)];
      const fail2 = (k: string, ex: string) => { if (planted) seen[1] = true; else note(`(2) ${k}`, ex); };
      if (!ob.success) {
        // (occt-import-js's OCCT reads no tessellated geometry: a file of it alone fails, one with more besides is read
        // with no meshes.)
        if (oa.success && oa.meshes.length) fail2('OCCT reads the original only', name);
        else note(`(2c) OCCT reads no geometry from either file${oa.success ? ' (it fails on the written one)' : ''}`,
          name);
      } else {
        R.occtFiles++;
        const box = (m: OcctMesh) => {
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          const q = m.attributes.position.array;
          for (let i = 0; i < q.length; i += 3) for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, q[i + k]!); hi[k] = Math.max(hi[k]!, q[i + k]!);
          }
          return [...lo, ...hi];
        };
        const boxes = ob.meshes.map(box).filter((x) => x[0]! <= x[3]!);
        const size = boxes.length ? Math.max(...[0, 1, 2].map((k) => Math.max(...boxes.map((x) => x[k + 3]!))
          - Math.min(...boxes.map((x) => x[k]!)))) : 1;
        // (2a) Our placed parts' B-rep vertices, in world millimetres by our transforms, among OCCT's mesh vertices
        // of the written file (they include the B-rep vertices), on a grid of a few times the tolerance.
        // A vertex missing there but found in OCCT's reading of the original is the writer's; missing from both,
        // OCCT's (its healing drops some vertices of broken files).
        const tol = 1e-5 * Math.max(size, 1), cell = 4 * tol;
        const finder = (meshes: OcctMesh[]) => {
          const grid = new Map<string, number[]>();
          for (const m of meshes) {
            const q = m.attributes.position.array;
            for (let i = 0; i < q.length; i += 3) {
              const key = `${Math.floor(q[i]! / cell)},${Math.floor(q[i + 1]! / cell)},${Math.floor(q[i + 2]! / cell)}`;
              const list = grid.get(key);
              if (list) list.push(q[i]!, q[i + 1]!, q[i + 2]!); else grid.set(key, [q[i]!, q[i + 1]!, q[i + 2]!]);
            }
          }
          return (x: number, y: number, z: number) => {
            const [i, j, k] = [x, y, z].map((c) => Math.floor(c / cell));
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
              const list = grid.get(`${i! + di},${j! + dj},${k! + dk}`) ?? [];
              for (let n = 0; n < list.length; n += 3) {
                if (Math.hypot(list[n]! - x, list[n + 1]! - y, list[n + 2]! - z) <= tol) return true;
              }
            }
            return false;
          };
        };
        const found = finder(ob.meshes), foundBefore = oa.success ? finder(oa.meshes) : () => false;
        for (const inst of partInstances(a)) {
          const m = a.parts[inst.part]!.brep?.model, t = inst.transform;
          if (!m) continue;
          let missing = 0, missingBoth = 0;
          for (let v = 0; v < rowCount(m, 'vertex'); v++) {
            const [x, y, z] = decode.vertex(m, v).point;
            if (!Number.isFinite(x)) continue;
            R.occtVertices++;
            const w = [0, 1, 2].map((k) => t[k]! * x! + t[4 + k]! * y! + t[8 + k]! * z! + t[12 + k]!);
            if (found(w[0]!, w[1]!, w[2]!)) R.occtFound++;
            else if (foundBefore(w[0]!, w[1]!, w[2]!)) missing++;
            else missingBoth++;
          }
          const where = `${name} ${inst.path.join('/')} ${a.parts[inst.part]!.name}`;
          if (missing) fail2(`placed vertices not among OCCT's${inst.visible ? '' : ' (a hidden placement)'}, but `
            + 'among its of the original', `${where}: ${missing}`);
          if (missingBoth && !planted) note('(2c) placed vertices among OCCT\'s of neither file', `${where}: `
            + `${missingBoth}`);
          else if (missingBoth) seen[1] = true;
        }
        // OCCT's two readings, their meshes paired by name, nearest boxes first (they come in the products' order).
        const distinct = (o: OcctMesh) => [...new Set(o.brep_faces.map((f) => (f.color ?? o.color)?.map((v) =>
          v.toFixed(3)).join(',') ?? '-'))].sort().join(' ');
        const partner = new Map<number, number>(); // written file's mesh -> the original's
        let moved = false;
        if (oa.success) {
          const ba = oa.meshes.map(box), bb = ob.meshes.map(box);
          const pairs: [number, number, number][] = [];
          oa.meshes.forEach((m, i) => ob.meshes.forEach((n, j) => {
            if (n.name === m.name) pairs.push([Math.max(...ba[i]!.map((v, k) => Math.abs(v - bb[j]![k]!))), i, j]);
          }));
          pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
          const usedA = new Set<number>();
          for (const [d, i, j] of pairs) {
            if (usedA.has(i) || partner.has(j)) continue;
            usedA.add(i);
            partner.set(j, i);
            // (Meshes with no points have no box: alike.)
            if (d > 1e-6 * Math.max(size, 1) && Number.isFinite(d)) moved = true;
          }
          if (oa.meshes.length !== ob.meshes.length || usedA.size < oa.meshes.length) moved = true;
        }
        // (2b) Each mesh's faces' colours as our scene colours its part's faces; where not, by the original's reading:
        // agreeing with ours, the writer's fault; with the written file's, OCCT reads both otherwise than step-import.
        const ourColours = (m: OcctMesh) => {
          const mine = ours.get(m.name);
          return mine !== undefined ? mine === distinct(m)
            : distinct(m).split(' ').every((c) => ours.get('*')!.split(' ').includes(c));
        };
        ob.meshes.forEach((m, j) => {
          if (!m.brep_faces.length) return;
          R.occtMeshes++;
          if (ourColours(m)) { R.occtSame++; return; }
          const i = partner.get(j), o = i === undefined ? undefined : oa.meshes[i]!;
          // (occt-import-js gives some parts' faces no colours of their own in either file, though both style them:
          // the mesh's colour only, or none.)
          const faceless = (x: OcctMesh) => x.brep_faces.every((f) => !f.color);
          const known = distinct(m).split(' ').every((c) => c === '-' || ours.get('*')!.split(' ').includes(c));
          if (o && faceless(o) && faceless(m) && known) {
            if (!planted) note('(2c) faces OCCT gives no colours of their own in either file', `${name} ${m.name}`);
            else seen[1] = true;
          } else if (o && !ourColours(o) && distinct(o) === distinct(m)) {
            if (!planted) note('(2c) colours OCCT reads in both files otherwise than step-import', `${name} ${m.name}`);
            else seen[1] = true;
          } else fail2('face colours not our scene\'s', `${name} ${m.name}: ${distinct(m)} against `
            + `${ours.get(m.name) ?? 'the scene'}`);
        });
        // (2c) OCCT's readings of the two files: told apart rather than failed (OCCT reads some files' placements and
        // colours otherwise than step-import: docs/step.md), but for a planted bug.
        if (oa.success && moved) {
          if (planted) seen[1] = true;
          else note('(2c) OCCT\'s two readings place meshes otherwise (it reads the original otherwise than '
            + 'step-import; the vertices above are where the scene places them)', name);
        }
      }
    }

    // (2d) OCCT's points at the same parameters, part by part.
    if (probe) {
      const readerA = new Reader(modelA);
      const fail = (k: string, ex: string) => { if (planted) seen[1] = true; else note(`(2d) ${k}`, ex); };
      for (const part of a.parts) {
        const id = part.sources[0]?.id;
        if (!part.brep || id === undefined || !models.has(id)) continue;
        const ra = probeRead(partSubset(modelA, id), id);
        if (ra.rc !== 0) {
          note(`(2d) the probe can't read the original's part: ${ra.diag}`, `${name} #${id}`);
          continue;
        }
        const qs: number[] = [];
        for (let k = 0; k < ra.faces.length; k += 5) {
          const [f, u0, u1, v0, v1] = ra.faces.slice(k, k + 5) as number[];
          for (const x of [0.2, 0.5, 0.8]) for (const y of [0.3, 0.7]) {
            qs.push(0, f!, u0! + x * (u1! - u0!), v0! + y * (v1! - v0!));
          }
        }
        for (let k = 0; k < ra.edges.length; k += 3) {
          const [e, t0, t1] = ra.edges.slice(k, k + 3) as number[];
          for (const x of [0.1, 0.5, 0.9]) qs.push(1, e!, t0! + x * (t1! - t0!), 0);
        }
        const pa = probeEval(qs);
        const rb = probeRead(partSubset(modelB, id), id);
        if (rb.rc !== 0) { fail(`the probe can't read the written part: ${rb.diag}`, `${name} #${id}`); continue; }
        const pb = probeEval(qs);
        R.probeParts++;
        let size = 0;
        for (const v of pa) if (Number.isFinite(v)) size = Math.max(size, Math.abs(v));
        let over = 0, worst = 0, worstAt = '', defaulted = 0, renumbered = 0;
        for (let k = 0; k < pa.length; k += 3) {
          if (!Number.isFinite(pa[k]!) || !Number.isFinite(pa[k + 1]!) || !Number.isFinite(pa[k + 2]!)) continue;
          // (None in the written part under that id: renumbered, its id another part's: (1) says which.)
          if (!Number.isFinite(pb[k]!)) { renumbered++; continue; }
          R.probePoints++;
          const d = Math.hypot(pa[k]! - pb[k]!, pa[k + 1]! - pb[k + 1]!, pa[k + 2]! - pb[k + 2]!) / Math.max(size, 1);
          const rel = Number.isNaN(d) ? Infinity : d;
          R.probeHist[PROBE_BINS.findIndex((x) => rel <= x)]!++;
          if (rel > 1e-9 && defaultRef(modelA, readerA, qs[(k / 3) * 4 + 1]!, qs[(k / 3) * 4] === 0)) {
            defaulted++;
            continue;
          }
          if (rel > 1e-9) over++;
          if (rel > worst) {
            worst = rel;
            worstAt = `${qs[(k / 3) * 4] === 0 ? 'face' : 'edge'} #${qs[(k / 3) * 4 + 1]}`;
          }
        }
        if (!planted && worst > 0) R.probeFarthest.push(`${worst.toExponential(1)} ${name} #${id} ${worstAt}`);
        if (over) fail('points at the same parameters over 1e-9 of the part\'s size apart', `${name} #${id}: ${over} `
          + `(the farthest ${worst.toExponential(1)} on ${worstAt})`);
        if (renumbered && !planted) note('(2d) faces or edges the written part has under other ids', `${name} #${id}: `
          + `${renumbered} points`);
        if (defaulted && !planted) note('(2d) points apart on geometry placed without a ref_direction (OCCT\'s x axis '
          + 'there, Part 42\'s written)', `${name} #${id}: ${defaulted}`);
      }
    }

    // (3) The area oracle on both files.
    const oracleA = new AreaOracle(parseStep(bytes)), oracleB = new AreaOracle(parseStep(written));
    for (const [, m] of models) for (let f = 0; f < rowCount(m, 'face'); f++) {
      const id = m.face.id[f]!;
      if (Number.isNaN(id)) continue;
      const p = oracleA.faceArea(id), q = oracleB.faceArea(id);
      if (!trusted(p)) continue;
      if (!trusted(q)) {
        if (planted) seen[2] = true;
        else note(`(3) trusted on the original only: ${q.ok ? q.flags.join(', ') || 'error' : norm(q.reason)}`,
          `${name} #${id}`);
        continue;
      }
      R.oracleBoth++;
      if (Math.abs(p.area - q.area) <= 1e-7 * p.area + p.error + q.error) R.oracleAgree++;
      else if (planted) seen[2] = true;
      else note('(3) areas differ', `${name} #${id}: ${p.area}, ${q.area}`);
    }

    if (planted) {
      seen.forEach((s, k) => { if (s) R.plantedSeen[k]!++; });
      if (!seen[0] || !seen[1]) R.plantedMissed.push(`${name} (${['(1)', '(2)', '(3)'].filter((_, k) => !seen[k])
        .join(' ')} not seeing it)`);
    }
    return R;
  },
};

if (import.meta.main) {
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  const t = performance.now();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) {
        all.tally.set(`threw: ${out.error.split('\n')[0]}`, { n: 1, ex: [shortName(f)] });
      } else addInto(all, out.result);
    });
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  console.log(`${all.files} files (${all.skipped} over ${maxMB} MB skipped), ${schema}, `
    + `${s(performance.now() - t)}; `
    + `written ${(all.bytes / 1e6).toFixed(1)} MB in ${s(all.exportMs)}`);
  console.log(`(1) ${all.placed} placed parts, ${all.same} the same (path, names, world transform, visibility, every `
    + `face's colour); ${all.parts} models, ${all.modelsSame} the same but for last bits and renumbered ids`);
  console.log(`(2) OCCT on ${all.occtFiles} written files (up to ${occtMb} MB): `
    + `${all.occtFound} of ${all.occtVertices} `
    + `placed B-rep vertices among its meshes'; ${all.occtSame} of ${all.occtMeshes} meshes coloured as the scene`);
  const hist = all.probeHist.map((n, k) => `<= ${PROBE_BINS[k] === Infinity ? 'inf'
    : PROBE_BINS[k]!.toExponential(0)}: ${n}`).join(', ');
  console.log(`(2d) OCCT's points at the same parameters: ${all.probeParts} parts, ${all.probePoints} points; apart by `
    + `(relative to the part's size) ${hist}; the farthest ${all.probeFarthest.sort((x, y) => parseFloat(y)
      - parseFloat(x))[0] ?? 'none'}`);
  console.log(`(3) the area oracle: ${all.oracleBoth} faces trusted on both files, ${all.oracleAgree} agreeing`);
  if (plant) {
    console.log(`PLANT=${plant}: ${all.planted} files planted, seen by (1) in ${all.plantedSeen[0]}, (2) in `
      + `${all.plantedSeen[1]}, (3) in ${all.plantedSeen[2]}`);
    for (const m of all.plantedMissed) console.log(`  missed: ${m}`);
  }
  for (const [k, v] of [...all.tally].sort((x, y) => y[1].n - x[1].n || (x[0] < y[0] ? -1 : 1))) {
    console.log(String(v.n).padStart(8), k, ' e.g.', v.ex.join('; '));
  }
}
