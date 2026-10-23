// A JSON parser (RFC 8259) that keeps integers and reals apart by their lexical form. A number written without a
// fraction or exponent (`5`, `-12`) is an integer and parses as a bigint; any other number (`5.0`, `1e-7`) is a real
// and parses as a double. JSON.parse can't do this: it reads both `5` and `5.0` as the number 5.

export type JsonValue = null | boolean | string | number | bigint | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class JsonParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = 'JsonParseError';
    this.offset = offset;
  }
}

const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c, COLON = 0x3a, MINUS = 0x2d, PLUS = 0x2b, DOT = 0x2e;
const LBRACKET = 0x5b, RBRACKET = 0x5d, LBRACE = 0x7b, RBRACE = 0x7d;

const encoder = new TextEncoder();
// ignoreBOM: a string that starts with U+FEFF keeps it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Parse JSON text, given as UTF-8 bytes or a string. Integers become bigints, reals numbers. A real too large for a
 * double is an error. Duplicate object keys are an error. A UTF-8 byte order mark before the value is skipped.
 */
export function parseJson(input: Uint8Array | string): JsonValue {
  const p = new Parser(typeof input === 'string' ? encoder.encode(input) : input);
  if (p.b[0] === 0xef && p.b[1] === 0xbb && p.b[2] === 0xbf) p.pos = 3;
  p.ws();
  const v = p.value();
  p.ws();
  if (p.pos < p.b.length) throw p.error('unexpected text after the value');
  return v;
}

class Parser {
  readonly b: Uint8Array;
  pos = 0;

  constructor(b: Uint8Array) {
    this.b = b;
  }

