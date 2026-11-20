// Checks of the catalogue's records (cases.ts) against cad-brep's evaluators, independent of how the records were
// written: crossings and overlap ends coincide on both curves, the curves don't meet elsewhere (dense sampling), a
// point's side by its distance from the boundary and the parity of a ray's crossings, feet as critical points no
// farther than any sample, singular iso-lines constant, measures from the rows.

import assert from 'node:assert/strict';
import type { BrepData } from '../../src/data.ts';
import * as dec from '../../src/decode.ts';
import { curveEvaluator, type CurveEvaluator, normalAt, surfaceEvaluator } from '../../src/geometry.ts';
import { type CaseRecord } from './cases.ts';
import { faceArea, quad } from './integrate.ts';
import { cross, dot, norm, sub, unit, type V } from './vec.ts';

const near = (a: V | number, b: V | number, tol: number, what: string) => {
  const d = typeof a === 'number' ? Math.abs(a - (b as number)) : norm(sub(a, b as V));
  assert.ok(d <= tol, `${what}: ${JSON.stringify(a)} against ${JSON.stringify(b)} (${d} > ${tol})`);
};

/** A 2D piece: a p-curve over [a, b] run from a to b. */
interface Piece2 {
  C: CurveEvaluator;
  a: number;
  b: number;
}

/** A face's loops as pieces in (u, v), as they run. */
function loops2(d: BrepData, f: number): Piece2[][] {
  return dec.face(d, f).loops.filter((l) => l.kind === 'edge').map((l) => l.coedges.map((c) => {
    const r = c.range ?? dec.edge(d, c.edge).range!;
    assert.ok(c.pcurve !== undefined && r, `face ${f}: a coedge without a p-curve or range`);
    const [a, b] = c.orientation === 'reversed' ? [r[1], r[0]] : r;
    return { C: curveEvaluator(d, c.pcurve!)!, a, b };
  }));
}

