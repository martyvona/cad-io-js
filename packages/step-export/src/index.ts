// STEP from the scene: a whole scene as a STEP file (export.ts, with tessellated.ts for meshes), a part's B-rep model as
// Part 21 (part.ts, geometry.ts), and a tessellator that meshes models with a backend reading STEP (tessellator.ts).

export { AP242_SCHEMA, largestId, stepContext, stepGeometry, stepIds, type StepGeometry, type StepGeometryOptions,
  type StepIds } from './geometry.ts';
export { stepPart, stepPartBytes, type StepPart } from './part.ts';
export { STEP_ADAPTER, STEP_WRITER_VERSION, StepTessellator } from './tessellator.ts';
export { AP214_SCHEMA, exportStep, type StepExport, type StepExportOptions, type StepSchema } from './export.ts';
