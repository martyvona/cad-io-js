// Driving a tessellator over a scene: one request per brep part, with the part's origin and the deflection (all in
// millimetres, as the models are); the results become the parts' meshes, their faces joined exactly along the model
// edges where only their points differ (join.ts), with closed shells that are inside out (and can't be voids'
// boundaries) turned over, so every consumer of the meshes, not just the exporters, has them outward, and triangles
// with two corners at one position dropped first. The meshes become the parts' tessellated
// levels of detail (the scene holds its geometry, exact and meshed).

import { degenerateMessage, dropDegenerate, faceFailures, orientShells } from './mesh.ts';
import { notManifoldDiagnostic } from './manifold.ts';
import { openEdgesCount } from './open-edges.ts';
import { addLod } from './lod.ts';
import { meshBox, sceneBounds } from './bounds.ts';
import type { BrepData } from 'cad-brep';
import type { Diagnostic, FaceMeasures, Measures, Mesh, Part, Scene } from './scene.ts';
import { meshDeflections, type MeshProfile } from './profiles.ts';
import type { FaceRecords, TessellationResult, Tessellator } from './tessellator.ts';
import { ORACLE_DISAGREE, ORACLE_REPLACE } from './area-oracle.ts';
import { fillResult } from './fill.ts';
import { joinResult } from './join.ts';
import { faceRecords } from './records.ts';
import { classifyAll, CRITERIA, type FaceClass, resolveTarget, type Target, type TargetName } from './targets.ts';
import { orientResult, shellsOriented } from './orient.ts';
import { describeWires, missingWires, noneMissing } from './wires.ts';

export interface TessellateOptions {
  /** The meshing profile (profiles.ts), default DEFAULT_MESH_PROFILE; the deflections below replace its values. */
  profile?: MeshProfile;
  /** Maximum distance between mesh and surface, in millimetres (default the profile's). */
  linearDeflection?: number;
  /** Maximum angle between adjacent mesh normals, in radians (default the profile's). */
  angularDeflection?: number;
  /** The smallest angle asked of the triangles, radians (TessellationRequest's minAngle); default the backend's. */
  minAngle?: number;
  edges?: boolean;
  /** Only these parts (indices); default every brep part the backend supports. */
  parts?: readonly number[];
  /** Requests in flight at once; set it to a worker pool's size. Default 1. */
  concurrency?: number;
  /**
   * Turn shells facing into the material over, with a warning per part: by the model, solids' shells whose closed
   * meshes enclose volume of the wrong sign (orientResult: the outer shell's to be positive, a void's negative; the
   * B-rep keeps the source's orientation), then by the mesh alone, inside-out closed pieces no other encloses
   * (orientShells). Default true; false keeps the meshes as the backend gave them.
   */
  orient?: boolean;
  /**
   * Drop triangles with two corners at one position (dropDegenerate), with an info diagnostic per part. Default true;
   * false keeps them.
   */
  dropDegenerate?: boolean;
  /**
   * Check each part's mesh, as kept (after dropDegenerate and orient), is a closed, oriented manifold over its model's
   * closed shells (manifold.ts's shellDefects), with an error diagnostic per part where it isn't. Default true.
   */
  manifold?: boolean;
  /**
   * Where faces fail to mesh (no triangles), or a whole part does (an error, a timeout), and the part can outline its
   * faces from the source (Brep.outline): the outlines of those faces in the mesh (`faceOutlines`), and for a part that
   * failed a mesh of its faces with no triangles, only outlines (so a viewer can show where they are). Default false.
   */
  outlines?: boolean;
  /**
   * Ask the backend for each face's measures on the exact geometry (area, perimeter, soundness) where the part has
   * none, and keep them (Part.measures), so faces are judged by them (faceFailures). Default true; parts that have
   * measures (read from one of our exports, or measured before) aren't measured again.
   */
  measures?: boolean;
  /**
   * Ask for each face's triage record (TessellationRequest.records, with measures for its area) and keep it with
   * the level (Lod.records): the backend's result's, measured where it ran (a pool's worker), else here (without the
   * part's size or expected counts: tess-cadio isn't loaded on this thread). Default false.
   */
  records?: boolean;
  /**
   * The target (targets.ts, docs/triage.md) each part's mesh is for: its meshing limits sent in each request (its
   * minAngle unless `minAngle` is given, its longest edge and elementary faces' stretch cap), records asked for
   * (`records`), a tessellator choosing among backends choosing each face's mesh by it (FallbackTessellator), and
   * each face classed by it (classifyAll) on the result: a face in error under it withheld (its triangles left out),
   * with an error per part naming them, and a warning per part counting the faces warned of. The level keeps the
   * target's name (Lod.target) and the faces withheld. Default none: nothing classed or withheld.
   */
  target?: TargetName | Target;
  /**
   * In the measures kept, a face's area and perimeter by the area oracle (the result's `oracle`, where it trusts
   * them) in place of the backend's where the backend's are unsound or missing, or more than ORACLE_DISAGREE off an
   * oracle area whose error is within ORACLE_REPLACE of it, with a warning per part: a backend can mesh a face wrongly and measure it as wrongly. Default true; false keeps the
   * backend's.
   */
  oracle?: boolean;
  /**
   * Join the meshes of faces along the model edges where they don't meet but each reaches the whole edge (joinEdges:
   * the faces' points along it made the same, T-junctions split, points within JOIN_SNAP of the deflection one),
   * with a note per part; the open-edge error then counts the edges still open. The backend is asked for edges to join
   * by, which the meshes keep only if `edges` asks. Default true; false keeps the meshes as the backend gave them.
   */
  join?: boolean;
  /**
   * Fill the faces no backend meshed that are narrower than the deflection (fillFaces: triangles between their rim's
   * points, their neighbours', so they meet them exactly; kept only where their area agrees with the face's exact
   * one), with a warning per part naming them; the faces-failed error then counts those left. The backend is asked
   * for edges (the rims), which the meshes keep only if `edges` asks. Default true; false leaves those faces out.
   */
  fill?: boolean;
  /** Called after each part, in the order parts finish, for progress reporting. */
  onPart?: (part: number, mesh: Mesh | undefined, done: number, total: number) => void;
}

