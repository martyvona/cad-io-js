// What a part's B-rep says of its faces, edges, curves and vertices, for the tree's icons (tree-panel.ts) and Details
// (details.ts), read from the model buffer (cad-brep's decode) and its analysis, never computed again: a face's
// surface and an edge's curve, by kind, with their parameters (millimetres, degrees) or, for B-splines, their degree,
// control points and knot spans; a vertex's point; and a part's volume, each solid's outer shell less its voids, by
// the analysis's shell volumes (the oracle's, where healing measured them) and by its mesh's triangles. Rows are
// found by the source id the mesh and the tree's nodes carry (each table's `id` column).

import { BODY_KIND, decode, LOOP_KIND, rowCount, type BrepAnalysis, type BrepData, type Curve, type Surface }
  from 'cad-brep';
import type { Mesh } from 'cad-scene';

/** What an icon shows: a surface's or curve's kind as the model names it, a wrapper's (trimmed, offset) its basis's. */
export type GeometryKind = Surface['kind'] | `curve:${Curve['kind']}`;

type Table = 'face' | 'edge' | 'vertex' | 'curve' | 'item';

const byId = new WeakMap<BrepData, Map<Table, Map<number, number>>>();

/** A table's row with this id (the first, where a baked copy repeats none), made once per model and table. */
export function rowOf(d: BrepData, table: Table, id: number): number | undefined {
  let tables = byId.get(d);
  if (!tables) byId.set(d, (tables = new Map()));
  let rows = tables.get(table);
  if (!rows) {
    rows = new Map();
    const ids = d[table].id;
    for (let i = ids.length - 1; i >= 0; i--) if (ids[i]) rows.set(ids[i]!, i);
    tables.set(table, rows);
  }
  return rows.get(id);
}

/** A wrapper's word in a name (`trimmed cylinder`), outermost first. */
type Wrapper = 'trimmed' | 'offset';

/**
 * A curve row's kind for its icon: a trimmed or offset curve's basis's, as far down as it goes; and the wrappers on
 * the way (16 deep; past that, the last wrapper's own kind, no wrappers: `trimmed curve`).
 */
function curveKind(d: BrepData, row: number): { kind: Curve['kind']; wrappers: Wrapper[] } {
  const wrappers: Wrapper[] = [];
  for (let r = row, k = 0; k < 16; k++) {
    const c = decode.curve(d, r);
    if (c.kind !== 'trimmed' && c.kind !== 'offset') return { kind: c.kind, wrappers };
    wrappers.push(c.kind);
    r = c.basis;
  }
  return { kind: wrappers.at(-1)!, wrappers: [] };
}

/** A surface row's kind for its icon and its wrappers, as curveKind's. */
function surfaceKind(d: BrepData, row: number): { kind: Surface['kind']; wrappers: Wrapper[] } {
  const wrappers: Wrapper[] = [];
  let last: Surface['kind'] = 'rectangularTrimmed';
  for (let r = row, k = 0; k < 16; k++) {
    const s = decode.surface(d, r);
    if (s.kind !== 'rectangularTrimmed' && s.kind !== 'offset') return { kind: s.kind, wrappers };
    wrappers.push(s.kind === 'offset' ? 'offset' : 'trimmed');
    last = s.kind;
    r = s.basis;
  }
  return { kind: last, wrappers: [] };
}

/** A kind as the tree names its nodes (`cylinder #12`, `circle #40`). */
export const GEOMETRY_NAMES: Readonly<Record<GeometryKind, string>> = {
  plane: 'plane', cylinder: 'cylinder', cone: 'cone', sphere: 'sphere', torus: 'torus', bspline: 'B-spline surface',
  extrusion: 'extrusion', revolution: 'revolution', offset: 'offset surface', rectangularTrimmed: 'trimmed surface',
  curveSwept: 'swept surface', fixedReferenceSwept: 'swept surface', 'curve:line': 'line', 'curve:circle': 'circle',
  'curve:ellipse': 'ellipse', 'curve:hyperbola': 'hyperbola', 'curve:parabola': 'parabola',
  'curve:bspline': 'B-spline curve', 'curve:polyline': 'polyline', 'curve:composite': 'composite curve',
  'curve:trimmed': 'trimmed curve', 'curve:offset': 'offset curve',
};

