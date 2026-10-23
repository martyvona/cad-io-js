// Phase 2 step 5: the whole path, end to end, against OCCT's own reading of the file. Each corpus file is imported
// (step-import), its parts tessellated with our OCCT backend (tess-occt, per-part subsets with origins), and placed
// (cad-scene's partInstances); the result is compared with occt-import-js's import of the whole file (OCCT's XCAF
// reader, meshes in world millimetres):
//   - geometry: sampled vertices of every placed part lie on OCCT's mesh surface, within the two meshes' deflections;
//   - colour: each sampled triangle's colour (part, face and instance materials resolved) matches the colour OCCT
//     gives the nearest of its triangles. OCCT's colours are linear RGB (Quantity_Color), ours sRGB as in the file.
// Usage: node corpus_checks/scene_occt.ts [file-list.txt] [max MB, default 2]  (progress per file on standard error)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { partInstances, tessellateScene } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { corpusDir, corpusFiles, shortName } from './corpus.ts';

const require = createRequire(import.meta.url);
const loadOcct = () => require(path.join(corpusDir, 'occt-import-js/dist/occt-import-js.js'))();
let occt = await loadOcct();
const tess = new OcctTessellator();
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
// Deflection on both sides: 1/1000 of the model's size (OCCT's bounding_box_ratio), in mm for ours.
const RATIO = 0.001;

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
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
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3);
      q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6);
      q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
    else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
  }
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const totals = { files: 0, skipped: 0, occtFailed: 0, parts: 0, meshes: 0, samples: 0, onSurface: 0, colourSamples: 0,
  colourMatch: 0 };
