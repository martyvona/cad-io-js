// Importers' plan, phase 4 (the user, 2026-10-29): every corpus file imported, tessellated with our OCCT backend
// (a tess-workers pool, 0.1 mm, 0.5 rad, edges), exported with extras in each form below, read back with our
// importers (threejs-import, gltf-import), and compared with what was written by cad-scene's viewDifferences:
// placement by placement, names along the tree, visibility, every triangle's corners in the world with its face id
// and colour, every shared and free edge, curve and point. The imported scene must also be valid.
//
//   json           three.js JSON (lossless: to 1e-4 mm)
//   glb            GLB uncompressed, hidden placements written (KHR_node_visibility): lossless
//   glb-draco      GLB with Draco, hidden placements left out (the exporter's defaults): within Draco's step, 14
//                  bits over the largest part mesh's extent, hidden placements not compared (the file has none)
//   glb-meshopt    GLB with meshopt: 16 bits over the largest part mesh's volume
//   glb-instanced  GLB uncompressed with GPU instancing: within float32 rounding of the instances' transforms at the
//                  model's reach (8 steps)
//
// PLANT=move|colour|hide|edge perturbs every imported scene (a vertex of its first triangle mesh moved 1 mm, its
// first material's red changed, its first placed part hidden, an edge dropped), to show the check fails then.
// Usage: node --max-old-space-size=12000 corpus_checks/roundtrip_corpus.ts [file-list.txt] [max MB, default 2]
// (progress on standard error)

import fs from 'node:fs';
import os from 'node:os';
import { exportView, identity, multiply, pruneView, tessellateScene, validate, viewDifferences, type ExportView,
  type Mat4, type Scene } from '../packages/cad-scene/src/index.ts';
import { glb, type GltfOptions } from '../packages/export-gltf/src/index.ts';
import { threejsChunks } from '../packages/export-threejs/src/index.ts';
import { importGltf } from '../packages/gltf-import/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { importThreejs } from '../packages/threejs-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
  export: 'OcctTessellator' }, workers, timeoutMs: 60_000 });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
const STRING_LIMIT = 2 ** 29 - 24;
const plant = process.env.PLANT;
const meshing = { linearDeflection: 0.1, angularDeflection: 0.5 };
const opts = { ...meshing, edges: true, curves: true };

const FORMS = ['json', 'glb', 'glb-draco', 'glb-meshopt', 'glb-instanced'] as const;
type Form = typeof FORMS[number];
const GLTF: Record<Exclude<Form, 'json'>, GltfOptions> = {
  'glb': { compression: 'none', hidden: 'extension' },
  'glb-draco': { compression: 'draco' },
  'glb-meshopt': { compression: 'meshopt', hidden: 'extension' },
  'glb-instanced': { compression: 'none', hidden: 'extension', instancing: true },
};
const totals = Object.fromEntries(FORMS.map((f) => [f, { files: 0, same: 0, invalid: 0, failed: 0, notLoaded: 0,
  exportMs: 0, importMs: 0, bytes: 0 }])) as Record<Form, { files: number; same: number; invalid: number;
  failed: number; notLoaded: number; exportMs: number; importMs: number; bytes: number }>;
const problems: string[] = [];
let files = 0, skipped = 0;

/**
 * The largest placed part mesh's extent, millimetres in the world (each placement's scale applied), and how far from
 * the origin anything placed reaches.
 */
function largest(view: ExportView): { extent: number; reach: number } {
  let most = 0, reach = 0;
  const walk = (n: ExportView['roots'][number], parent: Mat4) => {
    const t = multiply(parent, n.transform);
    for (const p of n.parts) {
      const w = multiply(t, p.transform), scale = Math.hypot(w[0]!, w[1]!, w[2]!);
      const m = view.looks[p.look]!.mesh;
      const all = [m.positions, m.edgePositions, m.curvePositions, m.points].filter((a) => a?.length) as Float32Array[];
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const a of all) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, a[i + k]!); hi[k] = Math.max(hi[k]!, a[i + k]!);
      }
      if (lo[0]! > hi[0]!) continue;
      most = Math.max(most, scale * Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!));
      const local = Math.max(...[0, 1, 2].map((k) => Math.max(Math.abs(lo[k]!), Math.abs(hi[k]!))));
      reach = Math.max(reach, Math.hypot(w[12]!, w[13]!, w[14]!) + scale * Math.sqrt(3) * local);
    }
    n.children.forEach((c) => walk(c, t));
  };
  view.roots.forEach((r) => walk(r, identity()));
  return { extent: most, reach };
}

