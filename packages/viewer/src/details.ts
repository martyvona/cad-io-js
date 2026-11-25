// The details of a selection, as lines of text (docs/viewer.md): how many of each kind; for one node its name,
// kind, place in the tree and, for a part, which placement of its part it is, for a failed face why where its backend
// said (`causes`: problems.ts's faceCausesOf); then the totals over what the selection
// covers: meshes and triangles with their area, lines and segments with their length, points; and the selection's STEP
// ids (step-ids.ts), cut short past about 50 characters. Millimetres; ASCII only (mm^2).

import type { Kind, NodeModel } from './model.ts';
import type { FaceReport } from './scene-graph.ts';
import { instancesOf, measure, piecesOf } from './selection.ts';
import { formatIds, stepIdsOf } from './step-ids.ts';

/** The STEP ids line's length, beyond which it's cut short (about 50). */
export const IDS_SHOWN = 50;

const num = (n: number) => n.toLocaleString('en-US');
const mm = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x < 10 ? 3 : 1 });
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const KIND_NAMES: Record<Kind, [string, string]> = {
  assembly: ['assembly', 'assemblies'], part: ['part', 'parts'], faces: ['set of faces', 'sets of faces'],
  edges: ['set of edges', 'sets of edges'], vertices: ['set of vertices', 'sets of vertices'], face: ['face', 'faces'],
  edge: ['edge', 'edges'], curve: ['curve', 'curves'], vertex: ['vertex', 'vertices'], point: ['point', 'points'],
};

export function details(model: NodeModel, ids: readonly number[], causes?: ReadonlyMap<number, string>): string[] {
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
      // (Its placement's mirror, scale or shear baked into the part: placements are rigid.)
      const stretched = n.object?.userData.stretched as string | undefined;
      if (stretched) out.push(`Stretched: ${stretched}`);
    }
    // Meshing failures (model.ts's failure, the kinds from the mesh's faceReport: scene-graph.ts): what failed, and
    // where it's drawn instead; a face's area on the exact geometry, where its part was measured.
    const failure = model.failure(n.id);
    const report = n.face ? faceReportOf(model, n.id) : undefined;
    const areas = report?.area !== undefined ? ` (${mm(report.meshArea)} of ${mm(report.area)} mm^2 meshed)` : '';
    if (n.face && report?.failure === 'excess') out.push(`Its mesh is larger than the face (its mesh ` +
      `${mm(report.meshArea)} mm^2, the face ${mm(report.area!)} mm^2): outlined in red`);
    else if (n.face && report?.failure === 'unverified') out.push(
      "Its area couldn't be verified (its geometry is unsound): outlined in red");
    else if (failure === 'failed') out.push(n.face ? 'Failed to mesh: its outline is drawn in red'
      : "Failed to mesh: its faces' outlines are drawn in red");
    // (Its cause, where the face failed and its backend said: tess-cadio's, a face kept by its debugging switch none.)
    const cause = n.face && (failure === 'failed' || failure === 'partly') ? causes?.get(n.face.source) : undefined;
    if (cause) out.push(`Cause: ${cause}`);
    else if (failure === 'partly' && n.face) out.push(`Part of it failed to mesh${areas}: outlined in red`);
    else if (failure === 'partly') {
      const m = n.object!.children.find((c) => (c.userData.failedFaces as number[] | undefined)?.length ||
        (c.userData.partlyFailedFaces as number[] | undefined)?.length)!;
      const kinds = new Map<string, number>();
      for (const r of Object.values((m.userData.faceReport ?? {}) as Record<number, FaceReport>)) {
        if (r.failure) kinds.set(r.failure, (kinds.get(r.failure) ?? 0) + 1);
      }
      const said = { failed: 'failed to mesh', partly: 'partly', excess: 'meshed larger than the face',
        unverified: "couldn't be verified" } as const;
      out.push(`Of ${plural((m.userData.faces as number[]).length, 'face')}, ` + (['failed', 'excess', 'unverified',
        'partly'] as const).flatMap((k) => (kinds.get(k) ? [`${num(kinds.get(k)!)} ${said[k]}`] : [])).join(', ') +
        ' (outlined in red)');
    }
    // (The oracle's with its error estimate where it measured the face, else the backend's.)
    if (report?.oracle) out.push(`Area on the exact geometry: ${mm(report.oracle.area)} mm^2 +/- `
      + `${report.oracle.error.toPrecision(2)} mm^2`);
    else if (report?.area !== undefined) out.push(`Area on the exact geometry: ${mm(report.area)} mm^2`);
    // Its appearance: its own override, or inherited from a node above (model.ts).
    const own = model.ownOverride(n.id), look = model.look(n.id);
    if (look.hidden) out.push(own?.hidden ? 'Hidden' : 'Hidden (by a node above)');
    if (look.alpha !== undefined) {
      out.push(`Opacity ${num(look.alpha)}${own?.transparent ? '' : ' (from a node above)'}`);
    }
    else if (own?.transparent === false) out.push("Opacity: the file's");
    if (look.triangleEdges !== undefined) out.push(`Triangle edges ${look.triangleEdges ? 'on' : 'off'}${
      own?.triangleEdges === undefined ? ' (from a node above)' : ''}`);
  }
  const m = measure(piecesOf(model, ids));
  if (m.meshes) out.push(`Triangles: ${num(m.triangles)} in ${plural(m.meshes, 'mesh', 'meshes')}, ` +
    `area ${mm(m.area)} mm^2`);
  if (m.lines) out.push(`Segments: ${num(m.segments)} in ${plural(m.lines, 'line object')}, length ${mm(m.length)} mm`);
  if (m.points) out.push(`Points: ${num(m.points)}`);
  return out;
}

/** A face node's report (scene-graph.ts's faceReport), from its part's mesh object. */
function faceReportOf(model: NodeModel, id: number): FaceReport | undefined {
  const n = model.nodes[id]!, part = model.nodes[model.partOf(id)];
  const m = part?.object?.children.find((c) => c.userData.faceReport);
  return (m?.userData.faceReport as Record<number, FaceReport> | undefined)?.[n.face!.source];
}
