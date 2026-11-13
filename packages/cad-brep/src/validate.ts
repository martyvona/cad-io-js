// validateBrep: whether a buffer keeps the format's rules (layout.ts) and Part 42's constraints on the values, as
// diagnostics, never throwing. Errors break a rule a consumer relies on (a reference out of range, a pool overrun, a
// knot vector that doesn't fit its poles, a loop whose coedges don't join); warnings are suspicious but readable
// (duplicate source ids). What needs evaluation (vertices on their curves, p-curves on their edges) isn't checked here.

import { type BrepData, rowCount } from './data.ts';
import { nameOf } from './decode.ts';
import {
  BODY_KIND, BOUND, CURVE_FORMS, CURVE_KIND, EDGE_FLAGS, ITEM_KIND, LOGICAL, LOOP_KIND, ORIENTATION, SHELL_KIND,
  SURFACE_FORMS, SURFACE_KIND, TRANSITIONS, TRIM_PREFERENCES, type TableName,
} from './layout.ts';

export interface BrepDiagnostic {
  severity: 'error' | 'warning';
  message: string;
}

/** At most this many diagnostics, then one saying how many more. */
export const MAX_DIAGNOSTICS = 1000;
/** Unit directions within this of length 1, and placements' axes within this of orthogonal (cosine). */
export const UNIT_TOLERANCE = 1e-9;

