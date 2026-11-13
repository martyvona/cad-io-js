// The oracle of lengths in millimetres (docs/brep-reference.md's list of what's a length, written here from it, not
// from step-import): a B-rep model read from a file, against the same model read from the file with its length unit
// changed (every length k times as long): each real times k where it's a length, the same where it isn't, a p-curve's
// coordinates times its surface's factors on (u, v) (k on a length parameter: a plane's u and v, a cylinder's and
// cone's v; a 2D line by its direction times its magnitude), ints and ids the same. For step-import's tests and
// corpus_checks/unit_scale.ts.

import { type BrepData, CURVE_KIND, ITEM_KIND, LOOP_KIND, rowCount, SURFACE_KIND, TABLES, type TableName }
  from 'cad-brep';

/** Where a problem goes: its kind, an example, a count. */
export type Report = (what: string, example: string, n?: number) => void;

type F = [number, number];
/**
 * The oracle: for each real of a model, the factor it takes (k a length, 1 not), per pool and table column. 2D curves
 * by their uses' surfaces; a 2D line's direction and magnitude apart (`lines2d`: their offsets, checked as a vector).
 */
function expectations(d: BrepData, k: number, note: Report) {
  const curve = new Map<number, number>(), surface = new Map<number, number>(), item = new Map<number, number>();
  const lines2d: { at: number; f: F }[] = [];
  const ci = d.pool.curveInt, si = d.pool.surfaceInt;
  // Each surface's factors on (u, v).
  const sfac = (s: number): F => {
    const kind = d.surface.kind[s]!;
    if (kind === SURFACE_KIND.plane) return [k, k];
    if (kind === SURFACE_KIND.cylinder || kind === SURFACE_KIND.cone) return [1, k];
    if (kind === SURFACE_KIND.offset || kind === SURFACE_KIND.rectangularTrimmed) return sfac(si[d.surface.int[s]!]!);
    return [1, 1];
  };
  // Each 2D curve's factors, from the coedges using it, handed to the curves it's made of.
  const f2 = new Map<number, F>();
  const give = (c: number, f: F, at: string) => {
    const had = f2.get(c);
    if (had && (had[0] !== f[0] || had[1] !== f[1])) {
      note('a 2D row used at two scales (the oracle takes the first)', at);
    }
    if (had) return;
    f2.set(c, f);
    const kind = d.curve.kind[c]!, i = d.curve.int[c]!;
    if (kind === CURVE_KIND.trimmed || kind === CURVE_KIND.offset) give(ci[i]!, f, at);
    if (kind === CURVE_KIND.composite) for (let j = 0; j < ci[i]!; j++) give(ci[i + 2 + 3 * j]!, f, at);
  };
  for (let fc = 0; fc < rowCount(d, 'face'); fc++) {
    const f = sfac(d.face.surface[fc]!);
    for (let l = d.face.firstLoop[fc]!; l < d.face.firstLoop[fc]! + d.face.loopCount[fc]!; l++) {
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        if (d.coedge.pcurve[c]! >= 0) give(d.coedge.pcurve[c]!, f, `face row ${fc}`);
      }
    }
  }
  const set = (m: Map<number, number>, at: number, n: number, x: number) => {
    for (let j = 0; j < n; j++) m.set(at + j, x);
  };
  // A run of points: each coordinate its factor.
  const pts = (m: Map<number, number>, at: number, n: number, dim: number, f: F | undefined) => {
    for (let j = 0; j < n; j++) for (let c = 0; c < dim; c++) m.set(at + j * dim + c, dim === 3 ? k : f![c]!);
  };
  // (A 2D row no coedge uses, as a seam's whose uses couldn't be told apart: its surface unknown, its reals unchecked.)
  const unused: number[] = [];
  for (let c = 0; c < rowCount(d, 'curve'); c++) {
    const kind = d.curve.kind[c]!, dim = d.curve.dim[c]!, r = d.curve.real[c]!, i = d.curve.int[c]!;
    if (dim === 2 && !f2.has(c)) { unused.push(c); continue; }
    const f = dim === 2 ? f2.get(c)! : undefined, len = dim === 3 ? k : f![0];
    const placement = () => {
      pts(curve, r, 1, dim, f);
      set(curve, r + dim, dim === 3 ? 6 : 2, 1);
      return dim === 3 ? 9 : 4;
    };
    switch (kind) {
      case CURVE_KIND.line:
        pts(curve, r, 1, dim, f);
        if (dim === 2) lines2d.push({ at: r + 2, f: f! });
        else { set(curve, r + 3, 3, 1); curve.set(r + 6, k); }
        break;
      case CURVE_KIND.circle: case CURVE_KIND.parabola: curve.set(r + placement(), len); break;
      case CURVE_KIND.ellipse: case CURVE_KIND.hyperbola: set(curve, r + placement(), 2, len); break;
      case CURVE_KIND.bspline: {
        const n = ci[i + 1]!, nk = ci[i + 2]!, rational = ci[i + 3]! === 1;
        set(curve, r, nk, 1);
        pts(curve, r + nk, n, dim, f);
        if (rational) set(curve, r + nk + n * dim, n, 1);
        break;
      }
      case CURVE_KIND.polyline: pts(curve, r, ci[i]!, dim, f); break;
      case CURVE_KIND.trimmed: set(curve, r, 2, 1); pts(curve, r + 2, 2, dim, f); break;
      case CURVE_KIND.offset: curve.set(r, len); if (dim === 3) set(curve, r + 1, 3, 1); break;
      default: break; // composite: no reals
    }
  }
  for (let s = 0; s < rowCount(d, 'surface'); s++) {
    const kind = d.surface.kind[s]!, r = d.surface.real[s]!, i = d.surface.int[s]!;
    const placement = () => { set(surface, r, 3, k); set(surface, r + 3, 6, 1); };
    switch (kind) {
      case SURFACE_KIND.plane: placement(); break;
      case SURFACE_KIND.cylinder: case SURFACE_KIND.sphere: placement(); surface.set(r + 9, k); break;
      case SURFACE_KIND.cone: placement(); surface.set(r + 9, k); surface.set(r + 10, 1); break;
      case SURFACE_KIND.torus: placement(); set(surface, r + 9, 2, k); break;
      case SURFACE_KIND.bspline: {
        const nu = si[i + 2]!, nv = si[i + 3]!, ku = si[i + 4]!, kv = si[i + 5]!, rational = si[i + 6]! === 1;
        set(surface, r, ku + kv, 1);
        set(surface, r + ku + kv, nu * nv * 3, k);
        if (rational) set(surface, r + ku + kv + nu * nv * 3, nu * nv, 1);
        break;
      }
      case SURFACE_KIND.extrusion: set(surface, r, 3, 1); surface.set(r + 3, k); break;
      case SURFACE_KIND.revolution: set(surface, r, 3, k); set(surface, r + 3, 3, 1); break;
      case SURFACE_KIND.offset: surface.set(r, k); break;
      case SURFACE_KIND.rectangularTrimmed: {
        const [fu, fv] = sfac(si[i]!);
        set(surface, r, 2, fu); set(surface, r + 2, 2, fv);
        break;
      }
      case SURFACE_KIND.fixedReferenceSwept: set(surface, r, 3, 1); break;
      default: break;
    }
  }
  for (let t = 0; t < rowCount(d, 'item'); t++) {
    if (d.item.kind[t] === ITEM_KIND.point) set(item, d.item.ref[t]!, 3, k);
  }
  return { curve, surface, item, lines2d, unused };
}

