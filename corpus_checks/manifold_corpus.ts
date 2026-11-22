// Whether each backend's meshes are fit for mesh booleans (Manifold) and slicers: every B-rep part's model through
// our own tessellator (tess-cadio), OCCT (its native route) and SMLib, each in a tess-workers pool at the medium
// profile (PROFILE), healing off, each by cad-scene's tessellateScene with its defaults (the meshes as consumers get
// them: joined, filled, oriented, degenerate triangles dropped; measures not asked, which changes no mesh), each alone
// (no fallback). Per part and backend, its mesh welded at exactly equal positions (float32 minus the part's origin,
// as the scene holds them), then per closed shell of the model (cad-brep's SHELL_KIND closed:
// every edge its faces bound used twice, once each way), that shell's faces' triangles:
//   - an oriented 2-manifold: every edge used exactly twice, once each way; its defects counted as edges used once
//     (open), twice the same way (a face or triangle wound against its neighbours), more than twice; triangles with two
//     corners welded together (degenerate, left out of the rest); vertices whose triangles aren't one fan closed
//     around them;
//   - self-intersection, sampled: up to SAMPLE triangles of the shell (every k-th, from its first), each against every
//     triangle of the shell whose box overlaps its own and that shares no welded vertex with it, by a triangle-triangle
//     interval test in double; a crossing counted only where the interiors cross by more than 1e-9 of the triangle's
//     size (touching and coplanar pairs aren't), so a crossing between triangles the sample misses goes unseen.
// A part with a face its backend gave no triangles is open by design: counted apart, not checked; a part without a
// closed shell (sheets, wires) too. Ours's parts that aren't manifold are listed in full, each with the faces whose
// triangles hold most of its defects; the other backends' worst, and every backend's worst crossing rates.
// Usage: node corpus_checks/manifold_corpus.ts [list[,list...]] [max MB, default 1000]   (progress on standard error)
//   lists: comma-separated, each reported apart, then together (default test_corpus/files.txt and
//          test_corpus/models.txt, the user's models)
//   RAW=1       the backends' own results (Tessellator.tessellate) in place of tessellateScene's meshes, for
//               debugging a backend
//   WORKERS=<n> workers per backend in each process (default: a third of the process's share, runner.ts)
//   SAMPLE=<n>  triangles tested for crossing per closed shell (default 4000)
//   CPU_MS=<ms> ours's limit per part in its worker thread's CPU time (default 120000, 4 x it in wall time the
//               backstop); TIMEOUT_MS=<ms> OCCT's and SMLib's in wall time (default 600000)
//   IDLE_MS=<ms> runner.ts's watchdog on a child silent on one file (default here 0, none: every request has its
//               backend's limit, and one large part can take longer than any fixed watchdog in OCCT or SMLib)
//   PLANT=<bug> a bug planted in ours's mesh of about one checkable part in 10 (a part ours meshes whole with a closed
//               shell), each planted part checked for the verdict it must get, the missed ones listed: flip (the
//               shell's first triangle's winding reversed: not manifold, an edge twice the same way), drop (that
//               triangle left out: not manifold, an edge open), cross (a small triangle added through the middle of
//               that triangle, across its plane, its corners new points: crossing)
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Mesh, TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { MESH_PROFILES, tessellateScene } from '../packages/cad-scene/src/index.ts';
import type { BrepData } from '../packages/cad-brep/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, plantedPart, repoDir, shortName } from './corpus.ts';
import { addInto, division, initAll, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

const PROFILE = (process.env.PROFILE ?? 'medium') as keyof typeof MESH_PROFILES;
if (!MESH_PROFILES[PROFILE]) throw new Error(`PROFILE=${PROFILE}: one of ${Object.keys(MESH_PROFILES).join(', ')}`);
const { linearDeflection: LIN, angularDeflection: ANG } = MESH_PROFILES[PROFILE];
const SAMPLE = Number(process.env.SAMPLE ?? 4000);
const CPU_MS = Number(process.env.CPU_MS ?? 120_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 600_000);
const RAW = process.env.RAW === '1';
const PLANT = process.env.PLANT ?? '';
const PLANTS = ['flip', 'drop', 'cross'];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PLANT=${PLANT}: one of ${PLANTS.join(', ')}`);
const DEFAULT_LISTS = ['test_corpus/files.txt', 'test_corpus/models.txt'];
/** cad-brep's SHELL_KIND.closed. */
const CLOSED = 1;
/** Parts listed per backend for the worst defects and crossing rates. */
const WORST = 12;

const BACKENDS = ['cadio', 'occt', 'smlib'] as const;
type Backend = typeof BACKENDS[number];
const LABEL: Record<Backend, string> = { cadio: 'ours', occt: 'OCCT', smlib: 'SMLib' };
const PKG: Record<Backend, string> = { cadio: 'tess-cadio', occt: 'tess-occt', smlib: 'tess-smlib' };

/** A part's mesh's defects over its closed shells. */
interface Defects {
  shells: number;
  triangles: number;
  open: number;
  sameWay: number;
  moreThanTwice: number;
  degenerate: number;
  vertices: number;
  tested: number;
  crossing: number;
}
const DEFECTS = ['open', 'sameWay', 'moreThanTwice', 'degenerate', 'vertices'] as const;
const DEFECT_LABEL: Record<typeof DEFECTS[number], string> = { open: 'edges used once',
  sameWay: 'edges used twice the same way', moreThanTwice: 'edges used more than twice',
  degenerate: 'degenerate triangles', vertices: 'non-manifold vertices' };
const manifold = (c: Defects) => DEFECTS.every((k) => c[k] === 0);

interface PerBackend {
  /** Parts: meshed (a result), failed whole (thrown, timed out), with a face without triangles, without a closed
   * shell. */
  /** Parts whose model has no faces (curves or points only): nothing to mesh. */
  noFaces: number;
  meshed: number;
  failedWhole: number;
  /** Parts failed whole by why (the error, its numbers as N). */
  whyWhole: Record<string, number>;
  withFailed: number;
  noClosedShell: number;
  checked: number;
  manifold: number;
  crossing: number;
  fit: number;
  /** Parts with each defect, and their total counts. */
  partsWith: Record<string, number>;
  totals: Record<string, number>;
  /** Not manifold, crossing: "where\tdefects or rate\t...". */
  bad: { where: string; score: number; line: string }[];
  crossers: { where: string; rate: number; line: string }[];
}
const freshBackend = (): PerBackend => ({ noFaces: 0, meshed: 0, failedWhole: 0, whyWhole: {}, withFailed: 0,
  noClosedShell: 0, checked: 0,
  manifold: 0, crossing: 0, fit: 0, partsWith: {}, totals: {}, bad: [], crossers: [] });
function fresh() {
  return { files: 0, skippedBig: 0, failedFiles: 0, parts: 0,
    by: Object.fromEntries(BACKENDS.map((b) => [b, freshBackend()])) as Record<Backend, PerBackend>,
    planted: 0, plantedCaught: 0, plantedMissed: [] as string[] };
}
type Tallies = ReturnType<typeof fresh>;

type V3 = [number, number, number];
const sub = (a: V3, c: V3): V3 => [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
const cross = (a: V3, c: V3): V3 => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
const dot = (a: V3, c: V3) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];

/**
 * Whether triangles p and q cross: their interiors meeting along a segment of positive length, by Moller's test (each
 * triangle's corners' signed distances from the other's plane, then their intervals on the planes' line), with eps
 * the distance within which a corner counts as on a plane. Touching (a corner or edge on the other within eps,
 * coplanar pairs, intervals meeting at a point) isn't crossing.
 */
export function trianglesCross(p: V3[], q: V3[], eps: number): boolean {
  const distances = (t: V3[], o: V3[]) => {
    const n = cross(sub(t[1]!, t[0]!), sub(t[2]!, t[0]!));
    const ln = Math.hypot(...n);
    return ln > 0 ? o.map((x) => dot(n, sub(x, t[0]!)) / ln) : null;
  };
  const dq = distances(p, q), dp = distances(q, p);
  if (!dq || !dp) return false;
  const sign = (ds: number[]) => ds.map((x) => (x > eps ? 1 : x < -eps ? -1 : 0));
  const sq = sign(dq), sp = sign(dp);
  // (Either all on one side, or within eps of the plane: apart, or coplanar, or touching.)
  for (const s of [sq, sp]) if (s.every((x) => x >= 0) || s.every((x) => x <= 0)) return false;
  const D = cross(cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!)), cross(sub(q[1]!, q[0]!), sub(q[2]!, q[0]!)));
  const interval = (t: V3[], ds: number[], s: number[]) => {
    const pr = t.map((x) => dot(D, x));
    const at: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (s[i]! * s[j]! < 0) at.push(pr[i]! + (pr[j]! - pr[i]!) * (ds[i]! / (ds[i]! - ds[j]!)));
      else if (s[i] === 0) at.push(pr[i]!);
    }
    return [Math.min(...at), Math.max(...at)];
  };
  const ip = interval(p, dp, sp), iq = interval(q, dq, sq);
  const overlap = Math.min(ip[1]!, iq[1]!) - Math.max(ip[0]!, iq[0]!);
  return overlap > eps * Math.hypot(...D);
}

/**
 * The defects of a mesh's closed shells: `shells` each a list of triangles as welded vertex triples, `at` the welded
 * vertices' positions; `faceOf` each triangle's face (parallel to the shells' lists), for naming the faces that hold
 * most edge defects in `byFace`.
 */
export function shellDefects(shells: [number, number, number][][], at: V3[], faceOf: number[][],
  byFace?: Map<number, number>, sample = SAMPLE): Defects {
  const c: Defects = { shells: shells.length, triangles: 0, open: 0, sameWay: 0, moreThanTwice: 0, degenerate: 0,
    vertices: 0, tested: 0, crossing: 0 };
  shells.forEach((tris, s) => {
    c.triangles += tris.length;
    const good: [number, number, number][] = [];
    const goodFace: number[] = [];
    // Directed edges: "a,b" -> the faces of the triangles using it that way.
    const dir = new Map<string, number[]>();
    tris.forEach((t, k) => {
      if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) { c.degenerate++; return; }
      good.push(t);
      goodFace.push(faceOf[s]![k]!);
      for (let i = 0; i < 3; i++) {
        const key = `${t[i]},${t[(i + 1) % 3]}`;
        const fs2 = dir.get(key);
        if (fs2) fs2.push(faceOf[s]![k]!);
        else dir.set(key, [faceOf[s]![k]!]);
      }
    });
    for (const [key, fs2] of dir) {
      const [a, b] = key.split(',');
      const back = dir.get(`${b},${a}`) ?? [];
      // (Each undirected edge once: from its smaller-keyed direction, or the only one.)
      if (back.length && `${b},${a}` < key) continue;
      const n = fs2.length + back.length;
      if (fs2.length === 1 && back.length === 1) continue;
      if (n === 1) c.open++;
      else if (n === 2) c.sameWay++;
      else c.moreThanTwice++;
      if (byFace) for (const f of [...fs2, ...back]) byFace.set(f, (byFace.get(f) ?? 0) + 1);
    }
    // Vertices: each one's triangles' opposite edges chained into one closed cycle.
    const link = new Map<number, Map<number, number>>();
    const badLink = new Set<number>();
    for (const t of good)
      for (let i = 0; i < 3; i++) {
        const v = t[i]!, a = t[(i + 1) % 3]!, b = t[(i + 2) % 3]!;
        const m = link.get(v) ?? link.set(v, new Map()).get(v)!;
        if (m.has(a)) badLink.add(v);
        m.set(a, b);
      }
    for (const [v, m] of link) {
      if (badLink.has(v)) continue;
      const first = m.keys().next().value!;
      let w = first, n = 0;
      do { w = m.get(w)!; n++; } while (w !== undefined && w !== first && n <= m.size);
      if (w !== first || n !== m.size) badLink.add(v);
    }
    c.vertices += badLink.size;
    // Sampled self-intersection: a uniform grid over the shell's box, each triangle in the cells its box overlaps
    // (one overlapping too many cells kept in a list every sample meets).
    if (!good.length) return;
    const boxes = good.map((t) => {
      const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (const v of t)
        for (let j = 0; j < 3; j++) lo[j] = Math.min(lo[j]!, at[v]![j]!), hi[j] = Math.max(hi[j]!, at[v]![j]!);
      return [lo, hi] as [V3, V3];
    });
    const glo: V3 = [Infinity, Infinity, Infinity], ghi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const [lo, hi] of boxes)
      for (let j = 0; j < 3; j++) glo[j] = Math.min(glo[j]!, lo[j]!), ghi[j] = Math.max(ghi[j]!, hi[j]!);
    const cell = (Math.max(ghi[0] - glo[0], ghi[1] - glo[1], ghi[2] - glo[2]) || 1)
      / Math.max(1, 2 * Math.cbrt(good.length));
    const cellsOf = (lo: V3, hi: V3) => {
      const r0 = lo.map((x, j) => Math.floor((x - glo[j]!) / cell));
      const r1 = hi.map((x, j) => Math.floor((x - glo[j]!) / cell));
      if ((r1[0]! - r0[0]! + 1) * (r1[1]! - r0[1]! + 1) * (r1[2]! - r0[2]! + 1) > 4096) return null;
      const out: string[] = [];
      for (let x = r0[0]!; x <= r1[0]!; x++)
        for (let y = r0[1]!; y <= r1[1]!; y++) for (let z = r0[2]!; z <= r1[2]!; z++) out.push(`${x},${y},${z}`);
      return out;
    };
    const grid = new Map<string, number[]>(), big: number[] = [];
    boxes.forEach(([lo, hi], i) => {
      const cs = cellsOf(lo, hi);
      if (!cs) { big.push(i); return; }
      for (const k of cs) (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    });
    const step = Math.max(1, Math.floor(good.length / sample));
    for (let i = 0; i < good.length; i += step) {
      c.tested++;
      const [lo, hi] = boxes[i]!;
      const candidates = new Set<number>(big);
      for (const k of cellsOf(lo, hi) ?? []) for (const j of grid.get(k) ?? []) candidates.add(j);
      const ti = good[i]!, pi = ti.map((v) => at[v]!);
      const eps = 1e-9 * (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1);
      for (const j of candidates) {
        if (j === i) continue;
        const tj = good[j]!;
        if (tj.some((v) => ti.includes(v))) continue;
        const [lo2, hi2] = boxes[j]!;
        if (lo2.some((x, a) => x > hi[a]!) || hi2.some((x, a) => x < lo[a]!)) continue;
        if (trianglesCross(pi, tj.map((v) => at[v]!), eps)) { c.crossing++; break; }
      }
    }
  });
  return c;
}

/**
 * Each face's triangles (as indices into the mesh's indices, 3 each) by face id: a result's faces name it as
 * `entityId`, a scene mesh's as `source`; a face of several ranges joined.
 */
function faceTriangles(m: TessellationResult | Mesh): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const f of m.faces as { entityId?: number | null; source?: number | null; start: number; count: number }[]) {
    const id = f.entityId ?? f.source ?? null;
    if (id === null || f.count === 0) continue;
    const t = out.get(id) ?? out.set(id, []).get(id)!;
    for (let k = f.start; k < f.start + f.count; k += 3) t.push(k);
  }
  return out;
}

/** A mesh's closed shells, welded: their triangles, each one's face, and the welded vertices' positions. */
function welded(r: TessellationResult | Mesh, d: BrepData, tris: Map<number, number[]>) {
  const pos = r.positions, idx = r.indices;
  const key = new Map<string, number>(), weld = new Int32Array(pos.length / 3), at: V3[] = [];
  for (let i = 0; i < weld.length; i++) {
    const k = `${pos[3 * i]},${pos[3 * i + 1]},${pos[3 * i + 2]}`;
    let w = key.get(k);
    if (w === undefined) key.set(k, (w = key.size)), at.push([pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!]);
    weld[i] = w;
  }
  const shells: [number, number, number][][] = [], faceOf: number[][] = [];
  for (let s = 0; s < d.shell.kind.length; s++) {
    if (d.shell.kind[s] !== CLOSED) continue;
    const ts: [number, number, number][] = [], fs2: number[] = [];
    for (let i = 0; i < d.shell.count[s]!; i++) {
      const f = d.face.id[d.faceUse.face[d.shell.first[s]! + i]!]!;
      for (const t of tris.get(f) ?? []) ts.push([weld[idx[t]!]!, weld[idx[t + 1]!]!, weld[idx[t + 2]!]!]), fs2.push(f);
    }
    shells.push(ts);
    faceOf.push(fs2);
  }
  return { shells, faceOf, at };
}

/** PLANT's bug in a part's welded shells (ours), on the first closed shell with a triangle; false if none. */
function plant(shells: [number, number, number][][], faceOf: number[][], at: V3[]): boolean {
  const s = shells.findIndex((t) => t.length > 0);
  if (s < 0) return false;
  const t = shells[s]![0]!;
  if (PLANT === 'flip') shells[s]![0] = [t[0], t[2], t[1]];
  if (PLANT === 'drop') shells[s]!.shift(), faceOf[s]!.shift();
  if (PLANT === 'cross') {
    // (A triangle a tenth of t's size straddling t's plane at its centroid, at right angles to it: put first, so
    // the sample, which starts at the shell's first triangle, meets it.)
    const [a, b, c] = t.map((v) => at[v]!) as [V3, V3, V3];
    const n = cross(sub(b, a), sub(c, a)), ln = Math.hypot(...n);
    if (!(ln > 0)) return false;
    const size = Math.max(Math.hypot(...sub(b, a)), Math.hypot(...sub(c, a))) / 10;
    const u = sub(b, a).map((x) => x / Math.hypot(...sub(b, a))) as V3, nn = n.map((x) => x / ln) as V3;
    const g: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const p = (du: number, dn: number): V3 => [g[0] + size * (du * u[0] + dn * nn[0]), g[1] + size * (du * u[1]
      + dn * nn[1]), g[2] + size * (du * u[2] + dn * nn[2])];
    const base = at.length;
    at.push(p(-0.5, -1), p(0.5, -1), p(0, 1));
    shells[s]!.unshift([base, base + 1, base + 2]);
    faceOf[s]!.unshift(faceOf[s]![0]!);
  }
  return true;
}

let maxBytes = 1000e6;
let pools: Record<Backend, WorkerTessellator>;
let workers = 1;

function readStep(f: string): Uint8Array {
  const b = fs.readFileSync(f);
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
}

export const check: FileCheck<string, Tallies> = {
  async setup({ meshWorkers }) {
    workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
    const pool = (b: Backend, cls: string) => new WorkerTessellator({
      backend: { module: import.meta.resolve(`../packages/${PKG[b]}/src/index.ts`), export: cls }, workers,
      ...(b === 'cadio' ? { cpuTimeoutMs: CPU_MS, timeoutMs: 4 * CPU_MS } : { timeoutMs: TIMEOUT_MS }) });
    pools = { cadio: pool('cadio', 'CadioTessellator'), occt: pool('occt', 'OcctTessellator'),
      smlib: pool('smlib', 'SmlibTessellator') };
    await initAll(Object.fromEntries(BACKENDS.map((b) => [`${LABEL[b]} (${PKG[b]})`, pools[b]])));
  },
  async teardown() {
    await Promise.all(BACKENDS.map((b) => pools[b].dispose()));
  },
  async file(f, list, ctx) {
    void list;
    const T = fresh();
    if (fs.statSync(f).size > maxBytes) { T.skippedBig++; return T; }
    T.files++;
    const name = shortName(f);
    const { scene } = await importStep(readStep(f), { heal: { heal: false } });
    const parts = scene.parts.filter((p) => p.brep);
    // Each part's mesh per backend (undefined where the part failed whole): tessellateScene's, or with RAW the
    // backend's own result.
    let results: (TessellationResult | Mesh | undefined)[][];
    // (Why a part failed whole, per backend by part index: the thrown error's, or tessellateScene's error diagnostic.)
    const why: Map<number, string>[] = BACKENDS.map(() => new Map());
    if (RAW) results = await Promise.all(parts.map((p) => {
      const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
        origin: p.origin, linearDeflection: LIN, angularDeflection: ANG, edges: false };
      return Promise.all(BACKENDS.map((b, bi) => pools[b].tessellate(req).catch((e: Error) => {
        why[bi]!.set(parts.indexOf(p), e.message);
        return undefined;
      })))
        .then((rs) => (ctx.progress(`${name} #${p.sources[0]!.id}`), rs));
    }));
    else {
      // (Three runs over one scene at once: each only adds its levels to the parts, and its meshes come back by part.)
      const index = new Map(parts.map((p, k) => [scene.parts.indexOf(p), k]));
      const byBackend = await Promise.all(BACKENDS.map((b) => tessellateScene(scene, pools[b], {
        linearDeflection: LIN, angularDeflection: ANG, parts: [...index.keys()], concurrency: 4 * workers,
        measures: false,
        onPart: (i) => ctx.progress(`${LABEL[b]} ${name} #${scene.parts[i]!.sources[0]!.id}`) })));
      results = parts.map((p) => byBackend.map((r) => r.meshes.get(scene.parts.indexOf(p))));
      const bySource = new Map(parts.map((p, k) => [p.sources[0], k]));
      byBackend.forEach((r, bi) => {
        for (const d of r.diagnostics) {
          const k = d.source ? bySource.get(d.source) : undefined;
          if (k !== undefined && d.severity === 'error' && !why[bi]!.has(k)) why[bi]!.set(k, d.message);
        }
      });
    }
    parts.forEach((p, k) => {
      T.parts++;
      const where = `${name} #${p.sources[0]!.id}`;
      const d: BrepData = p.brep!.model;
      BACKENDS.forEach((b, bi) => {
        const r = results[k]![bi], B = T.by[b];
        if (!d.face.id.length) { B.noFaces++; return; }
        // (No mesh because every face failed: open by design, as a part with some faces failed.)
        if (!r && /faces? failed to mesh/.test(why[bi]!.get(k) ?? '')) { B.withFailed++; return; }
        if (!r) {
          B.failedWhole++;
          const w = (why[bi]!.get(k) ?? 'no mesh, no error said').replace(/[\d.]+/g, 'N').slice(0, 90);
          B.whyWhole[w] = (B.whyWhole[w] ?? 0) + 1;
          return;
        }
        B.meshed++;
        const tris = faceTriangles(r);
        if ([...d.face.id].some((f) => !tris.get(f)?.length)) { B.withFailed++; return; }
        const { shells, faceOf, at } = welded(r, d, tris);
        if (!shells.length) { B.noClosedShell++; return; }
        const planted = b === 'cadio' && PLANT !== '' && plantedPart(where) && plant(shells, faceOf, at);
        const byFace = new Map<number, number>();
        const c = shellDefects(shells, at, faceOf, byFace);
        B.checked++;
        const ok = manifold(c);
        if (ok) B.manifold++;
        if (c.crossing) B.crossing++;
        if (ok && !c.crossing) B.fit++;
        for (const k2 of DEFECTS)
          if (c[k2]) B.partsWith[k2] = (B.partsWith[k2] ?? 0) + 1, B.totals[k2] = (B.totals[k2] ?? 0) + c[k2];
        const defects = DEFECTS.filter((k2) => c[k2]).map((k2) => `${DEFECT_LABEL[k2]} ${c[k2]}`).join(', ');
        if (!ok) {
          const faces = [...byFace].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4)
            .map(([f, n]) => `#${f} (${n})`);
          B.bad.push({ where, score: DEFECTS.reduce((a, k2) => a + c[k2], 0), line: `${where}: ${defects}; `
            + `${c.triangles} triangles in ${c.shells} closed shell${c.shells > 1 ? 's' : ''}`
            + `${faces.length ? `; faces with most: ${faces.join(', ')}` : ''}`
            + `${c.crossing ? `; crossing ${c.crossing} of ${c.tested} tested` : ''}` });
        }
        if (c.crossing) B.crossers.push({ where, rate: c.crossing / c.tested, line: `${where}: ${c.crossing} of `
          + `${c.tested} sampled triangles crossing${ok ? '' : `; not manifold (${defects})`}` });
        if (planted) {
          T.planted++;
          const caught = PLANT === 'flip' ? c.sameWay > 0 : PLANT === 'drop' ? c.open > 0 : c.crossing > 0;
          if (caught) T.plantedCaught++;
          else T.plantedMissed.push(`${where}: ${PLANT} not seen (${defects || 'no defects'}, crossing ${c.crossing})`);
        }
      });
    });
    return T;
  },
};

