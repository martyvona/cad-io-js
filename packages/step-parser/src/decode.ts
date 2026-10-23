// Pass 2: decode one instance (or header entity) from its byte range into the raw instance model.

import { makeList, ParseError, type Diagnostic, type EntityRecord, type Instance, type Value } from './model.ts';
import { decodeString } from './strings.ts';

const HASH = 0x23, DOLLAR = 0x24, STAR = 0x2a, QUOTE = 0x27, DQUOTE = 0x22, DOT = 0x2e, LPAREN = 0x28;
const RPAREN = 0x29, COMMA = 0x2c, SEMI = 0x3b, EQUALS = 0x3d, SLASH = 0x2f, PLUS = 0x2b, MINUS = 0x2d, BANG = 0x21;

const WS = new Uint8Array(256);
for (const c of [0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x0b]) WS[c] = 1;
const KW = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) KW[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) KW[c] = KW[c + 0x20] = 1;
KW[0x5f] = 1;

// Shared constants for the payload-free kinds.
const UNSET: Value = Object.freeze({ k: 'unset' }) as Value;
const DERIVED: Value = Object.freeze({ k: 'derived' }) as Value;

/**
 * Decode `#id=TYPE(...);` or `#id=(A(...)B(...));` from bytes[start, end). Throws ParseError if it is malformed.
 * Recoverable problems (an empty parameter, read as `$`) go to `warnings`; an out-of-range reference is read as `$`
 * too, and the scan warns of it.
 */
export function decodeInstance(bytes: Uint8Array, start: number, end: number, warnings?: Diagnostic[]): Instance {
  const d = new Decoder(bytes, start, end, warnings);
  d.expect(HASH);
  const id = d.unsigned();
  d.id = id;
  d.skip();
  d.expect(EQUALS);
  d.skip();
  let inst: Instance;
  if (d.peek() === LPAREN) {
    d.pos++;
    const parts: EntityRecord[] = [];
    for (;;) {
      d.skip();
      if (d.peek() === RPAREN) { d.pos++; break; }
      parts.push(d.record());
    }
    if (parts.length === 0) throw d.error('empty complex instance');
    inst = { id, parts };
  } else {
    const r = d.record();
    inst = { id, type: r.type, attrs: r.attrs };
  }
  d.end();
  return inst;
}

/** Decode a header entity `TYPE(...);` from bytes[start, end). */
export function decodeRecord(bytes: Uint8Array, start: number, end: number, warnings?: Diagnostic[]): EntityRecord {
  const d = new Decoder(bytes, start, end, warnings);
  const r = d.record();
  d.end();
  return r;
}

/** Decode a parenthesized parameter list, such as the `('name', ('SCHEMA'))` of an edition 3 DATA section. */
export function decodeList(bytes: Uint8Array, start: number, end: number): Value[] {
  const d = new Decoder(bytes, start, end);
  d.skip();
  const v = d.list();
  d.skip();
  if (d.pos < end) throw d.error('unexpected text after list');
  return v;
}

class Decoder {
  readonly bytes: Uint8Array;
  pos: number;
  readonly limit: number;
  readonly warnings?: Diagnostic[];
  id?: number;

  constructor(bytes: Uint8Array, start: number, limit: number, warnings?: Diagnostic[]) {
    this.bytes = bytes;
    this.pos = start;
    this.limit = limit;
    this.warnings = warnings;
  }

  peek(): number {
    return this.pos < this.limit ? this.bytes[this.pos]! : -1;
  }

  skip(): void {
    const b = this.bytes;
    while (this.pos < this.limit) {
      const c = b[this.pos]!;
      if (WS[c]) { this.pos++; continue; }
      if (c === SLASH && b[this.pos + 1] === STAR) {
        let j = this.pos + 2;
        while (j < this.limit - 1 && !(b[j] === STAR && b[j + 1] === SLASH)) j++;
        if (j >= this.limit - 1) throw this.error('unterminated comment');
        this.pos = j + 2;
        continue;
      }
      break;
    }
  }

  expect(c: number): void {
    if (this.peek() !== c) throw this.error(`expected '${String.fromCharCode(c)}'`);
    this.pos++;
  }

  /** The closing `;`, then nothing but whitespace and comments. */
  end(): void {
    this.skip();
    this.expect(SEMI);
    this.skip();
    if (this.pos < this.limit) throw this.error('unexpected text after ;');
  }

  unsigned(): number {
    const b = this.bytes;
    const s = this.pos;
    let v = 0;
    while (this.pos < this.limit) {
      const d = b[this.pos]! - 0x30;
      if (d < 0 || d > 9) break;
      v = v * 10 + d;
      this.pos++;
    }
    if (this.pos === s) throw this.error('expected digits');
    return v;
  }

