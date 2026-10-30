// The STEP importer: a parsed file, through Layer 2 and Layer 3 (step-parser), to the scene model (cad-scene). See
// README.md, "`step-import`", and CLAUDE.md, "STEP files in the wild", for the conventions files follow.
//
//   products        -> components (index for index); their documents -> external references
//   occurrences     -> each component's children, with transforms converted to millimetres
//   representations -> parts, one per shape representation holding geometry, with a STEP subset as payload; those
//                      only tessellated with their triangles as a level of detail instead (tessellated.ts)
//   styles          -> materials: per part, per face, per component, and per instance (context-dependent styles)
//   layers          -> layers of parts and faces

import {
  buildSubset, closure, danglingRefs, extractSemantics, math, openModel, productRepresentations, readStep, Reader,
  type Diagnostic as StepDiagnostic, type Mat4, type OpenOptions, type Semantics, type StepFile, type StepModel,
  type StepSource, type Style,
} from 'step-parser';
import { dropSourceDegenerate, type Component, type Diagnostic, type Layer, type Lod, type Material, type Part,
  type Scene, type Vec3 } from 'cad-scene';
import { faceOutlines } from './outlines.ts';
import { moveMesh, readTessellated, tessellatedItems } from './tessellated.ts';

export interface ImportOptions extends OpenOptions {
  /**
   * Representations holding only tessellated geometry (AP242's triangulated faces, surface sets, curve sets...):
   * `'read'` (the default) reads their triangles, curves and points into a level of detail from the source, with no
   * B-rep, and a product's tessellation of its B-rep into a level of the B-rep's part; `'backend'` makes them B-rep
   * parts like any other, meshed by a backend from their STEP subset (OCCT reads tessellated geometry; truck doesn't),
   * as before 2026-10-29.
   */
  tessellated?: 'read' | 'backend';
  /**
   * Drop triangles with two corners at one position from the file's meshes (cad-scene's dropSourceDegenerate), with
   * an info diagnostic per part. Default true; false keeps every triangle the file gives.
   */
  dropDegenerate?: boolean;
}

export interface ImportResult {
  scene: Scene;
  model: StepModel;
  semantics: Semantics;
  /** Part index by shape representation id. */
  partOf: Map<number, number>;
}

/** Read, bind, extract and import a STEP file. */
export async function importStep(input: StepSource | StepFile, opts: ImportOptions = {}): Promise<ImportResult> {
  const file = 'index' in input ? input : await readStep(input as StepSource);
  const model = await openModel(file, opts);
  return sceneFromStep(model, extractSemantics(model), opts);
}

