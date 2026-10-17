// The raw instance model: Part 21 values exactly as written, with no schema knowledge. See architecture.md,
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
  | { k: 'list'; v: Value[] }
  | { k: 'typed'; type: string; v: Value }; // LENGTH_MEASURE(5.)

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
