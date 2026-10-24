// Units (ISO 10303-41) and representation contexts: what a representation's numbers mean.

import type { Reader } from './reader.ts';

export type UnitKind =
  | 'length' | 'plane angle' | 'solid angle' | 'area' | 'volume' | 'mass' | 'time' | 'ratio'
  | 'thermodynamic temperature' | 'electric current' | 'amount of substance' | 'luminous intensity' | 'other';

export interface Unit {
  kind: UnitKind;
  /** A readable name: 'millimetre', 'INCH', 'degree'... */
  name: string;
  /**
   * The size of one unit in SI base units (metre, radian, steradian, square and cubic metre, kilogram, second...).
   * Undefined for context dependent units (a count, a page) and unconvertible ones.
   */
  factor?: number;
  /** The unit's instance id. */
  id: number;
}

export interface RepresentationContext {
  id: number;
  /** context_identifier and context_type. */
  identifier?: string;
  type?: string;
  /** coordinate_space_dimension of a geometric context. */
  dimension?: number;
  lengthUnit?: Unit;
  planeAngleUnit?: Unit;
  solidAngleUnit?: Unit;
  /** Other global units (area, volume, mass...). */
  otherUnits: Unit[];
  /** The global length uncertainty, in metres, if given. */
  uncertainty?: number;
}

const PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

// SI unit names: their kind, factor to the SI base unit, and the power the prefix is raised to.
const SI: Record<string, [UnitKind, number, number]> = {
  METRE: ['length', 1, 1], SQUARE_METRE: ['area', 1, 2], CUBIC_METRE: ['volume', 1, 3],
  RADIAN: ['plane angle', 1, 1], STERADIAN: ['solid angle', 1, 1],
  GRAM: ['mass', 1e-3, 1], SECOND: ['time', 1, 1], KELVIN: ['thermodynamic temperature', 1, 1],
  DEGREE_CELSIUS: ['thermodynamic temperature', 1, 1], AMPERE: ['electric current', 1, 1],
  MOLE: ['amount of substance', 1, 1], CANDELA: ['luminous intensity', 1, 1],
};

// Partial entity names that say what kind a named unit is.
const KIND_ENTITY: [string, UnitKind][] = [
  ['LENGTH_UNIT', 'length'], ['PLANE_ANGLE_UNIT', 'plane angle'], ['SOLID_ANGLE_UNIT', 'solid angle'],
  ['AREA_UNIT', 'area'], ['VOLUME_UNIT', 'volume'], ['MASS_UNIT', 'mass'], ['TIME_UNIT', 'time'],
  ['RATIO_UNIT', 'ratio'],
  ['THERMODYNAMIC_TEMPERATURE_UNIT', 'thermodynamic temperature'],
];

export class Units {
  private readonly r: Reader;
  private units = new Map<number, Unit | null>();
  private contexts = new Map<number, RepresentationContext | null>();

  constructor(r: Reader) {
    this.r = r;
  }

  /** The unit at position p (a NAMED_UNIT of any kind, or a DERIVED_UNIT); undefined, with a diagnostic, if not one. */
  unit(p: number): Unit | undefined {
    if (p < 0) return undefined;
    let u = this.units.get(p);
    if (u === undefined) {
      this.units.set(p, null); // guards against cycles through conversion factors
      u = this.resolve(p) ?? null;
      this.units.set(p, u);
    }
    return u ?? undefined;
  }

