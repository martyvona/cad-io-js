// What curves, surfaces and representations the corpus's STEP files use (docs/future.md): the surface of every face
// (advanced or plain `face_surface`) and the curve of every edge the faces reach, then the geometry no face reaches
// and the representations that hold it, then which representations hold solids, surface models and sets. Shows how
// much of Part 42 real B-rep uses beyond AP242's advanced face. Each row has its count, the files it occurs in and
// one example (file and instance id). A survey: it asserts nothing.
// Usage: node corpus_checks/step_geometry.ts [file-list.txt] [max MB, default 1000]  (progress on standard error;
// the log used --max-old-space-size=12000)
import fs from 'node:fs';
import { parseStep, type Value } from '../packages/step-parser/src/index.ts';
import { corpusFiles, shortName } from './corpus.ts';

/** The curve and surface types tallied: Part 42's, as AP242 includes them, including those no corpus file uses. */
const GEOMETRY = new Set([
  'LINE', 'CIRCLE', 'ELLIPSE', 'HYPERBOLA', 'PARABOLA', 'POLYLINE', 'B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS',
  'BEZIER_CURVE', 'RATIONAL_B_SPLINE_CURVE', 'QUASI_UNIFORM_CURVE', 'UNIFORM_CURVE', 'TRIMMED_CURVE',
  'COMPOSITE_CURVE', 'COMPOSITE_CURVE_ON_SURFACE', 'BOUNDARY_CURVE', 'OUTER_BOUNDARY_CURVE', 'OFFSET_CURVE_2D',
  'OFFSET_CURVE_3D', 'SURFACE_CURVE', 'SEAM_CURVE', 'INTERSECTION_CURVE', 'BOUNDED_SURFACE_CURVE', 'PCURVE',
  'BOUNDED_PCURVE', 'DEGENERATE_PCURVE', 'EVALUATED_DEGENERATE_PCURVE', 'CURVE_REPLICA', 'IMPLICIT_INTERSECTION_CURVE',
  'IMPLICIT_PROJECTED_CURVE', 'IMPLICIT_SILHOUETTE_CURVE', 'IMPLICIT_MODEL_INTERSECTION_CURVE',
  'LOCALLY_REFINED_SPLINE_CURVE', 'PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE',
  'TOROIDAL_SURFACE', 'DEGENERATE_TOROIDAL_SURFACE', 'DUPIN_CYCLIDE_SURFACE', 'SURFACE_OF_LINEAR_EXTRUSION',
  'SURFACE_OF_REVOLUTION', 'SURFACE_CURVE_SWEPT_SURFACE', 'FIXED_REFERENCE_SWEPT_SURFACE', 'B_SPLINE_SURFACE',
  'B_SPLINE_SURFACE_WITH_KNOTS', 'BEZIER_SURFACE', 'RATIONAL_B_SPLINE_SURFACE', 'QUASI_UNIFORM_SURFACE',
  'UNIFORM_SURFACE', 'LOCALLY_REFINED_SPLINE_SURFACE', 'OFFSET_SURFACE', 'RECTANGULAR_TRIMMED_SURFACE',
  'CURVE_BOUNDED_SURFACE', 'RECTANGULAR_COMPOSITE_SURFACE', 'SURFACE_REPLICA', 'ORIENTED_SURFACE',
]);
/** What representations are tallied as holding: solids, surface and wireframe models, sets, CSG, tessellation. */
const MODELS = new Set([
  'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL',
  'GEOMETRIC_CURVE_SET', 'GEOMETRIC_SET', 'EDGE_BASED_WIREFRAME_MODEL', 'SHELL_BASED_WIREFRAME_MODEL', 'CSG_SOLID',
  'BOOLEAN_RESULT', 'EXTRUDED_AREA_SOLID', 'REVOLVED_AREA_SOLID', 'SWEPT_DISK_SOLID', 'BLOCK',
  'SOLID_WITH_CONSTANT_RADIUS_EDGE_BLEND', 'SOLID_WITH_VARIABLE_RADIUS_EDGE_BLEND', 'TESSELLATED_SHELL',
  'TESSELLATED_SOLID',
]);
const isRepresentation = (t: string) => t.endsWith('REPRESENTATION') || t === 'DRAUGHTING_MODEL';
/** Presentation representations reach the shape through styled items: not where the geometry lives. */
const isPresentation = (label: string) => /_PRESENTATION_|DRAUGHTING_MODEL/.test(label);
/** Where the walk from a representation's items stops: other representations, contexts, units, mapped items. */
const stopsWalk = (t: string) => isRepresentation(t) || t.endsWith('CONTEXT') || t.includes('UNIT')
  || t === 'MAPPED_ITEM';

interface Row { count: number; files: Set<string>; example: string }
type Table = Map<string, Row>;
const tables = {
  faces: new Map() as Table, faceSurfaces: new Map() as Table, edgeCurves: new Map() as Table,
  inFaces: new Map() as Table, outside: new Map() as Table, outsideWhere: new Map() as Table,
  models: new Map() as Table,
};
function add(t: Table, key: string, file: string, id: number) {
  let r = t.get(key);
  if (!r) t.set(key, r = { count: 0, files: new Set(), example: `${file} #${id}` });
  r.count++;
  r.files.add(file);
}

