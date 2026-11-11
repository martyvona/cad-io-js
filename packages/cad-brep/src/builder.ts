// BrepBuilder: what importers write a part's B-rep with, a row at a time (each add returns the row's index), packed
// into one buffer by `finish`. It checks what would make the buffer unreadable (references forward or out of range,
// wrong dimensions, missing values) and throws, those being its caller's bugs; values a source can get wrong (radii,
// knots, unit directions, closed loops) are validateBrep's.

import { BYTES, COLUMNS, type BrepData, HEADER_BYTES, openBrep } from './data.ts';
import {
  BODY_KIND, BOUND, CURVE_FORMS, CURVE_KIND, EDGE_FLAGS, ITEM_KIND, LOGICAL, LOOP_KIND, MAGIC, ORIENTATION,
  SHELL_KIND, SURFACE_FORMS, SURFACE_KIND, TRANSITIONS, TRIM_PREFERENCES, type ColumnType, type TableName,
} from './layout.ts';
import type { Body, Curve, Edge, Face, Item, Logical, PartInfo, Placement, Point, Shell, Surface, Vertex } from
  './types.ts';

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('cad-brep needs a little-endian platform');

type Typed = Uint8Array | Int32Array | Float64Array;
const CTORS: Record<ColumnType, new (n: number) => Typed> = { u8: Uint8Array, i32: Int32Array, f64: Float64Array };

