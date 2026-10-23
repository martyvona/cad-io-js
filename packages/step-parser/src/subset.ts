// Per-part subsets: a small, valid Part 21 file holding one shape representation and everything it references, for a
// tessellator (docs/architecture.md, "The tessellator interface"). The production version of phase 0's subsets
// (docs/phase0/phase0_subset_method.md): the forward-reference closure over the pass-1 index, original
// #ids kept, entities in file order and copied byte for byte.

import type { EntityRecord, Instance, Value } from './model.ts';
import type { StepFile } from './file.ts';
import { writeStep } from './write.ts';

export interface SubsetOptions {
  /**
   * Positions to leave out: not copied, not followed, and removed from the roots' lists. For a representation whose
   * MAPPED_ITEMs place other representations that are tessellated as parts of their own.
   */
  exclude?: ReadonlySet<number>;
  /**
   * Append a minimal product structure (8 entities with fresh ids above any the file uses) whose
   * SHAPE_DEFINITION_REPRESENTATION points at the first root, for readers that need one (occt-import-js). The
   * custom OCCT backend and truck read bare subsets.
   */
  wrapper?: boolean;
  /** Header entities; default the source file's. */
  header?: readonly EntityRecord[];
}

export interface Subset {
  bytes: Uint8Array;
  /** Positions of the source instances included, in file order. */
  positions: Uint32Array;
  /** Ids referenced from the subset but not in it: dangling in the source too, or left out by `exclude`. */
  missing: number[];
}

/** The positions in the forward-reference closure of `roots`, in file order, not entering `exclude`. */
export function closure(file: StepFile, roots: readonly number[], exclude?: ReadonlySet<number>): Uint32Array {
  const ix = file.index;
  const seen = new Uint8Array(ix.count);
  const stack: number[] = [];
  for (const p of roots) if (!seen[p]) { seen[p] = 1; stack.push(p); }
  while (stack.length) {
    const p = stack.pop()!;
    for (const id of ix.refsOf(p)) {
      const q = ix.position(id);
      if (q >= 0 && !seen[q] && !exclude?.has(q)) { seen[q] = 1; stack.push(q); }
    }
  }
  const out: number[] = [];
  for (let p = 0; p < ix.count; p++) if (seen[p]) out.push(p);
  return Uint32Array.from(out);
}

/**
 * The ids that instances at `positions` refer to but the file doesn't define, ascending (references beyond the largest
 * id aren't indexed; the scan warns of them).
 */
export function danglingRefs(file: StepFile, positions: ArrayLike<number>): number[] {
  const ix = file.index;
  const out = new Set<number>();
  for (let k = 0; k < positions.length; k++) for (const id of ix.refsOf(positions[k]!)) if (ix.position(id) < 0) out.add(id);
  return [...out].sort((a, b) => a - b);
}

/** Build the subset for the representations at `roots` (positions). Throws ParseError if a rewritten root is malformed. */
export function buildSubset(file: StepFile, roots: readonly number[], opts: SubsetOptions = {}): Subset {
  const ix = file.index;
  const positions = closure(file, roots, opts.exclude);
  const included = new Set(positions);
  const rootSet = new Set(roots);
  const excludedIds = new Set([...(opts.exclude ?? [])].map((p) => ix.ids[p]!));
  const items: (Instance | Uint8Array)[] = [];
  const missing = new Set<number>();
  for (const p of positions) {
    // Roots lose their references to excluded instances; everything else is copied as written.
    const rewrite = rootSet.has(p) && ix.refsOf(p).some((id) => excludedIds.has(id));
    items.push(rewrite ? withoutRefs(file.instanceAt(p), excludedIds) : file.sourceBytesAt(p));
    for (const id of ix.refsOf(p)) {
      if (rewrite && excludedIds.has(id)) continue;
      if (!included.has(ix.position(id))) missing.add(id);
    }
  }
  if (opts.wrapper && roots.length) items.push(...wrapper(file, ix.ids[roots[0]!]!));
  const bytes = writeStep({ header: opts.header ?? file.header, data: [{ instances: items }] });
  return { bytes, positions, missing: [...missing].sort((a, b) => a - b) };
}

/** An instance with references to `ids` removed from its lists (a representation's items, say). */
function withoutRefs(inst: Instance, ids: ReadonlySet<number>): Instance {
  const filter = (v: Value): Value => {
    switch (v.k) {
      case 'list': return { k: 'list', v: v.v.filter((e) => !(e.k === 'ref' && ids.has(e.v))).map(filter) };
      case 'refs': return { k: 'refs', v: Array.from(v.v as ArrayLike<number>).filter((r) => !ids.has(r)) };
      case 'typed': return { ...v, v: filter(v.v) };
      default: return v;
    }
  };
  if ('parts' in inst) return { id: inst.id, parts: inst.parts.map((r) => ({ type: r.type, attrs: r.attrs.map(filter) })) };
  return { id: inst.id, type: inst.type, attrs: inst.attrs.map(filter) };
}

/**
 * A minimal product structure above the root, with ids above every id the file defines or references (so that a
 * dangling reference can't come to resolve to a wrapper entity).
 */
function wrapper(file: StepFile, root: number): Instance[] {
  let max = 0;
  for (const id of file.index.ids) if (id > max) max = id;
  for (const id of file.index.refs) if (id > max) max = id;
  const [ac, pc, p, pdf, pdc, pd, pds, sdr] = Array.from({ length: 8 }, (_, i) => max + 1 + i) as [number, number, number, number, number, number, number, number];
  const str = (v: string): Value => ({ k: 'str', v });
  const ref = (v: number): Value => ({ k: 'ref', v });
  return [
    { id: ac, type: 'APPLICATION_CONTEXT', attrs: [str('')] },
    { id: pc, type: 'PRODUCT_CONTEXT', attrs: [str(''), ref(ac), str('mechanical')] },
    { id: p, type: 'PRODUCT', attrs: [str('part'), str('part'), str(''), { k: 'refs', v: [pc] }] },
    { id: pdf, type: 'PRODUCT_DEFINITION_FORMATION', attrs: [str(''), str(''), ref(p)] },
    { id: pdc, type: 'PRODUCT_DEFINITION_CONTEXT', attrs: [str('part definition'), ref(ac), str('design')] },
    { id: pd, type: 'PRODUCT_DEFINITION', attrs: [str('design'), str(''), ref(pdf), ref(pdc)] },
    { id: pds, type: 'PRODUCT_DEFINITION_SHAPE', attrs: [str(''), str(''), ref(pd)] },
    { id: sdr, type: 'SHAPE_DEFINITION_REPRESENTATION', attrs: [ref(pds), ref(root)] },
  ];
}

