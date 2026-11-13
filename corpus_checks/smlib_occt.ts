// The SMLib backend against our OCCT backend (its native route), part by part: every B-rep part of every corpus file
// is meshed from its model by both (tess-smlib and tess-occt, each in a tess-workers pool, so a hang costs only its
// timeout) at the medium profile with measures, and compared face by face:
//   - status: SMLib ok, failed (an error), timed out or crashed, empty, when OCCT meshes the part;
//   - faces: OCCT's meshed faces SMLib leaves without triangles; faces SMLib meshes that OCCT doesn't;
//   - areas: SMLib's mesh area against OCCT's; SMLib's exact area (its measure) against OCCT's measure;
//   - orientation: faces whose sampled triangles face opposite to the nearest of OCCT's;
//   - faceFailures (cad-scene) on each backend's mesh by its own measures: failed, partly, excess;
//   - triangles and meshing time, and the SMLib builder's warnings.
// Usage: node corpus_checks/smlib_occt.ts [file-list.txt] [max MB, default 1000]   (progress on standard error)
//   WORKERS=<n> workers per backend in each process (default: half the process's share, runner.ts)
//   FACES=<dir>  write every problem face there, a JSON line each in <file>.ndjson: where, its problems, its
//                surface and edge curve kinds, each backend's mesh and exact areas and the oracle's; parts SMLib
//                fails or leaves empty and the builder's warnings as lines without a face
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import path from 'node:path';
import type { TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { faceFailures, failedPart, MESH_PROFILES } from '../packages/cad-scene/src/index.ts';
import { type BrepData, decode, nearestParams, surfaceEvaluator } from '../packages/cad-brep/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { modelFaceArea, trusted } from './area_oracle.ts';
import { corpusFiles, shortName } from './corpus.ts';
import { addInto, division, runFiles, type FileCheck } from './runner.ts';

const EXAMPLES = 4;
const { linearDeflection: LIN_MM, angularDeflection: ANG } = MESH_PROFILES.medium;

let maxBytes = 1000e6, smlib: WorkerTessellator, occt: WorkerTessellator;

type R = TessellationResult;

/**
 * The model edges a mesh is open along: edges two or more faces use (by the model) that all have triangles, with a
 * mesh edge on them that only one triangle has. Vertices are one where their positions are the same numbers; mesh
 * edges are placed on model edges by the result's edge polylines, so such an edge without one can't be judged
 * (unjudged). Independent of the backends' own accounts.
 */
function openEdges(d: BrepData, r: R): { open: number; unjudged: number } {
  const users = new Map<number, Set<number>>();
  for (let f = 0; f < d.face.surface.length; f++) {
    const face = decode.face(d, f);
    if (face.id === undefined) continue;
    for (const l of face.loops) if (l.kind === 'edge') for (const c of l.coedges) {
      const id = decode.edge(d, c.edge).id;
      if (id !== undefined) (users.get(id) ?? users.set(id, new Set()).get(id)!).add(face.id);
    }
  }
  const weld = new Map<string, number>();
  const at = (p: Float32Array, i: number) => {
    const k = `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
    return weld.get(k) ?? (weld.set(k, weld.size), weld.size - 1);
  };
  const key = (a: number, b: number) => Math.min(a, b) * 4294967296 + Math.max(a, b);
  const uses = new Map<number, number>();
  for (let k = 0; k < r.indices.length; k += 3) for (let j = 0; j < 3; j++) {
    const e = key(at(r.positions, r.indices[k + j]!), at(r.positions, r.indices[k + (j + 1) % 3]!));
    uses.set(e, (uses.get(e) ?? 0) + 1);
  }
  const meshed = new Set(r.faces.filter((f) => f.count > 0).map((f) => f.entityId));
  const judged = (id: number | null) => {
    const us = id === null ? undefined : users.get(id);
    return !!us && us.size >= 2 && [...us].every((f) => meshed.has(f));
  };
  const open = new Set<number>(), drawn = new Set<number>();
  for (const e of r.edges ?? []) {
    if (!judged(e.entityId)) continue;
    drawn.add(e.entityId!);
    for (let k = e.start; k + 1 < e.start + e.count; k++) {
      // (A segment from a point to itself, as single precision has some, is no gap.)
      const a = at(r.edgePositions!, k), z = at(r.edgePositions!, k + 1);
      if (a !== z && uses.get(key(a, z)) === 1) open.add(e.entityId!);
    }
  }
  return { open: open.size, unjudged: [...users.keys()].filter((id) => judged(id) && !drawn.has(id)).length };
}

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

/** Face ids where most of up to 10 sampled triangles of `a` face opposite to the nearest triangle of `b`'s face. */
function flippedFaces(a: R, b: R): Set<number> {
  const tri = (r: R, k: number) => {
    const P = [0, 1, 2].map((j) => 3 * r.indices[k + j]!);
    const q = (j: number, c: number) => r.positions[P[j]! + c]!;
    const u = [0, 1, 2].map((c) => q(1, c) - q(0, c)), v = [0, 1, 2].map((c) => q(2, c) - q(0, c));
    return { c: [0, 1, 2].map((c) => (q(0, c) + q(1, c) + q(2, c)) / 3),
      n: [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!] };
  };
  const byId = new Map<number, ReturnType<typeof tri>[]>();
  for (const f of b.faces) {
    if (f.entityId === null) continue;
    const list = byId.get(f.entityId) ?? [];
    for (let k = f.start; k < f.start + f.count; k += 3) list.push(tri(b, k));
    byId.set(f.entityId, list);
  }
  const out = new Set<number>();
  const counts = new Map<number, [number, number]>();
  for (const fa of a.faces) {
    const tris = fa.entityId === null ? undefined : byId.get(fa.entityId);
    if (!tris?.length || fa.count === 0) continue;
    const n = Math.min(10, fa.count / 3);
    const c = counts.get(fa.entityId!) ?? [0, 0];
    for (let s = 0; s < n; s++) {
      const t = tri(a, fa.start + 3 * Math.floor((s * fa.count) / 3 / n));
      let best = tris[0]!, bd = Infinity;
      for (const q of tris) {
        const d = (q.c[0]! - t.c[0]!) ** 2 + (q.c[1]! - t.c[1]!) ** 2 + (q.c[2]! - t.c[2]!) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      if (t.n[0]! * best.n[0]! + t.n[1]! * best.n[1]! + t.n[2]! * best.n[2]! < 0) c[0]++;
      c[1]++;
    }
    counts.set(fa.entityId!, c);
  }
  for (const [id, [bad, n]] of counts) if (bad > n / 2) out.add(id);
  return out;
}

type Bin = '0.1%' | '1%' | '5%' | 'worse';
type Bins = Record<Bin, number>;
const bins = (): Bins => ({ '0.1%': 0, '1%': 0, '5%': 0, worse: 0 });
/**
 * Whether a face's middle triangle in `r` faces along the model face's normal (its surface's S_u x S_v at the
 * centroid times its sameSense): true, false, or undefined where that can't be told (no triangles, no parameters).
 */
function alongModel(d: BrepData, row: number, r: R, id: number, origin: readonly number[]): boolean | undefined {
  const f = r.faces.find((x) => x.entityId === id && x.count > 0);
  if (!f) return undefined;
  const face = decode.face(d, row), ev = surfaceEvaluator(d, face.surface);
  if (!ev) return undefined;
  const k = f.start + 3 * Math.floor(f.count / 6);
  const P = [0, 1, 2].map((j) => [0, 1, 2].map((c) => r.positions[3 * r.indices[k + j]! + c]! + origin[c]!));
  const c = [0, 1, 2].map((i) => (P[0]![i]! + P[1]![i]! + P[2]![i]!) / 3) as [number, number, number];
  const uv = ev.params?.(c) ?? nearestParams(ev, c);
  if (!uv) return undefined;
  const [su, sv] = ev.d1(uv[0], uv[1]);
  const u = P[1]!.map((x, i) => x - P[0]![i]!), v = P[2]!.map((x, i) => x - P[0]![i]!);
  const t = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const n = [su[1]! * sv[2]! - su[2]! * sv[1]!, su[2]! * sv[0]! - su[0]! * sv[2]!, su[0]! * sv[1]! - su[1]! * sv[0]!];
  const dot = t[0]! * n[0]! + t[1]! * n[1]! + t[2]! * n[2]!;
  return dot === 0 ? undefined : (dot > 0) === face.sameSense;
}

const bin = (rel: number): Bin => (rel <= 1e-3 ? '0.1%' : rel <= 0.01 ? '1%' : rel <= 0.05 ? '5%' : 'worse');
type Status = 'ok' | 'error' | 'timeout' | 'crash' | 'empty';
/** A face's surface kind (a swept or offset one with its basis) and its edges' curve kinds, for FACES. */
function faceKinds(d: BrepData, row: number): { surface: string; curves: string; loops: number } {
  const face = decode.face(d, row);
  const surf = (k: number): string => {
    const s = decode.surface(d, k) as { kind: string; basis?: number; curve?: number; rational?: boolean };
    if (s.kind === 'bspline') return s.rational ? 'bspline rational' : 'bspline';
    if (s.basis !== undefined) return `${s.kind}(${surf(s.basis)})`;
    if (s.curve !== undefined) return `${s.kind}(${decode.curve(d, s.curve).kind})`;
    return s.kind;
  };
  const kinds = new Set<string>();
  for (const l of face.loops) {
    if (!('coedges' in l) || !l.coedges) { kinds.add(l.kind); continue; }
    for (const c of l.coedges) {
      const e = decode.edge(d, c.edge);
      kinds.add((e.curve === undefined || e.curve === null ? 'none' : decode.curve(d, e.curve).kind)
        + (e.start === undefined || e.start === null ? ' (no vertices)' : ''));
    }
  }
  return { surface: surf(face.surface), curves: [...kinds].sort().join(','), loops: face.loops.length };
}

const KINDS = ['failed', 'partly', 'excess', 'unverified'] as const;
const failureTally = () => ({ failed: 0, partly: 0, excess: 0, unverified: 0 });

const fresh = () => ({
  files: 0, skippedBig: 0, parts: 0, occtEmpty: 0, compared: 0,
  status: { ok: 0, error: 0, timeout: 0, crash: 0, empty: 0 } as Record<Status, number>,
  facesOcct: 0, facesMissing: 0, facesExtra: 0, facesFlipped: 0,
  // Of the faces facing opposite to OCCT's: which backend's faces against the model face's normal.
  flippedBy: { smlib: 0, occt: 0, unknown: 0 },
  meshArea: bins(),
  exactArea: { ...bins(), none: 0 },
  // Against the area oracle (corpus_checks/area_oracle.ts), where it trusts its area: each backend's measure and mesh.
  oracle: { faces: 0, smlibExact: bins(), occtExact: bins(), smlibMesh: bins(), occtMesh: bins() },
  failures: { smlib: failureTally(), occt: failureTally() },
  trisSmlib: 0, trisOcct: 0, msSmlib: 0, msOcct: 0, msBuild: 0, msTess: 0, msMeasures: 0, partsComplete: 0,
  retried: 0, improved: 0,
  // Parts with open model edges and those edges: by openEdges for each backend, and by SMLib's own error.
  open: { smlib: { parts: 0, edges: 0, unjudged: 0 }, occt: { parts: 0, edges: 0, unjudged: 0 },
    said: { parts: 0, edges: 0, unjudged: 0 } },
  tally: new Map<string, { n: number; ex: string[] }>(),
});
type Tallies = ReturnType<typeof fresh>;

export const check: FileCheck<undefined, Tallies> = {
  async setup({ meshWorkers, args }) {
    maxBytes = Number(args[1] ?? 1000) * 1e6;
    const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 2)));
    const pool = (pkg: string, cls: string) => new WorkerTessellator({
      backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls }, workers });
    smlib = pool('tess-smlib', 'SmlibTessellator');
    occt = pool('tess-occt', 'OcctTessellator');
    await Promise.all([smlib.init(), occt.init()]);
  },
  async teardown() {
    await Promise.all([smlib.dispose(), occt.dispose()]);
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
    const lines: string[] = [];
    const facesDir = process.env.FACES;
    const { scene } = await importStep(new Uint8Array(bytes));
    const parts = scene.parts.filter((p) => p.brep);
    const run = async (t: WorkerTessellator, req: TessellationRequest) => {
      const t0 = performance.now();
      const r = await t.tessellate(req).catch((e: Error) => e);
      return { r, ms: performance.now() - t0 };
    };
    const results = await Promise.all(parts.map(async (p) => {
      const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
        origin: p.origin, linearDeflection: LIN_MM, angularDeflection: ANG, measures: true, edges: true };
      const [a, b] = await Promise.all([run(smlib, req), run(occt, req)]);
      return { p, req, a, b };
    }));
    for (const { p, req, a, b } of results) {
      T.parts++;
      const where = `${name} #${p.sources[0]!.id}`;
      if (b.r instanceof Error || !b.r.indices.length) { T.occtEmpty++; continue; }
      T.compared++;
      T.msOcct += b.ms;
      T.msSmlib += a.ms;
      const ob = b.r;
      T.trisOcct += ob.indices.length / 3;
      const of = faceAreas(ob);
      T.facesOcct += of.size;
      if (a.r instanceof Error) {
        const m = a.r.message;
        const k: Status = /timed out/.test(m) ? 'timeout' : /exit|crash|terminated|memory/.test(m) ? 'crash' : 'error';
        T.status[k]++;
        T.facesMissing += of.size;
        note(`SMLib ${k}: ${m.replace(/\d+/g, 'N').slice(0, 120)}`, where);
        lines.push(JSON.stringify({ where, status: k, message: m.slice(0, 300), faces: of.size }));
        continue;
      }
      const sa = a.r;
      for (const d of sa.diagnostics) {
        const t = /^times (\S+) (\S+) (\S+)$/.exec(d.message);
        if (t) { T.msBuild += Number(t[1]); T.msTess += Number(t[2]); T.msMeasures += Number(t[3]); continue; }
        const q = /^(\d+) faces meshed badly .* \((\d+) better so\)$/.exec(d.message);
        if (q) { T.retried += Number(q[1]); T.improved += Number(q[2]); }
        const u = /^(\d+) edges along which the meshes/.exec(d.message);
        if (u) { T.open.said.parts++; T.open.said.edges += Number(u[1]); }
        note(`${d.severity}: ${d.message.replace(/\d+/g, 'N')}`, where);
      }
      const said = sa.diagnostics.filter((d) => !/^times /.test(d.message)).map((d) => `${d.severity}: ${d.message}`);
      const partLine = (status: string) => lines.push(JSON.stringify({ where, status, faces: of.size, said }));
      // (Errors with a mesh, faces failed or edges open, don't fail the part.)
      if (failedPart(sa)) {
        T.status.error++;
        T.facesMissing += of.size;
        partLine('error');
        continue;
      }
      if (!sa.indices.length) { T.status.empty++; T.facesMissing += of.size; partLine('empty'); continue; }
      if (said.length) partLine('ok');
      T.status.ok++;
      T.trisSmlib += sa.indices.length / 3;
      for (const [who, r] of [['smlib', sa], ['occt', ob]] as const) {
        const n = openEdges(p.brep!.model, r);
        if (n.open) { T.open[who].parts++; T.open[who].edges += n.open; }
        T.open[who].unjudged += n.unjudged;
      }
      const sf = faceAreas(sa);
      const sm = new Map((sa.measures ?? []).map((m) => [m.entityId, m]));
      const om = new Map((ob.measures ?? []).map((m) => [m.entityId, m]));
      let missing = 0, off = 0;
      // Each problem face's problems, for FACES.
      const problems = new Map<number, string[]>();
      const problem = (id: number, what: string) => {
        if (facesDir) problems.set(id, [...(problems.get(id) ?? []), what]);
      };
      // The oracle's trusted areas by face id (millimetres, as the model is).
      const d = p.brep!.model, oracleArea = new Map<number, number>();
      for (let fr = 0; fr < d.face.surface.length; fr++) {
        const id = d.face.id[fr]!;
        if (!Number.isFinite(id)) continue;
        const o = modelFaceArea(d, fr);
        if (o.ok && trusted(o)) oracleArea.set(id, o.area);
      }
      for (const [id, o] of of) {
        const s = sf.get(id);
        if (!s || !s.tris) {
          missing++;
          note('face OCCT meshes, SMLib not', `${where} face #${id}`);
          problem(id, 'missing');
          continue;
        }
        const rel = Math.abs(s.area - o.area) / Math.max(o.area, 1e-12);
        const k = bin(rel);
        T.meshArea[k]++;
        if (k === 'worse') {
          off++;
          note('mesh areas differ by over 5%', `${where} face #${id}`);
          problem(id, 'mesh off OCCT');
        }
        const x = sm.get(id), y = om.get(id), z = oracleArea.get(id);
        if (z !== undefined && z > 0) {
          T.oracle.faces++;
          const rel = (a: number | undefined) => (a === undefined ? Infinity : Math.abs(a - z) / z);
          const kx = bin(rel(x?.area)), ky = bin(rel(y?.area)), kxm = bin(rel(s.area)), kym = bin(rel(o.area));
          T.oracle.smlibExact[kx]++;
          T.oracle.occtExact[ky]++;
          T.oracle.smlibMesh[kxm]++;
          T.oracle.occtMesh[kym]++;
          if (kx === 'worse') {
            note('SMLib\'s exact area off the oracle\'s by over 5%', `${where} face #${id}`);
            problem(id, 'exact off oracle');
          }
          if (ky === 'worse') {
            note('OCCT\'s measured area off the oracle\'s by over 5%', `${where} face #${id}`);
            problem(id, 'OCCT exact off oracle');
          }
          if (kxm === 'worse') {
            note('SMLib\'s mesh area off the oracle\'s by over 5%', `${where} face #${id}`);
            problem(id, 'mesh off oracle');
          }
          if (kym === 'worse') problem(id, 'OCCT mesh off oracle');
        }
        if (!x || !y || !Number.isFinite(x.area) || !Number.isFinite(y.area)) T.exactArea.none++;
        else {
          const kk = bin(Math.abs(x.area - y.area) / Math.max(y.area, 1e-12));
          T.exactArea[kk]++;
          if (kk === 'worse') {
            note('exact areas (measures) differ by over 5%', `${where} face #${id}`);
            problem(id, 'exact off OCCT');
          }
        }
      }
      for (const id of sf.keys()) {
        if (!of.has(id)) { T.facesExtra++; note('face SMLib meshes, OCCT not', `${where} face #${id}`); }
      }
      T.facesMissing += missing;
      const flipped = flippedFaces(sa, ob);
      T.facesFlipped += flipped.size;
      const rowOf = new Map<number, number>();
      for (let fr = 0; fr < d.face.surface.length; fr++) rowOf.set(d.face.id[fr]!, fr);
      for (const id of flipped) {
        const row = rowOf.get(id);
        const a = row === undefined ? undefined : alongModel(d, row, sa, id, p.origin);
        const who = a === undefined ? 'unknown' : a ? 'occt' : 'smlib';
        T.flippedBy[who]++;
        note(`face facing opposite to OCCT's, against the model's normal: ${who}`, `${where} face #${id}`);
        problem(id, `flipped: ${who}`);
      }
      for (const [who, r] of [['smlib', sa], ['occt', ob]] as const) {
        const mesh = { positions: r.positions, indices: r.indices,
          faces: r.faces.map((x) => ({ source: x.entityId, start: x.start, count: x.count })) };
        const measures = { by: who, faces: new Map((r.measures ?? []).map((m) => [m.entityId, m])) };
        const fails = faceFailures(mesh as never, { measured: { measures: measures as never,
          deflection: req.linearDeflection } });
        for (const [id, kind] of fails) {
          T.failures[who][kind]++;
          if (who === 'smlib') note(`SMLib faceFailures: ${String(kind)}`, `${where} face #${id}`);
          if (id !== null) problem(id as number, `${who === 'smlib' ? '' : 'OCCT '}faceFailures ${String(kind)}`);
        }
      }
      for (const [id, what] of problems) {
        const row = rowOf.get(id);
        // (An id no face row has: a mesh's face without one.)
        if (row === undefined) { lines.push(JSON.stringify({ where, id, what })); continue; }
        const num = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : +x.toPrecision(6));
        lines.push(JSON.stringify({ where, id, row, what, ...faceKinds(d, row), smMesh: num(sf.get(id)?.area),
          ocMesh: num(of.get(id)?.area), smExact: num(sm.get(id)?.area), ocExact: num(om.get(id)?.area),
          oracle: num(oracleArea.get(id)), smTris: sf.get(id)?.tris ?? 0, ocTris: of.get(id)?.tris ?? 0 }));
      }
      if (!missing && !off && !flipped.size) T.partsComplete++;
    }
    if (facesDir) {
      fs.mkdirSync(facesDir, { recursive: true });
      fs.writeFileSync(path.join(facesDir, `${name.replace(/[^\w.-]+/g, '_')}.ndjson`),
        lines.length ? lines.join('\n') + '\n' : '');
    }
    return T;
  },
};