/** A face's, edge's or curve's geometry as the tree shows it: the kind its icon shows, and its name. */
export interface Geometry {
  kind: GeometryKind;
  /** The kind's name after its wrappers' words, outermost first, a word repeated next to itself once: `offset
   * trimmed cylinder`. */
  name: string;
}

/**
 * An item's geometry: a face's surface, an edge's or free curve's curve, a trimmed or offset one by its basis's kind
 * (named with the wrappers); none unknown (no 3D curve).
 */
export function geometryOf(d: BrepData, kind: 'face' | 'edge' | 'curve', id: number): Geometry | undefined {
  let found: { kind: GeometryKind; wrappers: Wrapper[] } | undefined;
  if (kind === 'face') {
    const f = rowOf(d, 'face', id);
    found = f === undefined ? undefined : surfaceKind(d, d.face.surface[f]!);
  } else {
    const c = kind === 'edge' ? edgeCurve(d, id) : itemCurve(d, id);
    const k = c === undefined ? undefined : curveKind(d, c);
    found = k && { kind: `curve:${k.kind}`, wrappers: k.wrappers };
  }
  if (!found) return undefined;
  const words = found.wrappers.filter((w, i, all) => w !== all[i - 1]);
  return { kind: found.kind, name: [...words, GEOMETRY_NAMES[found.kind]].join(' ') };
}

/** The kind an item's icon shows (geometryOf's). */
export function geometryKind(d: BrepData, kind: 'face' | 'edge' | 'curve', id: number): GeometryKind | undefined {
  return geometryOf(d, kind, id)?.kind;
}

/** An edge's 3D curve row (none: no edge of that id, or trims in parameter space only). */
function edgeCurve(d: BrepData, id: number): number | undefined {
  const e = rowOf(d, 'edge', id);
  const c = e === undefined ? -1 : d.edge.curve[e]!;
  return c >= 0 ? c : undefined;
}

/** A free curve's row: by its curve's id, else its curve item's. */
function itemCurve(d: BrepData, id: number): number | undefined {
  const c = rowOf(d, 'curve', id);
  if (c !== undefined) return c;
  const it = rowOf(d, 'item', id);
  if (it === undefined) return undefined;
  const item = decode.item(d, it);
  return item.kind === 'curve' ? item.ref : undefined;
}

