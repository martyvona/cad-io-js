// The raw instance model: Part 21 values exactly as written, with no schema knowledge. See docs/architecture.md,
// "The raw instance model".

export type Value =
  | { k: 'int'; v: number | bigint }
  | { k: 'real'; v: number }
  | { k: 'str'; v: string } // decoded Unicode
  | { k: 'enum'; v: string } // without the dots; includes booleans and logicals: T, F, U
  | { k: 'ref'; v: number } // #12
  | { k: 'bin'; v: string } // hex digits; the first digit is the count of unused bits
  | { k: 'unset' } // $
  | { k: 'derived' } // *
  | { k: 'list'; v: Value[] } // a list that isn't one of the three below, including the empty list
  | { k: 'reals'; v: number[] | Float64Array } // a non-empty list of reals only
  | { k: 'ints'; v: number[] | Int32Array | Float64Array } // a non-empty list of ints only, none of them a bigint
  | { k: 'refs'; v: number[] | Uint32Array } // a non-empty list of references only
  | { k: 'typed'; type: string; v: Value }; // LENGTH_MEASURE(5.)

/** The list kinds. */
export type ListValue = Extract<Value, { k: 'list' | 'reals' | 'ints' | 'refs' }>;

/**
 * Lists of at least this many numbers or references are stored in typed arrays; shorter ones in plain arrays, which
 * V8 already stores unboxed and which are cheaper to create. Storage is not part of a value's meaning.
 */
export const TYPED_ARRAY_MIN = 16;

/**
 * The canonical value for a list: `reals`, `ints` or `refs` when every element is of that kind (and no int is a
 * bigint), else `list`. The parser and the JSON loader produce only canonical lists, so two models of the same data
 * are deeply equal.
 */
export function makeList(items: Value[]): ListValue {
  const n = items.length;
  if (n === 0) return { k: 'list', v: items };
  const k = items[0]!.k;
  if (k !== 'real' && k !== 'int' && k !== 'ref') return { k: 'list', v: items };
  // Whether every int fits an Int32Array, or every ref a Uint32Array; else a Float64Array holds them unchanged (even
  // invalid ones, which the writers then reject).
  let fits = true;
  for (let i = 0; i < n; i++) {
    const e = items[i]!;
    if (e.k !== k) return { k: 'list', v: items };
    if (k === 'int') {
      const x = e.v as number | bigint;
      if (typeof x === 'bigint') return { k: 'list', v: items };
      if ((x | 0) !== x) fits = false;
    } else if (k === 'ref' && (e.v as number) >>> 0 !== e.v) {
      fits = false;
    }
  }
  if (n < TYPED_ARRAY_MIN) {
    const a = new Array<number>(n);
    for (let i = 0; i < n; i++) a[i] = (items[i] as { v: number }).v;
    return { k: k === 'real' ? 'reals' : k === 'int' ? 'ints' : 'refs', v: a } as ListValue;
  }
  const a = k === 'real' || !fits ? new Float64Array(n) : k === 'int' ? new Int32Array(n) : new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = (items[i] as { v: number }).v;
  return { k: k === 'real' ? 'reals' : k === 'int' ? 'ints' : 'refs', v: a } as ListValue;
}

/** A list's elements as values, whatever its kind. */
export function listItems(v: ListValue): Value[] {
  if (v.k === 'list') return v.v;
  const k = v.k === 'reals' ? 'real' : v.k === 'ints' ? 'int' : 'ref';
  return Array.from(v.v as ArrayLike<number>, (x) => ({ k, v: x }) as Value);
}

/** One entity record: a simple instance's body, a partial of a complex instance, or a header entity. */
export interface EntityRecord {
  type: string;
  attrs: Value[];
}

export type Instance =
  | { id: number; type: string; attrs: Value[] } // simple: #1=TYPE(...)
  | { id: number; parts: EntityRecord[] }; // complex: #1=(A(...)B(...))

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Byte offset in the input, when known. */
  offset?: number;
  /** Instance id, when the problem belongs to one instance. */
  id?: number;
}

export class ParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = 'ParseError';
    this.offset = offset;
  }
}
