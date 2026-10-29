// AP242 tessellated geometry read into a mesh (CLAUDE.md, "AP242 tessellated geometry read by step-import"; the
// CAx-IF practice rec_prac_3dtess_geo_v11.pdf, sections 4-7): solids, shells, faces and surface sets as triangles,
// faces by their STEP ids; curve sets, wires, edges, vertices and point sets as curves and points; geometric sets,
// repositioned items with their placement applied. Edges are the file's tessellated edges where a shell or solid has
// them, else its faces' boundaries, shared where two faces meet and free otherwise. Normals are the file's, else
// computed smooth within each face (each face has its own vertices).
//
// Strips follow Part 42's order: triangle i of a strip is (i, i+1, i+2), every other one turned to (i+1, i, i+2), and
// fans (1, i, i+1). Checked against the files' own normals (NIST FTC 08 -tg: 3,370 of 3,370 strip triangles agree;
// bug33638.stp 12 of 12; both solids' volumes positive); OCCT 8.1 reads strips and fans the other way round
// (StepToTopoDS_TranslateFace), so its meshes of these files face inward.

import { listItems, math, placement, type Mat4, type Reader, type Value } from 'step-parser';
import type { EdgeKind, Mesh, Vec3 } from 'cad-scene';

/** Tessellated items this reader takes as they come (others make a representation go to a backend, as before). */
const READABLE = ['TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TRIANGULATED_FACE', 'COMPLEX_TRIANGULATED_FACE',
  'TRIANGULATED_SURFACE_SET', 'COMPLEX_TRIANGULATED_SURFACE_SET', 'TESSELLATED_CURVE_SET', 'TESSELLATED_WIRE',
  'TESSELLATED_EDGE', 'TESSELLATED_VERTEX', 'TESSELLATED_POINT_SET', 'TESSELLATED_GEOMETRIC_SET', 'COORDINATES_LIST'];
/** Faces and surface sets: one face of the mesh each. */
const FACES = ['TRIANGULATED_FACE', 'COMPLEX_TRIANGULATED_FACE', 'TRIANGULATED_SURFACE_SET',
  'COMPLEX_TRIANGULATED_SURFACE_SET'];

/**
 * Whether a representation's geometric items (placements, mapped items and annotations left out) are all tessellated:
 * `readable` if this reader takes every one of them (and what they hold), else the first one it doesn't, by type.
 */
export function tessellatedItems(r: Reader, items: number[]): { readable: true } | { readable: false; type: string }
  | undefined {
  if (!items.length || !items.every((q) => r.is(q, 'TESSELLATED_ITEM'))) return undefined;
  const seen = new Set<number>();
  const check = (q: number): string | undefined => {
    if (seen.has(q)) return undefined;
    seen.add(q);
    const types = r.model.types(q);
    if (!READABLE.some((t) => r.is(q, t))) return types.join('+');
    for (const name of ['items', 'children']) for (const c of r.refs(q, name)) {
      const bad = check(c);
      if (bad) return bad;
    }
    return undefined;
  };
  for (const q of items) {
    const bad = check(q);
    if (bad) return { readable: false, type: bad };
  }
  return { readable: true };
}

export interface TessellatedMesh {
  mesh: Mesh;
  /** The face entities (faces and surface sets), in the mesh's face order. */
  faces: number[];
  /** True when every face is in a solid or a shell linked to a closed shell; false if one is in an open one. */
  closed?: boolean;
}

/** A face as the mesh will hold it: positions (with the placement applied, not yet less the origin) and triangles. */
interface FaceData {
  entity: number;
  source: number;
  positions: number[];
  normals: (number[] | undefined)[];
  triangles: number[];
  /** Whether its tessellated edges (if its shell has any) replace its boundary. */
  shell: number;
}

/**
 * Read tessellated items into a mesh in their representation's unit, less its own origin (the centre of the points'
 * box). `faceSource(p)` gives a face's source id (default: the face's own id). Problems go to `warn`.
 */
