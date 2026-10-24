// The product structure: products (part and assembly definitions), their shape representations, and assembly
// occurrences with their placements. Follows the PDM Schema Usage Guide (section 4.4) and the CAx-IF recommended
// practices: NEXT_ASSEMBLY_USAGE_OCCURRENCE (NAUO) for the structure, CONTEXT_DEPENDENT_SHAPE_REPRESENTATION with a
// REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION for each occurrence's placement (rep_1 = the component, rep_2 =
// the assembly), or MAPPED_ITEMs in the assembly's representation; SHAPE_REPRESENTATION_RELATIONSHIPs to the
// representations holding the geometry; APPLIED_DOCUMENT_REFERENCE for components defined in other files.

import { identity, invertAffine, multiply, scaling, type Mat4 } from './math.ts';
import { mappedItem, transformation } from './placement.ts';
import type { Reader } from './reader.ts';
import type { RepresentationContext, Units } from './units.ts';

export interface ProductStructure {
  /** Every PRODUCT_DEFINITION, in file order. */
  products: Product[];
  /** Every assembly occurrence, in file order. */
  occurrences: Occurrence[];
  /** Indices into `products` of the definitions that aren't a component of anything: the top of the tree. */
  roots: number[];
  /** The shape representations reached from products, by representation instance id. */
  representations: Map<number, ShapeRepresentation>;
}

export interface Product {
  /** The PRODUCT_DEFINITION's instance id. */
  id: number;
  /** The PRODUCT's instance id, and its attributes: id is the part number, name the part name. */
  productId: number;
  partNumber: string;
  name: string;
  description?: string;
  /** PRODUCT_DEFINITION_FORMATION.id (the version) and PRODUCT_DEFINITION.id, when not empty. */
  version?: string;
  definitionId?: string;
  /** The PRODUCT_DEFINITION's life-cycle stage, from its context (e.g. 'design'). */
  lifeCycleStage?: string;
  /** Shape representation ids from SHAPE_DEFINITION_REPRESENTATIONs of the product definition's shape. */
  shapes: number[];
  /** Documents assigned to the definition. `external` marks a file that holds its geometry. */
  documents: ProductDocument[];
  /** Indices into `occurrences` where this is the assembly (the parent). */
  children: number[];
}

export interface ProductDocument {
  /** The DOCUMENT_FILE (or DOCUMENT) instance id. */
  id: number;
  /** DOCUMENT.id: for a DOCUMENT_FILE, the file name. */
  name: string;
  /** The file holds the product's geometry (a PROPERTY_DEFINITION 'external definition' on the document). */
  external: boolean;
}

export interface Occurrence {
  /** The NEXT_ASSEMBLY_USAGE_OCCURRENCE's instance id, or the MAPPED_ITEM's for an occurrence made by one. */
  id: number;
  /**
   * 'nauo': the standard product structure. 'mapped-item': a MAPPED_ITEM in one product's representation that maps
   * another product's shape, with no NAUO between them (2.stp); treated as an occurrence, as OCCT's XCAF reader does.
   */
  kind: 'nauo' | 'mapped-item';
  /** Its id and name attributes, and the reference designator, when not empty. */
  occurrenceId?: string;
  name?: string;
  referenceDesignator?: string;
  /** Indices into `products`. */
  parent: number;
  child: number;
  /**
   * The child's placement: from the coordinates of the child's main shape representation to those of the parent's,
   * including any difference in length units. Undefined when the file gives none (the child is placed as is).
   */
  transform?: Mat4;
  /** Where the placement came from: the CONTEXT_DEPENDENT_SHAPE_REPRESENTATION, its relationship, or a MAPPED_ITEM. */
  source: { cdsr?: number; relationship?: number; mappedItem?: number };
}

export interface ShapeRepresentation {
  id: number;
  /** Entity types (one, or the partials of a complex instance). */
  types: readonly string[];
  name: string;
  context?: RepresentationContext;
  /** Item instance ids. */
  items: number[];
  /**
   * Other representations whose contents belong to this one, with the transform from their coordinates to this
   * one's: SHAPE_REPRESENTATION_RELATIONSHIPs (without a transformation, both directions), relationships with a
   * transformation that don't place an assembly occurrence, and MAPPED_ITEMs among the items.
   */
  related: RelatedRepresentation[];
}