export interface TessellateResult {
  /**
   * The meshes this call made, by part index, also added to the parts' levels (`lods`). Parts that failed are absent;
   * their problems are in `diagnostics`.
   */
  meshes: Map<number, Mesh>;
  diagnostics: Diagnostic[];
}

/** A tessellation result as a scene mesh. */
export function toMesh(r: TessellationResult): Mesh {
  const mesh: Mesh = {
    origin: r.origin, positions: r.positions, indices: r.indices,
    faces: r.faces.map((f) => ({ source: f.entityId, start: f.start, count: f.count })),
  };
  if (r.normals) mesh.normals = r.normals;
  if (r.edgePositions && r.edges) {
    mesh.edgePositions = r.edgePositions;
    mesh.edges = r.edges.map((e) => {
      const out: NonNullable<Mesh['edges']>[number] = { source: e.entityId, start: e.start, count: e.count,
        kind: e.kind };
      if (e.dihedral !== undefined) out.dihedral = e.dihedral;
      return out;
    });
  }
  if (r.curvePositions && r.curves) {
    mesh.curvePositions = r.curvePositions;
    mesh.curves = r.curves.map((c) => ({ source: c.entityId, start: c.start, count: c.count }));
  }
  if (r.points && r.pointIds) {
    mesh.points = r.points;
    mesh.pointSources = r.pointIds;
  }
  if (r.outlinePositions && r.outlines?.length) {
    mesh.faceOutlinePositions = r.outlinePositions;
    mesh.faceOutlines = r.outlines.flatMap((o) => o.entityId === null ? [] : [{ source: o.entityId, start: o.start,
      count: o.count }]);
  }
  return mesh;
}

/**
 * A part's mesh with the outlines of its faces that failed (faceFailures, against the part's own face list from the
 * source where it has one, the faces left out given a range of none, and by the part's measures where it has them): a
 * face that failed wholly by the backend's polylines where it gave them (a failed piece's own edges, meeting its
 * neighbours' meshes), else the source's; one that failed otherwise (partly, excess, unverified) by the source's whole
 * outline. For a part that failed (no mesh), a mesh of its faces with only their outlines. As it was if nothing failed,
 * less any backend outlines of faces that didn't. Outlining is approximate and must never fail a part: its errors are
 * diagnostics.
 */
