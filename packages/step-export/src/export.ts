// The scene as a STEP file (docs/brep-model.md, phase 6): what step-import reads, written back, so a file read, written
// and read again keeps it. AP242 by default, AP214 (AUTOMOTIVE_DESIGN) by option.
//   - A product (PRODUCT, its formation, definition and shape) per component placed, and per leaf product (a part
//     reference's `product`, else one made for a part placed at the top or styled per placement); a placement as a
//     NEXT_ASSEMBLY_USAGE_OCCURRENCE with a CONTEXT_DEPENDENT_SHAPE_REPRESENTATION and an ITEM_DEFINED_TRANSFORMATION
//     between two AXIS2_PLACEMENT_3Ds, each in its representation's items (the common practice; step-parser's
//     products.ts reads it); a component's own parts (references without a product) by a shape representation
//     relationship with a transformation.
//   - Each part's B-rep model by geometry.ts as its own shape representation, in its own unit, source ids kept
//     (`StepIds`); a leaf product's shape is its part's representation. Assemblies' representations are in the
//     scene's source unit (else millimetres).
//   - The top: each root and root part a top product, unless one of them is moved or styled per placement (which STEP
//     can't say without a parent), when they all go into one assembly made for them, named after the file.
//   - Styles (the CAx-IF's practices, as step-import reads them): a part's material on its representation's items,
//     its faceMaterials on the faces, a component's material on its representation (AP242; AP214 styles only items,
//     so there it's an override at each instance); a part hidden wherever it's placed as an INVISIBILITY of its
//     styled items; what differs per placement (a reference's own material or visibility, the scene's overrides) as
//     CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEMs whose context is the chain of placement relationships from the top;
//     transparency as SURFACE_STYLE_TRANSPARENT; layers as PRESENTATION_LAYER_ASSIGNMENTs. Styled items go in a
//     MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION per representation context.
// Placements are rigid in STEP: a transform that mirrors or scales is written as its rotation with a warning.
// Deterministic: the same scene gives the same bytes (no time stamp unless given).

import { instances as componentInstances, type Component, type Diagnostic, type InstanceOverride, type Lod,
  type Mat4, type Occurrence, type Part, type PartRef, type Scene } from 'cad-scene';
import { decode, rowCount } from 'cad-brep';
import { type EntityRecord, type Instance, makeHeader, makeList, type StepDocument, type Value,
  writeChunks } from 'step-parser';
import { AP242_SCHEMA, largestId, stepContext, stepGeometry, stepIds } from './geometry.ts';
import { stepMesh } from './tessellated.ts';

/** AP214 edition 3's FILE_SCHEMA. */
export const AP214_SCHEMA = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }';

export type StepSchema = 'ap242' | 'ap214';

export interface StepExportOptions {
  /** Default 'ap242'. */
  schema?: StepSchema;
  /** FILE_NAME's name; default the scene's `name` property, else ''. */
  name?: string;
  /** FILE_NAME's time stamp; default '' (so the same scene gives the same bytes). */
  timeStamp?: string;
  /**
   * Also each B-rep part's mesh (its tessellated level, else its finest) as tessellated geometry beside its B-rep, its
   * faces linked to the B-rep's, for readers that can't mesh B-reps. AP242 only. Default false.
   */
  meshes?: boolean;
}

export interface StepExport {
  /** The file, in chunks, made as they are pulled; one pass. */
  chunks: Iterable<Uint8Array>;
  /** Complete once `chunks` has been read through. */
  diagnostics: Diagnostic[];
}

const SCHEMAS: Record<StepSchema, { schema: string; context: string; protocol: string; year: number }> = {
  ap242: { schema: AP242_SCHEMA, context: 'managed model based 3d engineering',
    protocol: 'ap242_managed_model_based_3d_engineering', year: 2014 },
  ap214: { schema: AP214_SCHEMA, context: 'core data for automotive mechanical design processes',
    protocol: 'automotive_design', year: 2010 },
};

const str = (v = ''): Value => ({ k: 'str', v });
const real = (v: number): Value => ({ k: 'real', v });
const ref = (v: number): Value => ({ k: 'ref', v });
const enu = (v: string): Value => ({ k: 'enum', v });
const list = (vs: Value[]): Value => makeList(vs);
const refs = (xs: readonly number[]): Value => list(xs.map(ref));
const UNSET: Value = { k: 'unset' };
const text = (x: unknown) => (typeof x === 'string' ? x : undefined);
const strings = (x: unknown) => (Array.isArray(x) && x.every((y) => typeof y === 'string') ? x as string[]
  : undefined);
