// Two B-rep models compared as walks from their items, for the writer's checks (geometry.test.ts,
// corpus_checks/step_route.ts): a model written and read back is the same walk, up to row order, new ids, what STEP
// can't hold, and the last bits of numbers that pass through a unit conversion or a normalization.

import { type BrepData, decode, rowCount } from 'cad-brep';

/**
 * A model as a walk from its items: each row written out where first reached, later uses as its kind and order of
 * reaching; so two models equal up to row order walk the same. Rows no item reaches aren't in it. Left out: what STEP
 * can't hold (tolerances, parameter ranges, the kinds a source declared for shells and bodies), and items' ids but
 * points' (STEP's item is the body, curve, surface or face itself).
 */
export function walk(d: BrepData): unknown[] {
  const seen = new Map<string, number>();
  const strip = (o: Record<string, unknown>) => {
    const { tolerance: _t, range: _r, declared: _d, ...rest } = o;
    return rest;
  };
  const visit = (kind: string, k: number, expand: () => unknown): unknown => {
    const key = `${kind}${k}`;
    if (seen.has(key)) return `${kind}@${seen.get(key)}`;
    seen.set(key, seen.size);
    return expand();
  };
  const curve = (k: number): unknown => visit('curve', k, () => {
    const c = decode.curve(d, k);
    if (c.kind === 'trimmed' || c.kind === 'offset') return { ...c, basis: curve(c.basis) };
    if (c.kind === 'composite') return { ...c, segments: c.segments.map((s) => ({ ...s, curve: curve(s.curve) })) };
    return c;
  });
  const surface = (k: number): unknown => visit('surface', k, () => {
    const s = decode.surface(d, k);
    if (s.kind === 'extrusion' || s.kind === 'revolution') return { ...s, curve: curve(s.curve) };
    if (s.kind === 'offset' || s.kind === 'rectangularTrimmed') return { ...s, basis: surface(s.basis) };
    if (s.kind === 'curveSwept') {
      return { ...s, curve: curve(s.curve), directrix: curve(s.directrix),
        referenceSurface: surface(s.referenceSurface) };
    }
    if (s.kind === 'fixedReferenceSwept') return { ...s, curve: curve(s.curve), directrix: curve(s.directrix) };
    return s;
  });
  const vertex = (k: number) => visit('vertex', k, () => strip({ ...decode.vertex(d, k) }));
  const edge = (k: number) => visit('edge', k, () => {
    const e = decode.edge(d, k);
    const opt = (k: number | undefined, f: (k: number) => unknown) => k === undefined ? undefined : f(k);
    return strip({ ...e, curve: opt(e.curve, curve), start: opt(e.start, vertex), end: opt(e.end, vertex) });
  });
  const face = (k: number) => visit('face', k, () => {
    const f = decode.face(d, k);
    return strip({ ...f, surface: surface(f.surface), loops: f.loops.map((l) => {
      if (l.kind === 'edge') {
        return { ...l, coedges: l.coedges.map((c) => strip({ ...c, edge: edge(c.edge),
          pcurve: c.pcurve === undefined ? undefined : curve(c.pcurve) })) };
      }
      return l.kind === 'vertex' ? { ...l, vertex: vertex(l.vertex) } : l;
    }) });
  });
  const shell = (k: number) => visit('shell', k, () => {
    const s = decode.shell(d, k);
    return strip({ ...s, faces: s.faces.map((u) => ({ ...u, face: face(u.face) })) });
  });
  const body = (k: number) => visit('body', k, () => {
    const b = decode.body(d, k);
    return strip({ ...b, members: b.members.map((m) => ({ ...m, ref: b.kind === 'wire' ? edge(m.ref)
      : shell(m.ref) })) });
  });
  const out: unknown[] = [decode.part(d)];
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    const it = decode.item(d, k);
    if (it.kind === 'point') out.push(it);
    else if (it.kind !== 'instance') {
      const { id: _id, ...rest } = it;
      out.push({ ...rest, ref: { body, curve, surface, face }[it.kind](it.ref) });
    }
  }
  return JSON.parse(JSON.stringify(out));
}

/** Direction components (unit vectors, normalized again by a reader): their last bits are absolute, not relative. */
const DIRECTION = /\.(direction|axis|xDir|refDirection|axisDirection|fixedReference)\[\d+\]$/;
/** Last bits: within this many units in the last place. */
export const LAST_BITS = 4;

export interface Difference {
  path: string;
  /** Only in the last bits (a unit conversion, a normalization), or more. */
  bits: boolean;
  /** The relative difference, for numbers. */
  rel?: number;
}

/** Where `b`'s walk differs from `a`'s; ids only `b` has (new ones) aren't differences. */
export function differences(a: unknown, b: unknown, path = '', out: Difference[] = []): Difference[] {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || b.length !== a.length) out.push({ path: `${path}.length`, bits: false });
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { out.push({ path, bits: false }); return out; }
    const keys = new Set([...Object.keys(a), ...Object.keys(b).filter((k) => k !== 'id' || 'id' in a)]);
    const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
    for (const k of keys) differences(ra[k], rb[k], `${path}.${k}`, out);
  } else if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return out;
    const scale = DIRECTION.test(path) ? 1 : Math.max(Math.abs(a), Math.abs(b));
    const rel = Math.abs(a - b) / scale;
    out.push({ path, bits: rel <= LAST_BITS * Number.EPSILON, rel });
  } else if (a !== b) out.push({ path, bits: false });
  return out;
}
