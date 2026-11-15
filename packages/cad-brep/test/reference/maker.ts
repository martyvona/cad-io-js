// The reference shapes' builder: a shape is written once in its own frame, and the Maker writes its rows at a
// similarity T (docs/brep-reference.md, "Transforms": each curve keeps its parameter, each surface its (u, v) up to a
// factor per coordinate, a mirror turning loops and some faces' senses), together with the facts the shape states in
// its own frame, mapped by T and the parameter maps. The facts come from the shapes' closed forms, never from
// evaluating the rows; the rows are written by this file, not by the builder's baking (bake.ts), so a check of the
// facts against the evaluators of the rows checks this file's mapping too.

import { BrepBuilder } from '../../src/builder.ts';
import type { BrepData } from '../../src/data.ts';
import type { Body, Coedge, Curve, Edge, Loop, Placement, Shell, Surface } from '../../src/types.ts';
import {
  apply, clean, cross, det, linear, mul, norm, rotate, type Similarity, unit, type V,
} from './vec.ts';

/** A curve's point and derivatives at t, in the shape's frame. */
export type CurveEval = (t: number) => { p: V; d1: V; d2: V };
/** A surface's point and partials at (u, v), in the shape's frame. */
export type SurfaceEval = (u: number, v: number) => { p: V; du: V; dv: V; duu: V; duv: V; dvv: V };

export type Certainty = 'unique' | 'ambiguous' | 'none';

/** A fact as the fixtures hold it (the row filled in at the end, from the id). */
export type Fact = { kind: string; id: number; tol: number; abs: number } & Record<string, unknown>;

/** The relative tolerance of every fact: the closed forms are exact to rounding. */
export const TOL = 1e-12;

/** How a surface's (u, v) maps under T: u' = fu u, v' = fv v; sigma -1 where its normal turns against T's image. */
export interface SurfaceMap {
  fu: number;
  fv: number;
  sigma: number;
}

/** A surface row the Maker wrote: its row, its id, its map and periods (of the built parameters). */
export interface SurfaceRef {
  row: number;
  id: number;
  map: SurfaceMap;
  uPeriod?: number;
  vPeriod?: number;
}

/** A coedge in the shape's frame; its p-curve given as a 2D curve in the face's surface's local (u, v). */
export interface LocalCoedge extends Omit<Coedge, 'pcurve'> {
  pcurve?: number;
}

export type LocalLoop = Omit<Loop, 'coedges'> & { coedges?: LocalCoedge[] };

const wrap = (x: number, period: number | undefined) => {
  if (!period) return x;
  const r = x - period * Math.floor(x / period);
  return r >= period ? 0 : r + 0;
};

export class Maker {
  readonly b: BrepBuilder;
  readonly T: Similarity;
  readonly det: number;
  readonly facts: Fact[] = [];
  /** The tolerance floor for lengths: TOL times the shape's size after T (set by the shape). */
  size = 1;
  private nextId = 1;
  /** Each 2D curve row's map (the surface map it was written for), for its facts. */
  private readonly pcurveMaps = new Map<number, SurfaceMap>();
  private readonly curveIds: number[] = [];

  constructor(T: Similarity, uncertainty?: number) {
    this.T = T;
    this.det = Math.sign(det(T));
    this.b = new BrepBuilder(uncertainty === undefined ? {} : { uncertainty: uncertainty * T.s });
  }

  id(): number { return this.nextId++; }

  /** The absolute floor for a quantity of length dimension `power` (1 lengths, points; 2 areas; 3 volumes). */
  abs(power = 1): number { return TOL * (this.size * this.T.s) ** power; }

  private placement3(p: Placement, surface: boolean): Placement {
    // Curves and surfaces alike: z' = det Q z, so y' = z' x x' = Q y and every in-plane formula keeps its parameter.
    void surface;
    return { origin: clean(apply(this.T, p.origin)), axis: clean(mul(rotate(this.T, p.axis!), this.det)),
      xDir: clean(rotate(this.T, p.xDir)) };
  }