const num = (x: number) => Number(x.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
const mm = (x: number) => `${num(x)} mm`;
const deg = (r: number) => `${num(r * 180 / Math.PI)} degrees`;
const vec = (p: readonly number[]) => `(${p.map(num).join(', ')})`;
/** Distinct knots' spans: those of non-zero length. */
const spans = (knots: readonly number[]) => knots.slice(1).filter((k, i) => k > knots[i]!).length;
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** A curve row described: its kind and parameters, a wrapper's basis after it. */
export function curveText(d: BrepData, row: number, depth = 0): string {
  const c = decode.curve(d, row);
  const inner = (r: number) => (depth < 8 ? curveText(d, r, depth + 1) : 'a curve');
  switch (c.kind) {
    case 'line': return `line, direction ${vec(c.direction)}`;
    case 'circle': return `circle, radius ${mm(c.radius)}, centre ${vec(c.position.origin)}, axis ${
      vec(c.position.axis ?? [0, 0, 1])}`;
    case 'ellipse': return `ellipse, semi-axes ${mm(c.semiAxis1)} and ${mm(c.semiAxis2)}, centre ${
      vec(c.position.origin)}`;
    case 'hyperbola': return `hyperbola, semi-axis ${mm(c.semiAxis)}, imaginary semi-axis ${mm(c.semiImagAxis)}`;
    case 'parabola': return `parabola, focal distance ${mm(c.focalDist)}`;
    case 'bspline': return `${c.weights ? 'rational ' : ''}B-spline, degree ${c.degree}, ${
      plural(c.poles.length, 'control point')}, ${plural(spans(c.knots), 'knot span')}${
      c.closed === true ? ', closed' : ''}`;
    case 'polyline': return `polyline of ${plural(c.points.length, 'point')}`;
    case 'trimmed': return `trimmed ${inner(c.basis)}`;
    case 'composite': return `composite of ${plural(c.segments.length, 'segment')}`;
    case 'offset': return `offset by ${mm(c.distance)} from ${inner(c.basis)}`;
  }
}

/** A surface row described, likewise. */
export function surfaceText(d: BrepData, row: number, depth = 0): string {
  const s = decode.surface(d, row);
  const inner = (r: number) => (depth < 8 ? surfaceText(d, r, depth + 1) : 'a surface');
  const axis = (p: { origin: number[]; axis?: number[] }) => `axis ${vec(p.axis ?? [0, 0, 1])} through ${
    vec(p.origin)}`;
  switch (s.kind) {
    case 'plane': return `plane, normal ${vec(s.position.axis ?? [0, 0, 1])} through ${vec(s.position.origin)}`;
    case 'cylinder': return `cylinder, radius ${mm(s.radius)}, ${axis(s.position)}`;
    case 'cone': return `cone, half-angle ${deg(s.semiAngle)}, radius ${mm(s.radius)} at its placement, ${
      axis(s.position)}`;
    case 'sphere': return `sphere, radius ${mm(s.radius)}, centre ${vec(s.position.origin)}`;
    case 'torus': return `torus, major radius ${mm(s.majorRadius)}, minor radius ${mm(s.minorRadius)}, ${
      axis(s.position)}`;
    case 'bspline': return `${s.weights ? 'rational ' : ''}B-spline, degree ${s.uDegree} x ${s.vDegree}, ${
      num(s.poles.length)} x ${num(s.poles[0]?.length ?? 0)} control points, ${num(spans(s.uKnots))} x ${
      num(spans(s.vKnots))} knot spans${s.uClosed === true || s.vClosed === true ? `, closed in ${
      [s.uClosed === true ? 'u' : '', s.vClosed === true ? 'v' : ''].filter(Boolean).join(' and ')}` : ''}`;
    case 'extrusion': return `extrusion along ${vec(s.direction)} of a ${curveText(d, s.curve)}`;
    case 'revolution': return `revolution about the axis ${vec(s.axisDirection)} through ${vec(s.axisOrigin)} of a ${
      curveText(d, s.curve)}`;
    case 'offset': return `offset by ${mm(s.distance)} from a ${inner(s.basis)}`;
    case 'rectangularTrimmed': return `trimmed ${inner(s.basis)}`;
    case 'curveSwept': return `swept ${curveText(d, s.curve)} along a ${curveText(d, s.directrix)}`;
    case 'fixedReferenceSwept': return `swept ${curveText(d, s.curve)} along a ${curveText(d, s.directrix)}`;
  }
}

/** What Details says of a face's, edge's or free curve's geometry, by its id; undefined where the model has none. */
export function geometryText(d: BrepData, kind: 'face' | 'edge' | 'curve', id: number): string | undefined {
  if (kind === 'face') {
    const f = rowOf(d, 'face', id);
    return f === undefined ? undefined : `Surface: ${surfaceText(d, d.face.surface[f]!)}`;
  }
  if (kind === 'edge' && rowOf(d, 'edge', id) !== undefined && edgeCurve(d, id) === undefined) {
    return 'Curve: none in 3D (trimmed in parameter space only)';
  }
  const c = kind === 'edge' ? edgeCurve(d, id) : itemCurve(d, id);
  return c === undefined ? undefined : `Curve: ${curveText(d, c)}`;
}

/** The edges a face's edge loops run through, by id; none for an unknown face or one without edge loops. */
export function faceEdges(d: BrepData, id: number): number[] {
  const f = rowOf(d, 'face', id);
  const edges = new Set<number>();
  if (f === undefined) return [];
  const first = d.face.firstLoop[f]!;
  for (let l = first; l < first + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
    for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
      const e = d.edge.id[d.coedge.edge[c]!]!;
      if (e) edges.add(e);
    }
  }
  return [...edges];
}

