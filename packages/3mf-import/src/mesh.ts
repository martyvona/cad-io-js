// A 3MF mesh object's triangles as a scene mesh (the user, 2026-10-29; CLAUDE.md, "Decisions": 3MF import):
//
//   faces: all of the object's triangles of one property (colour) are one face, regrouped by it, faces numbered from
//     0 in order of first use (decision 2);
//   normals: 3MF has none, and shares vertices across sharp edges, so each corner's normal is the angle-weighted sum
//     of the normals of the triangles around its vertex within the crease angle of its own triangle's, so smooth
//     surfaces shade smooth and edges sharper than the angle stay sharp (decision 3; as three.js's
//     toCreasedNormals, but corners with the same normal keep sharing a vertex); vertices at one position count as
//     one (a writer that gives each triangle its own vertices still shades smooth);
//   positions relative to the centre of the box of the vertices the triangles use, subtracted in double precision.

import { weld, type Mesh, type Vec3 } from 'cad-scene';

export interface RawMesh {
  /** x, y, z per vertex, in the file's unit. */
  vertices: Float64Array;
  /** Three vertex indices per triangle, checked: in range, distinct. */
  triangles: Uint32Array;
  /** Each triangle's property: an index into the object's list of properties. */
  properties: Uint32Array;
}

/** The scene mesh, and each face's property (by index into the object's list). */
export function buildMesh(raw: RawMesh, creaseAngle: number): { mesh: Mesh; faceProperties: number[] } {
  const { vertices: v, triangles: tri, properties: prop } = raw;
  const n = tri.length / 3;

  // Faces: triangles regrouped by property, in order of first use.
  const faceOf = new Map<number, number>();
  const faceProperties: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!faceOf.has(prop[t]!)) { faceOf.set(prop[t]!, faceProperties.length); faceProperties.push(prop[t]!); }
  }
  const counts = new Uint32Array(faceProperties.length);
  for (let t = 0; t < n; t++) counts[faceOf.get(prop[t]!)!]!++;
  const starts = new Uint32Array(faceProperties.length);
  for (let f = 1; f < starts.length; f++) starts[f] = starts[f - 1]! + counts[f - 1]!;
  const order = new Uint32Array(n);
  const fill = starts.slice();
  for (let t = 0; t < n; t++) order[fill[faceOf.get(prop[t]!)!]!++] = t;

  // The origin: the centre of the box of the vertices used.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i++) {
    const a = 3 * tri[i]!;
    for (let k = 0; k < 3; k++) { const x = v[a + k]!; if (x < lo[k]!) lo[k] = x; if (x > hi[k]!) hi[k] = x; }
  }
  const origin: Vec3 = n ? [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2] : [0, 0, 0];
  const local = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) local[i + k] = v[i + k]! - origin[k]!;
  }

  // Each triangle's unit normal and its angle at each corner (in doubles, from the file's positions).
  const tn = new Float32Array(3 * n), angle = new Float32Array(3 * n);
  for (let t = 0; t < n; t++) {
    const a = 3 * tri[3 * t]!, b = 3 * tri[3 * t + 1]!, c = 3 * tri[3 * t + 2]!;
    const e: number[][] = [[v[b]! - v[a]!, v[b + 1]! - v[a + 1]!, v[b + 2]! - v[a + 2]!],
      [v[c]! - v[b]!, v[c + 1]! - v[b + 1]!, v[c + 2]! - v[b + 2]!],
      [v[a]! - v[c]!, v[a + 1]! - v[c + 1]!, v[a + 2]! - v[c + 2]!]];
    const [p, q] = [e[0]!, e[2]!];
    const x = p[1]! * -q[2]! - p[2]! * -q[1]!, y = p[2]! * -q[0]! - p[0]! * -q[2]!, z = p[0]! * -q[1]! - p[1]! * -q[0]!;
    const len = Math.hypot(x, y, z);
    if (len > 0) { tn[3 * t] = x / len; tn[3 * t + 1] = y / len; tn[3 * t + 2] = z / len; }
    // The angle at each corner, between the edges leaving it.
    for (let k = 0; k < 3; k++) {
      const out = e[k]!, back = e[(k + 2) % 3]!;
      const dot = -(out[0]! * back[0]! + out[1]! * back[1]! + out[2]! * back[2]!);
      angle[3 * t + k] = Math.atan2(len, dot);
    }
  }

  // The triangles around each vertex, vertices at one position counted as one.
  const { remap } = weld(local);
  let welded = 0;
  for (let i = 0; i < remap.length; i++) if (remap[i]! >= welded) welded = remap[i]! + 1;
  const around = new Uint32Array(welded + 1);
  for (let i = 0; i < tri.length; i++) around[remap[tri[i]!]! + 1]!++;
  for (let w = 0; w < welded; w++) around[w + 1]! += around[w]!;
  const corners = new Uint32Array(tri.length);
  const put = around.slice(0, welded);
  for (let i = 0; i < tri.length; i++) corners[put[remap[tri[i]!]!]!++] = i;

  // Each corner's normal, and the vertices of the result: one per file vertex and distinct normal.
  const cos = Math.cos(creaseAngle);
  let positions = new Float32Array(3 * Math.max(16, v.length / 3)), normals = new Float32Array(positions.length);
  let next = new Int32Array(positions.length / 3);
  let count = 0;
  const indices = new Uint32Array(tri.length);
  // Each file vertex's result vertices, as a list through `next`.
  const head = new Int32Array(v.length / 3).fill(-1);
  const sum = [0, 0, 0];
  for (let o = 0; o < n; o++) {
    const t = order[o]!;
    for (let k = 0; k < 3; k++) {
      const i = 3 * t + k, w = remap[tri[i]!]!;
      const nx = tn[3 * t]!, ny = tn[3 * t + 1]!, nz = tn[3 * t + 2]!;
      const flat = nx === 0 && ny === 0 && nz === 0;
      sum[0] = sum[1] = sum[2] = 0;
      for (let c = around[w]!; c < around[w + 1]!; c++) {
        const j = corners[c]!, u = (j / 3) | 0;
        const ux = tn[3 * u]!, uy = tn[3 * u + 1]!, uz = tn[3 * u + 2]!;
        // A degenerate triangle has no normal of its own: it takes the vertex's whole sum.
        if (!flat && ux * nx + uy * ny + uz * nz < cos) continue;
        const a = angle[j]!;
        sum[0] += a * ux; sum[1] += a * uy; sum[2] += a * uz;
      }
      let len = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
      if (!(len > 0)) { sum[0] = flat ? 0 : nx; sum[1] = flat ? 0 : ny; sum[2] = flat ? 1 : nz; len = 1; }
      const fx = Math.fround(sum[0]! / len), fy = Math.fround(sum[1]! / len), fz = Math.fround(sum[2]! / len);
      const vi = tri[i]!;
      let out = head[vi]!;
      while (out >= 0 && !(normals[3 * out] === fx && normals[3 * out + 1] === fy && normals[3 * out + 2] === fz)) {
        out = next[out]!;
      }
      if (out < 0) {
        if (count === next.length) {
          const grow = (a: Float32Array) => { const b = new Float32Array(2 * a.length); b.set(a); return b; };
          positions = grow(positions);
          normals = grow(normals);
          const b = new Int32Array(2 * next.length);
          b.set(next);
          next = b;
        }
        out = count++;
        next[out] = head[vi]!;
        head[vi] = out;
        positions.set(local.subarray(3 * vi, 3 * vi + 3), 3 * out);
        normals[3 * out] = fx; normals[3 * out + 1] = fy; normals[3 * out + 2] = fz;
      }
      indices[3 * o + k] = out;
    }
  }

  const faces = faceProperties.map((_, f) => ({ source: f, start: 3 * starts[f]!, count: 3 * counts[f]! }));
  return { mesh: { origin, positions: positions.slice(0, 3 * count), normals: normals.slice(0, 3 * count), indices,
    faces }, faceProperties };
}
