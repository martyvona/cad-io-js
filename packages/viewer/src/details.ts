// The details of a selection, as lines of text (docs/viewer.md): how many of each kind; for one node its name,
// kind, place in the tree and, for a part, which placement of its part it is, for a failed face why where its backend
// said (`causes`: problems.ts's faceCausesOf), for a face, edge or curve its surface or curve with its parameters and
// for a vertex or point where it is (geometry-info.ts); then the totals over what the selection covers: the faces'
// area on the exact geometry (the measures', the oracle's with its error), whole parts' volume (the analysis's shell
// volumes, and their meshes'), meshes and triangles with their area, lines and segments with their length, points;
// and the selection's STEP ids (step-ids.ts), cut short past about 50 characters. Millimetres; ASCII only (mm^2).

import { BODY_KIND, type BrepAnalysis, type BrepData } from 'cad-brep';
import type { Measures, Mesh } from 'cad-scene';
import { geometryText, meshVolume, oracleVolume, pointText, vertexPoint } from './geometry-info.ts';
import { itemsOf } from './items.ts';
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

/**
 * What Details reads of a part, by its scene index (scene-graph.ts's `sources`): its B-rep model and analysis where
 * the page holds them, its mesh, its measures (each face's area, the oracle's with its error).
 */
export interface DetailSources {
  modelOf(part: number): BrepData | undefined;
  analysisOf(part: number): BrepAnalysis | undefined;
  meshOf(part: number): Mesh | undefined;
  measuresOf(part: number): Measures | undefined;
}

export function details(model: NodeModel, ids: readonly number[], causes?: ReadonlyMap<number, string>,
  sources?: DetailSources): string[] {
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
    // (At a defect of its part's mesh: scene-graph.ts's defectFaces.)
    const partObject = n.face ? model.nodes[model.partOf(n.id)]?.object : undefined;
    const atDefect = !!n.face && !!partObject?.children.some((c) => (c.userData.defectFaces as number[] | undefined)
      ?.includes(n.face!.source));
    if (n.face && report?.failure === 'excess') out.push(`Its mesh is larger than the face (its mesh ` +
      `${mm(report.meshArea)} mm^2, the face ${mm(report.area!)} mm^2): outlined in red`);
    else if (n.face && report?.failure === 'unverified') out.push(
      "Its area couldn't be verified (its geometry is unsound): outlined in red");
    else if (failure === 'failed') out.push(n.face ? 'Failed to mesh: its outline is drawn in red'
      : "Failed to mesh: its faces' outlines are drawn in red");
    // (Its cause, where the face failed and its backend said: tess-cadio's, a face kept by its debugging switch none.)
    const cause = n.face && (failure === 'failed' || failure === 'partly') ? causes?.get(n.face.source) : undefined;
    if (cause) out.push(`Cause: ${cause}`);
    else if (failure === 'partly' && n.face) {
      if (report?.failure === 'partly' || !atDefect) out.push(`Part of it failed to mesh${areas}: outlined in red`);
    } else if (failure === 'partly') {
      const m = n.object!.children.find((c) => (c.userData.failedFaces as number[] | undefined)?.length ||
        (c.userData.partlyFailedFaces as number[] | undefined)?.length ||
        (c.userData.defectFaces as number[] | undefined)?.length)!;
      const kinds = new Map<string, number>();
      for (const r of Object.values((m.userData.faceReport ?? {}) as Record<number, FaceReport>)) {
        if (r.failure) kinds.set(r.failure, (kinds.get(r.failure) ?? 0) + 1);
      }
      const said = { failed: 'failed to mesh', partly: 'partly', excess: 'meshed larger than the face',
        unverified: "couldn't be verified" } as const;
      const failed = (['failed', 'excess', 'unverified', 'partly'] as const).flatMap((k) => (kinds.get(k)
        ? [`${num(kinds.get(k)!)} ${said[k]}`] : []));
      const defects = (m.userData.defectFaces as number[] | undefined)?.length ?? 0;
      out.push(`Of ${plural((m.userData.faces as number[]).length, 'face')}, ` + [
        ...(failed.length ? [failed.join(', ') + ' (outlined in red)'] : []),
        ...(defects ? [`${num(defects)} at a defect of the mesh (not a closed, oriented manifold there)`] : [])]
        .join('; '));
    }
    if (atDefect) out.push("At a defect of its part's mesh: not a closed, oriented manifold there (an edge used " +
      "once, twice the same way or more than twice, or a vertex whose triangles aren't one fan)");
    // Its geometry, from its part's B-rep (geometry-info.ts): a face's surface, an edge's or curve's curve; a vertex's
    // point; an isolated point's, from the mesh.
    const partIndex = model.nodes[model.partOf(n.id)]?.object?.userData.part as number | undefined;
    const brep = partIndex === undefined ? undefined : sources?.modelOf(partIndex);
    const source = n.face?.source ?? n.item?.source ?? null;
    if (brep && source !== null && (n.kind === 'face' || n.kind === 'edge' || n.kind === 'curve')) {
      const g = geometryText(brep, n.kind, source);
      if (g) out.push(g);
    }
    if (n.kind === 'vertex' && brep && source !== null) {
      const p = vertexPoint(brep, source);
      if (p) out.push(`Point: ${pointText(p)} mm in the part's frame`);
    }
    if (n.kind === 'point' && n.item && partIndex !== undefined) {
      const mesh = sources?.meshOf(partIndex), k = itemsOf(n.item.object)[n.item.k]?.start;
      if (mesh?.points && k !== undefined) out.push(`Point: ${pointText([0, 1, 2].map((i) => mesh.points![3 * k + i]! +
        mesh.origin[i]!))} mm in the part's frame`);
    }
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
  out.push(...areaLines(model, ids, sources), ...volumeLines(model, ids, sources));
  const m = measure(piecesOf(model, ids));
  if (m.meshes) out.push(`Triangles: ${num(m.triangles)} in ${plural(m.meshes, 'mesh', 'meshes')}, ` +
    `area ${mm(m.area)} mm^2`);
  if (m.lines) out.push(`Segments: ${num(m.segments)} in ${plural(m.lines, 'line object')}, length ${mm(m.length)} mm`);
  if (m.points) out.push(`Points: ${num(m.points)}`);
  return out;
}