const stepSource = (sources: readonly { format: string; id: number }[] | undefined, k = 0) =>
  sources?.filter((x) => x.format === 'step')[k]?.id;

/**
 * A part's level written as tessellated geometry, one with something to draw: its first (finest), or with
 * `tessellatedFirst` one made by a tessellator before any other.
 */
function meshLevel(part: Part, tessellatedFirst = false): Lod | undefined {
  const draws = (l: Lod) => l.mesh.indices.length > 0 || (l.mesh.curves?.length ?? 0) > 0
    || (l.mesh.points?.length ?? 0) > 0;
  return (tessellatedFirst ? part.lods.find((l) => l.from === 'tessellated' && draws(l)) : undefined)
    ?? part.lods.find(draws);
}

/** A style to write per placement: an instance override, the scene's or made from a part reference. */
type Override = Omit<InstanceOverride, 'sources'> & { sources?: InstanceOverride['sources'] };

/** The scene as a STEP file. */
export function exportStep(scene: Scene, opts: StepExportOptions = {}): StepExport {
  const diagnostics: Diagnostic[] = [];
  const schemaName = opts.schema ?? 'ap242';
  const schema = SCHEMAS[schemaName];
  const p = scene.properties;
  const header = makeHeader({
    description: strings(p.description) ?? [''], implementationLevel: '2;1',
    name: opts.name ?? text(p.name) ?? '', timeStamp: opts.timeStamp ?? '',
    author: strings(p.authors) ?? (text(p.author) ? [text(p.author)!] : ['']),
    organization: strings(p.organizations) ?? [''], preprocessorVersion: 'cad-io-js step-export',
    originatingSystem: text(p.originatingSystem) ?? 'cad-io-js', authorization: text(p.authorization) ?? '',
    schemas: [schema.schema],
  });
  const doc: StepDocument = { header, data: [{ instances: instances() }] };
  return { chunks: writeChunks(doc), diagnostics };

  function* instances(): Generator<Instance> {
    const warn = (message: string, id?: number, severity: Diagnostic['severity'] = 'warning') => diagnostics.push(
      id === undefined ? { severity, message } : { severity, message, source: { format: 'step', id } });
    const out: Instance[] = [];
    const flush = function* () { yield* out; out.length = 0; };

    // What's placed: components reachable from the roots, parts from them and the root parts.
    const placedComponents = new Set<number>(), placedParts = new Set<number>();
    const visit = (c: number) => {
      if (placedComponents.has(c)) return;
      placedComponents.add(c);
      const comp = scene.components[c]!;
      for (const r of comp.parts) placedParts.add(r.part);
      for (const o of comp.children) visit(o.component);
    };
    const roots = scene.roots.filter((o) => {
      if (scene.components[o.component]) return true;
      warn(`a root placing component ${o.component}, which the scene doesn't have; left out`);
      return false;
    });
    for (const o of roots) visit(o.component);
    for (const r of scene.rootParts ?? []) placedParts.add(r.part);
    // Parts written: those with a B-rep, and in AP242 those with a mesh to draw (tessellated geometry).
    const written = (i: number) => {
      const part = scene.parts[i];
      return part !== undefined && (part.brep !== undefined || (schemaName === 'ap242'
        && meshLevel(part) !== undefined));
    };
    for (const i of [...placedParts].sort((a, b) => a - b)) if (!written(i)) warn(`part ${i} `
      + `(${scene.parts[i]!.name}) has no B-rep${schemaName === 'ap214' && meshLevel(scene.parts[i]!)
        ? ', and AP214 has no tessellated geometry for its mesh' : ' or mesh'}; not written`);
    if (opts.meshes && schemaName === 'ap214') warn('B-rep parts\' meshes not written: AP214 has no tessellated '
      + 'geometry');
    const rootParts = (scene.rootParts ?? []).filter((r) => written(r.part));

    // -- What's styled per placement. A part's own style is what all its placements show (a reference's material,
    // else the part's), if they agree; a placement that differs gets an override, as does a hidden one unless all
    // are hidden. Overrides of single part references need the reference to be a placed product (a NAUO).
    const refsOf = new Map<number, PartRef[]>();
    const allRefs = [...[...placedComponents].flatMap((c) => scene.components[c]!.parts), ...rootParts];
    for (const r of allRefs) if (written(r.part)) refsOf.set(r.part, [...refsOf.get(r.part) ?? [], r]);
    const partMaterial = new Map<number, number | undefined>(), partHidden = new Set<number>();
    for (const [i, rs] of refsOf) {
      const own = rs.map((r) => r.material ?? scene.parts[i]!.material);
      partMaterial.set(i, own.every((m) => m === own[0]) ? own[0] : scene.parts[i]!.material);
      if (rs.every((r) => r.visible === false)) partHidden.add(i);
    }
    const overrides: Override[] = scene.overrides.map((o) => ({ ...o }));
    const leafRefs = new Set<PartRef>(), refOverride = (r: PartRef) => {
      const part = scene.parts[r.part]!;
      const m = r.material ?? part.material;
      const o: Omit<Override, 'path'> = {};
      if (m !== partMaterial.get(r.part) && m !== undefined) {
        o.material = m;
        // (A reference's material leaves its part's per-face materials, an override's doesn't: they go with it.)
        if (part.faceMaterials?.length) o.faceMaterials = part.faceMaterials.map((f) => ({ part: r.part, ...f }));
      }
      if (r.visible === false && !partHidden.has(r.part)) o.visible = false;
      return Object.keys(o).length ? o : undefined;
    };
    const componentPaths = new Map<number, number[][]>();
    for (const inst of componentInstances(scene)) {
      componentPaths.set(inst.component, [...componentPaths.get(inst.component) ?? [], inst.path]);
    }
    for (const c of [...placedComponents].sort((a, b) => a - b)) {
      const comp = scene.components[c]!;
      // A reference with a name of its own, one of several of a part in the component, or one moved, is a placed
      // product too: a shape representation relationship has no name or transformation (readers follow none outside
      // an occurrence), and a reader takes one representation once.
      for (const r of comp.parts) {
        const unit = scene.parts[r.part]?.unit ?? 1;
        if (r.name !== undefined || comp.parts.filter((x) => x.part === r.part).length > 1
          || !isIdentity(unscaled(r.transform, unit))) leafRefs.add(r);
      }
      comp.parts.forEach((r, k) => {
        const o = written(r.part) ? refOverride(r) : undefined;
        if (!o) return;
        leafRefs.add(r);
        for (const path of componentPaths.get(c) ?? []) overrides.push({ path, ref: k, ...o });
      });
      // AP214 styles items only: a component's material as an override of each of its instances.
      if (schemaName === 'ap214' && comp.material !== undefined) {
        for (const path of componentPaths.get(c) ?? []) overrides.push({ path, material: comp.material });
      }
    }
    // The scene's overrides of single references: those references placed products too.
    for (const o of scene.overrides) {
      if (o.ref === undefined || !o.path.length) continue;
      let comp: number | undefined = scene.roots[o.path[0]!]?.component;
      for (const k of o.path.slice(1)) comp = comp === undefined ? undefined : scene.components[comp]?.children[k]
        ?.component;
      const r = comp === undefined ? undefined : scene.components[comp]?.parts[o.ref];
      if (r) leafRefs.add(r);
    }
    (scene.rootParts ?? []).forEach((r, k) => {
      const o = written(r.part) ? refOverride(r) : undefined;
      if (o) overrides.push({ path: [], ref: k, ...o });
    });
    // Overrides need a chain of placements from the top: of the top itself (a root, a root part) only inside an
    // assembly made for them.
    const topStyled = overrides.some((o) => o.path.length === 0 || (o.path.length === 1 && o.ref === undefined));
    const moved = roots.some((o) => !isIdentity(o.transform))
      || rootParts.some((r) => !isIdentity(unscaled(r.transform, scene.parts[r.part]!.unit)));
    const wrapped = moved || topStyled;

    // Ids: every source id the file will keep, then new ones after the largest.
    let largest = 0;
    const see = (sources: readonly { format: string; id: number }[] | undefined) => {
      for (const s of sources ?? []) if (s.format === 'step' && s.id > largest) largest = s.id;
    };
    for (const c of scene.components) {
      see(c.sources);
      for (const o of c.children) see(o.sources);
      for (const r of c.parts) { see(r.sources); see(r.product?.sources); }
    }
    for (const r of scene.rootParts ?? []) { see(r.sources); see(r.product?.sources); }
    for (const i of placedParts) {
      const part = scene.parts[i]!;
      see(part.sources);
      if (part.brep) largest = Math.max(largest, largestId(part.brep.model));
      for (const l of part.lods) {
        for (const f of l.mesh.faces) if (f.source !== null && f.source > largest) largest = f.source;
        for (const c of l.mesh.curves ?? []) if (c.source !== null && c.source > largest) largest = c.source;
        for (const q of l.mesh.pointSources ?? []) if (q !== null && q > largest) largest = q;
      }
    }
    const ids = stepIds(largest);
    const fresh = () => ids.fresh();
    const emit = (id: number, type: string, attrs: Value[]) => { out.push({ id, type, attrs }); return id; };
    const emitComplex = (id: number, parts: EntityRecord[]) => { out.push({ id, parts }); return id; };
    const point = (xyz: readonly number[]) => emit(fresh(), 'CARTESIAN_POINT', [str(), list(xyz.map(real))]);
    const direction = (xyz: readonly number[]) => emit(fresh(), 'DIRECTION', [str(), list(xyz.map(real))]);
    const axes = (origin: readonly number[], z: readonly number[], x: readonly number[], name = '') =>
      emit(fresh(), 'AXIS2_PLACEMENT_3D', [str(name), ref(point(origin)), ref(direction(z)), ref(direction(x))]);

    // -- Contexts.
    const app = emit(fresh(), 'APPLICATION_CONTEXT', [str(schema.context)]);
    emit(fresh(), 'APPLICATION_PROTOCOL_DEFINITION', [str('international standard'), str(schema.protocol),
      { k: 'int', v: schema.year }, ref(app)]);
    const productContext = emit(fresh(), 'PRODUCT_CONTEXT', [str(), ref(app), str('mechanical')]);
    const definitionContexts = new Map<string, number>();
    const definitionContext = (stage: string) => {
      let c = definitionContexts.get(stage);
      if (c === undefined) {
        c = emit(fresh(), 'PRODUCT_DEFINITION_CONTEXT', [str('part definition'), ref(app), str(stage)]);
        definitionContexts.set(stage, c);
      }
      return c;
    };
    yield* flush();

    // -- Parts' representations, each with an origin placement for its placements to refer to.
    // `styled`: what a part's own style goes on, its items but geometric sets' elements in their place; `faceRows`
    // its faces alone, which take it too where its items aren't all solids (`solid`).
    type PartRep = { rep: number; origin: number; unit: number; items: number[]; faces: Map<number, number>;
      context: number; styled: number[]; faceRows: number[]; solid: boolean };
    const partRep = new Map<number, PartRep>();
    for (const i of [...placedParts].sort((a, b) => a - b)) {
      const part = scene.parts[i]!;
      if (!written(i)) continue;
      if (!part.brep) {
        const m = stepMesh(part, meshLevel(part)!, { ids, id: stepSource(part.sources) });
        out.push(...m.instances);
        partRep.set(i, { rep: m.rootId, origin: m.items.at(-1)!, unit: part.unit, items: m.items.slice(0, -1),
          faces: m.faceIds, context: m.contextId, styled: m.items.slice(0, -1), faceRows: [...m.faceIds.values()],
          solid: part.closed === true });
        yield* flush();
        continue;
      }
      const g = stepGeometry(part.brep.model, { ids, name: part.name, id: stepSource(part.sources), origin: true,
        derivedDimensions: schemaName === 'ap214' });
      yield* g.instances;
      for (const d of g.diagnostics) warn(`part ${i} (${part.name}): ${d.message}`, stepSource(part.sources),
        d.severity);
      const faces = new Map([...g.surfaceIds, ...g.faceIds]);
      const items = g.items.slice(0, -1);
      const model = part.brep.model;
      const solid = [...Array(rowCount(model, 'item')).keys()].every((k) => {
        const it = decode.item(model, k);
        return it.kind === 'body' && decode.body(model, it.ref).kind === 'solid';
      });
      partRep.set(i, { rep: g.rootId, origin: g.items.at(-1)!, unit: part.unit, items, faces, context: g.contextId,
        styled: items.flatMap((x) => g.setMembers.get(x) ?? [x]), faceRows: [...new Set(g.faceIds.values())], solid });
      // Its mesh beside it, related to it (so a product with either shape has both), its faces linked to the B-rep's.
      const lod = opts.meshes && schemaName === 'ap242' ? meshLevel(part, true) : undefined;
      if (lod) {
        const m = stepMesh(part, lod, { ids, links: faces });
        out.push(...m.instances);
        emit(fresh(), 'SHAPE_REPRESENTATION_RELATIONSHIP', [str(), str(), ref(m.rootId), ref(g.rootId)]);
        yield* flush();
      } else if (opts.meshes && schemaName === 'ap242') warn(`part ${i} (${part.name}) has no mesh to write beside `
        + 'its B-rep (not meshed)', stepSource(part.sources), 'info');
    }

    // -- Products.
    const assemblyUnit = scene.sourceUnit ?? 1;
    const products: number[] = [];
    type Definition = { pd: number; rep: number; origin: number; unit: number };
    const product = (name: string, props: Record<string, unknown>, sources: Component['sources'] | undefined) => {
      const prod = emit(ids.claim(stepSource(sources, 1)), 'PRODUCT', [str(text(props.partNumber) ?? name), str(name),
        str(text(props.description) ?? ''), refs([productContext])]);
      products.push(prod);
      const pdf = emit(fresh(), 'PRODUCT_DEFINITION_FORMATION', [str(text(props.version) ?? ''), str(), ref(prod)]);
      return emit(ids.claim(stepSource(sources)), 'PRODUCT_DEFINITION', [str(text(props.definitionId) ?? 'design'),
        str(), ref(pdf), ref(definitionContext(text(props.lifeCycleStage) ?? 'design'))]);
    };
    // A product defined in another file (the CAx-IF's external references): a DOCUMENT_FILE naming it, referred to
    // by the definition, with the property saying it's the product's definition.
    let documentType: number | undefined;
    const external = (pd: number, uri: string) => {
      documentType ??= emit(fresh(), 'DOCUMENT_TYPE', [str('')]);
      const d = emit(fresh(), 'DOCUMENT_FILE', [str(uri), str(uri), str('external reference document'),
        ref(documentType), str(), UNSET]);
      emit(fresh(), 'DOCUMENT_REPRESENTATION_TYPE', [str('digital'), ref(d)]);
      emit(fresh(), 'APPLIED_DOCUMENT_REFERENCE', [ref(d), str('external reference'), refs([pd])]);
      emit(fresh(), 'PROPERTY_DEFINITION', [str('external definition'), str(), ref(d)]);
    };
    const shape = (pd: number, rep: number) => emit(fresh(), 'SHAPE_DEFINITION_REPRESENTATION', [
      ref(emit(fresh(), 'PRODUCT_DEFINITION_SHAPE', [str(), str(), ref(pd)])), ref(rep)]);

    // A placement: the child's origin onto a placement in the parent's representation (made by `placement`, which
    // must be among its items), as its relationship's transformation.
    const placement = (t: Mat4, parentUnit: number, what: string, id?: number) => {
      const r = rigid(t);
      if (!r.ok) warn(`${what}: a transform that ${r.why}; written as its rotation`, id);
      return axes([t[12]! / parentUnit, t[13]! / parentUnit, t[14]! / parentUnit], r.z, r.x);
    };
    const relationship = (child: { rep: number; origin: number }, parentRep: number, placed: number) => {
      const idt = emit(fresh(), 'ITEM_DEFINED_TRANSFORMATION', [str(), str(), ref(child.origin), ref(placed)]);
      return emitComplex(fresh(), [
        { type: 'REPRESENTATION_RELATIONSHIP', attrs: [str(), str(), ref(child.rep), ref(parentRep)] },
        { type: 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION', attrs: [ref(idt)] },
        { type: 'SHAPE_REPRESENTATION_RELATIONSHIP', attrs: [] }]);
    };
    // Each placement's relationship, by what it places: what overrides' contexts are chains of.
    const relationOf = new Map<Occurrence | PartRef, number>();
    const occurrence = (parent: Definition, child: Definition, placed: number, what: Occurrence | PartRef) => {
      const props = what.properties;
      const nauo = emit(ids.claim(stepSource(what.sources)), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', [
        str(text(props?.occurrenceId) ?? what.name ?? ''), str(what.name ?? ''), str(), ref(parent.pd),
        ref(child.pd), text(props?.referenceDesignator) !== undefined ? str(text(props?.referenceDesignator))
          : UNSET]);
      const pds = emit(fresh(), 'PRODUCT_DEFINITION_SHAPE', [str(), str(), ref(nauo)]);
      const rel = relationship(child, parent.rep, placed);
      emit(fresh(), 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', [ref(rel), ref(pds)]);
      relationOf.set(what, rel);
    };

    // Leaf products: one per distinct product a part reference names (by its definition's id, else its name and
    // part), its shape the part's representation.
    const leaves = new Map<string, Definition>();
    const leafOf = (r: PartRef): Definition | undefined => {
      const rep = partRep.get(r.part);
      if (!rep) return undefined;
      const part = scene.parts[r.part]!;
      // (Made for a part placed at the top, it takes the placement's name: a top product has no NAUO to hold it.)
      const top = (scene.rootParts ?? []).includes(r) && !wrapped;
      const pr = r.product ?? { name: (top ? r.name : undefined) ?? part.name, sources: [], properties: {} };
      const key = stepSource(pr.sources) !== undefined ? `#${stepSource(pr.sources)}` : `${r.part}:${pr.name}`;
      let d = leaves.get(key);
      if (!d) {
        const pd = product(pr.name, pr.properties, pr.sources);
        shape(pd, rep.rep);
        d = { pd, ...rep };
        leaves.set(key, d);
      }
      return d;
    };

    // Components' products first, in the scene's order (a reader numbers products in the file's order); then their
    // representations and placements, children first (a placement refers to its child's definition).
    const pdOf = new Map<number, number>();
    for (const c of [...placedComponents].sort((x, y) => x - y)) {
      const comp = scene.components[c]!;
      const pd = product(comp.name, comp.properties, comp.sources);
      pdOf.set(c, pd);
      if (comp.external) external(pd, comp.external.uri);
    }
    yield* flush();
    let assemblyCtx: number | undefined;
    const assemblyContext = () => {
      if (assemblyCtx === undefined) {
        assemblyCtx = fresh();
        out.push(...stepContext(ids, assemblyCtx, assemblyUnit, undefined, schemaName === 'ap214'));
      }
      return assemblyCtx;
    };
    const defined = new Map<number, Definition>();
    const define = (c: number): Definition => {
      let d = defined.get(c);
      if (d) return d;
      const comp = scene.components[c]!;
      const kids = comp.children.map((o) => define(o.component));
      const pd = pdOf.get(c)!;
      const origin = axes([0, 0, 0], [0, 0, 1], [1, 0, 0], 'origin');
      const placed: { at: number; place: () => void }[] = [];
      comp.children.forEach((o, k) => {
        const at = placement(o.transform, assemblyUnit, `${comp.name}'s child ${k}`, stepSource(o.sources));
        placed.push({ at, place: () => occurrence(d!, kids[k]!, at, o) });
      });
      // Its own parts unmoved by a plain shape representation relationship (readers follow no transformation outside
      // an occurrence: OCCT reads nothing of such a part), the others as placed products (leafRefs).
      const own: number[] = [];
      comp.parts.forEach((r, k) => {
        const rep = partRep.get(r.part);
        if (!rep) return;
        if (!r.product && !leafRefs.has(r)) { own.push(rep.rep); return; }
        const at = placement(unscaled(r.transform, rep.unit), assemblyUnit, `${comp.name}'s part ${k}`,
          stepSource(r.sources));
        const leaf = leafOf(r)!;
        placed.push({ at, place: () => occurrence(d!, leaf, at, r) });
      });
      const rep = emit(fresh(), 'SHAPE_REPRESENTATION', [str(comp.name), refs([origin, ...placed.map((x) => x.at)]),
        ref(assemblyContext())]);
      for (const x of own) emit(fresh(), 'SHAPE_REPRESENTATION_RELATIONSHIP', [str(), str(), ref(x), ref(rep)]);
      shape(pd, rep);
      d = { pd, rep, origin, unit: assemblyUnit };
      defined.set(c, d);
      for (const x of placed) x.place();
      return d;
    };

    // -- The top.
    if (!wrapped) {
      for (const o of roots) { define(o.component); yield* flush(); }
      for (const r of rootParts) { leafOf(r); yield* flush(); }
    } else {
      warn(`the top of the tree is ${moved ? 'moved' : 'styled per placement'}, which STEP can't say without a `
        + 'parent: written inside one assembly', undefined, 'info');
      const name = opts.name ?? text(p.name) ?? 'model';
      const kids = roots.map((o) => define(o.component));
      const leafs = rootParts.map((r) => leafOf(r)!);
      const pd = product(name, {}, undefined);
      const origin = axes([0, 0, 0], [0, 0, 1], [1, 0, 0], 'origin');
      const ats = [...roots.map((o, k) => placement(o.transform, assemblyUnit, `root ${k}`)),
        ...rootParts.map((r, k) => placement(unscaled(r.transform, scene.parts[r.part]!.unit), assemblyUnit,
          `root part ${k}`))];
      const rep = emit(fresh(), 'SHAPE_REPRESENTATION', [str(name), refs([origin, ...ats]), ref(assemblyContext())]);
      shape(pd, rep);
      const top: Definition = { pd, rep, origin, unit: assemblyUnit };
      roots.forEach((o, k) => occurrence(top, kids[k]!, ats[k]!, o));
      rootParts.forEach((r, k) => occurrence(top, leafs[k]!, ats[roots.length + k]!, r));
      yield* flush();
    }
    if (products.length) emit(fresh(), 'PRODUCT_RELATED_PRODUCT_CATEGORY', [str('part'), UNSET, refs(products)]);
    yield* flush();

    // -- Styles.
    const styledIn = new Map<number, number[]>(); // representation context -> its styled items
    const styled = (context: number, id: number) => { styledIn.set(context, [...styledIn.get(context) ?? [], id]);
      return id; };
    const psaOf = new Map<number, number>();
    let nullPsa: number | undefined;
    const psa = (m: number | undefined): number => {
      if (m === undefined) return nullPsa ??= emit(fresh(), 'PRESENTATION_STYLE_ASSIGNMENT', [list([{ k: 'typed',
        type: 'NULL_STYLE', v: enu('NULL') }])]);
      let s = psaOf.get(m);
      if (s !== undefined) return s;
      const mat = scene.materials[m]!;
      const colour = emit(fresh(), 'COLOUR_RGB', [str(mat.name ?? ''), ...mat.color.map(real)]);
      const fill = emit(fresh(), 'FILL_AREA_STYLE', [str(), refs([emit(fresh(), 'FILL_AREA_STYLE_COLOUR', [str(),
        ref(colour)])])]);
      // Transparency always, 0 for opaque: a reader takes what a style leaves out from what contains its item, so an
      // opaque face of a transparent part would be transparent.
      const sides = [emit(fresh(), 'SURFACE_STYLE_FILL_AREA', [ref(fill)]),
        emit(fresh(), 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES', [enu('NORMAL_SHADING'), ref(colour),
          refs([emit(fresh(), 'SURFACE_STYLE_TRANSPARENT', [real(1 - mat.opacity)])])])];
      const usage = emit(fresh(), 'SURFACE_STYLE_USAGE', [enu('BOTH'),
        ref(emit(fresh(), 'SURFACE_SIDE_STYLE', [str(), refs(sides)]))]);
      const font = emit(fresh(), 'DRAUGHTING_PRE_DEFINED_CURVE_FONT', [str('continuous')]);
      const curve = emit(fresh(), 'CURVE_STYLE', [str(), ref(font), { k: 'typed', type: 'POSITIVE_LENGTH_MEASURE',
        v: real(0.1) }, ref(colour)]);
      s = emit(fresh(), 'PRESENTATION_STYLE_ASSIGNMENT', [refs([usage, curve])]);
      psaOf.set(m, s);
      return s;
    };
    const styledItem = (m: number | undefined, item: number) =>
      emit(fresh(), 'STYLED_ITEM', [str('color'), refs([psa(m)]), ref(item)]);
    // Each item's own styled item, which overrides override (a null style where it has none).
    const baseStyle = new Map<number, number>();
    const invisible: number[] = [];
    for (const [i, rep] of partRep) {
      const part = scene.parts[i]!;
      const m = partMaterial.get(i) ?? part.material;
      // (A set's element with a colour of its own styled once, with that: readers differ on which of two wins.)
      const own = new Set((part.faceMaterials ?? []).map((f) => rep.faces.get(f.face)));
      for (const item of rep.styled) {
        if ((m === undefined && !partHidden.has(i)) || (own.has(item) && !partHidden.has(i))) continue;
        const s = styled(rep.context, styledItem(m, item));
        baseStyle.set(item, s);
        if (partHidden.has(i)) invisible.push(s);
      }
      for (const f of part.faceMaterials ?? []) {
        const face = rep.faces.get(f.face);
        if (face === undefined) { warn(`part ${i}: a face material for face #${f.face}, which it doesn't have`);
          continue; }
        baseStyle.set(face, styled(rep.context, styledItem(f.material, face)));
      }
      // A surface model's or a shell's style isn't its faces' to every reader (OCCT passes a solid's down, not
      // theirs): there the part's colour also on each face without its own.
      if (!rep.solid && m !== undefined) {
        for (const face of rep.faceRows) {
          if (baseStyle.has(face)) continue;
          baseStyle.set(face, styled(rep.context, styledItem(m, face)));
        }
      }
      yield* flush();
    }
    if (schemaName === 'ap242') {
      for (const [c, d] of defined) {
        const m = scene.components[c]!.material;
        if (m !== undefined) styled(assemblyContext(), styledItem(m, d.rep));
      }
    }
    // Overrides: their context the placements' relationships from the top down to the instance (and the reference).
    for (const o of overrides) {
      const chain: number[] = [];
      let comp: number | undefined, ok = true;
      o.path.forEach((k, depth) => {
        const occ = depth === 0 ? roots[k] : scene.components[comp!]?.children[k];
        if (!occ) { ok = false; return; }
        if (depth > 0 || wrapped) {
          const rel = relationOf.get(occ);
          if (rel === undefined) ok = false;
          else chain.push(rel);
        }
        comp = occ.component;
      });
      let item: number | undefined, partIndex: number | undefined;
      if (ok && o.ref !== undefined) {
        const r = o.path.length ? scene.components[comp!]?.parts[o.ref] : (scene.rootParts ?? [])[o.ref];
        const rel = r && relationOf.get(r);
        if (!r || rel === undefined) ok = false;
        else {
          chain.push(rel);
          partIndex = r.part;
          const rep = partRep.get(r.part)!;
          item = rep.items[0] ?? rep.origin;
        }
      } else if (ok && comp !== undefined) item = defined.get(comp)?.origin;
      if (!ok || !chain.length || item === undefined) {
        warn(`an override at ${o.path.join('/') || 'the top'}${o.ref !== undefined ? ` (part reference ${o.ref})`
          : ''} that STEP can't place; left out`, stepSource(o.sources));
        continue;
      }
      const context = assemblyContext();
      const cdorsi = (m: number | undefined, target: number) => {
        let base = baseStyle.get(target);
        if (base === undefined) {
          base = styled(partIndex !== undefined && target !== item ? partRep.get(partIndex)!.context : context,
            styledItem(undefined, target));
          baseStyle.set(target, base);
        }
        return styled(context, emit(ids.claim(stepSource(o.sources)), 'CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM',
          [str('color'), refs([psa(m)]), ref(target), ref(base), refs(chain)]));
      };
      if (o.material !== undefined || o.visible === false || !o.faceMaterials?.length) {
        const s = cdorsi(o.material, item);
        if (o.visible === false) invisible.push(s);
      }
      for (const f of o.faceMaterials ?? []) {
        const face = partRep.get(f.part)?.faces.get(f.face);
        if (face === undefined) { warn(`an override's face #${f.face} of part ${f.part}, which isn't written`);
          continue; }
        partIndex = f.part;
        cdorsi(f.material, face);
      }
      yield* flush();
    }
    // Layers: their parts' items, and faces.
    for (const l of scene.layers) {
      const items = [...l.parts.flatMap((i) => partRep.get(i)?.items ?? []),
        ...l.faces.flatMap((f) => { const x = partRep.get(f.part)?.faces.get(f.face); return x === undefined ? [] : [x];
        })];
      if (!items.length) continue;
      const layer = emit(ids.claim(stepSource(l.sources)), 'PRESENTATION_LAYER_ASSIGNMENT', [str(l.name),
        str(l.description ?? ''), refs(items)]);
      if (!l.visible) invisible.push(layer);
    }
    if (invisible.length) emit(fresh(), 'INVISIBILITY', [refs(invisible)]);
    for (const [context, items] of styledIn) {
      emit(fresh(), 'MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION', [str(), refs(items), ref(context)]);
    }
    yield* flush();
  }
}