/** The planted bug, if any, in an imported scene. */
function perturb(s: Scene): void {
  if (!plant) return;
  const part = s.parts.find((p) => p.lods[0]?.mesh.indices.length);
  if (plant === 'move' && part) {
    const m = part.lods[0]!.mesh;
    m.positions[m.indices[0]! * 3] = m.positions[m.indices[0]! * 3]! + 1;
  }
  if (plant === 'colour' && s.materials[0]) s.materials[0].color = [(s.materials[0].color[0] + 0.5) % 1,
    s.materials[0].color[1], s.materials[0].color[2]];
  if (plant === 'hide' && s.roots.length) s.overrides.push({ path: [0], visible: false, sources: [] });
  if (plant === 'edge') {
    const e = s.parts.find((p) => p.lods[0]?.mesh.edges?.some((x) => x.kind === 'shared' || x.kind === 'free'));
    const m = e?.lods[0]!.mesh;
    if (m) m.edges = m.edges!.filter((x, i, all) => i !== all.findIndex((y) => y.kind === 'shared' ||
      y.kind === 'free'));
  }
}

const t0 = Date.now();
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { skipped++; continue; }
  const name = shortName(f);
  process.stderr.write(`${name}\n`);
  files++;
  const { scene } = await importStep(bytes);
  await tessellateScene(scene, tess, { ...meshing, edges: true, concurrency: workers });
  const view = exportView(scene, opts);
  if (!view.roots.length) continue;
  const { extent, reach } = largest(view);
  for (const form of FORMS) {
    const t = totals[form];
    t.files++;
    const problem = (msg: string) => { if (problems.length < 300) problems.push(`${form} ${name}: ${msg}`); };
    try {
      let back: Scene;
      const te = performance.now();
      if (form === 'json') {
        const chunks: string[] = [];
        let length = 0;
        for (const c of threejsChunks(scene, view, { extras: true })) { chunks.push(c); length += c.length; }
        t.exportMs += performance.now() - te;
        t.bytes += length;
        if (length > STRING_LIMIT) { t.notLoaded++; continue; }
        const ti = performance.now();
        back = importThreejs(chunks.join('')).scene;
        t.importMs += performance.now() - ti;
      } else {
        const out = await glb(scene, view, { extras: true, ...GLTF[form] });
        t.exportMs += performance.now() - te;
        t.bytes += out.bytes.length;
        const ti = performance.now();
        back = (await importGltf(out.bytes)).scene;
        t.importMs += performance.now() - ti;
      }
      perturb(back);
      const invalid = validate(back);
      if (invalid.length) { t.invalid++; problem(`invalid: ${invalid.slice(0, 3).join('; ')}`); }
      const o = GLTF[form as Exclude<Form, 'json'>];
      // What the file was meant to hold: the tree without empty nodes, hidden placements only where written.
      const written = pruneView(view, o?.hidden === 'extension' || form === 'json' ? undefined : (p) => p.visible);
      // Draco's step: 14 bits over a part mesh's extent; meshopt's 16 over its volume; doubled for rounding at both
      // ends, and the default 1e-4 mm for the lossless forms.
      // Instancing's transforms are float32 translation, rotation and scale: a few float32 steps at the model's reach.
      const tolerance = form === 'glb-draco' ? 2 * extent / 16383 : form === 'glb-meshopt' ? 2 * extent / 65535
        : form === 'glb-instanced' ? Math.max(1e-4, 8 * reach * 2 ** -24) : undefined;
      const d = viewDifferences({ scene, view: written }, { scene: back, view: exportView(back, opts) },
        { tolerance, skipHidden: form === 'glb-draco', max: 3 });
      if (d.length) problem(d.join(' | ').slice(0, 600));
      else t.same++;
    } catch (e) {
      t.failed++;
      problem(`threw: ${(e as Error).stack?.slice(0, 300)}`);
    }
  }
}
tess.dispose();

console.log(`${files} files (${skipped} over the size limit), ${((Date.now() - t0) / 1000).toFixed(0)} s` +
  (plant ? `, PLANT=${plant}` : ''));
for (const form of FORMS) {
  const t = totals[form];
  console.log(`${form.padEnd(14)} ${t.same} of ${t.files} the same; ${t.invalid} invalid, ${t.failed} threw` +
    `${t.notLoaded ? `, ${t.notLoaded} too large to load` : ''}; ${(t.bytes / 1e6).toFixed(1)} MB, export ` +
    `${(t.exportMs / 1000).toFixed(1)} s, import ${(t.importMs / 1000).toFixed(1)} s`);
}
console.log(`problems ${problems.length}`);
for (const p of problems) console.log(`  ${p}`);
