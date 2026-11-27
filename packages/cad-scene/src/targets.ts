// Mesh triage's targets (docs/triage.md, "Targets"): what each consumer tolerates of a face's mesh, criterion by
// criterion, as warn and error levels (multiples of the criterion's true limit); and classify, which classes a face's
// triage record (records.ts) under a target. The one place the levels are defined. Nothing chooses by the classes
// yet, and the targets' meshing limits are data only, not yet asked of the backends.

import { AREA, CHECK, EXPECTED, ORIENTATION } from './records.ts';
import type { FaceRecords } from './tessellator.ts';

export type TargetName = 'rendering' | 'manifold' | 'analysis';
export const TARGET_NAMES: readonly TargetName[] = ['rendering', 'manifold', 'analysis'];

/** The criteria, in docs/triage.md's order (the tie-break's too). */
export type Criterion = 'k' | 'a' | 'j' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'l' | 'i';
export const CRITERIA: readonly Criterion[] = ['k', 'a', 'j', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'l', 'i'];

export type FaceClass = 'pass' | 'warn' | 'error' | 'unchecked' | 'unverified';

/**
 * A criterion's levels: past `warn` times its true limit a face is warned of, past `error` times it the face's mesh
 * is an error; absent, never. Criteria without a magnitude (k, a, j, e, l) are past their limit or not: a level of 1.
 * (b)'s error is a fraction of the face's area (`errorFraction`) where the target sets one, else its true limit.
 */
export interface Level { warn?: number; error?: number; errorFraction?: number }

export interface Target {
  name: TargetName;
  levels: Readonly<Record<Criterion, Level>>;
  /**
   * What the target asks of the backends' meshing (docs/triage.md: "backends are told the true limits"): the smallest
   * angle (f's true limit too), the longest edge as a fraction of the part's size (g's; absent: none), elementary
   * faces' size metric's stretch capped from the start. Not yet applied: data only.
   */
  meshing: { minAngle: number; maxEdge?: number; elementaryStretchCap?: number };
  /** (h)'s ceiling, triangles per face: 10M on desktops, 2M on phones and tablets. */
  ceiling: number;
}

const deg = (d: number) => (d * Math.PI) / 180;
const DESKTOP_CEILING = 10_000_000;
/** (h)'s floor and multiple: min(ceiling, max(H_FLOOR, H_MULTIPLE x the face's expected count)). */
export const H_FLOOR = 200_000;
export const H_MULTIPLE = 64;

const common = { k: { error: 1 }, j: { warn: 1 }, e: { warn: 1 }, h: { error: 1 }, l: { warn: 1 }, i: {} };
export const TARGETS: Readonly<Record<TargetName, Target>> = {
  rendering: { name: 'rendering', ceiling: DESKTOP_CEILING, meshing: { minAngle: deg(10) }, levels: {
    ...common, a: { warn: 1 }, b: { warn: 1, errorFraction: 0.25 }, c: { warn: 1, error: 10 }, d: { warn: 1 },
    f: { warn: 1 }, g: { warn: 1 } } },
  manifold: { name: 'manifold', ceiling: DESKTOP_CEILING, meshing: { minAngle: deg(10), elementaryStretchCap: 16 },
    levels: { ...common, a: { error: 1 }, b: { warn: 1, errorFraction: 0.15 }, c: { warn: 1, error: 2 },
      d: { warn: 1, error: 2 }, f: { warn: 1 }, g: { warn: 1 } } },
  analysis: { name: 'analysis', ceiling: DESKTOP_CEILING, meshing: { minAngle: deg(10), maxEdge: 0.05,
    elementaryStretchCap: 16 }, levels: { ...common, a: { error: 1 }, b: { error: 1 }, c: { warn: 1, error: 2 },
    d: { warn: 1, error: 2 }, f: { warn: 1, error: 1.5 }, g: { warn: 1, error: 1.5 } } },
};

/** One criterion's class for a face: with the measured value, its true limit and their ratio where it has them. */
export interface CriterionClass {
  class: FaceClass;
  value?: number;
  limit?: number;
  ratio?: number;
  /** Past the limit by an amount the backend didn't measure (c, d: tess-cadio's "failed, unmeasured"). */
  unmeasured?: boolean;
}

export interface FaceClasses {
  entityId: number;
  criteria: Record<Criterion, CriterionClass>;
  /** The worst of pass, warn and error over the criteria; unchecked and unverified ones don't make it worse. */
  overall: 'pass' | 'warn' | 'error';
}

/** What classify needs besides the record: the request's deflections (c's and d's true limits). */
export interface ClassifyContext { linearDeflection: number; angularDeflection: number }