function outlined(part: Part & { brep: NonNullable<Part['brep']> }, mesh: Mesh | undefined, linearDeflection: number,
  angularDeflection: number, diagnostics: Diagnostic[], source: Diagnostic['source'], measures: Measures | undefined):
  Mesh | undefined {
  try {
    const d = { linearDeflection, angularDeflection };
    // (The face list alone first: outlines of none.)
    const all = part.brep.outline?.({ ...d, faces: new Set() }).faces;
    if (!mesh && !all?.length) return mesh;
    const base: Mesh = mesh ?? { origin: part.origin, positions: new Float32Array(), indices: new Uint32Array(),
      faces: [] };
    const failures = faceFailures(base, { ...(all ? { expected: all } : {}),
      ...(measures ? { measured: { measures, deflection: linearDeflection } } : {}) });
    const { faceOutlinePositions: bp, faceOutlines: bo, ...bare } = base;
    // (The backend's outlines are its empty pieces' edges: for a face that failed wholly.)
    const backend = (bo ?? []).filter((o) => failures.get(o.source) === 'failed');
    if (!failures.size) return bo ? bare : mesh;
    const covered = new Set(backend.map((o) => o.source));
    const fromSource = new Set([...failures.keys()].filter((f) => !covered.has(f)));
    const o = fromSource.size && part.brep.outline ? part.brep.outline({ ...d, faces: fromSource })
      : { positions: new Float32Array(), outlines: [] };
    // The backend's polylines, then the source's, in one array.
    const counts = backend.reduce((n, l) => n + l.count, 0);
    const positions = new Float32Array(3 * counts + o.positions.length);
    const outlines: NonNullable<Mesh['faceOutlines']> = [];
    let at = 0;
    for (const l of backend) {
      positions.set(bp!.subarray(3 * l.start, 3 * (l.start + l.count)), 3 * at);
      outlines.push({ source: l.source, start: at, count: l.count });
      at += l.count;
    }
    positions.set(o.positions, 3 * at);
    for (const l of o.outlines) outlines.push({ ...l, start: l.start + at });
    const end = base.indices.length;
    const present = new Set(base.faces.map((f) => f.source));
    const absent = (all ?? []).filter((f) => !present.has(f)).map((f) => ({ source: f, start: end, count: 0 }));
    return { ...bare, faces: [...base.faces, ...absent],
      ...(outlines.length ? { faceOutlinePositions: positions, faceOutlines: outlines } : {}) };
  } catch (e) {
    diagnostics.push({ severity: 'warning', message: `outlining the faces that failed: ${(e as Error).message}`,
      ...(source ? { source } : {}) });
    return mesh;
  }
}

/** The error for faces meshed short of or over their measured areas (by id: at most 10 named). */
export function areaMessage(ids: readonly number[]): string {
  const n = ids.length;
  return `${n} ${n === 1 ? 'face' : 'faces'} meshed short of or over ${n === 1 ? 'its' : 'their'} measured area: `
    + ids.slice(0, 10).map((i) => `#${i}`).join(', ') + (n > 10 ? ', ...' : '');
}

/**
 * A result judged by a target (tessellateScene's `target`): each face classed by its record (classifyAll), the faces
 * in error withheld (their triangles left out, their ranges kept with none), an error naming them with the criteria
 * they fail, and a warning counting the faces warned of by criterion. The records stay the meshes' as judged, the
 * withheld faces' included.
 */
