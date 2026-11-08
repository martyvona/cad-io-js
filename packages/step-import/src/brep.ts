// A STEP shape representation's geometry and topology to a B-rep buffer (cad-brep), by the model's rules
// (docs/brep-model.md): Part 42's parameterizations with angles in radians (trim parameters on circles and ellipses,
// cone semi-angles, p-curves' angular coordinates and rectangular trims on angular surfaces, converted from the file's
// plane angle unit), placements complete (Part 42's build_axes, step-parser's `placement`), directions unit with
// magnitudes kept, uniform, quasi-uniform and Bezier B-splines with their knots made explicit (as OCCT reads them),
// p-curves on the coedges of the faces whose surfaces they lie on, every row's id its STEP instance's. A
// SURFACE_CURVE is its 3D curve's row. Problems are diagnostics, repeated ones said once with a count; what can't be
// read is left out (an edge keeps its vertices without a curve it can't read; a face without its surface is dropped).

import {
  BrepBuilder, type BrepData, type Coedge, type Curve, type CurveEvaluator, curveEvaluatorOf, CURVE_FORMS,
  type CurveForm, type Edge, type Loop, type Point,
  type Surface, SURFACE_FORMS, type SurfaceForm, type Transition, TRANSITIONS,
} from 'cad-brep';
import { listItems, numbersOf, placement, type Reader, type Value } from 'step-parser';

export interface StepBrepOptions {
  /** The part's length unit in millimetres. */
  unit: number;
  /** Radians per the file's plane angle unit (1 for radians). */
  angle: number;
  /** The context's uncertainty in the part's unit, if it gives one. */
  uncertainty?: number;
}

export interface StepBrepResult {
  brep: BrepData;
  /** Rows made, by kind of STEP entity read (face, edge, vertex, curve, surface, shell, body, item). */
  counts: Record<string, number>;
  /** Seams on a face whose two p-curves couldn't be told apart, so neither use has one. */
  seams: number;
}

export type Warn = (message: string, severity?: 'error' | 'warning' | 'info') => void;

/** Items that carry nothing of the part's geometry: skipped without a word. */
const SILENT = ['AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'MAPPED_ITEM', 'STYLED_ITEM', 'TEXT_LITERAL',
  'COMPOSITE_TEXT', 'DRAUGHTING_CALLOUT', 'ANNOTATION_OCCURRENCE', 'CARTESIAN_TRANSFORMATION_OPERATOR'];
/** Up to this many ids in a repeated problem's diagnostic. */
const MAX_IDS = 5;

type Scale = [number, number];
const ONE: Scale = [1, 1];

/** Part 42's implicit knots for a B-spline form, from its poles and degree, as OCCT reads them (StepToGeom). */
export function implicitKnots(form: 'uniform' | 'quasi' | 'bezier', poles: number, degree: number):
  { knots: number[]; multiplicities: number[] } | undefined {
  let n: number, end: number, interior: number;
  if (form === 'uniform') [n, end, interior] = [poles + degree + 1, 1, 1];
  else if (form === 'quasi') [n, end, interior] = [poles - degree + 1, degree + 1, 1];
  else {
    // Piecewise Bezier: segments of `degree` + 1 poles sharing their ends, interior knots of multiplicity `degree`.
    if ((poles - 1) % degree) return undefined;
    [n, end, interior] = [(poles - 1) / degree + 1, degree + 1, degree];
  }
  if (n < 2) return undefined;
  const multiplicities = Array<number>(n).fill(interior);
  multiplicities[0] = multiplicities[n - 1] = end;
  return { knots: Array.from({ length: n }, (_, i) => i), multiplicities };
}

/** Knot values repeated in a list (zero-length spans some writers emit) folded into one, multiplicities summed. */
export function foldKnots(knots: number[], mults: number[]):
  { knots: number[]; multiplicities: number[]; folded: boolean } {
  const k: number[] = [], m: number[] = [];
  knots.forEach((x, i) => {
    if (k.length && x === k[k.length - 1]) m[m.length - 1]! += mults[i]!;
    else { k.push(x); m.push(mults[i]!); }
  });
  return { knots: k, multiplicities: m, folded: k.length !== knots.length };
}

const dimOf = (c: Curve, specs: Curve[]): number => {
  switch (c.kind) {
    case 'line': return c.point.length;
    case 'circle': case 'ellipse': case 'hyperbola': case 'parabola': return c.position.origin.length;
    case 'bspline': return c.poles[0]!.length;
    case 'polyline': return c.points[0]!.length;
    case 'trimmed': case 'offset': return dimOf(specs[c.basis]!, specs);
    case 'composite': return dimOf(specs[c.segments[0]!.curve]!, specs);
  }
};