function lists(arg: string | undefined): string[] {
  return (arg ? arg.split(',') : DEFAULT_LISTS).map((l) => path.resolve(repoDir, l));
}

/** A file's (or a list's) tallies into another's: addInto's rules (counts summed, lists appended). */
function merge(into: Tallies, r: Tallies): void {
  addInto(into, r);
}

function report(label: string, T: Tallies): void {
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(1) : '0'}%)`;
  console.log(`## ${label}${PLANT ? `, PLANT=${PLANT}` : ''}`);
  console.log(`${T.files} files (${T.skippedBig} over ${maxBytes / 1e6} MB skipped, ${T.failedFiles} failed), `
    + `${T.parts} B-rep parts`);
  for (const b of BACKENDS) {
    const B = T.by[b];
    console.log(`  ${LABEL[b]}: parts without faces ${B.noFaces}; meshed ${B.meshed}, failed whole ${B.failedWhole}; `
      + `with a face without triangles `
      + `(open by design, not checked) ${B.withFailed}; without a closed shell ${B.noClosedShell}; `
      + `checked ${B.checked}: `
      + `manifold ${pct(B.manifold, B.checked)}, crossing (sampled) ${B.crossing}, manifold and no crossing `
      + `${pct(B.fit, B.checked)}`);
    const whys = Object.entries(B.whyWhole).sort((x, y) => y[1] - x[1]);
    if (whys.length) console.log(`    failed whole, by why: ${whys.map(([w, n]) => `${n} ${w}`).join('; ')}`);
    console.log(`    parts with (total): ${DEFECTS.map((k) => `${DEFECT_LABEL[k]} ${B.partsWith[k] ?? 0} `
      + `(${B.totals[k] ?? 0})`).join(', ')}`);
  }
  if (PLANT) console.log(`  PLANT=${PLANT}: planted ${T.planted}, caught ${T.plantedCaught}, missed `
    + `${T.planted - T.plantedCaught}${T.plantedMissed.length ? `: ${T.plantedMissed.join('; ')}` : ''}`);
  console.log();
}

