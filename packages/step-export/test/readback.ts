// A written part read back as the importer reads a part: its shape representation's items through step-import's
// stepBrep, with the length unit, angle unit and uncertainty of the representation's context. For checks of the
// writer (unit tests, corpus_checks/step_route.ts).

import type { BrepData } from 'cad-brep';
import { type Diagnostic, openModel, parseStep, Reader, Units } from 'step-parser';
import { stepBrep } from '../../step-import/src/brep.ts';

export async function readBack(data: Uint8Array, rootId: number):
  Promise<{ brep: BrepData; warnings: string[]; diagnostics: Diagnostic[] }> {
  const model = await openModel(parseStep(data));
  const r = new Reader(model);
  const root = model.resolve(rootId);
  if (root < 0) throw new Error(`no #${rootId}`);
  const context = new Units(r).ofRepresentation(root);
  const mm = (context?.lengthUnit?.factor ?? 0.001) * 1000;
  const warnings: string[] = [];
  const { brep } = stepBrep(r, r.refs(root, 'items'), { length: mm, angle: context?.planeAngleUnit?.factor ?? 1,
    ...(context?.uncertainty !== undefined ? { uncertainty: context.uncertainty * 1000 } : {}) },
  (m) => warnings.push(m));
  return { brep, warnings, diagnostics: [...model.diagnostics, ...r.diagnostics] };
}