/** A typed array that grows by doubling. */
class Growable {
  readonly type: ColumnType;
  a: Typed;
  n = 0;
  constructor(type: ColumnType) {
    this.type = type;
    this.a = new CTORS[type](64);
  }
  private room(k: number) {
    if (this.n + k <= this.a.length) return;
    const b = new CTORS[this.type](Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push(x: number) { this.room(1); this.a[this.n++] = x; }
  pushAll(xs: ArrayLike<number>) {
    this.room(xs.length);
    for (let i = 0; i < xs.length; i++) this.a[this.n++] = xs[i]!;
  }
}

const logical = (x: Logical) => x === null ? LOGICAL.unknown : x ? LOGICAL.true : LOGICAL.false;
const bool = (x: boolean) => x ? 1 : 0;
const opt = (x: number | undefined) => x ?? NaN;
const ref = (x: number | undefined) => x ?? -1;

export class BrepBuilder {
  private readonly cols = new Map<string, Growable>(
    COLUMNS.map((c) => [`${c.table}.${c.column}`, new Growable(c.type)]));
  private readonly counts: Record<TableName, number> = {
    part: 0, pool: 0, curve: 0, surface: 0, vertex: 0, edge: 0, coedge: 0, loop: 0, face: 0, shell: 0, body: 0,
    faceUse: 0, member: 0, item: 0,
  };
  /** Each curve's dimension, for the checks. */
  private readonly dims: number[] = [];
  /** The pools the row being added writes to (its table's). */
  private real: Growable;
  private int: Growable;

  constructor(part: PartInfo) {
    this.real = this.col('pool', 'curveReal');
    this.int = this.col('pool', 'curveInt');
    this.row('part', { unit: part.unit, uncertainty: opt(part.uncertainty) });
  }

  private pools(real: string, int = 'curveInt') {
    this.real = this.col('pool', real);
    this.int = this.col('pool', int);
  }

  private col(table: TableName, column: string): Growable { return this.cols.get(`${table}.${column}`)!; }

  /** One row; every column of the table must be given (a number, or `width` numbers). */
  private row(table: TableName, values: Record<string, number | readonly number[]>): number {
    for (const c of COLUMNS) {
      if (c.table !== table) continue;
      const v = values[c.column];
      if (v === undefined) throw new Error(`${table}.${c.column} not given`);
      if (typeof v === 'number') this.col(table, c.column).push(v);
      else this.col(table, c.column).pushAll(v);
    }
    return this.counts[table]++;
  }

  private check(table: TableName, i: number | undefined, what: string) {
    if (i === undefined) return;
    if (!Number.isInteger(i) || i < 0 || i >= this.counts[table]) {
      throw new RangeError(`${what}: ${table} ${i} not added yet (${this.counts[table]} so far)`);
    }
  }

  private curveRef(i: number, dim: number | undefined, what: string): number {
    this.check('curve', i, what);
    const d = this.dims[i]!;
    if (dim !== undefined && d !== dim) throw new RangeError(`${what}: curve ${i} is ${d}D, not ${dim}D`);
    return d;
  }

  private points(ps: readonly Point[], dim: number, what: string) {
    for (const p of ps) {
      if (p.length !== dim) throw new RangeError(`${what}: a point of ${p.length} numbers, not ${dim}`);
      this.real.pushAll(p);
    }
  }

  private placement(p: Placement, what: string): number {
    const dim = p.origin.length;
    if (dim !== 2 && dim !== 3) throw new RangeError(`${what}: a placement of ${dim} dimensions`);
    if (dim === 3 && !p.axis) throw new RangeError(`${what}: a 3D placement without an axis`);
    if (dim === 2 && p.axis) throw new RangeError(`${what}: a 2D placement with an axis`);
    this.points(dim === 3 ? [p.origin, p.axis!, p.xDir] : [p.origin, p.xDir], dim, what);
    return dim;
  }

  private trimPoint(t: Point | undefined, dim: number, what: string) {
    if (t) this.points([t], dim, what);
    else for (let k = 0; k < dim; k++) this.real.push(NaN);
  }

  addCurve(c: Curve): number {
    const what = `curve ${this.counts.curve} (${c.kind})`;
    this.pools('curveReal', 'curveInt');
    const real = this.real.n, int = this.int.n;
    let dim: number;
    switch (c.kind) {
      case 'line':
        dim = c.point.length;
        this.points([c.point, c.direction], dim, what);
        this.real.push(c.magnitude);
        break;
      case 'circle': dim = this.placement(c.position, what); this.real.push(c.radius); break;
      case 'ellipse': dim = this.placement(c.position, what); this.real.pushAll([c.semiAxis1, c.semiAxis2]); break;
      case 'hyperbola': dim = this.placement(c.position, what); this.real.pushAll([c.semiAxis, c.semiImagAxis]); break;
      case 'parabola': dim = this.placement(c.position, what); this.real.push(c.focalDist); break;
      case 'bspline': {
        if (!c.poles.length) throw new RangeError(`${what}: no poles`);
        if (c.knots.length !== c.multiplicities.length) {
          throw new RangeError(`${what}: knots and multiplicities differ`);
        }
        if (c.weights && c.weights.length !== c.poles.length) throw new RangeError(`${what}: weights and poles differ`);
        dim = c.poles[0]!.length;
        this.int.pushAll([c.degree, c.poles.length, c.knots.length, c.weights ? 1 : 0, logical(c.closed),
          logical(c.selfIntersect), CURVE_FORMS.indexOf(c.form), ...c.multiplicities]);
        this.real.pushAll(c.knots);
        this.points(c.poles, dim, what);
        if (c.weights) this.real.pushAll(c.weights);
        break;
      }
      case 'polyline':
        if (!c.points.length) throw new RangeError(`${what}: no points`);
        dim = c.points[0]!.length;
        this.int.push(c.points.length);
        this.points(c.points, dim, what);
        break;
      case 'trimmed':
        dim = this.curveRef(c.basis, undefined, what);
        this.real.pushAll([opt(c.trim1.parameter), opt(c.trim2.parameter)]);
        this.trimPoint(c.trim1.point, dim, what);
        this.trimPoint(c.trim2.point, dim, what);
        this.int.pushAll([c.basis, bool(c.sense), TRIM_PREFERENCES.indexOf(c.preference)]);
        break;
      case 'composite':
        if (!c.segments.length) throw new RangeError(`${what}: no segments`);
        dim = this.curveRef(c.segments[0]!.curve, undefined, what);
        this.int.pushAll([c.segments.length, logical(c.selfIntersect)]);
        for (const s of c.segments) {
          this.curveRef(s.curve, dim, what);
          this.int.pushAll([s.curve, bool(s.sameSense), TRANSITIONS.indexOf(s.transition)]);
        }
        break;
      case 'offset':
        dim = this.curveRef(c.basis, undefined, what);
        if ((dim === 3) !== (c.refDirection !== undefined)) {
          throw new RangeError(`${what}: a reference direction is for 3D offsets only, and needed there`);
        }
        this.real.push(c.distance);
        if (c.refDirection) this.points([c.refDirection], 3, what);
        this.int.pushAll([c.basis, logical(c.selfIntersect)]);
        break;
      default: throw new RangeError(`${what}: unknown kind`);
    }
    if (dim !== 2 && dim !== 3) throw new RangeError(`${what}: ${dim} dimensions`);
    this.dims.push(dim);
    return this.row('curve', { kind: CURVE_KIND[c.kind], dim, real, int, id: opt(c.id) });
  }

  private surfaceRef(i: number, what: string) { this.check('surface', i, what); }

  addSurface(s: Surface): number {
    const what = `surface ${this.counts.surface} (${s.kind})`;
    this.pools('surfaceReal', 'surfaceInt');
    const real = this.real.n, int = this.int.n;
    const place = (p: Placement) => {
      if (this.placement(p, what) !== 3) throw new RangeError(`${what}: a 2D placement`);
    };
    switch (s.kind) {
      case 'plane': place(s.position); break;
      case 'cylinder': case 'sphere': place(s.position); this.real.push(s.radius); break;
      case 'cone': place(s.position); this.real.pushAll([s.radius, s.semiAngle]); break;
      case 'torus':
        place(s.position);
        this.real.pushAll([s.majorRadius, s.minorRadius]);
        this.int.pushAll([s.selectOuter === undefined ? 0 : 1, s.selectOuter ? 1 : 0]);
        break;
      case 'bspline': {
        const nu = s.poles.length, nv = s.poles[0]?.length ?? 0;
        if (!nu || !nv) throw new RangeError(`${what}: no poles`);
        if (s.poles.some((r) => r.length !== nv)) throw new RangeError(`${what}: pole rows of different lengths`);
        if (s.uKnots.length !== s.uMultiplicities.length || s.vKnots.length !== s.vMultiplicities.length) {
          throw new RangeError(`${what}: knots and multiplicities differ`);
        }
        if (s.weights && (s.weights.length !== nu || s.weights.some((r) => r.length !== nv))) {
          throw new RangeError(`${what}: weights and poles differ`);
        }
        this.int.pushAll([s.uDegree, s.vDegree, nu, nv, s.uKnots.length, s.vKnots.length, s.weights ? 1 : 0,
          logical(s.uClosed), logical(s.vClosed), logical(s.selfIntersect), SURFACE_FORMS.indexOf(s.form),
          ...s.uMultiplicities, ...s.vMultiplicities]);
        this.real.pushAll(s.uKnots);
        this.real.pushAll(s.vKnots);
        for (const r of s.poles) this.points(r, 3, what);
        if (s.weights) for (const r of s.weights) this.real.pushAll(r);
        break;
      }
      case 'extrusion':
        this.curveRef(s.curve, 3, what);
        this.points([s.direction], 3, what);
        this.real.push(s.magnitude);
        this.int.push(s.curve);
        break;
      case 'revolution':
        this.curveRef(s.curve, 3, what);
        this.points([s.axisOrigin, s.axisDirection], 3, what);
        this.int.push(s.curve);
        break;
      case 'offset':
        this.surfaceRef(s.basis, what);
        this.real.push(s.distance);
        this.int.pushAll([s.basis, logical(s.selfIntersect)]);
        break;
      case 'rectangularTrimmed':
        this.surfaceRef(s.basis, what);
        this.real.pushAll([s.u1, s.u2, s.v1, s.v2]);
        this.int.pushAll([s.basis, bool(s.uSense), bool(s.vSense)]);
        break;
      case 'curveSwept':
        this.curveRef(s.curve, 3, what);
        this.curveRef(s.directrix, undefined, what);
        this.surfaceRef(s.referenceSurface, what);
        this.int.pushAll([s.curve, s.directrix, s.referenceSurface]);
        break;
      case 'fixedReferenceSwept':
        this.curveRef(s.curve, 3, what);
        this.curveRef(s.directrix, 3, what);
        this.points([s.fixedReference], 3, what);
        this.int.pushAll([s.curve, s.directrix]);
        break;
      default: throw new RangeError(`${what}: unknown kind`);
    }
    return this.row('surface', { kind: SURFACE_KIND[s.kind], real, int, id: opt(s.id) });
  }

  addVertex(v: Vertex): number {
    if (v.point.length !== 3) throw new RangeError(`vertex ${this.counts.vertex}: a point of ${v.point.length}`);
    return this.row('vertex', { point: v.point, tolerance: opt(v.tolerance), id: opt(v.id) });
  }

  addEdge(e: Edge): number {
    const what = `edge ${this.counts.edge}`;
    if (e.curve !== undefined) this.curveRef(e.curve, 3, what);
    this.check('vertex', e.start, what);
    this.check('vertex', e.end, what);
    return this.row('edge', { curve: ref(e.curve), start: ref(e.start), end: ref(e.end), sameSense: bool(e.sameSense),
      flags: e.degenerate ? EDGE_FLAGS.degenerate : 0, range: e.range ?? [NaN, NaN], tolerance: opt(e.tolerance),
      id: opt(e.id) });
  }

  /** A face, its loops and their coedges. */
  addFace(f: Face): number {
    const what = `face ${this.counts.face}`;
    this.pools('itemReal', 'loopInt');
    this.surfaceRef(f.surface, what);
    const firstLoop = this.counts.loop;
    for (const l of f.loops) {
      let first: number, count: number;
      if (l.kind === 'edge') {
        first = this.counts.coedge;
        count = l.coedges.length;
        for (const c of l.coedges) {
          this.check('edge', c.edge, what);
          if (c.pcurve !== undefined) this.curveRef(c.pcurve, 2, `${what}, a p-curve`);
          this.row('coedge', { edge: c.edge, orientation: ORIENTATION[c.orientation], pcurve: ref(c.pcurve),
            range: c.range ?? [NaN, NaN], id: opt(c.id) });
        }
      } else if (l.kind === 'vertex') {
        this.check('vertex', l.vertex, what);
        first = l.vertex;
        count = 1;
      } else {
        for (const v of l.vertices) this.check('vertex', v, what);
        first = this.int.n;
        count = l.vertices.length;
        this.int.pushAll(l.vertices);
      }
      this.row('loop', { kind: LOOP_KIND[l.kind], bound: BOUND[l.bound], sense: bool(l.sense), first, count,
        id: opt(l.id) });
    }
    return this.row('face', { surface: f.surface, sameSense: bool(f.sameSense), firstLoop, loopCount: f.loops.length,
      tolerance: opt(f.tolerance), id: opt(f.id) });
  }

  addShell(s: Shell): number {
    const first = this.counts.faceUse;
    for (const u of s.faces) {
      this.check('face', u.face, `shell ${this.counts.shell}`);
      this.row('faceUse', { face: u.face, sense: bool(u.sense) });
    }
    return this.row('shell', { kind: SHELL_KIND[s.kind], first, count: s.faces.length, id: opt(s.id) });
  }

  addBody(b: Body): number {
    const first = this.counts.member;
    for (const m of b.members) {
      this.check(b.kind === 'wire' ? 'edge' : 'shell', m.ref, `body ${this.counts.body}`);
      this.row('member', { ref: m.ref, sense: bool(m.sense) });
    }
    return this.row('body', { kind: BODY_KIND[b.kind], first, count: b.members.length, id: opt(b.id) });
  }

  addItem(it: Item): number {
    const what = `item ${this.counts.item} (${it.kind})`;
    this.pools('itemReal');
    let target: number;
    if (it.kind === 'point') {
      target = this.real.n;
      this.points([it.point], 3, what);
    } else {
      target = it.ref;
      this.check(it.kind === 'instance' ? 'item' : it.kind, it.ref, what);
      if (it.kind === 'curve') this.curveRef(it.ref, 3, what);
    }
    let transform = -1;
    if (it.transform) {
      if (it.transform.length !== 12) throw new RangeError(`${what}: a transform of ${it.transform.length} numbers`);
      transform = this.real.n;
      this.real.pushAll(it.transform);
    }
    return this.row('item', { kind: ITEM_KIND[it.kind], ref: target, transform, id: opt(it.id) });
  }

  /** The buffer, deterministic: the same rows give the same bytes. The builder can go on after it. */
  finish(): BrepData {
    const align = (n: number) => (n + 7) & ~7;
    let size = HEADER_BYTES;
    const placed = COLUMNS.map((c) => {
      const g = this.col(c.table, c.column), offset = size;
      size = align(size + g.n * BYTES[c.type]);
      return { g, offset };
    });
    const buffer = new ArrayBuffer(size);
    const bytes = new Uint8Array(buffer), head = new DataView(buffer);
    for (let k = 0; k < 4; k++) bytes[k] = MAGIC.charCodeAt(k);
    head.setUint32(4, COLUMNS.length, true);
    placed.forEach(({ g, offset }, k) => {
      head.setUint32(8 + 8 * k, offset, true);
      head.setUint32(12 + 8 * k, g.n, true);
      new (g.a.constructor as new (b: ArrayBuffer, o: number, n: number) => Typed)(buffer, offset, g.n)
        .set(g.a.subarray(0, g.n));
    });
    return openBrep(buffer);
  }
}
