// The model edges a part's mesh is open along, from a backend's result and the part's B-rep model alone: whatever the
// backend says. Backends that mesh faces together and never join them (OCCT, truck) don't know when their faces'
// meshes miss each other along an edge; this tells, and the same error message is given by every backend (SMLib's
// wrapper counts its own while joining).

import { type BrepData, openBrep } from 'cad-brep';
import { weld } from './mesh.ts';
import type { TessellationResult } from './tessellator.ts';
import type { Diagnostic } from './scene.ts';

/** The error for a result open along `n` model edges (every backend's wording). */
export function openEdgesMessage(n: number): string {
  return `${n} edges along which the meshes of the faces they join don't meet: the mesh is open there`;
}

/** The open edges an error diagnostic of openEdgesMessage's counts, summed over `diagnostics` (0 if none). */
export function openEdgesCount(diagnostics: readonly Diagnostic[]): number {
  let n = 0;
  for (const d of diagnostics) {
    const m = d.severity === 'error' ? /^(\d+) edges along which the meshes of the faces they join don't meet/
      .exec(d.message) : null;
    if (m) n += Number(m[1]);
  }
  return n;
}

/** Each edge id's faces, by id, as the model's loops use them (faces and edges without an id left out). */
export function edgeUsers(d: BrepData): Map<number, number[]> {
  const users = new Map<number, number[]>();
  const f = d.face, l = d.loop, c = d.coedge;
  for (let row = 0; row < f.surface.length; row++) {
    const face = f.id[row]!;
    if (!face) continue;
    for (let k = f.firstLoop[row]!, end = k + f.loopCount[row]!; k < end; k++) {
      // (LOOP_KIND edge: 1; vertex and poly loops have no edges.)
      if (l.kind[k] !== 1) continue;
      for (let j = l.first[k]!, last = j + l.count[k]!; j < last; j++) {
        const id = d.edge.id[c.edge[j]!]!;
        if (!id) continue;
        const us = users.get(id);
        if (!us) users.set(id, [face]);
        else if (!us.includes(face)) us.push(face);
      }
    }
  }
  return users;
}

/**
 * The model edges (ids) along which the result's mesh is open: among those two or more faces use whose faces all
 * have triangles, the ones whose polyline has a segment that only one triangle has. Vertices are one where their
 * positions are the same numbers (as output: single precision, minus the origin), so the faces' meshes must share
 * their points exactly. Mesh edges are placed on model edges by the result's edge polylines: such an edge without one
 * can't be judged (`unjudged`). A segment from a point to itself is no gap. A result without edges judges none.
 */
export function openEdges(d: BrepData, r: Pick<TessellationResult, 'positions' | 'indices' | 'faces' | 'edges' |
  'edgePositions'>): { open: number[]; unjudged: number[] } {
  if (!r.edges || !r.edgePositions || !r.indices.length) return { open: [], unjudged: [] };
  const users = edgeUsers(d);
  const meshed = new Set<number>();
  for (const f of r.faces) if (f.count > 0 && f.entityId !== null) meshed.add(f.entityId);
  const judged = (id: number | null) => {
    const us = id === null ? undefined : users.get(id);
    return !!us && us.length >= 2 && us.every((f) => meshed.has(f));
  };
  // Mesh vertices then edge points, welded together.
  const nv = r.positions.length / 3, ne = r.edgePositions.length / 3;
  const all = new Float32Array(3 * (nv + ne));
  all.set(r.positions);
  all.set(r.edgePositions, 3 * nv);
  const { remap, positions } = weld(all);
  const n = positions.length / 3;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  // Only mesh edges with both ends on a judged edge's polyline can be on one: counted, the rest not.
  const onEdge = new Uint8Array(n);
  const drawn = new Set<number>();
  for (const e of r.edges) {
    if (!judged(e.entityId)) continue;
    drawn.add(e.entityId!);
    for (let k = e.start; k < e.start + e.count; k++) onEdge[remap[nv + k]!] = 1;
  }
  const uses = new Map<number, number>();
  const ix = r.indices;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = remap[ix[t + j]!]!, b = remap[ix[t + (j + 1) % 3]!]!;
      if (a === b || !onEdge[a] || !onEdge[b]) continue;
      const k = key(a, b);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  const open = new Set<number>();
  for (const e of r.edges) {
    if (!drawn.has(e.entityId!) || open.has(e.entityId!)) continue;
    for (let k = e.start; k + 1 < e.start + e.count; k++) {
      const a = remap[nv + k]!, b = remap[nv + k + 1]!;
      if (a !== b && uses.get(key(a, b)) === 1) { open.add(e.entityId!); break; }
    }
  }
  const unjudged = [...users.keys()].filter((id) => judged(id) && !drawn.has(id));
  return { open: [...open], unjudged };
}

/** The error diagnostic for a result's open edges (openEdges), or none; the model or its buffer's bytes. */
export function openEdgesDiagnostic(model: BrepData | Uint8Array, r: Parameters<typeof openEdges>[1]):
  Diagnostic | undefined {
  const { open } = openEdges(model instanceof Uint8Array ? openBrep(model) : model, r);
  return open.length ? { severity: 'error', message: openEdgesMessage(open.length) } : undefined;
}
