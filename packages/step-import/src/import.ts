// The STEP importer: a parsed file, through Layer 2 and Layer 3 (step-parser), to the scene model (cad-scene). See
// docs/phase2_progress.md, step 3, for how each STEP construct maps.
//
//   products        → components (index for index); their documents → external references
//   occurrences     → each component's children, with transforms converted to millimetres
//   representations → parts, one per shape representation holding geometry, with a STEP subset as payload
//   styles          → materials: per part, per face, per component, and per instance (context-dependent styles)
//   layers          → layers of parts and faces

import {
  buildSubset, closure, extractSemantics, math, openModel, productRepresentations, readStep, Reader,
  type Diagnostic as StepDiagnostic, type OpenOptions, type Semantics, type StepFile, type StepModel, type StepSource, type Style,
} from 'step-parser';
import type { Component, Diagnostic, Layer, Material, Part, Scene, Vec3 } from 'cad-scene';

export interface ImportResult {
  scene: Scene;
  model: StepModel;
  semantics: Semantics;
  /** Part index by shape representation id. */
  partOf: Map<number, number>;
}

/** Read, bind, extract and import a STEP file. */
export async function importStep(input: StepSource | StepFile, opts: OpenOptions = {}): Promise<ImportResult> {
  const file = 'index' in input ? input : await readStep(input as StepSource);
  const model = await openModel(file, opts);
  return sceneFromStep(model, extractSemantics(model));
}

