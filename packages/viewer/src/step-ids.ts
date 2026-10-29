// STEP instance ids in the viewer (the user, 2026-10-28): the ids of the selected nodes in the details panel, Select
// by ID (Selection), and the problems dialog's Copy IDs (problems.ts), whose list Select by ID reads back. A node's
// ids: an assembly's occurrence's and its component's (scene-graph.ts's `userData.sources`: NAUOs, product
// definitions), a part's (its shape representation), a face's (its own, where its part is from STEP); edges, curves
// and points nodes have none.

import type { NodeModel } from './model.ts';

/** A node's STEP ids (none for models from other formats). */
export function nodeStepIds(model: NodeModel, id: number): number[] {
  const n = model.nodes[id]!;
  if (n.face) return model.nodes[n.parent]!.object!.userData.stepFaces ? [n.face.source] : [];
  if (n.kind !== 'assembly' && n.kind !== 'part') return [];
  return (n.object?.userData.sources as number[] | undefined) ?? [];
}

/** The STEP ids of nodes, each once, in order. */
export function stepIdsOf(model: NodeModel, ids: readonly number[]): number[] {
  return [...new Set(ids.flatMap((id) => nodeStepIds(model, id)))];
}

/**
 * Ids as text, `#12 #345`; past `max` characters (none: never), the whole ids that fit with ` ...` after them
 * (the user, 2026-10-28: never part of an id), at least the first.
 */
export function formatIds(ids: readonly number[], max?: number): string {
  const all = ids.map((id) => `#${id}`);
  const text = all.join(' ');
  if (max === undefined || text.length <= max) return text;
  let shown = all[0]!;
  for (const id of all.slice(1)) {
    if (shown.length + 1 + id.length + 4 > max) break;
    shown += ` ${id}`;
  }
  return `${shown} ...`;
}

/**
 * Ids typed or pasted: separated by whitespace or commas, each `#123` or `123` (`#12#34`, as an input field joins
 * pasted lines, read as two); anything else is returned as not understood.
 */
export function parseIds(text: string): { ids: number[]; bad: string[] } {
  const ids: number[] = [], bad: string[] = [];
  for (const token of text.split(/[\s,]+/).filter((t) => t)) {
    if (/^(#?\d+)+$/.test(token)) {
      for (const m of token.matchAll(/#?(\d+)/g)) ids.push(Number(m[1]));
    } else bad.push(token);
  }
  return { ids: [...new Set(ids)], bad };
}

/** The part nodes whose meshes have faces with any of the ids (whose face nodes the tree's detail would make). */
export function partsWithFaces(model: NodeModel, ids: ReadonlySet<number>): number[] {
  return model.nodes.filter((n) => {
    if (n.kind !== 'part' || !n.object?.userData.stepFaces) return false;
    let hit = false;
    n.object.traverse((o) => {
      if (!hit) hit = ((o.userData.faces as number[] | undefined) ?? []).some((f) => ids.has(f));
    });
    return hit;
  }).map((n) => n.id);
}

/** The nodes made so far with any of the ids. */
export function nodesWithIds(model: NodeModel, ids: ReadonlySet<number>): number[] {
  return model.nodes.filter((n) => nodeStepIds(model, n.id).some((i) => ids.has(i))).map((n) => n.id);
}
