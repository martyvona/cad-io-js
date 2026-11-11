// A part's B-rep model (cad-brep) as STEP geometry and topology (Part 42, as AP242 has it): one shape representation
// of the model's items, with its context (length unit, radians, uncertainty), as step-parser's instances. The model's
// rows keep their source ids (`#` ids), new entities (points, directions, placements, surface curves, loops, units)
// are numbered after the largest, and a row whose id is taken (repeated ids) gets a new one. Only rows the items reach
// are written, in table order (curves, surfaces, vertices, edges, faces, shells, bodies, items), each after what it
// refers to, since the model's rows refer only to rows before them. Part 42's general forms: explicit knots, rational
// B-splines as complex instances, SURFACE_CURVE (SEAM_CURVE for two p-curves on one surface) where an edge's uses have
// p-curves, faces as ADVANCED_FACE where Part 42's rules for one hold (else FACE_SURFACE), a face whose edges all lack
// vertices as a CURVE_BOUNDED_SURFACE. What the source lacked (an edge's vertex or curve) is written unset, as it had
// it, not repaired. What STEP can't hold is a diagnostic: tolerances per entity, parameter ranges, internal and
// external coedges, item transforms and instances; names aren't in the model and are written empty.

import {
  BODY_KIND, type BrepData, type Curve, decode, type Face, ITEM_KIND, LOOP_KIND, type Logical, type Placement,
  type Point, rowCount, type Surface,
} from 'cad-brep';
import { type Diagnostic, type EntityRecord, type Instance, makeList, type Value } from 'step-parser';

export interface StepGeometry {
  /** The shape representation's id. */
  rootId: number;
  /** The instances, made as they are pulled; one pass. */
  instances: Iterable<Instance>;
  /** What couldn't be written as the model has it; complete once `instances` has been read through. */
  diagnostics: Diagnostic[];
  /**
   * Each written face's id by its source id (the model's `face.id`), and each surface's (a geometric set's surfaces
   * are faces to a reader: step-import's); complete once `instances` is read.
   */
  faceIds: Map<number, number>;
  surfaceIds: Map<number, number>;
  /**
   * A face written twice (used both ways, so once turned over): the other entity, by the first's written id, for
   * styles and layers to cover both.
   */
  faceCopies: Map<number, number>;
  /**
   * Each id written for a model entity that has a source id but not under it (another entity has the id, or the
   * entity is written twice): the source id, which is what a reader reports under it means (StepTessellator maps
   * results back by it). Other new ids are for entities without a source id, or only the writer's. Complete once
   * `instances` is read.
   */
  sourceIds: Map<number, number>;
  /** The representation's items, its origin placement (`origin`) last; complete once `instances` is read. */
  items: number[];
  /** The representation context's id. */
  contextId: number;
  /** Each geometric set's elements, by the set's id: a set's style isn't its elements' to every reader (OCCT). */
  setMembers: Map<number, number[]>;
}

/** Instance ids shared by several writers into one file: a source id kept unless taken, new ones after the largest. */
export interface StepIds {
  /** `id` if it's a positive safe integer not yet taken (it's then taken), else a new one. */
  claim(id: number | undefined): number;
  fresh(): number;
}

/** Ids for one file: source ids up to `largest` kept once each, new ones after it (so never colliding). */
export function stepIds(largest: number): StepIds {
  let next = Math.floor(Math.max(largest, 0)) + 1;
  const used = new Set<number>();
  return {
    claim: (x) => {
      if (x === undefined || !Number.isSafeInteger(x) || x <= 0 || x > largest || used.has(x)) {
        return next++;
      }
      used.add(x);
      return x;
    },
    fresh: () => next++,
  };
}

/** The largest source id in a model, for `stepIds`. */
export function largestId(d: BrepData): number {
  let largest = 0;
  for (const t of ['curve', 'surface', 'vertex', 'edge', 'coedge', 'loop', 'face', 'shell', 'body', 'item'] as const) {
    for (const x of d[t].id) if (x > largest) largest = x;
  }
  return largest;
}

export interface StepGeometryOptions {
  /** The file's ids, when the representation is one of several in it; by default the model's own (`stepIds`). */
  ids?: StepIds;
  /** The representation's name. */
  name?: string;
  /** The representation's id, kept if free (`StepIds.claim`): its source's. */
  id?: number;
  /** Add an AXIS2_PLACEMENT_3D at the origin to the items: what an assembly's placements of it refer to. */
  origin?: boolean;
  /** A conversion-based unit's dimensions written derived (`*`), as AP214 edition 3 has them. */
  derivedDimensions?: boolean;
}

/** An SI length unit's prefix by millimetres per unit (null: the metre itself). */
const SI_LENGTH = new Map<number, string | null>([[1e6, 'KILO'], [1e3, null], [100, 'DECI'], [10, 'CENTI'],
  [1, 'MILLI'], [1e-3, 'MICRO'], [1e-6, 'NANO']]);
/** Names of conversion-based length units by millimetres per unit. */
const NAMED_LENGTH = new Map<number, string>([[25.4, 'INCH'], [304.8, 'FOOT']]);
/** The FILE_SCHEMA of what `stepFile` writes. */
export const AP242_SCHEMA = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }';

// -- Values.
const str = (v = ''): Value => ({ k: 'str', v });
const real = (v: number): Value => ({ k: 'real', v });
const int = (v: number): Value => ({ k: 'int', v });
const ref = (v: number): Value => ({ k: 'ref', v });
const enu = (v: string): Value => ({ k: 'enum', v });
const bool = (b: boolean): Value => enu(b ? 'T' : 'F');
const logical = (l: Logical): Value => enu(l === null ? 'U' : l ? 'T' : 'F');
const list = (vs: Value[]): Value => makeList(vs);
const reals = (xs: readonly number[]): Value => list(xs.map(real));
const ints = (xs: readonly number[]): Value => list(xs.map(int));
const refs = (xs: readonly number[]): Value => list(xs.map(ref));
const DERIVED: Value = { k: 'derived' };
const UNSET: Value = { k: 'unset' };
const NAME = str();

