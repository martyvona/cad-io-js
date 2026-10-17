// Phase 1 step 6: check the validation property extractor against geometry. For files with one root product that
// carries part-level validation properties (volume, surface area, centroid), compare them, converted to SI units by
// our extractor, with the same quantities computed from occt-import-js's meshes of the whole file (in millimetres).
// The meshes approximate curved surfaces, so agreement is to a tessellation tolerance, not exact; what this catches
// is a wrong unit, a wrong property or a misread value.
// Usage: node corpus_checks/validation_occt.ts [file-list.txt] [max MB, default 5]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractSemantics, openModel, parseStep } from '../packages/step-parser/src/index.ts';
import { corpusDir, corpusFiles, shortName } from './corpus.ts';

const require = createRequire(import.meta.url);
const loadOcct = () => require(path.join(corpusDir, 'occt-import-js/dist/occt-import-js.js'))();
let occt = await loadOcct();
const maxBytes = Number(process.argv[3] ?? 5) * 1e6;

const rows: string[] = [];
const stats = { files: 0, compared: 0, volume: [0, 0], area: [0, 0], centroid: [0, 0] }; // [within tolerance, total]
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) continue;
  const m = await openModel(parseStep(bytes));
  const sem = extractSemantics(m);
  if (sem.structure.roots.length !== 1) continue;
  const root = sem.structure.products[sem.structure.roots[0]!]!;
  const props = sem.validation.filter((v) => v.target.kind === 'product' && v.target.product === root.id).flatMap((v) => v.values);
  // By the CAx-IF names (GVP v4.6, section 8): item names, or the representation's when the item has another.
  const pick = (item: string, rep: string) => props.find((v) => v.name.toLowerCase() === item) ?? props.find((v) => v.representation.toLowerCase() === rep);
  const volume = pick('volume measure', 'volume')?.measure;
  const area = pick('surface area measure', 'surface area')?.measure;
  const centroid = pick('centre point', 'centroid')?.point;
  if (volume === undefined && area === undefined && centroid === undefined) continue;
  stats.files++;

  let res;
  try {
    res = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.1 });
  } catch {
    occt = await loadOcct();
    res = { success: false };
  }
  if (!res.success) { rows.push(`${shortName(f)}: occt-import-js failed`); continue; }
  // Mesh volume (divergence theorem), area and volume centroid, in metres.
  let vol = 0, ar = 0;
  const c = [0, 0, 0];
  let size = 0;
  for (const mesh of res.meshes) {
    const p = mesh.attributes.position.array as number[];
    const idx = mesh.index.array as number[];
    for (let i = 0; i < idx.length; i += 3) {
      const a = [0, 1, 2].map((k) => p[idx[i]! * 3 + k]! / 1000), b = [0, 1, 2].map((k) => p[idx[i + 1]! * 3 + k]! / 1000), d = [0, 1, 2].map((k) => p[idx[i + 2]! * 3 + k]! / 1000);
      const cr = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
      const v6 = cr[0]! * d[0]! + cr[1]! * d[1]! + cr[2]! * d[2]!;
      vol += v6 / 6;
      for (let k = 0; k < 3; k++) c[k]! += (v6 / 24) * (a[k]! + b[k]! + d[k]!);
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
      ar += Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
      size = Math.max(size, ...a.map(Math.abs), ...b.map(Math.abs), ...d.map(Math.abs));
    }
  }
  const meshCentroid = c.map((x) => x / vol);
  stats.compared++;
  const cmp = (key: 'volume' | 'area', mine: number | undefined, theirs: number) => {
    if (mine === undefined) return '';
    const rel = Math.abs(mine - Math.abs(theirs)) / Math.abs(mine);
    stats[key][1]++;
    if (rel < 0.01) stats[key][0]++;
    return `${key} ${(rel * 100).toFixed(2)}%`;
  };
  const parts = [cmp('volume', volume, vol), cmp('area', area, ar)];
  if (centroid) {
    const d = Math.hypot(...centroid.map((x, k) => x - meshCentroid[k]!)) / Math.max(size, 1e-12);
    stats.centroid[1]++;
    if (d < 0.01) stats.centroid[0]++;
    parts.push(`centroid ${(d * 100).toFixed(2)}% of size`);
  }
  rows.push(`${shortName(f)}: ${parts.filter((x) => x).join(', ')}`);
}
console.log(`${stats.files} files with root validation properties, ${stats.compared} compared; within 1%: volume ${stats.volume[0]}/${stats.volume[1]}, area ${stats.area[0]}/${stats.area[1]}, centroid ${stats.centroid[0]}/${stats.centroid[1]}`);
for (const r of rows) console.log('  ', r);