const PLACEMENT_ONLY = ['AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'MAPPED_ITEM', 'CARTESIAN_TRANSFORMATION_OPERATOR'];

/** Build the scene from a bound model and its Layer 3 semantics. */
export function sceneFromStep(model: StepModel, sem: Semantics): ImportResult {
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
    if (sourceId !== undefined && !materials[i]!.sources.some((x) => x.id === sourceId)) materials[i]!.sources.push(src(sourceId));
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
    for (const x of [...list.filter((y) => y.overrides !== undefined).reverse(), ...list.filter((y) => y.overrides === undefined).reverse()]) {
      for (const k of Object.keys(x.style) as (keyof Style)[]) if (out[k] === undefined) (out as Record<string, unknown>)[k] = x.style[k];
    }
    return out;
  };

  // Parts: shape representations with geometry (anything but placements and mapped items).
  const parts: Part[] = [];
  const partOf = new Map<number, number>();
  const partOfPosition = new Map<number, number>(); // top-level items, faces and roots → part
  for (const rep of s.representations.values()) {
    const items = rep.items.map((id) => model.resolve(id));
    if (!items.some((q) => q >= 0 && !PLACEMENT_ONLY.some((e) => model.isInstanceOf(q, e)))) continue;
    const root = model.resolve(rep.id);
    const exclude = new Set(items.filter((q) => q >= 0 && model.isInstanceOf(q, 'MAPPED_ITEM')));
    const positions = closure(file, [root], exclude);
    const index = parts.length;
    partOf.set(rep.id, index);
    partOfPosition.set(root, index);
    for (const q of items) if (!partOfPosition.has(q)) partOfPosition.set(q, index);

    // The origin: the centre of the bounding box of the part's points.
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    const faces: number[] = [];
    for (const q of positions) {
      if (file.index.typeName(q) === 'CARTESIAN_POINT') {
        const c = r.attr(q, 'coordinates');
        const xs = c && (c.k === 'reals' || c.k === 'ints') ? Array.from(c.v as ArrayLike<number>) : undefined;
        if (xs && xs.length >= 2) for (let k = 0; k < 3; k++) { const x = xs[k] ?? 0; if (x < lo[k]!) lo[k] = x; if (x > hi[k]!) hi[k] = x; }
      } else if (model.isInstanceOf(q, 'FACE') || model.isInstanceOf(q, 'TESSELLATED_FACE')) {
        faces.push(q);
        if (!partOfPosition.has(q)) partOfPosition.set(q, index);
      }
    }
    const origin: Vec3 = lo[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as Vec3;
    const part: Part = {
      kind: 'brep', format: 'step', rootId: rep.id,
      payload: () => buildSubset(file, [root], { exclude }).bytes,
      name: rep.name, sources: [src(rep.id)], properties: { representation: rep.types.join('+') },
      unit: mmOf(rep.id), origin,
    };
    if (s.representations.get(rep.id)?.context?.lengthUnit === undefined) warn('representation without a length unit; read as millimetres', rep.id);

    // Face materials: each face's style resolved up through its shell, solid and the representation, within the part.
    const inPart = new Set(positions);
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

  // Parts without a name of their own take the name of the first product that uses them.
  s.products.forEach((p, i) => {
    for (const { representation } of productRepresentations(s, i)) {
      const part = partOf.get(representation);
      if (part !== undefined && !parts[part]!.name) parts[part]!.name = p.name || p.partNumber;
    }
  });

  // Components, one per product definition.
  const components: Component[] = s.products.map((p, i) => {
    const c: Component = {
      name: p.name || p.partNumber, sources: [src(p.id), ...(p.productId >= 0 ? [src(p.productId)] : [])],
      properties: Object.fromEntries(Object.entries({
        partNumber: p.partNumber, version: p.version, description: p.description, definitionId: p.definitionId, lifeCycleStage: p.lifeCycleStage,
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

  // Occurrences: child millimetres → parent millimetres.
  const childIndex = new Map<number, number>(); // occurrence index → index in its parent's children
  s.occurrences.forEach((o, i) => {
    const parentMm = mmOf(s.products[o.parent]!.shapes[0]), childMm = mmOf(s.products[o.child]!.shapes[0]);
    const t = math.multiply(math.multiply(math.scaling(parentMm), o.transform ?? math.identity()), math.scaling(1 / childMm));
    const props: Record<string, string> = { kind: o.kind };
    if (o.occurrenceId) props.occurrenceId = o.occurrenceId;
    if (o.referenceDesignator) props.referenceDesignator = o.referenceDesignator;
    const occ: Component['children'][number] = { component: o.child, transform: t, sources: [src(o.id)], properties: props };
    if (o.name) occ.name = o.name;
    childIndex.set(i, components[o.parent]!.children.length);
    components[o.parent]!.children.push(occ);
  });
  const roots = s.roots.map((i) => ({ component: i, transform: math.identity(), sources: [], properties: {} }));

  // Instance overrides: context-dependent overriding styles, whose context is the representation relationships from
  // the root down to the instance.
  const occurrenceByRelationship = new Map<number, number>();
  s.occurrences.forEach((o, i) => { if (o.source.relationship !== undefined) occurrenceByRelationship.set(o.source.relationship, i); });
  const overrides: Scene['overrides'] = [];
  for (const st of styles.styled) {
    if (!st.context) continue;
    const occs = st.context.map((id) => occurrenceByRelationship.get(id));
    if (!occs.length || occs.some((o) => o === undefined)) { warn('context-dependent style whose context is not a chain of occurrence placements', st.id); continue; }
    const first = s.occurrences[occs[0]!]!;
    const rootIndex = roots.findIndex((x) => x.component === first.parent);
    const chainOk = occs.every((o, k) => k === 0 || s.occurrences[o!]!.parent === s.occurrences[occs[k - 1]!]!.child);
    if (rootIndex < 0 || !chainOk) { warn('context-dependent style whose context does not start at a root or is not a chain', st.id); continue; }
    const path = [rootIndex, ...occs.map((o) => childIndex.get(o!)!)];
    const target = model.resolve(st.item);
    const material = materialOf(st.style, st.id);
    const ov: Scene['overrides'][number] = { path, sources: [src(st.id)] };
    if (st.style.invisible) ov.visible = false;
    const face = model.isInstanceOf(target, 'FACE') ? partOfPosition.get(target) : undefined;
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
      if (model.isInstanceOf(q, 'FACE')) layer.faces.push({ part, face: id });
      else if (!layer.parts.includes(part)) layer.parts.push(part);
    }
    return layer;
  });

  const convert = (d: StepDiagnostic): Diagnostic => (d.id === undefined ? { severity: d.severity, message: d.message } : { severity: d.severity, message: d.message, source: src(d.id) });
  const header = (type: string, i: number) => { const v = file.headerEntity(type)?.attrs[i]; return v?.k === 'str' ? v.v : undefined; };
  const scene: Scene = {
    unit: 'millimetre', components, roots, parts, materials, layers, overrides,
    properties: Object.fromEntries(Object.entries({
      format: 'step', name: header('FILE_NAME', 0), originatingSystem: header('FILE_NAME', 5), preprocessorVersion: header('FILE_NAME', 4),
      schemas: file.schemaNames.join(', ') || undefined,
    }).filter(([, v]) => v !== undefined)) as Record<string, string>,
    diagnostics: [...file.diagnostics.map(convert), ...model.diagnostics.map(convert), ...sem.diagnostics.map(convert), ...diagnostics],
  };
  return { scene, model, semantics: sem, partOf };
}

