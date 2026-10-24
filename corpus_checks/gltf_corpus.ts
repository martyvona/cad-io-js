// Phase 4 step 4: GLB for every corpus file, checked with the Khronos glTF-Validator, read back with glTF-Transform
// and compared with the export view it was written from. Each file is imported, tessellated with our OCCT backend
// (a tess-workers pool, 0.1 mm, edges), and exported with edges, curves and hidden instances (KHR_node_visibility);
// then:
//   - the validator's errors are problems; its warnings, infos and hints are tallied by code;
//   - one node per placed part (extras.part), in tree order, hidden ones with KHR_node_visibility;
//   - each one's world matrix (composed from the nodes' local matrices) equals the root transform times the view's
//     (glTF-Transform keeps TRS, so this checks the decomposition too);
//   - its triangles and, per triangle, its material's base colour (linear) and alpha equal the look's groups';
//   - one faces' mesh per look; edges, curves and points in child nodes (identity transforms) with meshes of their
//     own, segment and point counts.
// That GLB is uncompressed, with extras. The same view is also written with Draco and with meshopt (both with
// extras), read back with their decoders, and compared with the view in world coordinates (2026-10-24):
//   - per placed part, its triangle primitives' count and per primitive its triangles;
//   - per face (Draco: by its _FACE vertex attribute, all three corners agreeing; meshopt: by its index range), its
//     triangles, their total area and the mean of their centroids, within what quantization allows (Draco: 14 bits
//     over the extent of the part mesh's vertex array, which glTF-Transform hands Draco whole for each primitive;
//     meshopt: 16 bits over the part mesh's extent, every position, the edges' too);
//   - edges, curves and points: each vertex in place (meshopt, within its 16 bits; Draco leaves them exact).
// Prints the GLB sizes and export and validation times. Usage:
//   node corpus_checks/gltf_corpus.ts [file-list.txt] [max MB, default 2]  (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { WebIO, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRDracoMeshCompression, KHRMaterialsUnlit, KHRMeshQuantization,
  KHRNodeVisibility } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import validator from 'gltf-validator';
import { MeshoptDecoder } from 'meshoptimizer';
import { exportView, identity, multiply, tessellateScene, type ExportNode, type Look,
  type Mat4 } from '../packages/cad-scene/src/index.ts';
import { glb } from '../packages/export-gltf/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator(
  { backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
  export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
const io = new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility]);
await MeshoptDecoder.ready;
const decoding = new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility, KHRDracoMeshCompression,
  EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder });
