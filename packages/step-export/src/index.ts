// STEP from the B-rep model: a part's model as Part 21 (part.ts, geometry.ts), and a tessellator that meshes models
// with a backend reading STEP (tessellator.ts).

export { AP242_SCHEMA, stepGeometry, type StepGeometry } from './geometry.ts';
export { stepPart, stepPartBytes, type StepPart } from './part.ts';
export { STEP_WRITER_VERSION, StepTessellator } from './tessellator.ts';
