// A part's model as a bare Part 21 file of its shape representation (geometry.ts), what a backend that reads STEP
// (OCCT) meshes. The header is fixed, so the same model gives the same bytes.

import type { BrepData } from 'cad-brep';
import { type Diagnostic, makeHeader, type StepDocument, writeChunks, writeStep } from 'step-parser';
import { AP242_SCHEMA, largestId, stepGeometry, type StepGeometry } from './geometry.ts';

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

/**
 * `stepPart` as one array, with what to read a reader's ids back by: the model's largest source id (ids above it are
 * the writer's) and `StepGeometry.sourceIds`.
 */
export function stepPartBytes(d: BrepData): { data: Uint8Array; rootId: number; diagnostics: Diagnostic[];
  largest: number; sourceIds: Map<number, number> } {
  const g = stepGeometry(d);
  const data = writeStep(document(g));
  return { data, rootId: g.rootId, diagnostics: g.diagnostics, largest: largestId(d), sourceIds: g.sourceIds };
}