function refsIn(values: Value[], out: number[]) {
  for (const v of values) {
    if (v.k === 'ref') out.push(v.v);
    else if (v.k === 'refs') for (const r of v.v as ArrayLike<number>) out.push(r);
    else if (v.k === 'list') refsIn(v.v, out);
    else if (v.k === 'typed') refsIn([v.v], out);
  }
}

const maxMB = Number(process.argv[3] ?? 1000);
let files = 0, skipped = 0;
const t0 = Date.now();
for (const path of corpusFiles(process.argv[2])) {
  if (fs.statSync(path).size > maxMB * 1e6) { skipped++; continue; }
  const file = shortName(path);
  process.stderr.write(`${file}\n`);
  files++;
  const step = parseStep(new Uint8Array(fs.readFileSync(path)));
  // Per instance: its types (a complex instance's partials), its references, and the attributes of the partial that
  // is a face or an edge curve (whose surface and curve are read by position).
  const types = new Map<number, string[]>(), refs = new Map<number, number[]>(), attrs = new Map<number, Value[]>();
  for (const inst of step.instances()) {
    const parts = 'type' in inst ? [{ type: inst.type, attrs: inst.attrs }] : inst.parts;
    types.set(inst.id, parts.map((p) => p.type));
    const r: number[] = [];
    for (const p of parts) refsIn(p.attrs, r);
    refs.set(inst.id, r);
    const own = parts.find((p) => p.type === 'ADVANCED_FACE' || p.type === 'FACE_SURFACE' || p.type === 'EDGE_CURVE');
    if (own) attrs.set(inst.id, own.attrs);
  }
  /** An instance's geometry types joined (a rational B-spline is a complex instance), or `missing`. */
  const geometryOf = (id: number) => {
    const t = types.get(id);
    if (!t) return 'missing';
    return t.filter((x) => GEOMETRY.has(x)).sort().join('+') || t.join('+');
  };

  // Faces (ADVANCED_FACE(name, bounds, face_geometry, same_sense)) and everything they reach.
  const reached = new Set<number>();
  const stack: number[] = [];
  for (const [id, t] of types) {
    const kind = t.includes('ADVANCED_FACE') ? 'ADVANCED_FACE' : t.includes('FACE_SURFACE') ? 'FACE_SURFACE' : '';
    if (!kind) continue;
    add(tables.faces, kind, file, id);
    const surface = attrs.get(id)![2];
    add(tables.faceSurfaces, `${kind}: ${surface?.k === 'ref' ? geometryOf(surface.v) : 'not a reference'}`, file, id);
    stack.push(id);
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const r of refs.get(id) ?? []) if (!reached.has(r)) stack.push(r);
  }
  for (const id of reached) {
    if (!types.get(id)?.includes('EDGE_CURVE')) continue;
    const curve = attrs.get(id)![3]; // EDGE_CURVE(name, start, end, edge_geometry, same_sense)
    add(tables.edgeCurves, curve?.k === 'ref' ? geometryOf(curve.v) : 'not a reference', file, id);
  }
  for (const [id, t] of types) {
    for (const g of t) if (GEOMETRY.has(g)) add(reached.has(id) ? tables.inFaces : tables.outside, g, file, id);
  }

  // Representations: the models each holds, and the representations reaching geometry no face reaches (a shape
  // representation preferred to a presentation one).
  const where = new Map<number, Set<string>>();
  for (const [id, t] of types) {
    if (!t.some(isRepresentation)) continue;
    const label = t.filter(isRepresentation).sort().join('+');
    const local = new Set<number>();
    const walk = (refs.get(id) ?? []).slice();
    while (walk.length) {
      const x = walk.pop()!;
      const tx = types.get(x);
      if (local.has(x) || !tx || tx.some(stopsWalk)) continue;
      local.add(x);
      walk.push(...(refs.get(x) ?? []));
    }
    for (const x of local) {
      const tx = types.get(x)!;
      if (!isPresentation(label)) for (const m of tx) if (MODELS.has(m)) add(tables.models, `${label} > ${m}`, file, x);
      if (!reached.has(x) && tx.some((g) => GEOMETRY.has(g))) {
        let s = where.get(x);
        if (!s) where.set(x, s = new Set());
        s.add(label);
      }
    }
  }
  for (const [id, t] of types) {
    if (reached.has(id) || !t.some((g) => GEOMETRY.has(g))) continue;
    const labels = [...(where.get(id) ?? [])];
    const shape = labels.filter((l) => !isPresentation(l));
    const use = labels.length ? (shape.length ? shape : labels) : ['(no representation)'];
    for (const g of t) if (GEOMETRY.has(g)) for (const l of use) add(tables.outsideWhere, `${g} in ${l}`, file, id);
  }
}

function show(title: string, t: Table) {
  console.log(`\n## ${title}`);
  for (const [k, r] of [...t].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))) {
    console.log(`${String(r.count).padStart(9)} ${String(r.files.size).padStart(4)} files  ${k}  (${r.example})`);
  }
}
console.log(`files ${files}, ${skipped} over ${maxMB} MB skipped; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
show('faces', tables.faces);
show('face surfaces', tables.faceSurfaces);
show('edge curves (the edges the faces reach)', tables.edgeCurves);
show('geometry instances the faces reach, by type (a complex instance under each of its types)', tables.inFaces);
show('geometry instances no face reaches, by type', tables.outside);
show('geometry no face reaches, by the representation reaching it (once per representation)', tables.outsideWhere);
show('models in representations (presentation representations left out)', tables.models);