export function judgeByTarget(r: TessellationResult, target: Target, ctx: { linearDeflection: number;
  angularDeflection: number }): { result: TessellationResult; withheld: number[]; diagnostics: Diagnostic[] } {
  if (!r.records) return { result: r, withheld: [], diagnostics: [] };
  const { faces } = classifyAll(r.records, target, ctx);
  const errors = faces.filter((f) => f.overall === 'error'), warned = faces.filter((f) => f.overall === 'warn');
  const tally = (list: typeof faces, cls: FaceClass) => CRITERIA.map((x) => [x, list.filter((f) =>
    f.criteria[x].class === cls).length] as const).filter(([, n]) => n).map(([x, n]) => `${x} ${n}`).join(', ');
  const diagnostics: Diagnostic[] = [];
  const withheld = errors.map((f) => f.entityId).sort((a, b) => a - b);
  if (withheld.length) {
    const n = withheld.length;
    // (Where the fallback meshed some of them too, in error itself or put back: its criteria, counted alike.)
    const fe = r.fallbackErrors, also = new Map((fe?.faces ?? []).map((x) => [x.entityId, x.criteria]));
    const theirs = withheld.filter((x) => also.has(x)), m = theirs.length;
    const counts = CRITERIA.map((x) => [x, theirs.filter((id) => also.get(id)!.includes(x)).length] as const)
      .filter(([, k]) => k).map(([x, k]) => `${x} ${k}`).join(', ');
    diagnostics.push({ severity: 'error', message: `${n} ${n === 1 ? 'face' : 'faces'} withheld, in error under the `
      + `${target.name} target (${tally(errors, 'error')}): ${withheld.slice(0, 10).map((x) => `#${x}`).join(', ')}`
      + (n > 10 ? ', ...' : '') + (m ? `; the fallback's (${fe!.by}) mesh of ${m === 1 ? 'it' : m === n ? 'them'
        : `${m} of them`} in error too (${counts})` : '') });
  }
  if (warned.length) {
    const n = warned.length;
    diagnostics.push({ severity: 'warning', message: `${n} ${n === 1 ? 'face' : 'faces'} warned of under the `
      + `${target.name} target (${tally(warned, 'warn')})` });
  }
  if (!withheld.length) return { result: r, withheld, diagnostics };
  const out = new Set(withheld);
  const kept: number[] = [];
  const ranges = r.faces.map((f) => {
    const start = kept.length;
    if (f.entityId === null || !out.has(f.entityId)) for (let t = f.start; t < f.start + f.count; t++) {
      kept.push(r.indices[t]!);
    }
    return { entityId: f.entityId, start, count: kept.length - start };
  });
  return { result: { ...r, indices: Uint32Array.from(kept), faces: ranges }, withheld, diagnostics };
}

