// vertexSplit: one vertex standing for two or more points. Its uses' joints (two consecutive coedges of a loop meeting
// there) each agree (the two curves' ends there within AGREE x the tolerance), yet they fall in groups that never meet:
// the uses meet at more than one point, and each group's curves end at its own. trj3_s1-al #6704's v574: the edge
// #768 runs from it and back to it (a closed edge) on a 1 mm line, and the joints at its far end (#769's start, #801's
// end) agree with it there, 1.0 mm from the vertex's point, at the file's uncertainty of 1.0 mm, and meshers bridging
// the gap put that corner of faces #1350 and #1370 at the vertex, cutting the faces short. Each group
// but the one nearest the vertex's point gets a vertex of its own, at its curves' ends' mean: the groups farther apart
// than APART x the tolerance (groups nearer each other are at one point: an unsewn sheet's faces meet at a vertex in
// groups of their own).
//
// Runs before the curves' fixes, on the source's tolerances, before vertexTolerance grows them to cover the gap.
// Vertex rows are added; the result carries each row's given row, as coincidentEdges' does.

import { type BrepData, LOOP_KIND, ORIENTATION, rowCount } from 'cad-brep';
import { Geometry, type GeomModule } from 'cad-geom';
import { edgeRange, tolerances } from '../measure.ts';
import { PART, Topo } from './coincident.ts';
import type { RowsFrom } from './touch.ts';

/** Two curves' ends at a joint agree within this fraction of the tolerance. */
export const AGREE = PART;
/** A vertex is split only where its groups' points are farther apart than this fraction of the tolerance. */
export const APART = PART;

/** One vertex split, as said in the diagnostic (ids). */
export interface Split {
  vertex: number;
  /** The new vertices' count, the largest distance (mm) of one from the vertex, the tolerance. */
  added: number;
  distance: number;
  tolerance: number;
  /** The edges whose ends moved to a new vertex. */
  edges: number[];
}

export type SplitResult = RowsFrom & { split: Split[] };