type V3 = [number, number, number];
const apply = (m: ArrayLike<number>, p: ArrayLike<number>): V3 => [0, 1, 2].map(
  (r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!) as V3;
/** The largest factor by which a matrix stretches a length. */
const stretch = (m: ArrayLike<number>) => Math.max(...[0, 4, 8].map((c) => Math.hypot(m[c]!, m[c + 1]!, m[c + 2]!)));
/** A face's triangles, as world corners: their count, total area, perimeter and the mean of their centroids. */
interface FaceStat { n: number; area: number; perimeter: number; centroid: V3 }
function faceStat(tris: V3[][]): FaceStat {
  let area = 0, perimeter = 0;
  const c: V3 = [0, 0, 0];
  for (const [a, b, d] of tris) {
    const u = [b![0] - a![0], b![1] - a![1], b![2] - a![2]], v = [d![0] - a![0], d![1] - a![1], d![2] - a![2]];
    area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    perimeter += Math.hypot(...u) + Math.hypot(...v) + Math.hypot(d![0] - b![0], d![1] - b![1], d![2] - b![2]);
    for (let k = 0; k < 3; k++) c[k] += (a![k]! + b![k]! + d![k]!) / 3 / tris.length;
  }
  return { n: tris.length, area, perimeter, centroid: c };
}
/**
 * Whether two faces' statistics agree when every corner may have moved by up to `delta` (world units): moving one
 * corner by delta changes a triangle's area by at most delta times the opposite edge's length over 2, so a face's
 * by at most delta times its perimeter (and a little second order), and the centroids' mean by at most delta.
 */
function sameFace(got: FaceStat, want: FaceStat, delta: number): string | undefined {
  if (got.n !== want.n) return `${got.n} triangles, expected ${want.n}`;
  const eps = 1e-12 * Math.max(1, ...want.centroid.map(Math.abs));
  if (Math.abs(got.area - want.area) > delta * want.perimeter + 3 * want.n * delta * delta + eps * want.perimeter) {
    return `area ${got.area}, expected ${want.area}`;
  }
  const d = Math.hypot(...got.centroid.map((x, k) => x - want.centroid[k]!));
  if (d > delta + eps) return `centroid off by ${d.toPrecision(3)} (allowed ${delta.toPrecision(3)})`;
  return undefined;
}
/** The view's faces of a group as world triangles (with `world` the placed part's world matrix). */
function expectedFaces(look: Look, g: Look['groups'][number], world: Mat4): FaceStat[] {
  const pos = look.mesh.positions;
  const corner = (v: number) => apply(world, pos.subarray(3 * v, 3 * v + 3));
  return look.faces.filter((f) => f.start >= g.start && f.start < g.start + g.count).map((f) => {
    const tris: V3[][] = [];
    for (let i = f.start; i < f.start + f.count; i += 3) tris.push(
      [corner(look.indices[i]!), corner(look.indices[i + 1]!), corner(look.indices[i + 2]!)]);
    return faceStat(tris);
  });
}
/** A part mesh's faces' extent in its units (the largest of its vertices' ranges along an axis). */
function faceExtent(look: Look): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const a = look.mesh.positions;
  for (let i = 0; i < a.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, a[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, a[i]!);
  }
  return Math.max(...[0, 1, 2].map((k) => hi[k]! - lo[k]!));
}
/** A part mesh's extent over every position it has, faces, edges, curves and points (meshopt's volume). */
function meshExtent(look: Look): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const m = look.mesh;
  for (const a of [m.positions, m.edgePositions, m.curvePositions, m.points]) {
    if (a) for (let i = 0; i < a.length; i++) { lo[i % 3] = Math.min(lo[i % 3]!, a[i]!);
      hi[i % 3] = Math.max(hi[i % 3]!, a[i]!); }
  }
  return Math.max(...[0, 1, 2].map((k) => hi[k]! - lo[k]!));
}
const compressedTotals = { draco: { bytes: 0, ms: 0, faces: 0 }, meshopt: { bytes: 0, ms: 0, faces: 0 } };

