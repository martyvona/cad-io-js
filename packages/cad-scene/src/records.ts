// Each face's record for mesh triage (docs/triage.md, "The criteria"): what a backend's mesh of the face measures by
// criteria k, a, b, c, d, e, f, g, h and l, whoever made it. faceRecords measures a result as its backend shipped it
// (tess-workers' worker, after the request, with TessellationRequest.records); a.2 (sewn) and j (oriented) exist only
// once the result is joined and its shells oriented, so whoever joins it writes them (recordSewn, recordOriented).
// Nothing chooses by the record yet.

import type { BrepData } from 'cad-brep';
import { BOUNDARY_SLACK, EXCESS_FRACTION, MAX_PLAUSIBLE_AREA, MISSING_FRACTION, weld } from './mesh.ts';
import { edgeUsers } from './open-edges.ts';
import type { FaceRecords, TessellationRequest, TessellationResult } from './tessellator.ts';

/**
 * Names how faceRecords measures: bumped whenever a record's values change for some result, so a cache holding
 * records (tess-cache) measures again rather than answer with old ones.
 */
export const RECORDS_VERSION = 1;

/** tess-cadio's smallest angle by default (its minAngle), the true limit of (f) where a request gives none. */
export const DEFAULT_MIN_ANGLE = 10 * Math.PI / 180;

/** (b) and the other checks' classes, as FaceRecords stores them. */
export const AREA = { pass: 0, short: 1, over: 2, unverified: 3 } as const;
/**
 * (c) and (d): unchecked (a foreign backend's, trusted); measured (the value the worst found, so the face passes
 * where it's within the limit); a lower bound (the measuring stopped at the first point past the limit); passed with
 * no value (nothing was past the limit, nothing measured); failed with no value.
 */
export const CHECK = { unchecked: 0, measured: 1, lowerBound: 2, passed: 3, failedUnmeasured: 4 } as const;

/**
 * (h)'s expected count: none (the face failed before tess-cadio's count, or no count was asked); tess-cadio's first
 * meshing's (tc_expected_counts: every foreign backend's); the backend's own cap's (tess-cadio's results).
 */
export const EXPECTED = { none: 0, firstMeshing: 1, backend: 2 } as const;

/** (j): as the backend shipped it (judged right, or not judged: orient.ts's wrongShells), or turned by orientResult. */
export const ORIENTATION = { asShipped: 0, turned: 1 } as const;

/**
 * What faceRecords takes besides the result: the part's size (tess-cadio's partSize, for g) and each face's expected
 * triangles (tess-cadio's point cap's on the face's first meshing, for h), by face id, where known (0: no count).
 */
export interface RecordInputs {
  partSize?: number;
  expected?: ReadonlyMap<number, number>;
}

/**
 * The record of every face of `model` (by source id, a face a backend split summed over its pieces; faces the result
 * doesn't mesh have a row with no triangles), measured on `r` as shipped: k, a.1, b (against the result's area
 * oracle), c and d (the backend's own where it reports them, TessellationResult.reported; else unchecked), e (against
 * the shipped normals; unchecked without them), f, g, h (with `inputs`) and l. Positions are Float32 minus the
 * origin, compared exactly: a degenerate triangle has two corners at one position, and mesh edges are welded by
 * position.
 */