/** A magnitude's class by its ratio to the true limit: past error, past warn, else passed. */
function byRatio(level: Level, ratio: number): FaceClass {
  if (level.error !== undefined && ratio > level.error) return 'error';
  if (level.warn !== undefined && ratio > level.warn) return 'warn';
  return 'pass';
}

/** A criterion without a magnitude, past its limit: its target's worst level for it, else passed. */
const past = (level: Level): FaceClass => (level.error !== undefined ? 'error' : level.warn !== undefined ? 'warn'
  : 'pass');

/** Face row `k` of `records` classed under `target`: each criterion as docs/triage.md's "The criteria" defines it. */
export function classify(records: FaceRecords, k: number, target: Target, ctx: ClassifyContext): FaceClasses {
  const L = target.levels;
  const r = <K extends keyof FaceRecords>(name: K) => (records[name] as unknown as ArrayLike<number>)[k]!;
  const c: Partial<Record<Criterion, CriterionClass>> = {};
  const triangles = r('triangles');
  // (k) complete.
  c.k = { class: triangles > 0 ? 'pass' : past(L.k), value: triangles };
  // (a) manifold: within the face (a.1; holes where known) and sewn into its shell (a.2, where joined).
  const within = r('nonManifoldEdges') + Math.max(0, r('holeEdges')), unsewn = r('unsewnEdges');
  c.a = within > 0 || unsewn > 0 ? { class: past(L.a), value: within + Math.max(0, unsewn) }
    : unsewn < 0 ? { class: 'unverified', value: 0 } : { class: 'pass', value: 0 };
  // (j) oriented: a shell turned over by orientResult (fixed, warned of).
  c.j = { class: r('orientation') === ORIENTATION.turned ? past(L.j) : 'pass' };
  // (b) area: the record's class against the true limit, an error past the target's fraction of the area.
  const cls = r('areaClass');
  if (cls === AREA.unverified) c.b = { class: 'unverified' };
  else if (cls === AREA.pass) c.b = { class: 'pass', value: r('area'), limit: r('oracleArea') };
  else {
    const a = r('oracleArea'), m = r('area'), off = Math.abs(m - a) / a;
    const lb = L.b;
    const cl: FaceClass = lb.errorFraction !== undefined ? (off > lb.errorFraction ? 'error' : lb.warn !== undefined
      ? 'warn' : 'pass') : past(lb);
    c.b = { class: cl, value: m, limit: a, ratio: off };
  }
  // (c) distance, (d) angle: the backend's own checks (tess-cadio's), else unchecked.
  const check = (which: 'c' | 'd', code: number, value: number, limit: number): CriterionClass => {
    if (code === CHECK.unchecked) return { class: 'unchecked' };
    if (code === CHECK.passed) return { class: 'pass', limit };
    // (Past the limit by an amount not measured: a warning, whatever the error level, which is a multiple we lack.)
    if (code === CHECK.failedUnmeasured) return { class: 'warn', limit, unmeasured: true };
    return { class: byRatio(L[which], value / limit), value, limit, ratio: value / limit };
  };
  const tol = r('tolerance');
  c.c = check('c', r('deviationCheck'), r('deviation'), Math.max(ctx.linearDeflection, Number.isFinite(tol) ? tol
    : 0));
  c.d = check('d', r('normalCheck'), r('normalAngle'), ctx.angularDeflection);
  // (e) turned against the shipped normals.
  const turned = r('turned');
  c.e = turned < 0 ? { class: 'unchecked' } : { class: turned > 0 ? past(L.e) : 'pass', value: turned };
  // (f) smallest angle: the ratio the limit over the angle (past 1 where smaller).
  const angle = r('minAngle'), fl = target.meshing.minAngle;
  c.f = Number.isNaN(angle) ? { class: 'pass' } : { class: byRatio(L.f, fl / angle), value: angle, limit: fl,
    ratio: fl / angle };
  // (g) longest edge, against the target's fraction of the part's size (none: passed).
  const frac = target.meshing.maxEdge, size = records.partSize, longest = r('longestEdge');
  c.g = frac === undefined ? { class: 'pass', value: longest } : !(size > 0) ? { class: 'unverified', value: longest }
    : { class: byRatio(L.g, longest / (frac * size)), value: longest, limit: frac * size,
      ratio: longest / (frac * size) };
  // (h) triangles: min(ceiling, max(floor, multiple x expected)); without a count, passed to the floor, an error past
  // the ceiling, unverified between.
  const expected = r('expectedSource') === EXPECTED.none ? NaN : r('expected');
  if (Number.isFinite(expected)) {
    const limit = Math.min(target.ceiling, Math.max(H_FLOOR, H_MULTIPLE * expected));
    c.h = { class: byRatio(L.h, triangles / limit), value: triangles, limit, ratio: triangles / limit };
  } else {
    c.h = triangles > target.ceiling ? { class: past(L.h), value: triangles, limit: target.ceiling }
      : triangles > H_FLOOR ? { class: 'unverified', value: triangles } : { class: 'pass', value: triangles };
  }
  // (l) degenerate triangles (dropped and counted).
  const degenerate = r('degenerate');
  c.l = { class: degenerate > 0 ? past(L.l) : 'pass', value: degenerate };
  // (i) self-intersection: not checked.
  c.i = { class: 'unchecked' };
  const criteria = c as Record<Criterion, CriterionClass>;
  const classes = CRITERIA.map((x) => criteria[x].class);
  const overall = classes.includes('error') ? 'error' : classes.includes('warn') ? 'warn' : 'pass';
  return { entityId: records.entityId[k]!, criteria, overall };
}

