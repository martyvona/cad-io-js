// Part 21 string literals → Unicode.
//
// Escapes (ISO 10303-21 edition 2/3): '' and \\ for a quote and a backslash; \S\c for character c + 128 in the
// current ISO 8859 page; \Pa\ to select page ISO 8859-1 ('A') through 8859-9 ('I'); \X\hh for an ISO 8859-1
// character; \X2\hhhh…\X0\ for UCS-2 (UTF-16 code units); \X4\hhhhhhhh…\X0\ for UCS-4 code points.
//
// Tolerances for files in the wild (the first four follow OCCT's reader, see its test bugs/step/bug28454_2):
// - A lone ' ends the string only when followed by ',' or ')' (after optional whitespace and comments); otherwise
//   it is a literal apostrophe. Conformant files parse the same either way. If that rule finds no end, the strict
//   rule (first lone ') applies.
// - \X2\ runs whose length is a multiple of 3 but not 4 are read as 3-digit groups; an \X2\ or \X4\ run left open
//   at the end of the string is closed there; a stray \X0\ is dropped.
// - \N\ and \T\ are a line feed and a tab.
// - A backslash that doesn't start a valid escape is kept literally (Windows paths written unescaped).
// - Line breaks inside a string are dropped: Part 21 line ends are not significant, and writers wrap long lines.
// - Raw bytes ≥ 0x80 are decoded as UTF-8 when valid (edition 3 allows it), and as ISO 8859-1 otherwise.

const QUOTE = 0x27, BACKSLASH = 0x5c, CR = 0x0d, LF = 0x0a, COMMA = 0x2c, RPAREN = 0x29, SLASH = 0x2f, STAR = 0x2a;
const WS = new Uint8Array(256);
for (const c of [0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x0b]) WS[c] = 1;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const pageDecoders = new Map<number, TextDecoder | null>();

/**
 * The offset just past the closing quote of the string literal whose opening quote is at `start`, or -1 if it is
 * unterminated before `limit`.
 */
export function stringEnd(bytes: Uint8Array, start: number, limit = bytes.length): number {
  let firstLone = -1;
  let i = start + 1;
  while (i < limit) {
    const c = bytes[i]!;
    if (c !== QUOTE) { i++; continue; }
    if (bytes[i + 1] === QUOTE && i + 1 < limit) { i += 2; continue; }
    if (firstLone < 0) firstLone = i;
    if (followedByDelimiter(bytes, i + 1, limit)) return i + 1;
    i++;
  }
  return firstLone < 0 ? -1 : firstLone + 1;
}

function followedByDelimiter(bytes: Uint8Array, i: number, limit: number): boolean {
  while (i < limit) {
    const c = bytes[i]!;
    if (WS[c]) { i++; continue; }
    if (c === SLASH && bytes[i + 1] === STAR) {
      i += 2;
      while (i < limit - 1 && !(bytes[i] === STAR && bytes[i + 1] === SLASH)) i++;
      i += 2;
      continue;
    }
    return c === COMMA || c === RPAREN;
  }
  return false;
}

export interface DecodedString {
  value: string;
  /** Offset just past the closing quote. */
  end: number;
}

/** Decode the string literal whose opening quote is at `start`. Returns undefined if it is unterminated. */
export function decodeString(bytes: Uint8Array, start: number, limit = bytes.length): DecodedString | undefined {
  const end = stringEnd(bytes, start, limit);
  if (end < 0) return undefined;
  return { value: decodeStringBody(bytes, start + 1, end - 1), end };
}

/** Decode the text between the quotes, bytes[start, end). */
export function decodeStringBody(bytes: Uint8Array, start: number, end: number): string {
  let i = start;
  // Fast path: printable ASCII without escapes, quotes or line breaks.
  while (i < end) {
    const c = bytes[i]!;
    if (c === QUOTE || c === BACKSLASH || c >= 0x80 || c === CR || c === LF) break;
    i++;
  }
  let out = latin1(bytes, start, i);
  let page = 1;
  while (i < end) {
    const c = bytes[i]!;
    if (c === QUOTE) {
      // '' is one quote; a lone ' (tolerated, see above) is kept as is.
      out += "'";
      i += bytes[i + 1] === QUOTE && i + 1 < end ? 2 : 1;
      continue;
    }
    if (c === CR || c === LF) { i++; continue; }
    if (c >= 0x80) {
      let j = i + 1;
      while (j < end && bytes[j]! >= 0x80) j++;
      try {
        out += utf8.decode(bytes.subarray(i, j));
      } catch {
        out += latin1(bytes, i, j);
      }
      i = j;
      continue;
    }
    if (c === BACKSLASH) {
      const e = escape(bytes, i, end, page);
      if (e) {
        out += e.text;
        if (e.page) page = e.page;
        i = e.end;
        continue;
      }
    }
    out += String.fromCharCode(c);
    i++;
  }
  return out;
}