export function faceRecords(req: Pick<TessellationRequest, 'linearDeflection' | 'minAngle'>, r: TessellationResult,
  model: BrepData | undefined, inputs: RecordInputs = {}): FaceRecords {
  const ids: number[] = [];
  const rowOf = new Map<number, number>();
  const row = (id: number) => {
    let k = rowOf.get(id);
    if (k === undefined) rowOf.set(id, k = ids.length), ids.push(id);
    return k;
  };
  if (model) for (const id of model.face.id) if (id) row(id);
  for (const f of r.faces) if (f.entityId !== null) row(f.entityId);
  const n = ids.length;
  const out = emptyRecords(ids, inputs.partSize);
  const p = r.positions, ix = r.indices, nm = r.normals;
  // Mesh vertices then the edge polylines' points, welded together: a polyline's points are mesh vertices.
  const nv = p.length / 3, ep = r.edges && r.edgePositions ? r.edgePositions : undefined;
  const all = ep ? new Float32Array(p.length + ep.length) : p;
  if (ep) all.set(p), all.set(ep, p.length);
  const welded = weld(all), w = welded.remap, nw = welded.positions.length / 3;
  const key = (a: number, b: number) => (a < b ? a * nw + b : b * nw + a);
  const minAngle = req.minAngle ?? DEFAULT_MIN_ANGLE;
  // The mesh edges along a B-rep edge's polyline, where the result has them: a once-used edge off them is a hole in
  // its face.
  let onPolylines: Set<number> | undefined;
  if (ep) {
    onPolylines = new Set();
    for (const e of r.edges!) for (let q = e.start; q + 1 < e.start + e.count; q++) {
      const a = w[nv + q]!, b = w[nv + q + 1]!;
      if (a !== b) onPolylines.add(key(a, b));
    }
  }
  const ranges: { start: number; count: number }[][] = Array.from({ length: n }, () => []);
  for (const f of r.faces) if (f.entityId !== null) ranges[rowOf.get(f.entityId)!]!.push(f);
  const v = (i: number, c: number) => p[3 * i + c]!;
  for (let k = 0; k < n; k++) {
    const edges = new Map<number, { uses: number; net: number }>();  // by welded edge: uses, net direction
    let triangles = 0, degenerate = 0, area = 0, turned = 0, below = 0, smallest = Infinity, longest = 0;
    for (const { start, count } of ranges[k]!) {
      for (let t = start; t < start + count; t += 3) {
        const a = ix[t]!, b = ix[t + 1]!, c = ix[t + 2]!;
        triangles++;
        const wa = w[a]!, wb = w[b]!, wc = w[c]!;
        if (wa === wb || wb === wc || wc === wa) { degenerate++; continue; }
        const e1 = [v(b, 0) - v(a, 0), v(b, 1) - v(a, 1), v(b, 2) - v(a, 2)];
        const e2 = [v(c, 0) - v(a, 0), v(c, 1) - v(a, 1), v(c, 2) - v(a, 2)];
        const e3 = [v(c, 0) - v(b, 0), v(c, 1) - v(b, 1), v(c, 2) - v(b, 2)];
        const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!,
          e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        const twice = Math.hypot(cr[0]!, cr[1]!, cr[2]!);
        area += twice / 2;
        const la = Math.hypot(e1[0]!, e1[1]!, e1[2]!), lb = Math.hypot(e3[0]!, e3[1]!, e3[2]!);
        const lc = Math.hypot(e2[0]!, e2[1]!, e2[2]!);
        longest = Math.max(longest, la, lb, lc);
        // (The smallest angle is opposite the shortest side: its sine is twice the area over the other two.)
        const lmin = Math.min(la, lb, lc), lmax = Math.max(la, lb, lc), lmid = la + lb + lc - lmin - lmax;
        const angle = Math.asin(Math.min(1, twice / (lmid * lmax)));
        smallest = Math.min(smallest, angle);
        if (angle < minAngle) below++;
        if (nm) {
          const s = [0, 1, 2].map((q) => nm[3 * a + q]! + nm[3 * b + q]! + nm[3 * c + q]!);
          if (cr[0]! * s[0]! + cr[1]! * s[1]! + cr[2]! * s[2]! < 0) turned++;
        }
        for (const [x, y] of [[wa, wb], [wb, wc], [wc, wa]] as const) {
          const e = edges.get(key(x, y)) ?? { uses: 0, net: 0 };
          e.uses++, e.net += x < y ? 1 : -1;
          edges.set(key(x, y), e);
        }
      }
    }
    let nonManifold = 0, open = 0, holes = 0;
    for (const [k2, { uses, net }] of edges) {
      if (uses > 2 || (uses === 2 && net !== 0)) nonManifold++;
      else if (uses === 1) {
        open++;
        if (onPolylines && !onPolylines.has(k2)) holes++;
      }
    }
    out.triangles[k] = triangles;
    out.degenerate[k] = degenerate;
    out.nonManifoldEdges[k] = nonManifold;
    out.openEdges[k] = open;
    out.holeEdges[k] = onPolylines ? holes : -1;
    out.area[k] = area;
    out.turned[k] = nm ? turned : -1;
    out.minAngle[k] = smallest === Infinity ? NaN : smallest;
    out.belowMinAngle[k] = below;
    out.longestEdge[k] = longest;
    const e = inputs.expected?.get(ids[k]!);
    if (e !== undefined && e > 0) out.expected[k] = e, out.expectedSource[k] = EXPECTED.firstMeshing;
  }
  judgeAreas(out, r, model, req.linearDeflection);
  takeReported(out, r, rowOf);
  return out;
}

