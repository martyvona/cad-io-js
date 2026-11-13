// The canonical model's topology (docs/brep-reference.md, "The canonical model", rules 1-5 and 7-11): what
// BrepBuilder.finish writes in place of the forms a source may use. Loops run as listed (a loop's sense and a face's
// reversed uses baked in, a face used both ways copied), poly loops as edge loops of shared line edges, degenerate
// edges out of loops, the outer loop first, shells by topology, a sheet of one closed shell a solid. Exact: no
// tolerances, no evaluation. Works on the builder's row objects (types.ts); face, edge and body rows keep their
// indices (new edges and face copies after them), shells are made anew.

import type { Body, BodyKind, Bound, Coedge, Curve, Edge, Face, Loop, Orientation, Point, Shell, ShellKind, Surface }
  from './types.ts';

export interface CanonicalCoedge extends Omit<Coedge, 'orientation'> {
  orientation: Orientation;
}
export type CanonicalLoop = { bound: Bound; id?: number } & (
  | { kind: 'edge'; coedges: CanonicalCoedge[] }
  | { kind: 'vertex'; vertex: number });
export interface CanonicalFace extends Omit<Face, 'loops'> {
  loops: CanonicalLoop[];
}
export interface CanonicalShell {
  kind: 'closed' | 'open';
  /** The source's kind (of the first shell its faces came from). */
  declared: ShellKind;
  faces: number[];
  id?: number;
}
export interface CanonicalBody {
  kind: BodyKind;
  declared: BodyKind;
  /** Shell rows of the canonical shells (solids, sheets), or edge rows (wires). */
  members: number[];
  id?: number;
}

export interface Canonical {
  edges: Edge[];
  faces: CanonicalFace[];
  shells: CanonicalShell[];
  bodies: CanonicalBody[];
}

export interface CanonicalInput {
  edges: readonly Edge[];
  faces: readonly Face[];
  shells: readonly Shell[];
  bodies: readonly Body[];
  /** Faces drawn as items (used forward). */
  itemFaces: readonly number[];
  vertexPoint: (v: number) => Point;
  /** A line curve from a to b (parameter 0 at a, 1 at b), its row. */
  addLine: (a: Point, b: Point) => number;
  /** A fresh id for a copy of the row with source id `id` (the copy table told), or undefined. */
  fresh: (id: number | undefined) => number | undefined;
  /** Curve and surface rows as given. */
  curve: (k: number) => Curve;
  surface: (k: number) => Surface;
  /** A curve's range as its evaluator has it (a trimmed curve's from its trims), or undefined. */
  curveRange: (k: number) => [number, number] | undefined;
  /**
   * An edge without vertices: its points at its start and its end (its 3D curve over its range, else its use's
   * p-curve on the face's surface), or undefined where they don't evaluate.
   */
  ends: (e: Edge, pcurve: number | undefined, surface: number) => [Point, Point] | undefined;
  /** A vertex at a point, its row. */
  addVertex: (point: Point, tolerance: number | undefined) => number;
  /** How far apart a curve-bounded face's segments' ends may be and be joined: the part's uncertainty. */
  joinTolerance: number;
  /** A problem with the source, said (with the face's id). */
  note: (message: string) => void;
}

const turn = (o: Orientation): Orientation => o === 'forward' ? 'reversed' : o === 'reversed' ? 'forward' : o;

