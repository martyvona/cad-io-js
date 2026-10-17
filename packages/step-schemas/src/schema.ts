// Runtime view over a SchemaDictionary: inheritance queries and the Part 21 attribute layout of entity instances.

import type { EntityDef, SchemaDictionary, TypeDef, TypeRef } from './types.ts';

/** One attribute slot in a Part 21 instance. */
export interface AttributeSlot {
  name: string;
  /** The entity that declares the attribute. */
  owner: string;
  /** The attribute's type, narrowed by any redeclarations that apply to the instance's entity. */
  type: TypeRef;
  optional: boolean;
  /** Redeclared as DERIVE in a subtype: the slot holds `*` in Part 21. */
  derived: boolean;
}

export class Schema {
  readonly dict: SchemaDictionary;
  private flatCache = new Map<string, readonly AttributeSlot[]>();
  private partialCache = new Map<string, readonly AttributeSlot[]>();
  private ancestorCache = new Map<string, readonly string[]>();
  private subtypeIndex?: Map<string, string[]>;

  constructor(dict: SchemaDictionary) {
    this.dict = dict;
  }

  get name(): string {
    return this.dict.schema;
  }

  /** Look up an entity by name, case-insensitively. */
  entity(name: string): EntityDef | undefined {
    const n = name.toUpperCase();
    return Object.hasOwn(this.dict.entities, n) ? this.dict.entities[n] : undefined;
  }

  type(name: string): TypeDef | undefined {
    const n = name.toUpperCase();
    return Object.hasOwn(this.dict.types, n) ? this.dict.types[n] : undefined;
  }

  /** The entity and all its supertypes, supertypes first (a topological order). */
  ancestors(name: string): readonly string[] {
    const n = name.toUpperCase();
    let out = this.ancestorCache.get(n);
    if (!out) {
      const order: string[] = [];
      const seen = new Set<string>();
      const visit = (e: string) => {
        if (seen.has(e)) return;
        seen.add(e);
        const def = this.requireEntity(e);
        for (const s of def.supertypes) visit(s);
        order.push(e);
      };
      visit(n);
      out = order;
      this.ancestorCache.set(n, out);
    }
    return out;
  }

  isSubtypeOf(name: string, supertype: string): boolean {
    return this.ancestors(name).includes(supertype.toUpperCase());
  }

  /** Direct subtypes of an entity. */
  subtypes(name: string): readonly string[] {
    if (!this.subtypeIndex) {
      this.subtypeIndex = new Map();
      for (const [e, def] of Object.entries(this.dict.entities)) {
        for (const s of def.supertypes) {
          let list = this.subtypeIndex.get(s);
          if (!list) this.subtypeIndex.set(s, (list = []));
          list.push(e);
        }
      }
    }
    return this.subtypeIndex.get(name.toUpperCase()) ?? [];
  }

  /**
   * The attribute slots of a simple (internal mapping) instance `#1=ENTITY(...)`: inherited explicit attributes
   * first, supertypes in SUBTYPE OF order, depth first, each supertype once; then the entity's own.
   */
  instanceAttributes(name: string): readonly AttributeSlot[] {
    const n = name.toUpperCase();
    let out = this.flatCache.get(n);
    if (!out) {
      const order = this.ancestors(n);
      out = this.slots(order, order);
      this.flatCache.set(n, out);
    }
    return out;
  }

  /**
   * The attribute slots of one partial entity in a complex (external mapping) instance `#1=(A(...)B(...))`:
   * only the entity's own explicit attributes. `members` lists all the instance's entities, whose redeclarations
   * can make an attribute derived or narrow its type.
   */
  partialAttributes(name: string, members: readonly string[]): readonly AttributeSlot[] {
    const n = name.toUpperCase();
    const key = `${n}|${members.join(',')}`;
    let out = this.partialCache.get(key);
    if (!out) {
      // Every ancestor of every member contributes redeclarations, supertypes before subtypes.
      const all: string[] = [];
      const seen = new Set<string>();
      for (const m of members) for (const a of this.ancestors(m)) if (!seen.has(a)) { seen.add(a); all.push(a); }
      out = this.slots([n], all);
      this.partialCache.set(key, out);
    }
    return out;
  }

  private slots(owners: readonly string[], redeclarers: readonly string[]): AttributeSlot[] {
    const slots: AttributeSlot[] = [];
    const byKey = new Map<string, AttributeSlot>();
    for (const owner of owners) {
      for (const a of this.requireEntity(owner).attrs) {
        const s: AttributeSlot = { name: a.name, owner, type: a.type, optional: !!a.optional, derived: false };
        slots.push(s);
        byKey.set(`${owner}.${a.name}`, s);
      }
    }
    // Apply redeclarations general to specific, so the most specific one wins.
    for (const e of redeclarers) {
      const def = this.requireEntity(e);
      for (const r of def.redeclared ?? []) {
        const s = byKey.get(`${r.from}.${r.name}`);
        if (s) { s.type = r.type; s.optional = !!r.optional; }
      }
      for (const r of def.derivedRedeclared ?? []) {
        const s = byKey.get(`${r.from}.${r.name}`);
        if (s) { s.type = r.type; s.derived = true; }
      }
    }
    return slots;
  }

  private requireEntity(name: string): EntityDef {
    const def = this.entity(name);
    if (!def) throw new Error(`${this.name}: unknown entity ${name}`);
    return def;
  }
}