/** A part reference's transform without its part's unit (from the part's millimetres, not its units). */
function unscaled(t: Mat4, unit: number): Mat4 {
  if (unit === 1) return t;
  const m = new Float64Array(t);
  for (let k = 0; k < 12; k++) if (k % 4 !== 3) m[k] = t[k]! / unit;
  return m;
}

const TOLERANCE = 1e-9;

/** Whether a transform is the identity (to rounding). */
function isIdentity(t: Mat4): boolean {
  for (let k = 0; k < 16; k++) {
    const want = k % 5 === 0 ? 1 : 0;
    if (Math.abs(t[k]! - want) > (k >= 12 ? TOLERANCE * Math.max(1, Math.abs(t[k]!)) : TOLERANCE)) return false;
  }
  return true;
}

/**
 * A transform's axes as a placement's: z and x its third and first columns, normalized, x made orthogonal to z;
 * `ok` false (with why) where the transform isn't a rotation: a mirror, a scale, a shear.
 */
function rigid(t: Mat4): { ok: true; x: number[]; z: number[] } | { ok: false; why: string; x: number[];
  z: number[] } {
  const col = (j: number) => [t[4 * j]!, t[4 * j + 1]!, t[4 * j + 2]!];
  const [a, b, c] = [col(0), col(1), col(2)];
  const len = (v: number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
  const dot = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const det = a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!)
    + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  const z = c.map((x) => x / (len(c) || 1));
  const xp = a.map((x, i) => x - dot(a, z) * z[i]!);
  const x = xp.map((v) => v / (len(xp) || 1));
  const why = det < 0 ? 'mirrors' : [a, b, c].some((v) => Math.abs(len(v) - 1) > 1e-6) ? 'scales'
    : Math.abs(dot(a, b)) + Math.abs(dot(b, c)) + Math.abs(dot(a, c)) > 1e-6 ? 'shears' : undefined;
  return why ? { ok: false, why, x, z } : { ok: true, x, z };
}