/** Dangling references named in a part's warning; the rest are counted. */
const MAX_DANGLING = 10;
const PLACEMENT_ONLY = ['AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'MAPPED_ITEM', 'CARTESIAN_TRANSFORMATION_OPERATOR'];
/** Presentation (text, callouts, annotation occurrences): not shape, so a representation of only these isn't a part. */
const ANNOTATION = ['TEXT_LITERAL', 'COMPOSITE_TEXT', 'DRAUGHTING_CALLOUT', 'ANNOTATION_OCCURRENCE'];
/** Two-dimensional drawings: not parts until drawings are supported (CLAUDE.md, "Decisions"). */
const DRAWING = 'GEOMETRICALLY_BOUNDED_2D_WIREFRAME_REPRESENTATION';

/** Build the scene from a bound model and its Layer 3 semantics. */
export function sceneFromStep(model: StepModel, sem: Semantics, opts: ImportOptions = {}): ImportResult {
  const file = model.file;
  const r = new Reader(model);
  const s = sem.structure;
  const diagnostics: Diagnostic[] = [];
  const warn = (message: string, id?: number, severity: Diagnostic['severity'] = 'warning') =>
    diagnostics.push(id === undefined ? { severity, message } : { severity, message, source: { format: 'step', id } });
  const src = (id: number) => ({ format: 'step', id });

  // Millimetres per unit of a representation; files without a length unit are read as millimetres.
  const mmOf = (repId: number | undefined): number => {
    const f = repId === undefined ? undefined : s.representations.get(repId)?.context?.lengthUnit?.factor;
    return f === undefined ? 1 : f * 1000;
  };

  // A tessellation's stated accuracy (AP242 edition 2's ..._WITH_ACCURACY_PARAMETERS), in millimetres and radians.
  const accuracy = (repId: number, root: number): Partial<Lod> => {
    const out: Partial<Lod> = {};
    const radians = s.representations.get(repId)?.context?.planeAngleUnit?.factor ?? 1;
    const v = r.attr(root, 'tessellation_accuracy_parameters');
    for (const x of v && v.k === 'list' ? v.v : []) {
      if (x.k !== 'typed' || (x.v.k !== 'real' && x.v.k !== 'int')) continue;
      const n = Number(x.v.v);
      if (x.type === 'CHORDAL_DEVIATION') out.linearDeflection = n * mmOf(repId);
      else if (x.type === 'ANGULAR_DEVIATION') out.angularDeflection = n * radians;
    }
    return out;
  };

  // Faces as parts' meshes have them: B-rep faces, and tessellated faces and surface sets.
  const isFace = (q: number) => model.isInstanceOf(q, 'FACE') || model.isInstanceOf(q, 'TESSELLATED_FACE')
    || model.isInstanceOf(q, 'TESSELLATED_SURFACE_SET');

  // Materials, deduplicated by colour and opacity.
  const materials: Material[] = [];
  const materialIndex = new Map<string, number>();
  // Faces take surface colours, or failing that a surface style's boundary colour (writers such as Unigraphics colour
  // solids only through SURFACE_STYLE_BOUNDARY, and mean the faces; decided by the user, 2026-10-17); wireframe and
  // point parts their curve or point colour.
  const materialOf = (style: Style | undefined, sourceId?: number, surfaceOnly = false): number | undefined => {
    const c = surfaceOnly ? style?.surface ?? style?.boundary : style?.surface ?? style?.curve ?? style?.point;
    if (!c) return undefined;
    const opacity = 1 - (style?.transparency ?? 0);
    const key = `${c.join(',')},${opacity}`;
    let i = materialIndex.get(key);
    if (i === undefined) {
      i = materials.length;
      materials.push({ color: [...c], opacity, sources: [] });
      materialIndex.set(key, i);
    }
    if (sourceId !== undefined && !materials[i]!.sources.some((x) => x.id === sourceId)) materials[i]!.sources.push(
      src(sourceId));
    return i;
  };

  // Styles by styled item position, without the context-dependent ones (resolved per instance below).
  const styles = sem.styles;
  const ownStyle = (p: number): Style | undefined => {
    // Context-dependent (per instance, below) and per-view styles (PRESENTATION_STYLE_BY_CONTEXT) aren't the default.
    const list = styles.byItem.get(r.id(p))?.filter((x) => !x.context && !x.presentationContext);
    if (!list?.length) return undefined;
    // Overrides first, then plain styles, later ones before earlier (two overrides of one style: the later wins, as in
    // OCCT); each property from the first that has it.
    const out: Style = {};
    for (const x of [...list.filter((y) => y.overrides !== undefined).reverse(),
      ...list.filter((y) => y.overrides === undefined).reverse()]) {
      for (const k of Object.keys(x.style) as (keyof Style)[]) if (out[k] === undefined) (
        out as Record<string, unknown>)[k] = x.style[k];
    }
    return out;
  };

  // Parts: shape representations with geometry (anything but placements, mapped items and annotations), other than
  // drawings.
  const parts: Part[] = [];
  const partOf = new Map<number, number>();
  const partOfPosition = new Map<number, number>(); // top-level items, faces and roots -> part
  // Per part: its representation, and for those read from tessellated geometry, their faces (entities, in mesh order).
  const partRep: number[] = [];
  const partGeometry: number[][] = [];
  const faceCount: number[] = [];
  const onlyTessellated: boolean[] = []; // read or not
  const tessellatedFaces = new Map<number, number[]>();
  for (const rep of s.representations.values()) {
    const items = rep.items.map((id) => model.resolve(id));
    if (!items.some((q) => q >= 0 && ![...PLACEMENT_ONLY, ...ANNOTATION].some(
      (e) => model.isInstanceOf(q, e)))) continue;
    if (rep.types.includes(DRAWING)) {
      warn('a two-dimensional drawing; not imported', rep.id, 'info');
      continue;
    }
    const root = model.resolve(rep.id);
    // Only tessellated geometry: read here (unless asked for the backend), or, with items this reader doesn't take,
    // left to the backend as before.
    const geometry = items.filter((q) => q >= 0 && ![...PLACEMENT_ONLY, ...ANNOTATION].some((e) =>
      model.isInstanceOf(q, e)));
    const tessellated = opts.tessellated === 'backend' ? undefined : tessellatedItems(r, geometry);
    if (tessellated && !tessellated.readable) warn(`tessellated geometry with ${tessellated.type}, which isn't read; `
      + 'meshed by the backend', rep.id, 'info');
    const read = tessellated?.readable ? readTessellated(r, geometry, (m, p) => warn(m, r.id(p))) : undefined;
    const exclude = new Set(items.filter((q) => q >= 0 && model.isInstanceOf(q, 'MAPPED_ITEM')));
    const positions = closure(file, [root], exclude);
    const dangling = danglingRefs(file, positions);
    if (dangling.length) {
      const shown = dangling.slice(0, MAX_DANGLING).map((id) => `#${id}`).join(', ');
      warn(`${dangling.length === 1 ? '1 reference to an instance' : `${dangling.length} references to instances`} the `
        + `file doesn't define: ${shown}${dangling.length > MAX_DANGLING ? ', ...' : ''}`, rep.id);
    }
    const index = parts.length;
    partRep.push(rep.id);
    partGeometry.push(geometry);
    onlyTessellated.push(tessellated !== undefined || geometry.every((q) => model.isInstanceOf(q, 'TESSELLATED_ITEM')));
    if (read) tessellatedFaces.set(index, read.faces);
    partOf.set(rep.id, index);
    partOfPosition.set(root, index);
    for (const q of items) if (!partOfPosition.has(q)) partOfPosition.set(q, index);

    // The origin: the centre of the bounding box of the part's vertices, which lie on its shape; else (no vertices:
    // a geometric set's curves and points, tessellated faces) of all its points. Not of all points whatever: a
    // B-spline's control points can lie far off (bug24383_224013.stp has some 30 km away from a 32 mm part), and
    // positions are float32 minus the origin, so its faces lost their triangles to rounding (the user, 2026-10-29).
    const box = () => ({ lo: [Infinity, Infinity, Infinity] as Vec3, hi: [-Infinity, -Infinity, -Infinity] as Vec3 });
    const all = box(), vertices = box();
    const extend = (b: ReturnType<typeof box>, p: number) => {
      const c = r.attr(p, 'coordinates');
      const xs = c && (c.k === 'reals' || c.k === 'ints') ? Array.from(c.v as ArrayLike<number>) : undefined;
      if (xs && xs.length >= 2) for (let k = 0; k < 3; k++) {
        const x = xs[k] ?? 0;
        if (x < b.lo[k]!) b.lo[k] = x;
        if (x > b.hi[k]!) b.hi[k] = x;
      }
    };
    const faces: number[] = read ? [...read.faces] : [];
    if (read) for (const q of read.faces) if (!partOfPosition.has(q)) partOfPosition.set(q, index);
    if (!read) for (const q of positions) {
      const type = file.index.typeName(q);
      if (type === 'CARTESIAN_POINT') extend(all, q);
      else if (type === 'VERTEX_POINT') {
        const g = r.ref(q, 'vertex_geometry');
        if (g >= 0 && file.index.typeName(g) === 'CARTESIAN_POINT') extend(vertices, g);
      } else if (model.isInstanceOf(q, 'FACE') || model.isInstanceOf(q, 'TESSELLATED_FACE')) {
        faces.push(q);
        if (!partOfPosition.has(q)) partOfPosition.set(q, index);
      }
    }
    // A geometric set's surfaces are faces too (a backend makes one face of each, with the surface's id).
    const isFace = new Set(faces);
    if (!read) for (const q of positions) {
      if (!model.isInstanceOf(q, 'GEOMETRIC_SET')) continue;
      for (const e of r.refs(q, 'elements')) {
        if (!model.isInstanceOf(e, 'SURFACE') || isFace.has(e)) continue;
        isFace.add(e);
        faces.push(e);
        if (!partOfPosition.has(e)) partOfPosition.set(e, index);
      }
    }
    const { lo, hi } = vertices.lo[0] === Infinity ? all : vertices;
    const origin: Vec3 = read ? read.mesh.origin
      : lo[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as Vec3;
    // Closed: every face in a closed shell of the part (solids' shells and voids, closed shells of surface models);
    // open if one is in another shell of the part (an open shell, a face set), which the file then says; otherwise
    // the file doesn't say: faces in no shell (a geometric set's surfaces, as bug28366_fuselage.stp's, which close up
    // all the same), tessellated faces (in tessellated shells, not face sets) (the user, 2026-10-27: caps on what the
    // file says is solid).
    const inPart = new Set(positions);
    let closed: boolean | undefined = read ? read.closed : faces.length ? true : undefined;
    if (!read) for (const f of faces) {
      const shells = model.referrers(f).filter((q) => inPart.has(q) && model.isInstanceOf(q, 'CONNECTED_FACE_SET'));
      if (shells.some((q) => !model.isInstanceOf(q, 'CLOSED_SHELL'))) {
        closed = false;
        break;
      }
      if (!shells.length) closed = undefined;
    }
    faceCount.push(faces.length);
    const part: Part = {
      ...(read ? {} : { brep: {
        format: 'step', rootId: rep.id,
        payload: () => buildSubset(file, [root], { exclude }).bytes,
        // Faces' outlines from the file, for faces that fail to mesh (outlines.ts).
        outline: ({ faces: only, ...o }) => ({ faces: faces.map((q) => r.id(q)),
          ...faceOutlines(r, faces, origin, o, only) }),
      } }),
      lods: read ? [{ mesh: read.mesh, from: 'source', ...accuracy(rep.id, root) }] : [],
      name: rep.name, sources: [src(rep.id)], properties: { representation: rep.types.join('+') },
      unit: mmOf(rep.id), origin, ...(closed === undefined ? {} : { closed }),
    };
    if (s.representations.get(rep.id)?.context?.lengthUnit === undefined) warn(
      'representation without a length unit; read as millimetres', rep.id);

    // Face materials: each face's style resolved up through its shell, solid and the representation, within the part.
    const resolved = new Map<number, Style | null>();
    const resolve = (p: number, depth = 0): Style | null => {
      let st = resolved.get(p);
      if (st !== undefined) return st;
      const own = ownStyle(p);
      let up: Style | null = null;
      if (depth < 8) {
        for (const q of model.referrers(p)) {
          if (!inPart.has(q) || model.isInstanceOf(q, 'STYLED_ITEM')) continue;
          up = resolve(q, depth + 1);
          if (up) break;
        }
      }
      st = own || up ? { ...(up ?? {}), ...(own ?? {}) } : null;
      resolved.set(p, st);
      return st;
    };
    const faceMaterial = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const f of faces) {
      const m = materialOf(resolve(f) ?? undefined, undefined, true);
      if (m === undefined) continue;
      faceMaterial.set(f, m);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    if (counts.size && faceMaterial.size === faces.length) {
      // Every face has a colour: the most common is the part's, the others per face.
      const main = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      part.material = main;
      const others = [...faceMaterial].filter(([, m]) => m !== main).map(([f, m]) => ({ face: r.id(f), material: m }));
      if (others.length) part.faceMaterials = others;
    } else if (counts.size) {
      // Some faces have none: those stay unstyled (the viewer's default), so the colours go per face.
      part.faceMaterials = [...faceMaterial].map(([f, m]) => ({ face: r.id(f), material: m }));
    } else {
      // No faces (wireframe, points) or no styled faces: the style of the representation or its items.
      const m = materialOf(resolve(root) ?? items.map((q) => resolve(q)).find((x) => x) ?? undefined);
      if (m !== undefined) part.material = m;
    }
    const topStyles = items.map((q) => resolve(q));
    if (topStyles.length && topStyles.every((x) => x?.invisible)) part.properties.invisible = true;
    parts.push(part);
  }

  if (opts.tessellated !== 'backend') mergeTessellations();

  // A product's tessellation of its B-rep (both its representations) becomes a level of the B-rep's part, from the
  // source, and its own part goes (decided by the user, 2026-10-29): paired by the tessellation's links to the B-rep
  // (a solid's to its MANIFOLD_SOLID_BREP, faces' to their faces) where it has them, else with the product's one B-rep
  // part with faces; with several and no links, or claimed by two products, it stays a part of its own (a warning).
  // Linked faces take their B-rep face's id, so a face is one face at either level.
  function mergeTessellations(): void {
    const target = new Map<number, number | null>(); // tessellated part -> B-rep part (null: conflicting)
    const moves = new Map<number, Mat4>();
    s.products.forEach((_, i) => {
      const reps = productRepresentations(s, i).filter((x) => partOf.has(x.representation));
      const breps = reps.filter((x) => { const p = partOf.get(x.representation)!;
        return parts[p]!.brep !== undefined && !onlyTessellated[p] && faceCount[p]! > 0; });
      for (const t of reps) {
        const tp = partOf.get(t.representation)!;
        const faces = tessellatedFaces.get(tp);
        if (!faces?.length) continue;
        const links = new Set<number>();
        for (const q of [...partGeometry[tp]!, ...faces]) {
          const l = r.ref(q, 'geometric_link');
          const part = l >= 0 ? partOfPosition.get(l) : undefined;
          if (part !== undefined && breps.some((x) => partOf.get(x.representation) === part)) links.add(part);
        }
        const b = links.size === 1 ? breps.find((x) => partOf.get(x.representation) === [...links][0])
          : links.size === 0 && breps.length === 1 ? breps[0] : undefined;
        if (!b) {
          if (breps.length) warn(`a tessellation beside ${breps.length} B-rep parts, none of which it links to; kept `
            + 'as a part of its own', t.representation);
          continue;
        }
        const bp = partOf.get(b.representation)!;
        if (target.has(tp) && target.get(tp) !== bp) { target.set(tp, null); continue; }
        const inv = math.invertAffine(b.transform);
        if (!inv) continue;
        target.set(tp, bp);
        moves.set(tp, math.multiply(inv, t.transform));
      }
    });
    const merged = [...target].filter(([, b]) => b !== null) as [number, number][];
    for (const [tp] of target) if (target.get(tp) === null) warn('a tessellation claimed by B-rep parts of two '
      + 'products; kept as a part of its own', partRep[tp]);
    if (!merged.length) return;
    for (const [tp, bp] of merged) {
      const t = parts[tp]!, b = parts[bp]!;
      const lod = t.lods[0]!;
      const mesh = moveMesh(lod.mesh, moves.get(tp)!);
      // Linked faces as their B-rep face; others keep their own id and colour.
      const faces = tessellatedFaces.get(tp)!;
      mesh.faces = mesh.faces.map((f, k) => {
        const l = r.ref(faces[k]!, 'geometric_link');
        return l >= 0 && partOfPosition.get(l) === bp && model.isInstanceOf(l, 'FACE') ? { ...f, source: r.id(l) } : f;
      });
      const own = new Set(mesh.faces.map((f) => f.source));
      const colours = new Map((t.faceMaterials ?? []).map((x) => [x.face, x.material]));
      for (const f of faces) {
        const id = r.id(f), m = colours.get(id) ?? t.material;
        if (own.has(id) && m !== undefined && m !== b.material) (b.faceMaterials ??= []).push({ face: id, material: m });
      }
      b.lods.push({ ...lod, mesh });
      b.sources.push(...t.sources);
      for (const [q, p] of partOfPosition) if (p === tp) partOfPosition.set(q, bp);
      partOf.delete(partRep[tp]!);
    }
    // Renumber the parts left.
    const gone = new Set(merged.map(([tp]) => tp));
    const renumber = new Map<number, number>();
    let n = 0;
    parts.forEach((_, i) => { if (!gone.has(i)) renumber.set(i, n++); });
    const kept = parts.filter((_, i) => !gone.has(i));
    parts.length = 0;
    parts.push(...kept);
    for (const [k, p] of partOf) partOf.set(k, renumber.get(p)!);
    for (const [k, p] of partOfPosition) partOfPosition.set(k, renumber.get(p)!);
  }

  // Parts with a generic name (blank, NONE, #123) take the name of the first product that uses them, if it has one
  // (decided by the user, 2026-10-22).
  s.products.forEach((p, i) => {
    for (const { representation } of productRepresentations(s, i)) {
      const part = partOf.get(representation);
      const name = productName(p);
      if (part !== undefined && genericName(parts[part]!.name) && !genericName(name)) parts[part]!.name = name;
    }
  });

  // Components, one per product definition.
  const components: Component[] = s.products.map((p, i) => {
    const c: Component = {
      name: productName(p), sources: [src(p.id), ...(p.productId >= 0 ? [src(p.productId)] : [])],
      properties: Object.fromEntries(Object.entries({
        partNumber: p.partNumber, version: p.version, description: p.description, definitionId: p.definitionId,
        lifeCycleStage: p.lifeCycleStage,
      }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      parts: [], children: [],
    };
    const mainMm = mmOf(p.shapes[0]);
    for (const { representation, transform } of productRepresentations(s, i)) {
      const part = partOf.get(representation);
      if (part === undefined) continue;
      const ref: Component['parts'][number] = { part, transform: math.multiply(math.scaling(mainMm), transform) };
      if (parts[part]!.properties.invisible) ref.visible = false;
      c.parts.push(ref);
    }
    const ext = p.documents.find((d) => d.external);
    if (ext) c.external = { uri: ext.name, format: 'step' };
    // A style on the product's own (assembly) representation applies to everything in it.
    const main = p.shapes[0];
    if (main !== undefined && !partOf.has(main)) {
      const m = materialOf(ownStyle(model.resolve(main)));
      if (m !== undefined) c.material = m;
    }
    return c;
  });

  // Occurrences: child millimetres -> parent millimetres.
  const childIndex = new Map<number, number>(); // occurrence index -> index in its parent's children
  s.occurrences.forEach((o, i) => {
    const parentMm = mmOf(s.products[o.parent]!.shapes[0]), childMm = mmOf(s.products[o.child]!.shapes[0]);
    const t = math.multiply(math.multiply(math.scaling(parentMm), o.transform ?? math.identity()),
      math.scaling(1 / childMm));
    const props: Record<string, string> = { kind: o.kind };
    if (o.occurrenceId) props.occurrenceId = o.occurrenceId;
    if (o.referenceDesignator) props.referenceDesignator = o.referenceDesignator;
    const occ: Component['children'][number] = { component: o.child, transform: t, sources: [src(o.id)],
      properties: props };
    if (o.name) occ.name = o.name;
    childIndex.set(i, components[o.parent]!.children.length);
    components[o.parent]!.children.push(occ);
  });
  const roots = s.roots.map((i) => ({ component: i, transform: math.identity(), sources: [], properties: {} }));

  // Instance overrides: context-dependent overriding styles, whose context is the representation relationships from
  // the root down to the instance.
  const occurrenceByRelationship = new Map<number, number>();
  s.occurrences.forEach((o, i) => {
    if (o.source.relationship !== undefined) occurrenceByRelationship.set(o.source.relationship, i); });
  const overrides: Scene['overrides'] = [];
  for (const st of styles.styled) {
    if (!st.context) continue;
    const occs = st.context.map((id) => occurrenceByRelationship.get(id));
    if (!occs.length || occs.some((o) => o === undefined)) {
      warn('context-dependent style whose context is not a chain of occurrence placements', st.id); continue; }
    const first = s.occurrences[occs[0]!]!;
    const rootIndex = roots.findIndex((x) => x.component === first.parent);
    const chainOk = occs.every((o, k) => k === 0 || s.occurrences[o!]!.parent === s.occurrences[occs[k - 1]!]!.child);
    if (rootIndex < 0 || !chainOk) {
      warn('context-dependent style whose context does not start at a root or is not a chain', st.id); continue; }
    const path = [rootIndex, ...occs.map((o) => childIndex.get(o!)!)];
    const target = model.resolve(st.item);
    const material = materialOf(st.style, st.id);
    const ov: Scene['overrides'][number] = { path, sources: [src(st.id)] };
    if (st.style.invisible) ov.visible = false;
    const face = isFace(target) ? partOfPosition.get(target) : undefined;
    if (face !== undefined) {
      if (material !== undefined) ov.faceMaterials = [{ part: face, face: st.item, material }];
    } else if (material !== undefined) {
      ov.material = material;
    }
    overrides.push(ov);
  }

  // Layers.
  const layers: Layer[] = styles.layers.map((l) => {
    const layer: Layer = { name: l.name, visible: !l.invisible, parts: [], faces: [], sources: [src(l.id)] };
    if (l.description) layer.description = l.description;
    for (const id of l.items) {
      const q = model.resolve(id);
      const part = partOfPosition.get(q);
      if (part === undefined) continue;
      if (isFace(q)) layer.faces.push({ part, face: id });
      else if (!layer.parts.includes(part)) layer.parts.push(part);
    }
    return layer;
  });

  const convert = (d: StepDiagnostic): Diagnostic => (
    d.id === undefined ? { severity: d.severity, message: d.message } : { severity: d.severity, message: d.message,
    source: src(d.id) });
  const header = (type: string, i: number) => { const v = file.headerEntity(type)?.attrs[i];
    return v?.k === 'str' ? v.v : undefined; };
  const scene: Scene = {
    unit: 'millimetre', components, roots, parts, materials, layers, overrides,
    properties: Object.fromEntries(Object.entries({
      format: 'step', name: header('FILE_NAME', 0), originatingSystem: header('FILE_NAME', 5),
      preprocessorVersion: header('FILE_NAME', 4),
      schemas: file.schemaNames.join(', ') || undefined,
    }).filter(([, v]) => v !== undefined)) as Record<string, string>,
    diagnostics: [...file.diagnostics.map(convert), ...model.diagnostics.map(convert), ...sem.diagnostics.map(convert),
      ...diagnostics],
  };
  if (opts.dropDegenerate ?? true) dropSourceDegenerate(scene);
  return { scene, model, semantics: sem, partOf };
}

/** A product's name, else (blank) its part number (decided by the user, 2026-10-22). */
function productName(p: { name: string; partNumber: string }): string {
  return p.name.trim() || !p.partNumber.trim() ? p.name : p.partNumber;
}

/**
 * Names that say nothing of the part: blank, NONE, or an instance id such as #830 (as some writers name
 * representations).
 */
function genericName(name: string): boolean {
  return /^\s*(none|#\d+)?\s*$/i.test(name);
}
