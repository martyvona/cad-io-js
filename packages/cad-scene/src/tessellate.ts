// Driving a tessellator over a scene: one request per brep part, with the part's origin and the deflection
// converted from the scene's millimetres to the part's units; the results become the parts' meshes, with closed
// shells that are inside out (and can't be voids' boundaries) turned over, so every consumer of the meshes, not just
// the exporters, has them outward, and triangles with two corners at one position dropped first (both decided by the
// user, 2026-10-22).

import { dropDegenerate, orientShells } from './mesh.ts';
import type { Diagnostic, Mesh, Scene } from './scene.ts';
import type { TessellationResult, Tessellator } from './tessellator.ts';

export interface TessellateOptions {
  /** Maximum distance between mesh and surface, in millimetres. */
  linearDeflection: number;
  /** Maximum angle between adjacent mesh normals, in radians. */
  angularDeflection: number;
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
  /** Called after each part, in the order parts finish, for progress reporting. */
  onPart?: (part: number, mesh: Mesh | undefined, done: number, total: number) => void;
}

export interface TessellateResult {
  /** Meshes by part index. Parts that failed are absent; their problems are in `diagnostics`. */
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
  return mesh;
}

/** Tessellate a scene's brep parts, `concurrency` at a time. */
export async function tessellateScene(scene: Scene, tess: Tessellator,
  opts: TessellateOptions): Promise<TessellateResult> {
  const todo = (opts.parts ?? scene.parts.map((_, i) => i)).filter((i) => {
    const p = scene.parts[i];
    return p?.kind === 'brep' && tess.info.formats.includes(p.format);
  });
  const perPart: Diagnostic[][] = todo.map(() => []);
  const found: (Mesh | undefined)[] = [];
  let done = 0;
  let next = 0;
  const one = async (k: number) => {
    const i = todo[k]!;
    const part = scene.parts[i]!;
    if (part.kind !== 'brep') return;
    const diagnostics = perPart[k]!;
    const source = part.sources[0];
    let mesh: Mesh | undefined;
    try {
      const r = await tess.tessellate({
        format: part.format, data: part.payload(), rootId: part.rootId, origin: part.origin,
        linearDeflection: opts.linearDeflection / part.unit, angularDeflection: opts.angularDeflection,
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
    found[k] = mesh;
    opts.onPart?.(i, mesh, ++done, todo.length);
  };
  const lane = async () => { while (next < todo.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, todo.length)) }, lane));
  // Both in part order, whatever order the parts finished in.
  const meshes = new Map<number, Mesh>();
  todo.forEach((i, k) => { if (found[k]) meshes.set(i, found[k]); });
  return { meshes, diagnostics: perPart.flat() };
}
