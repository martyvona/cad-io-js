// Rows of a BrepData as plain objects (types.ts), equal to what the builder was given: for convenience, tests and
// JSON. They allocate; code walking large models reads the columns directly (layout.ts). They assume a valid buffer
// (validateBrep): on an invalid one they return garbage rather than throw.

import type { BrepData } from './data.ts';
import {
  BODY_KIND, BOUND, CURVE_FORMS, CURVE_KIND, EDGE_FLAGS, ITEM_KIND, LOGICAL, LOOP_KIND, ORIENTATION, SHELL_KIND,
  SURFACE_FORMS, SURFACE_KIND, TRANSITIONS, TRIM_PREFERENCES,
} from './layout.ts';
import type {
  Body, Bound, BodyKind, Coedge, Curve, Edge, Face, Item, Logical, Loop, Orientation, PartInfo, Placement, Point,
  Shell, ShellKind, Surface, Vertex,
} from './types.ts';

/** The name for a kind's number in one of layout.ts's tables. */
export function nameOf<K extends string>(table: Record<K, number>, n: number): K | undefined {
  for (const k in table) if (table[k] === n) return k;
  return undefined;
}

const logical = (x: number): Logical => x === LOGICAL.unknown ? null : x === LOGICAL.true;
/** Optional fields: present only when the buffer has a value. */
const id = (x: number) => x === 0 ? {} : { id: x };

/** Reads the pools from an offset on. */
class Cursor {
  private readonly real_: Float64Array;
  private readonly int_: Int32Array;
  r: number;
  i: number;
  constructor(real: Float64Array, r: number, int: Int32Array = new Int32Array(), i = -1) {
    this.real_ = real;
    this.int_ = int;
    this.r = r;
    this.i = i;
  }
  real() { return this.real_[this.r++]!; }
  reals(n: number) { const a = Array.from(this.real_.subarray(this.r, this.r + n)); this.r += n; return a; }
  points(n: number, dim: number): Point[] { return Array.from({ length: n }, () => this.reals(dim)); }
  int() { return this.int_[this.i++]!; }
  ints(n: number) { const a = Array.from(this.int_.subarray(this.i, this.i + n)); this.i += n; return a; }
  placement(dim: number): Placement {
    return dim === 3 ? { origin: this.reals(3), axis: this.reals(3), xDir: this.reals(3) }
      : { origin: this.reals(2), xDir: this.reals(2) };
  }
}

export function part(d: BrepData): PartInfo {
  const u = d.part.uncertainty[0]!;
  return Number.isNaN(u) ? {} : { uncertainty: u };
}

export function curve(d: BrepData, k: number): Curve {
  const dim = d.curve.dim[k]!, c = new Cursor(d.pool.curveReal, d.curve.real[k]!, d.pool.curveInt, d.curve.int[k]!);
  const kind = nameOf(CURVE_KIND, d.curve.kind[k]!);
  const base = id(d.curve.id[k]!);
  switch (kind) {
    case 'line': return { kind, point: c.reals(dim), direction: c.reals(dim), magnitude: c.real(), ...base };
    case 'circle': return { kind, position: c.placement(dim), radius: c.real(), ...base };
    case 'ellipse': return { kind, position: c.placement(dim), semiAxis1: c.real(), semiAxis2: c.real(), ...base };
    case 'hyperbola': return { kind, position: c.placement(dim), semiAxis: c.real(), semiImagAxis: c.real(), ...base };
    case 'parabola': return { kind, position: c.placement(dim), focalDist: c.real(), ...base };
    case 'bspline': {
      const [degree, n, nk, rational, closed, selfIntersect, form] = c.ints(7) as number[];
      const multiplicities = c.ints(nk!), knots = c.reals(nk!), poles = c.points(n!, dim);
      return { kind, degree: degree!, knots, multiplicities, poles, ...(rational ? { weights: c.reals(n!) } : {}),
        closed: logical(closed!), selfIntersect: logical(selfIntersect!), form: CURVE_FORMS[form!]!, ...base };
    }
    case 'polyline': return { kind, points: c.points(c.int(), dim), ...base };
    case 'trimmed': {
      const [t1, t2] = c.reals(2), p1 = c.reals(dim), p2 = c.reals(dim);
      const trim = (t: number, p: number[]) => ({ ...(Number.isNaN(t) ? {} : { parameter: t }),
        ...(p.some(Number.isNaN) ? {} : { point: p }) });
      const [basis, sense, preference] = c.ints(3) as number[];
      return { kind, basis: basis!, trim1: trim(t1!, p1), trim2: trim(t2!, p2), sense: sense === 1,
        preference: TRIM_PREFERENCES[preference!]!, ...base };
    }
    case 'composite': {
      const [n, selfIntersect] = c.ints(2) as number[];
      const segments = Array.from({ length: n! }, () => {
        const [s, same, t] = c.ints(3) as number[];
        return { curve: s!, sameSense: same === 1, transition: TRANSITIONS[t!]! };
      });
      return { kind, segments, selfIntersect: logical(selfIntersect!), ...base };
    }
    case 'offset': {
      const distance = c.real(), refDirection = dim === 3 ? { refDirection: c.reals(3) } : {};
      const [basis, selfIntersect] = c.ints(2) as number[];
      return { kind, basis: basis!, distance, selfIntersect: logical(selfIntersect!), ...refDirection, ...base };
    }
    default: throw new RangeError(`curve ${k}: kind ${d.curve.kind[k]}`);
  }
}