/** The nearest distance from p to a piece: dense samples, then golden-section search about the best. */
function distTo(p: V, g: Piece2): number {
  const n = 400, at = (t: number) => norm(sub(g.C.point(t), p));
  let best = 0, bd = Infinity;
  for (let k = 0; k <= n; k++) {
    const t = g.a + (g.b - g.a) * k / n, x = at(t);
    if (x < bd) [bd, best] = [x, k];
  }
  let lo = g.a + (g.b - g.a) * Math.max(0, best - 1) / n, hi = g.a + (g.b - g.a) * Math.min(n, best + 1) / n;
  const r = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 200; it++) {
    const m1 = hi - r * (hi - lo), m2 = lo + r * (hi - lo);
    if (at(m1) < at(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(bd, at((lo + hi) / 2));
}

/** Whether a loop winds once round a period instead of closing: its end its start moved by the period. */
function winding(loop: Piece2[], P: { u: number; v: number }): 'u' | 'v' | undefined {
  const s = loop[0]!.C.point(loop[0]!.a), e = loop.at(-1)!.C.point(loop.at(-1)!.b), du = e[0]! - s[0]!,
    dv = e[1]! - s[1]!;
  if (P.u && Math.abs(Math.abs(du) - P.u) < 1e-9 && Math.abs(dv) < 1e-9) return 'u';
  if (P.v && Math.abs(Math.abs(dv) - P.v) < 1e-9 && Math.abs(du) < 1e-9) return 'v';
  return undefined;
}

/**
 * The parity of crossings of a ray from p: along +v where a loop winds round u (it is crossed going up), else along
 * +u; the loops as dense polylines, unshifted, each closed segment half-open in the ray's cross coordinate.
 */
function rayParity(p: V, loops: Piece2[][], P: { u: number; v: number }): number {
  const upward = loops.some((l) => winding(l, P) === 'u');
  const [a, b] = upward ? [1, 0] : [0, 1];
  let n = 0;
  for (const loop of loops) for (const g of loop) {
    const k = 2000;
    let q = g.C.point(g.a);
    for (let j = 1; j <= k; j++) {
      const r = g.C.point(g.a + (g.b - g.a) * j / k);
      // The segment q-r against the ray {x_b = p_b, x_a > p_a}.
      if ((q[b]! <= p[b]!) !== (r[b]! <= p[b]!)) {
        const x = q[a]! + (p[b]! - q[b]!) * (r[a]! - q[a]!) / (r[b]! - q[b]!);
        if (x > p[a]!) n++;
      }
      q = r;
    }
  }
  return n % 2;
}

/** Pieces closing a loop that jumps along a singular line (a cone's apex, a sphere's pole): end back to start. */
function closures(d: BrepData, f: number, loops: Piece2[][]): Piece2[] {
  const s = dec.surface(d, dec.face(d, f).surface), out: Piece2[] = [];
  const apexV = s.kind === 'cone' ? -s.radius / Math.tan(s.semiAngle) : undefined;
  for (const l of loops) {
    const st = l[0]!.C.point(l[0]!.a), en = l.at(-1)!.C.point(l.at(-1)!.b);
    const onSingular = (v: number) => (apexV !== undefined && Math.abs(v - apexV) < 1e-12)
      || (s.kind === 'sphere' && Math.abs(Math.abs(v) - Math.PI / 2) < 1e-12);
    if (norm(sub(st, en)) > 1e-9 && Math.abs(st[1]! - en[1]!) < 1e-12 && onSingular(st[1]!)) {
      out.push({ C: { dim: 2, range: [0, 1], point: (t) => [en[0]! + t * (st[0]! - en[0]!), en[1]!],
        d1: () => [st[0]! - en[0]!, 0], param: () => undefined }, a: 0, b: 1 });
    }
  }
  return out;
}

function classify(d: BrepData, f: number, p: V, P: { u: number; v: number }, tol: number): string {
  const loops = loops2(d, f), extra = closures(d, f, loops);
  const dist = Math.min(...[...loops.flat(), ...extra].map((g) => distTo(p, g)));
  if (dist <= tol) return 'on';
  return rayParity(p, loops, P) ? 'in' : 'out';
}

/** Pairs of samples of two pieces nearer than tol: [ta, tb]. */
function closePairs(A: CurveEvaluator, ra: V, B: CurveEvaluator, rb: V, tol: number): [number, number][] {
  const n = 600, out: [number, number][] = [];
  const pb = Array.from({ length: n + 1 }, (_, k) => B.point(rb[0]! + (rb[1]! - rb[0]!) * k / n));
  for (let i = 0; i <= n; i++) {
    const ta = ra[0]! + (ra[1]! - ra[0]!) * i / n, p = A.point(ta);
    for (let k = 0; k <= n; k++) if (norm(sub(p, pb[k]!)) <= tol) out.push([ta, rb[0]! + (rb[1]! - rb[0]!) * k / n]);
  }
  return out;
}

type Inter = { crossings: { ta: number; tb: number; p: V; tangent: boolean }[];
  overlaps: { a: V; b: V; sameDirection: boolean }[] };

/** Crossings and overlaps of two curves: at the parameters stated, and nowhere else (to the sampling's step). */
function checkIntersections(A: CurveEvaluator, ra: V, B: CurveEvaluator, rb: V, e: Inter, what: string) {
  for (const c of e.crossings) {
    near(A.point(c.ta), c.p, 1e-12, `${what}: crossing on a`);
    near(B.point(c.tb), c.p, 1e-12, `${what}: crossing on b`);
    const s = norm(cross([...unit(A.d1(c.ta)), 0], [...unit(B.d1(c.tb)), 0]));
    assert.ok(c.tangent ? s < 1e-12 : s > 1e-6, `${what}: tangency ${s}`);
  }
  for (const o of e.overlaps) {
    const [b0, b1] = o.sameDirection ? [o.b[0]!, o.b[1]!] : [o.b[1]!, o.b[0]!];
    near(A.point(o.a[0]!), B.point(b0), 1e-12, `${what}: overlap start`);
    near(A.point(o.a[1]!), B.point(b1), 1e-12, `${what}: overlap end`);
    near(A.point((o.a[0]! + o.a[1]!) / 2), B.point((b0 + b1) / 2), 1e-12, `${what}: overlap middle`);
  }
  const step = Math.max(ra[1]! - ra[0]!, rb[1]! - rb[0]!) / 600;
  for (const [ta] of closePairs(A, ra, B, rb, 1e-9)) {
    const known = e.crossings.some((c) => Math.abs(c.ta - ta) <= 2 * step)
      || e.overlaps.some((o) => ta >= o.a[0]! - 2 * step && ta <= o.a[1]! + 2 * step);
    assert.ok(known, `${what}: the curves meet at ta ${ta}, not recorded`);
  }
}

/** The loop's point at a selfIntersect2 parameter (piece index plus fraction). */
function loopAt(loop: Piece2[], t: number): V {
  const k = Math.min(Math.floor(t), loop.length - 1), g = loop[k]!;
  return g.C.point(g.a + (t - k) * (g.b - g.a));
}

/** The pole lines given with a face's periods: the surface collapses along each, and nowhere else sampled. */
function checkPoles(d: BrepData, f: number, P: { poleU: number[]; poleV: number[] }, what: string) {
  const S = surfaceEvaluator(d, d.face.surface[f]!)!;
  const lo = (r: V) => Number.isFinite(r[0]!) ? r[0]! : -4, hi = (r: V) => Number.isFinite(r[1]!) ? r[1]! : 4;
  const collapsed = (iso: 'u' | 'v', x: number) => [0, 1, 2, 3, 4].every((k) => {
    const y = (iso === 'v' ? lo(S.u) : lo(S.v)) + k * ((iso === 'v' ? hi(S.u) - lo(S.u) : hi(S.v) - lo(S.v)) / 4);
    const [su, sv] = iso === 'v' ? S.d1(y, x) : S.d1(x, y);
    return norm(iso === 'v' ? su : sv) <= 1e-12 * Math.max(1, norm(iso === 'v' ? sv : su));
  });
  for (const v of P.poleV) assert.ok(collapsed('v', v), `${what}: pole line v = ${v}`);
  for (const u of P.poleU) assert.ok(collapsed('u', u), `${what}: pole line u = ${u}`);
  for (let k = 0; k <= 64; k++) {
    const v = lo(S.v) + (hi(S.v) - lo(S.v)) * k / 64;
    if (collapsed('v', v)) assert.ok(P.poleV.some((x) => Math.abs(x - v) < 1e-9), `${what}: v = ${v} not given`);
  }
}

export function checkCase(d: BrepData, c: CaseRecord, uncertainty: number) {
  const what = `${c.id}`, i = c.input as Record<string, any>, e = c.expected as Record<string, any>;
  if (i.periods) checkPoles(d, i.face, i.periods, what);
  switch (c.query) {
    case 'intersect2': {
      const A = curveEvaluator(d, i.a.curve)!, B = curveEvaluator(d, i.b.curve)!;
      checkIntersections(A, i.a.range, B, i.b.range, e as Inter, what);
      break;
    }
    case 'selfIntersect2': {
      const loop = loops2(d, i.face)[i.loop]!;
      for (const x of e.crossings as Inter['crossings']) {
        near(loopAt(loop, x.ta), x.p, 1e-12, `${what}: ta`);
        near(loopAt(loop, x.tb), x.p, 1e-12, `${what}: tb`);
      }
      // Nowhere else: pieces that aren't consecutive meet only at the recorded points.
      for (let a = 0; a < loop.length; a++) for (let b = a + 2; b < loop.length; b++) {
        if (a === 0 && b === loop.length - 1) continue;
        const ga = loop[a]!, gb = loop[b]!;
        for (const [ta] of closePairs(ga.C, [ga.a, ga.b], gb.C, [gb.a, gb.b], 1e-9)) {
          const p = ga.C.point(ta);
          assert.ok((e.crossings as Inter['crossings']).some((x) => norm(sub(x.p, p)) < 1e-6), `${what}: ${p}`);
        }
      }
      break;
    }
    case 'classify2':
      assert.equal(classify(d, i.face, i.p, i.periods, i.tol), e.side, what);
      break;
    case 'nest2': {
      const loops = loops2(d, i.face);
      assert.equal(e.parents.length, loops.length, what);
      if (loops.some((l) => winding(l, i.periods))) {
        assert.ok(loops.every((l) => winding(l, i.periods)), `${what}: all wind`);
        assert.deepEqual(e.parents, loops.map(() => -1), what);
        break;
      }
      // A loop's parent: the loop whose region (alone) holds a point of it, -1 for none.
      loops.forEach((l, j) => {
        const p = l[0]!.C.point((l[0]!.a + l[0]!.b) / 2);
        const holders = loops.map((o, k) => (k !== j && rayParity(p, [o], i.periods) ? k : -1)).filter((k) => k >= 0);
        assert.equal(e.parents[j], holders.length ? holders[0] : -1, `${what}: loop ${j}`);
      });
      break;
    }
    case 'invertCurve': {
      const C = curveEvaluator(d, i.curve)!, r: V = i.range ?? C.range, foot = C.point(e.t);
      near(norm(sub(i.p, foot)), e.distance, 1e-12, `${what}: distance`);
      for (const t of e.alternatives as number[]) {
        near(norm(sub(i.p, C.point(t))), e.distance, 1e-12, `${what}: alternative`);
        assert.ok(norm(sub(C.point(t), foot)) > i.tol, `${what}: an alternative is another foot`);
      }
      assert.equal(e.certainty === 'ambiguous', (e.alternatives as number[]).length > 0, what);
      for (let k = 0; k <= 4000; k++) {
        const x = norm(sub(i.p, C.point(r[0]! + (r[1]! - r[0]!) * k / 4000)));
        assert.ok(x >= e.distance - 1e-12, `${what}: a nearer sample`);
      }
      break;
    }
    case 'invertSurface': {
      const S = surfaceEvaluator(d, i.surface)!, [u, v] = e.uv as [number, number], foot = S.point(u, v);
      near(norm(sub(i.p, foot)), e.distance, 1e-12, `${what}: distance`);
      for (const [a, b] of e.alternatives as [number, number][]) {
        near(norm(sub(i.p, S.point(a, b))), e.distance, 1e-12, `${what}: alternative`);
        assert.ok(norm(sub(S.point(a, b), foot)) > i.tol, `${what}: an alternative is another foot`);
      }
      assert.equal(e.certainty === 'ambiguous', (e.alternatives as V[]).length > 0, what);
      // No sample nearer, over the domain (an infinite range: 4 about the foot).
      const lo = (r: V, x: number) => Number.isFinite(r[0]!) ? r[0]! : x - 4;
      const hi = (r: V, x: number) => Number.isFinite(r[1]!) ? r[1]! : x + 4;
      const [u0, u1, v0, v1] = [lo(S.u, u), hi(S.u, u), lo(S.v, v), hi(S.v, v)];
      for (let a = 0; a <= 300; a++) for (let b = 0; b <= 300; b++) {
        const x = norm(sub(i.p, S.point(u0 + (u1 - u0) * a / 300, v0 + (v1 - v0) * b / 300)));
        assert.ok(x >= e.distance - 1e-12, `${what}: a nearer sample`);
      }
      if (e.family) {
        for (let k = 0; k <= 16; k++) {
          const fu = e.family.u[0] + (e.family.u[1] - e.family.u[0]) * k / 16;
          near(norm(sub(i.p, S.point(fu, e.family.v))), e.distance, 1e-12, `${what}: family`);
        }
      }
      if (e.atSingularity) {
        near(S.point(u + 1, v), foot, 1e-12, `${what}: singular`);
      }
      // (At a singularity u is a choice, not a seam.)
      if (!e.atSingularity) assert.equal(e.onSeamU, !!S.uPeriod && (u === 0 || u === S.u[0]), `${what}: onSeamU`);
      break;
    }
    case 'singularities':
      for (const s of e.singularities as { isoU: boolean; at: number; point: V }[]) {
        const S = surfaceEvaluator(d, i.surface)!;
        for (let k = 0; k <= 8; k++) {
          const x = k * 2 * Math.PI / 8;
          const p = s.isoU ? S.point(s.at, x) : S.point(x, s.at);
          near(p, s.point, 1e-12, `${what}: iso-line`);
          const [su, sv] = s.isoU ? S.d1(s.at, x) : S.d1(x, s.at);
          assert.ok(norm(s.isoU ? sv : su) < 1e-12 * Math.max(1, norm(s.isoU ? su : sv)), `${what}: collapsed`);
        }
      }
      break;
    case 'singular': {
      const C = curveEvaluator(d, i.curve)!;
      for (const t of e.params as number[]) {
        assert.ok(norm(C.d1(t)) < 1e-12, `${what}: speed at ${t}`);
        near(C.point(t), e.point, 1e-12, `${what}: point`);
      }
      for (let k = 0; k <= 100; k++) {
        const t = i.range[0] + (i.range[1] - i.range[0]) * k / 100;
        if ((e.params as number[]).every((x) => Math.abs(x - t) > 0.02)) assert.ok(norm(C.d1(t)) > 1e-6, what);
      }
      break;
    }
    case 'edgeUses': {
      const faces: number[] = [];
      for (let f = 0; f < d.face.surface.length; f++) {
        for (const l of dec.face(d, f).loops) {
          if (l.kind === 'edge') for (const ce of l.coedges) if (ce.edge === i.edge) faces.push(f);
        }
      }
      assert.equal(faces.length, e.uses, what);
      assert.deepEqual(faces, e.faces, what);
      break;
    }
    case 'edgeLength': {
      const ed = dec.edge(d, i.edge), C = curveEvaluator(d, ed.curve!)!;
      const L = quad((t) => norm(C.d1(t)), ed.range![0], ed.range![1], 4);
      near(L, e.length, 1e-12 * Math.max(1, e.length) + 1e-20, `${what}: length`);
      assert.equal(L < uncertainty, e.belowTolerance, what);
      break;
    }
    case 'vertexGap': {
      const ed = dec.edge(d, i.edge), C = curveEvaluator(d, ed.curve!)!;
      const t = ed.end === i.vertex ? ed.range![1] : ed.range![0];
      const gap = norm(sub(C.point(t), Array.from(d.vertex.point.subarray(3 * i.vertex, 3 * i.vertex + 3))));
      near(gap, e.gap, 1e-12, `${what}: gap`);
      assert.ok(gap > uncertainty, what);
      break;
    }
    case 'faceWidth': {
      const a = faceArea(d, i.face)!;
      near(a, e.area, 1e-6 * e.area, `${what}: area`);
      // The width of these rectangles: their shortest side.
      const sides = loops2(d, i.face)[0]!.map((g) => norm(sub(g.C.point(g.b), g.C.point(g.a))));
      near(Math.min(...sides), e.width, 1e-6 * e.width, `${what}: width`);
      break;
    }
    case 'normal': {
      const S = surfaceEvaluator(d, i.surface)!, base = dec.surface(d, i.surface);
      near(normalAt(S, i.u, i.v)!, e.n, 1e-9, `${what}: n`);
      assert.ok(base.kind === 'offset', what);
      near(normalAt(surfaceEvaluator(d, base.basis)!, i.u, i.v)!, e.basisN, 1e-12, `${what}: basis`);
      assert.ok(dot(e.n, e.basisN) < 0, `${what}: turned`);
      break;
    }
    case 'loopCoedges': {
      const loop = loops2(d, i.face)[0]!;
      assert.equal(loop.length, e.coedges, what);
      near(loop.at(-1)!.C.point(loop.at(-1)!.b), e.jump.from, 1e-12, `${what}: from`);
      near(loop[0]!.C.point(loop[0]!.a), e.jump.to, 1e-12, `${what}: to`);
      break;
    }
    default: assert.fail(`${what}: unknown query ${c.query}`);
  }
}