  ws(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
      this.pos++;
    }
  }

  value(): JsonValue {
    const c = this.b[this.pos];
    switch (c) {
      case LBRACE: return this.object();
      case LBRACKET: return this.array();
      case QUOTE: return this.string();
      case 0x74: return this.literal('true', true);
      case 0x66: return this.literal('false', false);
      case 0x6e: return this.literal('null', null);
    }
    if (c === MINUS || (c !== undefined && c >= 0x30 && c <= 0x39)) return this.number();
    throw this.error(c === undefined ? 'unexpected end of input' : `unexpected '${String.fromCharCode(c)}'`);
  }

  literal<T>(word: string, v: T): T {
    for (let i = 0; i < word.length; i++) {
      if (this.b[this.pos + i] !== word.charCodeAt(i)) throw this.error(`expected '${word}'`);
    }
    this.pos += word.length;
    return v;
  }

  object(): JsonObject {
    this.pos++;
    const o: JsonObject = {};
    this.ws();
    if (this.b[this.pos] === RBRACE) { this.pos++; return o; }
    for (;;) {
      if (this.b[this.pos] !== QUOTE) throw this.error('expected a key');
      const at = this.pos;
      const k = this.string();
      this.ws();
      if (this.b[this.pos] !== COLON) throw this.error("expected ':'");
      this.pos++;
      this.ws();
      const v = this.value();
      if (Object.hasOwn(o, k)) throw new JsonParseError(`duplicate key ${JSON.stringify(k)}`, at);
      // defineProperty, so that a "__proto__" key is an ordinary property, as with JSON.parse.
      if (k === '__proto__') Object.defineProperty(o, k,
        { value: v, enumerable: true, writable: true, configurable: true });
      else o[k] = v;
      this.ws();
      const c = this.b[this.pos];
      this.pos++;
      if (c === COMMA) { this.ws(); continue; }
      if (c === RBRACE) return o;
      this.pos--;
      throw this.error("expected ',' or '}'");
    }
  }

  array(): JsonValue[] {
    this.pos++;
    const a: JsonValue[] = [];
    this.ws();
    if (this.b[this.pos] === RBRACKET) { this.pos++; return a; }
    for (;;) {
      a.push(this.value());
      this.ws();
      const c = this.b[this.pos];
      this.pos++;
      if (c === COMMA) { this.ws(); continue; }
      if (c === RBRACKET) return a;
      this.pos--;
      throw this.error("expected ',' or ']'");
    }
  }

  number(): number | bigint {
    const b = this.b;
    const s = this.pos;
    let i = s;
    if (b[i] === MINUS) i++;
    if (b[i] === 0x30) i++;
    else if (b[i]! >= 0x31 && b[i]! <= 0x39) while (b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    else throw this.at(i, 'expected a digit');
    let real = false;
    if (b[i] === DOT) {
      real = true;
      const d = ++i;
      while (b[i]! >= 0x30 && b[i]! <= 0x39) i++;
      if (i === d) throw this.at(i, 'expected a digit after the decimal point');
    }
    if (b[i] === 0x65 || b[i] === 0x45) {
      real = true;
      i++;
      if (b[i] === PLUS || b[i] === MINUS) i++;
      const d = i;
      while (b[i]! >= 0x30 && b[i]! <= 0x39) i++;
      if (i === d) throw this.at(i, 'expected a digit in the exponent');
    }
    let text = '';
    for (let k = s; k < i; k++) text += String.fromCharCode(b[k]!);
    this.pos = i;
    if (!real) return BigInt(text);
    const x = Number(text);
    if (!Number.isFinite(x)) throw this.at(s, `real ${text} is out of range`);
    return x;
  }

  string(): string {
    const b = this.b;
    let i = ++this.pos;
    let ascii = true;
    // Fast path: no escapes.
    for (;;) {
      const c = b[i];
      if (c === undefined) throw this.at(i, 'unterminated string');
      if (c === QUOTE) break;
      if (c === BACKSLASH) return this.escaped(i);
      if (c < 0x20) throw this.at(i, 'control character in string');
      if (c > 0x7f) ascii = false;
      i++;
    }
    const s = this.slice(this.pos, i, ascii);
    this.pos = i + 1;
    return s;
  }

  /** The rest of a string from its first backslash at i. */
  escaped(i: number): string {
    const b = this.b;
    let out = this.slice(this.pos, i, false);
    for (;;) {
      const c = b[i];
      if (c === undefined) throw this.at(i, 'unterminated string');
      if (c === QUOTE) { this.pos = i + 1; return out; }
      if (c === BACKSLASH) {
        const e = b[i + 1];
        i += 2;
        switch (e) {
          case QUOTE: out += '"'; break;
          case BACKSLASH: out += '\\'; break;
          case 0x2f: out += '/'; break;
          case 0x62: out += '\b'; break;
          case 0x66: out += '\f'; break;
          case 0x6e: out += '\n'; break;
          case 0x72: out += '\r'; break;
          case 0x74: out += '\t'; break;
          case 0x75: {
            let u = 0;
            for (let k = 0; k < 4; k++) {
              const h = b[i + k]!;
              const d = h >= 0x30 && h <= 0x39 ? h - 0x30
                : h >= 0x41 && h <= 0x46 ? h - 0x37
                  : h >= 0x61 && h <= 0x66 ? h - 0x57 : -1;
              if (d < 0) throw this.at(i + k, 'invalid \\u escape');
              u = u * 16 + d;
            }
            // Surrogates, paired or not, are kept as code units, as JSON.parse does.
            out += String.fromCharCode(u);
            i += 4;
            break;
          }
          default: throw this.at(i - 1, 'invalid escape');
        }
        continue;
      }
      const s = i;
      let ascii = true;
      while (i < b.length && b[i] !== QUOTE && b[i] !== BACKSLASH) {
        if (b[i]! < 0x20) throw this.at(i, 'control character in string');
        if (b[i]! > 0x7f) ascii = false;
        i++;
      }
      out += this.slice(s, i, ascii);
    }
  }

  slice(s: number, e: number, ascii: boolean): string {
    if (ascii && e - s < 64) {
      let t = '';
      for (let k = s; k < e; k++) t += String.fromCharCode(this.b[k]!);
      return t;
    }
    try {
      return utf8.decode(this.b.subarray(s, e));
    } catch {
      throw this.at(s, 'invalid UTF-8 in string');
    }
  }

  at(offset: number, msg: string): JsonParseError {
    return new JsonParseError(msg, offset);
  }

  error(msg: string): JsonParseError {
    return new JsonParseError(msg, this.pos);
  }
}