/** Advanced faces' edge curves (and swept surfaces' curves, and p-curves' geometry): Part 42's advanced_face rules. */
// How a vertex is used (`reachable`'s marks): by edges or vertex loops (a VERTEX_POINT), as a poly loop's corner.
const VERTEX_USE = 1, CORNER_USE = 2;
const ADVANCED_CURVES = new Set(['line', 'circle', 'ellipse', 'hyperbola', 'parabola', 'polyline', 'bspline']);
const ADVANCED_SURFACES = new Set(['plane', 'cylinder', 'cone', 'sphere', 'torus', 'bspline', 'extrusion',
  'revolution']);

/**
 * The rows the items reach, per table: what's written (a p-curve no coedge uses, as a seam's whose uses couldn't be
 * told apart, isn't; an unreferenced entity would be a root to a reader).
 */
function reachable(d: BrepData) {
  const live = {
    curve: new Uint8Array(rowCount(d, 'curve')), surface: new Uint8Array(rowCount(d, 'surface')),
    vertex: new Uint8Array(rowCount(d, 'vertex')), edge: new Uint8Array(rowCount(d, 'edge')),
    face: new Uint8Array(rowCount(d, 'face')), shell: new Uint8Array(rowCount(d, 'shell')),
    body: new Uint8Array(rowCount(d, 'body')),
  };
  const curve = (k: number) => {
    if (live.curve[k]) return;
    live.curve[k] = 1;
    const c = decode.curve(d, k);
    if (c.kind === 'trimmed' || c.kind === 'offset') curve(c.basis);
    else if (c.kind === 'composite') for (const x of c.segments) curve(x.curve);
  };
  const surface = (k: number) => {
    if (live.surface[k]) return;
    live.surface[k] = 1;
    const x = decode.surface(d, k);
    if (x.kind === 'extrusion' || x.kind === 'revolution') curve(x.curve);
    else if (x.kind === 'offset' || x.kind === 'rectangularTrimmed') surface(x.basis);
    else if (x.kind === 'curveSwept' || x.kind === 'fixedReferenceSwept') {
      curve(x.curve);
      curve(x.directrix);
      if (x.kind === 'curveSwept') surface(x.referenceSurface);
    }
  };
  const edge = (k: number) => {
    if (live.edge[k]) return;
    live.edge[k] = 1;
    const e = d.edge;
    if (e.curve[k]! >= 0) curve(e.curve[k]!);
    for (const v of [e.start[k]!, e.end[k]!]) if (v >= 0) live.vertex[v]! |= VERTEX_USE;
  };
  const face = (f: number) => {
    if (live.face[f]) return;
    live.face[f] = 1;
    surface(d.face.surface[f]!);
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
      if (d.loop.kind[l] === LOOP_KIND.vertex) live.vertex[d.loop.first[l]!]! |= VERTEX_USE;
      if (d.loop.kind[l] === LOOP_KIND.poly) {
        for (let j = 0; j < d.loop.count[l]!; j++) live.vertex[d.pool.loopInt[d.loop.first[l]! + j]!]! |= CORNER_USE;
      }
      if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        edge(d.coedge.edge[c]!);
        if (d.coedge.pcurve[c]! >= 0) curve(d.coedge.pcurve[c]!);
      }
    }
  };
  const shell = (k: number) => {
    if (live.shell[k]) return;
    live.shell[k] = 1;
    for (let j = d.shell.first[k]!; j < d.shell.first[k]! + d.shell.count[k]!; j++) face(d.faceUse.face[j]!);
  };
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    const r = d.item.ref[k]!;
    switch (d.item.kind[k]) {
      case ITEM_KIND.body: {
        live.body[r] = 1;
        const wire = d.body.kind[r] === BODY_KIND.wire;
        for (let j = d.body.first[r]!; j < d.body.first[r]! + d.body.count[r]!; j++) {
          (wire ? edge : shell)(d.member.ref[j]!);
        }
        break;
      }
      case ITEM_KIND.curve: curve(r); break;
      case ITEM_KIND.surface: surface(r); break;
      case ITEM_KIND.face: face(r); break;
    }
  }
  return live;
}

