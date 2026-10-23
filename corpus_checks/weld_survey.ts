// Phase 4 step 5 (3MF), before the exporter: how many of our OCCT backend's part meshes become closed, oriented
// manifolds when their vertices are welded, as 3MF's model objects must be. Each corpus file is imported and its parts
// tessellated (a tess-workers pool, 0.1 mm; the meshes as the backend gives them, without tessellateScene's turning
// of inside-out shells); each part mesh with triangles is welded by position, exactly (equal
// float32 coordinates) and within tolerances relative to its bounding box's diagonal, and then classified:
//   - closed: every edge in exactly two triangles, once in each direction;
//   - open: some edge in one triangle only (a boundary), none in more than two;
//   - misoriented: every edge in at most two triangles, but some edge twice in the same direction;
//   - non-manifold: some edge in three or more triangles;
// each also split by whether the B-rep has free edges (edges of one face: an open shell in the file itself);
// and triangles that welding made degenerate (two corners merged) are counted and dropped before classifying.
// Usage: node corpus_checks/weld_survey.ts [file-list.txt] [max MB, default 2]  (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { tessellateScene, type Mesh } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator(
  { backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
  export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;

/**
 * Welded vertex per vertex: exact (tol 0) by coordinates, else within tol (a grid of tol-sized cells, 27 neighbours).
 */
function weld(p: Float32Array, tol: number): Uint32Array {
  const n = p.length / 3;
  const out = new Uint32Array(n);
  const map = new Map<string, number>();
  if (tol === 0) {
    for (let i = 0; i < n; i++) {
      // + 0 makes −0 equal 0.
      const key = `${p[3 * i]! + 0},${p[3 * i + 1]! + 0},${p[3 * i + 2]! + 0}`;
      const w = map.get(key);
      if (w === undefined) { map.set(key, i); out[i] = i; } else out[i] = w;
    }
    return out;
  }
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const x = p[3 * i]!, y = p[3 * i + 1]!, z = p[3 * i + 2]!;
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol), cz = Math.floor(z / tol);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (
      let dz = -1; dz <= 1 && found < 0; dz++) {
      for (const j of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (Math.abs(p[3 * j]! - x) <= tol && Math.abs(p[3 * j + 1]! - y) <= tol && Math.abs(
          p[3 * j + 2]! - z) <= tol) { found = j; break; }
      }
    }
    if (found >= 0) out[i] = found;
    else {
      out[i] = i;
      const key = `${cx},${cy},${cz}`;
      const c = cells.get(key);
      if (c) c.push(i); else cells.set(key, [i]);
    }
  }
  return out;
}

type Kind = 'closed' | 'open' | 'misoriented' | 'non-manifold';
function classify(mesh: Mesh, tol: number): { kind: Kind; degenerate: number; boundary: number; nonManifold: number;
  vertices: number } {
  const w = weld(mesh.positions, tol);
  // Each edge as (lower vertex × count + higher) × 2 + direction, sorted, so an edge's uses are adjacent (a Map
  // tops out at 2^24 entries).
  const nv = mesh.positions.length / 3;
  const ix = mesh.indices;
  const keys = new Float64Array(ix.length);
  let n = 0, degenerate = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = w[ix[t]!]!, b = w[ix[t + 1]!]!, c = w[ix[t + 2]!]!;
    if (a === b || b === c || c === a) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) keys[n++] = (u < v ? u * nv + v : v * nv + u) * 2 + (
      u < v ? 0 : 1);
  }
  const sorted = keys.subarray(0, n).sort();
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (let i = 0; i < n;) {
    const edge = Math.floor(sorted[i]! / 2);
    let fwd = 0, back = 0;
    for (; i < n && Math.floor(sorted[i]! / 2) === edge; i++) if (sorted[i]! % 2) back++; else fwd++;
    if (fwd + back === 1) boundary++;
    else if (fwd + back > 2) nonManifold++;
    else if (fwd !== 1) misoriented++;
  }
  const kind: Kind = nonManifold ? 'non-manifold' : boundary ? 'open' : misoriented ? 'misoriented' : 'closed';
  return { kind, degenerate, boundary, nonManifold, vertices: new Set(w).size };
}

const tolerances: [string, (m: Mesh) => number][] = [
  ['exact', () => 0],
  ['1e-7 diag', (m) => 1e-7 * diag(m)],
  ['1e-5 diag', (m) => 1e-5 * diag(m)],
];
function diag(m: Mesh): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k]!, m.positions[i]!);
    hi[k] = Math.max(hi[k]!, m.positions[i]!); }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

const tally = tolerances.map(() => (
  { closed: 0, open: 0, misoriented: 0, 'non-manifold': 0, degenerateParts: 0,
  degenerate: 0 } as Record<string, number>));
const examples = tolerances.map(() => new Map<string, string[]>());
let parts = 0, files = 0, skipped = 0, triangles = 0, vertices = 0, welded = 0;
const t0 = Date.now();
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { skipped++; continue; }
  const name = shortName(f);
  process.stderr.write(`${name}\n`);
  files++;
  const { scene } = await importStep(bytes);
  const { meshes } = await tessellateScene(scene, tess,
    { linearDeflection: 0.1, angularDeflection: 0.5, edges: true, concurrency: workers, orient: false,
    dropDegenerate: false });
  for (const [part, mesh] of meshes) {
    if (!mesh.indices.length) continue;
    parts++;
    triangles += mesh.indices.length / 3;
    vertices += mesh.positions.length / 3;
    tolerances.forEach(([label, tol], k) => {
      const r = classify(mesh, tol(mesh));
      if (k === 0) welded += r.vertices;
      tally[k]![r.kind]!++;
      const free = mesh.edges?.some((e) => e.kind === 'free') ? 'free' : 'no free';
      tally[k]![`${r.kind}, ${free}`] = (tally[k]![`${r.kind}, ${free}`] ?? 0) + 1;
      if (r.degenerate) { tally[k]!.degenerateParts!++; tally[k]!.degenerate! += r.degenerate; }
      const ex = examples[k]!.get(r.kind) ?? [];
      if (r.kind !== 'closed' && ex.length < 8) ex.push(
        `${name} part ${part} (${scene.parts[part]!.name ?? ''}): ${r.boundary} boundary, ${r.nonManifold} `
        + `non-manifold edges, ${r.degenerate} degenerate`);
      examples[k]!.set(r.kind, ex);
      void label;
    });
  }
}
tess.dispose();

console.log(`files ${files} (${skipped} over ${maxBytes / 1e6} MB skipped), `
  + `${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`part meshes with triangles ${parts}, triangles ${triangles}, vertices ${vertices} (${welded} after `
  + `exact welding)`);
tolerances.forEach(([label], k) => {
  const t = tally[k]!;
  console.log(`${label}, by B-rep free edges: `
    + `${Object.entries(t).filter(([key]) => key.includes(',')).sort().map(([key, n]) => `${key} ${n}`).join('; ')}`);
  console.log(`${label}: closed ${t.closed}, open ${t.open}, misoriented ${t.misoriented}, non-manifold `
    + `${t['non-manifold']}; degenerate triangles ${t.degenerate} in ${t.degenerateParts} parts`);
  for (const [kind, ex] of examples[k]!) if (ex.length) { console.log(`  ${kind}, e.g.:`);
    for (const e of ex) console.log(`    ${e}`); }
});
