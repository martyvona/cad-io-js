// The reference shapes (test/reference/): their fixtures current, their models valid, and every fact they state
// checked against cad-brep's evaluators (geometry.ts), areas and volumes by quadrature over them (integrate.ts).
// The facts come from closed forms (forms.ts, bezier.ts) and the evaluators from the rows, so each checks the other;
// second derivatives, which geometry.ts doesn't give, against central differences of its first.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrepData } from '../src/data.ts';
import { curveEvaluator, normalAt, surfaceEvaluator } from '../src/geometry.ts';
import { validateBrep } from '../src/validate.ts';
import { FIXTURES, type Fixture, fixtures } from './reference/generate.ts';
import { bodyVolume, faceArea, quad } from './reference/integrate.ts';
import type { Fact } from './reference/maker.ts';
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

function checkFact(fx: Fixture, f: Fact) {
  const d = fx.data, what = `${fx.file} ${f.kind} ${JSON.stringify(f).slice(0, 120)}`;
  assert.equal(idOf(d, f), f.id, `${what}: id`);
  assert.ok(f.id > 0, `${what}: an id`);
  switch (f.kind) {
    case 'curvePoint': {
      const C = curveEvaluator(d, f.curve as number)!, t = f.t as number;
      near(C.point(t), f.p as V, f.tol, f.abs, `${what}: p`);
      near(C.d1(t), f.d1 as V, 1e-9, f.abs, `${what}: d1`);
      // d2 by central differences of d1, h relative to the parameter's scale.
      const h = 1e-5 * Math.max(1, Math.abs(t)), d2 = sub(C.d1(t + h), C.d1(t - h)).map((x) => x / (2 * h));
      near(d2, f.d2 as V, 1e-6, 1e-6 * Math.max(norm(f.d1 as V), f.abs), `${what}: d2`);
      break;
    }
    case 'curveLength': {
      const C = curveEvaluator(d, f.curve as number)!;
      const L = quad((t) => norm(C.d1(t)), f.t0 as number, f.t1 as number, 64);
      near(L, f.length as number, 1e-10, f.abs, `${what}: length`);
      break;
    }
    case 'surfacePoint': {
      const S = surfaceEvaluator(d, f.surface as number)!, u = f.u as number, v = f.v as number;
      near(S.point(u, v), f.p as V, f.tol, f.abs, `${what}: p`);
      const [su, sv] = S.d1(u, v);
      near(su, f.du as V, 1e-9, f.abs, `${what}: du`);
      near(sv, f.dv as V, 1e-9, f.abs, `${what}: dv`);
      const hu = 1e-5 * Math.max(1, Math.abs(u)), hv = 1e-5 * Math.max(1, Math.abs(v));
      const [au, av] = S.d1(u + hu, v), [bu, bv] = S.d1(u - hu, v), [, cv] = S.d1(u, v + hv), [, ev] = S.d1(u, v - hv);
      const fd = (a: V, b: V, h: number) => sub(a, b).map((x) => x / (2 * h));
      const scale = Math.max(norm(f.du as V), norm(f.dv as V), f.abs);
      near(fd(au, bu, hu), f.duu as V, 1e-6, 1e-6 * scale, `${what}: duu`);
      near(fd(av, bv, hu), f.duv as V, 1e-6, 1e-6 * scale, `${what}: duv`);
      near(fd(cv, ev, hv), f.dvv as V, 1e-6, 1e-6 * scale, `${what}: dvv`);
      const n = normalAt(S, u, v);
      if (f.n === null) assert.ok(!n || norm(cross(su, sv)) <= 1e-9 * norm(su) * norm(sv) || norm(su) === 0, what);
      else {
        near(n!, f.n as V, 1e-9, 1e-9, `${what}: n`);
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
      for (const a of f.alternatives as number[]) near(C.point(a), foot, f.tol, f.abs, `${what}: alternative`);
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
        const P = S.uPeriod ?? 0;
        if (q && f.onSeamU && Math.abs(q[0] - u) > P / 2) q[0] -= Math.sign(q[0] - u) * P;
        if (q) near(q, [u, v], 0, f.ptol as number, `${what}: params`);
      }
      if (f.onSeamU) assert.ok(S.uPeriod && (u === 0 || u === S.u[0]), `${what}: seam`);
      break;
    }
    case 'faceArea': {
      const a = faceArea(d, f.face as number);
      assert.ok(a !== undefined, `${what}: no area`);
      near(a, f.area as number, 1e-9, f.abs, `${what}: area`);
      break;
    }
    case 'volume': {
      const vol = bodyVolume(d, f.body as number);
      assert.ok(vol !== undefined, `${what}: no volume`);
      near(vol, f.volume as number, 1e-9, f.abs, `${what}: volume`);
      break;
    }
    default: assert.fail(`${what}: unknown kind`);
  }
}

for (const fx of all) {
  test(`${fx.file}: the facts hold on the evaluators`, () => {
    assert.ok(fx.facts.length > 0);
    for (const f of fx.facts) checkFact(fx, f);
  });
}
