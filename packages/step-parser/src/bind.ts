// Layer 2: schema binding. A StepModel joins a parsed file with the schema dictionary its FILE_SCHEMA names (plus a
// fallback dictionary, AP242 by default, for entities from other schemas): entity type queries that know about
// subtypes and complex instances, a reverse-reference index, and attribute names for decoded instances, with
// optional checks of each value against its declared type. See docs/architecture.md, "Layer 2: schema binding".
//
// Nothing here fails the file: whatever doesn't match the schema stays positional and gets a diagnostic.

import { dictionaryForFileSchema, loadSchema, type AttributeSlot, type Schema, type TypeRef } from 'step-schemas';
import type { StepFile } from './file.ts';
import { listItems, ParseError, type Diagnostic, type Instance, type Value } from './model.ts';

export interface OpenOptions {
  /**
   * Dictionary id for entities the file's own schema doesn't define, and for files whose FILE_SCHEMA names no
   * dictionary we ship. Default 'ap242', which defines most entities other schemas' files use; null for none.
   */
  fallback?: string | null;
}

/** Load the dictionaries a file needs and bind it. */
export async function openModel(file: StepFile, opts: OpenOptions = {}): Promise<StepModel> {
  const id = dictionaryForFileSchema(file.schemaNames);
  const fb = opts.fallback === undefined ? 'ap242' : opts.fallback;
  const [schema, fallback] = await Promise.all([
    id ? loadSchema(id) : undefined,
    fb && fb !== id ? loadSchema(fb) : undefined,
  ]);
  return new StepModel(file, schema, fallback);
}

export interface BindOptions {
  /** Check each value against its attribute's declared type, and references against their targets' types. */
  check?: boolean;
  /** Recoverable decoding problems are appended here (see StepFile.instanceAt). */
  warnings?: Diagnostic[];
}

/** One attribute of a bound instance. */
export interface BoundAttribute {
  /** The entity whose record holds the value: the instance's type, or the partial of a complex instance. */
  record: string;
  slot: AttributeSlot;
  value: Value;
}

export class BoundInstance {
  readonly instance: Instance;
  readonly position: number;
  /** The entity types: one for a simple instance, the partials in file order for a complex one. */
  readonly types: readonly string[];
  /** The dictionary that bound the instance; undefined when it couldn't be bound (attributes stay positional). */
  readonly schema?: Schema;
  /** Every attribute in file order, when bound. */
  readonly attributes?: readonly BoundAttribute[];
  readonly diagnostics: Diagnostic[];
  private byName?: Map<string, BoundAttribute | null>;

  constructor(instance: Instance, position: number, types: readonly string[], schema: Schema | undefined,
    attributes: BoundAttribute[] | undefined, diagnostics: Diagnostic[]) {
    this.instance = instance;
    this.position = position;
    this.types = types;
    this.schema = schema;
    this.attributes = attributes;
    this.diagnostics = diagnostics;
  }

  get id(): number {
    return this.instance.id;
  }

  /**
   * An attribute's value by name (`'name'`), or by declaring entity and name (`'REPRESENTATION_ITEM.name'`) when a
   * name alone is ambiguous, which throws. Undefined when the instance isn't bound or has no such attribute.
   */
  get(name: string): Value | undefined {
    if (!this.attributes) return undefined;
    if (!this.byName) {
      this.byName = new Map();
      for (const a of this.attributes) {
        const n = a.slot.name;
        this.byName.set(n, this.byName.has(n) ? null : a);
        this.byName.set(`${a.slot.owner}.${n}`, a);
      }
    }
    const a = this.byName.get(name.includes('.') ? name.replace(/^[^.]*/, (e) => e.toUpperCase()) : name);
    if (a === null) throw new Error(`#${this.id}: attribute '${name}' is ambiguous; qualify it with the declaring entity`);
    return a?.value;
  }
}

export class StepModel {
  readonly file: StepFile;
  /** The dictionary for the file's FILE_SCHEMA, if we ship one. */
  readonly schema?: Schema;
  /** The dictionary for entities the file's schema doesn't define. */
  readonly fallback?: Schema;
  /** Model-level diagnostics (the schema choice). Per-instance ones come with each BoundInstance. */
  readonly diagnostics: Diagnostic[] = [];

  private complexTypes = new Map<number, readonly string[]>();
  private byType?: Map<string, number[]>;
  private revStarts?: Uint32Array;
  private rev?: Uint32Array;

  constructor(file: StepFile, schema?: Schema, fallback?: Schema) {
    this.file = file;
    this.schema = schema;
    this.fallback = fallback;
    if (!schema) {
      const names = file.schemaNames.map((n) => `'${n}'`).join(', ') || 'none';
      this.diagnostics.push({
        severity: 'warning',
        message: `no dictionary for FILE_SCHEMA (${names})${fallback ? `; binding with ${fallback.name}` : ''}`,
      });
    }
  }