/** The parts listed: ours's not manifold in full, the others' worst, and the worst crossing rates. */
function listed(T: Tallies): void {
  const bad = T.by.cadio.bad.sort((x, y) => (x.where < y.where ? -1 : x.where > y.where ? 1 : 0));
  console.log(`### Ours's parts not manifold (${bad.length}), with the faces holding most of their edge defects`);
  for (const x of bad) console.log(`  ${x.line}`);
  for (const b of ['occt', 'smlib'] as const) {
    console.log(`\n### ${LABEL[b]}'s ${WORST} worst parts by defects (of ${T.by[b].bad.length} not manifold)`);
    const worst = [...T.by[b].bad].sort((p, q) => q.score - p.score || (p.where < q.where ? -1 : 1));
    for (const x of worst.slice(0, WORST)) console.log(`  ${x.line}`);
  }
  for (const b of BACKENDS) {
    console.log(`\n### ${LABEL[b]}'s ${WORST} worst crossing rates (of ${T.by[b].crossers.length} parts crossing)`);
    const worst = [...T.by[b].crossers].sort((p, q) => q.rate - p.rate || (p.where < q.where ? -1 : 1));
    for (const x of worst.slice(0, WORST)) console.log(`  ${x.line}`);
  }
}

if (import.meta.main) {
  // (runFiles reads it, in this process.)
  process.env.IDLE_MS ??= '0';
  console.log(await hostLine());
  maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
  const ls = lists(process.argv[2]);
  const label = (l: string) => (l.startsWith(repoDir + path.sep) ? path.relative(repoDir, l) : path.basename(l));
  const files = ls.flatMap((l) => corpusFiles(l).map((f) => ({ path: f, job: label(l) })));
  const listOf = new Map(files.map((f) => [f.path, f.job]));
  const per = new Map(ls.map((l) => [label(l), fresh()]));
  const errors: string[] = [];
  const t0 = performance.now();
  await runFiles(import.meta.url, check, files, process.argv.slice(2), (f, out) => {
    const into = per.get(listOf.get(f)!)!;
    if ('error' in out) {
      into.failedFiles++;
      errors.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      return;
    }
    merge(into, out.result);
  });
  const checked = [...per.values()].reduce((a, T) => a + T.files, 0);
  if (!checked) throw new Error(`manifold: no file ran: ${files.length} listed, ${errors.length} failed`);
  const { children, meshWorkers } = division();
  const perBackend = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
  console.log(`manifold: tess-cadio, OCCT (native route) and SMLib, ${RAW ? 'their own results (RAW)'
    : 'tessellateScene\'s meshes'}, ${PROFILE} profile (${LIN} mm, ${ANG} rad), healing off, welded at the meshes' `
    + `positions, per closed shell; crossing sampled at ${SAMPLE} triangles a shell; ours's limit ${CPU_MS / 1000} s `
    + `of CPU, the references' ${TIMEOUT_MS / 1000} s of wall; ${((performance.now() - t0) / 1000).toFixed(0)} s, `
    + `${children || 1} processes x ${perBackend} workers per backend`);
  console.log();
  for (const [l, T] of per) report(l, T);
  const all = fresh();
  for (const T of per.values()) merge(all, T);
  if (per.size > 1) report('all lists', all);
  listed(all);
  for (const e of errors) console.log(e);
}