function escape(
  bytes: Uint8Array, i: number, end: number, page: number,
): { text: string; end: number; page?: number } | undefined {
  const a = i + 1 < end ? bytes[i + 1] : undefined;
  if (a === BACKSLASH) return { text: '\\', end: i + 2 };
  const b = i + 2 < end ? bytes[i + 2] : undefined;
  const third = i + 3 < end && bytes[i + 3] === BACKSLASH;
  if (b === BACKSLASH) {
    if (a === 0x53 /* S */ && i + 3 < end) {
      const c = bytes[i + 3]!;
      return c >= 0x20 && c <= 0x7e ? { text: pageChar(page, c), end: i + 4 } : undefined;
    }
    if (a === 0x58 /* X */) {
      const h = hex(bytes, i + 3, 2, end);
      return h < 0 ? undefined : { text: String.fromCharCode(h), end: i + 5 };
    }
    if (a === 0x4e /* N */) return { text: '\n', end: i + 3 };
    if (a === 0x54 /* T */) return { text: '\t', end: i + 3 };
    return undefined;
  }
  if (a === 0x50 /* P */ && b !== undefined && b >= 0x41 && b <= 0x49 && third) {
    return { text: '', end: i + 4, page: b - 0x40 };
  }
  if (a !== 0x58 /* X */ || !third) return undefined;
  if (b === 0x30 /* 0 */) return { text: '', end: i + 4 }; // stray \X0\
  if (b !== 0x32 /* 2 */ && b !== 0x34 /* 4 */) return undefined;
  // Hex digits up to \X0\ or the end of the string; line breaks inside the run are skipped.
  let digits = '';
  let j = i + 4;
  while (j < end && bytes[j] !== BACKSLASH) {
    const c = bytes[j]!;
    if (c !== CR && c !== LF) digits += String.fromCharCode(c);
    j++;
  }
  let after: number;
  if (j >= end) after = end; // unclosed run
  else if (bytes[j + 1] === 0x58 && bytes[j + 2] === 0x30 && bytes[j + 3] === BACKSLASH && j + 3 < end) after = j + 4;
  else return undefined;
  if (!/^[0-9A-Fa-f]*$/.test(digits)) return undefined;
  let text = '';
  if (b === 0x32) {
    const w = digits.length % 4 === 0 ? 4 : digits.length % 3 === 0 ? 3 : 0;
    if (!w) return undefined;
    for (let k = 0; k < digits.length; k += w) text += String.fromCharCode(parseInt(digits.slice(k, k + w), 16));
  } else {
    if (digits.length % 8 !== 0) return undefined;
    for (let k = 0; k < digits.length; k += 8) {
      const cp = parseInt(digits.slice(k, k + 8), 16);
      if (cp > 0x10ffff) return undefined;
      text += String.fromCodePoint(cp);
    }
  }
  return { text, end: after };
}

/** Upper half of ISO 8859-`part`: character 0x80 + c. */
function pageChar(part: number, c: number): string {
  if (part === 1) return String.fromCharCode(0x80 + c);
  let dec = pageDecoders.get(part);
  if (dec === undefined) {
    try {
      dec = new TextDecoder(`iso-8859-${part}`);
    } catch {
      dec = null; // runtime without that encoding; fall back to 8859-1
    }
    pageDecoders.set(part, dec);
  }
  return dec ? dec.decode(new Uint8Array([0x80 + c])) : String.fromCharCode(0x80 + c);
}

function hex(bytes: Uint8Array, i: number, width: number, end: number): number {
  if (i + width > end) return -1;
  let v = 0;
  for (let k = 0; k < width; k++) {
    const c = bytes[i + k]!;
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else return -1;
    v = v * 16 + d;
  }
  return v;
}

/** Bytes as ISO 8859-1 (each byte is one code point). */
export function latin1(bytes: Uint8Array, start: number, end: number): string {
  if (end - start < 64) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  }
  let s = '';
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  }
  return s;
}
