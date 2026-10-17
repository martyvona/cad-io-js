// Shared plumbing for the Layer 3 extractors: cached binding, attribute access by name, reference following and
// diagnostics. Extractors never throw over file content; they record a diagnostic and carry on.

import type { BoundInstance, StepModel } from '../bind.ts';
import { listItems, ParseError, type Diagnostic, type Value } from '../model.ts';

export class Reader {
  readonly model: StepModel;
  readonly diagnostics: Diagnostic[] = [];
  private cache = new Map<number, BoundInstance | null>();

  constructor(model: StepModel) {
    this.model = model;
  }

  /** The bound instance at position p, cached; undefined if it is malformed or p < 0. */
  bound(p: number): BoundInstance | undefined {
    if (p < 0) return undefined;
    let b = this.cache.get(p);
    if (b === undefined) {
      try {
        b = this.model.bind(p);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        b = null;
      }
      this.cache.set(p, b);
    }
    return b ?? undefined;
  }

  id(p: number): number {
    return this.model.file.index.ids[p]!;
  }

  is(p: number, entity: string): boolean {
    return p >= 0 && this.model.isInstanceOf(p, entity);
  }

  /** An attribute's value, or undefined (unbound instance, no such attribute). */
  attr(p: number, name: string): Value | undefined {
    return this.bound(p)?.get(name);
  }

  /** The position an attribute references, or -1 ($, not a reference, dangling). */
  ref(p: number, name: string): number {
    return refPosition(this.model, this.attr(p, name));
  }

  /** The positions an aggregate attribute references, skipping anything that isn't a resolvable reference. */
  refs(p: number, name: string): number[] {
    const v = this.attr(p, name);
    if (!v) return [];
    const out: number[] = [];
    for (const e of items(v)) {
      const q = refPosition(this.model, e);
      if (q >= 0) out.push(q);
    }
    return out;
  }

  str(p: number, name: string): string | undefined {
    const v = this.attr(p, name);
    return v?.k === 'str' ? v.v : undefined;
  }

  /** A number attribute, unwrapping a typed parameter such as LENGTH_MEASURE(5.). */
  num(p: number, name: string): number | undefined {
    return numberOf(this.attr(p, name));
  }

  /** An enumeration attribute's value, without the dots. */
  enum(p: number, name: string): string | undefined {
    const v = this.attr(p, name);
    return v?.k === 'enum' ? v.v : undefined;
  }

  /** The instances of an entity that reference p, optionally only through one attribute. */
  referrers(p: number, entity: string, via?: string): number[] {
    const out: number[] = [];
    for (const q of this.model.referrers(p)) {
      if (!this.model.isInstanceOf(q, entity)) continue;
      if (via !== undefined) {
        const v = this.attr(q, via);
        if (!v || !items(v).some((e) => refPosition(this.model, e) === p)) continue;
      }
      out.push(q);
    }
    return out;
  }

  warn(message: string, p?: number, severity: Diagnostic['severity'] = 'warning'): void {
    this.diagnostics.push(p === undefined ? { severity, message } : { severity, message, id: this.id(p) });
  }
}

/** A value's elements if it is a list, else the value itself. */
export function items(v: Value): Value[] {
  return v.k === 'list' || v.k === 'reals' || v.k === 'ints' || v.k === 'refs' ? listItems(v) : [v];
}

export function refPosition(model: StepModel, v: Value | undefined): number {
  return v?.k === 'ref' ? model.resolve(v.v) : -1;
}

/** A number, unwrapping typed parameters. */
export function numberOf(v: Value | undefined): number | undefined {
  while (v?.k === 'typed') v = v.v;
  if (v?.k === 'real') return v.v;
  if (v?.k === 'int') return Number(v.v);
  return undefined;
}

/** A list of numbers (reals or ints), or undefined if it isn't one. */
export function numbersOf(v: Value | undefined): number[] | undefined {
  if (!v) return undefined;
  if (v.k === 'reals' || v.k === 'ints') return Array.from(v.v as ArrayLike<number>);
  if (v.k !== 'list') return undefined;
  const out: number[] = [];
  for (const e of v.v) {
    const x = numberOf(e);
    if (x === undefined) return undefined;
    out.push(x);
  }
  return out;
}
