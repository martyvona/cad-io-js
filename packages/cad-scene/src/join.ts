// The exact join: a backend's result made to share its points along the model edges where its faces' meshes don't
// meet (openEdges), where each face reaches the whole edge and only the points differ. Each face's own boundary along
// the edge is found from its triangles (mesh edges one of its triangles has, near the edge's polyline); the points of
// all of them, in order along the edge, are the joined edge's: points closer than the snap distance one (moved to one
// of them, everywhere it is), and each face's boundary segments split at the points it lacks, the triangle on each
// into a fan from its third corner. A split that would turn a triangle over leaves the edge as it was. Edges where a
// face's boundary stops short of the edge, leaves it, or puts a corner elsewhere aren't joined: no splitting can close
// them. The edge's polylines become one, the joined points.

import type { BrepData } from 'cad-brep';
import { edgeUsers, openEdges, openEdgesCount, openEdgesMessage } from './open-edges.ts';
import type { Diagnostic } from './scene.ts';
import type { TessellationResult } from './tessellator.ts';

/** Points closer than this fraction of the linear deflection are one point of the joined edge. */
export const JOIN_SNAP = 0.01;

export interface Joined {
  /** The result, joined (`r` itself where nothing was). */
  result: TessellationResult;
  /** The edges joined, by id: each was open and isn't. */
  joined: number[];
  /** The edges still open, by id (openEdges on the joined result). */
  open: number[];
  /** Why each open edge wasn't joined, by id. */
  skipped: Map<number, string>;
  /** For edges not joined for one face's boundary (its corner off the edge's end, or leaving the edge): that face. */
  culprits: Map<number, number>;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The parameter (arc length from the start) of q's nearest point on polyline P, and its distance from it. */
function project(P: readonly V3[], cum: readonly number[], q: V3): { t: number; d: number } {
  if (P.length === 1) return { t: 0, d: dist(P[0]!, q) };
  let best = { t: 0, d: Infinity };
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i]!, ab = sub(P[i + 1]!, a), l2 = dot(ab, ab);
    const s = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2)) : 0;
    const d = dist(q, [a[0] + s * ab[0], a[1] + s * ab[1], a[2] + s * ab[2]]);
    if (d < best.d) best = { t: cum[i]! + s * Math.sqrt(l2), d };
  }
  return best;
}

/**
 * Joins the result's open edges (openEdges) where a split can close them. `deflection` the request's linear
 * deflection: a face's boundary within it of an edge's polyline is along the edge, and points within JOIN_SNAP of it
 * are one. A result without edge polylines, or without open edges, comes back as it is.
 */
