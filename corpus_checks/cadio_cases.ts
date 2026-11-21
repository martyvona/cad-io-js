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