  keyword(): string {
    const b = this.bytes;
    const s = this.pos;
    if (b[this.pos] === BANG) this.pos++;
    while (this.pos < this.limit && KW[b[this.pos]!]) this.pos++;
    if (this.pos === s) throw this.error('expected a keyword');
    let k = '';
    for (let i = s; i < this.pos; i++) k += String.fromCharCode(b[i]!);
    return k.toUpperCase();
  }

  record(): EntityRecord {
    this.skip();
    const type = this.keyword();
    this.skip();
    return { type, attrs: this.list() };
  }

  /** `( [value {, value}] )` */
  list(): Value[] {
    this.expect(LPAREN);
    const out: Value[] = [];
    this.skip();
    if (this.peek() === RPAREN) { this.pos++; return out; }
    for (;;) {
      this.skip();
      const e = this.peek();
      if (e === COMMA || e === RPAREN) {
        // An empty parameter, as in EDGE_CURVE('',#1,#2,#3, ): not Part 21, read as $.
        this.warnings?.push({ severity: 'warning', message: 'empty parameter read as $', offset: this.pos,
          id: this.id });
        out.push(UNSET);
      } else {
        out.push(this.value());
      }
      this.skip();
      const c = this.peek();
      if (c === COMMA) { this.pos++; continue; }
      if (c === RPAREN) { this.pos++; return out; }
      throw this.error("expected ',' or ')'");
    }
  }

  value(): Value {
    this.skip();
    const b = this.bytes;
    const c = this.peek();
    switch (c) {
      case HASH: {
        this.pos++;
        const v = this.unsigned();
        if (v > 0xffffffff) {
          // Ids are at most 2^32 - 1, so this can't resolve (OCCT's bug31292.stp has #18446744073709551615). Like
          // OCCT, keep the instance and treat the reference as unresolved: read as $. The scan warns of it, once for
          // the file however often the instance is decoded.
          return UNSET;
        }
        return { k: 'ref', v };
      }
      case DOLLAR:
        this.pos++;
        return UNSET;
      case STAR:
        this.pos++;
        return DERIVED;
      case QUOTE: {
        const s = decodeString(b, this.pos, this.limit);
        if (!s) throw this.error('unterminated string');
        this.pos = s.end;
        return { k: 'str', v: s.value };
      }
      case DQUOTE: {
        let hex = '';
        let j = this.pos + 1;
        for (; j < this.limit && b[j] !== DQUOTE; j++) {
          const h = b[j]!;
          if (WS[h]) continue;
          if (!((h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46))) throw this.error('invalid binary digit');
          hex += String.fromCharCode(h);
        }
        if (j >= this.limit) throw this.error('unterminated binary');
        this.pos = j + 1;
        return { k: 'bin', v: hex };
      }
      case DOT: {
        let j = this.pos + 1;
        while (j < this.limit && KW[b[j]!]) j++;
        if (b[j] !== DOT || j === this.pos + 1) throw this.error('invalid enumeration');
        let v = '';
        for (let i = this.pos + 1; i < j; i++) v += String.fromCharCode(b[i]!);
        this.pos = j + 1;
        return { k: 'enum', v: v.toUpperCase() };
      }
      case LPAREN:
        return makeList(this.list());
    }
    if ((c >= 0x30 && c <= 0x39) || c === PLUS || c === MINUS) return this.number();
    if (c >= 0 && (KW[c] || c === BANG)) {
      const type = this.keyword();
      this.skip();
      this.expect(LPAREN);
      const v = this.value();
      this.skip();
      this.expect(RPAREN);
      return { k: 'typed', type, v };
    }
    throw this.error(c < 0 ? 'unexpected end of instance' : `unexpected '${String.fromCharCode(c)}'`);
  }

  /** Integers have no '.' or exponent. Reals should have a '.', but `1E-5` is accepted as a real too. */
  number(): Value {
    const b = this.bytes;
    const s = this.pos;
    let i = s;
    if (b[i] === PLUS || b[i] === MINUS) i++;
    const digits = i;
    while (i < this.limit && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    if (i === digits) throw this.error('expected a number');
    let real = false;
    if (b[i] === DOT) {
      real = true;
      i++;
      while (i < this.limit && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    }
    if (b[i] === 0x45 || b[i] === 0x65) {
      let j = i + 1;
      if (b[j] === PLUS || b[j] === MINUS) j++;
      const e = j;
      while (j < this.limit && b[j]! >= 0x30 && b[j]! <= 0x39) j++;
      if (j > e) { real = true; i = j; }
    }
    let text = '';
    for (let k = s; k < i; k++) text += String.fromCharCode(b[k]!);
    this.pos = i;
    if (real) return { k: 'real', v: Number(text) };
    if (i - digits <= 15) return { k: 'int', v: Number(text) };
    const big = BigInt(text);
    return { k: 'int', v: big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(
      big) : big };
  }

  error(msg: string): ParseError {
    return new ParseError(msg, this.pos);
  }
}