/** How many shells use each face, by its id (faces with no id or in no shell left out). */
export function faceUses(d: BrepData): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of d.faceUse.face) {
    const id = d.face.id[f]!;
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/**
 * Tessellate a scene's B-rep parts, `concurrency` at a time; their meshes added as levels. Requests carry each part's
 * B-rep model (`cad-brep`): a backend that reads another format goes behind a tessellator that writes it (step-export's
 * StepTessellator, for STEP); one that takes none of them meshes nothing, with an error saying so.
 */
export async function tessellateScene(scene: Scene, tess: Tessellator,
  opts: TessellateOptions = {}): Promise<TessellateResult> {
  const { linearDeflection, angularDeflection } = meshDeflections(opts);
  const target = opts.target === undefined ? undefined : resolveTarget(opts.target);
  const minAngle = opts.minAngle ?? target?.meshing.minAngle;
  const records = opts.records || !!target;
  const m = target?.meshing;
  const limits = m ? { ...(m.maxEdge !== undefined ? { maxEdge: m.maxEdge } : {}),
    ...(m.elementaryStretchCap !== undefined ? { elementaryStretchCap: m.elementaryStretchCap } : {}), target } : {};
  const breps = (opts.parts ?? scene.parts.map((_, i) => i)).filter((i) => !!scene.parts[i]?.brep);
  const takes = tess.info.formats.includes('cad-brep');
  const todo = takes ? breps : [];
  const perPart: Diagnostic[][] = todo.map(() => []);
  const found: (Mesh | undefined)[] = [];
  // Which backend made each part's result: the tessellator, or the one a result names.
  const madeBy: string[] = [];
  const recordsOf: (FaceRecords | undefined)[] = [];
  const withheldOf: (number[] | undefined)[] = [];
  // (A result may name another: FallbackTessellator's say which of its backends made them.)
  const backend = `${tess.info.name} ${tess.info.version}`;
  let done = 0;
  let next = 0;
  const one = async (k: number) => {
    const i = todo[k]!;
    const part = scene.parts[i]!;
    if (!part.brep) return;
    const brep = part.brep;
    const diagnostics = perPart[k]!;
    const source = part.sources[0];
    let mesh: Mesh | undefined;
    let by = backend;
    const measure = (opts.measures ?? true) && !part.measures;
    try {
      const join = opts.join ?? true, fill = opts.fill ?? true;
      let r = await tess.tessellate({
        format: 'cad-brep', data: new Uint8Array(brep.model.buffer), origin: part.origin,
        linearDeflection, angularDeflection, ...(minAngle !== undefined ? { minAngle } : {}), ...limits,
        ...(brep.analysis ? { analysis: new Uint8Array(brep.analysis.buffer) } : {}),
        edges: join || fill || opts.edges, ...(measure || records ? { measures: true } : {}),
        ...(records ? { records: true } : {}),
      });
      // (A tessellator that didn't measure them, run on this thread: measured here, before the join.)
      if (records && !r.records) r = { ...r, records: faceRecords({ linearDeflection,
        ...(minAngle !== undefined ? { minAngle } : {}) }, r, brep.model) };
      if (join) r = joinResult(brep.model, r, linearDeflection);
      if (fill) r = fillResult(brep.model, r, linearDeflection);
      if (opts.orient ?? true) r = orientResult(brep.model, r, linearDeflection, shellsOriented(brep.analysis)
        ? { backend: r.backend ?? backend } : undefined);
      if ((join || fill) && !opts.edges) { r = { ...r }; delete r.edges; delete r.edgePositions; }
      by = r.backend ?? backend;
      if (records) recordsOf[k] = r.records;
      if (target && r.records) {
        const judged = judgeByTarget(r, target, { linearDeflection, angularDeflection });
        r = judged.result;
        withheldOf[k] = judged.withheld;
        for (const d of judged.diagnostics) diagnostics.push(source ? { ...d, source } : d);
      }
      for (const d of r.diagnostics) diagnostics.push(source && !d.source ? { ...d, source } : d);
      // The model's wireframe curves and points the result left out: no mesh of them, so the viewer and every export
      // lack them (a backend that meshes faces alone; FallbackTessellator asks its fallback for them first).
      const lacking = missingWires(brep.model, r);
      if (!noneMissing(lacking)) diagnostics.push({ severity: 'warning', message: `${describeWires(lacking)} not `
        + `meshed by ${tess.info.name} (left out of its result)`, ...(source ? { source } : {}) });
      // (Kept at once, so `onPart` sees them.)
      if (measure && (r.measures?.length || r.oracle?.length)) {
        const uses = faceUses(brep.model);
        const faces = new Map<number, FaceMeasures>();
        const add = (id: number, m: { area: number; perimeter: number; valid: boolean }) => {
          const n = uses.get(id) ?? 1;
          faces.set(id, { area: m.area, perimeter: m.perimeter, valid: m.valid, ...(n > 1 ? { uses: n } : {}) });
        };
        for (const x of r.measures ?? []) add(x.entityId, x);
        let replaced = 0;
        if (opts.oracle ?? true) for (const o of r.oracle ?? []) {
          const m = faces.get(o.entityId);
          // (An area without an error estimate is one the oracle trusts at its own level, ORACLE_RELATIVE.)
          const sure = o.error === undefined || o.error <= ORACLE_REPLACE * o.area;
          const keep = m && m.valid && Number.isFinite(m.area)
            && (!sure || Math.abs(m.area - o.area) <= ORACLE_DISAGREE * o.area);
          if (!keep) {
            // (A face the backend didn't measure, as truck can't, isn't a disagreement.)
            if (m) replaced++;
            add(o.entityId, { area: o.area, perimeter: o.perimeter, valid: true });
          }
          // The oracle's area with its error, for users, whichever area is kept.
          if (Number.isFinite(o.error)) faces.get(o.entityId)!.oracle = { area: o.area, error: o.error! };
        }
        part.measures = { by: replaced ? `${by}, the area oracle's for ${replaced} ${replaced === 1 ? 'face' : 'faces'}`
          : by, faces };
        if (replaced) diagnostics.push({ severity: 'warning', message: `${replaced} ${replaced === 1 ? 'face\'s'
          : 'faces\''} measured area replaced by the area oracle's (the backend's more than ${100 * ORACLE_DISAGREE}% `
          + 'off, or unsound)', ...(source ? { source } : {}) });
      }
      if (r.indices.length || r.positions.length || r.curves?.length || r.points?.length) mesh = toMesh(r);
      if (mesh && (opts.dropDegenerate ?? true)) {
        const d = dropDegenerate(mesh);
        mesh = d.mesh;
        if (d.dropped) {
          diagnostics.push({ severity: 'info', message: degenerateMessage(d.dropped), ...(source ? { source } : {}) });
        }
      }
      if (mesh && (opts.orient ?? true)) {
        const o = orientShells(mesh);
        mesh = o.mesh;
        if (o.turned) {
          const n = o.turned;
          diagnostics.push({ severity: 'warning',
            message: `${n} closed ${n === 1 ? 'shell' : 'shells'} turned over (inside out, and inside no other shell)`,
            ...(source ? { source } : {}) });
        }
      }
      if (mesh && (opts.manifold ?? true)) {
        const x = notManifoldDiagnostic(brep.model, mesh, openEdgesCount(diagnostics) > 0);
        if (x) diagnostics.push({ ...x, ...(source ? { source } : {}) });
      }
    } catch (e) {
      diagnostics.push({ severity: 'error', message: `tessellation failed: ${(e as Error).message}`,
        ...(source ? { source } : {}) });
    }
    // Faces meshed short of or over their area (by the part's measures): errors, as faces that fail to mesh are.
    // (Faces without triangles are the backend's to say.)
    if (mesh && part.measures) {
      const off = [...faceFailures(mesh, { measured: { measures: part.measures, deflection: linearDeflection } })]
        .filter(([, k]) => k === 'partly' || k === 'excess').map(([id]) => id).sort((a, b) => a - b);
      if (off.length) diagnostics.push({ severity: 'error', message: areaMessage(off), ...(source ? { source } : {}) });
    }
    if (opts.outlines) mesh = outlined({ ...part, brep }, mesh, linearDeflection, angularDeflection,
      diagnostics, source, part.measures);
    const box = mesh && meshBox(mesh);
    if (box) mesh!.box = box;
    found[k] = mesh;
    madeBy[k] = by;
    opts.onPart?.(i, mesh, ++done, todo.length);
  };
  const lane = async () => { while (next < todo.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, todo.length)) }, lane));
  // Both in part order, whatever order the parts finished in. Each mesh a level of its part; a part that failed loses
  // an earlier level of the same backend and settings (it would stand for this run's).
  const meshes = new Map<number, Mesh>();
  todo.forEach((i, k) => {
    const part = scene.parts[i]!;
    const lod = { from: 'tessellated' as const, linearDeflection, angularDeflection,
      ...(minAngle !== undefined ? { minAngle } : {}), backend: madeBy[k]!,
      ...(target ? { target: target.name } : {}), ...(recordsOf[k] ? { records: recordsOf[k] } : {}),
      ...(withheldOf[k]?.length ? { withheld: withheldOf[k] } : {}) };
    if (found[k]) {
      meshes.set(i, found[k]);
      addLod(part, { mesh: found[k], ...lod });
    } else part.lods = part.lods.filter((l) => !(l.from === 'tessellated' && l.backend === madeBy[k] &&
      l.linearDeflection === linearDeflection && l.angularDeflection === angularDeflection &&
      l.minAngle === minAngle && l.target === target?.name));
  });
  // The model's sphere again from the meshes alone, which can shrink an estimate (decision 3); a file's kept.
  if (scene.bounds?.from !== 'source') scene.bounds = sceneBounds(scene, { meshesOnly: true }) ?? scene.bounds;
  const refused: Diagnostic[] = takes || !breps.length ? [] : [{ severity: 'error', message: `${breps.length} B-rep `
    + `${breps.length === 1 ? 'part' : 'parts'} not meshed: the backend (${backend}) takes ${tess.info.formats
      .join(', ')}, not B-rep models (cad-brep)` }];
  return { meshes, diagnostics: [...refused, ...perPart.flat()] };
}
