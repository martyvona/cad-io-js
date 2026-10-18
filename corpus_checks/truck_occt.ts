// Phase 3 step 3: the truck backend against our OCCT backend, part by part. Every brep part of every corpus file is
// tessellated by both (tess-truck and tess-occt, each in a tess-workers pool, so a hang costs only its timeout), at
// 0.05 mm (phase 0's tolerance; OCCT also at 0.5 rad), and compared:
//   - status: truck ok, panicked, timed out, failed or empty, when OCCT meshes the part;
//   - faces: OCCT's face ids that truck lacks (failed to mesh, couldn't convert, other) or adds;
//   - edges: the kind of each STEP edge both report; edge points that aren't mesh vertices;
//   - area: truck's against OCCT's; faces whose sampled triangles face opposite to OCCT's;
//   - truck's workaround diagnostics (placements fixed, shells reversed or unchecked).
// For files with one root product and a surface area validation property, both backends' placed totals are also
// compared with the property: a check independent of either backend.
// Usage: node corpus_checks/truck_occt.ts [file-list.txt] [max MB, default 30]   (progress on standard error)
//   DUMP=<dir>  write the subset of every part with a problem there, as <file>.<root id>.stp, for repros
//   WORKERS=<n> workers per backend (default 4)
import fs from 'node:fs';
import path from 'node:path';
import type { Scene, TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { partInstances } from '../packages/cad-scene/src/index.ts';
import { extractSemantics, openModel, parseStep } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const maxBytes = Number(process.argv[3] ?? 30) * 1e6;
const dump = process.env.DUMP;
const workers = Number(process.env.WORKERS ?? 4);
if (dump) fs.mkdirSync(dump, { recursive: true });
const TOL_MM = 0.05;

const pool = (pkg: string, cls: string, timeoutMs: number) =>
  new WorkerTessellator({ backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls }, workers, timeoutMs });
const truck = pool('tess-truck', 'TruckTessellator', 60_000);
const occt = pool('tess-occt', 'OcctTessellator', 300_000);
await Promise.all([truck.init(), occt.init()]);

// ---- geometry helpers ----

type R = TessellationResult;
function area(r: R, f?: R['faces'][number]): number {
  const p = r.positions, ix = r.indices;
  let a = 0;
  for (let k = f?.start ?? 0, end = f ? f.start + f.count : ix.length; k < end; k += 3) {
    const A = 3 * ix[k]!, B = 3 * ix[k + 1]!, C = 3 * ix[k + 2]!;
    const u0 = p[B]! - p[A]!, u1 = p[B + 1]! - p[A + 1]!, u2 = p[B + 2]! - p[A + 2]!;
    const v0 = p[C]! - p[A]!, v1 = p[C + 1]! - p[A + 1]!, v2 = p[C + 2]! - p[A + 2]!;
    a += Math.hypot(u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0) / 2;
  }
  return a;
}

