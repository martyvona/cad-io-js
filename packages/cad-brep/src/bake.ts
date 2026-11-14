// A whole model at a transform: its rows given to a builder again, every item at the transform, so the builder bakes
// it (docs/brep-reference.md, "Transforms"): what the scene's stretched copies of a part are made with.

import { BrepBuilder } from './builder.ts';
import { type BrepData, rowCount } from './data.ts';
import * as dec from './decode.ts';
import type { Transform } from './types.ts';
import type { BrepDiagnostic } from './validate.ts';

/**
 * The model with every item at `transform` (12 numbers, column-major: x, y, z, translation), and what baking it said;
 * a transform that isn't a similarity (a non-uniform scale, a shear) leaves every item out, an error each. Rows no item
 * reaches are left out; every row keeps its id (each is drawn once).
 */
export function transformBrep(d: BrepData, transform: Transform): { data: BrepData; diagnostics: BrepDiagnostic[] } {
  const b = new BrepBuilder(dec.part(d));
  for (let k = 0; k < rowCount(d, 'curve'); k++) b.addCurve(dec.curve(d, k));
  for (let k = 0; k < rowCount(d, 'surface'); k++) b.addSurface(dec.surface(d, k));
  for (let k = 0; k < rowCount(d, 'vertex'); k++) b.addVertex(dec.vertex(d, k));
  for (let k = 0; k < rowCount(d, 'edge'); k++) b.addEdge(dec.edge(d, k));
  for (let k = 0; k < rowCount(d, 'face'); k++) b.addFace(dec.face(d, k));
  for (let k = 0; k < rowCount(d, 'shell'); k++) b.addShell(dec.shell(d, k));
  for (let k = 0; k < rowCount(d, 'body'); k++) b.addBody(dec.body(d, k));
  for (let k = 0; k < rowCount(d, 'item'); k++) b.addItem({ ...dec.item(d, k), transform });
  for (let k = 0; k < rowCount(d, 'copy'); k++) b.addCopy(dec.copy(d, k));
  const data = b.finish();
  return { data, diagnostics: b.diagnostics };
}