const rows: string[] = [];
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { totals.skipped++; continue; }
  const name = shortName(f);
  let res;
  try {
    res = occt.ReadStepFile(bytes,
      { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: RATIO,
      angularDeflection: 0.5 });
  } catch {
    occt = await loadOcct();
    res = { success: false };
  }
  if (!res.success || !res.meshes.length) { totals.occtFailed++; continue; }
  totals.files++;

  // OCCT's triangles in a grid, with their colours (face colour, else mesh colour, else none).
  interface Tri { a: V; b: V; c: V; colour: string }
  const tris: Tri[] = [];
  let size = 0;
  for (const mesh of res.meshes) {
    const p = mesh.attributes.position.array as number[], idx = mesh.index.array as number[];
    const faceColour: (string | undefined)[] = [];
    for (const bf of mesh.brep_faces ?? []) for (let t = bf.first; t <= bf.last; t++) faceColour[
      t] = bf.color ? bf.color.map((x: number) => x.toFixed(3)).join(',') : undefined;
    const meshColour = mesh.color ? mesh.color.map((x: number) => x.toFixed(3)).join(',') : 'none';
    for (let i = 0; i < idx.length; i += 3) {
      const v = (k: number): V => [p[idx[i + k]! * 3]!, p[idx[i + k]! * 3 + 1]!, p[idx[i + k]! * 3 + 2]!];
      const t = { a: v(0), b: v(1), c: v(2), colour: faceColour[i / 3] ?? meshColour };
      for (const x of [t.a, t.b, t.c]) size = Math.max(size, ...x.map(Math.abs));
      tris.push(t);
    }
  }
  const cell = Math.max(size / 64, 1e-6);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  tris.forEach((t, i) => {
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(t.a[k]!, t.b[k]!, t.c[k]!) / cell)),
    hi = [0, 1, 2].map((k) => Math.floor(Math.max(t.a[k]!, t.b[k]!, t.c[k]!) / cell));
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (
      let z = lo[2]!; z <= hi[2]!; z++) {
      let l = grid.get(key(x, y, z));
      if (!l) grid.set(key(x, y, z), (l = []));
      l.push(i);
    }
  });
  const normal = (a: V, b: V, c: V): V => {
    const u = sub(b, a), v = sub(c, a);
    const n: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  // The nearest triangle; with a normal, the nearest within `within` facing the same way (where assembly parts
  // touch, a point lies on both, and only the orientation tells them apart).
  const nearest = (p: V, n?: V, within = Infinity): { d: number; t?: Tri } => {
    const c = p.map((x) => Math.floor(x / cell));
    let best = Infinity, bt: Tri | undefined, bestAligned = Infinity, ba: Tri | undefined;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(key(c[0]! + dx, c[1]! + dy, c[2]! + dz)) ?? []) {
        const t = tris[i]!, d = triDist(p, t.a, t.b, t.c);
        if (d < best) { best = d; bt = t; }
        if (n && d <= within && d < bestAligned && dot(n, normal(t.a, t.b, t.c)) > 0.5) { bestAligned = d; ba = t; }
      }
    }
    return ba ? { d: bestAligned, t: ba } : { d: best, t: bt };
  };

  // The model's diagonal, from OCCT's meshes, for the deflection.
  let lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const x of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, x[k]!);
    hi[k] = Math.max(hi[k]!, x[k]!); }
  const deflection = RATIO * Math.hypot(...sub(hi, lo));
  const { scene } = await importStep(bytes);
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: deflection, angularDeflection: 0.5 });
  totals.parts += scene.parts.length;
  totals.meshes += meshes.size;
  const tol = 4 * deflection + size * 1e-6;
  let samples = 0, onSurface = 0, cs = 0, cm = 0;
  for (const pi of partInstances(scene)) {
    const mesh = meshes.get(pi.part);
    if (!mesh || !pi.visible) continue;
    const m = pi.transform, o = mesh.origin;
    const world = (i: number): V => {
      const x = mesh.positions[i * 3]! + o[0], y = mesh.positions[i * 3 + 1]! + o[1],
      z = mesh.positions[i * 3 + 2]! + o[2];
      return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
        m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
    };
    const nv = mesh.positions.length / 3, step = Math.max(1, Math.floor(nv / 100));
    for (let i = 0; i < nv; i += step) { samples++; if (nearest(world(i)).d <= tol) onSurface++; }
    // Colours: a few triangle centroids per face.
    for (const face of mesh.faces) {
      for (let k = 0; k < Math.min(face.count / 3, 3); k++) {
        const t = face.start + k * 3;
        const a = world(mesh.indices[t]!), b = world(mesh.indices[t + 1]!), c = world(mesh.indices[t + 2]!);
        const centroid: V = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const near = nearest(centroid, normal(a, b, c), tol);
        if (!near.t || near.d > tol) continue;
        const mat = (face.source !== null ? pi.faceMaterials.get(face.source) : undefined) ?? pi.material;
        const ours = mat === undefined ? 'none' : scene.materials[mat]!.color.map(
          (x) => toLinear(x).toFixed(3)).join(',');
        cs++;
        // Within 0.01 per component: OCCT's sRGB-to-linear conversion differs from ours in the third decimal.
        const same = ours === near.t.colour || (ours !== 'none' && near.t.colour !== 'none'
          && ours.split(',').every((x, k) => Math.abs(Number(x) - Number(near.t!.colour.split(',')[k])) <= 0.01));
        if (same) cm++;
        else if (process.env.SHOW) console.error(`  face #${face.source}: ours ${ours}, OCCT ${near.t.colour}`);
      }
    }
  }
  totals.samples += samples; totals.onSurface += onSurface; totals.colourSamples += cs; totals.colourMatch += cm;
  console.error(`${name}: ${onSurface}/${samples} on surface, ${cm}/${cs} colours`);
  if (onSurface < samples || cm < cs) rows.push(
    `${name}: ${samples - onSurface} of ${samples} vertices off OCCT's surface; ${cs - cm} of ${cs} colour `
    + `samples differ`);
}
console.log(`${totals.files} files compared (${totals.skipped} over the size limit, ${totals.occtFailed} without OCCT `
  + `meshes); ${totals.meshes} of ${totals.parts} parts tessellated`);
console.log(`vertices on OCCT's surface: ${totals.onSurface} of ${totals.samples}; colours matching: `
  + `${totals.colourMatch} of ${totals.colourSamples}`);
for (const r of rows) console.log('  ', r);