if (import.meta.main) {
  maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
  const all = fresh();
  const { children, meshWorkers } = division();
  const perBackend = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 2)));
  const rows: string[] = [];
  const t0 = performance.now();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) rows.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      else {
        for (const [k, t] of out.result.tally) {
          const u = all.tally.get(k) ?? { n: 0, ex: [] };
          u.n += t.n;
          for (const e of t.ex) if (u.ex.length < EXAMPLES) u.ex.push(e);
          all.tally.set(k, u);
        }
        out.result.tally = new Map();
        addInto(all, out.result);
      }
    });
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(2) : '0'}%)`;
  const T = all;
  console.log(`SMLib against OCCT (native route), medium profile: ${T.files} files (${T.skippedBig} over `
    + `${maxBytes / 1e6} MB skipped), ${T.parts} B-rep parts; OCCT meshes ${T.compared} (${T.occtEmpty} empty or `
    + 'failed, not compared)');
  console.log(`  SMLib status: ${Object.entries(T.status).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  faces: ${pct(T.facesMissing, T.facesOcct)} of OCCT's without SMLib triangles; ${T.facesExtra} extra; `
    + `${T.facesFlipped} facing opposite to OCCT's (against the model face's normal: SMLib's ${T.flippedBy.smlib}, `
    + `OCCT's ${T.flippedBy.occt}, not told ${T.flippedBy.unknown})`);
  console.log(`  mesh area against OCCT's (faces both mesh): `
    + Object.entries(T.meshArea).map(([k, n]) => `${k === 'worse' ? '> 5%' : `within ${k}`} ${n}`).join(', '));
  console.log(`  exact area (SMLib's measure) against OCCT's measure: `
    + Object.entries(T.exactArea).map(([k, n]) =>
      `${k === 'worse' ? '> 5%' : k === 'none' ? 'unmeasured' : `within ${k}`} ${n}`)
      .join(', '));
  console.log(`  against the area oracle (${T.oracle.faces} faces both mesh it trusts): `
    + (['smlibExact', 'occtExact', 'smlibMesh', 'occtMesh'] as const).map((k) => `${k} ${Object.entries(T.oracle[k])
      .map(([b, n]) => `${b === 'worse' ? '>5%' : b} ${n}`).join(' ')}`).join('; '));
  for (const who of ['smlib', 'occt'] as const) console.log(`  faceFailures by its own measures, ${who}: `
    + KINDS.map((k) => `${k} ${T.failures[who][k]}`).join(', '));
  console.log(`  complete (no face missing, off by 5% or flipped): ${pct(T.partsComplete, T.compared)} parts`);
  console.log(`  faces meshed again alone: ${T.retried}, ${T.improved} better so`);
  console.log(`  open model edges (edges of two or more meshed faces whose meshes don't meet along them, vertices `
    + `matched exactly): SMLib ${T.open.smlib.edges} in ${T.open.smlib.parts} parts (its own error: `
    + `${T.open.said.edges} in ${T.open.said.parts}), OCCT ${T.open.occt.edges} in ${T.open.occt.parts}; shared `
    + `edges without an edge polyline, not judged: SMLib ${T.open.smlib.unjudged}, OCCT ${T.open.occt.unjudged}`);
  console.log(`  triangles: SMLib ${T.trisSmlib}, OCCT ${T.trisOcct}; meshing ${(T.msSmlib / 1000).toFixed(1)} s `
    + `SMLib, ${(T.msOcct / 1000).toFixed(1)} s OCCT (wall time per request, summed); SMLib's (SMLIB_TIMES): build `
    + `${(T.msBuild / 1000).toFixed(1)} s, tessellate ${(T.msTess / 1000).toFixed(1)} s, measures `
    + `${(T.msMeasures / 1000).toFixed(1)} s`);
  console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s, ${children || 1} processes x ${perBackend} workers `
    + 'per backend');
  console.log();
  for (const [k, t] of [...T.tally].sort((x, y) => y[1].n - x[1].n)) console.log(
    `${String(t.n).padStart(8)} ${k}  e.g. ${t.ex.join('; ')}`);
  for (const r of rows) console.log(r);
}
