// Whether a part's mesh is a closed, oriented 2-manifold over each of its model's closed shells, from the mesh and
// the part's B-rep model alone: what mesh booleans (Manifold) and slicers need. Every backend's result, whatever it
// says: a face meshed as its complement (with its area right), or wound against its neighbours, leaves every other
// check quiet. Topology only: no self-intersection test.

import type { BrepData } from 'cad-brep';
import { weld } from './mesh.ts';
import type { Diagnostic } from './scene.ts';

/** cad-brep's SHELL_KIND.closed. */
const CLOSED = 1;

/** A mesh's faces as a result (`entityId`) or a scene mesh (`source`) names them. */
type FaceRange = { entityId?: number | null; source?: number | null; start: number; count: number };

/** What keeps a part's mesh from being a closed, oriented manifold over its model's closed shells. */
export interface ShellDefects {
  /** Closed shells judged: those whose faces all have triangles (a face without is open by design). */
  shells: number;
  /** Mesh edges used once, used twice the same way, used more than twice. */
  open: number;
  misoriented: number;
  nonManifold: number;
  /** Vertices whose triangles in their shell aren't one fan closed around them (a vertex on such an edge too). */
  vertices: number;
  /** The faces (ids) whose triangles have those edges or vertices, by how many, most first (then by id). */
  faces: [number, number][];
  /** The same by kind: edges used once, the other edges, vertices (for `reported`). */
  facesBy: { open: [number, number][]; edges: [number, number][]; vertices: [number, number][] };
}

/** Face counts (id to count) as `faces` lists them: most first, then by id. */
const ranked = (m: Map<number, number>): [number, number][] => [...m].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
/** Face counts summed over lists of them, ranked. */
function sum(...lists: [number, number][][]): [number, number][] {
  const m = new Map<number, number>();
  for (const l of lists) for (const [f, n] of l) m.set(f, (m.get(f) ?? 0) + n);
  return ranked(m);
}

/**
 * Each judged closed shell's mesh (`positions` and `indices` as shipped, `faces` naming each range's face), welded at
 * its exact positions: every edge used exactly twice, once each way, and every vertex's triangles one fan closed
 * around it. Triangles with two corners at one position aren't judged (dropDegenerate drops them), so the verdict is
 * the same before that pass and after. A face the model uses more than once is meshed once a use, so its triangles'
 * exact repeats count once. A shell is judged only if every face it uses has triangles; faces without an id, and
 * shells of no such faces, are left out.
 */
export function shellDefects(d: BrepData, mesh: { positions: Float32Array; indices: Uint32Array;
  faces: readonly FaceRange[] }): ShellDefects {
  const out: ShellDefects = { shells: 0, open: 0, misoriented: 0, nonManifold: 0, vertices: 0, faces: [],
    facesBy: { open: [], edges: [], vertices: [] } };
  const uses = new Map<number, number>();
  for (let k = 0; k < d.faceUse.face.length; k++) {
    const id = d.face.id[d.faceUse.face[k]!]!;
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const ranges = new Map<number, FaceRange[]>();
  for (const f of mesh.faces) {
    const id = f.entityId ?? f.source ?? null;
    if (id === null || !f.count) continue;
    const rs = ranges.get(id);
    if (rs) rs.push(f);
    else ranges.set(id, [f]);
  }
  const shells: number[][] = [];
  for (let s = 0; s < d.shell.kind.length; s++) {
    if (d.shell.kind[s] !== CLOSED) continue;
    const ids: number[] = [];
    let complete = true;
    for (let i = 0; i < d.shell.count[s]! && complete; i++) {
      const id = d.face.id[d.faceUse.face[d.shell.first[s]! + i]!]!;
      if (!id) continue;
      if (!ranges.has(id)) complete = false;
      else if (!ids.includes(id)) ids.push(id);
    }
    if (complete && ids.length) shells.push(ids);
  }
  if (!shells.length) return out;
  const { remap, positions } = weld(mesh.positions);
  const nv = positions.length / 3;
  const blamed = { open: new Map<number, number>(), edges: new Map<number, number>(),
    vertices: new Map<number, number>() };
  const blame = (kind: keyof typeof blamed, face: number) => blamed[kind].set(face, (blamed[kind].get(face) ?? 0) + 1);
  for (const ids of shells) {
    out.shells++;
    // The shell's triangles (welded corners, degenerate ones left out) and each one's face.
    const tri: number[] = [], faceOf: number[] = [];
    for (const id of ids) {
      const seen = (uses.get(id) ?? 1) > 1 ? new Set<string>() : undefined;
      for (const f of ranges.get(id)!)
        for (let t = f.start; t + 2 < f.start + f.count; t += 3) {
          const a = remap[mesh.indices[t]!]!, b = remap[mesh.indices[t + 1]!]!, c = remap[mesh.indices[t + 2]!]!;
          if (a === b || b === c || a === c) continue;
          if (seen) {
            // (One key per triangle and winding: from its least corner.)
            const key = a < b && a < c ? `${a},${b},${c}` : b < c ? `${b},${c},${a}` : `${c},${a},${b}`;
            if (seen.has(key)) continue;
            seen.add(key);
          }
          tri.push(a, b, c);
          faceOf.push(id);
        }
    }
    const n = tri.length;
    // Edges: each use as (lower x nv + higher) x 2 + direction, sorted so an edge's uses are adjacent (exact in a
    // double for fewer than 6.7e7 vertices), with the use's triangle beside it.
    const keys = new Float64Array(n), order = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      const a = tri[k]!, b = tri[k - (k % 3) + ((k % 3) + 1) % 3]!;
      keys[k] = a < b ? (a * nv + b) * 2 : (b * nv + a) * 2 + 1;
      order[k] = k;
    }
    order.sort((x, y) => keys[x]! - keys[y]!);
    for (let i = 0; i < n;) {
      const edge = Math.floor(keys[order[i]!]! / 2);
      let forward = 0, back = 0, j = i;
      for (; j < n && Math.floor(keys[order[j]!]! / 2) === edge; j++) if (keys[order[j]!]! % 2) back++; else forward++;
      const bad = forward + back === 1 ? 'open' : forward + back > 2 ? 'nonManifold' : forward !== 1 ? 'misoriented'
        : '';
      if (bad) {
        out[bad]++;
        for (let k = i; k < j; k++) blame(bad === 'open' ? 'open' : 'edges', faceOf[Math.floor(order[k]! / 3)]!);
      }
      i = j;
    }
    // Vertices: each one's triangles' far edges (from the corner after it to the one before) chained must close one
    // cycle through them all (two triangles leaving from one corner leave the chain short of them, so it can't).
    const corner = new Uint32Array(n);
    for (let k = 0; k < n; k++) corner[k] = k;
    corner.sort((x, y) => tri[x]! - tri[y]! || x - y);
    for (let i = 0; i < n;) {
      const v = tri[corner[i]!]!;
      let j = i;
      while (j < n && tri[corner[j]!] === v) j++;
      const next = new Map<number, number>();
      for (let k = i; k < j; k++) {
        const c = corner[k]!, t = c - (c % 3);
        next.set(tri[t + ((c % 3) + 1) % 3]!, tri[t + ((c % 3) + 2) % 3]!);
      }
      const first = tri[corner[i]! - (corner[i]! % 3) + ((corner[i]! % 3) + 1) % 3]!;
      let w = first, steps = 0;
      do { w = next.get(w)!; steps++; } while (w !== undefined && w !== first && steps <= j - i);
      if (w !== first || steps !== j - i) {
        out.vertices++;
        for (let k = i; k < j; k++) blame('vertices', faceOf[Math.floor(corner[k]! / 3)]!);
      }
      i = j;
    }
  }
  out.facesBy = { open: ranked(blamed.open), edges: ranked(blamed.edges), vertices: ranked(blamed.vertices) };
  out.faces = sum(out.facesBy.open, out.facesBy.edges, out.facesBy.vertices);
  return out;
}

