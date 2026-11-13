// Phase 4 step 6: every corpus file through stepconv, with its defaults, in each format (three.js JSON, GLB, glTF with
// its .bin, 3MF): stepconv's main in this process for every file, and the bin spawned for a sample. Each file is also
// imported and tessellated here (as stepconv's defaults: tess-workers pools of OCCT with SMLib its fallback, each
// cached, the medium profile, no edges or curves) for the export view each output should come from; then, per format:
//   - exit 0, nothing on standard output, and the summary's parts, tessellated parts, placed parts and triangles
//     those of the scene and the view;
//   - the output read back with that format's own tools: three.js's ObjectLoader; the Khronos glTF-Validator (its
//     errors are problems; it knows no Draco) and glTF-Transform with the Draco decoder for GLB and for glTF with its
//     .bin; lib3mf in strict mode for 3MF;
//   - its placed parts, in tree order, with their names and triangle counts (the defaults write no extras, so no part
//     indices), as the format's defaults have them: three.js every placed part with triangles, hidden ones invisible;
//     glTF the visible ones; 3MF the visible ones whose
//     welded mesh is a closed, oriented manifold of positive volume (the others are left out with warnings);
//   - in the sample, the bin's outputs byte-identical to main's, its exit code, standard output and summary (but
//     for times) the same; its wall time against the summary's times gives the startup.
// Prints, per format, sizes and the summary's import, tessellation and export times. Several files at once
// (runner.ts: CHILDREN, MESH_WORKERS), stepconv given --workers to fit (its outputs don't depend on it; its times do).
// Usage:
//   node corpus_checks/stepconv_corpus.ts [file-list.txt] [max MB, default 2] [sample size, default 20]
//   (progress on standard error)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { NodeIO, type Document } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRNodeVisibility } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import validator from 'gltf-validator';
import * as THREE from 'three';
import { DEFAULT_MESH_PROFILE, exportView, FallbackTessellator, manifoldProblems, meshDeflections, placedName,
  tessellateScene, weld, type ExportNode, type ExportPart, type ExportView, type PartRef,
  type Scene } from '../packages/cad-scene/src/index.ts';
import { stepconv } from '../packages/cli/src/stepconv.ts';
import { read3mf } from '../packages/export-3mf/test/read3mf.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { cachedMesher, reportMeshCache, stepconvCacheArgs } from './mesh-cache.ts';
import { corpusFiles, repoDir, shortName } from './corpus.ts';
import { runFiles, type FileCheck } from './runner.ts';

const BIN = path.join(repoDir, 'packages/cli/bin/stepconv.ts');
const FORMATS = ['json', 'glb', 'gltf', '3mf'] as const;
type Format = typeof FORMATS[number];
const zero = () => ({ bytes: 0, import: 0, tessellate: 0, export: 0, wall: 0, parts: 0, triangles: 0 });

/** One file's results. */
interface Result {
  placed: number; hidden: number; notSolid: number; triangles: number; sampled: number; startup: number[];
  totals: Record<Format, ReturnType<typeof zero>>; issues: [string, number][]; problems: string[];
  /** Outputs too large to read back (three.js JSON past V8's longest string). */
  tooLarge: string[];
  runs: [number, Format][];
}

// The process's own: its meshing pool and workers, its glTF reader, its directory for outputs.
let tess: FallbackTessellator, workers = 1, gltfIo: NodeIO, dir = '', binDir = '';

/** A stepconv summary's numbers. */
interface Summary { parts: number; meshed: number; brep: number; placed: number; triangles: number; import: number;
  tessellate: number; export: number }
