// EXPRESS (ISO 10303-11) tokenizer. Only what the declaration parser needs: identifiers, numbers,
// strings and punctuation. Remarks are dropped; identifiers are case-insensitive and returned lowercase.

export type TokenKind = 'id' | 'num' | 'str' | 'op' | 'eof';

export interface Token {
  k: TokenKind;
  v: string;
  line: number;
}

// Multi-character operators, longest first.
const OPS = ['<*', ':<>:', ':=:', '<>', '<=', '>=', ':=', '||', '**', '\\'];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    // Embedded remark (* ... *), which may nest.
    if (c === '(' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '(' && src[i + 1] === '*') { depth++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === ')') { depth--; i += 2; }
        else { if (src[i] === '\n') line++; i++; }
      }
      if (depth > 0) throw new Error(`unterminated remark at end of input`);
      continue;
    }
    // Tail remark -- to end of line.
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j).toLowerCase(), line });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(src[j]!)) j++;
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        j++;
        while (j < n && isDigit(src[j]!)) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[-+0-9]/.test(src[j + 1] ?? '')) {
        j += 2;
        while (j < n && isDigit(src[j]!)) j++;
      }
      out.push({ k: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === "'") {
      // Simple string literal; '' is an embedded quote.
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) throw new Error(`unterminated string at line ${line}`);
        const d = src[j]!;
        if (d === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        if (d === '\n') line++;
        s += d;
        j++;
      }
      out.push({ k: 'str', v: s, line });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      // Encoded string literal: hex digits, kept as-is.
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw new Error(`unterminated encoded string at line ${line}`);
      out.push({ k: 'str', v: src.slice(i + 1, j), line });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ k: 'op', v: op, line });
      i += op.length;
      continue;
    }
    out.push({ k: 'op', v: c, line });
    i++;
  }
  out.push({ k: 'eof', v: '', line });
  return out;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isIdPart(c: string): boolean {
  return isIdStart(c) || isDigit(c) || c === '_';
}
