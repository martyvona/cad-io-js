// The details of a selection, as lines of text (the user, 2026-10-24; CLAUDE.md, "The viewer"): how many of each
// kind; for one node its name, kind, place in the tree and, for a part, which placement of its part it is; then the
// totals over what the selection covers: meshes and triangles with their area, lines and segments with their
// length, points; and the selection's STEP ids (step-ids.ts), cut short past about 50 characters. Millimetres;
// ASCII only (mm^2).

import type { Kind, NodeModel } from './model.ts';
import { instancesOf, measure, piecesOf } from './selection.ts';
import { formatIds, stepIdsOf } from './step-ids.ts';

/** The STEP ids line's length, beyond which it's cut short (the user, 2026-10-28: about 50). */
export const IDS_SHOWN = 50;

const num = (n: number) => n.toLocaleString('en-US');
const mm = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x < 10 ? 3 : 1 });
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const KIND_NAMES: Record<Kind, [string, string]> = {
  assembly: ['assembly', 'assemblies'], part: ['part', 'parts'], face: ['face', 'faces'],
  edges: ['set of edges', 'sets of edges'], curves: ['set of curves', 'sets of curves'],
  points: ['set of points', 'sets of points'],
};

export function details(model: NodeModel, ids: readonly number[]): string[] {
  if (!ids.length) return ['Nothing selected.'];
  const out: string[] = [];
  const counts = new Map<Kind, number>();
  for (const id of ids) {
    const k = model.nodes[id]!.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  out.push(`Selected: ${[...counts].map(([k, n]) => `${num(n)} ${KIND_NAMES[k][n === 1 ? 0 : 1]}`).join(', ')}`);
  const stepIds = stepIdsOf(model, ids);
  if (stepIds.length) out.push(`STEP IDs: ${formatIds(stepIds, IDS_SHOWN)}`);
  if (ids.length === 1) {
    const n = model.nodes[ids[0]!]!;
    const path: string[] = [];
    for (let p = n.parent; p >= 0; p = model.nodes[p]!.parent) path.unshift(model.nodes[p]!.name);
    out.push(`Name: ${n.name} (${n.kind})`);
    if (path.length) out.push(`In: ${path.join(' / ')}`);
    if (n.kind === 'part') {
      const all = instancesOf(model, n.id);
      if (all.length > 1) out.push(`Placement ${num(all.indexOf(n.id) + 1)} of ${num(all.length)} of this part`);
      else out.push('The only placement of this part');
    }
    // Meshing failures (model.ts's failure): what failed, and where it's drawn instead.
    const failure = model.failure(n.id);
    if (failure === 'failed') out.push(n.face ? 'Failed to mesh: its outline is drawn in red'
      : "Failed to mesh: its faces' outlines are drawn in red");
    else if (failure === 'partly' && n.face) out.push('Part of it failed to mesh: outlined in red');
    else if (failure === 'partly') {
      const m = n.object!.children.find((c) => (c.userData.failedFaces as number[] | undefined)?.length ||
        (c.userData.partlyFailedFaces as number[] | undefined)?.length)!;
      const failed = (m.userData.failedFaces as number[]).length;
      const partly = (m.userData.partlyFailedFaces as number[]).length;
      out.push(`Of ${plural((m.userData.faces as number[]).length, 'face')}, ` + [failed ? `${num(failed)} failed to ` +
        'mesh' : '', partly ? `${num(partly)} partly` : ''].filter((x) => x).join(', ') + ' (outlined in red)');
    }
    if (n.hidden) out.push('Hidden');
    else if (model.hiddenInTree(n.id)) out.push('Hidden (by an assembly above)');
  }
  const m = measure(piecesOf(model, ids));
  if (m.meshes) out.push(`Triangles: ${num(m.triangles)} in ${plural(m.meshes, 'mesh', 'meshes')}, ` +
    `area ${mm(m.area)} mm^2`);
  if (m.lines) out.push(`Segments: ${num(m.segments)} in ${plural(m.lines, 'line object')}, length ${mm(m.length)} mm`);
  if (m.points) out.push(`Points: ${num(m.points)}`);
  return out;
}