/** Records with a row per id and every value absent or zero. */
function emptyRecords(ids: number[], partSize: number | undefined): FaceRecords {
  const n = ids.length;
  const f64 = (x: number) => new Float64Array(n).fill(x);
  return { entityId: Float64Array.from(ids), partSize: partSize ?? NaN, triangles: new Uint32Array(n),
    degenerate: new Uint32Array(n), nonManifoldEdges: new Uint32Array(n), openEdges: new Uint32Array(n),
    holeEdges: new Int32Array(n).fill(-1), area: f64(0), oracleArea: f64(NaN), areaClass: new Uint8Array(n),
    deviation: f64(NaN), deviationCheck: new Uint8Array(n), normalAngle: f64(NaN), normalCheck: new Uint8Array(n),
    turned: new Int32Array(n).fill(-1), minAngle: f64(NaN), belowMinAngle: new Uint32Array(n), longestEdge: f64(0),
    expected: f64(NaN), expectedSource: new Uint8Array(n), unsewnEdges: new Int32Array(n).fill(-1),
    orientation: new Uint8Array(n) };
}

/**
 * (b): each face's mesh area against the result's area oracle (TessellationResult.oracle), by faceFailures' rules (a
 * face used by several shells meshed once in each); unverified where the oracle trusts no area.
 */