/** A vertex's point in its part's frame (mm), by its id. */
export function vertexPoint(d: BrepData, id: number): [number, number, number] | undefined {
  const v = rowOf(d, 'vertex', id);
  if (v === undefined) return undefined;
  const p = d.vertex.point;
  return [p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!];
}

/** A point as Details writes it. */
export const pointText = (p: readonly number[]): string => vec(p);

/** A part's volume (mm^3): each solid's outer shell less its voids, with the error the measures carry. */
export interface Volume { volume: number; error: number }

/** Each solid's shells, its outer first: rows of the shell table. */
function solids(d: BrepData): number[][] {
  const out: number[][] = [];
  for (let b = 0; b < rowCount(d, 'body'); b++) {
    if (d.body.kind[b] !== BODY_KIND.solid) continue;
    const first = d.body.first[b]!, n = d.body.count[b]!;
    out.push(Array.from({ length: n }, (_, i) => d.member.ref[first + i]!));
  }
  return out.filter((s) => s.length);
}

/**
 * The volume of a part's solids as the analysis measured their shells (the oracle's signed volumes: each shell's
 * magnitude, the outer's less its voids'); undefined without solids, or where any shell of them wasn't measured.
 */
export function oracleVolume(d: BrepData, a: BrepAnalysis | undefined): Volume | undefined {
  const all = solids(d);
  if (!all.length || !a || a.shell.volume.length < 2 * rowCount(d, 'shell')) return undefined;
  let volume = 0, error = 0;
  for (const shells of all) {
    for (const [i, s] of shells.entries()) {
      const v = a.shell.volume[2 * s]!, e = a.shell.volume[2 * s + 1]!;
      if (!Number.isFinite(v)) return undefined;
      volume += i === 0 ? Math.abs(v) : -Math.abs(v);
      error += Number.isFinite(e) ? Math.abs(e) : 0;
    }
  }
  return { volume, error };
}

/**
 * The volume of a part's solids by its mesh: each shell's faces' triangles (found by their ids in the mesh's face
 * ranges), the signed volume they enclose, magnitudes combined as the oracle's are; undefined without solids, or
 * where a shell's face has no triangles.
 */
export function meshVolume(d: BrepData, mesh: Mesh): number | undefined {
  const all = solids(d);
  if (!all.length) return undefined;
  const ranges = new Map<number, { start: number; count: number }[]>();
  for (const f of mesh.faces) if (f.source !== null) ranges.set(f.source, [...ranges.get(f.source) ?? [], f]);
  const p = mesh.positions, ix = mesh.indices, [ox, oy, oz] = mesh.origin;
  const shellVolume = (s: number): number | undefined => {
    let v = 0;
    const first = d.shell.first[s]!, n = d.shell.count[s]!;
    for (let k = 0; k < n; k++) {
      const face = d.faceUse.face[first + k]!, rs = ranges.get(d.face.id[face]!);
      if (!rs?.length) return undefined;
      for (const r of rs) for (let t = r.start; t + 2 < r.start + r.count; t += 3) {
        const [i, j, l] = [3 * ix[t]!, 3 * ix[t + 1]!, 3 * ix[t + 2]!];
        const ax = p[i]! + ox, ay = p[i + 1]! + oy, az = p[i + 2]! + oz;
        const bx = p[j]! + ox, by = p[j + 1]! + oy, bz = p[j + 2]! + oz;
        const cx = p[l]! + ox, cy = p[l + 1]! + oy, cz = p[l + 2]! + oz;
        v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
    }
    return v;
  };
  let volume = 0;
  for (const shells of all) {
    for (const [i, s] of shells.entries()) {
      const v = shellVolume(s);
      if (v === undefined) return undefined;
      volume += i === 0 ? Math.abs(v) : -Math.abs(v);
    }
  }
  return volume;
}
