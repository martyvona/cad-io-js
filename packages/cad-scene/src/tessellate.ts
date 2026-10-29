// Driving a tessellator over a scene: one request per brep part, with the part's origin and the deflection
// converted from the scene's millimetres to the part's units; the results become the parts' meshes, with closed
// shells that are inside out (and can't be voids' boundaries) turned over, so every consumer of the meshes, not just
// the exporters, has them outward, and triangles with two corners at one position dropped first (both decided by the
// user, 2026-10-22). The meshes become the parts' tessellated levels of detail (the user, 2026-10-29: the scene holds
// its geometry, exact and meshed).

import { dropDegenerate, faceFailures, orientShells } from './mesh.ts';
import { addLod } from './lod.ts';
import type { Diagnostic, Mesh, Part, Scene } from './scene.ts';
import { meshDeflections, type MeshProfile } from './profiles.ts';
import type { TessellationResult, Tessellator } from './tessellator.ts';

export interface TessellateOptions {
  /** The meshing profile (profiles.ts), default DEFAULT_MESH_PROFILE; the deflections below replace its values. */
  profile?: MeshProfile;
  /** Maximum distance between mesh and surface, in millimetres (default the profile's). */
  linearDeflection?: number;
  /** Maximum angle between adjacent mesh normals, in radians (default the profile's). */
  angularDeflection?: number;
  edges?: boolean;
  /** Only these parts (indices); default every brep part the backend supports. */
  parts?: readonly number[];
  /** Requests in flight at once; set it to a worker pool's size. Default 1. */
  concurrency?: number;
  /**
   * Turn inside-out closed shells over (orientShells), with a warning per part. Default true; false keeps the meshes as
   * the backend gave them.
   */
  orient?: boolean;
  /**
   * Drop triangles with two corners at one position (dropDegenerate), with an info diagnostic per part. Default true;
   * false keeps them.
   */
  dropDegenerate?: boolean;
  /**
   * Where faces fail to mesh (no triangles), or a whole part does (an error, a timeout), and the part can outline its
   * faces from the source (Brep.outline): the outlines of those faces in the mesh (`faceOutlines`), and for a
   * part that failed a mesh of its faces with no triangles, only outlines (the user, 2026-10-28: so a viewer can show
   * where they are). Default false.
   */
  outlines?: boolean;
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
    faces: r.faces.map((f) => ({ source: f.entityId, start: f.start, count: f.count,
      ...(f.area !== undefined && f.area >= 0 ? { area: f.area } : {}) })),
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
 * A part's mesh with the outlines of its faces that failed (faceFailures: no triangles, or a piece with none that
 * isn't a sliver, against the part's own face list from the source where it has one, the faces left out given a
 * range of none): the backend's outlines of a face where it gave them (a failed piece's own edges), else the
 * source's (the whole face's); for a part that failed (no mesh), a mesh of its faces with only their outlines. As it
 * was if nothing failed, less any backend outlines of slivers. Outlining is approximate and must never fail a part:
 * its errors are diagnostics.
 */
function outlined(part: Part & { brep: NonNullable<Part['brep']> }, mesh: Mesh | undefined, linearDeflection: number, angularDeflection: number,
  diagnostics: Diagnostic[], source: Diagnostic['source']): Mesh | undefined {
  try {
    const d = { linearDeflection, angularDeflection };
    // (The face list alone first: outlines of none.)
    const all = part.brep.outline?.({ ...d, faces: new Set() }).faces;
    if (!mesh && !all?.length) return mesh;
    const base: Mesh = mesh ?? { origin: part.origin, positions: new Float32Array(), indices: new Uint32Array(),
      faces: [] };
    const failures = faceFailures(base, all);
    const { faceOutlinePositions: bp, faceOutlines: bo, ...bare } = base;
    const backend = (bo ?? []).filter((o) => failures.has(o.source));
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

/** Tessellate a scene's parts with B-rep the backend takes, `concurrency` at a time; their meshes added as levels. */
export async function tessellateScene(scene: Scene, tess: Tessellator,
  opts: TessellateOptions = {}): Promise<TessellateResult> {
  const { linearDeflection, angularDeflection } = meshDeflections(opts);
  const todo = (opts.parts ?? scene.parts.map((_, i) => i)).filter((i) => {
    const p = scene.parts[i];
    return !!p?.brep && tess.info.formats.includes(p.brep.format);
  });
  const perPart: Diagnostic[][] = todo.map(() => []);
  const found: (Mesh | undefined)[] = [];
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
    try {
      const r = await tess.tessellate({
        format: brep.format, data: brep.payload(), rootId: brep.rootId, origin: part.origin,
        linearDeflection: linearDeflection / part.unit, angularDeflection,
        edges: opts.edges,
      });
      for (const d of r.diagnostics) diagnostics.push(source && !d.source ? { ...d, source } : d);
      if (r.indices.length || r.positions.length || r.curves?.length || r.points?.length) mesh = toMesh(r);
      if (mesh && (opts.dropDegenerate ?? true)) {
        const d = dropDegenerate(mesh);
        mesh = d.mesh;
        if (d.dropped) {
          const n = d.dropped;
          diagnostics.push({ severity: 'info',
            message: `${n} degenerate ${n === 1 ? 'triangle' : 'triangles'} dropped (two corners at one position)`,
            ...(source ? { source } : {}) });
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
    } catch (e) {
      diagnostics.push({ severity: 'error', message: `tessellation failed: ${(e as Error).message}`,
        ...(source ? { source } : {}) });
    }
    if (opts.outlines) mesh = outlined({ ...part, brep }, mesh, linearDeflection / part.unit, angularDeflection,
      diagnostics, source);
    found[k] = mesh;
    opts.onPart?.(i, mesh, ++done, todo.length);
  };
  const lane = async () => { while (next < todo.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, todo.length)) }, lane));
  // Both in part order, whatever order the parts finished in. Each mesh a level of its part; a part that failed loses
  // an earlier level of the same backend and settings (it would stand for this run's).
  const meshes = new Map<number, Mesh>();
  const backend = `${tess.info.name} ${tess.info.version}`;
  todo.forEach((i, k) => {
    const part = scene.parts[i]!;
    const lod = { from: 'tessellated' as const, linearDeflection, angularDeflection, backend };
    if (found[k]) {
      meshes.set(i, found[k]);
      addLod(part, { mesh: found[k], ...lod });
    } else part.lods = part.lods.filter((l) => !(l.from === 'tessellated' && l.backend === backend &&
      l.linearDeflection === linearDeflection && l.angularDeflection === angularDeflection));
  });
  return { meshes, diagnostics: perPart.flat() };
}