export function joinEdges(d: BrepData, r: TessellationResult, deflection: number): Joined {
  const skipped = new Map<number, string>(), culprits = new Map<number, number>();
  if (!r.edges || !r.edgePositions) return { result: r, joined: [], open: [], skipped, culprits };
  const open = openEdges(d, r).open.sort((a, b) => a - b);
  if (!open.length) return { result: r, joined: [], open: [], skipped, culprits };
  const users = edgeUsers(d);
  const tol = deflection, snap = JOIN_SNAP * deflection;
  // Mutable copies: positions (grown as points are added), normals, each face's triangles (its ranges as one).
  let positions = Float32Array.from(r.positions);
  let normals = r.normals ? Float32Array.from(r.normals) : undefined;
  let used = positions.length / 3;
  const grow = (n: number) => {
    if (3 * (used + n) <= positions.length) return;
    const size = Math.max(3 * (used + n), 2 * positions.length);
    const p = new Float32Array(size); p.set(positions.subarray(0, 3 * used)); positions = p;
    if (normals) { const q = new Float32Array(size); q.set(normals.subarray(0, 3 * used)); normals = q; }
  };
  const at = (i: number): V3 => [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
  const key = (i: number) => `${positions[3 * i]! + 0},${positions[3 * i + 1]! + 0},${positions[3 * i + 2]! + 0}`;
  const tris = new Map<number, number[]>();
  for (const f of r.faces) {
    if (f.entityId === null) continue;
    const t = tris.get(f.entityId) ?? tris.set(f.entityId, []).get(f.entityId)!;
    for (let k = f.start; k < f.start + f.count; k++) t.push(r.indices[k]!);
  }
  // Every vertex by its position, for moving a point everywhere it is (made when first needed).
  let byKey: Map<string, number[]> | undefined;
  const vertices = () => {
    if (!byKey) {
      byKey = new Map();
      for (let i = 0; i < used; i++) { const k = key(i); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(i); }
    }
    return byKey;
  };
  let edges = r.edges.map((e) => ({ ...e })), edgePoints: number[][] = r.edges.map((e) =>
    Array.from(r.edgePositions!.subarray(3 * e.start, 3 * (e.start + e.count))));
  const joined: number[] = [];

  for (const id of open) {
    const faces = users.get(id);
    if (!faces || faces.length < 2 || faces.some((f) => !tris.get(f)?.length)) { skipped.set(id, 'faces'); continue; }
    // The edge's polylines chained into one, end to end within the deflection (reversed as needed); unchainable
    // ones aren't joined.
    // (Its polylines with points: a backend gives one of none for an edge it couldn't draw.)
    const mine = edges.flatMap((e, k) => (e.entityId === id && e.count > 0 ? [k] : []));
    if (!mine.length) { skipped.set(id, 'no polyline'); continue; }
    const pts = (k: number): V3[] => { const a = edgePoints[k]!, out: V3[] = [];
      for (let i = 0; i + 2 < a.length; i += 3) out.push([a[i]!, a[i + 1]!, a[i + 2]!]); return out; };
    let P = pts(mine[0]!);
    const rest = mine.slice(1).map(pts);
    while (rest.length) {
      const end = P[P.length - 1]!, start = P[0]!;
      // (The nearest of the four ways a piece can meet the chain.)
      let best: { k: number; way: number; d: number } | undefined;
      rest.forEach((q, k) => [dist(q[0]!, end), dist(q[q.length - 1]!, end), dist(q[q.length - 1]!, start),
        dist(q[0]!, start)].forEach((dq, way) => { if (!best || dq < best.d) best = { k, way, d: dq }; }));
      if (!best || best.d > tol) break;
      const q = rest.splice(best.k, 1)[0]!;
      if (best.way === 0) P = [...P, ...q.slice(1)];
      else if (best.way === 1) P = [...P, ...q.reverse().slice(1)];
      else if (best.way === 2) P = [...q.slice(0, -1), ...P];
      else P = [...q.reverse().slice(0, -1), ...P];
    }
    if (rest.length || P.length < 2) { skipped.set(id, 'polylines don\'t chain'); continue; }
    const cum = [0];
    for (let i = 0; i + 1 < P.length; i++) cum.push(cum[i]! + dist(P[i]!, P[i + 1]!));
    const L = cum[cum.length - 1]!;
    if (!(L > snap)) { skipped.set(id, 'too short'); continue; }
    // Each face's boundary along the edge: a simple path from the edge's start to its end.
    interface Seg { a: number; b: number; ta: number; tb: number }
    const paths: { face: number; segs: Seg[] }[] = [];
    let ok = true;
    for (const f of faces) {
      const t = tris.get(f)!;
      const count = new Map<string, { n: number; a: number; b: number }>();
      for (let k = 0; k < t.length; k += 3) for (let j = 0; j < 3; j++) {
        const a = t[k + j]!, b = t[k + (j + 1) % 3]!, ka = key(a), kb = key(b);
        if (ka === kb) continue;
        const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const c = count.get(e);
        if (c) c.n++; else count.set(e, { n: 1, a, b });
      }
      // The face's boundary (mesh edges one of its triangles has) as a graph on positions: at each point its
      // neighbours, with the vertex indices at this end (a) and the other (b).
      const nbrs = new Map<string, { k: string; a: number; b: number }[]>();
      for (const { n, a, b } of count.values()) {
        if (n !== 1) continue;
        const ka = key(a), kb = key(b);
        (nbrs.get(ka) ?? nbrs.set(ka, []).get(ka)!).push({ k: kb, a, b });
        (nbrs.get(kb) ?? nbrs.set(kb, []).get(kb)!).push({ k: ka, a: b, b: a });
      }
      // Walked from its point nearest the edge's start to its point nearest the edge's end, each step to the
      // neighbour that goes on along the edge (within the deflection of it, advancing along it by 0.5 to 1.5 times
      // the step's length: not off along another edge at a corner, nor round a closed edge the wrong way) nearest it.
      // On a closed edge (its ends one point) a step onto the end point is the end, whatever its projection (the
      // start's).
      const nearest = (q: V3) => {
        let best: { k: string; i: number; d: number } | undefined;
        for (const [k, ns] of nbrs) {
          const i = ns[0]!.a, dq = dist(at(i), q);
          if (!best || dq < best.d) best = { k, i, d: dq };
        }
        return best;
      };
      const from = nearest(P[0]!), to = nearest(P[P.length - 1]!);
      const segs: Seg[] = [];
      let why = !from || !to || from.d > tol || to.d > tol ? 'a face\'s corner off the edge\'s end' : '';
      if (!why) {
        let cur = from!.k, t = 0;
        for (let steps = 0; steps <= nbrs.size && (cur !== to!.k || !segs.length); steps++) {
          let next: { k: string; a: number; b: number; t: number; d: number } | undefined;
          for (const n of nbrs.get(cur)!) {
            const pr = project(P, cum, at(n.b));
            const tn = n.k === to!.k && segs.length ? L : pr.t;
            const step = dist(at(n.a), at(n.b)), along = tn - t >= 0.5 * step && tn - t <= 1.5 * step + snap;
            if (pr.d <= tol && along && (!next || pr.d < next.d || (pr.d === next.d && tn < next.t))) {
              next = { ...n, t: tn, d: pr.d };
            }
          }
          if (!next) break;
          segs.push({ a: next.a, b: next.b, ta: t, tb: next.t });
          cur = next.k; t = next.t;
        }
        // (Its ends then within the deflection of the edge's: where they are with the other faces' is below.)
        why = cur !== to!.k || !segs.length ? 'a face\'s boundary leaves the edge' : '';
      }
      if (why) { skipped.set(id, why); culprits.set(id, f); ok = false; break; }
      paths.push({ face: f, segs });
    }
    if (!ok) continue;
    // The joined points: every face's, in order along the edge, those within the snap distance of a point one (it
    // standing for them: the first along the edge, then by the faces' order in the model).
    const all: { t: number; p: V3; face: number }[] = [];
    for (const { face, segs } of paths) {
      all.push({ t: segs[0]!.ta, p: at(segs[0]!.a), face });
      for (const s of segs) all.push({ t: s.tb, p: at(s.b), face });
    }
    all.sort((x, y) => x.t - y.t || faces.indexOf(x.face) - faces.indexOf(y.face));
    const clusters: { t: number; p: V3; members: V3[] }[] = [];
    for (const x of all) {
      const last = clusters[clusters.length - 1];
      if (last && dist(last.p, x.p) <= snap) last.members.push(x.p);
      else clusters.push({ t: x.t, p: x.p, members: [x.p] });
    }
    // Each face's points their clusters, in order along its path (on a closed edge, its first and last points are one
    // position in the first and the last cluster); its ends the first and last (its corners the same as the others').
    const has = (c: (typeof clusters)[number], p: V3) => c.members.some((m) => m[0] === p[0] && m[1] === p[1]
      && m[2] === p[2]);
    const placed = new Map<Seg, [number, number]>();
    let apart = false;
    for (const { segs } of paths) {
      let ci = has(clusters[0]!, at(segs[0]!.a)) ? 0 : -1;
      for (const sg of segs) {
        if (ci < 0) break;
        let cb = ci;
        while (cb < clusters.length && !has(clusters[cb]!, at(sg.b))) cb++;
        if (cb === clusters.length) { ci = -1; break; }
        placed.set(sg, [ci, cb]);
        ci = cb;
      }
      if (ci !== clusters.length - 1) { apart = true; break; }
    }
    if (apart) {
      skipped.set(id, 'the faces\' corners apart by more than the snap distance');
      continue;
    }
    // The plan: points moved onto their cluster's, and each face's segments split at the clusters between their ends.
    const moves = new Map<string, V3>();
    for (const c of clusters) for (const m of c.members) {
      if (m[0] !== c.p[0] || m[1] !== c.p[1] || m[2] !== c.p[2]) moves.set(`${m[0] + 0},${m[1] + 0},${m[2] + 0}`, c.p);
    }
    const moved = (i: number): V3 => moves.get(key(i)) ?? at(i);
    const plan: { face: number; tri: number; fan: (number | V3)[][] }[] = [];
    let flips = false;
    for (const { face, segs } of paths) {
      const t = tris.get(face)!;
      for (const s of segs) {
        const [ca, cb] = placed.get(s)!;
        if (cb - ca <= 1) continue;
        const inner = clusters.slice(ca + 1, cb).map((c) => c.p);
        // The triangle with this boundary segment, and its winding along it.
        let tri = -1, forward = true, c = -1;
        for (let k = 0; k < t.length && tri < 0; k += 3) for (let j = 0; j < 3; j++) {
          const x = t[k + j]!, y = t[k + (j + 1) % 3]!;
          if ((x === s.a && y === s.b) || (x === s.b && y === s.a)) {
            tri = k; forward = x === s.a; c = t[k + (j + 2) % 3]!; break;
          }
        }
        if (tri < 0) { flips = true; break; }
        const chain: (number | V3)[] = [s.a, ...inner, s.b];
        if (!forward) chain.reverse();
        const fan = chain.slice(0, -1).map((p, k) => [p, chain[k + 1]!, c]);
        // None turned over against the triangle it replaces (or made of no area).
        const pos = (p: number | V3) => (typeof p === 'number' ? moved(p) : p);
        const n0 = cross(sub(pos(t[tri + 1]!), pos(t[tri]!)), sub(pos(t[tri + 2]!), pos(t[tri]!)));
        for (const [p, q, o] of fan) {
          const n = cross(sub(pos(q!), pos(p!)), sub(pos(o!), pos(p!)));
          if (!(dot(n, n0) > 0)) flips = true;
        }
        plan.push({ face, tri, fan });
      }
      if (flips) break;
    }
    // (Two splits in one triangle, a corner on the edge twice: not joined.)
    if (new Set(plan.map((x) => `${x.face} ${x.tri}`)).size < plan.length) flips = true;
    if (flips) { skipped.set(id, 'a split would turn a triangle over'); continue; }
    // Applied: moves everywhere the point is, then the fans (each new point a new vertex at the cluster's point).
    if (moves.size) {
      const vs = vertices();
      for (const [k, p] of moves) for (const i of vs.get(k) ?? []) {
        positions.set(p, 3 * i);
        const nk = key(i);
        (vs.get(nk) ?? vs.set(nk, []).get(nk)!).push(i);
      }
      for (const k of moves.keys()) vs.delete(k);
    }
    // (Fans replace their triangles from the last in each face, so earlier offsets stay right.)
    plan.sort((x, y) => x.face - y.face || y.tri - x.tri);
    for (const { face, tri, fan } of plan) {
      const t = tris.get(face)!;
      const old = [t[tri]!, t[tri + 1]!, t[tri + 2]!];
      const flat: number[] = [];
      for (const corner of fan) for (const p of corner) {
        if (typeof p === 'number') { flat.push(p); continue; }
        grow(1);
        positions.set(p, 3 * used);
        // (A new point's normal: its segment's first end's.)
        if (normals) normals.set(normals.subarray(3 * old[0]!, 3 * old[0]! + 3), 3 * used);
        if (byKey) { const k = key(used); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(used); }
        flat.push(used++);
      }
      t.splice(tri, 3, ...flat);
    }
    // The edge's polylines one: the joined points.
    const first = mine[0]!;
    edgePoints[first] = clusters.flatMap((c) => c.p);
    edges[first] = { ...edges[first]!, count: clusters.length };
    const drop = new Set(mine.slice(1));
    edges = edges.filter((_, k) => !drop.has(k));
    edgePoints = edgePoints.filter((_, k) => !drop.has(k));
    joined.push(id);
  }
  if (!joined.length) return { result: r, joined, open, skipped, culprits };
  // Rebuilt: each face's triangles at its first range (its later ranges dropped), the edges' polylines in order.
  const indices: number[] = [], outFaces: TessellationResult['faces'] = [], seen = new Set<number>();
  for (const f of r.faces) {
    if (f.entityId !== null && seen.has(f.entityId)) continue;
    const t = f.entityId === null ? Array.from(r.indices.subarray(f.start, f.start + f.count)) : tris.get(f.entityId)!;
    if (f.entityId !== null) seen.add(f.entityId);
    outFaces.push({ ...f, start: indices.length, count: t.length });
    for (const i of t) indices.push(i);
  }
  const ep: number[] = [];
  edges = edges.map((e, k) => { const s = ep.length / 3; ep.push(...edgePoints[k]!); return { ...e, start: s }; });
  const result: TessellationResult = { ...r, positions: positions.slice(0, 3 * used),
    indices: Uint32Array.from(indices), faces: outFaces, edges, edgePositions: Float32Array.from(ep),
    ...(normals ? { normals: normals.slice(0, 3 * used) } : {}) };
  const still = openEdges(d, result).open.sort((a, b) => a - b);
  for (const id of joined) if (still.includes(id)) skipped.set(id, 'joined, still open');
  return { result, joined: joined.filter((id) => !still.includes(id)), open: still, skipped, culprits };
}

/** The note for edges joined. */
export function joinedMessage(n: number): string {
  return `${n} ${n === 1 ? 'edge' : 'edges'} joined exactly: the meshes of the faces `
    + `${n === 1 ? 'it joins' : 'they join'} made to share their points along ${n === 1 ? 'it' : 'them'}`;
}

/**
 * joinEdges on a result whose diagnostics say it's open along edges (openEdgesCount), its diagnostics made to say what
 * is left: the open-edge errors replaced by one for the edges still open, and a note of those joined. Others as they
 * are.
 */
export function joinResult(d: BrepData, r: TessellationResult, deflection: number): TessellationResult {
  if (!openEdgesCount(r.diagnostics)) return r;
  const j = joinEdges(d, r, deflection);
  if (!j.joined.length) return r;
  const diagnostics: Diagnostic[] = [{ severity: 'info', message: joinedMessage(j.joined.length) },
    ...r.diagnostics.filter((x) => !openEdgesCount([x]))];
  if (j.open.length) diagnostics.push({ severity: 'error', message: openEdgesMessage(j.open.length) });
  return { ...j.result, diagnostics };
}