/** The model as STEP: a shape representation with its items. */
export function stepGeometry(d: BrepData, opts: StepGeometryOptions = {}): StepGeometry {
  const live = reachable(d);
  const diagnostics: Diagnostic[] = [];
  // Problems said once each, with a count and the first few source ids.
  const problems = new Map<string, { n: number; ids: number[]; severity: Diagnostic['severity'] }>();
  const note = (message: string, sourceId = NaN, severity: Diagnostic['severity'] = 'warning') => {
    const x = problems.get(message) ?? { n: 0, ids: [], severity };
    x.n++;
    if (x.ids.length < 5 && !Number.isNaN(sourceId)) x.ids.push(sourceId);
    problems.set(message, x);
  };

  // Ids: the rows' own, unless taken; new ones after the largest.
  const ids = opts.ids ?? stepIds(largestId(d));
  const fresh = () => ids.fresh();
  const sourceIds = new Map<number, number>();
  const own = (x: number | undefined) => {
    const id = ids.claim(x);
    if (id !== x && x !== undefined && Number.isSafeInteger(x) && x > 0) sourceIds.set(id, x);
    return id;
  };
  const rootId = opts.id !== undefined ? own(opts.id) : fresh(), contextId = fresh();
  const faceIds = new Map<number, number>(), surfaceIds = new Map<number, number>();
  const faceCopies = new Map<number, number>();
  const setMembers = new Map<number, number[]>();
  const rootItems: number[] = [];

  const out: Instance[] = [];
  const emit = (id: number, type: string, attrs: Value[]) => { out.push({ id, type, attrs }); return id; };
  const emitComplex = (id: number, parts: EntityRecord[]) => { out.push({ id, parts }); return id; };

  // -- Points, directions, placements.
  const point = (p: Point) => emit(fresh(), 'CARTESIAN_POINT', [NAME, reals(p)]);
  const direction = (p: Point) => emit(fresh(), 'DIRECTION', [NAME, reals(p)]);
  const vector = (dir: Point, magnitude: number) =>
    emit(fresh(), 'VECTOR', [NAME, ref(direction(dir)), real(magnitude)]);
  const placement = (pl: Placement) => pl.axis
    ? emit(fresh(), 'AXIS2_PLACEMENT_3D', [NAME, ref(point(pl.origin)), ref(direction(pl.axis)),
      ref(direction(pl.xDir))])
    : emit(fresh(), 'AXIS2_PLACEMENT_2D', [NAME, ref(point(pl.origin)), ref(direction(pl.xDir))]);

  // -- Curves.
  const curveId = new Float64Array(rowCount(d, 'curve')).fill(NaN);
  const curveKinds: Curve['kind'][] = [];
  const curveForm = (f: string) => enu(f.toUpperCase());
  function writeCurve(k: number) {
    const c = decode.curve(d, k), id = own(c.id);
    curveKinds[k] = c.kind;
    switch (c.kind) {
      case 'line': emit(id, 'LINE', [NAME, ref(point(c.point)), ref(vector(c.direction, c.magnitude))]); break;
      case 'circle': emit(id, 'CIRCLE', [NAME, ref(placement(c.position)), real(c.radius)]); break;
      case 'ellipse': emit(id, 'ELLIPSE', [NAME, ref(placement(c.position)), real(c.semiAxis1), real(c.semiAxis2)]);
        break;
      case 'hyperbola': emit(id, 'HYPERBOLA', [NAME, ref(placement(c.position)), real(c.semiAxis),
        real(c.semiImagAxis)]); break;
      case 'parabola': emit(id, 'PARABOLA', [NAME, ref(placement(c.position)), real(c.focalDist)]); break;
      case 'bspline': {
        const poles = refs(c.poles.map(point));
        const head = [int(c.degree), poles, curveForm(c.form), logical(c.closed), logical(c.selfIntersect)];
        const knots = [ints(c.multiplicities), reals(c.knots), enu('UNSPECIFIED')];
        if (!c.weights) emit(id, 'B_SPLINE_CURVE_WITH_KNOTS', [NAME, ...head, ...knots]);
        else {
          // Partials in alphabetical order (Part 21), each with its own attributes.
          emitComplex(id, [{ type: 'BOUNDED_CURVE', attrs: [] }, { type: 'B_SPLINE_CURVE', attrs: head },
            { type: 'B_SPLINE_CURVE_WITH_KNOTS', attrs: knots }, { type: 'CURVE', attrs: [] },
            { type: 'GEOMETRIC_REPRESENTATION_ITEM', attrs: [] },
            { type: 'RATIONAL_B_SPLINE_CURVE', attrs: [reals(c.weights)] },
            { type: 'REPRESENTATION_ITEM', attrs: [NAME] }]);
        }
        break;
      }
      case 'polyline': emit(id, 'POLYLINE', [NAME, refs(c.points.map(point))]); break;
      case 'trimmed': {
        const parameter = (x: number): Value => ({ k: 'typed', type: 'PARAMETER_VALUE', v: real(x) });
        const trim = (t: { parameter?: number; point?: Point }) => list([
          ...(t.point ? [ref(point(t.point))] : []), ...(t.parameter !== undefined ? [parameter(t.parameter)] : []),
        ]);
        emit(id, 'TRIMMED_CURVE', [NAME, ref(curveId[c.basis]!), trim(c.trim1), trim(c.trim2), bool(c.sense),
          enu(c.preference.toUpperCase())]);
        break;
      }
      case 'composite': {
        const segs = c.segments.map((s) => emit(fresh(), 'COMPOSITE_CURVE_SEGMENT', [enu(s.transition.toUpperCase()),
          bool(s.sameSense), ref(curveId[s.curve]!)]));
        emit(id, 'COMPOSITE_CURVE', [NAME, refs(segs), logical(c.selfIntersect)]);
        break;
      }
      case 'offset':
        if (c.refDirection) {
          emit(id, 'OFFSET_CURVE_3D', [NAME, ref(curveId[c.basis]!), real(c.distance), logical(c.selfIntersect),
            ref(direction(c.refDirection))]);
        } else {
          emit(id, 'OFFSET_CURVE_2D', [NAME, ref(curveId[c.basis]!), real(c.distance), logical(c.selfIntersect)]);
        }
        break;
    }
    curveId[k] = id;
  }

  // -- Surfaces.
  const surfaceId = new Float64Array(rowCount(d, 'surface')).fill(NaN);
  const surfaces: Surface[] = [];
  function writeSurface(k: number) {
    const s = decode.surface(d, k), id = own(s.id);
    surfaces[k] = s;
    switch (s.kind) {
      case 'plane': emit(id, 'PLANE', [NAME, ref(placement(s.position))]); break;
      case 'cylinder': emit(id, 'CYLINDRICAL_SURFACE', [NAME, ref(placement(s.position)), real(s.radius)]); break;
      case 'cone': emit(id, 'CONICAL_SURFACE', [NAME, ref(placement(s.position)), real(s.radius), real(s.semiAngle)]);
        break;
      case 'sphere': emit(id, 'SPHERICAL_SURFACE', [NAME, ref(placement(s.position)), real(s.radius)]); break;
      case 'torus': {
        const a = [NAME, ref(placement(s.position)), real(s.majorRadius), real(s.minorRadius)];
        if (s.selectOuter === undefined) emit(id, 'TOROIDAL_SURFACE', a);
        else emit(id, 'DEGENERATE_TOROIDAL_SURFACE', [...a, bool(s.selectOuter)]);
        break;
      }
      case 'bspline': {
        const grid = list(s.poles.map((row) => refs(row.map(point))));
        const head = [int(s.uDegree), int(s.vDegree), grid, enu(s.form.toUpperCase()), logical(s.uClosed),
          logical(s.vClosed), logical(s.selfIntersect)];
        const knots = [ints(s.uMultiplicities), ints(s.vMultiplicities), reals(s.uKnots), reals(s.vKnots),
          enu('UNSPECIFIED')];
        if (!s.weights) emit(id, 'B_SPLINE_SURFACE_WITH_KNOTS', [NAME, ...head, ...knots]);
        else {
          emitComplex(id, [{ type: 'BOUNDED_SURFACE', attrs: [] }, { type: 'B_SPLINE_SURFACE', attrs: head },
            { type: 'B_SPLINE_SURFACE_WITH_KNOTS', attrs: knots },
            { type: 'GEOMETRIC_REPRESENTATION_ITEM', attrs: [] },
            { type: 'RATIONAL_B_SPLINE_SURFACE', attrs: [list(s.weights.map(reals))] },
            { type: 'REPRESENTATION_ITEM', attrs: [NAME] }, { type: 'SURFACE', attrs: [] }]);
        }
        break;
      }
      case 'extrusion': emit(id, 'SURFACE_OF_LINEAR_EXTRUSION', [NAME, ref(curveId[s.curve]!),
        ref(vector(s.direction, s.magnitude))]); break;
      case 'revolution': emit(id, 'SURFACE_OF_REVOLUTION', [NAME, ref(curveId[s.curve]!),
        ref(emit(fresh(), 'AXIS1_PLACEMENT', [NAME, ref(point(s.axisOrigin)), ref(direction(s.axisDirection))]))]);
        break;
      case 'offset': emit(id, 'OFFSET_SURFACE', [NAME, ref(surfaceId[s.basis]!), real(s.distance),
        logical(s.selfIntersect)]); break;
      case 'rectangularTrimmed': emit(id, 'RECTANGULAR_TRIMMED_SURFACE', [NAME, ref(surfaceId[s.basis]!), real(s.u1),
        real(s.u2), real(s.v1), real(s.v2), bool(s.uSense), bool(s.vSense)]); break;
      case 'curveSwept': emit(id, 'SURFACE_CURVE_SWEPT_SURFACE', [NAME, ref(curveId[s.curve]!),
        ref(curveId[s.directrix]!), ref(surfaceId[s.referenceSurface]!)]); break;
      case 'fixedReferenceSwept': emit(id, 'FIXED_REFERENCE_SWEPT_SURFACE', [NAME, ref(curveId[s.curve]!),
        ref(curveId[s.directrix]!), ref(direction(s.fixedReference))]); break;
    }
    surfaceId[k] = id;
    if (s.id !== undefined && !Number.isNaN(s.id) && !surfaceIds.has(s.id)) surfaceIds.set(s.id, id);
  }

  // -- P-curves: a 2D curve on a surface, through a definitional representation in the parameter space's context.
  let context2d = -1;
  const pcurve = (surface: number, curve: number) => {
    if (context2d < 0) {
      context2d = emitComplex(fresh(), [{ type: 'GEOMETRIC_REPRESENTATION_CONTEXT', attrs: [int(2)] },
        { type: 'PARAMETRIC_REPRESENTATION_CONTEXT', attrs: [] },
        { type: 'REPRESENTATION_CONTEXT', attrs: [str('2D SPACE'), str()] }]);
    }
    const rep = emit(fresh(), 'DEFINITIONAL_REPRESENTATION', [NAME, refs([curveId[curve]!]), ref(context2d)]);
    return emit(fresh(), 'PCURVE', [NAME, ref(surfaceId[surface]!), ref(rep)]);
  };

  // Each edge's p-curves: (surface, p-curve) pairs of the coedges of faces, in face order, without repeats. A face
  // whose edges all lack vertices is a curve-bounded surface; an edge only such faces use is only their boundaries'
  // segment, else an EDGE_CURVE.
  const edgePcurves = new Map<number, [number, number][]>();
  const nFaces = rowCount(d, 'face');
  const faces: Face[] = [];
  const curveBounded = new Uint8Array(nFaces), edgeCurve = new Uint8Array(rowCount(d, 'edge'));
  const noVertex = (e: number) => d.edge.start[e]! < 0 && d.edge.end[e]! < 0;
  for (let k = 0; k < rowCount(d, 'body'); k++) {
    if (d.body.kind[k] !== BODY_KIND.wire) continue;
    for (let j = d.body.first[k]!; j < d.body.first[k]! + d.body.count[k]!; j++) edgeCurve[d.member.ref[j]!] = 1;
  }
  for (let f = 0; f < nFaces; f++) {
    const face = faces[f] = decode.face(d, f);
    const edges = face.loops.flatMap((l) => l.kind === 'edge' ? l.coedges.map((c) => c.edge) : []);
    curveBounded[f] = edges.length && edges.every(noVertex) ? 1 : 0;
    if (!curveBounded[f]) for (const e of edges) edgeCurve[e] = 1;
    for (const l of face.loops) {
      if (l.kind !== 'edge') continue;
      for (const c of l.coedges) {
        if (c.pcurve === undefined) continue;
        const ps = edgePcurves.get(c.edge) ?? [];
        if (!ps.some(([s, p]) => s === face.surface && p === c.pcurve)) ps.push([face.surface, c.pcurve]);
        edgePcurves.set(c.edge, ps);
      }
    }
  }

  // -- Vertices and edges. An edge without both vertices is written only as a curve-bounded surface's boundary.
  const vertexId = new Float64Array(rowCount(d, 'vertex')).fill(NaN);
  // Each vertex's point, what poly loops refer to.
  const cornerId = new Float64Array(rowCount(d, 'vertex')).fill(NaN);
  const edgeId = new Float64Array(rowCount(d, 'edge')).fill(NaN);
  /** Where an edge's 3D geometry is an advanced face's (an EDGE_CURVE whose curve is Part 42's list). */
  const advancedEdge = new Uint8Array(rowCount(d, 'edge'));
  function writeEdge(k: number) {
    const e = decode.edge(d, k);
    if (e.tolerance !== undefined) note('edge tolerances (not written: STEP has none per entity)', e.id, 'info');
    if (e.range) note('edge parameter ranges (not written: STEP has none)', e.id, 'info');
    if (e.degenerate) note('degenerate edges (written as edges: STEP doesn\'t mark them)', e.id, 'info');
    if (!edgeCurve[k]) return;
    // What the source lacks (a vertex, a curve it couldn't read) is written unset, as it had it.
    if (e.start === undefined || e.end === undefined) {
      note('an edge without its start or end vertex (written unset)', e.id, 'warning');
    }
    // In row order: a reader makes a seam's two rows in the order its SURFACE_CURVE lists them.
    let pcs = [...edgePcurves.get(k) ?? []].sort((a, b) => a[1] - b[1]);
    let geometry: number;
    if (e.curve !== undefined) {
      if (pcs.length > 2) {
        note('an edge with p-curves on more than two surfaces (the first two written)', e.id);
        pcs = pcs.slice(0, 2);
      }
      if (!pcs.length) geometry = curveId[e.curve]!;
      else {
        const seam = pcs.length === 2 && pcs[0]![0] === pcs[1]![0];
        geometry = emit(fresh(), seam ? 'SEAM_CURVE' : 'SURFACE_CURVE', [NAME, ref(curveId[e.curve]!),
          refs(pcs.map(([s, p]) => pcurve(s, p))), enu('CURVE_3D')]);
      }
      advancedEdge[k] = e.start !== undefined && e.end !== undefined && ADVANCED_CURVES.has(curveKinds[e.curve]!)
        && pcs.every(([, p]) => ADVANCED_CURVES.has(curveKinds[p]!)) ? 1 : 0;
    } else if (pcs.length === 1) geometry = pcurve(pcs[0]![0], pcs[0]![1]);
    else if (pcs.length) {
      // P-curves on two faces and no 3D curve (the source's unreadable): a surface curve without its curve, its
      // p-curves the master representation.
      note('an edge with p-curves and no 3D curve (written as a surface curve with its curve unset)', e.id);
      if (pcs.length > 2) {
        note('an edge with p-curves on more than two surfaces (the first two written)', e.id);
        pcs = pcs.slice(0, 2);
      }
      const seam = pcs[0]![0] === pcs[1]![0];
      geometry = emit(fresh(), seam ? 'SEAM_CURVE' : 'SURFACE_CURVE', [NAME, UNSET,
        refs(pcs.map(([s, p]) => pcurve(s, p))), enu('PCURVE_S1')]);
    } else {
      note('an edge with neither a curve nor a p-curve (written unset)', e.id, 'warning');
      geometry = -1;
    }
    const opt = (x: number | undefined) => x === undefined || x < 0 ? UNSET : ref(x);
    edgeId[k] = emit(own(e.id), 'EDGE_CURVE', [NAME, opt(e.start === undefined ? -1 : vertexId[e.start]!),
      opt(e.end === undefined ? -1 : vertexId[e.end]!), opt(geometry), bool(e.sameSense)]);
  }

  // -- Faces.
  const faceId = new Float64Array(nFaces).fill(NaN);
  // A face's written id, kept by its source id (the first face with it, if repeated) for styles.
  const faceIdOf = (source: number | undefined) => {
    const id = own(source);
    if (source !== undefined && !Number.isNaN(source) && !faceIds.has(source)) faceIds.set(source, id);
    return id;
  };
  const faceAdvanced = new Uint8Array(nFaces);
  // Which ways round each shell and face is written: a solid's outer shell turned over where it's used reversed, a
  // void where it's used forward (shellUse), and a face turned over where its use and its shell's way round differ.
  const FORWARD = 1, TURNED = 2;
  const shellNeeds = new Uint8Array(rowCount(d, 'shell')), faceNeeds = new Uint8Array(nFaces);
  /** Each face's entity as it is ([2f]) and turned over ([2f + 1]), where written. */
  const faceAs = new Float64Array(2 * nFaces).fill(NaN);
  for (let k = 0; k < rowCount(d, 'body'); k++) {
    const kind = d.body.kind[k]!;
    if (!live.body[k] || kind === BODY_KIND.wire) continue;
    for (let j = d.body.first[k]!; j < d.body.first[k]! + d.body.count[k]!; j++) {
      const forward = d.member.sense[j] === 1, outer = j === d.body.first[k];
      shellNeeds[d.member.ref[j]!]! |= kind !== BODY_KIND.solid || (outer ? forward : !forward) ? FORWARD : TURNED;
    }
  }
  for (let k = 0; k < rowCount(d, 'shell'); k++) {
    const needs = shellNeeds[k]! || FORWARD;
    for (let j = d.shell.first[k]!; j < d.shell.first[k]! + d.shell.count[k]!; j++) {
      const f = d.faceUse.face[j]!, sense = d.faceUse.sense[j] === 1;
      if (needs & FORWARD) faceNeeds[f]! |= sense ? FORWARD : TURNED;
      if (needs & TURNED) faceNeeds[f]! |= sense ? TURNED : FORWARD;
    }
  }
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    if (d.item.kind[k] === ITEM_KIND.face) faceNeeds[d.item.ref[k]!]! |= FORWARD;
  }
  const orientation = (o: string, id: number | undefined, range?: [number, number]) => {
    if (o === 'internal' || o === 'external') note(`${o} coedges (written as forward)`, id);
    if (range) note('coedge parameter ranges (not written: STEP has none)', id, 'info');
    return o !== 'reversed';
  };
  function writeFace(f: number) {
    const face = faces[f]!, s = face.surface;
    if (face.tolerance !== undefined) note('face tolerances (not written: STEP has none per entity)', face.id, 'info');
    if (curveBounded[f]) {
      if (faceNeeds[f]! & TURNED) note('a curve-bounded face used reversed (written as it is)', face.id);
      writeCurveBounded(f);
      faceAs[2 * f] = faceAs[2 * f + 1] = faceId[f]!;
      return;
    }
    if (!face.loops.length) note('a face without loops (written with none: STEP needs at least one)', face.id);
    const loops = face.loops.map((l) => {
      if (l.kind === 'edge') {
        return emit(fresh(), 'EDGE_LOOP', [NAME, refs(l.coedges.map((c) => emit(own(c.id), 'ORIENTED_EDGE',
          [NAME, DERIVED, DERIVED, ref(edgeId[c.edge]!), bool(orientation(c.orientation, c.id, c.range))])))]);
      }
      if (l.kind === 'vertex') return emit(fresh(), 'VERTEX_LOOP', [NAME, ref(vertexId[l.vertex]!)]);
      return emit(fresh(), 'POLY_LOOP', [NAME, refs(l.vertices.map((v) => cornerId[v]!))]);
    });
    const advanced = ADVANCED_SURFACES.has(surfaces[s]!.kind) && sweptAdvanced(surfaces[s]!)
      && face.loops.every((l) => l.kind === 'vertex' || (l.kind === 'edge'
        && l.coedges.every((c) => advancedEdge[c.edge] === 1)));
    faceAdvanced[f] = advanced ? 1 : 0;
    // Forward, turned over (its sense and its bounds' negated: the same face the other way round), or both: the
    // first written keeps the source's ids, the second gets new ones.
    const needs = faceNeeds[f]! || FORWARD;
    let first = true;
    for (const turned of [false, true]) {
      if (!(needs & (turned ? TURNED : FORWARD))) continue;
      const bounds = face.loops.map((l, j) => emit(first ? own(l.id) : fresh(),
        l.bound === 'outer' ? 'FACE_OUTER_BOUND' : 'FACE_BOUND', [NAME, ref(loops[j]!), bool(l.sense !== turned)]));
      const id = emit(first ? faceIdOf(face.id) : fresh(), advanced ? 'ADVANCED_FACE' : 'FACE_SURFACE',
        [NAME, refs(bounds), ref(surfaceId[s]!), bool(face.sameSense !== turned)]);
      faceAs[2 * f + (turned ? 1 : 0)] = id;
      if (first) faceId[f] = id;
      else {
        faceCopies.set(faceId[f]!, id);
        if (face.id !== undefined) sourceIds.set(id, face.id);
        note('a face used both ways (written twice, turned over the second time, with new ids)', face.id, 'info');
      }
      first = false;
    }
  }
  const sweptAdvanced = (s: Surface) =>
    s.kind !== 'extrusion' && s.kind !== 'revolution' || ADVANCED_CURVES.has(curveKinds[s.curve]!);

  /** A face whose boundaries are curves without vertices: a CURVE_BOUNDED_SURFACE of composite curve segments. */
  function writeCurveBounded(f: number) {
    const face = faces[f]!, s = face.surface;
    if (!face.sameSense) note('a curve-bounded face against its surface\'s sense (written with it)', face.id);
    const implicitOuter = face.loops.some((l) => l.bound === 'inner');
    const boundaries: number[] = [];
    for (const l of face.loops) {
      if (l.kind !== 'edge') {
        note('a curve-bounded face with a vertex or poly loop (the loop left out)', face.id);
        continue;
      }
      if (!l.sense) note('a curve-bounded face\'s loop against its sense (written with it)', face.id);
      const segments = l.coedges.map((c) => {
        const e = decode.edge(d, c.edge);
        let parent: number;
        if (e.curve === undefined) parent = pcurve(s, c.pcurve!);
        else if (c.pcurve === undefined) parent = curveId[e.curve]!;
        else parent = emit(fresh(), 'SURFACE_CURVE', [NAME, ref(curveId[e.curve]!), refs([pcurve(s, c.pcurve)]),
          enu('CURVE_3D')]);
        return emit(own(e.id), 'COMPOSITE_CURVE_SEGMENT', [enu('CONTINUOUS'),
          bool(orientation(c.orientation, c.id, c.range)), ref(parent)]);
      });
      boundaries.push(emit(own(l.id), l.bound === 'outer' && !implicitOuter ? 'OUTER_BOUNDARY_CURVE'
        : 'BOUNDARY_CURVE', [NAME, refs(segments), logical(null)]));
    }
    faceId[f] = emit(faceIdOf(face.id), 'CURVE_BOUNDED_SURFACE', [NAME, ref(surfaceId[s]!), refs(boundaries),
      bool(implicitOuter)]);
  }

  // -- Shells and bodies.
  const shellId = new Float64Array(rowCount(d, 'shell')).fill(NaN);
  const shellKind: string[] = [];
  /** Each shell's entity as it is ([2k]) and with every face turned over ([2k + 1]), where written. */
  const shellAs = new Float64Array(2 * rowCount(d, 'shell')).fill(NaN);
  function writeShell(k: number) {
    const sh = decode.shell(d, k);
    shellKind[k] = sh.kind;
    const needs = shellNeeds[k]! || FORWARD;
    let first = true;
    for (const turned of [false, true]) {
      if (!(needs & (turned ? TURNED : FORWARD))) continue;
      // Each face use as the face written its way round (no ORIENTED_FACE: OCCT's reader drops them, and AP242's
      // advanced B-rep allows only advanced faces in a solid's shells).
      const uses = sh.faces.map((u) => faceAs[2 * u.face + (u.sense === turned ? 1 : 0)]!)
        .filter((x) => !Number.isNaN(x));
      const id = emit(first ? own(sh.id) : fresh(), sh.kind === 'closed' ? 'CLOSED_SHELL'
        : sh.kind === 'open' ? 'OPEN_SHELL' : 'CONNECTED_FACE_SET', [NAME, refs(uses)]);
      shellAs[2 * k + (turned ? 1 : 0)] = id;
      if (first) shellId[k] = id;
      first = false;
    }
  }
  /**
   * A shell's use: a sheet's as the model has it (ORIENTED_CLOSED_SHELL or ORIENTED_OPEN_SHELL where reversed; a face
   * set can't be); a solid's outer shell never oriented (AP242's advanced B-rep forbids it), its faces turned over
   * where it's used reversed; a void always an ORIENTED_CLOSED_SHELL with orientation false (as AP242 requires), its
   * faces turned over where it's used forward.
   */
  const shellUse = (m: { ref: number; sense: boolean }, role: 'sheet' | 'outer' | 'void' = 'sheet') => {
    if (role === 'outer') return shellAs[2 * m.ref + (m.sense ? 0 : 1)]!;
    if (role === 'void') {
      return emit(fresh(), 'ORIENTED_CLOSED_SHELL', [NAME, DERIVED, ref(shellAs[2 * m.ref + (m.sense ? 1 : 0)]!),
        bool(false)]);
    }
    if (m.sense) return shellId[m.ref]!;
    const kind = shellKind[m.ref];
    if (kind === 'faceSet') {
      note('a face set used reversed (written forward)', d.shell.id[m.ref]);
      return shellId[m.ref]!;
    }
    return emit(fresh(), kind === 'closed' ? 'ORIENTED_CLOSED_SHELL' : 'ORIENTED_OPEN_SHELL',
      [NAME, DERIVED, ref(shellId[m.ref]!), bool(m.sense)]);
  };
  /** Each body's written entities (a sheet of shells and face sets is two). */
  const bodyIds: number[][] = [];
  const bodyAdvanced: boolean[] = [];
  function writeBody(k: number) {
    const b = decode.body(d, k), id = own(b.id);
    if (b.kind === 'solid') {
      const [outer, ...voids] = b.members;
      if (shellKind[outer!.ref] !== 'closed') note('a solid whose outer shell isn\'t closed', b.id);
      bodyIds[k] = [voids.length
        ? emit(id, 'BREP_WITH_VOIDS', [NAME, ref(shellUse(outer!, 'outer')),
          refs(voids.map((v) => shellUse(v, 'void')))])
        : emit(id, 'MANIFOLD_SOLID_BREP', [NAME, ref(shellUse(outer!, 'outer'))])];
    } else if (b.kind === 'sheet') {
      const shells = b.members.filter((m) => shellKind[m.ref] !== 'faceSet');
      const sets = b.members.filter((m) => shellKind[m.ref] === 'faceSet');
      const ids: number[] = [];
      if (shells.length) ids.push(emit(id, 'SHELL_BASED_SURFACE_MODEL', [NAME, refs(shells.map((m) => shellUse(m)))]));
      if (sets.length) {
        ids.push(emit(ids.length ? fresh() : id, 'FACE_BASED_SURFACE_MODEL', [NAME,
          refs(sets.map((m) => shellUse(m)))]));
      }
      bodyIds[k] = ids;
    } else {
      const es = b.members.filter((m) => !Number.isNaN(edgeId[m.ref]!)).map((m) => m.sense ? edgeId[m.ref]!
        : emit(fresh(), 'ORIENTED_EDGE', [NAME, DERIVED, DERIVED, ref(edgeId[m.ref]!), bool(false)]));
      bodyIds[k] = [emit(id, 'EDGE_BASED_WIREFRAME_MODEL', [NAME, refs([emit(fresh(), 'CONNECTED_EDGE_SET',
        [NAME, refs(es)])])])];
    }
    // An advanced B-rep's solids: their faces all advanced.
    bodyAdvanced[k] = b.kind === 'solid' && b.members.every((m) => shellFacesAdvanced(m.ref));
  }
  const shellFacesAdvanced = (sh: number) => {
    const first = d.shell.first[sh]!;
    for (let j = first; j < first + d.shell.count[sh]!; j++) {
      if (!faceAdvanced[d.faceUse.face[j]!]) return false;
    }
    return true;
  };

  // -- Items, the representation and its context.
  function writeRoot() {
    // The items in the model's order, each run of geometry (curves, points, surfaces, faces) a geometric set's
    // elements (a curve set's if only curves and points): readers take curves from sets, not loose (OCCT).
    const items: number[] = [];
    let bodies = 0, sets = 0, solidsOnly = true, curvesOnly = true;
    let run: number[] = [], runCurves = true;
    const flush = () => {
      if (!run.length) return;
      const set = emit(fresh(), runCurves ? 'GEOMETRIC_CURVE_SET' : 'GEOMETRIC_SET', [NAME, refs(run)]);
      setMembers.set(set, run);
      items.push(set);
      sets++;
      if (!runCurves) curvesOnly = false;
      run = [];
      runCurves = true;
    };
    for (let k = 0; k < rowCount(d, 'item'); k++) {
      const it = decode.item(d, k);
      if (it.kind === 'instance') { note('an instance item (left out: not written yet)', it.id, 'error'); continue; }
      if (it.transform) { note('an item with a transform (left out: not written yet)', it.id, 'error'); continue; }
      if (it.kind === 'body') {
        flush();
        items.push(...bodyIds[it.ref]!);
        bodies++;
        if (!bodyAdvanced[it.ref]) solidsOnly = false;
        continue;
      }
      const id = it.kind === 'point' ? emit(own(it.id), 'CARTESIAN_POINT', [NAME, reals(it.point)])
        : it.kind === 'curve' ? curveId[it.ref]! : it.kind === 'surface' ? surfaceId[it.ref]! : faceId[it.ref]!;
      if (Number.isNaN(id)) continue;
      run.push(id);
      if (it.kind !== 'curve' && it.kind !== 'point') runCurves = false;
    }
    flush();
    if (opts.origin) items.push(emit(fresh(), 'AXIS2_PLACEMENT_3D', [str('origin'), ref(point([0, 0, 0])),
      ref(direction([0, 0, 1])), ref(direction([1, 0, 0]))]));
    rootItems.push(...items);
    const type = !bodies && sets ? curvesOnly ? 'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION'
      : 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION'
      : bodies && !sets && solidsOnly ? 'ADVANCED_BREP_SHAPE_REPRESENTATION' : 'SHAPE_REPRESENTATION';
    if (!items.length) note('a model with no items (an empty representation)');
    writeContext();
    emit(rootId, type, [str(opts.name ?? ''), refs(items), ref(contextId)]);
  }

  function writeContext() {
    const info = decode.part(d);
    out.push(...stepContext(ids, contextId, info.unit, info.uncertainty, opts.derivedDimensions));
  }

  function* instances(): Generator<Instance> {
    const flush = function* () { yield* out; out.length = 0; };
    for (let k = 0; k < rowCount(d, 'curve'); k++) {
      if (!live.curve[k]) continue;
      writeCurve(k);
      yield* flush();
    }
    for (let k = 0; k < rowCount(d, 'surface'); k++) {
      if (!live.surface[k]) continue;
      writeSurface(k);
      yield* flush();
    }
    for (let k = 0; k < rowCount(d, 'vertex'); k++) {
      if (!live.vertex[k]) continue;
      const v = decode.vertex(d, k);
      if (v.tolerance !== undefined) note('vertex tolerances (not written: STEP has none per entity)', v.id, 'info');
      // A vertex of edges or vertex loops a VERTEX_POINT, a poly loop's corner the point alone (a POLY_LOOP's corners
      // are CARTESIAN_POINTs), one of both the VERTEX_POINT's point (its own id the VERTEX_POINT's).
      if (live.vertex[k]! & VERTEX_USE) {
        const p = point(v.point);
        vertexId[k] = emit(own(v.id), 'VERTEX_POINT', [NAME, ref(p)]);
        cornerId[k] = p;
      } else cornerId[k] = emit(own(v.id), 'CARTESIAN_POINT', [NAME, reals(v.point)]);
      yield* flush();
    }
    for (let k = 0; k < rowCount(d, 'edge'); k++) {
      if (!live.edge[k]) continue;
      writeEdge(k);
      yield* flush();
    }
    for (let f = 0; f < nFaces; f++) {
      if (!live.face[f]) continue;
      writeFace(f);
      yield* flush();
    }
    for (let k = 0; k < rowCount(d, 'shell'); k++) {
      if (!live.shell[k]) continue;
      writeShell(k);
      yield* flush();
    }
    for (let k = 0; k < rowCount(d, 'body'); k++) {
      if (!live.body[k]) continue;
      writeBody(k);
      yield* flush();
    }
    writeRoot();
    yield* flush();
    for (const [message, x] of problems) {
      const ids = x.ids.length ? ` (#${x.ids.join(', #')}${x.n > x.ids.length ? ', ...' : ''})` : '';
      diagnostics.push({ severity: x.severity, message: `${x.n === 1 ? '' : `${x.n} x `}${message}${ids}` });
    }
  }

  return { rootId, instances: instances(), diagnostics, faceIds, surfaceIds, faceCopies, sourceIds, items: rootItems,
    contextId, setMembers };
}