type Vec = [number, number, number];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** vertexSplit on a model: every vertex whose uses meet at points apart split, or undefined where there's none. */
export function splitVertices(module: GeomModule, d: BrepData): SplitResult | undefined {
  const tol = tolerances(d), ne = rowCount(d, 'edge');
  // Each edge's curve's ends (its range's: the model's, else as the face API derives it), NaN where unknown.
  const ends = new Float64Array(6 * ne).fill(NaN);
  const g = new Geometry(module, new Uint8Array(d.buffer));
  // Joints by vertex: an edge's end as a node, 2e at its start, 2e + 1 at its end.
  const joints = new Map<number, [number, number][]>();
  const bad = new Set<number>();
  try {
    for (let l = 0; l < rowCount(d, 'loop'); l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      const f0 = d.loop.first[l]!, n = d.loop.count[l]!;
      for (let i = 0; i < n; i++) {
        const a = f0 + i, b = f0 + (i + 1) % n, ea = d.coedge.edge[a]!, eb = d.coedge.edge[b]!;
        const ra = d.coedge.orientation[a] === ORIENTATION.reversed;
        const rb = d.coedge.orientation[b] === ORIENTATION.reversed;
        const na = 2 * ea + (ra ? 0 : 1), nb = 2 * eb + (rb ? 1 : 0);
        const v = na & 1 ? d.edge.end[ea]! : d.edge.start[ea]!, w = nb & 1 ? d.edge.end[eb]! : d.edge.start[eb]!;
        // (A joint between two vertices: the loop doesn't close in topology, and neither vertex is split.)
        if (v !== w) {
          bad.add(v), bad.add(w);
          continue;
        }
        if (v < 0) continue;
        (joints.get(v) ?? joints.set(v, []).get(v)!).push([na, nb]);
      }
    }
    const need = new Set<number>();
    for (const [v, js] of joints) {
      if (bad.has(v)) continue;
      for (const [a, b] of js) need.add(a >> 1), need.add(b >> 1);
    }
    for (const e of need) {
      if (d.edge.curve[e]! < 0) continue;
      const r = edgeRange(g, e);
      if (!r) continue;
      const C = g.evalCurve(d.edge.curve[e]!, r, 0);
      if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) continue;
      for (let k = 0; k < 6; k++) ends[6 * e + k] = C.values[k]!;
    }
  } finally {
    g.dispose();
  }
  const at = (n: number): Vec => [ends[3 * n]!, ends[3 * n + 1]!, ends[3 * n + 2]!];
  const t = new Topo(d), split: Split[] = [];
  for (const [v, js] of joints) {
    if (bad.has(v)) continue;
    const nodes = new Set<number>();
    let tv = tol.vertex(v);
    for (const [a, b] of js) nodes.add(a), nodes.add(b), tv = Math.max(tv, tol.edge(a >> 1), tol.edge(b >> 1));
    if ([...nodes].some((n) => !Number.isFinite(ends[3 * n]!))) continue;
    // Every joint agrees, or the vertex is left (its uses don't tell where they meet).
    if (js.some(([a, b]) => !(dist(at(a), at(b)) <= AGREE * tv))) continue;
    const parent = new Map<number, number>([...nodes].map((n) => [n, n]));
    const root = (n: number): number => {
      while (parent.get(n) !== n) n = parent.get(n)!;
      return n;
    };
    for (const [a, b] of js) parent.set(root(a), root(b));
    const groups = new Map<number, number[]>();
    for (const n of nodes) (groups.get(root(n)) ?? groups.set(root(n), []).get(root(n))!).push(n);
    // Groups within APART x the tolerance of each other are at one point (an unsewn face's corner beside a sewn one's).
    const mean = (ns: number[]) => [0, 1, 2].map((k) => ns.reduce((s, n) => s + at(n)[k]!, 0) / ns.length) as Vec;
    const gp = [...groups.values()].map((ns) => ({ ns, p: mean(ns) }));
    const joint = gp.map((_, i) => i), top = (i: number): number => joint[i] === i ? i : top(joint[i]!);
    for (let i = 0; i < gp.length; i++) for (let j = i + 1; j < gp.length; j++) {
      if (!(dist(gp[i]!.p, gp[j]!.p) > APART * tv)) joint[top(i)] = top(j);
    }
    const points = new Map<number, number[]>();
    gp.forEach((x, i) => (points.get(top(i)) ?? points.set(top(i), []).get(top(i))!).push(...x.ns));
    if (points.size < 2) continue;
    const gs = [...points.values()].map((ns) => ({ ns, p: mean(ns) }));
    // The group nearest the vertex's point keeps it; each other one gets its own at its ends' mean.
    const V: Vec = [d.vertex.point[3 * v]!, d.vertex.point[3 * v + 1]!, d.vertex.point[3 * v + 2]!];
    gs.sort((x, y) => dist(x.p, V) - dist(y.p, V));
    const edges = new Set<number>();
    let far = 0;
    for (const x of gs.slice(1)) {
      const nv = t.v.length;
      t.v.push({ point: x.p, tol: NaN, id: 0, from: -1 });
      far = Math.max(far, dist(x.p, V));
      for (const n of x.ns) {
        const E = t.e[n >> 1]!;
        if (n & 1) E.end = nv;
        else E.start = nv;
        edges.add(d.edge.id[n >> 1]!);
      }
    }
    split.push({ vertex: d.vertex.id[v]!, added: gs.length - 1, distance: far, tolerance: tv, edges: [...edges] });
  }
  if (!split.length) return undefined;
  const w = t.write();
  return { model: w.model, vertexFrom: w.vertexFrom, edgeFrom: w.edgeFrom, coedgeFrom: w.coedgeFrom,
    faceFrom: w.faceFrom, split };
}