export function surface(d: BrepData, k: number): Surface {
  const c = new Cursor(d.pool.surfaceReal, d.surface.real[k]!, d.pool.surfaceInt, d.surface.int[k]!);
  const kind = nameOf(SURFACE_KIND, d.surface.kind[k]!);
  const base = id(d.surface.id[k]!);
  switch (kind) {
    case 'plane': return { kind, position: c.placement(3), ...base };
    case 'cylinder': case 'sphere': return { kind, position: c.placement(3), radius: c.real(), ...base };
    case 'cone': return { kind, position: c.placement(3), radius: c.real(), semiAngle: c.real(), ...base };
    case 'torus': {
      const position = c.placement(3), majorRadius = c.real(), minorRadius = c.real();
      const [degenerate, outer] = c.ints(2);
      return { kind, position, majorRadius, minorRadius, ...(degenerate ? { selectOuter: outer === 1 } : {}),
        ...base };
    }
    case 'bspline': {
      const [uDegree, vDegree, nu, nv, ku, kv, rational, uClosed, vClosed, selfIntersect, form] = c.ints(11) as
        number[];
      const uMultiplicities = c.ints(ku!), vMultiplicities = c.ints(kv!);
      const uKnots = c.reals(ku!), vKnots = c.reals(kv!);
      const poles = Array.from({ length: nu! }, () => c.points(nv!, 3));
      const weights = rational ? { weights: Array.from({ length: nu! }, () => c.reals(nv!)) } : {};
      return { kind, uDegree: uDegree!, vDegree: vDegree!, uKnots, vKnots, uMultiplicities, vMultiplicities, poles,
        ...weights, uClosed: logical(uClosed!), vClosed: logical(vClosed!), selfIntersect: logical(selfIntersect!),
        form: SURFACE_FORMS[form!]!, ...base };
    }
    case 'extrusion': return { kind, direction: c.reals(3), magnitude: c.real(), curve: c.int(), ...base };
    case 'revolution': return { kind, axisOrigin: c.reals(3), axisDirection: c.reals(3), curve: c.int(), ...base };
    case 'offset': {
      const distance = c.real(), [basis, selfIntersect] = c.ints(2) as number[];
      return { kind, basis: basis!, distance, selfIntersect: logical(selfIntersect!), ...base };
    }
    case 'rectangularTrimmed': {
      const [u1, u2, v1, v2] = c.reals(4) as number[], [basis, uSense, vSense] = c.ints(3) as number[];
      return { kind, basis: basis!, u1: u1!, u2: u2!, v1: v1!, v2: v2!, uSense: uSense === 1, vSense: vSense === 1,
        ...base };
    }
    case 'curveSwept': {
      const [curve, directrix, referenceSurface] = c.ints(3) as number[];
      return { kind, curve: curve!, directrix: directrix!, referenceSurface: referenceSurface!, ...base };
    }
    case 'fixedReferenceSwept': {
      const fixedReference = c.reals(3), [curve, directrix] = c.ints(2) as number[];
      return { kind, curve: curve!, directrix: directrix!, fixedReference, ...base };
    }
    default: throw new RangeError(`surface ${k}: kind ${d.surface.kind[k]}`);
  }
}