function judgeAreas(out: FaceRecords, r: TessellationResult, model: BrepData | undefined, d: number): void {
  // (Each face's uses by shells, as tessellate.ts's faceUses: not imported, which would make a cycle through join.ts.)
  const uses = new Map<number, number>();
  if (model) for (const f of model.faceUse.face) {
    const id = model.face.id[f]!;
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const oracle = new Map((r.oracle ?? []).map((o) => [o.entityId, o]));
  for (let k = 0; k < out.entityId.length; k++) {
    const id = out.entityId[k]!, o = oracle.get(id);
    if (!o || !Number.isFinite(o.area) || o.area < 0 || o.area > MAX_PLAUSIBLE_AREA || !(o.perimeter >= 0)) {
      out.areaClass[k] = AREA.unverified;
      continue;
    }
    const m = uses.get(id) ?? 1, a = o.area * m, perimeter = o.perimeter * m, mesh = out.area[k]!;
    out.oracleArea[k] = a;
    const slack = BOUNDARY_SLACK * d * perimeter;
    out.areaClass[k] = a < d * d ? AREA.pass : a - mesh > Math.max(MISSING_FRACTION * a, slack) ? AREA.short
      : mesh - a > Math.max(EXCESS_FRACTION * a, slack) ? AREA.over : AREA.pass;
  }
}

/**
 * (c), (d) and (h) where the backend reports its own (TessellationResult.reported: tess-cadio's): its deviation and
 * normal checks as CHECK says, and the expected count its point cap meshed the face to (its last meshing's), so it
 * can't fail (h) against a slightly different number; other backends' (h) the first meshing's (RecordInputs).
 */
function takeReported(out: FaceRecords, r: TessellationResult, rowOf: ReadonlyMap<number, number>): void {
  for (const x of r.reported ?? []) {
    const k = rowOf.get(x.entityId);
    if (k === undefined) continue;
    out.deviationCheck[k] = x.deviationCheck;
    out.deviation[k] = x.deviation;
    out.normalCheck[k] = x.normalCheck;
    out.normalAngle[k] = x.normalAngle;
    if (x.expected > 0) out.expected[k] = x.expected, out.expectedSource[k] = EXPECTED.backend;
  }
}

/**
 * The records with (a.2) written: each face's model edges along which the joined result's mesh is still open (`open`,
 * edge ids: openEdges'), 0 for the rest; unchanged (-1) where the result has no edge polylines to judge by.
 */
export function recordSewn(records: FaceRecords, model: BrepData, open: readonly number[], hasEdges: boolean):
  FaceRecords {
  if (!hasEdges) return records;
  const unsewn = new Int32Array(records.entityId.length);
  if (open.length) {
    const users = edgeUsers(model), rowOf = new Map<number, number>();
    records.entityId.forEach((id, k) => rowOf.set(id, k));
    for (const e of open) for (const f of users.get(e) ?? []) {
      const k = rowOf.get(f);
      if (k !== undefined) unsewn[k]!++;
    }
  }
  return { ...records, unsewnEdges: unsewn };
}

/** The records with (j) written: the faces of the shells orientResult turned over (`faces`, ids) turned. */
export function recordOriented(records: FaceRecords, faces: ReadonlySet<number>): FaceRecords {
  const orientation = new Uint8Array(records.entityId.length);
  records.entityId.forEach((id, k) => { orientation[k] = faces.has(id) ? ORIENTATION.turned : ORIENTATION.asShipped; });
  return { ...records, orientation };
}

/**
 * `a`'s records with the faces `faces` (ids) `b`'s rows, as composeResults takes those faces' meshes from `b`; the
 * part's size `a`'s. A face `b` has no row for keeps `a`'s.
 */
export function composeRecords(a: FaceRecords, b: FaceRecords, faces: ReadonlySet<number>): FaceRecords {
  const rowOf = new Map<number, number>();
  b.entityId.forEach((id, k) => rowOf.set(id, k));
  const out = { ...a } as Record<string, unknown>;
  for (const [name, col] of Object.entries(a)) {
    if (!ArrayBuffer.isView(col) || name === 'entityId') continue;
    const from = (b as unknown as Record<string, ArrayLike<number>>)[name]!;
    const c = (col as unknown as { slice(): Float64Array }).slice();
    a.entityId.forEach((id, k) => {
      const j = faces.has(id) ? rowOf.get(id) : undefined;
      if (j !== undefined) c[k] = from[j]!;
    });
    out[name] = c;
  }
  return out as unknown as FaceRecords;
}

/** Records as JSON (each column a plain array, NaN as null), for a cache's entry; recordsFromJson reads it back. */
export function recordsJson(r: FaceRecords): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(r)) out[name] = ArrayBuffer.isView(col)
    ? Array.from(col as unknown as ArrayLike<number>, (x) => (Number.isNaN(x) ? null : x))
    : Number.isNaN(col) ? null : col;
  return out;
}

/** Records from recordsJson's JSON; undefined if it isn't that. */
export function recordsFromJson(j: unknown): FaceRecords | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>, ids = o.entityId;
  if (!Array.isArray(ids)) return undefined;
  const template = emptyRecords([], undefined) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(template)) {
    const v = o[name];
    if (!ArrayBuffer.isView(col)) {
      out[name] = typeof v === 'number' ? v : NaN;
      continue;
    }
    if (!Array.isArray(v) || v.length !== ids.length) return undefined;
    const C = (col as unknown as { constructor: new (a: ArrayLike<number>) => unknown }).constructor;
    out[name] = new C(v.map((x) => (x === null ? NaN : Number(x))));
  }
  return out as unknown as FaceRecords;
}