export function canonical(x: CanonicalInput): Canonical {
  // Rule 10: a curve-bounded face's segments (edges without vertices) share a vertex at each join where their ends
  // meet within the tolerance, at the point between them, its tolerance the gap; a face with a join farther apart
  // left as it is, said. Its loops all inner (the surface's extent its outer bound, STEP's implicit_outer) left too:
  // a face of edges with vertices can't say so.
  const joined = [...x.edges];
  for (const f of x.faces) {
    const bare = (c: Coedge) => joined[c.edge]!.start === undefined && joined[c.edge]!.end === undefined;
    if (!f.loops.length || !f.loops.every((l) => l.kind === 'edge' && l.coedges.length && l.coedges.every(bare))) {
      continue;
    }
    if (f.loops.every((l) => l.bound === 'inner')) continue;
    // (Each loop: 'ends' where a segment's ends don't evaluate, 'apart' where a join is wider than the tolerance.)
    const why = f.loops.map((l) => {
      if (l.kind !== 'edge') return 'ends';
      const seg = l.coedges.map((c): [Point, Point] | undefined => {
        const ends = x.ends(joined[c.edge]!, c.pcurve, f.surface);
        return ends && (c.orientation === 'reversed' ? [ends[1], ends[0]] : ends);
      });
      if (seg.some((q) => !q) || new Set(l.coedges.map((c) => c.edge)).size < l.coedges.length) return 'ends';
      const n = seg.length;
      const gaps = seg.map((q, i) => Math.hypot(...q![1].map((v, j) => v - seg[(i + 1) % n]![0][j]!)));
      return gaps.every((g) => g <= x.joinTolerance) ? '' : 'apart';
    });
    if (why.some(Boolean)) {
      const id = f.id ? ` (#${f.id})` : '';
      x.note(why.includes('apart')
        ? `a curve-bounded face whose boundary's segments don't meet within the uncertainty (left as segments)${id}`
        : `a curve-bounded face with a segment of no ends of its own (an unbounded curve, untrimmed: left as `
          + `segments)${id}`);
      continue;
    }
    for (const l of f.loops) {
      if (l.kind !== 'edge') continue;
      const seg = l.coedges.map((c): [Point, Point] => {
        const ends = x.ends(joined[c.edge]!, c.pcurve, f.surface)!;
        return c.orientation === 'reversed' ? [ends[1], ends[0]] : ends;
      });
      const n = seg.length;
      // Vertex i: where segment i ends and segment i + 1 starts.
      const v = seg.map((q, i) => {
        const a = q[1], b = seg[(i + 1) % n]![0], g = Math.hypot(...a.map((t, j) => t - b[j]!));
        return x.addVertex(a.map((t, j) => (t + b[j]!) / 2), g > 0 ? g : undefined);
      });
      l.coedges.forEach((c, i) => {
        const before = v[(i + n - 1) % n]!, after = v[i]!;
        const [start, end] = c.orientation === 'reversed' ? [after, before] : [before, after];
        joined[c.edge] = { ...joined[c.edge]!, start, end };
      });
    }
  }
  // Rule 4: an edge with both vertices on a trimmed curve is on its basis (the vertices bound it; the trim's
  // parameters are the basis's, so ranges and p-curves stand), its sense turned where the trim runs against the basis;
  // without a range, the trim's as its range.
  const edges = joined.map((e) => {
    if (e.curve === undefined || e.start === undefined || e.end === undefined) return e;
    let curve = e.curve, sameSense = e.sameSense, c = x.curve(curve);
    const trimmed = c.kind === 'trimmed' ? x.curveRange(curve) : undefined;
    while (c.kind === 'trimmed') {
      curve = c.basis;
      if (!c.sense) sameSense = !sameSense;
      c = x.curve(curve);
    }
    if (curve === e.curve) return e;
    const range = e.range ?? (trimmed && trimmed.every(Number.isFinite)
      ? (sameSense ? trimmed : [trimmed[1], trimmed[0]] as [number, number]) : undefined);
    return { ...e, curve, sameSense, ...(range ? { range } : {}) };
  });
  // Rule 3: a poly loop's sides as line edges, one per pair of corner rows, shared by every loop that has it.
  const sides = new Map<string, number>();
  const side = (a: number, b: number): CanonicalCoedge => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let e = sides.get(key);
    if (e === undefined) {
      const [s, t] = a < b ? [a, b] : [b, a];
      e = edges.length;
      edges.push({ curve: x.addLine(x.vertexPoint(s), x.vertexPoint(t)), start: s, end: t, sameSense: true });
      sides.set(key, e);
    }
    return { edge: e, orientation: a < b ? 'forward' : 'reversed' };
  };

  // Rule 2: each face's uses, forward or reversed (a use's sense against its shell's in its body); items forward.
  const uses = x.faces.map(() => ({ forward: false, reversed: false }));
  for (const f of x.itemFaces) uses[f]!.forward = true;
  for (const b of x.bodies) {
    if (b.kind === 'wire') continue;
    for (const m of b.members) {
      for (const u of x.shells[m.ref]!.faces) {
        if ((u.sense === false) === (m.sense === false)) uses[u.face]!.forward = true;
        else uses[u.face]!.reversed = true;
      }
    }
  }

  // Rules 1, 3, 7, 9: a face's loops run as listed, turned over with the face where `turned`.
  const loopsOf = (f: Face, turned: boolean, freshIds: boolean): CanonicalLoop[] => {
    const id = (i: number | undefined) => freshIds ? x.fresh(i) : i;
    const out = f.loops.map((l: Loop): CanonicalLoop => {
      const lid = id(l.id), base = { bound: l.bound, ...(lid === undefined ? {} : { id: lid }) };
      if (l.kind === 'vertex') return { kind: 'vertex', vertex: l.vertex, ...base };
      let coedges: CanonicalCoedge[] = l.kind === 'poly'
        ? l.vertices.map((v, i) => side(v, l.vertices[(i + 1) % l.vertices.length]!))
        : l.coedges.map((c) => {
          const cid = id(c.id);
          const { id: _, ...rest } = c;
          return { ...rest, ...(cid === undefined ? {} : { id: cid }) };
        });
      // Rule 7: an edge of no length out of its loop; a loop of nothing else a vertex loop at its point.
      const degenerate = coedges.filter((c) => edges[c.edge]!.degenerate);
      coedges = coedges.filter((c) => !edges[c.edge]!.degenerate);
      if (!coedges.length && degenerate.length) {
        const e = edges[degenerate[0]!.edge]!;
        if (e.start !== undefined) return { kind: 'vertex', vertex: e.start, ...base };
      }
      if ((l.sense === false) !== turned) {
        coedges = coedges.reverse().map((c) => ({ ...c, orientation: turn(c.orientation) }));
      }
      return { kind: 'edge', coedges, ...base };
    });
    // Rule 9: the one outer loop first.
    const outer = out.filter((l) => l.bound === 'outer');
    return outer.length === 1 ? [outer[0]!, ...out.filter((l) => l !== outer[0])] : out;
  };
  const faces: CanonicalFace[] = [];
  const reversedRow: number[] = [];
  // Rule 5: a face with loops on a rectangular trim is on its basis (its loops bound it; the trim's parameters are
  // the basis's). A trim reversing a direction kept: none seen, so nothing to check its reading against.
  const basisOf = (f: Face): number => {
    let k = f.surface, s = x.surface(k);
    while (f.loops.length && s.kind === 'rectangularTrimmed' && s.uSense && s.vSense) {
      k = s.basis;
      s = x.surface(k);
    }
    return k;
  };
  x.faces.forEach((f, k) => {
    const u = uses[k]!, turned = u.reversed && !u.forward;
    faces.push({ ...f, surface: basisOf(f), sameSense: turned ? !f.sameSense : f.sameSense,
      loops: loopsOf(f, turned, false) });
    reversedRow[k] = k;
  });
  x.faces.forEach((f, k) => {
    const u = uses[k]!;
    if (!(u.forward && u.reversed)) return;
    const id = x.fresh(f.id);
    const { id: _, ...rest } = f;
    reversedRow[k] = faces.length;
    faces.push({ ...rest, surface: basisOf(f), sameSense: !f.sameSense, loops: loopsOf(f, true, true),
      ...(id === undefined ? {} : { id }) });
  });
  const faceFor = (face: number, forward: boolean) => forward ? face : reversedRow[face]!;

  // Rule 8: shells by topology, per body. A body's shells the source calls closed each split into their connected
  // pieces; its others' faces together, split likewise (open shells sharing edges merged).
  const shells: CanonicalShell[] = [];
  const edgesOf = (f: number) => faces[f]!.loops.flatMap((l) => l.kind === 'edge' ? l.coedges.map((c) => c.edge)
    : []);
  const pieces = (fs: { face: number; declared: ShellKind; id?: number }[]) => {
    const parent = fs.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
    const byEdge = new Map<number, number>();
    fs.forEach((u, i) => {
      for (const e of edgesOf(u.face)) {
        const j = byEdge.get(e);
        if (j === undefined) byEdge.set(e, i);
        else parent[find(i)] = find(j);
      }
    });
    const groups = new Map<number, typeof fs>();
    fs.forEach((u, i) => {
      const r = find(i), g = groups.get(r);
      if (g) g.push(u);
      else groups.set(r, [u]);
    });
    return [...groups.values()];
  };
  const shellOf = (g: { face: number; declared: ShellKind; id?: number }[], first: boolean): number => {
    // Closed: every edge its faces bound with used exactly twice, once each way (internal and external uses bound
    // nothing). A shell whose faces use no edges keeps the source's claim.
    const count = new Map<number, [number, number]>();
    for (const u of g) {
      for (const l of faces[u.face]!.loops) {
        if (l.kind !== 'edge') continue;
        for (const c of l.coedges) {
          if (c.orientation !== 'forward' && c.orientation !== 'reversed') continue;
          const n = count.get(c.edge) ?? [0, 0];
          n[c.orientation === 'forward' ? 0 : 1]++;
          count.set(c.edge, n);
        }
      }
    }
    const closed = count.size ? [...count.values()].every(([a, b]) => a === 1 && b === 1)
      : g[0]!.declared === 'closed';
    const id = first ? g[0]!.id : undefined;
    shells.push({ kind: closed ? 'closed' : 'open', declared: g[0]!.declared, faces: g.map((u) => u.face),
      ...(id === undefined ? {} : { id }) });
    return shells.length - 1;
  };
  const bodies: CanonicalBody[] = x.bodies.map((b) => {
    const base = b.id === undefined ? {} : { id: b.id };
    if (b.kind === 'wire') {
      return { kind: 'wire', declared: b.declared ?? 'wire', members: b.members.map((m) => m.ref), ...base };
    }
    const uses = (m: Body['members'][number]) => {
      const s = x.shells[m.ref]!;
      return s.faces.map((u) => ({ face: faceFor(u.face, (u.sense === false) === (m.sense === false)),
        declared: s.declared ?? s.kind, ...(s.id === undefined ? {} : { id: s.id }) }));
    };
    const members: number[] = [];
    const rest: ReturnType<typeof uses> = [];
    for (const m of b.members) {
      const s = x.shells[m.ref]!;
      if (s.kind === 'closed') pieces(uses(m)).forEach((g, i) => members.push(shellOf(g, i === 0)));
      else rest.push(...uses(m));
    }
    const seen = new Set<number | undefined>();
    for (const g of pieces(rest)) {
      // (A merged piece keeps its first source shell's id, once.)
      const first = !seen.has(g[0]!.id);
      seen.add(g[0]!.id);
      members.push(shellOf(g, first));
    }
    // Rule 11: a sheet of one shell, closed, is a solid.
    const kind: BodyKind = b.kind === 'sheet' && members.length === 1 && shells[members[0]!]!.kind === 'closed'
      ? 'solid' : b.kind;
    return { kind, declared: b.declared ?? b.kind, members, ...base };
  });
  return { edges: edges.map(({ degenerate: _, ...e }) => e), faces, shells, bodies };
}