const num = (x: number, key: string) => Number.isNaN(x) ? {} : { [key]: x };
const refOpt = (x: number, key: string) => x < 0 ? {} : { [key]: x };
const range = (r: Float64Array, k: number) =>
  Number.isNaN(r[2 * k]!) && Number.isNaN(r[2 * k + 1]!) ? {}
    : { range: [r[2 * k]!, r[2 * k + 1]!] as [number, number] };

export function vertex(d: BrepData, k: number): Vertex {
  return { point: Array.from(d.vertex.point.subarray(3 * k, 3 * k + 3)), ...num(d.vertex.tolerance[k]!, 'tolerance'),
    ...id(d.vertex.id[k]!) };
}

export function edge(d: BrepData, k: number): Edge {
  const e = d.edge;
  return { ...refOpt(e.curve[k]!, 'curve'), ...refOpt(e.start[k]!, 'start'), ...refOpt(e.end[k]!, 'end'),
    sameSense: e.sameSense[k] === 1, ...(e.flags[k]! & EDGE_FLAGS.degenerate ? { degenerate: true } : {}),
    ...range(e.range, k), ...num(e.tolerance[k]!, 'tolerance'), ...id(e.id[k]!) };
}

export function coedge(d: BrepData, k: number): Coedge {
  const c = d.coedge;
  return { edge: c.edge[k]!, orientation: nameOf(ORIENTATION, c.orientation[k]!) as Orientation,
    ...refOpt(c.pcurve[k]!, 'pcurve'), ...range(c.range, k), ...id(c.id[k]!) };
}

export function loop(d: BrepData, k: number): Loop {
  const l = d.loop, first = l.first[k]!, count = l.count[k]!;
  const base = { bound: nameOf(BOUND, l.bound[k]!) as Bound, sense: l.sense[k] === 1, ...id(l.id[k]!) };
  switch (nameOf(LOOP_KIND, l.kind[k]!)) {
    case 'edge': return { kind: 'edge', coedges: Array.from({ length: count }, (_, j) => coedge(d, first + j)),
      ...base };
    case 'vertex': return { kind: 'vertex', vertex: first, ...base };
    case 'poly': return { kind: 'poly', vertices: Array.from(d.pool.loopInt.subarray(first, first + count)), ...base };
    default: throw new RangeError(`loop ${k}: kind ${l.kind[k]}`);
  }
}

export function face(d: BrepData, k: number): Face {
  const f = d.face, first = f.firstLoop[k]!;
  return { surface: f.surface[k]!, sameSense: f.sameSense[k] === 1,
    loops: Array.from({ length: f.loopCount[k]! }, (_, j) => loop(d, first + j)), ...num(f.tolerance[k]!, 'tolerance'),
    ...id(f.id[k]!) };
}

export function shell(d: BrepData, k: number): Shell {
  const first = d.shell.first[k]!;
  return { kind: nameOf(SHELL_KIND, d.shell.kind[k]!) as ShellKind, faces: Array.from({ length: d.shell.count[k]! },
    (_, j) => ({ face: d.faceUse.face[first + j]!, sense: d.faceUse.sense[first + j] === 1 })), ...id(d.shell.id[k]!) };
}

export function body(d: BrepData, k: number): Body {
  const first = d.body.first[k]!;
  return { kind: nameOf(BODY_KIND, d.body.kind[k]!) as BodyKind, members: Array.from({ length: d.body.count[k]! },
    (_, j) => ({ ref: d.member.ref[first + j]!, sense: d.member.sense[first + j] === 1 })), ...id(d.body.id[k]!) };
}

export function item(d: BrepData, k: number): Item {
  const it = d.item, t = it.transform[k]!, kind = nameOf(ITEM_KIND, it.kind[k]!);
  const transform = t < 0 ? {} : { transform: Array.from(d.pool.itemReal.subarray(t, t + 12)) };
  if (kind === 'point') {
    return { kind, point: new Cursor(d.pool.itemReal, it.ref[k]!).reals(3), ...transform, ...id(it.id[k]!) };
  }
  if (!kind) throw new RangeError(`item ${k}: kind ${it.kind[k]}`);
  return { kind, ref: it.ref[k]!, ...transform, ...id(it.id[k]!) };
}