/** Faces (by id) where most of up to 10 sampled truck triangles face opposite to the nearest OCCT triangle of the face. */
function flippedFaces(a: R, b: R): number[] {
  const byId = new Map<number | null, R['faces'][number][]>();
  for (const f of b.faces) byId.set(f.entityId, [...(byId.get(f.entityId) ?? []), f]);
  const tri = (r: R, k: number) => {
    const P = [0, 1, 2].map((j) => 3 * r.indices[k + j]!);
    const q = (j: number, c: number) => r.positions[P[j]! + c]!;
    const u = [0, 1, 2].map((c) => q(1, c) - q(0, c)), v = [0, 1, 2].map((c) => q(2, c) - q(0, c));
    return { c: [0, 1, 2].map((c) => (q(0, c) + q(1, c) + q(2, c)) / 3), n: [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!] };
  };
  const out: number[] = [];
  for (const fa of a.faces) {
    const fbs = byId.get(fa.entityId);
    if (fa.entityId === null || !fbs || fa.count === 0) continue;
    const tris = fbs.flatMap((fb) => Array.from({ length: fb.count / 3 }, (_, i) => tri(b, fb.start + 3 * i)));
    if (!tris.length) continue;
    const n = Math.min(10, fa.count / 3);
    let bad = 0;
    for (let s = 0; s < n; s++) {
      const t = tri(a, fa.start + 3 * Math.floor((s * fa.count) / 3 / n));
      let best = tris[0]!, bd = Infinity;
      for (const q of tris) {
        const d = (q.c[0]! - t.c[0]!) ** 2 + (q.c[1]! - t.c[1]!) ** 2 + (q.c[2]! - t.c[2]!) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      if (t.n[0]! * best.n[0]! + t.n[1]! * best.n[1]! + t.n[2]! * best.n[2]! < 0) bad++;
    }
    if (bad > n / 2) out.push(fa.entityId);
  }
  return out;
}

function offMesh(r: R): number {
  const verts = new Set<string>();
  for (let i = 0; i < r.positions.length; i += 3) verts.add(`${r.positions[i]},${r.positions[i + 1]},${r.positions[i + 2]}`);
  let n = 0;
  const e = r.edgePositions ?? new Float32Array();
  for (let i = 0; i < e.length; i += 3) if (!verts.has(`${e[i]},${e[i + 1]},${e[i + 2]}`)) n++;
  return n;
}

// ---- entity types, for the per-face and per-edge tallies ----

/** Each instance's text, by id, from a payload (split at semicolons outside strings). */
function instances(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let start = text.indexOf('DATA;'), str = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'") str = !str;
    else if (c === ';' && !str) {
      const rec = text.slice(start + 1, i).trim();
      const m = /^#(\d+)\s*=\s*/.exec(rec);
      if (m) out.set(Number(m[1]), rec.slice(m[0].length).replace(/\s+/g, ' '));
      start = i;
    }
  }
  return out;
}

