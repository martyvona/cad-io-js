// The reference shapes (test/reference/): their fixtures current, their models valid, and every fact they state
// checked against cad-brep's evaluators (geometry.ts), areas and volumes by quadrature over them (integrate.ts).
// The facts come from closed forms (forms.ts, bezier.ts) and the evaluators from the rows, so each checks the other;
// second derivatives, which geometry.ts doesn't give, against central differences of its first.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrepData } from '../src/data.ts';
import * as dec from '../src/decode.ts';
import { curveEvaluator, normalAt, surfaceEvaluator } from '../src/geometry.ts';
import { validateBrep } from '../src/validate.ts';
import { checkCase } from './reference/check-cases.ts';
import { FIXTURES, type Fixture, fixtures } from './reference/generate.ts';
import { bodyVolume, curveCuts, faceArea, quad } from './reference/integrate.ts';
import { FAR, type Fact, TOL } from './reference/maker.ts';
import { cross, norm, sub, unit, type V } from './reference/vec.ts';

const all = fixtures();

test('the fixtures are what generate.ts writes', () => {
  const stale = 'stale: run node packages/cad-brep/test/reference/generate.ts';
  assert.ok(existsSync(FIXTURES), stale);
  const want = new Set(all.flatMap((f) => [`${f.file}.cbr`, `${f.file}.json`]));
  assert.deepEqual(readdirSync(FIXTURES).sort(), [...want].sort(), stale);
  for (const f of all) {
    assert.ok(Buffer.from(f.data.buffer).equals(readFileSync(join(FIXTURES, `${f.file}.cbr`))), `${f.file}: ${stale}`);
    assert.equal(readFileSync(join(FIXTURES, `${f.file}.json`), 'utf8'), f.json, `${f.file}: ${stale}`);
  }
});

test('the fixtures are deterministic and hold no NaN, Infinity or -0', () => {
  const again = fixtures();
  for (const [k, f] of all.entries()) {
    assert.equal(again[k]!.json, f.json, f.file);
    assert.ok(!/NaN|Infinity|-0[,\]}]/.test(f.json), f.file);
    const j = JSON.parse(f.json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j), ['format', 'name', 'variant', 'file', 'similarity', 'uncertainty', 'facts',
      'cases']);
    assert.equal(j.file, `${j.name}-${j.variant}`);
  }
});

test('every reference model is valid', () => {
  for (const f of all) {
    const errors = validateBrep(f.data).filter((x) => x.severity === 'error');
    assert.deepEqual(errors, [], f.file);
  }
});

/** |got - want| <= max(tol |want|, abs), vectors by their norm. */
function near(got: V | number, want: V | number, tol: number, abs: number, what: string) {
  const g = typeof got === 'number' ? [got] : got, w = typeof want === 'number' ? [want] : want;
  assert.equal(g.length, w.length, `${what}: dimension`);
  const err = norm(sub(g, w)), lim = Math.max(tol * norm(w), abs);
  assert.ok(err <= lim, `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)} (error ${err}, ${lim})`);
}

/** The ids the facts name are the rows' (so the C++ tests can find rows either way). */
function idOf(d: BrepData, f: Fact): number {
  if (f.kind === 'faceArea') return d.face.id[f.face as number]!;
  if (f.kind === 'volume') return d.body.id[f.body as number]!;
  if ('surface' in f) return d.surface.id[f.surface as number]!;
  return d.curve.id[f.curve as number]!;
}

/**
 * Whether geometry.ts evaluates a row's derivatives by differences (offsets, and what's built on them): its error is
 * then about 1e-9 times the coordinates' size (the step 1e-7 against rounding), far more than the closed forms'.
 */
function numericCurve(d: BrepData, c: number): boolean {
  const row = dec.curve(d, c);
  if (row.kind === 'offset') return true;
  if (row.kind === 'trimmed') return numericCurve(d, row.basis);
  if (row.kind === 'composite') return row.segments.some((g) => numericCurve(d, g.curve));
  return false;
}