function parseSummary(text: string): Summary | undefined {
  const a = new RegExp(String.raw`^(\d+) parts \((\d+) of (\d+) brep parts tessellated\), (\d+) placed; `
    + String.raw`(\d+) triangles; [\d.]+ MB written$`, 'm').exec(text);
  // (The meshing profile or settings in parentheses after the tessellation's time.)
  const b = /^import ([\d.]+) s, tessellation ([\d.]+) s(?: \([^)]*\))?, export ([\d.]+) s$/m.exec(text);
  if (!a || !b) return undefined;
  const [parts, meshed, brep, placed, triangles] = a.slice(1).map(Number) as [number, number, number, number, number];
  return { parts, meshed, brep, placed, triangles, import: Number(b[1]), tessellate: Number(b[2]),
    export: Number(b[3]) };
}

/** Text collected from a stream. */
function sink(): { stream: Writable; text: () => string } {
  const parts: Buffer[] = [];
  const stream = new Writable({ write(c, _e, done) { parts.push(Buffer.from(c)); done(); } });
  return { stream, text: () => Buffer.concat(parts).toString() };
}

/** The placed parts with triangles, in tree order: part index, triangles, visibility, and for 3MF whether a solid. */
function placedParts(view: ExportView, scene: Scene): { part: number; ref: PartRef; triangles: number; visible: boolean;
  solid: boolean }[] {
  const solid = new Map<number, boolean>();
  const isSolid = (l: number) => {
    let s = solid.get(l);
    if (s === undefined) {
      const look = view.looks[l]!;
      const w = weld(look.mesh.positions);
      const tris = Uint32Array.from(look.indices, (v) => w.remap[v]!);
      // (And not said to be open by the source: then never a model.)
      solid.set(l, (s = manifoldProblems(w.positions, tris).length === 0 &&
        scene.parts[look.part]!.closed !== false));
    }
    return s;
  };
  const out: ReturnType<typeof placedParts> = [];
  const place = (p: ExportPart) => {
    const look = view.looks[p.look]!;
    if (look.indices.length) out.push({ part: look.part, ref: p.ref, triangles: look.indices.length / 3,
      visible: p.visible, solid: isSolid(p.look) });
  };
  const walk = (n: ExportNode) => {
    n.parts.forEach(place);
    n.children.forEach(walk);
  };
  // (The scene's root parts first, as the exporters write them.)
  view.parts.forEach(place);
  view.roots.forEach(walk);
  return out;
}

/** A glTF's part nodes (those with triangles), in tree order, with their names and triangles. */
function gltfParts(doc: Document): { name: string; triangles: number }[] {
  const out: { name: string; triangles: number }[] = [];
  const visit = (n: ReturnType<Document['createNode']>) => {
    let triangles = 0;
    for (const p of n.getMesh()?.listPrimitives() ?? []) if (
      p.getMode() === 4) triangles += p.getIndices()!.getCount() / 3;
    if (triangles) out.push({ name: n.getName(), triangles });
    n.listChildren().forEach(visit);
  };
  for (const s of doc.getRoot().listScenes()) s.listChildren().forEach(visit);
  return out;
}

async function validate(bytes: Uint8Array, problem: (m: string) => void, issues: Map<string, number>,
  resource?: (uri: string) => Promise<Uint8Array>): Promise<void> {
  const report = await validator.validateBytes(bytes,
    { maxIssues: 0, ignoredIssues: [], ...(resource ? { externalResourceFunction: resource } : {}) });
  for (const m of report.issues.messages) {
    const key = `${['error', 'warning', 'info', 'hint'][m.severity]} ${m.code}`;
    issues.set(key, (issues.get(key) ?? 0) + 1);
    if (m.severity === 0) problem(`validator: ${m.code} ${m.message} at ${m.pointer}`);
  }
}