  /** A 3D curve given in the shape's frame, written at T; its evaluator `ev` for the facts. Returns its row. */
  curve(c: Curve): number {
    const T = this.T, s = T.s;
    let m: Curve;
    switch (c.kind) {
      case 'line': m = { kind: 'line', point: clean(apply(T, c.point)), direction: clean(rotate(T, c.direction)),
        magnitude: c.magnitude * s }; break;
      case 'circle': m = { ...c, position: this.placement3(c.position, false), radius: c.radius * s }; break;
      case 'ellipse': m = { ...c, position: this.placement3(c.position, false), semiAxis1: c.semiAxis1 * s,
        semiAxis2: c.semiAxis2 * s }; break;
      case 'hyperbola': m = { ...c, position: this.placement3(c.position, false), semiAxis: c.semiAxis * s,
        semiImagAxis: c.semiImagAxis * s }; break;
      case 'parabola': m = { ...c, position: this.placement3(c.position, false), focalDist: c.focalDist * s }; break;
      case 'bspline': m = { ...c, poles: c.poles.map((p) => clean(apply(T, p))) }; break;
      case 'polyline': m = { ...c, points: c.points.map((p) => clean(apply(T, p))) }; break;
      case 'trimmed': m = { ...c, trim1: this.trim(c.trim1), trim2: this.trim(c.trim2) }; break;
      case 'composite': m = c; break;
      case 'offset': m = { ...c, distance: c.distance * s * this.det, refDirection: clean(rotate(T, c.refDirection!)) };
        break;
    }
    const id = c.id ?? this.id();
    const row = this.b.addCurve({ ...m, id });
    this.curveIds[row] = id;
    return row;
  }

  private trim(t: { parameter?: number; point?: V }) {
    return { ...t, ...(t.point ? { point: clean(apply(this.T, t.point)) } : {}) };
  }

  /** A 2D curve in a surface's local (u, v), written in its built (u, v) by the surface's map. */
  pcurve(c: Curve, on: SurfaceRef): number {
    const { fu, fv } = on.map, f = (p: V): V => clean([p[0]! * fu, p[1]! * fv]);
    let m: Curve;
    switch (c.kind) {
      case 'line': {
        const d = [c.direction[0]! * fu, c.direction[1]! * fv], l = norm(d);
        m = { ...c, point: f(c.point), direction: clean(mul(d, 1 / l)), magnitude: c.magnitude * l };
        break;
      }
      case 'circle': {
        // Exact only where the map is uniform and keeps orientation (docs/brep-reference.md, "Transforms").
        if (Math.abs(fu) !== Math.abs(fv) || fu * fv < 0) throw new Error('a 2D circle under a non-conformal map');
        m = { ...c, position: { origin: f(c.position.origin), xDir: clean(mul(c.position.xDir, Math.sign(fu))) },
          radius: c.radius * Math.abs(fu) };
        break;
      }
      case 'bspline': m = { ...c, poles: c.poles.map(f) }; break;
      case 'polyline': m = { ...c, points: c.points.map(f) }; break;
      default: throw new Error(`no map for a 2D ${c.kind}`);
    }
    const id = c.id ?? this.id();
    const row = this.b.addCurve({ ...m, id });
    this.curveIds[row] = id;
    this.pcurveMaps.set(row, on.map);
    return row;
  }