function numericSurface(d: BrepData, s: number): boolean {
  const row = dec.surface(d, s);
  if (row.kind === 'offset') return true;
  if (row.kind === 'rectangularTrimmed') return numericSurface(d, row.basis);
  if (row.kind === 'extrusion' || row.kind === 'revolution') return numericCurve(d, row.curve);
  return false;
}

/**
 * A second derivative by differences of a first, one-sided (second order) so as not to straddle a B-spline's knot
 * at t: forward from t (derivatives at a knot are the span's starting there), backward where that passes `hi`.
 */
function diff2(g: (t: number) => V, t: number, h: number, hi: number): V {
  if (t + 2 * h <= hi) return g(t).map((x, k) => (-3 * x + 4 * g(t + h)[k]! - g(t + 2 * h)[k]!) / (2 * h));
  return g(t).map((x, k) => (3 * x - 4 * g(t - h)[k]! + g(t - 2 * h)[k]!) / (2 * h));
}

/** The relative tolerance of an area (power 2) or volume (3) integrated over numeric derivatives. */
function numericTol(fx: Fixture, f: Fact, power: number): number {
  const t = (JSON.parse(fx.json) as { similarity: { translation: V } }).similarity.translation;
  const size = ((f.abs - (power === 1 ? FAR * norm(t) : 0)) / TOL) ** (1 / power);
  return 1e-6 + 8e-9 * (norm(t) + size) / size;
}