const NAMES = ['RATIONAL_B_SPLINE_SURFACE', 'B_SPLINE_SURFACE_WITH_KNOTS', 'BEZIER_SURFACE', 'RATIONAL_B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS', 'BEZIER_CURVE'];
/** An entity's type: its name, or for a complex instance the most telling of its partial names. */
function typeOf(rec: string | undefined): string {
  if (!rec) return '?';
  if (!rec.startsWith('(')) return /^[A-Z_0-9]+/.exec(rec)?.[0] ?? '?';
  return NAMES.find((n) => rec.includes(`${n}(`) || rec.includes(`${n} (`)) ?? 'complex';
}
const lastRef = (rec: string) => Number(/#(\d+)\s*,\s*\.[TF]\.\s*\)\s*$/.exec(rec)?.[1]);
/** A face's surface type. */
const surfaceType = (ins: Map<number, string>, face: number) => { const r = ins.get(face); return r ? typeOf(ins.get(lastRef(r))) : '?'; };
/** An edge's curve type; a SURFACE_CURVE or SEAM_CURVE by its 3D curve. */
function curveType(ins: Map<number, string>, edge: number): string {
  const r = ins.get(edge);
  if (!r) return '?';
  const c = ins.get(lastRef(r));
  const t = typeOf(c);
  if ((t === 'SURFACE_CURVE' || t === 'SEAM_CURVE') && c) return `${t}/${typeOf(ins.get(Number(/#(\d+)/.exec(c.slice(c.indexOf(',')))?.[1])))}`;
  return t;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5; as in scene_occt.ts).
function triDist(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q: V;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = b;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
    else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
  }
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const vert = (r: R, v: number): V => [r.positions[3 * v]!, r.positions[3 * v + 1]!, r.positions[3 * v + 2]!];
/** Of up to 10 vertices sampled from faces `fa` of r, how many lie farther than `thr` from the triangles `fb` of q. */
function farSamples(r: R, fa: R['faces'], q: R, fb: R['faces'], thr: number): [number, number] {
  const verts = fa.flatMap((f) => Array.from({ length: f.count }, (_, i) => r.indices[f.start + i]!));
  if (!verts.length) return [0, 0];
  const n = Math.min(10, verts.length);
  let far = 0;
  for (let s = 0; s < n; s++) {
    const p = vert(r, verts[Math.floor((s * verts.length) / n)]!);
    let best = Infinity;
    for (const f of fb) for (let k = f.start; k < f.start + f.count && best > thr; k += 3) best = Math.min(best, triDist(p, vert(q, q.indices[k]!), vert(q, q.indices[k + 1]!), vert(q, q.indices[k + 2]!)));
    if (best > thr) far++;
  }
  return [far, n];
}
/** Each face's loop edges: (EDGE_CURVE id, traversed along the curve?), from the payload's topology. */
function loopUses(ins: Map<number, string>): Map<number, [number, boolean][]> {
  const refs = (x: string) => [...x.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const last = (x: string) => /\.([TF])\.\s*\)?\s*$/.exec(x)?.[1] === 'T';
  const out = new Map<number, [number, boolean][]>();
  for (const [id, r] of ins) {
    if (!/^(ADVANCED_FACE|FACE_SURFACE)\b/.test(r)) continue;
    const list: [number, boolean][] = [];
    for (const b of refs(r.slice(r.indexOf('('), r.lastIndexOf('#')))) {
      const br = ins.get(b), lp = br && ins.get(refs(br)[0]!);
      if (!br || !lp || !/^EDGE_LOOP\b/.test(lp)) continue;
      for (const oe of refs(lp)) {
        const o = ins.get(oe);
        if (o && /^ORIENTED_EDGE\b/.test(o)) list.push([refs(o).at(-1)!, last(o) === last(br)]);
      }
    }
    out.set(id, list);
  }
  return out;
}

const byFaceType = new Map<string, { faces: number; missing: number; ok: number; wrong: number; short: number; contra: number; mixed: number; flipped: number }>();
const byEdgeType = new Map<string, { edges: number; withOff: number; off: number }>();
const tally = <T>(m: Map<string, T>, k: string, init: () => T) => { let v = m.get(k); if (!v) m.set(k, (v = init())); return v; };

const num = (r: R, re: RegExp) => r.diagnostics.reduce((s, d) => s + Number(re.exec(d.message)?.[1] ?? 0), 0);
const has = (r: R, re: RegExp) => r.diagnostics.some((d) => re.test(d.message));

// ---- the run ----

const totals = {
  files: 0, skippedBig: 0, parts: 0, occtEmpty: 0, compared: 0,
  status: { ok: 0, panic: 0, timeout: 0, error: 0, empty: 0 } as Record<string, number>,
  area: { '0.1%': 0, '1%': 0, '5%': 0, worse: 0 } as Record<string, number>,
  facesOcct: 0, facesMissing: 0, facesUnmeshed: 0, facesUnconverted: 0, facesExtra: 0,
  edgesCompared: 0, edgeKindDiff: 0, edgePoints: 0, edgePointsOff: 0, partsOffMesh: 0,
  partsFlipped: 0, facesFlipped: 0, placementsFixed: 0, partsPlacementsFixed: 0, shellsReversed: 0, shellsOpen: 0, shellsInconsistent: 0,
  curves3d: 0, tori: 0, cones: 0, nanEdges: 0, nanFaces: 0, unread: 0, partsComplete: 0,
  validation: { files: 0, truck: [0, 0], occt: [0, 0] } as { files: number; truck: number[]; occt: number[] },
};
const rows: string[] = [];
const panics = new Map<string, number>();
const t0 = performance.now();

const files = corpusFiles(process.argv[2]);
for (const [fi, f] of files.entries()) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { totals.skippedBig++; continue; }
  const name = shortName(f);
  let scene: Scene;
  try {
    scene = (await importStep(bytes)).scene;
  } catch (e) {
    rows.push(`${name}: import failed: ${(e as Error).message}`);
    continue;
  }
  totals.files++;
  const parts = scene.parts.flatMap((p, i) => (p.kind === 'brep' ? [{ i, p }] : []));
  const run = (t: WorkerTessellator, req: TessellationRequest) => t.tessellate(req).catch((e: Error) => e);
  const results = await Promise.all(parts.map(async ({ i, p }) => {
    if (p.kind !== 'brep') throw new Error('unreachable');
    const req: TessellationRequest = { format: p.format, data: p.payload(), rootId: p.rootId, origin: p.origin, linearDeflection: TOL_MM / p.unit, angularDeflection: 0.5, edges: true };
    const [a, b] = await Promise.all([run(truck, req), run(occt, req)]);
    return { i, req, a, b };
  }));
  const meshes = { truck: new Map<number, R>(), occt: new Map<number, R>() };
  for (const { i, req, a, b } of results) {
    totals.parts++;
    const where = `${name} #${req.rootId}`;
    if (b instanceof Error || !b.indices.length) { totals.occtEmpty++; continue; }
    meshes.occt.set(i, b);
    totals.compared++;
    const problems: string[] = [];
    let status: string;
    if (a instanceof Error) status = /timed out/.test(a.message) ? 'timeout' : 'error';
    else if (has(a, /^truck panicked/)) status = 'panic';
    else if (has(a, /^truck: /)) status = 'error';
    else if (!a.indices.length) status = 'empty';
    else status = 'ok';
    totals.status[status]!++;
    if (status !== 'ok') {
      const why = a instanceof Error ? a.message : a.diagnostics.map((d) => d.message).join('; ');
      problems.push(`${status}: ${why.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (status === 'panic') { const k = why.replace(/^truck panicked: panicked at /, '').replace(/\s+/g, ' ').slice(0, 160); panics.set(k, (panics.get(k) ?? 0) + 1); }
    } else if (!(a instanceof Error)) {
      meshes.truck.set(i, a);
      // Faces.
      const ta = new Set(a.faces.map((x) => x.entityId)), tb = new Set(b.faces.map((x) => x.entityId).filter((x) => x !== null));
      const unmeshed = num(a, /^(\d+) faces failed to mesh/), unconverted = num(a, /^(\d+) faces truck can't convert/);
      const missing = [...tb].filter((x) => !ta.has(x)).length, extra = [...ta].filter((x) => x !== null && !tb.has(x)).length;
      totals.facesOcct += tb.size; totals.facesMissing += missing; totals.facesUnmeshed += unmeshed; totals.facesUnconverted += unconverted; totals.facesExtra += extra;
      if (missing || extra) problems.push(`faces: ${missing} of ${tb.size} missing (${unmeshed} failed to mesh, ${unconverted} not converted), ${extra} extra`);
      // Edges.
      const kb = new Map(b.edges!.filter((e) => e.entityId !== null).map((e) => [e.entityId, e.kind]));
      let kindDiff = 0, compared = 0;
      const diffs: Record<string, number> = {};
      for (const e of a.edges!) {
        const k = kb.get(e.entityId);
        if (k === undefined) continue;
        compared++;
        if (k !== e.kind) { kindDiff++; diffs[`${e.kind}/${k}`] = (diffs[`${e.kind}/${k}`] ?? 0) + 1; }
      }
      totals.edgesCompared += compared; totals.edgeKindDiff += kindDiff;
      if (kindDiff) problems.push(`edge kinds (truck/OCCT): ${Object.entries(diffs).map(([k, n]) => `${n} ${k}`).join(', ')}`);
      const off = offMesh(a), pts = (a.edgePositions?.length ?? 0) / 3;
      totals.edgePoints += pts; totals.edgePointsOff += off;
      if (off) { totals.partsOffMesh++; problems.push(`${off} of ${pts} edge points off the mesh`); }
      // Area and orientation.
      const ratio = area(a) / area(b);
      const bucket = Math.abs(ratio - 1) <= 0.001 ? '0.1%' : Math.abs(ratio - 1) <= 0.01 ? '1%' : Math.abs(ratio - 1) <= 0.05 ? '5%' : 'worse';
      totals.area[bucket]!++;
      if (bucket === '5%' || bucket === 'worse') problems.push(`area ${ratio.toFixed(4)} x OCCT's`);
      const flipped = flippedFaces(a, b);
      // Per face and per edge, by type.
      const ins = instances(new TextDecoder('latin1').decode(req.data));
      const faceArea = (r: R) => { const m = new Map<number, number>(); for (const fc of r.faces) if (fc.entityId !== null) m.set(fc.entityId, (m.get(fc.entityId) ?? 0) + area(r, fc)); return m; };
      const flippedSet = new Set(flipped);
      const facesOf = (r: R) => { const m = new Map<number, R['faces']>(); for (const fc of r.faces) if (fc.entityId !== null) m.set(fc.entityId, [...(m.get(fc.entityId) ?? []), fc]); return m; };
      const fa = facesOf(a), fb = facesOf(b);
      const thr = 2 * req.linearDeflection + 1e-6;
      const verts = new Set<string>();
      for (let k = 0; k < a.positions.length; k += 3) verts.add(`${a.positions[k]},${a.positions[k + 1]},${a.positions[k + 2]}`);
      const epts = new Map<number, string[]>();
      for (const e of a.edges!) if (e.entityId !== null) epts.set(e.entityId, Array.from({ length: e.count }, (_, i) => `${a.edgePositions![3 * (e.start + i)]},${a.edgePositions![3 * (e.start + i) + 1]},${a.edgePositions![3 * (e.start + i) + 2]}`));
      const uses = loopUses(ins);
      let wrongFaces = 0, contraFaces = 0;
      for (const [id, fbs] of fb) {
        const t = tally(byFaceType, surfaceType(ins, id), () => ({ faces: 0, missing: 0, ok: 0, wrong: 0, short: 0, contra: 0, mixed: 0, flipped: 0 }));
        t.faces++;
        const fas = fa.get(id);
        if (!fas) { t.missing++; continue; }
        // Geometry: truck's vertices on OCCT's face (else truck's surface is wrong or too large), and OCCT's on truck's
        // (else part of the face is missing).
        const [farA, nA] = farSamples(a, fas, b, fbs, thr), [farB, nB] = farSamples(b, fbs, a, fas, thr);
        if (farA > nA / 5) t.wrong++; else if (farB > nB / 5) t.short++; else t.ok++;
        if (farA > nA / 5 || farB > nB / 5) wrongFaces++;
        // Orientation against the file's loops: truck's triangles wind counter-clockwise about its normals, so the
        // loops (counter-clockwise about the face normal, ISO 10303-42) run along the face's triangle boundaries.
        const half = new Set<string>();
        const vk = (v: number) => `${a.positions[3 * v]},${a.positions[3 * v + 1]},${a.positions[3 * v + 2]}`;
        for (const fc of fas) for (let k = fc.start; k < fc.start + fc.count; k += 3) for (let j = 0; j < 3; j++) half.add(`${vk(a.indices[k + j]!)}>${vk(a.indices[k + (j + 1) % 3]!)}`);
        let agree = 0, contra = 0;
        for (const [ec, along] of uses.get(id) ?? []) {
          const p = epts.get(ec);
          if (!p) continue;
          const q = along ? p : [...p].reverse();
          for (let k = 0; k + 1 < q.length; k++) { if (half.has(`${q[k]}>${q[k + 1]}`)) agree++; else if (half.has(`${q[k + 1]}>${q[k]}`)) contra++; }
        }
        if (contra && !agree) { t.contra++; contraFaces++; } else if (contra && agree) t.mixed++;
        if (flippedSet.has(id)) t.flipped++;
      }
      if (wrongFaces) problems.push(`${wrongFaces} faces off OCCT's geometry`);
      if (contraFaces) problems.push(`${contraFaces} faces whose normals contradict their loops`);
      for (const e of a.edges!) {
        if (e.entityId === null) continue;
        const t = tally(byEdgeType, curveType(ins, e.entityId), () => ({ edges: 0, withOff: 0, off: 0 }));
        t.edges++;
        let o = 0;
        for (let k = e.start; k < e.start + e.count; k++) if (!verts.has(`${a.edgePositions![3 * k]},${a.edgePositions![3 * k + 1]},${a.edgePositions![3 * k + 2]}`)) o++;
        if (o) { t.withOff++; t.off += o; }
      }
      if (flipped.length) { totals.partsFlipped++; totals.facesFlipped += flipped.length; problems.push(`${flipped.length} faces facing opposite to OCCT's: ${flipped.slice(0, 5).map((x) => `#${x}`).join(', ')}`); }
      // Workarounds.
      const fixed = num(a, /^(\d+) AXIS2_PLACEMENT_3Ds/);
      totals.placementsFixed += fixed; if (fixed) totals.partsPlacementsFixed++;
      const reversed = a.diagnostics.filter((d) => /^shell #\d+ reversed/.test(d.message));
      totals.shellsReversed += reversed.length;
      if (reversed.length) problems.push(reversed.map((d) => d.message).join('; '));
      totals.shellsOpen += num(a, /^orientation of (\d+) solid shells not checked, since their meshes/);
      totals.shellsInconsistent += num(a, /^orientation of (\d+) solid shells not checked, since their faces/);
    }
    if (!(a instanceof Error)) {
      totals.curves3d += num(a, /^(\d+) SURFACE_CURVEs read/); totals.tori += num(a, /^(\d+) TOROIDAL_SURFACEs/); totals.cones += num(a, /^(\d+) CONICAL_SURFACE semi-angles/);
      totals.nanEdges += num(a, /^(\d+) edges whose curves truck evaluates to NaN/); totals.nanFaces += num(a, /^(\d+) faces whose surfaces truck evaluates to NaN/);
      totals.unread += num(a, /^(\d+) instances truck's parser can't read/);
    }
    if (status === 'ok' && !problems.some((x) => /missing|off OCCT's geometry/.test(x))) totals.partsComplete++;
    if (problems.length) {
      rows.push(`${where}: ${problems.join(' | ')}`);
      if (dump) fs.writeFileSync(path.join(dump, `${path.basename(name)}.${req.rootId}.stp`), req.data);
    }
  }
  // The validation property, for files with one root.
  try {
    const sem = extractSemantics(await openModel(parseStep(bytes)));
    if (sem.structure.roots.length === 1) {
      const root = sem.structure.products[sem.structure.roots[0]!]!;
      const props = sem.validation.filter((v) => v.target.kind === 'product' && v.target.product === root.id).flatMap((v) => v.values);
      const declared = (props.find((v) => v.name.toLowerCase() === 'surface area measure') ?? props.find((v) => v.representation.toLowerCase() === 'surface area'))?.measure;
      if (declared !== undefined && declared > 0) {
        const placed = (m: Map<number, R>) => {
          let s = 0, all = true;
          for (const pi of partInstances(scene)) {
            if (!pi.visible) continue;
            const r = m.get(pi.part);
            if (!r) { all = false; continue; }
            const t = pi.transform;
            const det = t[0]! * (t[5]! * t[10]! - t[6]! * t[9]!) - t[4]! * (t[1]! * t[10]! - t[2]! * t[9]!) + t[8]! * (t[1]! * t[6]! - t[2]! * t[5]!);
            s += area(r) * Math.abs(det) ** (2 / 3);
          }
          return all ? s * 1e-6 : NaN; // mm² to m²
        };
        const si = declared;
        const [at, ao] = [placed(meshes.truck), placed(meshes.occt)];
        if (!Number.isNaN(ao)) {
          totals.validation.files++;
          const within = (x: number) => Math.abs(x / si - 1) <= 0.01;
          totals.validation.occt[1]!++; if (within(ao)) totals.validation.occt[0]!++;
          totals.validation.truck[1]!++; if (!Number.isNaN(at) && within(at)) totals.validation.truck[0]!++;
          if (!within(at) || !within(ao)) rows.push(`${name}: surface area validation property ${si.toPrecision(6)} m²: truck ${Number.isNaN(at) ? 'incomplete' : `${((at / si - 1) * 100).toFixed(2)}%`}, OCCT ${((ao / si - 1) * 100).toFixed(2)}%`);
        }
      }
    }
  } catch (e) {
    rows.push(`${name}: validation check failed: ${(e as Error).message}`);
  }
  process.stderr.write(`[${fi + 1}/${files.length}] ${name}: ${parts.length} parts, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
}
truck.dispose();
occt.dispose();

const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(1) : '0'}%)`;
const T = totals;
console.log(`truck against OCCT, ${TOL_MM} mm: ${T.files} files (${T.skippedBig} over ${maxBytes / 1e6} MB skipped), ${T.parts} brep parts; OCCT meshes ${T.compared} (${T.occtEmpty} empty or failed, not compared)`);
console.log(`  truck status: ${Object.entries(T.status).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`  area against OCCT (truck ok): ${Object.entries(T.area).map(([k, n]) => `${k === 'worse' ? '> 5%' : `within ${k}`} ${n}`).join(', ')}`);
console.log(`  faces: ${pct(T.facesMissing, T.facesOcct)} of OCCT's missing (${T.facesUnmeshed} failed to mesh, ${T.facesUnconverted} not converted), ${T.facesExtra} extra`);
console.log(`  edge kinds: ${pct(T.edgeKindDiff, T.edgesCompared)} differ; edge points off the mesh: ${pct(T.edgePointsOff, T.edgePoints)}, in ${T.partsOffMesh} parts`);
console.log(`  orientation: ${T.facesFlipped} faces in ${T.partsFlipped} parts facing opposite to OCCT's`);
console.log(`  complete and on OCCT's geometry (truck ok, no face missing or off): ${pct(T.partsComplete, T.compared)} parts`);
console.log(`  workarounds: ${T.placementsFixed} placements fixed in ${T.partsPlacementsFixed} parts; ${T.curves3d} surface curves read by their 3D curve; ${T.tori} tori with negative radii; ${T.cones} cone angles converted to radians; ${T.unread} unreadable instances left out`);
console.log(`    ${T.nanEdges} edges and ${T.nanFaces} faces evaluating to NaN left out; ${T.shellsReversed} shells reversed; solid shells not checked: ${T.shellsOpen} open meshes, ${T.shellsInconsistent} with faces disagreeing`);
console.log(`  surface area validation property, within 1%: truck ${pct(T.validation.truck[0]!, T.validation.truck[1]!)}, OCCT ${pct(T.validation.occt[0]!, T.validation.occt[1]!)}, in ${T.validation.files} files`);
if (panics.size) {
  console.log('  panics:');
  for (const [k, n] of [...panics].sort((x, y) => y[1] - x[1])) console.log(`    ${n} × ${k}`);
}
console.log(`  faces by surface type (parts truck meshes; OCCT's faces). Geometry, sampled vertices within 2 x tolerance: ok;`);
console.log(`  truck off OCCT's face (wrong or extra surface); OCCT's off truck's (part missing). Normals against the loops:`);
console.log(`  contradict, mixed. Facing opposite to OCCT's.`);
console.log(`    ${'type'.padEnd(32)} ${['faces', 'missing', 'ok', 'wrong', 'short', 'contra', 'mixed', 'vsOCCT'].map((h) => h.padStart(7)).join(' ')}`);
for (const [k, t] of [...byFaceType].sort((x, y) => y[1].faces - x[1].faces)) console.log(`    ${k.padEnd(32)} ${[t.faces, t.missing, t.ok, t.wrong, t.short, t.contra, t.mixed, t.flipped].map((x) => String(x).padStart(7)).join(' ')}`);
console.log('  edges by curve type (truck ok): edges, edges with points off the mesh, points off');
for (const [k, t] of [...byEdgeType].sort((x, y) => y[1].edges - x[1].edges)) console.log(`    ${k.padEnd(40)} ${String(t.edges).padStart(7)} ${String(t.withOff).padStart(6)} ${String(t.off).padStart(7)}`);
console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s, ${workers} workers per backend`);
console.log();
for (const r of rows) console.log(r);