  /** A surface given in the shape's frame, written at T. */
  surface(sf: Surface, periods: { u?: number; v?: number } = {}): SurfaceRef {
    const T = this.T, s = T.s, D = this.det;
    let m: Surface, map: SurfaceMap;
    switch (sf.kind) {
      case 'plane':
        m = { ...sf, position: this.placement3(sf.position, true) };
        map = { fu: s, fv: s, sigma: D };
        break;
      case 'cylinder':
        m = { ...sf, position: this.placement3(sf.position, true), radius: sf.radius * s };
        map = { fu: 1, fv: s * D, sigma: 1 };
        break;
      case 'cone':
        m = { ...sf, position: this.placement3(sf.position, true), radius: sf.radius * s, semiAngle: sf.semiAngle * D };
        map = { fu: 1, fv: s * D, sigma: 1 };
        break;
      case 'sphere':
        m = { ...sf, position: this.placement3(sf.position, true), radius: sf.radius * s };
        map = { fu: 1, fv: D, sigma: 1 };
        break;
      case 'torus':
        m = { ...sf, position: this.placement3(sf.position, true), majorRadius: sf.majorRadius * s,
          minorRadius: sf.minorRadius * s };
        map = { fu: 1, fv: D, sigma: 1 };
        break;
      case 'bspline':
        m = { ...sf, poles: sf.poles.map((r) => r.map((p) => clean(apply(T, p)))) };
        map = { fu: 1, fv: 1, sigma: D };
        break;
      case 'extrusion':
        m = { ...sf, direction: clean(rotate(T, sf.direction)), magnitude: sf.magnitude * s };
        map = { fu: 1, fv: 1, sigma: D };
        break;
      case 'revolution':
        m = { ...sf, axisOrigin: clean(apply(T, sf.axisOrigin)), axisDirection: clean(mul(rotate(T,
          sf.axisDirection), D)) };
        map = { fu: 1, fv: 1, sigma: D };
        break;
      case 'offset': case 'rectangularTrimmed': {
        const basis = this.surfaces.get(sf.basis);
        if (!basis) throw new Error('an offset or trim of a surface the Maker did not write');
        map = basis.map;
        if (sf.kind === 'offset') m = { ...sf, distance: sf.distance * s * basis.map.sigma };
        else {
          m = { ...sf, u1: sf.u1 * map.fu, u2: sf.u2 * map.fu, v1: sf.v1 * map.fv, v2: sf.v2 * map.fv };
        }
        break;
      }
      default: throw new Error(`no map for a ${sf.kind} surface`);
    }
    const id = sf.id ?? this.id();
    const row = this.b.addSurface({ ...m, id });
    const ref: SurfaceRef = { row, id, map, ...(periods.u ? { uPeriod: periods.u } : {}),
      ...(periods.v ? { vPeriod: periods.v } : {}) };
    this.surfaces.set(row, ref);
    return ref;
  }

  private readonly surfaces = new Map<number, SurfaceRef>();

  vertex(p: V): number { return this.b.addVertex({ point: clean(apply(this.T, p)), id: this.id() }); }

  edge(e: Omit<Edge, 'id'>): number {
    return this.b.addEdge({ ...e, ...(e.tolerance === undefined ? {} : { tolerance: e.tolerance * this.T.s }),
      id: this.id() });
  }

  /**
   * A face on a surface the Maker wrote, its loops in the shape's frame (outer counter-clockwise about the face's
   * normal); under a mirror every edge loop is run the other way round and the face's sense turned by the surface's
   * sigma, so it still faces where T takes its normal.
   */
  face(on: SurfaceRef, sameSense: boolean, loops: LocalLoop[]): number {
    const flip = this.det < 0;
    const out: Loop[] = loops.map((l): Loop => {
      if (l.kind !== 'edge') return l as Loop;
      const cs = l.coedges!.map((c): Coedge => ({ ...c, ...(c.pcurve === undefined ? {} : { pcurve: c.pcurve }) }));
      if (!flip) return { ...l, kind: 'edge', coedges: cs };
      return { ...l, kind: 'edge', coedges: cs.reverse().map((c) => ({ ...c,
        orientation: c.orientation === 'forward' ? 'reversed' : c.orientation === 'reversed' ? 'forward'
          : c.orientation })) };
    });
    return this.b.addFace({ surface: on.row, sameSense: on.map.sigma < 0 ? !sameSense : sameSense, loops: out,
      id: this.id() });
  }

  shell(s: Shell): number { return this.b.addShell(s); }
  body(bd: Omit<Body, 'id'>): number { return this.b.addBody({ ...bd, id: this.id() }); }

  /** The id of a curve row the Maker wrote. */
  curveId(row: number): number { return this.curveIds[row]!; }

  // -- Facts, given in the shape's frame.

  /** Points and derivatives of a 3D curve row at the given parameters (its own, which T keeps). */
  curvePoints(row: number, ev: CurveEval, ts: number[]) {
    for (const t of ts) {
      const r = ev(t);
      this.facts.push({ kind: 'curvePoint', id: this.curveId(row), curve: row, t, p: clean(apply(this.T, r.p)),
        d1: clean(linear(this.T, r.d1)), d2: clean(linear(this.T, r.d2)), tol: TOL, abs: this.abs() });
    }
  }

  /** The same for a 2D curve row, its local evaluator in the surface's local (u, v). */
  pcurvePoints(row: number, ev: CurveEval, ts: number[]) {
    const { fu, fv } = this.pcurveMaps.get(row)!, f = (p: V) => clean([p[0]! * fu, p[1]! * fv]);
    for (const t of ts) {
      const r = ev(t);
      this.facts.push({ kind: 'curvePoint', id: this.curveId(row), curve: row, t, p: f(r.p), d1: f(r.d1),
        d2: f(r.d2), tol: TOL, abs: TOL * Math.max(Math.abs(fu), Math.abs(fv), 1) * this.size });
    }
  }