/**
 * A model against the same model read from the same file with its length unit `k` times as long: problems to
 * `note` (kind of problem, example), and whether it agrees, with the count of values checked.
 */
export function compareScaled(a: BrepData, b: BrepData, k: number, where: string, note: Report):
  { ok: boolean; checked: number } {
  let ok = true, realsChecked = 0;
  const bad = (what: string, ex: string) => { note(what, `${where}: ${ex}`); ok = false; };
  for (const t of Object.keys(TABLES) as TableName[]) {
    if (t === 'pool') continue;
    if (rowCount(a, t) !== rowCount(b, t)) {
      bad(`${t} rows differ in number`, `${rowCount(a, t)}, ${rowCount(b, t)}`);
      return { ok: false, checked: realsChecked };
    }
  }
  const near = (x: number, y: number) => Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y))
    || Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y), 1e-300);
  // Columns: ints the same; reals by what they are (vertex points, tolerances, the uncertainty lengths; ranges not).
  const LENGTH_COLUMNS = new Set(['vertex.point', 'vertex.tolerance', 'edge.tolerance', 'face.tolerance',
    'part.uncertainty']);
  for (const [t, cols] of Object.entries(TABLES) as [TableName, readonly (readonly [string, string, number])[]][]) {
    if (t === 'pool') continue;
    for (const [c, type] of cols) {
      const x = (a as unknown as Record<string, Record<string, ArrayLike<number>>>)[t]![c]!;
      const y = (b as unknown as Record<string, Record<string, ArrayLike<number>>>)[t]![c]!;
      const f = type === 'f64' && LENGTH_COLUMNS.has(`${t}.${c}`) ? k : 1;
      for (let j = 0; j < x.length; j++) {
        realsChecked++;
        if (!near(x[j]! * f, y[j]!)) {
          bad(`${t}.${c} ${f === 1 ? 'changed' : 'not times k'}`, `[${j}] ${x[j]}, ${y[j]}`);
          break;
        }
      }
    }
  }
  for (const pool of ['curveInt', 'surfaceInt', 'loopInt'] as const) {
    const x = a.pool[pool], y = b.pool[pool];
    if (x.length !== y.length || x.some((v, j) => v !== y[j])) bad(`pool.${pool} differs`, '');
  }
  const e = expectations(a, k, note);
  const line2d = new Set(e.lines2d.flatMap((l) => [l.at, l.at + 1, l.at + 2]));
  // Unused 2D rows' reals: from each one's offset to the next row's (rows' reals are in row order).
  const skip = new Set<number>();
  for (const c of e.unused) {
    const end = c + 1 < rowCount(a, 'curve') ? a.curve.real[c + 1]! : a.pool.curveReal.length;
    for (let j = a.curve.real[c]!; j < end; j++) skip.add(j);
  }
  if (e.unused.length) note('2D rows no coedge uses (their surface unknown: not checked)', where, e.unused.length);
  for (const [pool, map] of [['curveReal', e.curve], ['surfaceReal', e.surface], ['itemReal', e.item]] as const) {
    const x = a.pool[pool], y = b.pool[pool];
    if (x.length !== y.length) { bad(`pool.${pool} lengths differ`, `${x.length}, ${y.length}`); continue; }
    for (let j = 0; j < x.length; j++) {
      if (pool === 'curveReal' && (line2d.has(j) || skip.has(j))) continue;
      const f = map.get(j);
      if (f === undefined) { bad(`pool.${pool}: a real the oracle doesn't place`, `[${j}]`); break; }
      realsChecked++;
      if (!near(x[j]! * f, y[j]!)) {
        bad(`pool.${pool}: ${f === 1 ? 'changed' : 'not scaled as its kind says'}`, `[${j}] ${x[j]} x ${f}, ${y[j]}`);
        break;
      }
    }
  }
  // 2D lines: direction x magnitude, each coordinate times its factor.
  for (const { at, f } of e.lines2d) {
    const [xa, xb] = [a.pool.curveReal, b.pool.curveReal];
    for (let c = 0; c < 2; c++) {
      realsChecked++;
      if (!near(xa[at + c]! * xa[at + 2]! * f[c]!, xb[at + c]! * xb[at + 2]!)) {
        bad('a 2D line\'s vector not scaled as its surface\'s parameters', `[${at}]`);
        break;
      }
    }
  }
  return { ok, checked: realsChecked };
}

