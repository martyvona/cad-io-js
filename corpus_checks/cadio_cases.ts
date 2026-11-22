// tess-cadio's cases from the corpus that a unit fixture doesn't reach: each a part of a file and its faces, meshed
// (the medium profile, init's defaults) and checked to have none of them failed. A file missing from the corpus is
// skipped, said so. Usage: node --max-old-space-size=12000 corpus_checks/cadio_cases.ts
import fs from 'node:fs';
import path from 'node:path';
import { MESH_PROFILES } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { CadioTessellator } from '../packages/tess-cadio/src/index.ts';
import { failedCauses } from './cadio_causes.ts';

interface Case { file: string; part: number; faces: number[]; why: string }
const root = path.join(import.meta.dirname, '..', 'test_corpus');
const CASES: Case[] = [
  // A pole's ring inside an arc that, one span at the start (its two ends labelled with the edges before them), the
  // ring's clearance didn't see (poles.cpp: the face's edges from the model's loops, each one's nearest approach).
  { file: 'models/onshape/LMP1.step', part: 172969, faces: [1072177, 1072086],
    why: "a pole's ring inside a one-span arc's approach" },
  { file: 'models/onshape/LMP1.step', part: 172968, faces: [1071824, 1071883],
    why: "a pole's ring inside a one-span arc's approach" },
  // A triangle at a boundary whose edges' points are off the surface (within the tolerance) turned as output though
  // not on the surface's points: the criteria's turn on the boundary's own points (setBoundaryPoints) mends it.
  { file: 'models/onshape/LMP1.step', part: 172400, faces: [1038482], why: 'turned on the boundary\'s own points' },
  { file: 'models/onshape/LMP1.step', part: 173233, faces: [1082381], why: 'turned on the boundary\'s own points' },
  // A refused sliver at a boundary (u near 0) whose quadrilaterals across its interior edges are both non-convex in
  // (u, v), so no flip mends it: the apex snapped onto its long edge.
  { file: 'models/onshape/LMP1.step', part: 172440, faces: [1041915], why: 'a sliver no flip mends' },
  // The same face meshed only if no more is judged on those points than the output's own turn: the angle on them
  // (a thin triangle's tilt, steeper as refinement thins it) took it to the point cap, the turn against any one
  // corner's normal left one turned.
  { file: 'models/onshape/LMP1.step', part: 172878, faces: [1064893],
    why: 'only the turn on the boundary\'s own points' },
  // A split a torus asks on its edge's span inside a neighbouring sphere's pole ring: the ring shrunk to it
  // (part.cpp's shrinkRings).
  { file: 'third_party/gkv311-opencascade-dataset/step/r0901_ec.stp', part: 11, faces: [37264],
    why: 'a pole\'s ring shrunk for a neighbour\'s split' },
  // Meshed only as long as the shrink keeps to its rules: a free-form pole's rings not shrunk (arm's B-spline faces
  // at a pole, their slivers turned), and a shrink that fails a face ok before undone (LMP1 #172522's sphere, its
  // boundary through its own point with its ring smaller).
  { file: 'models/arm/arm-ap242.step', part: 114, faces: [1197, 1201], why: 'no shrink at a free-form pole' },
  { file: 'models/onshape/LMP1.step', part: 172522, faces: [1049041], why: 'a shrink failing a face undone' },
  // Tori whose turned slivers encroach an edge's end span a little longer than the reach of its near-end drop
  // (min(tol, d / 10), tol 0.01 at d 0.1): the split's point kept past it, and the end span left too short for
  // another frozen (EdgeMesh::split, endSpanFrozen).
  { file: 'third_party/gkv311-opencascade-dataset/step/trj6_pm4-ec-203.stp', part: 43110, faces: [23796, 23984],
    why: 'an end span\'s split past the near-end drop, then frozen' },
];

const t = new CadioTessellator();
await t.init();
let bad = 0;
const byFile = new Map<string, Case[]>();
for (const c of CASES) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
for (const [file, cases] of byFile) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) {
    console.log(`skipped ${file}: not in the corpus`);
    continue;
  }
  const { scene } = await importStep(new Uint8Array(fs.readFileSync(p)));
  for (const c of cases) {
    const part = scene.parts.find((q) => q.sources[0]?.id === c.part && q.brep);
    if (!part) {
      console.log(`FAIL ${file} #${c.part}: no such part`);
      bad++;
      continue;
    }
    const r = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(part.brep!.model.buffer),
      origin: part.origin, ...MESH_PROFILES.medium });
    const failed = failedCauses(r), still = c.faces.filter((f) => failed.has(f));
    if (still.length) bad++;
    console.log(`${still.length ? 'FAIL' : 'ok  '} ${file} #${c.part} (${c.why}): ` +
      (still.length ? still.map((f) => `#${f} ${failed.get(f)}`).join('; ') : `${c.faces.length} faces meshed`));
  }
}
process.exitCode = bad ? 1 : 0;