/**
 * A representation context with its units, as instances: the length unit (millimetres per unit: SI where there's a
 * prefix for it, else a conversion-based unit, INCH and FOOT by name, its dimensions derived where
 * `derivedDimensions`, as AP214 edition 3 has them), radians, steradians, and the uncertainty in that unit if given.
 * `id` is the context's own.
 */
export function stepContext(ids: StepIds, id: number, unit: number, uncertainty?: number, derivedDimensions = false):
  Instance[] {
  const out: Instance[] = [];
  const emit = (i: number, type: string, attrs: Value[]) => { out.push({ id: i, type, attrs }); return i; };
  const emitComplex = (i: number, parts: EntityRecord[]) => { out.push({ id: i, parts }); return i; };
  const fresh = () => ids.fresh();
  const si = (prefix: string | null, name: string) => [{ type: 'SI_UNIT', attrs: [prefix ? enu(prefix) : UNSET,
    enu(name)] }];
  const named: EntityRecord = { type: 'NAMED_UNIT', attrs: [DERIVED] };
  let length: number;
  const prefix = SI_LENGTH.get(unit);
  if (prefix !== undefined) {
    length = emitComplex(fresh(), [{ type: 'LENGTH_UNIT', attrs: [] }, named, ...si(prefix, 'METRE')]);
  } else {
    const mm = emitComplex(fresh(), [{ type: 'LENGTH_UNIT', attrs: [] }, named, ...si('MILLI', 'METRE')]);
    const factor = emit(fresh(), 'LENGTH_MEASURE_WITH_UNIT', [{ k: 'typed', type: 'LENGTH_MEASURE',
      v: real(unit) }, ref(mm)]);
    const dims = derivedDimensions ? DERIVED : ref(emit(fresh(), 'DIMENSIONAL_EXPONENTS',
      [1, 0, 0, 0, 0, 0, 0].map(real)));
    length = emitComplex(fresh(), [{ type: 'CONVERSION_BASED_UNIT', attrs: [str(NAMED_LENGTH.get(unit)
      ?? 'UNIT'), ref(factor)] }, { type: 'LENGTH_UNIT', attrs: [] }, { type: 'NAMED_UNIT', attrs: [dims] }]);
  }
  const angle = emitComplex(fresh(), [named, { type: 'PLANE_ANGLE_UNIT', attrs: [] }, ...si(null, 'RADIAN')]);
  const solid = emitComplex(fresh(), [named, ...si(null, 'STERADIAN'), { type: 'SOLID_ANGLE_UNIT', attrs: [] }]);
  const parts: EntityRecord[] = [{ type: 'GEOMETRIC_REPRESENTATION_CONTEXT', attrs: [int(3)] }];
  if (uncertainty !== undefined) {
    const u = emit(fresh(), 'UNCERTAINTY_MEASURE_WITH_UNIT', [{ k: 'typed', type: 'LENGTH_MEASURE',
      v: real(uncertainty) }, ref(length), str('distance_accuracy_value'), str('confusion accuracy')]);
    parts.push({ type: 'GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT', attrs: [refs([u])] });
  }
  parts.push({ type: 'GLOBAL_UNIT_ASSIGNED_CONTEXT', attrs: [refs([length, angle, solid])] },
    { type: 'REPRESENTATION_CONTEXT', attrs: [str(), str()] });
  emitComplex(id, parts);
  return out;
}