// The expectations, written out here rather than taken from the exporter: millimetres to metres and Z up to Y up
// ((x, y, z) -> (x, z, -y)), and the sRGB transfer function.
const ROOT: Mat4 = Float64Array.of(0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const totals = { files: 0, skipped: 0, nodes: 0, hidden: 0, meshes: 0, primitives: 0, triangles: 0, segments: 0,
  points: 0, bytes: 0, exportMs: 0, validateMs: 0, problems: 0, lineVertices: 0 };
const issues = new Map<string, { n: number; files: Set<string>; example: string }>();
const problems: string[] = [];
const biggest: [number, string, number][] = [];
const t0 = Date.now();
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { totals.skipped++; continue; }
  const name = shortName(f);
  process.stderr.write(`${name}\n`);
  totals.files++;
  const problem = (msg: string) => { totals.problems++; if (problems.length < 200) problems.push(`${name}: ${msg}`); };
  const { scene } = await importStep(bytes);
  const { meshes } = await tessellateScene(scene, tess,
    { linearDeflection: 0.1, angularDeflection: 0.5, edges: true, concurrency: workers });
  const view = exportView(scene, meshes, { edges: true, curves: true });

  const te = performance.now();
  const out = await glb(scene, view, { hidden: 'extension', compression: 'none', extras: true });
  const ms = performance.now() - te;
  totals.exportMs += ms;
  totals.bytes += out.bytes.length;
  biggest.push([out.bytes.length, name, ms]);
  if (out.diagnostics.length) problem(`diagnostics: ${out.diagnostics.map((d) => d.message).join('; ')}`);

  const tv = performance.now();
  const report = await validator.validateBytes(out.bytes, { maxIssues: 0, ignoredIssues: [] });
  totals.validateMs += performance.now() - tv;
  for (const m of report.issues.messages) {
    const sev = ['error', 'warning', 'info', 'hint'][m.severity]!;
    if (m.severity === 0) problem(`validator: ${m.code} ${m.message} at ${m.pointer}`);
    const key = `${sev} ${m.code}`;
    const e = issues.get(key) ?? { n: 0, files: new Set(), example: `${name} ${m.pointer ?? ''}: ${m.message}` };
    e.n++;
    e.files.add(name);
    issues.set(key, e);
  }

  const doc = await io.readBinary(out.bytes);
  // Expected, in tree order: each placed part's world matrix and look.
  const expected: { world: Mat4; look: number; visible: boolean }[] = [];
  const walk = (n: ExportNode, parent: Mat4) => {
    const t = multiply(parent, n.transform);
    for (const p of n.parts) expected.push({ world: multiply(t, p.transform), look: p.look, visible: p.visible });
    for (const c of n.children) walk(c, t);
  };
  for (const r of view.roots) walk(r, ROOT);
  // World matrices: each node's local matrix (from the TRS written) down the tree.
  const found: { node: Node; world: Mat4 }[] = [];
  const visit = (n: Node, parent: Mat4) => {
    const world = multiply(parent, Float64Array.from(n.getMatrix()));
    if ((n.getExtras() as { part?: number }).part !== undefined) found.push({ node: n, world });
    for (const c of n.listChildren()) visit(c, world);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) visit(n, identity());
  if (found.length !== expected.length) {
    problem(`${found.length} part nodes, expected ${expected.length}`); continue; }
  const meshesSeen = new Set<unknown>();
  found.forEach(({ node, world }, k) => {
    const e = expected[k]!;
    const look = view.looks[e.look]!;
    totals.nodes++;
    const part = (node.getExtras() as { part: number }).part;
    if (part !== look.part) problem(`node ${k}: part ${part}, expected ${look.part}`);
    const hidden = node.getExtension<{ getVisible(): boolean }>('KHR_node_visibility')?.getVisible() === false;
    if (hidden) totals.hidden++;
    if (hidden === e.visible) problem(`node ${k} (part ${look.part}): visibility differs`);
    const scale = Math.max(1, ...Array.from(e.world, Math.abs));
    const err = Math.max(...Array.from(world, (x, i) => Math.abs(x - e.world[i]!)));
    if (err > 1e-9 * scale) problem(
      `node ${k} (part ${look.part}): world matrix differs by ${err.toPrecision(3)} (largest entry `
      + `${scale.toPrecision(3)})`);
    const mesh = node.getMesh();
    const prims = mesh?.listPrimitives() ?? [];
    if (mesh) meshesSeen.add(mesh);
    const tris = prims.filter((p) => p.getMode() === 4);
    if (tris.length !== look.groups.length) {
      problem(`node ${k} (part ${look.part}): ${tris.length} triangle primitives, expected `
      + `${look.groups.length}`); return; }
    tris.forEach((p, g) => {
      const group = look.groups[g]!;
      const ix = p.getIndices()!.getArray()!;
      if (ix.length !== group.count || !ix.every((v, i) => v === look.indices[group.start + i])) problem(
        `node ${k} (part ${look.part}) group ${g}: indices differ`);
      if (p.getAttribute('POSITION')!.getArray() !== null && p.getAttribute(
        'POSITION')!.getCount() !== look.mesh.positions.length / 3) problem(
        `node ${k} group ${g}: vertex count differs`);
      const m = group.material === undefined ? undefined : scene.materials[group.material];
      const want = m ? [...m.color.map(linear), m.opacity] : [linear(0.8), linear(0.8), linear(0.8), 1];
      const got = p.getMaterial()!.getBaseColorFactor();
      if (!got.every((x, i) => Math.abs(x - want[i]!) < 1e-6)) problem(
        `node ${k} (part ${look.part}) group ${g}: colour ${got}, expected ${want}`);
      if ((m !== undefined && m.opacity < 1) !== (p.getMaterial()!.getAlphaMode() === 'BLEND')) problem(
        `node ${k} group ${g}: alpha mode`);
      totals.triangles += ix.length / 3;
      totals.primitives++;
    });
    if (prims.some((p) => p.getMode() !== 4)) problem(
      `node ${k} (part ${look.part}): lines or points in the faces' mesh`);
    for (const c of node.listChildren()) {
      const what = c.getName();
      if (!['edges', 'curves', 'points'].includes(what)) problem(`node ${k} (part ${look.part}): child ${what}`);
      if (!c.getMatrix().every((x, i) => x === (i % 5 === 0 ? 1 : 0))) problem(
        `node ${k} (part ${look.part}): ${what} not at the part's place`);
      for (const p of c.getMesh()?.listPrimitives() ?? []) {
        if (p.getMode() !== (what === 'points' ? 0 : 1)) problem(
          `node ${k} (part ${look.part}): ${what} in mode ${p.getMode()}`);
        if (p.getMode() === 1) totals.segments += p.getIndices()!.getCount() / 2;
        if (p.getMode() === 0) totals.points += p.getIndices()!.getCount();
      }
    }
  });
  totals.meshes += meshesSeen.size;
  const looksUsed = new Set(expected.filter((e) => view.looks[e.look]!.groups.length).map((e) => e.look));
  if (meshesSeen.size > looksUsed.size) problem(`${meshesSeen.size} meshes for ${looksUsed.size} looks`);

  // Compressed, read back with the decoders.
  for (const compression of ['draco', 'meshopt'] as const) {
    const cp = (msg: string) => problem(`${compression}: ${msg}`);
    const tc = performance.now();
    let bytes: Uint8Array;
    try {
      bytes = (await glb(scene, view, { hidden: 'extension', compression, extras: true })).bytes;
    } catch (e) { cp(`export: ${(e as Error).message}`); continue; }
    compressedTotals[compression].ms += performance.now() - tc;
    compressedTotals[compression].bytes += bytes.length;
    const cdoc = await decoding.readBinary(bytes);
    const parts: { node: Node; world: Mat4 }[] = [];
    const walkNodes = (n: Node, parent: Mat4) => {
      const world = multiply(parent, Float64Array.from(n.getMatrix()));
      if ((n.getExtras() as { part?: number }).part !== undefined) parts.push({ node: n, world });
      for (const c of n.listChildren()) walkNodes(c, world);
    };
    for (const sc of cdoc.getRoot().listScenes()) for (const n of sc.listChildren()) walkNodes(n, identity());
    if (parts.length !== expected.length) { cp(`${parts.length} part nodes, expected ${expected.length}`); continue; }
    parts.forEach(({ node, world }, k) => {
      const e = expected[k]!;
      const look = view.looks[e.look]!;
      const where = `node ${k} (part ${look.part})`;
      const tris = (node.getMesh()?.listPrimitives() ?? []).filter((p) => p.getMode() === 4);
      if (tris.length !== look.groups.length) { cp(`${where}: ${tris.length} triangle primitives, expected `
        + `${look.groups.length}`); return; }
      const s = stretch(e.world);
      const volumeStep = meshExtent(look) / 2 / 32767; // meshopt's step in the mesh's units
      tris.forEach((p, g) => {
        const group = look.groups[g]!;
        const want = expectedFaces(look, group, e.world);
        const step = compression === 'draco' ? faceExtent(look) / (2 ** 14 - 1) : volumeStep;
        const delta = (step / 2) * Math.sqrt(3) * s * 1.0001;
        const pos = p.getAttribute('POSITION')!, ix = p.getIndices()!;
        const e3 = [0, 0, 0];
        const corner = (v: number) => apply(world, pos.getElement(v, e3));
        const got: V3[][][] = want.map(() => []);
        if (compression === 'draco') {
          const fa = p.getAttribute('_FACE');
          if (!fa) { cp(`${where} group ${g}: no _FACE`); return; }
          for (let i = 0; i < ix.getCount(); i += 3) {
            const [a, b, c] = [ix.getScalar(i), ix.getScalar(i + 1), ix.getScalar(i + 2)];
            const j = fa.getScalar(a);
            if (fa.getScalar(b) !== j || fa.getScalar(c) !== j) { cp(`${where} group ${g}: a triangle's corners `
              + 'in different faces'); return; }
            if (!(j < want.length)) { cp(`${where} group ${g}: _FACE ${j} of ${want.length} faces`); return; }
            got[j]!.push([corner(a), corner(b), corner(c)]);
          }
        } else {
          const ranges = (p.getExtras() as { faces: { start: number; count: number }[] }).faces;
          if (ranges.length !== want.length) { cp(`${where} group ${g}: ${ranges.length} faces`); return; }
          ranges.forEach((f, j) => {
            for (let i = f.start; i < f.start + f.count; i += 3) got[j]!.push(
              [corner(ix.getScalar(i)), corner(ix.getScalar(i + 1)), corner(ix.getScalar(i + 2))]);
          });
        }
        want.forEach((w, j) => {
          const bad = sameFace(faceStat(got[j]!), w, delta);
          if (bad) cp(`${where} group ${g} face ${j}: ${bad}`);
        });
        compressedTotals[compression].faces += want.length;
      });
      // Lines and points: vertex for vertex.
      for (const c of node.listChildren()) {
        const what = c.getName() as 'edges' | 'curves' | 'points';
        const src = what === 'edges' ? look.mesh.edgePositions : what === 'curves' ? look.mesh.curvePositions
          : look.mesh.points;
        const p = c.getMesh()?.listPrimitives()[0];
        if (!src || !p) { cp(`${where}: ${what} missing`); continue; }
        const cw = multiply(world, Float64Array.from(c.getMatrix()));
        const pos = p.getAttribute('POSITION')!;
        if (pos.getCount() !== src.length / 3) { cp(`${where}: ${what} vertex count`); continue; }
        let big = 1;
        for (const x of src) big = Math.max(big, Math.abs(x));
        // (Rounding in the matrices, a little; a lone point's volume has no extent, so quantization adds nothing.)
        const delta = 1e-12 * s * big + (compression === 'draco' ? 0 : (volumeStep / 2) * Math.sqrt(3) * s * 1.0001);
        const e3 = [0, 0, 0];
        for (let v = 0; v < pos.getCount(); v++) {
          const a = apply(cw, pos.getElement(v, e3)), b = apply(e.world, src.subarray(3 * v, 3 * v + 3));
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (d > delta) { cp(`${where}: ${what} vertex ${v} off by ${d.toPrecision(3)}`); break; }
        }
        if (compression === 'meshopt') totals.lineVertices += pos.getCount();
      }
    });
  }
}
tess.dispose();

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`files ${totals.files} (${totals.skipped} over ${maxBytes / 1e6} MB skipped), `
  + `${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`part nodes ${totals.nodes} (${totals.hidden} hidden), meshes ${totals.meshes}, triangle primitives `
  + `${totals.primitives}, triangles ${totals.triangles}, segments ${totals.segments}, points ${totals.points}`);
console.log(`GLB ${mb(totals.bytes)} MB; export ${(totals.exportMs / 1000).toFixed(2)} s; validation `
  + `${(totals.validateMs / 1000).toFixed(2)} s`);
for (const [c, t] of Object.entries(compressedTotals)) console.log(`${c}: ${mb(t.bytes)} MB `
  + `(${(100 * t.bytes / totals.bytes).toFixed(1)}%), export ${(t.ms / 1000).toFixed(2)} s; faces checked ${t.faces}`
  + `${c === 'meshopt' ? `, line and point vertices ${totals.lineVertices}` : ''}`);
console.log('largest:');
for (const [n, f, ms] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(
  `  ${mb(n)} MB, ${(ms / 1000).toFixed(1)} s  ${f}`);
console.log('validator issues (count, files, code, an example):');
for (const [k, e] of [...issues].sort((a, b) => b[1].n - a[1].n)) console.log(
  `  ${String(e.n).padStart(8)} ${String(e.files.size).padStart(4)} ${k}  e.g. ${e.example}`);
console.log(`problems ${totals.problems}`);
for (const p of problems) console.log(`  ${p}`);
