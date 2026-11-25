// tess-cadio's cases from the corpus that a unit fixture doesn't reach: each a part of a file and its faces, meshed
// (the medium profile, init's defaults) and checked to have none of them failed or kept with a defect, nor any split
// its refinement asked for dropped (tess-cadio's warning naming the face: a segment no edge, crease or ring has). A file missing from the
// corpus is skipped, said so. Usage: node --max-old-space-size=12000 corpus_checks/cadio_cases.ts
import fs from 'node:fs';
import path from 'node:path';
import { MESH_PROFILES, type TessellationResult } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { CadioTessellator } from '../packages/tess-cadio/src/index.ts';
import { failedCauses, keptDefects } from './cadio_causes.ts';

// `needles`: also none of the faces' triangles past an aspect (its longest side over its altitude) of 1000.
interface Case { file: string; part: number; faces: number[]; why: string; needles?: boolean }
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
  // Slivers turned as shipped that refinement neither judges nor splits (within the floor), mended after meshing
  // (part.h's flipTurned, collapseTurned): flipped across an interior edge (LMP1 #173233's above); their apex
  // collapsed onto the nearer end of their long edge, a boundary span a split of which would fall under the floor.
  { file: 'third_party/gkv311-opencascade-dataset/step/trj6_b1-ec-214.stp', part: 10, faces: [6770],
    why: 'a turned sliver\'s apex collapsed' },
  { file: 'models/onshape/LMP1.step', part: 172440, faces: [1041915], why: 'a turned sliver\'s apex collapsed' },
  { file: 'models/onshape/LMP1.step', part: 172482, faces: [1046237, 1046289], why: 'a flip and a collapse' },
  // Turned needles beside a boundary whose long side isn't a span the floor bars splitting, and the refused ones the
  // mesher couldn't break: a corner of the mesher's own collapsed onto a neighbour (collapseTurned's general case).
  { file: 'third_party/gkv311-opencascade-dataset/step/trj4_k1_top-pe-214.stp', part: 4779, faces: [1529, 1759],
    why: 'a turned needle\'s corner collapsed onto a neighbour' },
  { file: 'third_party/gkv311-opencascade-dataset/step/bug27693_cornetta-step.stp', part: 22, faces: [139, 142, 143],
    why: 'a turned needle\'s corner collapsed onto a neighbour' },
  { file: 'third_party/gkv311-opencascade-dataset/step/bug33398.step', part: 13688, faces: [76],
    why: 'a turned needle\'s corner collapsed onto a neighbour' },
  // Poles' fans folding once welded (PartOptions::failFoldedFans fails them), at an apex with a curve through it: a fan
  // whose triangles' directions by their normals disagree made consistent along its chain, each against the mesher's
  // use of its ring segment (a cone's far ends on generators through its apex; a torus's corners a degree apart);
  // at an apex a far end's corner under 1e-3 rad from that end about it left out (a needle else).
  { file: 'third_party/nist-pmi-models/NIST_MBE_PMI_CTC_Definitions/NIST_MBE_PMI_CTC_Definitions/'
    + 'nist_ctc_02_asme1_rc.stp', part: 20754, faces: [14052, 14104, 14156, 14208, 20640, 20651],
    why: 'a cone apex\'s fans made consistent, no needles', needles: true },
  { file: 'models/onshape/LMP1.step', part: 173466, faces: [1091324, 1091325, 1091329, 1091330],
    why: 'a torus apex\'s fans made consistent' },
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
  // Tori cut by a straight pseudo-edge sampled at its ends alone (both its loops' points), whose span refinement asks
  // split: the face's cut among its edges (part.cpp's addCuts), the split made (#1061562 past its deflection else).
  { file: 'models/onshape/LMP1.step', part: 172790, faces: [1061562, 1061570], why: 'a two-sample cut split' },
  { file: 'models/onshape/LaPavoni.step', part: 5805, faces: [31422, 31427], why: 'a two-sample cut split' },
];

// A face's triangles past an aspect of 1000 in a result.
function needles(r: TessellationResult, face: number): number {
  let n = 0;
  for (const f of r.faces) if (f.entityId === face) for (let k = f.start; k < f.start + f.count; k += 3) {
    const p = [0, 1, 2].map((q) => [0, 1, 2].map((c) => r.positions[3 * r.indices[k + q]! + c]!));
    const e = [0, 1, 2].map((q) => p[(q + 1) % 3]!.map((x, i) => x - p[q]![i]!));
    const [u, v] = [e[0]!, e[2]!.map((x) => -x)] as [number[], number[]];
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    const long = Math.max(...e.map((x) => Math.hypot(...x)));
    if (!(long * long / (2 * area) <= 1000)) n++;
  }
  return n;
}

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
    const failed = failedCauses(r), still = c.faces.filter((f) => failed.has(f)).map((f) => `#${f} ${failed.get(f)}`);
    // (A face kept with a defect, tess-cadio's keepDefects, is no case met: the case is for meshing it clean.)
    const kept = keptDefects(r);
    for (const f of c.faces) if (kept.has(f)) still.push(`#${f} kept with defects: ${kept.get(f)}`);
    const drop = r.diagnostics?.find((d) => d.message.includes('split requests dropped'))?.message ?? '';
    for (const f of c.faces) if (new RegExp(`#${f} \\(`).test(drop)) still.push(`#${f} split requests dropped`);
    if (c.needles) {
      for (const f of c.faces) if (!failed.has(f) && needles(r, f)) still.push(`#${f} ${needles(r, f)} needles`);
    }
    if (still.length) bad++;
    console.log(`${still.length ? 'FAIL' : 'ok  '} ${file} #${c.part} (${c.why}): ` +
      (still.length ? still.join('; ') : `${c.faces.length} faces meshed`));
  }
}
process.exitCode = bad ? 1 : 0;