/** The output's placed parts and triangles, read back with the format's own tools. */
const STRING_LIMIT = 2 ** 29 - 24;
async function readBack(format: Format, file: string, problem: (m: string) => void, issues: Map<string, number>):
  Promise<{ name?: string; triangles: number; visible?: boolean }[] | undefined> {
  if (format === 'json') {
    // (A file longer than V8's longest string can't be read back whole: said, not compared.)
    if (fs.statSync(file).size > STRING_LIMIT) return undefined;
    const root = new THREE.ObjectLoader().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const out: { name: string; triangles: number; visible: boolean }[] = [];
    root.traverse((o) => {
      if (Object.keys(o.userData).length) problem('json: userData without --extras');
      if ((o as THREE.Mesh).isMesh) out.push(
        { name: o.name, triangles: (o as THREE.Mesh).geometry.index!.count / 3, visible: o.visible });
    });
    return out;
  }
  if (format === 'glb' || format === 'gltf') {
    const bytes = fs.readFileSync(file);
    const dirOf = path.dirname(file);
    await validate(bytes, problem, issues,
      format === 'gltf' ? async (uri) => new Uint8Array(
      fs.readFileSync(path.join(dirOf, decodeURIComponent(uri)))) : undefined);
    const doc = await gltfIo.read(file);
    if (doc.getRoot().listNodes().some((n) => Object.keys(n.getExtras()).length)) problem(`${format}: extras without `
      + '--extras');
    return gltfParts(doc);
  }
  const read = await read3mf(fs.readFileSync(file));
  return read.items.map((it) => ({ triangles: (read.meshes.get(it.object)?.triangles.length ?? 0) / 3 }));
}

/** Runs the bin, as a user would. */
function spawn(args: string[]): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const t = performance.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { maxBuffer: 1 << 26 }, (e, stdout, stderr) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr, ms: performance.now() - t });
    });
  });
}