  private resolve(p: number): Unit | undefined {
    const r = this.r;
    const id = r.id(p);
    const declared = KIND_ENTITY.find(([e]) => r.is(p, e))?.[1];
    if (r.is(p, 'SI_UNIT')) {
      const name = r.enum(p, 'name');
      const prefix = r.enum(p, 'prefix');
      const si = name ? SI[name] : undefined;
      if (!si) { r.warn(`unknown SI unit name .${name}.`, p); return undefined; }
      const pf = prefix ? PREFIX[prefix] : 1;
      if (pf === undefined) { r.warn(`unknown SI prefix .${prefix}.`, p); return undefined; }
      let [kind, factor, power] = si;
      // An AREA_UNIT or VOLUME_UNIT named METRE (trj1_t4m-pe.stp): read as square or cubic metres.
      if (kind === 'length' && (declared === 'area' || declared === 'volume')) {
        power = declared === 'area' ? 2 : 3;
        r.warn(`${declared} unit named .${name}.; read as ${declared === 'area' ? 'square' : 'cubic'} metres`, p);
        kind = declared;
      }
      // millimetre, square millimetre, degree celsius...
      const words = name!.toLowerCase().split('_');
      const pre = prefix ? prefix.toLowerCase() : '';
      const nm = words.length === 2 && (
        words[0] === 'square' || words[0] === 'cubic') ? `${words[0]} ${pre}${words[1]}` : pre + words.join(' ');
      if (declared && declared !== kind) r.warn(`${declared} unit named .${name}.`, p);
      if (kind !== si[0]) return { kind, name: `${kind === 'area' ? 'square' : 'cubic'} ${nm}`,
        factor: factor * pf ** power, id };
      return { kind: declared ?? kind, name: nm, factor: factor * pf ** power, id };
    }
    if (r.is(p, 'CONVERSION_BASED_UNIT')) {
      const name = r.str(p, 'name') ?? '';
      const cf = r.ref(p, 'conversion_factor');
      const value = r.num(cf, 'value_component');
      const base = this.unit(r.ref(cf, 'unit_component'));
      if (value === undefined || !base) {
        r.warn(`conversion based unit '${name}' without a usable conversion factor`, p); return undefined; }
      let factor = base.factor === undefined ? undefined : value * base.factor;
      if (declared && base.kind !== declared) {
        if (base.kind === 'length' && (declared === 'area' || declared === 'volume') && factor !== undefined) {
          // An area or volume unit converted from a length unit (trj2_as1-pe-203.stp: VOLUME_UNIT 'INCH' from mm):
          // read as the square or cube of that length, which is what the values in these files mean.
          factor **= declared === 'area' ? 2 : 3;
          r.warn(`${declared} unit '${name}' converts from a length unit; read as its `
            + `${declared === 'area' ? 'square' : 'cube'}`, p);
        } else {
          r.warn(`${declared} unit '${name}' converts from a ${base.kind} unit`, p);
        }
      }
      return { kind: declared ?? base.kind, name, factor, id };
    }
    if (r.is(p, 'DERIVED_UNIT')) {
      let factor: number | undefined = 1;
      const lengthPowers: number[] = [];
      const parts: string[] = [];
      for (const e of r.refs(p, 'elements')) {
        const u = this.unit(r.ref(e, 'unit'));
        const x = r.num(e, 'exponent');
        if (!u || x === undefined) { r.warn('derived unit with an unusable element', p); return undefined; }
        factor = factor === undefined || u.factor === undefined ? undefined : factor * u.factor ** x;
        if (u.kind === 'length') lengthPowers.push(x);
        parts.push(x === 1 ? u.name : `${u.name}^${x}`);
      }
      const only = parts.length === 1 && lengthPowers.length === 1 ? lengthPowers[0] : undefined;
      const kind: UnitKind = declared ?? (only === 2 ? 'area' : only === 3 ? 'volume' : 'other');
      return { kind, name: parts.join('.'), factor, id };
    }
    if (r.is(p, 'CONTEXT_DEPENDENT_UNIT') || r.is(p, 'NAMED_UNIT')) {
      return { kind: declared ?? 'other', name: r.str(p, 'name') ?? '', id };
    }
    r.warn(`expected a unit, got ${r.model.types(p).join('+') || 'nothing'}`, p);
    return undefined;
  }

  /** A measure value in SI base units: a MEASURE_WITH_UNIT's value times its unit's factor. */
  measure(p: number): number | undefined {
    const v = this.r.num(p, 'value_component');
    const f = this.unit(this.r.ref(p, 'unit_component'))?.factor;
    return v === undefined || f === undefined ? undefined : v * f;
  }

  /** The context of the representation at p, from its context_of_items. */
  ofRepresentation(p: number): RepresentationContext | undefined {
    return this.context(this.r.ref(p, 'context_of_items'));
  }

  /** A representation context: its units and uncertainty. */
  context(p: number): RepresentationContext | undefined {
    if (p < 0) return undefined;
    let c = this.contexts.get(p);
    if (c === undefined) {
      c = this.resolveContext(p) ?? null;
      this.contexts.set(p, c);
    }
    return c ?? undefined;
  }

  private resolveContext(p: number): RepresentationContext {
    const r = this.r;
    const c: RepresentationContext = { id: r.id(p), otherUnits: [] };
    const ident = r.str(p, 'context_identifier'), type = r.str(p, 'context_type');
    if (ident) c.identifier = ident;
    if (type) c.type = type;
    const dim = r.is(p, 'GEOMETRIC_REPRESENTATION_CONTEXT') ? r.num(p, 'coordinate_space_dimension') : undefined;
    if (dim !== undefined) c.dimension = dim;
    if (r.is(p, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')) {
      for (const q of r.refs(p, 'units')) {
        const u = this.unit(q);
        if (!u) continue;
        const slot = u.kind === 'length' ? 'lengthUnit'
          : u.kind === 'plane angle' ? 'planeAngleUnit'
            : u.kind === 'solid angle' ? 'solidAngleUnit' : undefined;
        if (!slot) { c.otherUnits.push(u); continue; }
        if (c[slot]) r.warn(`context has more than one ${u.kind} unit`, p);
        else c[slot] = u;
      }
    }
    if (r.is(p, 'GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT')) {
      for (const q of r.refs(p, 'uncertainty')) {
        const u = this.unit(r.ref(q, 'unit_component'));
        const v = r.num(q, 'value_component');
        if (u?.kind !== 'length' || u.factor === undefined || v === undefined) continue;
        c.uncertainty = c.uncertainty === undefined ? v * u.factor : Math.min(c.uncertainty, v * u.factor);
      }
    }
    if (c.dimension === 3 && !c.lengthUnit) r.warn('3D geometric context without a length unit', p);
    return c;
  }
}