export function validateBrep(d: BrepData): BrepDiagnostic[] {
  const out: BrepDiagnostic[] = [];
  let more = 0;
  const say = (severity: BrepDiagnostic['severity'], message: string) => {
    if (out.length < MAX_DIAGNOSTICS) out.push({ severity, message });
    else more++;
  };
  const n = Object.fromEntries((['curve', 'surface', 'vertex', 'edge', 'coedge', 'loop', 'face', 'shell', 'body',
    'faceUse', 'member', 'item'] as TableName[]).map((t) => [t, rowCount(d, t)])) as Record<TableName, number>;
  const name = (t: TableName, k: number, ids?: Uint32Array) => `${t} ${k}${ids?.[k] ? ` (#${ids[k]})` : ''}`;
  const finite = (xs: ArrayLike<number>) => {
    for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) return false;
    return true;
  };
  const inRange = (t: TableName, i: number) => Number.isInteger(i) && i >= 0 && i < n[t];

  const uncertainty = d.part.uncertainty[0]!;
  if (!Number.isNaN(uncertainty) && !(uncertainty > 0 && Number.isFinite(uncertainty))) {
    say('error', `part: uncertainty ${uncertainty}`);
  }

  // Values read from a pool, with what's wrong said once per row.
  const len = (v: number[]) => Math.hypot(...v);
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  const isUnit = (v: number[]) => v.every(Number.isFinite) && Math.abs(len(v) - 1) <= UNIT_TOLERANCE;
  class Reader {
    problems: string[] = [];
    readonly real: Float64Array;
    readonly int: Int32Array;
    r: number;
    i: number;
    constructor(real: Float64Array, r: number, int: Int32Array, i: number) {
      this.real = real;
      this.int = int;
      this.r = r;
      this.i = i;
    }
    reals(k: number): number[] | undefined {
      if (this.r < 0 || this.r + k > this.real.length) {
        this.problems.push('reals beyond its pool');
        return undefined;
      }
      const a = Array.from(this.real.subarray(this.r, this.r + k));
      this.r += k;
      return a;
    }
    ints(k: number): number[] | undefined {
      if (this.i < 0 || this.i + k > this.int.length) {
        this.problems.push('integers beyond its pool');
        return undefined;
      }
      const a = Array.from(this.int.subarray(this.i, this.i + k));
      this.i += k;
      return a;
    }
    want(ok: boolean, what: string) { if (!ok) this.problems.push(what); }
    placement(dim: number) {
      const p = this.reals(dim === 3 ? 9 : 4);
      if (!p) return;
      const origin = p.slice(0, dim);
      const axes = dim === 3 ? [p.slice(3, 6), p.slice(6, 9)] : [p.slice(2, 4)];
      this.want(origin.every(Number.isFinite), 'a placement origin not finite');
      this.want(axes.every(isUnit), 'a placement direction not of unit length');
      if (dim === 3) {
        this.want(Math.abs(dot(axes[0]!, axes[1]!)) <= UNIT_TOLERANCE, 'a placement\'s axis and x direction not '
          + 'orthogonal');
      }
    }
    positive(x: number | undefined, what: string) {
      this.want(x !== undefined && x > 0 && Number.isFinite(x), `${what} ${x}`);
    }
    logical(x: number | undefined, what: string) {
      this.want(x !== undefined && x >= 0 && x <= LOGICAL.unknown, `${what} ${x}`);
    }
    flag(x: number | undefined, what: string) { this.want(x === 0 || x === 1, `${what} ${x}`); }
    /** Part 42's constraints on a knot vector of `k` knots with multiplicities for `poles` poles of `degree`. */
    knots(degree: number, poles: number, knots: number[], mults: number[], dir = '') {
      this.want(Number.isInteger(degree) && degree >= 1, `${dir}degree ${degree}`);
      this.want(poles >= 2 && poles >= degree + 1, `${poles} ${dir}poles for degree ${degree}`);
      this.want(knots.length >= 2, `${knots.length} ${dir}knots`);
      this.want(knots.every(Number.isFinite) && knots.every((x, j) => j === 0 || x > knots[j - 1]!),
        `${dir}knots not finite and increasing`);
      this.want(mults.every((m, j) => m >= 1 && m <= (j === 0 || j === mults.length - 1 ? degree + 1 : degree)),
        `${dir}multiplicities out of range`);
      const sum = mults.reduce((s, m) => s + m, 0);
      this.want(sum === poles + degree + 1, `${dir}multiplicities sum to ${sum}, not poles + degree + 1 = `
        + `${poles + degree + 1}`);
    }
  }
  const report = (what: string, r: Reader) => {
    if (r.problems.length) say('error', `${what}: ${r.problems.join('; ')}`);
  };

  const curveDim = (i: number) => d.curve.dim[i]!;
  const curveRef = (r: Reader, i: number | undefined, k: number | undefined, dim: number | undefined, what: string) => {
    if (i === undefined) return;
    if (!inRange('curve', i) || (k !== undefined && i >= k)) r.problems.push(`${what} ${i} not an earlier curve`);
    else if (dim !== undefined && curveDim(i) !== dim) r.problems.push(`${what} ${i} is ${curveDim(i)}D, not ${dim}D`);
  };

  for (let k = 0; k < n.curve; k++) {
    const dim = d.curve.dim[k]!, kind = nameOf(CURVE_KIND, d.curve.kind[k]!);
    const r = new Reader(d.pool.curveReal, d.curve.real[k]!, d.pool.curveInt, d.curve.int[k]!);
    const what = `${name('curve', k, d.curve.id)}${kind ? ` (${kind})` : ''}`;
    if (dim !== 2 && dim !== 3) { say('error', `${what}: dimension ${dim}`); continue; }
    switch (kind) {
      case 'line': {
        const p = r.reals(2 * dim + 1);
        if (!p) break;
        r.want(p.slice(0, dim).every(Number.isFinite), 'point not finite');
        r.want(isUnit(p.slice(dim, 2 * dim)), 'direction not of unit length');
        r.positive(p[2 * dim], 'magnitude');
        break;
      }
      case 'circle': r.placement(dim); r.positive(r.reals(1)?.[0], 'radius'); break;
      case 'ellipse': case 'hyperbola': {
        r.placement(dim);
        const [a, b] = r.reals(2) ?? [];
        r.positive(a, 'first semi-axis');
        r.positive(b, 'second semi-axis');
        break;
      }
      case 'parabola': {
        r.placement(dim);
        const f = r.reals(1)?.[0];
        r.want(f !== undefined && f !== 0 && Number.isFinite(f), `focal distance ${f}`);
        break;
      }
      case 'bspline': {
        const h = r.ints(7);
        if (!h) break;
        const [degree, poles, nk, rational, closed, selfIntersect, form] = h as number[];
        r.flag(rational, 'rational');
        r.logical(closed, 'closed');
        r.logical(selfIntersect, 'self_intersect');
        r.want(form! >= 0 && form! < CURVE_FORMS.length, `form ${form}`);
        if (!(nk! >= 0 && poles! >= 0)) { r.problems.push(`${nk} knots, ${poles} poles`); break; }
        const mults = r.ints(nk!), knots = r.reals(nk!), p = r.reals(poles! * dim);
        const w = rational ? r.reals(poles!) : [];
        if (!mults || !knots || !p || !w) break;
        r.knots(degree!, poles!, knots, mults);
        r.want(finite(p), 'poles not finite');
        r.want(w.every((x) => x > 0 && Number.isFinite(x)), 'weights not positive');
        break;
      }
      case 'polyline': {
        const m = r.ints(1)?.[0];
        if (m === undefined) break;
        r.want(m >= 2, `${m} points`);
        const p = m >= 0 ? r.reals(m * dim) : undefined;
        if (p) r.want(finite(p), 'points not finite');
        break;
      }
      case 'trimmed': {
        const t = r.reals(2 + 2 * dim), h = r.ints(3);
        if (!t || !h) break;
        curveRef(r, h[0], k, dim, 'basis');
        for (const [j, p] of [[0, t.slice(2, 2 + dim)], [1, t.slice(2 + dim)]] as [number, number[]][]) {
          const hasParam = Number.isFinite(t[j]!), hasPoint = p.every(Number.isFinite);
          r.want(hasParam || hasPoint, `trim ${j + 1} with neither a parameter nor a point`);
          r.want(hasPoint || p.every(Number.isNaN), `trim ${j + 1}'s point partly given`);
        }
        r.flag(h[1], 'sense');
        r.want(h[2]! >= 0 && h[2]! < TRIM_PREFERENCES.length, `master representation ${h[2]}`);
        break;
      }
      case 'composite': {
        const h = r.ints(2);
        if (!h) break;
        r.want(h[0]! >= 1, `${h[0]} segments`);
        r.logical(h[1], 'self_intersect');
        for (let j = 0; j < h[0]!; j++) {
          const s = r.ints(3);
          if (!s) break;
          curveRef(r, s[0], k, dim, 'segment curve');
          r.flag(s[1], 'same_sense');
          r.want(s[2]! >= 0 && s[2]! < TRANSITIONS.length, `transition ${s[2]}`);
        }
        break;
      }
      case 'offset': {
        const t = r.reals(dim === 3 ? 4 : 1), h = r.ints(2);
        if (!t || !h) break;
        r.want(Number.isFinite(t[0]!), `distance ${t[0]}`);
        if (dim === 3) r.want(isUnit(t.slice(1)), 'reference direction not of unit length');
        curveRef(r, h[0], k, dim, 'basis');
        r.logical(h[1], 'self_intersect');
        break;
      }
      default: r.problems.push(`kind ${d.curve.kind[k]}`);
    }
    report(what, r);
  }

  for (let k = 0; k < n.surface; k++) {
    const kind = nameOf(SURFACE_KIND, d.surface.kind[k]!);
    const r = new Reader(d.pool.surfaceReal, d.surface.real[k]!, d.pool.surfaceInt, d.surface.int[k]!);
    const what = `${name('surface', k, d.surface.id)}${kind ? ` (${kind})` : ''}`;
    const surfaceRef = (i: number | undefined, label: string) => {
      if (i === undefined || !inRange('surface', i) || i >= k) r.problems.push(`${label} ${i} not an earlier surface`);
    };
    switch (kind) {
      case 'plane': r.placement(3); break;
      case 'cylinder': case 'sphere': r.placement(3); r.positive(r.reals(1)?.[0], 'radius'); break;
      case 'cone': {
        r.placement(3);
        const [radius, a] = r.reals(2) ?? [];
        r.want(radius !== undefined && radius >= 0 && Number.isFinite(radius), `radius ${radius}`);
        r.want(a !== undefined && Math.abs(a) > 0 && Math.abs(a) < Math.PI / 2, `semi-angle ${a} (radians)`);
        break;
      }
      case 'torus': {
        r.placement(3);
        const [major, minor] = r.reals(2) ?? [], h = r.ints(2);
        r.positive(major, 'major radius');
        r.positive(minor, 'minor radius');
        if (!h) break;
        r.flag(h[0], 'degenerate');
        r.flag(h[1], 'select_outer');
        if (h[0]) r.want(major! < minor!, 'degenerate with the major radius not under the minor');
        else r.want(h[1] === 0, 'select_outer on a torus not degenerate');
        break;
      }
      case 'bspline': {
        const h = r.ints(11);
        if (!h) break;
        const [ud, vd, nu, nv, ku, kv, rational, uc, vc, si, form] = h as number[];
        r.flag(rational, 'rational');
        r.logical(uc, 'u_closed');
        r.logical(vc, 'v_closed');
        r.logical(si, 'self_intersect');
        r.want(form! >= 0 && form! < SURFACE_FORMS.length, `form ${form}`);
        if (!(nu! >= 0 && nv! >= 0 && ku! >= 0 && kv! >= 0)) { r.problems.push('negative counts'); break; }
        const um = r.ints(ku!), vm = r.ints(kv!), uk = r.reals(ku!), vk = r.reals(kv!);
        const p = r.reals(nu! * nv! * 3), w = rational ? r.reals(nu! * nv!) : [];
        if (!um || !vm || !uk || !vk || !p || !w) break;
        r.knots(ud!, nu!, uk, um, 'u ');
        r.knots(vd!, nv!, vk, vm, 'v ');
        r.want(finite(p), 'poles not finite');
        r.want(w.every((x) => x > 0 && Number.isFinite(x)), 'weights not positive');
        break;
      }
      case 'extrusion': {
        const t = r.reals(4), h = r.ints(1);
        if (!t || !h) break;
        r.want(isUnit(t.slice(0, 3)), 'direction not of unit length');
        r.positive(t[3], 'magnitude');
        curveRef(r, h[0], undefined, 3, 'swept curve');
        break;
      }
      case 'revolution': {
        const t = r.reals(6), h = r.ints(1);
        if (!t || !h) break;
        r.want(t.slice(0, 3).every(Number.isFinite), 'axis location not finite');
        r.want(isUnit(t.slice(3)), 'axis direction not of unit length');
        curveRef(r, h[0], undefined, 3, 'swept curve');
        break;
      }
      case 'offset': {
        const t = r.reals(1), h = r.ints(2);
        if (!t || !h) break;
        r.want(Number.isFinite(t[0]!), `distance ${t[0]}`);
        surfaceRef(h[0], 'basis');
        r.logical(h[1], 'self_intersect');
        break;
      }
      case 'rectangularTrimmed': {
        const t = r.reals(4), h = r.ints(3);
        if (!t || !h) break;
        r.want(finite(t) && t[0] !== t[1] && t[2] !== t[3], `bounds ${t.join(', ')}`);
        surfaceRef(h[0], 'basis');
        r.flag(h[1], 'usense');
        r.flag(h[2], 'vsense');
        break;
      }
      case 'curveSwept': {
        const h = r.ints(3);
        if (!h) break;
        curveRef(r, h[0], undefined, 3, 'swept curve');
        curveRef(r, h[1], undefined, undefined, 'directrix');
        surfaceRef(h[2], 'reference surface');
        break;
      }
      case 'fixedReferenceSwept': {
        const t = r.reals(3), h = r.ints(2);
        if (!t || !h) break;
        r.want(isUnit(t), 'fixed reference not of unit length');
        curveRef(r, h[0], undefined, 3, 'swept curve');
        curveRef(r, h[1], undefined, 3, 'directrix');
        break;
      }
      default: r.problems.push(`kind ${d.surface.kind[k]}`);
    }
    report(what, r);
  }

  const tolerance = (t: TableName, k: number, x: number, ids: Uint32Array) => {
    if (!Number.isNaN(x) && !(x >= 0 && Number.isFinite(x))) say('error', `${name(t, k, ids)}: tolerance ${x}`);
  };
  const pair = (t: TableName, k: number, r: Float64Array, ids: Uint32Array) => {
    const a = r[2 * k]!, b = r[2 * k + 1]!;
    if (!(Number.isNaN(a) && Number.isNaN(b)) && !(Number.isFinite(a) && Number.isFinite(b))) {
      say('error', `${name(t, k, ids)}: range ${a}, ${b}`);
    }
  };

  for (let k = 0; k < n.vertex; k++) {
    if (!finite(d.vertex.point.subarray(3 * k, 3 * k + 3))) {
      say('error', `${name('vertex', k, d.vertex.id)}: point not finite`);
    }
    tolerance('vertex', k, d.vertex.tolerance[k]!, d.vertex.id);
  }

  const e = d.edge;
  // An edge with neither a 3D curve nor vertices is defined by its uses' p-curves alone (a curve-bounded surface's
  // boundary, trims in parameter space): it needs uses, every one with a p-curve.
  const uses = new Int32Array(n.edge), bare = new Int32Array(n.edge);
  for (let k = 0; k < n.coedge; k++) {
    const g = d.coedge.edge[k]!;
    if (!inRange('edge', g)) continue;
    uses[g]!++;
    if (d.coedge.pcurve[k]! < 0) bare[g]!++;
  }
  for (let k = 0; k < n.edge; k++) {
    const what = name('edge', k, e.id), c = e.curve[k]!, s = e.start[k]!, t = e.end[k]!;
    if (c !== -1 && (!inRange('curve', c) || curveDim(c) !== 3)) say('error', `${what}: curve ${c} not a 3D curve`);
    for (const v of [s, t]) if (v !== -1 && !inRange('vertex', v)) say('error', `${what}: vertex ${v} out of range`);
    if ((s === -1) !== (t === -1)) say('warning', `${what}: one vertex only`);
    if (c === -1 && s === -1 && (!uses[k] || bare[k])) {
      say('error', `${what}: neither a curve nor vertices, and ${uses[k] ? 'a use without a p-curve' : 'no use'}`);
    }
    if (e.sameSense[k]! > 1) say('error', `${what}: same_sense ${e.sameSense[k]}`);
    if (e.flags[k]! & ~EDGE_FLAGS.degenerate) say('error', `${what}: flags ${e.flags[k]}`);
    pair('edge', k, e.range, e.id);
    tolerance('edge', k, e.tolerance[k]!, e.id);
  }

  const c = d.coedge;
  for (let k = 0; k < n.coedge; k++) {
    const what = name('coedge', k, c.id), p = c.pcurve[k]!;
    if (!inRange('edge', c.edge[k]!)) say('error', `${what}: edge ${c.edge[k]} out of range`);
    if (c.orientation[k]! > ORIENTATION.external) say('error', `${what}: orientation ${c.orientation[k]}`);
    if (p !== -1 && (!inRange('curve', p) || curveDim(p) !== 2)) say('error', `${what}: p-curve ${p} not a 2D curve`);
    pair('coedge', k, c.range, c.id);
  }

  // Ownership: every coedge in one loop, every loop in one face, every face use in one shell, every member in one
  // body.
  const owners = (t: TableName, count: number) => new Int32Array(count).fill(-1);
  const coedgeOwner = owners('coedge', n.coedge), loopOwner = owners('loop', n.loop);
  const faceUseOwner = owners('faceUse', n.faceUse), memberOwner = owners('member', n.member);
  const own = (o: Int32Array, t: TableName, first: number, count: number, by: string, k: number) => {
    if (!(count >= 0 && first >= 0 && first + count <= o.length)) {
      say('error', `${by}: ${t}s ${first} to ${first + count - 1} out of range`);
      return false;
    }
    for (let j = first; j < first + count; j++) {
      if (o[j] !== -1) { say('error', `${by}: ${t} ${j} already belongs to another`); return false; }
      o[j] = k;
    }
    return true;
  };

  const l = d.loop;
  /** A coedge's first and last vertex as it runs. */
  const ends = (j: number): [number, number] => {
    const g = c.edge[j]!, s = e.start[g]!, t = e.end[g]!;
    return c.orientation[j] === ORIENTATION.reversed ? [t, s] : [s, t];
  };
  for (let k = 0; k < n.loop; k++) {
    const what = name('loop', k, l.id), kind = nameOf(LOOP_KIND, l.kind[k]!), first = l.first[k]!, count = l.count[k]!;
    if (l.bound[k]! > BOUND.inner) say('error', `${what}: bound ${l.bound[k]}`);
    if (l.sense[k]! > 1) say('error', `${what}: sense ${l.sense[k]}`);
    if (kind === 'edge') {
      if (count < 1) { say('error', `${what}: ${count} coedges`); continue; }
      if (!own(coedgeOwner, 'coedge', first, count, what, k)) continue;
      // Joined: each coedge ends where the next starts (where both vertices are known, and every use is forward
      // or reversed: internal and external edges needn't join).
      let joined = true;
      for (let j = 0; j < count && joined; j++) {
        const a = first + j, b = first + (j + 1) % count;
        if (!inRange('edge', c.edge[a]!) || !inRange('edge', c.edge[b]!)) { joined = false; break; }
        if (c.orientation[a]! > ORIENTATION.reversed || c.orientation[b]! > ORIENTATION.reversed) continue;
        const end = ends(a)[1], start = ends(b)[0];
        if (end !== -1 && start !== -1 && end !== start) {
          say('error', `${what}: coedge ${a} ends at vertex ${end}, the next starts at ${start}`);
          joined = false;
        }
      }
    } else if (kind === 'vertex') {
      if (count !== 1 || !inRange('vertex', first)) say('error', `${what}: vertex ${first} (count ${count})`);
    } else if (kind === 'poly') {
      if (count < 3 || first < 0 || first + count > d.pool.loopInt.length) {
        say('error', `${what}: ${count} vertices at ${first}`);
      } else {
        const bad = Array.from(d.pool.loopInt.subarray(first, first + count)).find((v) => !inRange('vertex', v));
        if (bad !== undefined) say('error', `${what}: vertex ${bad}`);
      }
    } else say('error', `${what}: kind ${l.kind[k]}`);
  }
  for (let j = 0; j < n.coedge; j++) if (coedgeOwner[j] === -1) say('error', `coedge ${j}: in no edge loop`);

  const f = d.face;
  for (let k = 0; k < n.face; k++) {
    const what = name('face', k, f.id), first = f.firstLoop[k]!, count = f.loopCount[k]!;
    if (!inRange('surface', f.surface[k]!)) say('error', `${what}: surface ${f.surface[k]} out of range`);
    if (f.sameSense[k]! > 1) say('error', `${what}: same_sense ${f.sameSense[k]}`);
    tolerance('face', k, f.tolerance[k]!, f.id);
    if (!own(loopOwner, 'loop', first, count, what, k)) continue;
    let outer = 0;
    for (let j = first; j < first + count; j++) if (l.bound[j] === BOUND.outer) outer++;
    // Part 42 allows one; files with more are kept as they are, so a warning.
    if (outer > 1) say('warning', `${what}: ${outer} outer bounds (Part 42 allows one)`);
  }
  for (let j = 0; j < n.loop; j++) if (loopOwner[j] === -1) say('error', `loop ${j}: in no face`);

  const s = d.shell;
  for (let k = 0; k < n.shell; k++) {
    const what = name('shell', k, s.id), first = s.first[k]!, count = s.count[k]!;
    if (!nameOf(SHELL_KIND, s.kind[k]!)) say('error', `${what}: kind ${s.kind[k]}`);
    if (!own(faceUseOwner, 'faceUse', first, count, what, k)) continue;
    for (let j = first; j < first + count; j++) {
      if (!inRange('face', d.faceUse.face[j]!)) say('error', `${what}: face ${d.faceUse.face[j]} out of range`);
    }
  }
  const b = d.body;
  for (let k = 0; k < n.body; k++) {
    const what = name('body', k, b.id), first = b.first[k]!, count = b.count[k]!;
    const kind = nameOf(BODY_KIND, b.kind[k]!);
    if (!kind) { say('error', `${what}: kind ${b.kind[k]}`); continue; }
    if (count < 1) say('error', `${what}: no members`);
    if (!own(memberOwner, 'member', first, count, what, k)) continue;
    const table: TableName = kind === 'wire' ? 'edge' : 'shell';
    for (let j = first; j < first + count; j++) {
      const m = d.member.ref[j]!;
      if (!inRange(table, m)) say('error', `${what}: ${table} ${m} out of range`);
      else if (kind === 'solid' && s.kind[m] !== SHELL_KIND.closed) say('warning', `${what}: shell ${m} not closed`);
    }
  }
  for (let j = 0; j < n.faceUse; j++) {
    if (faceUseOwner[j] === -1) say('error', `faceUse ${j}: in no shell`);
    if (d.faceUse.sense[j]! > 1) say('error', `faceUse ${j}: sense ${d.faceUse.sense[j]}`);
  }
  for (let j = 0; j < n.member; j++) {
    if (memberOwner[j] === -1) say('error', `member ${j}: in no body`);
    if (d.member.sense[j]! > 1) say('error', `member ${j}: sense ${d.member.sense[j]}`);
  }

  const it = d.item, ir = d.pool.itemReal;
  for (let k = 0; k < n.item; k++) {
    const what = name('item', k, it.id), kind = nameOf(ITEM_KIND, it.kind[k]!), ref = it.ref[k]!, t = it.transform[k]!;
    if (!kind) { say('error', `${what}: kind ${it.kind[k]}`); continue; }
    if (kind === 'point') {
      if (!(ref >= 0 && ref + 3 <= ir.length) || !finite(ir.subarray(ref, ref + 3))) {
        say('error', `${what}: point at ${ref}`);
      }
    } else if (kind === 'instance') {
      if (!(ref >= 0 && ref < k)) say('error', `${what}: item ${ref} not an earlier item`);
      if (t === -1) say('error', `${what}: an instance without a transform`);
    } else if (!inRange(kind, ref)) say('error', `${what}: ${kind} ${ref} out of range`);
    if (t !== -1) {
      const m = t >= 0 && t + 12 <= ir.length ? Array.from(ir.subarray(t, t + 12)) : undefined;
      const det = m && m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!)
        + m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!);
      if (!m || !finite(m) || !det) {
        say('error', `${what}: transform at ${t} ${m ? 'singular or not finite' : 'out of range'}`);
      }
    }
  }

  const sourced: [TableName, Uint32Array][] = [['vertex', d.vertex.id], ['edge', d.edge.id], ['face', d.face.id]];
  for (const [t, ids] of sourced) {
    const seen = new Map<number, number>();
    ids.forEach((x, k) => {
      if (x === 0) return;
      const was = seen.get(x);
      if (was !== undefined) say('warning', `${t} ${k}: source id #${x}, as ${t} ${was}`);
      else seen.set(x, k);
    });
  }

  if (more) out.push({ severity: 'warning', message: `and ${more} more` });
  return out;
}