export const check: FileCheck<{ sample: boolean }, Result> = {
  async setup({ meshWorkers }) {
    workers = meshWorkers;
    const pool = (p: string, e: string) => cachedMesher(new WorkerTessellator({ backend: {
      module: import.meta.resolve(`../packages/${p}/src/index.ts`), export: e }, workers }));
    tess = new FallbackTessellator(pool('tess-occt', 'OcctTessellator'), pool('tess-smlib', 'SmlibTessellator'));
    await tess.init();
    gltfIo = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility, KHRDracoMeshCompression])
      .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepconv-corpus-'));
    // The bin writes into a directory of its own, under the same names (a .gltf names its .bin).
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
  },
  async file(f, job) {
    const r: Result = { placed: 0, hidden: 0, notSolid: 0, triangles: 0, sampled: 0, startup: [],
      totals: Object.fromEntries(FORMATS.map((x) => [x, zero()])) as Result['totals'], issues: [], problems: [],
      tooLarge: [], runs: [] };
    const issues = new Map<string, number>();
    const problem = (msg: string) => { r.problems.push(msg); };
    try {
      const { scene } = await importStep(fs.readFileSync(f));
      // (As stepconv meshes by default: its default profile, medium.)
      const deflections = meshDeflections({ profile: DEFAULT_MESH_PROFILE });
      const { meshes } = await tessellateScene(scene, tess,
        { ...deflections, concurrency: workers });
      const view = exportView(scene, { ...deflections, edges: false, curves: false });
      const placed = placedParts(view, scene);
      const brep = scene.parts.filter((p) => p.brep).length;
      let viewPlaced = 0, viewTriangles = 0;
      const walk = (n: ExportNode) => {
        for (const p of n.parts) { viewPlaced++;
        viewTriangles += view.looks[p.look]!.indices.length / 3; } n.children.forEach(walk); };
      walk({ parts: view.parts, children: view.roots } as ExportNode);
      r.placed = placed.length;
      r.hidden = placed.filter((p) => !p.visible).length;
      r.notSolid = placed.filter((p) => p.visible && !p.solid).length;
      r.triangles = viewTriangles;
      // (A placed part's node named as its placement.)
      const partName = (p: { ref: PartRef }) => placedName(scene, p.ref);
      const expected: Record<Format, { name?: string; triangles: number; visible?: boolean }[]> = {
        json: placed.map((p) => ({ name: partName(p), triangles: p.triangles, visible: p.visible })),
        glb: placed.filter((p) => p.visible).map((p) => ({ name: partName(p), triangles: p.triangles })),
        gltf: placed.filter((p) => p.visible).map((p) => ({ name: partName(p), triangles: p.triangles })),
        '3mf': placed.filter((p) => p.visible && p.solid).map((p) => ({ triangles: p.triangles })),
      };

      for (const format of FORMATS) {
        const out = path.join(dir, `model.${format}`);
        const stdout = sink(), stderr = sink();
        const t = performance.now();
        const code = await stepconv([f, '-o', out, '--workers', String(workers), ...stepconvCacheArgs()],
          { stdout: stdout.stream, stderr: stderr.stream, stdin: process.stdin });
        const wall = performance.now() - t;
        const fp = (m: string) => problem(`${format}: ${m}`);
        if (code !== 0) fp(`exit ${code}: ${stderr.text().split('\n')[0]}`);
        if (stdout.text()) fp('standard output not empty');
        const s = parseSummary(stderr.text());
        if (!s) { fp(`no summary: ${stderr.text().slice(0, 200)}`); continue; }
        const want = { parts: scene.parts.length, meshed: meshes.size, brep, placed: viewPlaced,
          triangles: viewTriangles };
        for (const [k, v] of Object.entries(want)) if (s[k as keyof Summary] !== v) fp(
          `summary ${k} ${s[k as keyof Summary]}, expected ${v}`);
        const tt = r.totals[format];
        tt.import += s.import; tt.tessellate += s.tessellate; tt.export += s.export; tt.wall += wall / 1000;
        const sidecar = path.join(dir, 'model.bin');
        tt.bytes += fs.statSync(out).size
          + (format === 'gltf' && fs.existsSync(sidecar) ? fs.statSync(sidecar).size : 0);
        r.runs.push([wall, format]);

        const got = await readBack(format, out, fp, issues);
        if (!got) { r.tooLarge.push(format); continue; }
        const e = expected[format];
        tt.parts += got.length;
        tt.triangles += got.reduce((n, p) => n + p.triangles, 0);
        if (got.length !== e.length) fp(`${got.length} placed parts, expected ${e.length}`);
        else got.forEach((g, k) => {
          const x = e[k]!;
          if (g.triangles !== x.triangles || g.name !== x.name || g.visible !== x.visible) fp(
            `placed part ${k}: ${JSON.stringify(g)}, expected ${JSON.stringify(x)}`);
        });

        if (job.sample) {
          const binOut = path.join(binDir, `model.${format}`);
          const b = await spawn([f, '-o', binOut, '--workers', String(workers), ...stepconvCacheArgs()]);
          const times = (x: string) => x.replace(/^import .*$/m, '');
          if (b.code !== code) fp(`bin exit ${b.code}, main ${code}`);
          if (b.stdout) fp('bin wrote standard output');
          if (times(b.stderr) !== times(stderr.text())) fp('bin summary differs from main');
          if (!fs.readFileSync(binOut).equals(fs.readFileSync(out))) fp('bin output differs from main');
          const binSidecar = path.join(binDir, 'model.bin');
          if (fs.existsSync(sidecar) !== fs.existsSync(binSidecar)) fp('bin sidecar presence differs');
          else if (fs.existsSync(sidecar) && !fs.readFileSync(binSidecar).equals(fs.readFileSync(sidecar))) fp(
            'bin sidecar differs');
          const rs = parseSummary(b.stderr);
          if (rs) r.startup.push(b.ms / 1000 - (rs.import + rs.tessellate + rs.export));
          if (format === FORMATS[0]) r.sampled++;
        }
        for (const d of [dir, binDir]) for (const x of fs.readdirSync(d)) if (x !== 'bin') fs.rmSync(path.join(d, x));
      }
    } catch (e) {
      problem(`failed: ${(e as Error).stack ?? e}`);
    }
    r.issues = [...issues];
    return r;
  },
  teardown() {
    reportMeshCache();
    tess.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  },
};

