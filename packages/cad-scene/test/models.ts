// B-rep models for the scene's tests, where only telling parts apart matters: one point item, its x the tag a fake
// backend reads back from a request (tagOf).

import { BrepBuilder, type BrepData, openBrep } from 'cad-brep';

/** A model tagged `tag`. */
export function tagged(tag = 0): BrepData {
  const b = new BrepBuilder({ unit: 1 });
  b.addItem({ kind: 'point', point: [tag, 0, 0] });
  return b.finish();
}

/** The tag of the model a `cad-brep` request carries. */
export const tagOf = (data: Uint8Array): number => openBrep(data).pool.itemReal[0]!;
