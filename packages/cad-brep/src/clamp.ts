// Clamping B-splines (docs/brep-reference.md, "The canonical model", rule 6): a curve or surface whose end knots
// haven't full multiplicity (degree + 1) rewritten, by knot insertion, as the same curve over its valid range (from
// the knot at index degree to the knot at index n of the flat knot vector) with end knots of full multiplicity. Its
// parameterization doesn't change, so p-curves on a clamped surface and ranges on a clamped curve stay as they are.
// Rational ones in homogeneous coordinates. Exact but for rounding (each insertion is a convex combination).

/** Knots with multiplicities, flattened. */
function flat(knots: readonly number[], mults: readonly number[]): number[] {
  return knots.flatMap((k, i) => Array<number>(mults[i]!).fill(k));
}

/** Flat knots back to distinct knots and multiplicities. */
function grouped(u: readonly number[]): { knots: number[]; multiplicities: number[] } {
  const knots: number[] = [], multiplicities: number[] = [];
  for (const x of u) {
    if (knots.length && knots[knots.length - 1] === x) multiplicities[multiplicities.length - 1]!++;
    else { knots.push(x); multiplicities.push(1); }
  }
  return { knots, multiplicities };
}

/**
 * Inserts knot t once into a degree-p B-spline of control points `q` (each a vector, homogeneous where rational) on
 * flat knots `u` (Boehm's algorithm).
 */
function insert(p: number, u: number[], q: number[][], t: number): { u: number[]; q: number[][] } {
  // k: the last knot span index with u[k] <= t < u[k + 1] (t at a knot: after the knots equal to it).
  let k = p;
  while (k + 1 < u.length - p - 1 && u[k + 1]! <= t) k++;
  const out: number[][] = [];
  for (let i = 0; i <= q.length; i++) {
    if (i <= k - p) out.push(q[i]!);
    else if (i > k) out.push(q[i - 1]!);
    else {
      const a = (t - u[i]!) / (u[i + p]! - u[i]!);
      out.push(q[i]!.map((x, j) => (1 - a) * q[i - 1]![j]! + a * x));
    }
  }
  return { u: [...u.slice(0, k + 1), t, ...u.slice(k + 1)], q: out };
}

/**
 * One direction of a B-spline clamped: degree p, flat knots u, control vectors q (n of them). Undefined when already
 * clamped.
 */
function clampFlat(p: number, u0: readonly number[], q0: readonly number[][]): { u: number[]; q: number[][] }
  | undefined {
  // (Knots that don't fit the poles, or no valid range: left as they are, validateBrep's to say.)
  if (!(p >= 1) || q0.length <= p || u0.length !== q0.length + p + 1 || !u0.every(Number.isFinite)) return undefined;
  if (!(u0[p]! < u0[q0.length]!) || u0.some((x, i) => i > 0 && x < u0[i - 1]!)) return undefined;
  let u = [...u0], q = q0.map((x) => [...x]);
  const n = q.length;
  const a = u[p]!, b = u[n]!;
  const startFull = u.slice(0, p + 1).every((x) => x === a), endFull = u.slice(n).every((x) => x === b);
  if (startFull && endFull) return undefined;
  const count = (t: number) => u.filter((x) => x === t).length;
  const full = (t: number) => Array<number>(p + 1).fill(t);
  // Each end to multiplicity p at least by insertion; then the knots and poles beyond the valid range dropped and
  // the end knot given multiplicity p + 1: the end pole the curve's point there.
  if (!startFull) {
    while (count(a) < p) ({ u, q } = insert(p, u, q, a));
    const i0 = u.indexOf(a), m = count(a);
    u = [...full(a), ...u.slice(i0 + m)];
    q = q.slice(i0 + m - p - 1);
  }
  if (!endFull) {
    while (count(b) < p) ({ u, q } = insert(p, u, q, b));
    const first = u.indexOf(b);
    u = [...u.slice(0, first), ...full(b)];
    q = q.slice(0, u.length - p - 1);
  }
  return { u, q };
}

/** A B-spline curve's degree, knots, multiplicities, poles and weights, clamped; undefined if already clamped. */
export function clampCurve(c: { degree: number; knots: number[]; multiplicities: number[]; poles: number[][];
  weights?: number[] }): { knots: number[]; multiplicities: number[]; poles: number[][]; weights?: number[] }
  | undefined {
  const w = c.weights;
  const q = c.poles.map((pt, i) => w ? [...pt.map((x) => x * w[i]!), w[i]!] : [...pt]);
  const r = clampFlat(c.degree, flat(c.knots, c.multiplicities), q);
  if (!r) return undefined;
  const dim = c.poles[0]!.length;
  return { ...grouped(r.u), poles: r.q.map((x) => w ? x.slice(0, dim).map((v) => v / x[dim]!) : x),
    ...(w ? { weights: r.q.map((x) => x[dim]!) } : {}) };
}

/**
 * A B-spline surface clamped in each direction that needs it (poles[i][j]: u index i, v index j); undefined if
 * already clamped.
 */
export function clampSurface(s: { uDegree: number; vDegree: number; uKnots: number[]; vKnots: number[];
  uMultiplicities: number[]; vMultiplicities: number[]; poles: number[][][]; weights?: number[][] }): {
  uKnots: number[]; vKnots: number[]; uMultiplicities: number[]; vMultiplicities: number[]; poles: number[][][];
  weights?: number[][] } | undefined {
  const w = s.weights;
  // Homogeneous control net: net[i][j].
  let net = s.poles.map((row, i) => row.map((pt, j) => w ? [...pt.map((x) => x * w[i]![j]!), w[i]![j]!] : [...pt]));
  let uFlat = flat(s.uKnots, s.uMultiplicities), vFlat = flat(s.vKnots, s.vMultiplicities), changed = false;
  // u: each column (fixed j) along i; the knots come out the same for every column.
  const cols = net[0]!.length;
  const byCol = Array.from({ length: cols }, (_, j) => clampFlat(s.uDegree, uFlat, net.map((row) => row[j]!)));
  if (byCol[0]) {
    changed = true;
    uFlat = byCol[0].u;
    net = byCol[0].q.map((_, i) => byCol.map((c) => c!.q[i]!));
  }
  const byRow = net.map((row) => clampFlat(s.vDegree, vFlat, row));
  if (byRow[0]) {
    changed = true;
    vFlat = byRow[0].u;
    net = byRow.map((r) => r!.q);
  }
  if (!changed) return undefined;
  const u = grouped(uFlat), v = grouped(vFlat);
  return { uKnots: u.knots, uMultiplicities: u.multiplicities, vKnots: v.knots, vMultiplicities: v.multiplicities,
    poles: net.map((row) => row.map((x) => w ? x.slice(0, 3).map((c) => c / x[3]!) : x)),
    ...(w ? { weights: net.map((row) => row.map((x) => x[3]!)) } : {}) };
}