/** Every face of `records` classed (classify), with the count of faces per criterion and class. */
export function classifyAll(records: FaceRecords, target: Target, ctx: ClassifyContext): {
  faces: FaceClasses[]; counts: Record<Criterion, Record<FaceClass, number>>;
} {
  const faces = Array.from(records.entityId, (_, k) => classify(records, k, target, ctx));
  const counts = Object.fromEntries(CRITERIA.map((x) => [x, { pass: 0, warn: 0, error: 0, unchecked: 0,
    unverified: 0 }])) as Record<Criterion, Record<FaceClass, number>>;
  for (const f of faces) for (const x of CRITERIA) counts[x][f.criteria[x].class]++;
  return { faces, counts };
}

/** Each criterion's true limit, as a formula, for describeTarget. */
const FORMULAS: Readonly<Record<Criterion, string>> = {
  k: 'complete: the face has triangles',
  a: 'manifold: within the face (no edge used 3+ times or twice one way, no hole) and sewn into its shell',
  j: 'oriented: a closed shell\'s mesh faces out (turned over where it faces in)',
  b: 'area: short by more than max(3 % of A, d x P), over by more than max(10 % of A, d x P), A the oracle\'s',
  c: 'distance from the surface: max(d, the face\'s tolerance) (unchecked for foreign backends)',
  d: 'angle between normals: the angular deflection (unchecked for foreign backends)',
  e: 'turned triangles (a facet against its corners\' normals): none',
  f: 'smallest triangle angle: the target\'s minAngle (the ratio the limit over the angle)',
  g: 'longest edge: the target\'s fraction of the part\'s size (partSize), where it sets one',
  h: `triangles per face: min(ceiling, max(${H_FLOOR.toLocaleString('en')}, ${H_MULTIPLE} x the face's expected `
    + 'count))',
  l: 'degenerate triangles (two corners at one position): none',
  i: 'self-intersection: not checked',
};

/** The criteria past their limit or not, without a magnitude. */
const BINARY: ReadonlySet<Criterion> = new Set(['k', 'a', 'j', 'e', 'l']);

/** A level in words: "warn past 1 x; error past 10 x", "error" (a criterion without a magnitude), "allowed". */
function levelWords(x: Criterion, l: Level): string {
  if (BINARY.has(x)) return l.error !== undefined ? 'error' : l.warn !== undefined ? 'warn' : 'allowed';
  const parts: string[] = [];
  if (l.warn !== undefined) parts.push(`warn past ${l.warn} x`);
  if (l.errorFraction !== undefined) parts.push(`error past ${100 * l.errorFraction} % of the area`);
  else if (l.error !== undefined) parts.push(`error past ${l.error} x`);
  return parts.length ? parts.join('; ') : x === 'i' ? 'allowed' : 'never';
}

/** The target's effective settings, a line per criterion with its true limit's formula, and its meshing limits. */
export function describeTarget(t: Target): string {
  const lines = [`target ${t.name}:`];
  for (const x of CRITERIA) lines.push(`  ${x}  ${FORMULAS[x]}: ${levelWords(x, t.levels[x])}`);
  const m = t.meshing;
  lines.push(`  ceiling (h): ${t.ceiling.toLocaleString('en')} triangles a face`);
  lines.push(`  meshing limits (not yet applied): smallest angle ${+(m.minAngle * 180 / Math.PI).toFixed(2)} deg`
    + `${m.maxEdge !== undefined ? `, longest edge ${100 * m.maxEdge} % of the part's size` : ''}`
    + `${m.elementaryStretchCap !== undefined ? `, elementary faces' stretch capped at ${m.elementaryStretchCap}`
      : ''}`);
  return lines.join('\n') + '\n';
}