/** The B-rep of a shape representation's items (positions), in its unit. */
export function stepBrep(r: Reader, items: number[], o: StepBrepOptions, warn: Warn): StepBrepResult {
  const b = new BrepBuilder({ unit: o.unit, ...(o.uncertainty !== undefined ? { uncertainty: o.uncertainty } : {}) });
  const A = o.angle;
  const counts: Record<string, number> = {};
  const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  /** Seams whose p-curves couldn't be given to their uses (edge and surface positions), counted once each. */
  const seamsMet = new Set<string>();

  // Problems seen many times are said once, with a count and the first few ids.
  const problems = new Map<string, { n: number; ids: number[]; severity: 'error' | 'warning' | 'info' }>();
  const note = (message: string, p: number, severity: 'error' | 'warning' | 'info' = 'warning'): undefined => {
    const x = problems.get(message) ?? { n: 0, ids: [], severity };
    x.n++;
    if (x.ids.length < MAX_IDS && p >= 0) x.ids.push(r.id(p));
    problems.set(message, x);
    return undefined;
  };
  const types = (p: number) => r.model.types(p).join('+');
  const missing = (what: string, p: number) =>
    note(p < 0 ? `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} missing from the file`
      : `an unsupported ${what} (${types(p)})`, p);

  // -- Values.
  const id = (p: number) => r.id(p);
  const num = (p: number, name: string) => r.num(p, name);
  const logical = (p: number, name: string): boolean | null => {
    const v = r.attr(p, name);
    return v?.k === 'enum' ? (v.v === 'T' ? true : v.v === 'F' ? false : null) : null;
  };
  const bool = (p: number, name: string, dflt = true): boolean => {
    const v = r.attr(p, name);
    return v?.k === 'enum' ? v.v === 'T' : dflt;
  };
  const unit = (v: number[]) => {
    const l = Math.hypot(...v);
    return l > 0 && Number.isFinite(l) ? v.map((x) => x / l) : undefined;
  };
  const coords = (p: number): number[] | undefined => {
    if (!r.is(p, 'CARTESIAN_POINT')) return undefined;
    const c = numbersOf(r.attr(p, 'coordinates'));
    return c && (c.length === 2 || c.length === 3) && c.every(Number.isFinite) ? c : undefined;
  };
  const dir = (p: number): number[] | undefined => {
    if (!r.is(p, 'DIRECTION')) return undefined;
    const c = numbersOf(r.attr(p, 'direction_ratios'));
    return c && (c.length === 2 || c.length === 3) ? unit(c) : undefined;
  };
  /** A list's elements, whichever form it was decoded in (lists of numbers and references are typed arrays). */
  const listOf = (v: Value | undefined): Value[] =>
    v?.k === 'list' || v?.k === 'reals' || v?.k === 'ints' || v?.k === 'refs' ? listItems(v) : [];
  /** The positions an attribute refers to, in order (-1 for what isn't a reference that resolves). */
  const refsOf = (v: Value | undefined): number[] =>
    (v && listOf(v).length === 0 && v.k === 'ref' ? [v] : listOf(v))
      .map((e) => e.k === 'ref' ? r.model.resolve(e.v as number) : -1);
  const points = (v: Value | undefined): number[][] | undefined => {
    const out: number[][] = [];
    for (const q of refsOf(v)) {
      const c = coords(q);
      if (!c) return undefined;
      out.push(c);
    }
    return out.length ? out : undefined;
  };
  /** A placement's origin, axis and x direction, completed as Part 42 does. */
  const place = (p: number, dim: 2 | 3) => {
    if (!r.is(p, dim === 3 ? 'AXIS2_PLACEMENT_3D' : 'AXIS2_PLACEMENT_2D')) return undefined;
    const m = placement(r, p);
    if (!m) return undefined;
    return dim === 3 ? { origin: [m[12]!, m[13]!, m[14]!], axis: [m[8]!, m[9]!, m[10]!], xDir: [m[0]!, m[1]!, m[2]!] }
      : { origin: [m[12]!, m[13]!], xDir: [m[0]!, m[1]!] };
  };
  /** A VECTOR: unit direction and magnitude. */
  const vector = (p: number) => {
    const d = r.is(p, 'VECTOR') ? dir(r.ref(p, 'orientation')) : undefined;
    const m = num(p, 'magnitude');
    return d && m !== undefined && m > 0 && Number.isFinite(m) ? { direction: d, magnitude: m } : undefined;
  };
  const scaled = (c: number[], s: Scale) => c.length === 2 ? [c[0]! * s[0], c[1]! * s[1]] : c;
  const isOne = (s: Scale) => s[0] === 1 && s[1] === 1;

  // -- Curves. A 2D curve (a p-curve's geometry) may be scaled, its coordinates times (su, sv) to make radians of an
  // angular surface's parameters: such a curve is a row of its own per scale.
  const curves = new Map<string, number | null>();
  const specs: Curve[] = [];
  function curve(p: number, s: Scale = ONE): number | undefined {
    if (r.is(p, 'SURFACE_CURVE')) return curve(r.ref(p, 'curve_3d'), s);
    const key = isOne(s) ? `${p}` : `${p}:${s[0]}:${s[1]}`;
    const known = curves.get(key);
    if (known !== undefined) return known ?? undefined;
    curves.set(key, null); // a cycle ends here
    const c = readCurve(p, s);
    let row: number | undefined;
    if (c) {
      row = b.addCurve({ ...c, id: id(p) });
      specs[row] = c;
      count('curve');
    }
    curves.set(key, row ?? null);
    return row;
  }

  function readCurve(p: number, s: Scale): Curve | undefined {
    if (r.is(p, 'LINE')) {
      const pt = coords(r.ref(p, 'pnt')), v = vector(r.ref(p, 'dir'));
      if (!pt || !v || v.direction.length !== pt.length) return note('a line without its point or direction', p);
      if (pt.length === 3) return { kind: 'line', point: pt, direction: v.direction, magnitude: v.magnitude };
      // The parameter stays the file's: the magnitude takes the direction's change of length.
      const d = scaled(v.direction, s), l = Math.hypot(...d);
      return { kind: 'line', point: scaled(pt, s), direction: d.map((x) => x / l), magnitude: v.magnitude * l };
    }
    if (r.is(p, 'CONIC')) {
      const pos = r.ref(p, 'position'), dim = r.is(pos, 'AXIS2_PLACEMENT_2D') ? 2 : 3;
      const position = place(pos, dim);
      if (!position) return note('a conic without its placement', p);
      if (dim === 2 && s[0] !== s[1]) {
        return note('a conic p-curve on an angular surface in degrees (no exact form)', p);
      }
      const k = dim === 2 ? s[0] : 1;
      position.origin = scaled(position.origin, s);
      const len = (name: string) => (num(p, name) ?? NaN) * k;
      if (r.is(p, 'CIRCLE')) return { kind: 'circle', position, radius: len('radius') };
      if (r.is(p, 'ELLIPSE')) return { kind: 'ellipse', position, semiAxis1: len('semi_axis_1'),
        semiAxis2: len('semi_axis_2') };
      if (r.is(p, 'HYPERBOLA')) return { kind: 'hyperbola', position, semiAxis: len('semi_axis'),
        semiImagAxis: len('semi_imag_axis') };
      if (r.is(p, 'PARABOLA')) return { kind: 'parabola', position, focalDist: len('focal_dist') };
      return missing('conic', p);
    }
    if (r.is(p, 'B_SPLINE_CURVE')) {
      const degree = num(p, 'degree'), poles = points(r.attr(p, 'control_points_list'));
      if (degree === undefined || !poles || poles.some((q) => q.length !== poles[0]!.length)) {
        return note('a B-spline without its degree or poles', p);
      }
      const kn = knots(p, '', poles.length, degree);
      if (!kn) return undefined;
      const weights = r.is(p, 'RATIONAL_B_SPLINE_CURVE') ? numbersOf(r.attr(p, 'weights_data')) : undefined;
      if (weights && weights.length !== poles.length) {
        return note('a rational B-spline with weights not one per pole', p);
      }
      const form = r.enum(p, 'curve_form')?.toLowerCase() ?? '';
      return { kind: 'bspline', degree, ...kn, poles: poles.map((q) => scaled(q, s)), ...(weights ? { weights } : {}),
        closed: logical(p, 'closed_curve'), selfIntersect: logical(p, 'self_intersect'),
        form: (CURVE_FORMS as readonly string[]).includes(form) ? form as CurveForm : 'unspecified' };
    }
    if (r.is(p, 'POLYLINE')) {
      const pts = points(r.attr(p, 'points'));
      if (!pts || pts.some((q) => q.length !== pts[0]!.length)) return note('a polyline without its points', p);
      return { kind: 'polyline', points: pts.map((q) => scaled(q, s)) };
    }
    if (r.is(p, 'TRIMMED_CURVE')) {
      const bp = r.ref(p, 'basis_curve'), basis = curve(bp, s);
      if (basis === undefined) return note('a trimmed curve whose basis can\'t be read', p);
      // Trim parameters on circles and ellipses are angles, in the file's unit.
      const k = r.is(bp, 'CIRCLE') || r.is(bp, 'ELLIPSE') ? A : 1;
      const trim = (name: string) => {
        const out: { parameter?: number; point?: Point } = {};
        for (const v of listOf(r.attr(p, name))) {
          if (v.k === 'ref') {
            const c = coords(r.model.resolve(v.v as number));
            if (c) out.point = scaled(c, s);
          } else {
            let w: Value = v;
            while (w.k === 'typed') w = w.v;
            if (w.k === 'real' || w.k === 'int') out.parameter = Number(w.v) * k;
          }
        }
        return out;
      };
      const pref = r.enum(p, 'master_representation');
      return { kind: 'trimmed', basis, trim1: trim('trim_1'), trim2: trim('trim_2'), sense: bool(p, 'sense_agreement'),
        preference: pref === 'PARAMETER' ? 'parameter' : pref === 'CARTESIAN' ? 'cartesian' : 'unspecified' };
    }
    if (r.is(p, 'COMPOSITE_CURVE')) {
      const segments: { curve: number; sameSense: boolean; transition: Transition }[] = [];
      for (const q of refsOf(r.attr(p, 'segments'))) {
        const c = curve(r.ref(q, 'parent_curve'), s);
        if (c === undefined) return note('a composite curve with a segment that can\'t be read', p);
        const t = r.enum(q, 'transition')?.toLowerCase() ?? '';
        segments.push({ curve: c, sameSense: bool(q, 'same_sense'),
          transition: (TRANSITIONS as readonly string[]).includes(t) ? t as Transition : 'continuous' });
      }
      if (!segments.length) return note('a composite curve without segments', p);
      if (segments.some((x) => dimOf(specs[x.curve]!, specs) !== dimOf(specs[segments[0]!.curve]!, specs))) {
        return note('a composite curve of 2D and 3D segments', p);
      }
      return { kind: 'composite', segments, selfIntersect: logical(p, 'self_intersect') };
    }
    if (r.is(p, 'OFFSET_CURVE_3D') || r.is(p, 'OFFSET_CURVE_2D')) {
      if (!isOne(s)) return note('an offset p-curve on an angular surface in degrees (no exact form)', p);
      const basis = curve(r.ref(p, 'basis_curve')), distance = num(p, 'distance');
      if (basis === undefined || distance === undefined) {
        return note('an offset curve without its basis or distance', p);
      }
      const three = dimOf(specs[basis]!, specs) === 3;
      const ref = three ? dir(r.ref(p, 'ref_direction')) : undefined;
      if (three && ref?.length !== 3) return note('a 3D offset curve without its reference direction', p);
      return { kind: 'offset', basis, distance, selfIntersect: logical(p, 'self_intersect'),
        ...(ref ? { refDirection: ref } : {}) };
    }
    return missing('curve', p);
  }

  function knots(p: number, dir: '' | 'u_' | 'v_', poles: number, degree: number):
    { knots: number[]; multiplicities: number[] } | undefined {
    const onSurface = dir !== '';
    if (r.is(p, onSurface ? 'B_SPLINE_SURFACE_WITH_KNOTS' : 'B_SPLINE_CURVE_WITH_KNOTS')) {
      const ks = numbersOf(r.attr(p, `${dir}knots`));
      const ms = numbersOf(r.attr(p, onSurface ? `${dir}multiplicities` : 'knot_multiplicities'));
      if (!ks || !ms || ks.length !== ms.length) return note('a B-spline whose knots and multiplicities differ', p);
      const f = foldKnots(ks, ms);
      if (f.folded) note('a B-spline with repeated knot values (folded into one, multiplicities summed)', p, 'info');
      return { knots: f.knots, multiplicities: f.multiplicities };
    }
    const form = r.is(p, onSurface ? 'UNIFORM_SURFACE' : 'UNIFORM_CURVE') ? 'uniform'
      : r.is(p, onSurface ? 'QUASI_UNIFORM_SURFACE' : 'QUASI_UNIFORM_CURVE') ? 'quasi'
        : r.is(p, onSurface ? 'BEZIER_SURFACE' : 'BEZIER_CURVE') ? 'bezier' : undefined;
    if (!form) return note('a B-spline without knots', p);
    return implicitKnots(form, poles, degree) ?? note(`a ${form === 'quasi' ? 'quasi-uniform' : form} B-spline whose `
      + 'poles don\'t fit its degree', p);
  }

  // -- Surfaces, and which of their parameters are angles (in the file's unit in p-curves and trims).
  const surfaces = new Map<number, number | null>();
  function surface(p: number): number | undefined {
    const known = surfaces.get(p);
    if (known !== undefined) return known ?? undefined;
    surfaces.set(p, null);
    const s = readSurface(p);
    let row: number | undefined;
    if (s) {
      row = b.addSurface({ ...s, id: id(p) });
      count('surface');
    }
    surfaces.set(p, row ?? null);
    return row;
  }
  const angularOf = new Map<number, [boolean, boolean]>();
  function angular(p: number): [boolean, boolean] {
    const known = angularOf.get(p);
    if (known) return known;
    let a: [boolean, boolean] = [false, false];
    angularOf.set(p, a); // a cycle ends here
    if (r.is(p, 'CYLINDRICAL_SURFACE') || r.is(p, 'CONICAL_SURFACE') || r.is(p, 'SURFACE_OF_REVOLUTION')) {
      a = [true, false];
    } else if (r.is(p, 'SPHERICAL_SURFACE') || r.is(p, 'TOROIDAL_SURFACE')) a = [true, true];
    else if (r.is(p, 'RECTANGULAR_TRIMMED_SURFACE') || r.is(p, 'OFFSET_SURFACE')) {
      a = angular(r.ref(p, 'basis_surface'));
    }
    angularOf.set(p, a);
    return a;
  }
  const scaleOf = (p: number): Scale => {
    const [u, v] = angular(p);
    return A !== 1 && (u || v) ? [u ? A : 1, v ? A : 1] : ONE;
  };

  function readSurface(p: number): Surface | undefined {
    if (r.is(p, 'ELEMENTARY_SURFACE')) {
      const position = place(r.ref(p, 'position'), 3);
      if (!position) return note('a surface without its placement', p);
      const len = (name: string) => {
        const x = num(p, name);
        if (x !== undefined && x < 0) {
          note('a negative radius (read as its absolute value)', p);
          return -x;
        }
        return x ?? NaN;
      };
      if (r.is(p, 'PLANE')) return { kind: 'plane', position };
      if (r.is(p, 'CYLINDRICAL_SURFACE')) return { kind: 'cylinder', position, radius: len('radius') };
      if (r.is(p, 'CONICAL_SURFACE')) return { kind: 'cone', position, radius: len('radius'),
        semiAngle: (num(p, 'semi_angle') ?? NaN) * A };
      if (r.is(p, 'SPHERICAL_SURFACE')) return { kind: 'sphere', position, radius: len('radius') };
      if (r.is(p, 'TOROIDAL_SURFACE')) return { kind: 'torus', position, majorRadius: len('major_radius'),
        minorRadius: len('minor_radius'),
        ...(r.is(p, 'DEGENERATE_TOROIDAL_SURFACE') ? { selectOuter: bool(p, 'select_outer') } : {}) };
      return missing('surface', p);
    }
    if (r.is(p, 'B_SPLINE_SURFACE')) {
      const ud = num(p, 'u_degree'), vd = num(p, 'v_degree');
      const grid = listOf(r.attr(p, 'control_points_list')).map((row) => points(row));
      if (ud === undefined || vd === undefined || !grid.length || grid.some((g) => !g || g.length !== grid[0]!.length
        || g.some((q) => q.length !== 3))) return note('a B-spline surface without its degrees or a grid of poles', p);
      const poles = grid as number[][][];
      const uk = knots(p, 'u_', poles.length, ud), vk = knots(p, 'v_', poles[0]!.length, vd);
      if (!uk || !vk) return undefined;
      let weights: number[][] | undefined;
      if (r.is(p, 'RATIONAL_B_SPLINE_SURFACE')) {
        weights = listOf(r.attr(p, 'weights_data')).map((row) => numbersOf(row) ?? []);
        if (weights.length !== poles.length || weights.some((row) => row.length !== poles[0]!.length)) {
          return note('a rational B-spline surface with weights not one per pole', p);
        }
      }
      const form = r.enum(p, 'surface_form')?.toLowerCase() ?? '';
      return { kind: 'bspline', uDegree: ud, vDegree: vd, uKnots: uk.knots, vKnots: vk.knots,
        uMultiplicities: uk.multiplicities, vMultiplicities: vk.multiplicities, poles, ...(weights ? { weights } : {}),
        uClosed: logical(p, 'u_closed'), vClosed: logical(p, 'v_closed'), selfIntersect: logical(p, 'self_intersect'),
        form: (SURFACE_FORMS as readonly string[]).includes(form) ? form as SurfaceForm : 'unspecified' };
    }
    const curve3 = (q: number) => {
      const c = curve(q);
      return c !== undefined && dimOf(specs[c]!, specs) === 3 ? c : undefined;
    };
    if (r.is(p, 'SURFACE_OF_LINEAR_EXTRUSION')) {
      const c = curve3(r.ref(p, 'swept_curve')), v = vector(r.ref(p, 'extrusion_axis'));
      if (c === undefined || v?.direction.length !== 3) return note('an extrusion without its curve or axis', p);
      return { kind: 'extrusion', curve: c, direction: v.direction, magnitude: v.magnitude };
    }
    if (r.is(p, 'SURFACE_OF_REVOLUTION')) {
      const c = curve3(r.ref(p, 'swept_curve')), ax = r.ref(p, 'axis_position');
      const origin = coords(r.ref(ax, 'location'));
      const axis = r.ref(ax, 'axis') >= 0 ? dir(r.ref(ax, 'axis')) : [0, 0, 1];
      if (c === undefined || origin?.length !== 3 || axis?.length !== 3) {
        return note('a surface of revolution without its curve or axis', p);
      }
      return { kind: 'revolution', curve: c, axisOrigin: origin, axisDirection: axis };
    }
    if (r.is(p, 'OFFSET_SURFACE')) {
      const basis = surface(r.ref(p, 'basis_surface')), distance = num(p, 'distance');
      if (basis === undefined || distance === undefined) return note('an offset surface without its basis', p);
      return { kind: 'offset', basis, distance, selfIntersect: logical(p, 'self_intersect') };
    }
    if (r.is(p, 'RECTANGULAR_TRIMMED_SURFACE')) {
      const bp = r.ref(p, 'basis_surface'), basis = surface(bp), [su, sv] = scaleOf(bp);
      const t = ['u1', 'u2', 'v1', 'v2'].map((n) => num(p, n));
      if (basis === undefined || t.some((x) => x === undefined)) return note('a trimmed surface without its basis', p);
      const [u1, u2, v1, v2] = t as [number, number, number, number];
      return { kind: 'rectangularTrimmed', basis, u1: u1 * su, u2: u2 * su, v1: v1 * sv, v2: v2 * sv,
        uSense: bool(p, 'usense'), vSense: bool(p, 'vsense') };
    }
    if (r.is(p, 'SURFACE_CURVE_SWEPT_SURFACE')) {
      const c = curve3(r.ref(p, 'swept_curve')), d = curve(r.ref(p, 'directrix'));
      const ref = surface(r.ref(p, 'reference_surface'));
      if (c === undefined || d === undefined || ref === undefined) return note('a swept surface missing a part', p);
      return { kind: 'curveSwept', curve: c, directrix: d, referenceSurface: ref };
    }
    if (r.is(p, 'FIXED_REFERENCE_SWEPT_SURFACE')) {
      const c = curve3(r.ref(p, 'swept_curve')), d = curve3(r.ref(p, 'directrix'));
      const f = dir(r.ref(p, 'fixed_reference'));
      if (c === undefined || d === undefined || f?.length !== 3) return note('a swept surface missing a part', p);
      return { kind: 'fixedReferenceSwept', curve: c, directrix: d, fixedReference: f };
    }
    return missing('surface', p);
  }

  /** A PCURVE's 2D curve, scaled for its surface; undefined if it isn't 2D or can't be read. */
  function pcurveGeometry(q: number, surfaceP: number): number | undefined {
    const c = refsOf(r.attr(r.ref(q, 'reference_to_curve'), 'items')).find((x) => r.is(x, 'CURVE'));
    if (c === undefined) return note('a p-curve without its curve', q);
    const row = curve(c, scaleOf(surfaceP));
    if (row === undefined) return undefined;
    return dimOf(specs[row]!, specs) === 2 ? row : note('a p-curve whose curve isn\'t 2D', q);
  }

  // -- Topology.
  const vertices = new Map<number, number | null>();
  function vertex(p: number): number | undefined {
    const known = vertices.get(p);
    if (known !== undefined) return known ?? undefined;
    const c = r.is(p, 'VERTEX_POINT') ? coords(r.ref(p, 'vertex_geometry')) : undefined;
    let row: number | undefined;
    if (c?.length === 3) {
      row = b.addVertex({ point: c, id: id(p) });
      count('vertex');
    } else note(p < 0 ? 'a vertex missing from the file' : 'a vertex without a 3D point', p);
    vertices.set(p, row ?? null);
    return row;
  }

  /** Per EDGE_CURVE: its row, and its p-curves (PCURVE positions) for the coedges of faces on their surfaces. */
  const edges = new Map<number, { row: number; pcurves: number[] } | null>();
  function edge(p: number): { row: number; pcurves: number[] } | undefined {
    const known = edges.get(p);
    if (known !== undefined) return known ?? undefined;
    edges.set(p, null);
    if (!r.is(p, 'EDGE_CURVE')) return missing('edge', p);
    const g = r.ref(p, 'edge_geometry');
    const pcurves = r.is(g, 'PCURVE') ? [g] : r.is(g, 'SURFACE_CURVE')
      ? refsOf(r.attr(g, 'associated_geometry')).filter((q) => r.is(q, 'PCURVE')) : [];
    const c = r.is(g, 'PCURVE') ? undefined : curve(g);
    if (c !== undefined && dimOf(specs[c]!, specs) !== 3) return note('an edge whose curve isn\'t 3D (left out)', p);
    const start = vertex(r.ref(p, 'edge_start')), end = vertex(r.ref(p, 'edge_end'));
    if (c === undefined && (start === undefined || end === undefined)) {
      return note('an edge with neither a curve nor both its vertices (left out)', p);
    }
    const spec: Edge = { sameSense: bool(p, 'same_sense'), id: id(p), ...(c !== undefined ? { curve: c } : {}),
      ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
    const out = { row: b.addEdge(spec), pcurves };
    count('edge');
    edges.set(p, out);
    return out;
  }

  /** An oriented edge (or a chain of them) to its edge curve and whether it's used forward. */
  const unorient = (p: number): [number, boolean] => {
    let forward = true, q = p;
    while (r.is(q, 'ORIENTED_EDGE')) {
      forward = forward === bool(q, 'orientation');
      q = r.ref(q, 'edge_element');
    }
    return [q, forward];
  };

  // Evaluators of the curve rows made so far (a seam's p-curves).
  const evals = new Map<number, CurveEvaluator | undefined>();
  const evalRow = (row: number): CurveEvaluator | undefined => {
    if (evals.has(row)) return evals.get(row);
    evals.set(row, undefined);
    const e = curveEvaluatorOf(specs[row]!, evalRow);
    evals.set(row, e);
    return e;
  };
  /**
   * Which of a seam's two p-curves (rows) a use of it takes. The face lies to the left of each use in (u, v) (Part
   * 42; to the right where the face's or the bound's sense turns it over), so a use's p-curve is the one with the
   * other on its left: its direction of travel the p-curve's tangent, turned by the use's orientation and the edge's
   * same_sense (a p-curve shares its 3D curve's parameter). Undefined where that can't be told.
   */
  function seamPcurve(rows: [number, number], forward: boolean, edgeSame: boolean, flip: boolean): number | undefined {
    const [a, b] = rows.map(evalRow);
    if (!a || !b) return undefined;
    const t = Number.isFinite(a.range[0]) && Number.isFinite(a.range[1]) ? (a.range[0] + a.range[1]) / 2 : 0;
    const pa = a.point(t), pb = b.point(t), tan = a.d1(t);
    const k = (forward ? 1 : -1) * (edgeSame ? 1 : -1) * (flip ? -1 : 1);
    const left = [-tan[1]! * k, tan[0]! * k], gap = [pb[0]! - pa[0]!, pb[1]! - pa[1]!];
    const side = left[0]! * gap[0]! + left[1]! * gap[1]!;
    if (!(Math.abs(side) > 1e-9 * Math.hypot(...gap) * Math.hypot(...tan))) return undefined;
    return side > 0 ? rows[0] : rows[1];
  }

  function loop(bound: number, surfaceP: number, hasOuter: boolean, ignoreOuter: boolean, faceSame: boolean):
    Loop | undefined {
    const l = r.ref(bound, 'bound');
    const outer = r.is(bound, 'FACE_OUTER_BOUND') && !ignoreOuter;
    const base = { bound: outer ? 'outer' as const : hasOuter ? 'inner' as const : 'unknown' as const,
      sense: bool(bound, 'orientation'), id: id(bound) };
    if (r.is(l, 'EDGE_LOOP')) {
      const coedges: Coedge[] = [];
      for (const oe of refsOf(r.attr(l, 'edge_list'))) {
        const [q, forward] = unorient(oe);
        const e = edge(q);
        if (!e) return note('a loop with an edge that can\'t be read (the loop left out)', bound);
        const mine = e.pcurves.filter((x) => r.ref(x, 'basis_surface') === surfaceP);
        let pcurve: number | undefined;
        if (mine.length === 1) pcurve = pcurveGeometry(mine[0]!, surfaceP);
        else if (mine.length === 2) {
          const rows = mine.map((x) => pcurveGeometry(x, surfaceP));
          if (rows[0] !== undefined && rows[1] !== undefined) {
            pcurve = seamPcurve(rows as [number, number], forward, bool(q, 'same_sense'),
              !faceSame !== !base.sense);
          }
          if (pcurve === undefined) seamsMet.add(`${q}:${surfaceP}`);
        } else if (mine.length > 2) note('an edge with more than two p-curves on one surface (none used)', q);
        coedges.push({ edge: e.row, orientation: forward ? 'forward' : 'reversed',
          ...(pcurve !== undefined ? { pcurve } : {}), ...(oe !== q ? { id: id(oe) } : {}) });
      }
      if (!coedges.length) return note('an empty edge loop (left out)', bound);
      seamUses.push(...coedges.filter((c) => c.pcurve !== undefined));
      return { kind: 'edge', coedges, ...base };
    }
    if (r.is(l, 'VERTEX_LOOP')) {
      const v = vertex(r.ref(l, 'loop_vertex'));
      return v === undefined ? note('a vertex loop without its vertex (left out)', bound)
        : { kind: 'vertex', vertex: v, ...base };
    }
    if (r.is(l, 'POLY_LOOP')) {
      const pts = points(r.attr(l, 'polygon'));
      if (!pts || pts.length < 3 || pts.some((x) => x.length !== 3)) {
        return note('a poly loop without its points', bound);
      }
      return { kind: 'poly', points: pts, ...base };
    }
    return missing('loop', l);
  }

  const faces = new Map<number, number | null>();
  /** The current face's coedges with p-curves, to check its seams' two uses took different ones. */
  const seamUses: Coedge[] = [];
  function face(p: number): number | undefined {
    const known = faces.get(p);
    if (known !== undefined) return known ?? undefined;
    faces.set(p, null);
    let row: number | undefined;
    if (r.is(p, 'FACE_SURFACE')) {
      const sp = r.ref(p, 'face_geometry'), s = surface(sp);
      if (s === undefined) note('a face whose surface can\'t be read (left out)', p);
      else {
        const bounds = refsOf(r.attr(p, 'bounds')).filter((q) => q >= 0);
        const outers = bounds.filter((q) => r.is(q, 'FACE_OUTER_BOUND')).length;
        // Part 42 allows one outer bound: a face with more (bug30790.step's tubes) has bounds of unknown kind.
        if (outers > 1) note('a face with more than one outer bound (all read as bounds of unknown kind)', p, 'info');
        seamUses.length = 0;
        const sameSense = bool(p, 'same_sense');
        const loops = bounds.map((q) => loop(q, sp, outers === 1, outers > 1, sameSense))
          .filter((x): x is Loop => x !== undefined);
        // A seam's two uses must take different p-curves; where the rule gave both one, neither keeps it.
        const byEdge = new Map<number, Coedge[]>();
        for (const c of seamUses) byEdge.set(c.edge, [...(byEdge.get(c.edge) ?? []), c]);
        for (const [edgeRow, cs] of byEdge) {
          if (cs.length === 2 && cs[0]!.pcurve === cs[1]!.pcurve) {
            for (const c of cs) delete c.pcurve;
            seamsMet.add(`edge ${edgeRow}:${sp}`);
          }
        }
        row = b.addFace({ surface: s, sameSense, loops, id: id(p) });
        count('face');
      }
    } else if (r.is(p, 'CURVE_BOUNDED_SURFACE')) row = curveBounded(p);
    else missing('face', p);
    faces.set(p, row ?? null);
    return row;
  }

  /**
   * A CURVE_BOUNDED_SURFACE: a face of its basis surface, each boundary a loop of edges without vertices, one per
   * segment (its 3D curve, its p-curve on the surface where it has one). With `implicit_outer`, every boundary is an
   * inner loop of the surface's own extent.
   */
  function curveBounded(p: number): number | undefined {
    const sp = r.ref(p, 'basis_surface'), s = surface(sp);
    if (s === undefined) return note('a curve-bounded surface whose surface can\'t be read (left out)', p);
    const implicitOuter = bool(p, 'implicit_outer', false);
    const loops: Loop[] = [];
    for (const bc of refsOf(r.attr(p, 'boundaries'))) {
      const coedges: Coedge[] = [];
      for (const seg of refsOf(r.attr(bc, 'segments'))) {
        const pc = r.ref(seg, 'parent_curve');
        const c = r.is(pc, 'PCURVE') ? undefined : curve(pc);
        const c3 = c !== undefined && dimOf(specs[c]!, specs) === 3 ? c : undefined;
        const on = r.is(pc, 'PCURVE') ? [pc] : r.is(pc, 'SURFACE_CURVE')
          ? refsOf(r.attr(pc, 'associated_geometry'))
            .filter((x) => r.is(x, 'PCURVE') && r.ref(x, 'basis_surface') === sp)
          : [];
        const pcurve = on.length === 1 ? pcurveGeometry(on[0]!, sp) : undefined;
        if (c3 === undefined && pcurve === undefined) {
          return note('a curve-bounded surface with a boundary that can\'t be read (left out)', p);
        }
        const e = b.addEdge({ ...(c3 !== undefined ? { curve: c3 } : {}), sameSense: true, id: id(seg) });
        count('edge');
        coedges.push({ edge: e, orientation: bool(seg, 'same_sense') ? 'forward' : 'reversed',
          ...(pcurve !== undefined ? { pcurve } : {}) });
      }
      if (coedges.length) loops.push({ kind: 'edge', coedges, sense: true, id: id(bc),
        bound: implicitOuter ? 'inner' : r.is(bc, 'OUTER_BOUNDARY_CURVE') ? 'outer' : 'unknown' });
    }
    count('face');
    return b.addFace({ surface: s, sameSense: true, loops, id: id(p) });
  }

  const shells = new Map<number, number | null>();
  /** A shell and the sense it's used with (through ORIENTED_*_SHELL). */
  function shellUse(p: number): { ref: number; sense: boolean } | undefined {
    let sense = true, q = p;
    while (r.is(q, 'ORIENTED_CLOSED_SHELL') || r.is(q, 'ORIENTED_OPEN_SHELL')) {
      sense = sense === bool(q, 'orientation');
      q = r.ref(q, r.is(q, 'ORIENTED_CLOSED_SHELL') ? 'closed_shell_element' : 'open_shell_element');
    }
    let row = shells.get(q);
    if (row === undefined) {
      shells.set(q, null);
      if (r.is(q, 'CONNECTED_FACE_SET')) {
        const fs: { face: number; sense: boolean }[] = [];
        for (const f of refsOf(r.attr(q, 'cfs_faces'))) {
          let s = true, g = f;
          while (r.is(g, 'ORIENTED_FACE')) {
            s = s === bool(g, 'orientation');
            g = r.ref(g, 'face_element');
          }
          const fr = face(g);
          if (fr !== undefined) fs.push({ face: fr, sense: s });
        }
        row = b.addShell({ kind: r.is(q, 'CLOSED_SHELL') ? 'closed' : r.is(q, 'OPEN_SHELL') ? 'open' : 'faceSet',
          faces: fs, id: id(q) });
        count('shell');
      } else {
        missing('shell', q);
        row = null;
      }
      shells.set(q, row);
    }
    return row === null ? undefined : { ref: row, sense };
  }

  /** A solid, surface model or wireframe model; undefined (silently) for anything else. */
  function body(p: number): number | undefined {
    const shellsOf = (...names: string[]) => names.flatMap((n) => refsOf(r.attr(p, n))).map(shellUse)
      .filter((x): x is { ref: number; sense: boolean } => x !== undefined);
    let kind: 'solid' | 'sheet' | 'wire', members: { ref: number; sense: boolean }[];
    if (r.is(p, 'MANIFOLD_SOLID_BREP')) {
      kind = 'solid';
      members = r.is(p, 'BREP_WITH_VOIDS') ? shellsOf('outer', 'voids') : shellsOf('outer');
    } else if (r.is(p, 'SHELL_BASED_SURFACE_MODEL')) [kind, members] = ['sheet', shellsOf('sbsm_boundary')];
    else if (r.is(p, 'FACE_BASED_SURFACE_MODEL')) [kind, members] = ['sheet', shellsOf('fbsm_faces')];
    else if (r.is(p, 'CONNECTED_FACE_SET')) {
      kind = 'sheet';
      const u = shellUse(p);
      members = u ? [u] : [];
    } else if (r.is(p, 'EDGE_BASED_WIREFRAME_MODEL') || r.is(p, 'SHELL_BASED_WIREFRAME_MODEL')) {
      kind = 'wire';
      const es = r.is(p, 'EDGE_BASED_WIREFRAME_MODEL')
        ? refsOf(r.attr(p, 'ebwm_boundary')).flatMap((ces) => refsOf(r.attr(ces, 'ces_edges')))
        : refsOf(r.attr(p, 'sbwm_boundary')).flatMap((ws) => refsOf(r.attr(ws, 'wire_shell_extent')))
          .flatMap((l) => refsOf(r.attr(l, 'edge_list')));
      members = [];
      for (const q0 of es) {
        const [q, sense] = unorient(q0);
        const e = edge(q);
        if (e) members.push({ ref: e.row, sense });
      }
    } else return undefined;
    if (!members.length) return note('a body with no member that can be read (left out)', p);
    count('body');
    return b.addBody({ kind, members, id: id(p) });
  }

  // -- The items: bodies, geometric sets' elements, loose geometry.
  const add = (kind: 'body' | 'curve' | 'surface' | 'face', ref: number | undefined, p: number) => {
    if (ref === undefined) return;
    b.addItem({ kind, ref, id: id(p) });
    count('item');
  };
  function item(q: number) {
    if (q < 0 || SILENT.some((e) => r.is(q, e))) return;
    const bodyRow = body(q);
    if (bodyRow !== undefined) return add('body', bodyRow, q);
    if (r.is(q, 'MANIFOLD_SOLID_BREP') || r.is(q, 'SURFACE_MODEL') || r.is(q, 'WIREFRAME_MODEL')
      || r.is(q, 'CONNECTED_FACE_SET')) return; // read, nothing in it
    if (r.is(q, 'GEOMETRIC_SET')) {
      for (const e of refsOf(r.attr(q, 'elements'))) item(e);
      return;
    }
    if (r.is(q, 'CARTESIAN_POINT')) {
      const c = coords(q);
      if (c?.length !== 3) return void note('a point that isn\'t 3D', q);
      b.addItem({ kind: 'point', point: c, id: id(q) });
      count('item');
    } else if (r.is(q, 'CURVE_BOUNDED_SURFACE') || r.is(q, 'FACE_SURFACE')) add('face', face(q), q);
    else if (r.is(q, 'SURFACE')) add('surface', surface(q), q);
    else if (r.is(q, 'PCURVE')) note('a p-curve among a representation\'s items (not in the B-rep model)', q, 'info');
    else if (r.is(q, 'CURVE')) {
      const c = curve(q);
      if (c !== undefined && dimOf(specs[c]!, specs) !== 3) note('a 2D curve among a 3D representation\'s items', q);
      else add('curve', c, q);
    } else if (r.is(q, 'TESSELLATED_ITEM')) note('tessellated geometry (not in the B-rep model)', q, 'info');
    else note(`an item not in the B-rep model (${types(q)})`, q, 'info');
  }

  for (const q of items) item(q);
  const seams = seamsMet.size;
  if (seams) note(`${seams === 1 ? 'a seam' : `${seams} seams`} whose two p-curves on one face couldn't be told apart `
    + '(neither use has one)', -1, 'info');
  for (const [message, x] of problems) {
    const ids = x.ids.length ? ` (#${x.ids.join(', #')}${x.n > x.ids.length ? ', ...' : ''})` : '';
    warn(`B-rep model: ${x.n === 1 ? '' : `${x.n} x `}${message}${ids}`, x.severity);
  }
  return { brep: b.finish(), counts, seams };
}
