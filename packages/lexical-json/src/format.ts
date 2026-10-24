// Writing lexical JSON: reals always carry a decimal point or an exponent, integers never do, so that parseJson
// (and parsers in other languages that keep the distinction, such as Python's) read each back as the kind written.

import type { JsonValue } from './parse.ts';

/**
 * A real: the shortest text that reads back as the same double, with `.0` added when that text is integral.
 * 5 -> `5.0`, 0.25 -> `0.25`, 1e-7 -> `1e-7`, 1e21 -> `1e+21`, -0 -> `-0.0`. NaN and infinities throw a RangeError.
 */
export function formatReal(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`real value ${x} can't be written in JSON`);
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const s = String(x);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2e || c === 0x65) return s;
  }
  return s + '.0';
}

/** An integer, from a bigint or an integral number. */
export function formatInt(x: number | bigint): string {
  if (typeof x === 'bigint') return x.toString();
  if (!Number.isInteger(x)) throw new RangeError(`integer value ${x} is not an integer`);
  return Number.isSafeInteger(x) ? String(x) : BigInt(x).toString();
}

/** A string literal. Lone surrogates are written as `\u` escapes, so the text is always valid UTF-8. */
export function formatString(s: string): string {
  return JSON.stringify(s);
}

/** Values stringify accepts: JsonValue, plus typed arrays, written as JSON arrays. */
export type JsonInput =
  | JsonValue
  | Float32Array | Float64Array
  | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array
  | BigInt64Array | BigUint64Array
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput | undefined };

export interface StringifyOptions {
  /** Pretty-print with this many spaces per level. Arrays of numbers stay on one line. */
  indent?: number;
}

/**
 * JSON text for a value: bigints as integers, numbers as reals. Float32Array and Float64Array elements are written as
 * reals, the elements of integer typed arrays as integers. Object properties that are undefined are left out.
 */
export function stringify(v: JsonInput, opts: StringifyOptions = {}): string {
  const indent = opts.indent ?? 0;
  const out: string[] = [];
  write(v, '');
  return out.join('');

  function write(v: JsonInput, pad: string): void {
    if (v === null) { out.push('null'); return; }
    switch (typeof v) {
      case 'boolean': out.push(v ? 'true' : 'false'); return;
      case 'number': out.push(formatReal(v)); return;
      case 'bigint': out.push(v.toString()); return;
      case 'string': out.push(formatString(v)); return;
    }
    if (ArrayBuffer.isView(v)) {
      const f = v instanceof Float64Array || v instanceof Float32Array ? formatReal : formatInt;
      const a = v as ArrayLike<number | bigint>;
      let s = '[';
      for (let i = 0; i < a.length; i++) s += (i ? ',' : '') + f(a[i] as never);
      out.push(s + ']');
      return;
    }
    const inner = indent ? pad + ' '.repeat(indent) : '';
    const nl = indent ? '\n' : '';
    if (Array.isArray(v)) {
      if (v.length === 0) { out.push('[]'); return; }
      // Arrays of scalars stay on one line.
      const flat = !indent || v.every((e) => e === null || typeof e !== 'object' || ArrayBuffer.isView(e));
      out.push('[');
      v.forEach((e, i) => {
        if (i) out.push(',');
        if (!flat) out.push(nl + inner);
        write(e as JsonInput, inner);
      });
      out.push(flat ? ']' : nl + pad + ']');
      return;
    }
    if (typeof v !== 'object') throw new TypeError(`can't write ${typeof v} as JSON`);
    const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
    if (keys.length === 0) { out.push('{}'); return; }
    out.push('{');
    keys.forEach((k, i) => {
      out.push((i ? ',' : '') + nl + inner + formatString(k) + (indent ? ': ' : ':'));
      write((v as Record<string, JsonInput>)[k]!, inner);
    });
    out.push(nl + pad + '}');
  }
}