if (import.meta.main) {
  const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
  const sampleSize = Number(process.argv[4] ?? 20);
  const files = corpusFiles(process.argv[2]).filter((f) => fs.statSync(f).size <= maxBytes);
  const skipped = corpusFiles(process.argv[2]).length - files.length;
  // The sample: spread evenly over the list.
  const sample = new Set(Array.from({ length: Math.min(sampleSize, files.length) },
    (_, k) => files[Math.floor((k * files.length) / Math.min(sampleSize, files.length))]!));
  const totals = Object.fromEntries(FORMATS.map((f) => [f, zero()])) as Result['totals'];
  const counts = { files: 0, skipped, placed: 0, hidden: 0, notSolid: 0, triangles: 0, sampled: 0,
    startup: [] as number[], problems: 0 };
  const issues = new Map<string, number>();
  const problems: string[] = [];
  const tooLarge: string[] = [];
  const slowest: [number, string, Format][] = [];
  const t0 = Date.now();
  await runFiles(import.meta.url, check, files.map((f) => ({ path: f, job: { sample: sample.has(f) } })),
    process.argv.slice(2), (f, out) => {
      const name = shortName(f);
      counts.files++;
      const r = 'result' in out ? out.result : undefined;
      for (const msg of r ? r.problems : [`failed: ${'error' in out ? out.error : ''}`]) {
        counts.problems++;
        if (problems.length < 200) problems.push(`${name}: ${msg}`);
      }
      if (!r) return;
      counts.placed += r.placed; counts.hidden += r.hidden; counts.notSolid += r.notSolid;
      counts.triangles += r.triangles; counts.sampled += r.sampled; counts.startup.push(...r.startup);
      for (const x of FORMATS) for (const k of Object.keys(zero()) as (keyof ReturnType<typeof zero>)[]) {
        totals[x][k] += r.totals[x][k];
      }
      for (const [k, n] of r.issues) issues.set(k, (issues.get(k) ?? 0) + n);
      for (const x of r.tooLarge) tooLarge.push(`${name} ${x}`);
      for (const [ms, x] of r.runs) slowest.push([ms, name, x]);
    });

  const s1 = (x: number) => `${x.toFixed(1)} s`;
  console.log(`files ${counts.files} (${counts.skipped} over ${maxBytes / 1e6} MB skipped), `
    + `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`placed parts with triangles ${counts.placed} (${counts.hidden} hidden; ${counts.notSolid} visible ones `
    + `not closed solids); triangles placed ${counts.triangles}`);
  for (const format of FORMATS) {
    const t = totals[format];
    console.log(`${format}: ${(t.bytes / 1e6).toFixed(1)} MB, ${t.parts} placed parts, ${t.triangles} triangles; `
      + `import ${s1(t.import)}, tessellation ${s1(t.tessellate)}, export ${s1(t.export)}, main ${s1(t.wall)}`);
  }
  const st = counts.startup.sort((a, b) => a - b);
  if (st.length) console.log(`bin sample: ${counts.sampled} files x ${FORMATS.length} formats; startup (wall time less `
    + `the summary's times) median ${s1(st[st.length >> 1]!)}, range ${s1(st[0]!)}-${s1(st[st.length - 1]!)}`);
  console.log('validator issues (glb and gltf):');
  for (const [k, n] of [...issues].sort()) console.log(`  ${String(n).padStart(5)} ${k}`);
  console.log('slowest runs of main:');
  for (const [ms, name, format] of slowest.sort((a, b) => b[0] - a[0]).slice(0, 6)) console.log(
    `  ${s1(ms / 1000)}  ${format}  ${name}`);
  if (tooLarge.length) console.log(`too large to read back: ${tooLarge.join(', ')}`);
  console.log(`problems ${counts.problems}`);
  for (const p of problems) console.log(`  ${p}`);
}