  /** A curve's length between parameters, in the shape's frame (times s). */
  curveLength(row: number, t0: number, t1: number, length: number) {
    this.facts.push({ kind: 'curveLength', id: this.curveId(row), curve: row, t0, t1, length: length * this.T.s,
      tol: TOL, abs: this.abs() });
  }

  /** Points and partials of a surface at local (u, v)s, reported at the built (u, v). */
  surfacePoints(on: SurfaceRef, ev: SurfaceEval, uvs: [number, number][]) {
    const { fu, fv } = on.map, L = (d: V) => clean(linear(this.T, d));
    for (const [u, v] of uvs) {
      const r = ev(u, v), n = cross(r.du, r.dv), nl = norm(n);
      const scaleL = norm(r.du) * norm(r.dv);
      // The built surface's partials: d/du' = (1 / fu) d/du. Its normal: Q n times det Q and the maps' signs.
      this.facts.push({ kind: 'surfacePoint', id: on.id, surface: on.row, u: wrap(u * fu, on.uPeriod),
        v: wrap(v * fv, on.vPeriod), p: clean(apply(this.T, r.p)), du: L(mul(r.du, 1 / fu)), dv: L(mul(r.dv, 1 / fv)),
        duu: L(mul(r.duu, 1 / (fu * fu))), duv: L(mul(r.duv, 1 / (fu * fv))), dvv: L(mul(r.dvv, 1 / (fv * fv))),
        n: nl <= 1e-14 * Math.max(scaleL, 1e-300) || nl === 0 ? null
          : clean(mul(rotate(this.T, unit(n)), this.det * Math.sign(fu * fv))),
        tol: TOL, abs: this.abs() });
    }
  }

  /** A point's parameter on a 3D curve, in closed form (the curve's own parameter: T keeps it). */
  curveInverse(row: number, p: V, t: number, distance: number, certainty: Certainty, alternatives: number[] = []) {
    this.facts.push({ kind: 'curveInverse', id: this.curveId(row), curve: row, p: clean(apply(this.T, p)), t,
      distance: distance * this.T.s, certainty, alternatives, tol: TOL, abs: this.abs(), ptol: 1e-9 });
  }

  /** A point's (u, v) on a surface, given at local (u, v)s and reported at the built ones. */
  surfaceInverse(on: SurfaceRef, p: V, uv: [number, number], distance: number, certainty: Certainty,
    flags: { onSeamU?: boolean; onSeamV?: boolean; atSingularity?: boolean } = {},
    alternatives: [number, number][] = []) {
    const { fu, fv } = on.map, f = ([u, v]: [number, number]) => [wrap(u * fu, on.uPeriod), wrap(v * fv, on.vPeriod)];
    // Parameters that are lengths scale with T; ptol follows.
    const ptol = 1e-9 * Math.max(1, Math.abs(fu), Math.abs(fv)) * Math.max(1, this.size);
    this.facts.push({ kind: 'surfaceInverse', id: on.id, surface: on.row, p: clean(apply(this.T, p)), uv: f(uv),
      distance: distance * this.T.s, certainty, alternatives: alternatives.map(f), onSeamU: !!flags.onSeamU,
      onSeamV: !!flags.onSeamV, atSingularity: !!flags.atSingularity, tol: TOL, abs: this.abs(), ptol });
  }

  faceArea(face: number, area: number) {
    this.facts.push({ kind: 'faceArea', id: 0, face, area: area * this.T.s ** 2, tol: TOL, abs: this.abs(2) });
  }

  volume(body: number, volume: number) {
    this.facts.push({ kind: 'volume', id: 0, body, volume: volume * this.T.s ** 3, tol: TOL, abs: this.abs(3) });
  }

  /** The buffer, and the facts with face and body rows' ids filled in. */
  finish(): { data: BrepData; facts: Fact[] } {
    const data = this.b.finish();
    // Faces and bodies keep their rows (no transforms or instances here): their ids from the buffer.
    for (const f of this.facts) {
      if (f.kind === 'faceArea') f.id = data.face.id[f.face as number]!;
      if (f.kind === 'volume') f.id = data.body.id[f.body as number]!;
    }
    return { data, facts: this.facts };
  }
}
