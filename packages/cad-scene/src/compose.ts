// The per-face fallback's composite: one backend's result for a part with some faces' triangles taken from
// another's result for it. The two meshes meet along those faces' edges with each backend's own points, so the
// composite is to be joined (joinResult) before it's used.

import type { BrepData } from 'cad-brep';
import { failedMessage } from './fill.ts';
import { edgeUsers, openEdges, openEdgesCount, openEdgesMessage } from './open-edges.ts';
import type { Diagnostic } from './scene.ts';
import type { TessellationResult } from './tessellator.ts';

/**
 * `a` with the faces `faces` (by id) meshed as in `b`: their triangles, measures and edges' polylines `b`'s (an edge
 * only these faces use `b`'s, else `a`'s where it has one), the rest `a`'s; both results for the same request (one
 * origin). Normals where both have them. Its diagnostics: `a`'s but its errors for faces that failed and open edges,
 * which are made again for the composite (open edges by openEdges, not yet joined).
 */
export function composeResults(d: BrepData, a: TessellationResult, b: TessellationResult,
  faces: ReadonlySet<number>): TessellationResult {
  const na = a.positions.length / 3;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const normals = a.normals && b.normals ? new Float32Array(positions.length) : undefined;
  if (normals) { normals.set(a.normals!); normals.set(b.normals!, a.positions.length); }
  const indices: number[] = [];
  const outFaces: TessellationResult['faces'] = [];
  for (const f of a.faces) {
    if (f.entityId !== null && faces.has(f.entityId)) continue;
    outFaces.push({ ...f, start: indices.length });
    for (let k = f.start; k < f.start + f.count; k++) indices.push(a.indices[k]!);
  }
  for (const f of b.faces) {
    if (f.entityId === null || !faces.has(f.entityId)) continue;
    outFaces.push({ ...f, start: indices.length });
    for (let k = f.start; k < f.start + f.count; k++) indices.push(b.indices[k]! + na);
  }
  // Edges: by who uses them.
  const users = edgeUsers(d);
  const fromB = (id: number | null) => {
    if (id === null) return false;
    const us = users.get(id);
    if (us && us.length && us.every((f) => faces.has(f))) return true;
    return !(a.edges ?? []).some((e) => e.entityId === id) && !!us?.some((f) => faces.has(f));
  };
  const ep: number[] = [];
  const edges: NonNullable<TessellationResult['edges']> = [];
  const take = (r: TessellationResult, keep: (id: number | null) => boolean) => {
    for (const e of r.edges ?? []) {
      if (!keep(e.entityId)) continue;
      edges.push({ ...e, start: ep.length / 3 });
      for (let k = 3 * e.start; k < 3 * (e.start + e.count); k++) ep.push(r.edgePositions![k]!);
    }
  };
  take(a, (id) => !fromB(id));
  take(b, fromB);
  const measures = [...(a.measures ?? []).filter((m) => !faces.has(m.entityId)),
    ...(b.measures ?? []).filter((m) => faces.has(m.entityId))];
  const { normals: _, ...rest } = a;
  const out: TessellationResult = { ...rest, positions, indices: Uint32Array.from(indices), faces: outFaces,
    ...(normals ? { normals } : {}),
    ...(a.edges || b.edges ? { edges, edgePositions: Float32Array.from(ep) } : {}),
    ...(a.measures || b.measures ? { measures } : {}), diagnostics: [] };
  if (a.outlines) out.outlines = a.outlines.filter((o) => o.entityId === null || !faces.has(o.entityId));
  // The diagnostics: a's, but its failed faces and open edges told again.
  const kept: Diagnostic[] = a.diagnostics.filter((x) => !(x.severity === 'error'
    && (/^\d+ faces failed to mesh/.test(x.message) || openEdgesCount([x]))));
  const meshed = new Set(outFaces.filter((f) => f.count > 0).map((f) => f.entityId));
  const failed = [...new Set(d.face.id)].filter((id) => id && !meshed.has(id)).sort((x, y) => x - y);
  if (failed.length) kept.push({ severity: 'error', message: failedMessage(failed) });
  const open = openEdges(d, out).open.length;
  if (open) kept.push({ severity: 'error', message: openEdgesMessage(open) });
  out.diagnostics = kept;
  return out;
}