  /** The dictionary that defines an entity or type: the file's own first, then the fallback. */
  schemaFor(name: string): Schema | undefined {
    if (this.schema?.entity(name) || this.schema?.type(name)) return this.schema;
    if (this.fallback?.entity(name) || this.fallback?.type(name)) return this.fallback;
    return undefined;
  }

  /**
   * The entity types of the instance at position p: its type, or the partials of a complex instance in file order.
   * Empty for a malformed complex instance.
   */
  types(p: number): readonly string[] {
    const t = this.file.index.typeName(p);
    if (t !== undefined) return [t];
    let out = this.complexTypes.get(p);
    if (!out) {
      try {
        const inst = this.file.instanceAt(p);
        out = 'parts' in inst ? inst.parts.map((r) => r.type) : [inst.type];
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        out = [];
      }
      this.complexTypes.set(p, out);
    }
    return out;
  }

  /** Whether the instance at p is an `entity`, directly, through a supertype, or as a partial of a complex instance. */
  isInstanceOf(p: number, entity: string): boolean {
    const e = entity.toUpperCase();
    for (const t of this.types(p)) {
      if (t === e) return true;
      const s = this.schemaFor(t);
      if (s?.entity(t) && s.entity(e) && s.isSubtypeOf(t, e)) return true;
    }
    return false;
  }

  /** Positions of the instances of an entity, including subtypes and complex instances, in file order. */
  instancesOf(entity: string): Uint32Array {
    const byType = this.typeIndex();
    // The entity and its subtypes in either dictionary.
    const names = new Set<string>();
    const add = (s: Schema | undefined, e: string, seen: Set<string>) => {
      if (seen.has(e)) return;
      seen.add(e);
      names.add(e);
      if (s?.entity(e)) for (const sub of s.subtypes(e)) add(s, sub, seen);
    };
    const e = entity.toUpperCase();
    add(this.schema, e, new Set());
    add(this.fallback, e, new Set());
    const out = new Set<number>();
    for (const n of names) for (const p of byType.get(n) ?? []) out.add(p);
    return Uint32Array.from(out).sort();
  }

  /** Positions of the distinct instances that reference the instance at p, in file order. */
  referrers(p: number): Uint32Array {
    if (!this.rev) this.buildReverse();
    return this.rev!.subarray(this.revStarts![p]!, this.revStarts![p + 1]!);
  }

  /** The position a reference resolves to, or -1 for a dangling reference. */
  resolve(id: number): number {
    return this.file.index.position(id);
  }

  /** Decode and bind the instance at position p. Throws ParseError if it is malformed. */
  bind(p: number, opts: BindOptions = {}): BoundInstance {
    return this.bindInstance(this.file.instanceAt(p, opts.warnings), p, opts);
  }

  /** Bind an already decoded instance (position -1 if it isn't from this file). */
  bindInstance(inst: Instance, p: number, opts: BindOptions = {}): BoundInstance {
    const parts = 'parts' in inst ? inst.parts : [{ type: inst.type, attrs: inst.attrs }];
    const types = parts.map((r) => r.type);
    const diags: Diagnostic[] = [];
    const id = inst.id;
    const warn = (message: string, severity: Diagnostic['severity'] = 'warning') => diags.push({ severity, message, id });

    const knows = (s: Schema | undefined) => !!s && types.every((t) => s.entity(t));
    const s = knows(this.schema) ? this.schema : knows(this.fallback) ? this.fallback : undefined;
    if (!s) {
      const unknown = types.filter((t) => !this.schemaFor(t)?.entity(t));
      warn(unknown.length ? `unknown entity ${unknown.join(', ')}` : `entities ${types.join(', ')} are not all in one schema`);
      return new BoundInstance(inst, p, types, undefined, undefined, diags);
    }
    if (s !== this.schema && this.schema) {
      warn(`${types.filter((t) => !this.schema!.entity(t)).join(', ')} not in ${this.schema.name}; bound with ${s.name}`, 'info');
    }
    if (parts.length > 1 && types.some((t, i) => i > 0 && types[i - 1]! > t)) warn('partials not in alphabetical order', 'info');

    const attributes: BoundAttribute[] = [];
    for (const r of parts) {
      const slots = parts.length > 1 ? s.partialAttributes(r.type, types) : s.instanceAttributes(r.type);
      if (slots.length !== r.attrs.length) {
        warn(`${r.type}: ${r.attrs.length} attributes, schema has ${slots.length}`);
        return new BoundInstance(inst, p, types, undefined, undefined, diags);
      }
      for (let i = 0; i < slots.length; i++) attributes.push({ record: r.type, slot: slots[i]!, value: r.attrs[i]! });
    }

    for (const a of attributes) {
      const { slot, value } = a;
      const where = `${slot.owner}.${slot.name}`;
      if (slot.derived) {
        if (value.k !== 'derived') warn(`${where}: value where the schema derives the attribute (*)`);
        continue;
      }
      if (value.k === 'derived') { warn(`${where}: * but the attribute isn't derived`); continue; }
      if (!opts.check) continue;
      if (value.k === 'unset') {
        if (!slot.optional) warn(`${where}: $ in a mandatory attribute`, 'info');
        continue;
      }
      new Checker(this, s, where, warn).value(value, slot.type);
    }
    return new BoundInstance(inst, p, types, s, attributes, diags);
  }