export function readTessellated(r: Reader, items: number[], warn: (message: string, p: number) => void,
  faceSource: (p: number) => number = (p) => r.id(p)): TessellatedMesh {
  const coordsCache = new Map<number, Float64Array>();
  const coordsOf = (p: number): Float64Array => {
    let c = coordsCache.get(p);
    if (!c) {
      const rows = listOf(r.attr(p, 'position_coords'));
      c = new Float64Array(rows.length * 3);
      rows.forEach((row, i) => { const xs = numbers(row); for (let k = 0; k < 3; k++) c![i * 3 + k] = xs[k] ?? 0; });
      coordsCache.set(p, c);
    }
    return c;
  };

  const faces: FaceData[] = [];
  const fileEdges: { shell: number; source: number; kind: EdgeKind; points: number[] }[] = [];
  const curves: { source: number; points: number[] }[] = [];
  const points: { source: number; point: number[] }[] = [];
  const shellsWithEdges = new Set<number>();
  let closed: boolean | undefined;
  let anyFace = false;
  const closure = (c: boolean | undefined) => {
    closed = !anyFace ? c : closed === false || c === false ? false : closed === undefined || c === undefined
      ? undefined : true;
    anyFace = true;
  };

  const apply = (m: Mat4 | undefined, x: number, y: number, z: number): number[] => (m ? [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!] : [x, y, z]);
  const rotate = (m: Mat4 | undefined, n: number[]): number[] => (m ? [m[0]! * n[0]! + m[4]! * n[1]! + m[8]! * n[2]!,
    m[1]! * n[0]! + m[5]! * n[1]! + m[9]! * n[2]!, m[2]! * n[0]! + m[6]! * n[1]! + m[10]! * n[2]!] : n);
  // A point of a coordinates list by its 1-based index, placed; undefined (with a warning) when out of range.
  const pointAt = (list: number, k: number, m: Mat4 | undefined, owner: number): number[] | undefined => {
    const c = coordsOf(list);
    if (!Number.isInteger(k) || k < 1 || k * 3 > c.length) {
      warn(`index ${k} outside its coordinates list (${c.length / 3} points); skipped`, owner);
      return undefined;
    }
    return apply(m, c[k * 3 - 3]!, c[k * 3 - 2]!, c[k * 3 - 1]!);
  };

  const face = (p: number, m: Mat4 | undefined, shell: number) => {
    const list = r.ref(p, 'coordinates');
    if (list < 0) { warn('tessellated face without coordinates; skipped', p); return; }
    const pn = numbers(r.attr(p, 'pnindex'));
    const given = listOf(r.attr(p, 'normals')).map(numbers);
    // Triangles as 1-based indices into pnindex (or the coordinates when it's empty).
    const tris: number[] = [];
    if (r.is(p, 'TRIANGULATED_FACE') || r.is(p, 'TRIANGULATED_SURFACE_SET')) {
      for (const t of listOf(r.attr(p, 'triangles'))) { const v = numbers(t); tris.push(v[0]!, v[1]!, v[2]!); }
    } else {
      for (const s of listOf(r.attr(p, 'triangle_strips')).map(numbers)) for (let i = 0; i + 2 < s.length; i++) {
        if (i % 2 === 0) tris.push(s[i]!, s[i + 1]!, s[i + 2]!);
        else tris.push(s[i + 1]!, s[i]!, s[i + 2]!);
      }
      for (const s of listOf(r.attr(p, 'triangle_fans')).map(numbers)) for (let i = 1; i + 1 < s.length; i++) {
        tris.push(s[0]!, s[i]!, s[i + 1]!);
      }
    }
    // Each index used becomes a vertex of the face's own, its normal the file's (one per index, or one for all).
    const local = new Map<number, number>();
    const f: FaceData = { entity: p, source: faceSource(p), positions: [], normals: [], triangles: [], shell };
    const vertex = (k: number): number | undefined => {
      let v = local.get(k);
      if (v !== undefined) return v;
      const ci = pn.length ? pn[k - 1] : k;
      if (ci === undefined) { warn(`index ${k} outside pnindex (${pn.length}); skipped`, p); return undefined; }
      const at = pointAt(list, ci, m, p);
      if (!at) return undefined;
      v = f.positions.length / 3;
      f.positions.push(...at);
      const n = given.length === 1 ? given[0] : given.length ? given[k - 1] : undefined;
      f.normals.push(n && n.length === 3 ? rotate(m, n) : undefined);
      local.set(k, v);
      return v;
    };
    let degenerate = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      // (Strips repeat an index to turn or restart: those triangles have no area and aren't drawn.)
      if (a === b || b === c || a === c) { degenerate++; continue; }
      const va = vertex(a), vb = vertex(b), vc = vertex(c);
      if (va !== undefined && vb !== undefined && vc !== undefined) f.triangles.push(va, vb, vc);
    }
    if (degenerate && !(r.is(p, 'COMPLEX_TRIANGULATED_FACE') || r.is(p, 'COMPLEX_TRIANGULATED_SURFACE_SET'))) {
      warn(`${degenerate} triangle${degenerate === 1 ? '' : 's'} with a repeated corner; skipped`, p);
    }
    faces.push(f);
  };

  const edge = (p: number, m: Mat4 | undefined): number[] => {
    const list = r.ref(p, 'coordinates');
    const out: number[] = [];
    if (list < 0) { warn('tessellated edge without coordinates; skipped', p); return out; }
    for (const k of numbers(r.attr(p, 'line_strip'))) { const at = pointAt(list, k, m, p); if (at) out.push(...at); }
    return out;
  };
  const vertexPoint = (p: number, m: Mat4 | undefined) => {
    const list = r.ref(p, 'coordinates');
    const at = list >= 0 ? pointAt(list, r.num(p, 'point_index') ?? 0, m, p) : undefined;
    if (at) points.push({ source: r.id(p), point: at });
  };

  // (An item may be reached twice, as a set's child and again repositioned: each is drawn; only cycles are cut.)
  const visit = (p: number, m: Mat4 | undefined, path: Set<number>) => {
    if (path.has(p)) return;
    path.add(p);
    // A repositioned item's placement applies to what it holds (practice, section 7).
    if (r.is(p, 'REPOSITIONED_TESSELLATED_ITEM')) {
      const at = placement(r, r.ref(p, 'location'));
      if (at) m = m ? math.multiply(m, at) : at;
    }
    if (r.is(p, 'TESSELLATED_SOLID') || r.is(p, 'TESSELLATED_SHELL')) {
      // Closed: a solid is; a shell as the topological shell it stands for says, else unknown.
      let c: boolean | undefined;
      if (r.is(p, 'TESSELLATED_SOLID')) c = true;
      else {
        const link = r.ref(p, 'topological_link');
        c = r.is(link, 'CLOSED_SHELL') ? true : r.is(link, 'OPEN_SHELL') ? false : undefined;
      }
      let hasFace = false;
      for (const q of r.refs(p, 'items')) {
        if (FACES.some((t) => r.is(q, t))) { face(q, m, p); hasFace = true; }
        else if (r.is(q, 'TESSELLATED_EDGE')) {
          shellsWithEdges.add(p);
          // A connecting edge joins two faces; a plain one in a shell is on its free boundary (the practice: a
          // connecting edge needs both faces).
          fileEdges.push({ shell: p, source: r.id(q), kind: r.is(q, 'TESSELLATED_CONNECTING_EDGE') ? 'shared' : 'free',
            points: edge(q, m) });
        }
        // (Vertices of a shell are its corners, drawn as B-rep vertices are: not at all.)
      }
      if (hasFace) closure(c);
    } else if (FACES.some((t) => r.is(p, t))) {
      face(p, m, -1);
      closure(undefined);
    } else if (r.is(p, 'TESSELLATED_CURVE_SET')) {
      const list = r.ref(p, 'coordinates');
      for (const s of listOf(r.attr(p, 'line_strips')).map(numbers)) {
        const pts: number[] = [];
        for (const k of s) { const at = pointAt(list, k, m, p); if (at) pts.push(...at); }
        if (pts.length >= 6) curves.push({ source: r.id(p), points: pts });
      }
    } else if (r.is(p, 'TESSELLATED_WIRE')) {
      for (const q of r.refs(p, 'items')) {
        if (r.is(q, 'TESSELLATED_EDGE')) { const pts = edge(q, m); if (pts.length >= 6) curves.push({ source: r.id(q),
          points: pts }); }
        else if (r.is(q, 'TESSELLATED_VERTEX')) vertexPoint(q, m);
      }
    } else if (r.is(p, 'TESSELLATED_EDGE')) {
      const pts = edge(p, m);
      if (pts.length >= 6) curves.push({ source: r.id(p), points: pts });
    } else if (r.is(p, 'TESSELLATED_VERTEX')) {
      vertexPoint(p, m);
    } else if (r.is(p, 'TESSELLATED_POINT_SET')) {
      const list = r.ref(p, 'coordinates');
      for (const k of numbers(r.attr(p, 'point_list'))) {
        const at = pointAt(list, k, m, p);
        if (at) points.push({ source: r.id(p), point: at });
      }
    }
    if (r.is(p, 'TESSELLATED_GEOMETRIC_SET')) for (const q of r.refs(p, 'children')) visit(q, m, path);
    path.delete(p);
  };
  for (const q of items) visit(q, undefined, new Set());

  // The origin: the centre of the box of everything drawn, so float32 keeps its precision.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const extend = (xs: ArrayLike<number>) => {
    for (let i = 0; i + 2 < xs.length; i += 3) for (let k = 0; k < 3; k++) {
      if (xs[i + k]! < lo[k]!) lo[k] = xs[i + k]!;
      if (xs[i + k]! > hi[k]!) hi[k] = xs[i + k]!;
    }
  };
  for (const f of faces) extend(f.positions);
  for (const e of fileEdges) extend(e.points);
  for (const c of curves) extend(c.points);
  for (const p of points) extend(p.point);
  const origin: Vec3 = lo[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as Vec3;
  const less = (xs: number[], out: Float32Array, at: number) => {
    for (let i = 0; i < xs.length; i++) out[at + i] = xs[i]! - origin[i % 3]!;
  };

  // Triangles: each face's own vertices, normals given or computed (area-weighted, within the face).
  const vertexCount = faces.reduce((n, f) => n + f.positions.length / 3, 0);
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(faces.reduce((n, f) => n + f.triangles.length, 0));
  const meshFaces: Mesh['faces'] = [];
  let v0 = 0, t0 = 0;
  for (const f of faces) {
    less(f.positions, positions, v0 * 3);
    const n = f.positions.length / 3;
    const sum = new Float64Array(n * 3);
    for (let t = 0; t < f.triangles.length; t += 3) {
      const [a, b, c] = [f.triangles[t]!, f.triangles[t + 1]!, f.triangles[t + 2]!];
      const P = f.positions;
      const u = [P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!];
      const w = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
      const x = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) sum[v * 3 + k] = sum[v * 3 + k]! + x[k]!;
      indices[t0 + t] = v0 + a; indices[t0 + t + 1] = v0 + b; indices[t0 + t + 2] = v0 + c;
    }
    for (let v = 0; v < n; v++) {
      const g = f.normals[v];
      const d = g && Math.hypot(g[0]!, g[1]!, g[2]!) > 0 ? g : [sum[v * 3]!, sum[v * 3 + 1]!, sum[v * 3 + 2]!];
      const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      for (let k = 0; k < 3; k++) normals[(v0 + v) * 3 + k] = d[k]! / len;
    }
    meshFaces.push({ source: f.source, start: t0, count: f.triangles.length });
    v0 += n;
    t0 += f.triangles.length;
  }

  // Edges: the file's where its shell has them, else the faces' boundaries (segments used once within a face),
  // shared where another face has the segment on its boundary too, free otherwise; chained into polylines.
  const edgeLines: { source: number | null; kind: EdgeKind; points: number[] }[] =
    fileEdges.filter((e) => e.points.length >= 6).map((e) => ({ source: e.source, kind: e.kind, points: e.points }));
  const key = (P: number[], v: number) => `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
  const boundary = new Map<string, { a: number[]; b: number[]; faces: number[] }>();
  faces.forEach((f, fi) => {
    if (shellsWithEdges.has(f.shell)) return;
    const count = new Map<string, { a: number; b: number; n: number }>();
    for (let t = 0; t < f.triangles.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = f.triangles[t + e]!, b = f.triangles[t + (e + 1) % 3]!;
      const ka = key(f.positions, a), kb = key(f.positions, b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const c = count.get(k);
      if (c) c.n++; else count.set(k, { a, b, n: 1 });
    }
    for (const [k, c] of count) {
      if (c.n !== 1) continue;
      const pa = f.positions.slice(c.a * 3, c.a * 3 + 3), pb = f.positions.slice(c.b * 3, c.b * 3 + 3);
      const s = boundary.get(k);
      if (s) s.faces.push(fi); else boundary.set(k, { a: pa, b: pb, faces: [fi] });
    }
  });
  // Chain segments of one kind and one pair of faces into polylines.
  const groups = new Map<string, { kind: EdgeKind; segments: { a: number[]; b: number[] }[] }>();
  for (const s of boundary.values()) {
    const kind: EdgeKind = s.faces.length > 1 ? 'shared' : 'free';
    const g = `${kind}:${[...s.faces].sort((x, y) => x - y).join(',')}`;
    let group = groups.get(g);
    if (!group) groups.set(g, group = { kind, segments: [] });
    group.segments.push({ a: s.a, b: s.b });
  }
  for (const { kind, segments } of groups.values()) {
    for (const line of chain(segments)) edgeLines.push({ source: null, kind, points: line });
  }

  const mesh: Mesh = { origin, positions, normals, indices, faces: meshFaces };
  if (edgeLines.length) {
    const total = edgeLines.reduce((n, e) => n + e.points.length, 0);
    mesh.edgePositions = new Float32Array(total);
    mesh.edges = [];
    let at = 0;
    for (const e of edgeLines) {
      less(e.points, mesh.edgePositions, at);
      mesh.edges.push({ source: e.source, start: at / 3, count: e.points.length / 3, kind: e.kind });
      at += e.points.length;
    }
  }
  if (curves.length) {
    mesh.curvePositions = new Float32Array(curves.reduce((n, c) => n + c.points.length, 0));
    mesh.curves = [];
    let at = 0;
    for (const c of curves) {
      less(c.points, mesh.curvePositions, at);
      mesh.curves.push({ source: c.source, start: at / 3, count: c.points.length / 3 });
      at += c.points.length;
    }
  }
  if (points.length) {
    mesh.points = new Float32Array(points.length * 3);
    points.forEach((p, i) => less(p.point, mesh.points!, i * 3));
    mesh.pointSources = points.map((p) => p.source);
  }
  return { mesh, faces: faces.map((f) => f.entity), ...(closed === undefined ? {} : { closed }) };
}

/** Segments joined end to end into polylines (flat xyz arrays), loops closed by repeating their first point. */
function chain(segments: { a: number[]; b: number[] }[]): number[][] {
  const k = (p: number[]) => `${p[0]},${p[1]},${p[2]}`;
  const at = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of [s.a, s.b]) { const l = at.get(k(p)); if (l) l.push(i); else at.set(k(p), [i]); }
  });
  const used = new Uint8Array(segments.length);
  const lines: number[][] = [];
  const walk = (start: number, from: number[]) => {
    const line = [...from];
    let point = from, seg = start;
    for (;;) {
      used[seg] = 1;
      const s = segments[seg]!;
      point = k(s.a) === k(point) ? s.b : s.a;
      line.push(...point);
      const next = (at.get(k(point)) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      // (Stop at branch points, where more than two segments meet: each branch is a line of its own.)
      if (at.get(k(point))!.length !== 2) break;
      seg = next;
    }
    lines.push(line);
  };
  // Open chains from their ends (or branch points) first, then loops.
  for (const [p, list] of at) {
    if (list.length === 2) continue;
    for (const i of list) if (!used[i]) {
      const s = segments[i]!;
      walk(i, k(s.a) === p ? s.a : s.b);
    }
  }
  segments.forEach((s, i) => { if (!used[i]) walk(i, s.a); });
  return lines;
}

/** A list value's elements ([] for anything else). */
function listOf(v: Value | undefined): Value[] {
  return v && (v.k === 'list' || v.k === 'reals' || v.k === 'ints' || v.k === 'refs') ? listItems(v) : [];
}

/** A list of numbers (or one number) as numbers; [] for anything else. */
function numbers(v: Value | undefined): number[] {
  if (!v) return [];
  if (v.k === 'reals' || v.k === 'ints') return Array.from(v.v as ArrayLike<number>);
  if (v.k === 'list') return v.v.flatMap((x) => (x.k === 'int' ? [Number(x.v)] : x.k === 'real' ? [x.v] : []));
  if (v.k === 'int') return [Number(v.v)];
  if (v.k === 'real') return [v.v];
  return [];
}

/**
 * A mesh moved by an affine transform (a tessellation into its B-rep's coordinates): positions, edges, curves and
 * points transformed (in double precision, from the mesh's origin), normals turned and renormalized, the origin the
 * centre of the result's box.
 */
export function moveMesh(mesh: Mesh, m: Mat4): Mesh {
  const arrays = [mesh.positions, mesh.edgePositions, mesh.curvePositions, mesh.points];
  const moved = arrays.map((a) => {
    if (!a) return undefined;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i]! + mesh.origin[0], y = a[i + 1]! + mesh.origin[1], z = a[i + 2]! + mesh.origin[2];
      out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    return out;
  });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const a of moved) if (a) for (let i = 0; i < a.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, a[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, a[i]!);
  }
  const origin: Vec3 = lo[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as Vec3;
  const [positions, edgePositions, curvePositions, points] = moved.map((a) => {
    if (!a) return undefined;
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! - origin[i % 3]!;
    return out;
  });
  const out: Mesh = { ...mesh, origin, positions: positions! };
  if (edgePositions) out.edgePositions = edgePositions;
  if (curvePositions) out.curvePositions = curvePositions;
  if (points) out.points = points;
  if (mesh.normals) {
    const n = new Float32Array(mesh.normals.length), a = mesh.normals;
    for (let i = 0; i < a.length; i += 3) {
      const x = m[0]! * a[i]! + m[4]! * a[i + 1]! + m[8]! * a[i + 2]!;
      const y = m[1]! * a[i]! + m[5]! * a[i + 1]! + m[9]! * a[i + 2]!;
      const z = m[2]! * a[i]! + m[6]! * a[i + 1]! + m[10]! * a[i + 2]!;
      const len = Math.hypot(x, y, z) || 1;
      n[i] = x / len; n[i + 1] = y / len; n[i + 2] = z / len;
    }
    out.normals = n;
  }
  return out;
}
