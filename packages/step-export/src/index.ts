// STEP from the B-rep model: a part's model as a bare Part 21 file of its shape representation (geometry.ts), what a
// backend that reads STEP (OCCT) meshes. The header is fixed, so the same model gives the same bytes.

import type { BrepData } from 'cad-brep';
import { type Diagnostic, makeHeader, type StepDocument, writeChunks, writeStep } from 'step-parser';
import { AP242_SCHEMA, stepGeometry, type StepGeometry } from './geometry.ts';

export { AP242_SCHEMA, stepGeometry, type StepGeometry } from './geometry.ts';

export interface StepPart {
  /** The shape representation's id. */
  rootId: number;
  /** The file, in chunks, made as they are pulled; one pass. */
  chunks: Iterable<Uint8Array>;
  /** Complete once `chunks` has been read through. */
  diagnostics: Diagnostic[];
}

const header = makeHeader({ description: ['a B-rep model'], timeStamp: '', schemas: [AP242_SCHEMA],
  preprocessorVersion: 'cad-io-js step-export' });
const document = (g: StepGeometry): StepDocument => ({ header, data: [{ instances: g.instances }] });

/** A part's model as a Part 21 file holding its shape representation alone. */
export function stepPart(d: BrepData): StepPart {
  const g = stepGeometry(d);
  return { rootId: g.rootId, chunks: writeChunks(document(g)), diagnostics: g.diagnostics };
}

/** `stepPart` as one array. */
export function stepPartBytes(d: BrepData): { data: Uint8Array; rootId: number; diagnostics: Diagnostic[] } {
  const g = stepGeometry(d);
  return { data: writeStep(document(g)), rootId: g.rootId, diagnostics: g.diagnostics };
}