function checkFact(fx: Fixture, f: Fact) {
  const d = fx.data, what = `${fx.file} ${f.kind} ${JSON.stringify(f).slice(0, 120)}`;
  assert.equal(idOf(d, f), f.id, `${what}: id`);
  assert.ok(f.id > 0, `${what}: an id`);
  // The shape's size after its similarity (abs is TOL times it), against which far coordinates lose digits.
  const size = (f.abs - FAR * norm((JSON.parse(fx.json) as { similarity: { translation: V } }).similarity
    .translation)) / TOL;
  switch (f.kind) {
    case 'curvePoint': {
      const row = f.curve as number, C = curveEvaluator(d, row)!, t = f.t as number, p = f.p as V;
      const num = numericCurve(d, row), d1 = norm(f.d1 as V), lift = norm(p) / size;
      near(C.point(t), p, f.tol, f.abs, `${what}: p`);
      near(C.d1(t), f.d1 as V, num ? 1e-6 : 1e-9, f.abs + (num ? 4e-9 * norm(p) : 0), `${what}: d1`);
      const h = (num ? 1e-3 : 1e-4) * Math.max(1, Math.abs(t)), hi = Number.isFinite(C.range[1]) && !C.period
        ? C.range[1] : Infinity;
      near(diff2((x) => C.d1(x), t, h, hi), f.d2 as V, num ? 1e-4 : 1e-6, 1e-6 * Math.max(d1, f.abs)
        + (num ? 8e-9 * norm(p) / h : 1e-15 * lift * d1 / h), `${what}: d2`);
      break;
    }
    case 'curveLength': {
      const row = f.curve as number, C = curveEvaluator(d, row)!;
      const L = quad((t) => norm(C.d1(t)), f.t0 as number, f.t1 as number, 64, curveCuts(d, row));
      near(L, f.length as number, numericCurve(d, row) ? numericTol(fx, f, 1) : 1e-10, f.abs, `${what}: length`);
      break;
    }
    case 'surfacePoint': {
      const row = f.surface as number, S = surfaceEvaluator(d, row)!, u = f.u as number, v = f.v as number;
      const p = f.p as V, num = numericSurface(d, row), lift = norm(p) / size;
      near(S.point(u, v), p, f.tol, f.abs, `${what}: p`);
      const [su, sv] = S.d1(u, v), slack = num ? 4e-9 * norm(p) : 0;
      near(su, f.du as V, num ? 1e-6 : 1e-9, f.abs + slack, `${what}: du`);
      near(sv, f.dv as V, num ? 1e-6 : 1e-9, f.abs + slack, `${what}: dv`);
      const k = num ? 1e-3 : 1e-4, hu = k * Math.max(1, Math.abs(u)), hv = k * Math.max(1, Math.abs(v));
      const uHi = S.uPeriod ? Infinity : S.u[1], vHi = S.vPeriod ? Infinity : S.v[1];
      const scale = Math.max(norm(f.du as V), norm(f.dv as V), f.abs);
      const tol2 = num ? 1e-4 : 1e-6, abs2 = (h: number) => 1e-6 * scale + (num ? 8e-9 * norm(p) / h
        : 1e-15 * lift * scale / h);
      near(diff2((x) => S.d1(x, v)[0], u, hu, uHi), f.duu as V, tol2, abs2(hu), `${what}: duu`);
      near(diff2((x) => S.d1(x, v)[1], u, hu, uHi), f.duv as V, tol2, abs2(hu), `${what}: duv`);
      near(diff2((x) => S.d1(u, x)[1], v, hv, vHi), f.dvv as V, tol2, abs2(hv), `${what}: dvv`);
      // Periodic parameters in [0, period), as the fixtures give them.
      if (S.uPeriod) assert.ok(u >= 0 && u < S.uPeriod, `${what}: u in [0, period)`);
      if (S.vPeriod) assert.ok(v >= 0 && v < S.vPeriod, `${what}: v in [0, period)`);
      const n = normalAt(S, u, v), big = Math.max(norm(su), norm(sv));
      if (f.n === null) assert.ok(!n || norm(cross(su, sv)) <= 1e-9 * big * big, `${what}: a normal`);
      else {
        assert.ok(n, `${what}: no normal`);
        // (A difference quotient's rounding over its partials' size: worst on an offset plane, whose parameters
        // are lengths.)
        near(n, f.n as V, num ? 1e-6 : 1e-9, 1e-9 + (num ? 1e-8 * norm(p) / Math.min(norm(su), norm(sv)) : 0),
          `${what}: n`);
        near(unit(cross(f.du as V, f.dv as V)), f.n as V, 1e-9, 1e-9, `${what}: n against du x dv`);
      }
      break;
    }
    case 'curveInverse': {
      const C = curveEvaluator(d, f.curve as number)!, t = f.t as number, p = f.p as V;
      const foot = C.point(t);
      near(norm(sub(p, foot)), f.distance as number, 1e-9, f.abs, `${what}: distance`);
      // The foot is a critical point of the distance: p - foot normal to the tangent.
      const tan = unit(C.d1(t));
      assert.ok(Math.abs(sub(p, foot).reduce((s, x, k) => s + x * tan[k]!, 0)) <= 1e-9 * Math.max(1,
        norm(sub(p, foot))), `${what}: not a foot`);
      // Alternatives are other feet as near; onSeam the same foot at the other end of a closed range.
      for (const a of f.alternatives as number[]) {
        near(norm(sub(p, C.point(a))), f.distance as number, 1e-9, f.abs, `${what}: alternative`);
      }
      assert.equal(f.certainty === 'ambiguous', (f.alternatives as number[]).length > 0, `${what}: certainty`);
      // onSeam exactly where t is an end of a range the curve closes over.
      const [lo, hi] = C.period ? [0, C.period] : C.range;
      const closed = !!C.period || (Number.isFinite(hi) && norm(sub(C.point(lo), C.point(hi))) <= f.abs);
      assert.equal(f.onSeam, closed && (t === lo || t === hi), `${what}: onSeam`);
      if (C.period) assert.ok(t >= 0 && t < C.period, `${what}: t in [0, period)`);
      const q = C.param(p);
      if (q !== undefined && f.certainty === 'unique' && Number.isFinite(C.range[0]) && !C.period) {
        near(q, t, 0, f.ptol as number, `${what}: param`);
      }
      break;
    }
    case 'surfaceInverse': {
      const S = surfaceEvaluator(d, f.surface as number)!, [u, v] = f.uv as [number, number], p = f.p as V;
      const foot = S.point(u, v), r = sub(p, foot);
      near(norm(r), f.distance as number, 1e-9, f.abs, `${what}: distance`);
      const [su, sv] = S.d1(u, v);
      for (const dd of [su, sv]) {
        const l = norm(dd);
        if (l > 0) {
          assert.ok(Math.abs(r.reduce((s, x, k) => s + x * dd[k]!, 0)) / l <= 1e-9 * Math.max(1, norm(r)),
            `${what}: not a foot`);
        }
      }
      for (const a of f.alternatives as [number, number][]) near(S.point(a[0], a[1]), foot, 1e-9, f.abs, what);
      if (S.params && f.certainty === 'unique' && !f.atSingularity) {
        const q = S.params(foot);
        // On a seam either end of the period is the point's.
        if (q && f.onSeamU && Math.abs(q[0] - u) > S.uPeriod! / 2) q[0] -= Math.sign(q[0] - u) * S.uPeriod!;
        if (q && f.onSeamV && Math.abs(q[1] - v) > S.vPeriod! / 2) q[1] -= Math.sign(q[1] - v) * S.vPeriod!;
        if (q) near(q, [u, v], 0, f.ptol as number, `${what}: params`);
      }
      // The flags: at a singularity a partial vanishes (u is then a choice, not a seam); on a seam u (or v) is at the
      // start of a direction closed in fact (periodic, or S equal at both ends of its range there).
      const big = Math.max(norm(su), norm(sv));
      assert.equal(f.atSingularity, Math.min(norm(su), norm(sv)) <= 1e-9 * big, `${what}: atSingularity`);
      const closedU = !!S.uPeriod || (Number.isFinite(S.u[1]) && norm(sub(S.point(S.u[0], v), S.point(S.u[1], v)))
        <= f.abs), closedV = !!S.vPeriod || (Number.isFinite(S.v[1]) && norm(sub(S.point(u, S.v[0]), S.point(u,
        S.v[1]))) <= f.abs);
      if (!f.atSingularity) {
        assert.equal(f.onSeamU, closedU && u === S.u[0], `${what}: onSeamU`);
        assert.equal(f.onSeamV, closedV && v === S.v[0], `${what}: onSeamV`);
      }
      break;
    }
    case 'faceArea': {
      const a = faceArea(d, f.face as number);
      assert.ok(a !== undefined, `${what}: no area`);
      near(a, f.area as number, numericSurface(d, d.face.surface[f.face as number]!) ? numericTol(fx, f, 2) : 1e-9,
        f.abs, `${what}: area`);
      break;
    }
    case 'volume': {
      const vol = bodyVolume(d, f.body as number);
      assert.ok(vol !== undefined, `${what}: no volume`);
      const num = dec.body(d, f.body as number).members.some((mm) => dec.shell(d, mm.ref).faces.some(({ face }) =>
        numericSurface(d, d.face.surface[face]!)));
      near(vol, f.volume as number, num ? numericTol(fx, f, 3) : 1e-9, f.abs, `${what}: volume`);
      break;
    }
    default: assert.fail(`${what}: unknown kind`);
  }
}

for (const fx of all) {
  test(`${fx.file}: the facts and cases hold on the evaluators`, () => {
    assert.ok(fx.facts.length + fx.cases.length > 0);
    for (const f of fx.facts) checkFact(fx, f);
    const uncertainty = fx.data.part.uncertainty[0]!;
    for (const c of fx.cases) checkCase(fx.data, c, uncertainty);
    assert.equal(new Set(fx.cases.map((c) => c.id)).size, fx.cases.length, `${fx.file}: case ids unique`);
  });
}