  /**
   * Attribute names for a decoded instance, one list per record (one for a simple instance), or undefined when it
   * can't be bound. For annotating raw JSON (see jsonChunks).
   */
  attributeNames(inst: Instance): string[][] | undefined {
    const b = this.bindInstance(inst, -1);
    if (!b.attributes) return undefined;
    const parts = 'parts' in inst ? inst.parts : [inst];
    let k = 0;
    return parts.map((r) => r.attrs.map(() => b.attributes![k++]!.slot.name));
  }

  private typeIndex(): Map<string, number[]> {
    if (!this.byType) {
      const m = new Map<string, number[]>();
      const ix = this.file.index;
      for (let p = 0; p < ix.count; p++) {
        for (const t of this.types(p)) {
          let list = m.get(t);
          if (!list) m.set(t, (list = []));
          list.push(p);
        }
      }
      this.byType = m;
    }
    return this.byType;
  }

  // Compressed rows: the referrers of p are rev[revStarts[p] .. revStarts[p + 1]).
  private buildReverse(): void {
    const ix = this.file.index;
    const n = ix.count;
    const targets = new Int32Array(ix.refs.length);
    const counts = new Uint32Array(n + 1);
    for (let p = 0; p < n; p++) {
      for (let r = ix.refStarts[p]!; r < ix.refStarts[p + 1]!; r++) {
        const q = ix.position(ix.refs[r]!);
        targets[r] = q;
        if (q >= 0) counts[q + 1]!++;
      }
    }
    for (let q = 0; q < n; q++) counts[q + 1]! += counts[q]!;
    const fill = counts.slice(0, n);
    const rev = new Uint32Array(counts[n]!);
    for (let p = 0; p < n; p++) {
      for (let r = ix.refStarts[p]!; r < ix.refStarts[p + 1]!; r++) {
        const q = targets[r]!;
        // Sources are visited in order, so a repeated reference from p to q is the previous entry.
        if (q < 0 || (fill[q]! > counts[q]! && rev[fill[q]! - 1] === p)) continue;
        rev[fill[q]!++] = p;
      }
    }
    // Compact away the slots left by repeated references.
    let o = 0;
    const starts = new Uint32Array(n + 1);
    for (let q = 0; q < n; q++) {
      starts[q] = o;
      for (let i = counts[q]!; i < fill[q]!; i++) rev[o++] = rev[i]!;
    }
    starts[n] = o;
    this.revStarts = starts;
    this.rev = rev.subarray(0, o);
  }
}

/** Checks one attribute value against its declared type. Each distinct problem is reported once per attribute. */
class Checker {
  private readonly model: StepModel;
  private readonly s: Schema;
  private readonly where: string;
  private readonly warn: (m: string) => void;
  private readonly seen = new Set<string>();

  constructor(model: StepModel, s: Schema, where: string, warn: (m: string) => void) {
    this.model = model;
    this.s = s;
    this.where = where;
    this.warn = warn;
  }

  private problem(m: string): void {
    if (this.seen.has(m)) return;
    this.seen.add(m);
    this.warn(`${this.where}: ${m}`);
  }

