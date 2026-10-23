// Geometric and assembly validation properties, following the CAx-IF Recommended Practices for Geometric and
// Assembly Validation Properties (v4.6): volume, surface area, centroid, curve length, point counts and bounding
// boxes that the writing system computed, for checking what a reader makes of the geometry.

import type { Vec3 } from './math.ts';
import { numbersOf, type Reader } from './reader.ts';
import type { Units } from './units.ts';

export interface ValidationProperty {
  /** The PROPERTY_DEFINITION's instance id. */
  id: number;
  kind: 'geometric' | 'assembly';
  /** Its description, which often names the shape it applies to. */
  description?: string;
  /** What the property describes. */
  target: PropertyTarget;
  values: ValidationValue[];
}

export type PropertyTarget =
  /** A product definition's whole shape: the PRODUCT_DEFINITION's instance id. */
  | { kind: 'product'; product: number }
  /** A SHAPE_ASPECT, and the representation items it stands for (when found). */
  | { kind: 'shape aspect'; aspect: number; items: number[] }
  | { kind: 'other'; id: number };

export interface ValidationValue {
  /** The item's name, which says what it is: 'volume measure', 'surface area measure', 'centre point'... */
  name: string;
  /** The representation's name ('volume', 'centroid'...; often empty when one representation holds several). */
  representation: string;
  /** The representation item's instance id. */
  item: number;
  /** A measure in SI units (m³, m², m...), a point in metres, or a count. */
  measure?: number;
  unit?: string;
  point?: Vec3;
  count?: number;
}

const normal = (s: string | undefined) => (s ?? '').toLowerCase().replace(/_/g, ' ').trim();

export function extractValidationProperties(r: Reader, units: Units): ValidationProperty[] {
  const out: ValidationProperty[] = [];
  for (const p of r.model.instancesOf('PROPERTY_DEFINITION')) {
    const name = normal(r.str(p, 'name'));
    const kind = name === 'geometric validation property' ? 'geometric' : name === 'assembly validation '
      + 'property' ? 'assembly' : undefined;
    if (!kind) continue;
    const prop: ValidationProperty = { id: r.id(p), kind, target: target(r, r.ref(p, 'definition')), values: [] };
    const desc = r.str(p, 'description');
    if (desc && desc.trim()) prop.description = desc;
    for (const pdr of r.referrers(p, 'PROPERTY_DEFINITION_REPRESENTATION', 'definition')) {
      const rep = r.ref(pdr, 'used_representation');
      const repName = r.str(rep, 'name') ?? '';
      const lengthUnit = units.ofRepresentation(rep)?.lengthUnit?.factor;
      for (const item of r.refs(rep, 'items')) {
        const v: ValidationValue = { name: r.str(item, 'name') ?? '', representation: repName, item: r.id(item) };
        if (r.is(item, 'CARTESIAN_POINT')) {
          const c = numbersOf(r.attr(item, 'coordinates'));
          if (!c || c.length !== 3) { r.warn('validation point without three coordinates', item); continue; }
          if (lengthUnit === undefined) r.warn('validation point in a representation without a length unit', item);
          const f = lengthUnit ?? 1;
          v.point = [c[0]! * f, c[1]! * f, c[2]! * f];
        } else if (r.is(item, 'MEASURE_REPRESENTATION_ITEM')) {
          const value = r.num(item, 'value_component');
          const unit = units.unit(r.ref(item, 'unit_component'));
          if (value === undefined || unit?.factor === undefined) {
            r.warn('validation measure without a usable value and unit', item); continue; }
          v.measure = value * unit.factor;
          v.unit = unit.kind;
        } else if (r.is(item, 'INTEGER_REPRESENTATION_ITEM') || r.is(item, 'VALUE_REPRESENTATION_ITEM')) {
          const n = r.num(item, r.is(item, 'INTEGER_REPRESENTATION_ITEM') ? 'the_value' : 'value_component');
          if (n === undefined) { r.warn('validation count without a value', item); continue; }
          v.count = n;
        } else {
          continue; // other items (descriptive, qualified...) carry no value we interpret
        }
        prop.values.push(v);
      }
    }
    out.push(prop);
  }
  return out;
}

function target(r: Reader, d: number): PropertyTarget {
  if (r.is(d, 'PRODUCT_DEFINITION_SHAPE')) {
    const pd = r.ref(d, 'definition');
    if (r.is(pd, 'PRODUCT_DEFINITION')) return { kind: 'product', product: r.id(pd) };
  }
  if (r.is(d, 'SHAPE_ASPECT')) {
    const items = new Set<number>();
    // GEOMETRIC_ITEM_SPECIFIC_USAGE (AP203e2, AP214e3, AP242)...
    for (const g of r.referrers(d, 'GEOMETRIC_ITEM_SPECIFIC_USAGE', 'definition')) {
      const i = r.ref(g, 'identified_item');
      if (i >= 0) items.add(r.id(i));
    }
    // ...or the older PROPERTY_DEFINITION → SHAPE_DEFINITION_REPRESENTATION → representation.
    for (const pd of r.referrers(d, 'PROPERTY_DEFINITION', 'definition')) {
      for (const sdr of r.referrers(pd, 'SHAPE_DEFINITION_REPRESENTATION', 'definition')) {
        for (const i of r.refs(r.ref(sdr, 'used_representation'), 'items')) items.add(r.id(i));
      }
    }
    return { kind: 'shape aspect', aspect: r.id(d), items: [...items] };
  }
  if (d < 0) r.warn('validation property without a definition');
  return { kind: 'other', id: d >= 0 ? r.id(d) : -1 };
}