/**
 * The faces a selection covers, each placement's once: a face, a faces group's, a part's, an assembly's parts'. By
 * placement (its part node) and source id.
 */
function facesCovered(model: NodeModel, ids: readonly number[]): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const add = (part: number, sources: Iterable<number>) => {
    const set = out.get(part) ?? new Set<number>();
    for (const s of sources) set.add(s);
    out.set(part, set);
  };
  const all = (part: number) => model.nodes[part]!.object!.children.flatMap((c) =>
    (c.userData.faces as number[] | undefined) ?? []);
  const visit = (id: number) => {
    const n = model.nodes[id]!;
    if (n.dead) return;
    if (n.face) add(model.partOf(id), [n.face.source]);
    else if (n.kind === 'faces' || n.kind === 'part') add(model.partOf(id), all(model.partOf(id)));
    else if (n.kind === 'assembly') for (const c of model.children(id)) visit(c);
  };
  for (const id of ids) visit(id);
  return out;
}

/**
 * The faces' area on the exact geometry (their parts' measures: the oracle's with its error where it measured the
 * face, else the backend's), summed over every placement covered; nothing where none is measured.
 */
function areaLines(model: NodeModel, ids: readonly number[], sources?: DetailSources): string[] {
  let area = 0, error = 0, faces = 0, oracle = 0, measured = 0;
  for (const [part, set] of facesCovered(model, ids)) {
    const index = model.nodes[part]!.object!.userData.part as number;
    const m = sources?.measuresOf(index) ?? partMeasures(model, part);
    for (const s of set) {
      faces++;
      const f = m?.faces.get(s);
      if (!f) continue;
      measured++;
      if (f.oracle) {
        oracle++;
        area += f.oracle.area;
        error += f.oracle.error;
      } else area += f.area;
    }
  }
  if (!measured) return [];
  const err = (e: number) => `${errorText(e)} mm^2`;
  if (oracle === faces) return [`Area on the exact geometry: ${mm(area)} mm^2 +/- ${err(error)}`];
  const of = measured < faces ? ` (${num(measured)} of ${plural(faces, 'face')} measured)` : '';
  return [`Area on the exact geometry: ${mm(area)} mm^2${oracle ? ` (+/- ${err(error)} on the ${num(oracle)} the ` +
    'oracle measured)' : ''}${of}`];
}

/** A part's measures without sources: those its mesh's faceReport carries (tests build no sources). */
function partMeasures(model: NodeModel, part: number): Measures | undefined {
  const m = model.nodes[part]!.object!.children.find((c) => c.userData.faceReport);
  const report = m?.userData.faceReport as Record<number, FaceReport> | undefined;
  if (!report) return undefined;
  const faces = new Map(Object.entries(report).flatMap(([k, r]) => r.area === undefined ? [] : [[Number(k),
    { area: r.area, perimeter: 0, valid: true, ...(r.oracle ? { oracle: r.oracle } : {}) }] as const]));
  return { by: '', faces };
}

/**
 * The volume of the whole parts a selection covers (parts, and assemblies' parts, each placement once): their solids'
 * outer shells less their voids, on the exact geometry (the analysis's shell volumes, with their errors) and by their
 * meshes; nothing where no part covered has a solid in a model the page holds.
 */
function volumeLines(model: NodeModel, ids: readonly number[], sources?: DetailSources): string[] {
  if (!sources) return [];
  const parts = new Set<number>();
  const visit = (id: number) => {
    const n = model.nodes[id]!;
    if (n.kind === 'part') parts.add(id);
    else if (n.kind === 'assembly') for (const c of model.children(id)) visit(c);
  };
  for (const id of ids) visit(id);
  let solid = 0, exact = 0, volume = 0, error = 0, meshed = 0, meshVol = 0, analysed = 0;
  for (const part of parts) {
    const index = model.nodes[part]!.object!.userData.part as number;
    const d = sources.modelOf(index);
    if (!d || !hasSolid(d)) continue;
    solid++;
    const a = sources.analysisOf(index);
    if (a) analysed++;
    const o = oracleVolume(d, a);
    if (o) {
      exact++;
      volume += o.volume;
      error += o.error;
    }
    const mesh = sources.meshOf(index);
    const v = mesh && meshVolumeOf(d, mesh);
    if (v !== undefined) {
      meshed++;
      meshVol += v;
    }
  }
  if (!solid) return [];
  const of = (k: number) => (k < solid ? ` (${num(k)} of ${plural(solid, 'part')} with solids)` : '');
  const err = `${errorText(error)} mm^3`;
  return [exact ? `Volume on the exact geometry: ${mm(volume)} mm^3 +/- ${err}${of(exact)}`
    // (Healing measures shells, the oracle as far as it can: unhealed, none.)
    : `Volume on the exact geometry: not measured (${analysed ? "the oracle couldn't measure every shell"
      : 'Heal B-reps measures it'})`,
  ...(meshed ? [`Volume of the mesh: ${mm(meshVol)} mm^3${of(meshed)}`] : [])];
}

/** An error estimate to two significant digits, as short as they write. */
const errorText = (e: number) => String(Number(e.toPrecision(2)));

const hasSolid = (d: BrepData) => d.body.kind.some((k) => k === BODY_KIND.solid);

/** meshVolume, once per mesh and model. */
const meshVolumes = new WeakMap<Mesh, { d: BrepData; v: number | undefined }>();
function meshVolumeOf(d: BrepData, mesh: Mesh): number | undefined {
  const had = meshVolumes.get(mesh);
  if (had?.d === d) return had.v;
  const v = meshVolume(d, mesh);
  meshVolumes.set(mesh, { d, v });
  return v;
}

/** A face node's report (scene-graph.ts's faceReport), from its part's mesh object. */
function faceReportOf(model: NodeModel, id: number): FaceReport | undefined {
  const n = model.nodes[id]!, part = model.nodes[model.partOf(id)];
  const m = part?.object?.children.find((c) => c.userData.faceReport);
  return (m?.userData.faceReport as Record<number, FaceReport> | undefined)?.[n.face!.source];
}