  value(v: Value, t: TypeRef): void {
    if (v.k === 'derived') { this.problem('* inside a value'); return; }
    if (typeof t !== 'string') { this.aggregate(v, t); return; }
    switch (t) {
      case 'INTEGER': if (v.k !== 'int') this.problem(`expected INTEGER, got ${kind(v)}`); return;
      case 'REAL': if (v.k !== 'real') this.problem(`expected REAL, got ${kind(v)}`); return;
      case 'NUMBER': if (v.k !== 'int' && v.k !== 'real') this.problem(`expected NUMBER, got ${kind(v)}`); return;
      case 'STRING': if (v.k !== 'str') this.problem(`expected STRING, got ${kind(v)}`); return;
      case 'BINARY': if (v.k !== 'bin') this.problem(`expected BINARY, got ${kind(v)}`); return;
      case 'BOOLEAN': if (v.k !== 'enum' || (v.v !== 'T' && v.v !== 'F')) this.problem(`expected BOOLEAN, got ${kind(v)}`); return;
      case 'LOGICAL': if (v.k !== 'enum' || (v.v !== 'T' && v.v !== 'F' && v.v !== 'U')) this.problem(`expected LOGICAL, got ${kind(v)}`); return;
    }
    const def = this.s.type(t);
    if (!def) {
      if (this.s.entity(t)) this.entity(v, t);
      else this.problem(`unknown type ${t}`);
      return;
    }
    switch (def.kind) {
      case 'defined':
        if (v.k === 'typed' && this.isA(v.type, t)) {
          this.problem(`typed parameter ${v.type}(...) where a plain value is expected (only SELECT values are typed)`);
          this.value(v.v, v.type);
        } else {
          this.value(v, def.type);
        }
        return;
      case 'enum':
        if (v.k !== 'enum') this.problem(`expected ${t}, got ${kind(v)}`);
        else if (!this.s.enumValues(t).has(v.v)) this.problem(`.${v.v}. is not a ${t} value`);
        return;
      case 'select':
        this.select(v, t);
        return;
    }
  }

  private select(v: Value, t: string): void {
    const leaves = this.s.selectLeaves(t);
    if (v.k === 'ref') {
      this.target(v.v, (p) => leaves.generic || [...leaves.entities].some((e) => this.model.isInstanceOf(p, e)), `SELECT ${t}`);
    } else if (v.k === 'refs' || v.k === 'reals' || v.k === 'ints' || v.k === 'list') {
      this.problem(`expected SELECT ${t}, got a list`);
    } else if (v.k === 'typed') {
      const leaf = [...leaves.types].find((l) => this.isA(v.type, l));
      if (!leaf) this.problem(`typed parameter ${v.type}(...) is not in SELECT ${t}`);
      else this.value(v.v, v.type);
    } else {
      this.problem(`${kind(v)} without a type name in SELECT ${t}`);
    }
  }

  /** Whether defined type `a` is `b` or specializes it through its chain of underlying types. */
  private isA(a: string, b: string): boolean {
    let t: TypeRef | undefined = a;
    for (let i = 0; i < 32 && typeof t === 'string'; i++) {
      if (t === b) return true;
      const def = this.s.type(t);
      t = def?.kind === 'defined' ? def.type : undefined;
    }
    return false;
  }

  private entity(v: Value, e: string): void {
    if (v.k !== 'ref') { this.problem(`expected a reference to ${e}, got ${kind(v)}`); return; }
    this.target(v.v, (p) => this.model.isInstanceOf(p, e), e);
  }

  private target(id: number, ok: (p: number) => boolean, expected: string): void {
    const p = this.model.resolve(id);
    if (p < 0) { this.problem('dangling reference'); return; }
    if (!ok(p)) this.problem(`reference to ${this.model.types(p).join('+') || 'a malformed instance'}, expected ${expected}`);
  }

  private aggregate(v: Value, t: Exclude<TypeRef, string>): void {
    if (v.k !== 'list' && v.k !== 'reals' && v.k !== 'ints' && v.k !== 'refs') {
      this.problem(`expected ${t.agg}, got ${kind(v)}`);
      return;
    }
    const n = v.v.length;
    if ((typeof t.lo === 'number' && n < t.lo) || (typeof t.hi === 'number' && n > t.hi)) {
      this.problem(`${t.agg} of ${n} elements, expected [${t.lo ?? '?'}:${t.hi ?? '?'}]`);
    }
    if (n === 0) return;
    if (v.k === 'reals' || v.k === 'ints') {
      // All elements have one kind, so one check covers them.
      this.value(v.k === 'reals' ? { k: 'real', v: v.v[0]! } : { k: 'int', v: v.v[0]! }, t.of);
      return;
    }
    for (const e of v.k === 'list' ? v.v : listItems(v)) {
      if (e.k === 'unset') { if (!t.optional) this.problem(`$ in ${t.agg}`); continue; }
      this.value(e, t.of);
    }
  }
}

function kind(v: Value): string {
  switch (v.k) {
    case 'ref': return 'a reference';
    case 'enum': return `.${v.v}.`;
    case 'typed': return `${v.type}(...)`;
    case 'reals': case 'ints': case 'refs': case 'list': return 'a list';
    case 'str': return 'a string';
    case 'unset': return '$';
    case 'derived': return '*';
    case 'bin': return 'a binary';
    case 'int': return 'an integer';
    case 'real': return 'a real';
  }
}