export interface RelatedRepresentation {
  representation: number;
  transform: Mat4;
  via: 'relationship' | 'mapped-item';
  /** The relationship or mapped item's instance id. */
  source: number;
}

export function extractProducts(r: Reader, units: Units): ProductStructure {
  const m = r.model;
  // Alibre (trj4_s1-ai-214.stp) swaps rep_1/rep_2 and puts the transformation items in the opposite representations,
  // like CATIA V4, but means the items in the order written: only that reading assembles its parts. CATIA V4's files
  // assemble with OCCT's rule (swap the items back), so the exception is by writer (FILE_NAME.originating_system).
  const fileName = m.file.headerEntity('FILE_NAME');
  const system = fileName?.attrs[5];
  const keepItemOrder = system?.k === 'str' && /alibre/i.test(system.v);
  const index = new Map<number, number>(); // PRODUCT_DEFINITION position -> product index
  const products: Product[] = [];
  const reps = new Map<number, ShapeRepresentation>();
  const placing = new Set<number>(); // relationships and mapped items that place occurrences

  // Length unit of a representation, in metres (undefined when unknown).
  const lengthUnit = (rep: number) => units.ofRepresentation(rep)?.lengthUnit?.factor;
  const unitRatio = (from: number, to: number) => {
    const a = lengthUnit(from), b = lengthUnit(to);
    return a !== undefined && b !== undefined ? a / b : 1;
  };

  for (const p of m.instancesOf('PRODUCT_DEFINITION')) {
    const formation = r.ref(p, 'formation');
    const prod = r.ref(formation, 'of_product');
    const product: Product = {
      id: r.id(p), productId: prod >= 0 ? r.id(prod) : -1,
      partNumber: r.str(prod, 'id') ?? '', name: r.str(prod, 'name') ?? '',
      shapes: [], documents: [], children: [],
    };
    if (prod < 0) r.warn('product definition without a product', p);
    const desc = r.str(prod, 'description');
    if (desc && desc.trim()) product.description = desc;
    const version = r.str(formation, 'id');
    if (version && version.trim()) product.version = version;
    const defId = r.str(p, 'id');
    if (defId && defId.trim()) product.definitionId = defId;
    const stage = r.str(r.ref(p, 'frame_of_reference'), 'life_cycle_stage');
    if (stage) product.lifeCycleStage = stage;
    // PRODUCT_DEFINITION_SHAPE -> SHAPE_DEFINITION_REPRESENTATION -> representation.
    for (const pds of r.referrers(p, 'PRODUCT_DEFINITION_SHAPE', 'definition')) {
      for (const sdr of r.referrers(pds, 'SHAPE_DEFINITION_REPRESENTATION', 'definition')) {
        const rep = r.ref(sdr, 'used_representation');
        if (rep >= 0 && !product.shapes.includes(r.id(rep))) product.shapes.push(r.id(rep));
      }
    }
    product.documents = documents(r, p);
    index.set(p, products.length);
    products.push(product);
  }

  // Assembly occurrences.
  const occurrences: Occurrence[] = [];
  const isChild = new Set<number>();
  for (const p of m.instancesOf('PRODUCT_DEFINITION_USAGE')) {
    const parent = index.get(definitionOf(p, 'relating_product_definition'));
    const child = index.get(definitionOf(p, 'related_product_definition'));
    if (parent === undefined || child === undefined) {
      r.warn('assembly usage whose product definitions are missing', p);
      continue;
    }
    // Only occurrences in the structure; other usages (alternates, specified higher usage) are left out.
    if (!m.isInstanceOf(p, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')) continue;
    const occ: Occurrence = { id: r.id(p), kind: 'nauo', parent, child, source: {} };
    const id = r.str(p, 'id'), name = r.str(p, 'name'), designator = r.str(p, 'reference_designator');
    if (id && id.trim()) occ.occurrenceId = id;
    if (name && name.trim()) occ.name = name;
    if (designator && designator.trim()) occ.referenceDesignator = designator;
    placeOccurrence(p, occ);
    products[parent]!.children.push(occurrences.length);
    occurrences.push(occ);
    isChild.add(child);
  }

  // A usage's product definition; tolerates a PRODUCT_DEFINITION_SHAPE in its place (bug25167.stp), as OCCT does.
  function definitionOf(usage: number, attr: string): number {
    const q = r.ref(usage, attr);
    if (!r.is(q, 'PRODUCT_DEFINITION_SHAPE')) return q;
    r.warn(`${attr} is a product definition shape, not a product definition; using its definition`, usage);
    return r.ref(q, 'definition');
  }

  // Occurrences made by mapped items: a MAPPED_ITEM in a product's representations that maps another product's shape,
  // when nothing placed it already.
  const sets = products.map((pr) => shapeSet(pr));
  const ownerOf = new Map<number, number>(); // representation position -> product index
  sets.forEach((set, i) => { for (const q of set.keys()) if (!ownerOf.has(q)) ownerOf.set(q, i); });
  sets.forEach((set, parent) => {
    for (const [container, toMainT] of set) {
      for (const mi of r.refs(container, 'items')) {
        if (!r.is(mi, 'MAPPED_ITEM') || placing.has(mi)) continue;
        const mapped = r.ref(r.ref(mi, 'mapping_source'), 'mapped_representation');
        const child = ownerOf.get(mapped);
        if (child === undefined || child === parent) continue;
        const t = mappedItem(r, mi, (rep) => unitRatio(rep, container));
        if (!t) continue;
        placing.add(mi);
        const occ: Occurrence = {
          id: r.id(mi), kind: 'mapped-item', parent, child, source: { mappedItem: r.id(mi) },
          transform: multiply(multiply(toMainT, t.matrix), fromMain(sets[child]!, mapped)),
        };
        const name = r.str(mi, 'name');
        if (name && name.trim()) occ.name = name;
        products[parent]!.children.push(occurrences.length);
        occurrences.push(occ);
        isChild.add(child);
      }
    }
  });

  const roots = products.flatMap((_, i) => (isChild.has(i) ? [] : [i]));

  // Representations reached from the products, with their related representations.
  const queue = products.flatMap((pr) => pr.shapes.map((id) => m.resolve(id)));
  while (queue.length) {
    const p = queue.pop()!;
    if (p < 0 || reps.has(r.id(p))) continue;
    const rep = representation(p);
    reps.set(rep.id, rep);
    for (const rel of rep.related) queue.push(m.resolve(rel.representation));
  }

  return { products, occurrences, roots, representations: reps };

  /** An occurrence's placement, from a CDSR whose PRODUCT_DEFINITION_SHAPE describes the NAUO. */
  function placeOccurrence(nauo: number, occ: Occurrence): void {
    const parentShapes = shapeSet(products[occ.parent]!), childShapes = shapeSet(products[occ.child]!);
    for (const pds of r.referrers(nauo, 'PRODUCT_DEFINITION_SHAPE', 'definition')) {
      for (const cdsr of r.referrers(pds, 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', 'represented_product_relation')) {
        const rel = r.ref(cdsr, 'representation_relation');
        if (occ.source.cdsr !== undefined) {
          r.warn('more than one placement for an occurrence; using the first', nauo); return; }
        occ.source.cdsr = r.id(cdsr);
        if (rel < 0) { r.warn('context dependent shape representation without a relationship', cdsr); continue; }
        occ.source.relationship = r.id(rel);
        placing.add(rel);
        const rep1 = r.ref(rel, 'rep_1'), rep2 = r.ref(rel, 'rep_2');
        // Standard: rep_1 is the component's representation, rep_2 the assembly's. Some writers swap them.
        let swapped = false;
        if (!childShapes.has(rep1) && childShapes.has(rep2) && parentShapes.has(rep1)) swapped = true;
        else if (!(childShapes.has(rep1) && parentShapes.has(rep2))) {
          r.warn('placement relationship whose representations are not the component\'s and the assembly\'s', rel);
        }
        if (swapped) r.warn('placement relationship with rep_1 and rep_2 swapped (rep_1 is the assembly)', rel, 'info');
        if (r.is(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) {
          const t = transformation(r, r.ref(rel, 'transformation_operator'), unitRatio(rep1, rep2), [rep1, rep2],
            keepItemOrder);
          const tt = t && (swapped ? invertAffine(t) : t);
          if (!tt) { r.warn('occurrence placement could not be computed', rel); continue; }
          // Relative to the child's and parent's main representations, when rep_1/rep_2 are others in their sets.
          occ.transform = multiply(multiply(toMain(parentShapes, swapped ? rep1 : rep2), tt),
            fromMain(childShapes, swapped ? rep2 : rep1));
        } else {
          // A relationship without a transformation: the explicit approach, with a MAPPED_ITEM of the component's
          // representation in the assembly's.
          const asm = swapped ? rep1 : rep2, comp = swapped ? rep2 : rep1;
          const mi = r.refs(asm, 'items').find(
            (q) => r.is(q, 'MAPPED_ITEM') && r.ref(r.ref(q, 'mapping_source'), 'mapped_representation') === comp);
          if (mi === undefined) {
            r.warn('occurrence placed by a relationship without a transformation or a matching mapped item',
            rel); continue; }
          const t = mappedItem(r, mi, (rep) => unitRatio(rep, asm));
          if (!t) continue;
          occ.source.mappedItem = r.id(mi);
          placing.add(mi);
          occ.transform = multiply(multiply(toMain(parentShapes, asm), t.matrix), fromMain(childShapes, comp));
        }
      }
      if (occ.source.cdsr !== undefined) continue;
      // No CDSR: a SHAPE_DEFINITION_REPRESENTATION of the occurrence whose representation holds a MAPPED_ITEM of the
      // component's shape (tr8_ha1_db.stp); the same mapped item is usually also among the assembly's items.
      for (const sdr of r.referrers(pds, 'SHAPE_DEFINITION_REPRESENTATION', 'definition')) {
        for (const mi of r.refs(r.ref(sdr, 'used_representation'), 'items')) {
          if (!r.is(mi, 'MAPPED_ITEM')) continue;
          const comp = r.ref(r.ref(mi, 'mapping_source'), 'mapped_representation');
          if (!childShapes.has(comp)) continue;
          const asm = m.resolve(products[occ.parent]!.shapes[0] ?? -1);
          const t = mappedItem(r, mi, (rep) => unitRatio(rep, asm));
          if (!t) continue;
          occ.source.mappedItem = r.id(mi);
          placing.add(mi);
          occ.transform = multiply(t.matrix, fromMain(childShapes, comp));
          return;
        }
      }
    }
  }

  // A product's shape representations and those related to them without a transformation, each with the matrix
  // from its coordinates to the main (first) representation's: identity, or a unit conversion.
  function shapeSet(pr: Product): Map<number, Mat4> {
    const out = new Map<number, Mat4>();
    const main = m.resolve(pr.shapes[0] ?? -1);
    if (main < 0) return out;
    out.set(main, identity());
    const todo = [main];
    for (const id of pr.shapes.slice(1)) { const q = m.resolve(id);
      if (q >= 0 && !out.has(q)) { out.set(q, scaling(unitRatio(q, main))); todo.push(q); } }
    while (todo.length) {
      const q = todo.pop()!;
      for (const rel of r.referrers(q, 'SHAPE_REPRESENTATION_RELATIONSHIP')) {
        if (r.is(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) continue;
        for (const other of [r.ref(rel, 'rep_1'), r.ref(rel, 'rep_2')]) {
          if (other >= 0 && !out.has(other)) { out.set(other, scaling(unitRatio(other, main))); todo.push(other); }
        }
      }
    }
    return out;
  }

  // From a representation in a product's shape set to the main one, and back.
  function toMain(set: Map<number, Mat4>, rep: number): Mat4 {
    return set.get(rep) ?? identity();
  }
  function fromMain(set: Map<number, Mat4>, rep: number): Mat4 {
    const t = set.get(rep);
    return (t && invertAffine(t)) ?? identity();
  }

  function representation(p: number): ShapeRepresentation {
    const rep: ShapeRepresentation = {
      id: r.id(p), types: m.types(p), name: r.str(p, 'name') ?? '', items: r.refs(p, 'items').map((q) => r.id(q)),
      related: [],
    };
    const ctx = units.ofRepresentation(p);
    if (ctx) rep.context = ctx;
    for (const rel of r.referrers(p, 'REPRESENTATION_RELATIONSHIP')) {
      if (placing.has(rel)) continue;
      const rep1 = r.ref(rel, 'rep_1'), rep2 = r.ref(rel, 'rep_2');
      if (r.is(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) {
        // Not an occurrence placement: rep_1's contents placed in rep_2.
        if (rep2 !== p || rep1 < 0) continue;
        const t = transformation(r, r.ref(rel, 'transformation_operator'), unitRatio(rep1, rep2), [rep1, rep2],
          keepItemOrder);
        if (t) rep.related.push({ representation: r.id(rep1), transform: t, via: 'relationship', source: r.id(rel) });
      } else if (r.is(rel, 'SHAPE_REPRESENTATION_RELATIONSHIP')) {
        const other = rep1 === p ? rep2 : rep1;
        if (other >= 0 && other !== p) {
          rep.related.push({ representation: r.id(other), transform: scaling(unitRatio(other, p)), via: 'relationship',
            source: r.id(rel) });
        }
      }
    }
    for (const q of r.refs(p, 'items')) {
      if (!r.is(q, 'MAPPED_ITEM') || placing.has(q)) continue;
      const t = mappedItem(r, q, (mapped) => unitRatio(mapped, p));
      if (t) rep.related.push(
        { representation: r.id(t.representation), transform: t.matrix, via: 'mapped-item', source: r.id(q) });
    }
    return rep;
  }
}

/** Documents assigned to a product definition, through APPLIED_DOCUMENT_REFERENCE or documentation_ids. */
function documents(r: Reader, pd: number): ProductDocument[] {
  const found = new Set<number>();
  for (const a of r.referrers(pd, 'APPLIED_DOCUMENT_REFERENCE', 'items')) {
    const d = r.ref(a, 'assigned_document');
    if (d >= 0) found.add(d);
  }
  if (r.is(pd, 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS')) for (
    const d of r.refs(pd, 'documentation_ids')) found.add(d);
  return [...found].sort((a, b) => a - b).map((d) => ({
    id: r.id(d),
    name: r.str(d, 'id') ?? '',
    external: r.referrers(d, 'PROPERTY_DEFINITION', 'definition').some(
      (q) => r.str(q, 'name') === 'external definition'),
  }));
}

export interface ProductInstance {
  /** Index into `products`. */
  product: number;
  /** The occurrences from a root down to this instance (indices into `occurrences`); empty for a root. */
  path: number[];
  /** From the product's main shape representation to the root's, in the root's length unit. */
  transform: Mat4;
}

/**
 * Every instance of every product in the tree, depth first from each root in order: a product used twice in an
 * assembly appears twice, with its own path and placement. A cycle in the structure is cut, with a diagnostic.
 */
export function productInstances(s: ProductStructure, r?: Reader): ProductInstance[] {
  const out: ProductInstance[] = [];
  const visit = (product: number, path: number[], transform: Mat4, onPath: Set<number>) => {
    out.push({ product, path, transform });
    for (const o of s.products[product]!.children) {
      const occ = s.occurrences[o]!;
      if (onPath.has(occ.child)) { r?.warn('cycle in the assembly structure', r.model.resolve(occ.id)); continue; }
      onPath.add(occ.child);
      visit(occ.child, [...path, o], occ.transform ? multiply(transform, occ.transform) : transform, onPath);
      onPath.delete(occ.child);
    }
  };
  for (const root of s.roots) visit(root, [], identity(), new Set([root]));
  return out;
}

/**
 * A product's shape representations and everything related to them, each with the transform from its coordinates
 * to the product's main representation's. A representation appears once, except that each MAPPED_ITEM of it adds
 * another placement.
 */
export function productRepresentations(s: ProductStructure, product: number): { representation: number;
  transform: Mat4 }[] {
  const out: { representation: number; transform: Mat4 }[] = [];
  const shapes = s.products[product]!.shapes;
  const mainId = shapes[0];
  const metres = (id: number) => s.representations.get(id)?.context?.lengthUnit?.factor;
  const reached = new Set<number>(); // reached other than through a mapped item
  const visit = (id: number, transform: Mat4, onPath: Set<number>) => {
    const rep = s.representations.get(id);
    if (!rep) return;
    out.push({ representation: id, transform });
    for (const rel of rep.related) {
      if (onPath.has(rel.representation)) continue;
      if (rel.via === 'relationship') {
        if (reached.has(rel.representation)) continue;
        reached.add(rel.representation);
      }
      onPath.add(rel.representation);
      visit(rel.representation, multiply(transform, rel.transform), onPath);
      onPath.delete(rel.representation);
    }
  };
  for (const id of shapes) reached.add(id);
  for (const id of shapes) {
    const a = metres(id), b = mainId === undefined ? undefined : metres(mainId);
    visit(id, a !== undefined && b !== undefined && id !== mainId ? scaling(a / b) : identity(), new Set([id]));
  }
  return out;
}