/** Whether nothing keeps the mesh from being a closed, oriented manifold over its closed shells. */
export const shellsManifold = (x: ShellDefects) => !x.open && !x.misoriented && !x.nonManifold && !x.vertices;

/**
 * The defects to report, given whether the part's open edges are reported already (openEdgesMessage's error): edges
 * used twice the same way or more than twice always; edges used once only where the open edges aren't (the same gap
 * said once); vertices only where no edge is wrong (a vertex on a wrong edge, an open one's above all, isn't a fan
 * closed round it either: only a vertex two closed fans touch at is told by its vertices alone).
 */
export function reported(x: ShellDefects, openReported: boolean): ShellDefects {
  const open = openReported ? 0 : x.open;
  const vertices = x.open || x.misoriented || x.nonManifold ? 0 : x.vertices;
  const faces = sum(open ? x.facesBy.open : [], x.facesBy.edges, vertices ? x.facesBy.vertices : []);
  return { ...x, open, vertices, faces };
}

/** The error for a mesh that isn't a closed, oriented manifold over its closed shells (every backend's wording). */
export function notManifoldMessage(x: ShellDefects): string {
  const edges = x.open + x.misoriented + x.nonManifold;
  const kinds = [[x.open, 'used once'], [x.misoriented, 'used twice the same way'], [x.nonManifold,
    'used more than twice']].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  const what = [edges ? `${edges} mesh ${edges === 1 ? 'edge' : 'edges'} (${kinds.join(', ')})` : '',
    x.vertices ? `${x.vertices} ${x.vertices === 1 ? 'vertex' : 'vertices'} whose triangles aren't one fan` : '']
    .filter((s) => s).join(' and ');
  const ids = x.faces.slice(0, 10).map(([f]) => `#${f}`).join(', ') + (x.faces.length > 10 ? ', ...' : '');
  return `not a closed, oriented manifold over its closed shells: ${what}; faces ${ids}`;
}

/** The mesh edges and vertices an error diagnostic of notManifoldMessage's counts, summed (0 if none). */
export function notManifoldCount(diagnostics: readonly Diagnostic[]): number {
  let n = 0;
  for (const d of diagnostics) {
    if (d.severity !== 'error' || !d.message.startsWith('not a closed, oriented manifold over its closed shells: '))
      continue;
    const e = /: (\d+) mesh edges? /.exec(d.message), v = /(\d+) vert(?:ex|ices) whose/.exec(d.message);
    n += Number(e?.[1] ?? 0) + Number(v?.[1] ?? 0);
  }
  return n;
}

/**
 * The error diagnostic for a mesh that isn't a closed, oriented manifold over its closed shells, or none: of the
 * defects `reported` keeps, `openReported` whether the part's open edges are told already.
 */
export function notManifoldDiagnostic(d: BrepData, mesh: Parameters<typeof shellDefects>[1], openReported = false):
  Diagnostic | undefined {
  const x = reported(shellDefects(d, mesh), openReported);
  return shellsManifold(x) ? undefined : { severity: 'error', message: notManifoldMessage(x) };
}
