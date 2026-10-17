// Pass 1: a single fast scan over the bytes that finds the sections, the header entities and every instance's
// byte range, id, type name and outgoing references, without decoding any values. Results go into typed arrays.

import type { Diagnostic } from './model.ts';
import { stringEnd } from './strings.ts';

export type SectionKind = 'header' | 'data' | 'anchor' | 'reference' | 'signature';

export interface Section {
  kind: SectionKind;
  /** Byte range from the section keyword to the end of its ENDSEC; */
  start: number;
  end: number;
  /** DATA sections (edition 3): byte range of the parameter list in `DATA(...);`, if present. */
  params?: { start: number; end: number };
  /** DATA sections: the range of instance positions [first, last) in the index. */
  first?: number;
  last?: number;
}

export interface ScanResult {
  index: InstanceIndex;
  /** Byte ranges of the header entities (FILE_DESCRIPTION(...); and so on), each ending after its `;`. */
  header: { start: number; end: number }[];
  sections: Section[];
  diagnostics: Diagnostic[];
}

/**
 * The instance index: parallel typed arrays in file order. Position `p` (0 ≤ p < count) identifies an instance.
 */
export class InstanceIndex {
  readonly count: number;
  readonly ids: Uint32Array;
  /** Byte offset of the instance's `#`. */
  readonly starts: Uint32Array;
  /** Byte offset just past the instance's `;`. */
  readonly ends: Uint32Array;
  /** Index into typeNames, or -1 for a complex instance. */
  readonly types: Int32Array;
  /** Interned, uppercase entity type names of simple instances. */
  readonly typeNames: readonly string[];
  /** The references of instance p are refs[refStarts[p] .. refStarts[p + 1]), in textual order, with repeats. */
  readonly refStarts: Uint32Array;
  readonly refs: Uint32Array;

  private dense?: Int32Array;
  private sorted?: Uint32Array; // positions ordered by id, when ids aren't increasing in file order
  private increasing = false;

  constructor(
    count: number, ids: Uint32Array, starts: Uint32Array, ends: Uint32Array, types: Int32Array, typeNames: string[],
    refStarts: Uint32Array, refs: Uint32Array,
  ) {
    this.count = count;
    this.ids = ids;
    this.starts = starts;
    this.ends = ends;
    this.types = types;
    this.typeNames = typeNames;
    this.refStarts = refStarts;
    this.refs = refs;
    this.buildLookup();
  }

  /** The position of the instance with this id, or -1. With duplicate ids, the first in file order. */
  position(id: number): number {
    if (this.dense) return id < this.dense.length ? this.dense[id]! : -1;
    const ids = this.ids;
    const perm = this.sorted;
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = ids[perm ? perm[mid]! : mid]!;
      if (v < id) lo = mid + 1;
      else if (v > id) hi = mid - 1;
      else {
        // Step back over duplicates to the first one.
        let m = mid;
        while (m > 0 && ids[perm ? perm[m - 1]! : m - 1] === id) m--;
        return perm ? perm[m]! : m;
      }
    }
    return -1;
  }

  /** The type name of a simple instance, or undefined for a complex one. */
  typeName(p: number): string | undefined {
    const t = this.types[p]!;
    return t < 0 ? undefined : this.typeNames[t];
  }

  refsOf(p: number): Uint32Array {
    return this.refs.subarray(this.refStarts[p]!, this.refStarts[p + 1]!);
  }

  /** Ids that occur more than once, in file order of their second occurrence. */
  duplicateIds(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.count; p++) if (this.position(this.ids[p]!) !== p) out.push(this.ids[p]!);
    return out;
  }

  private buildLookup(): void {
    const n = this.count;
    const ids = this.ids;
    let maxId = 0;
    let increasing = true;
    for (let p = 0; p < n; p++) {
      const id = ids[p]!;
      if (id > maxId) maxId = id;
      if (p > 0 && id <= ids[p - 1]!) increasing = false;
    }
    // A direct table when ids are reasonably dense; otherwise binary search.
    if (maxId <= 4 * n + 1024) {
      const dense = new Int32Array(maxId + 1).fill(-1);
      for (let p = n - 1; p >= 0; p--) dense[ids[p]!] = p;
      this.dense = dense;
    } else if (!increasing) {
      const perm = new Uint32Array(n);
      for (let p = 0; p < n; p++) perm[p] = p;
      perm.sort((a, b) => ids[a]! - ids[b]! || a - b);
      this.sorted = perm;
    }
    this.increasing = increasing;
  }

  /** Whether ids increase strictly in file order (common, not required). */
  get idsIncreasing(): boolean {
    return this.increasing;
  }
}

// Byte constants.
const HASH = 0x23, LPAREN = 0x28, RPAREN = 0x29, SEMI = 0x3b, EQUALS = 0x3d, QUOTE = 0x27, SLASH = 0x2f;
const STAR = 0x2a, BANG = 0x21;

const WS = new Uint8Array(256);
for (const c of [0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x0b]) WS[c] = 1;
// Keyword characters: letters, digits, '_' and '-' (the '-' only matters for ISO-10303-21 / END-ISO-10303-21).
const KW = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) KW[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) KW[c] = KW[c + 0x20] = 1;
KW[0x5f] = 1;
const KW_SECTION = KW.slice();
KW_SECTION[0x2d] = 1;

class Grow {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(Math.max(cap, 16));
  }
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

export function scan(bytes: Uint8Array): ScanResult {
  const n = bytes.length;
  if (n > 0xffffffff) throw new Error('inputs over 4 GiB are not supported');
  const diagnostics: Diagnostic[] = [];
  const header: { start: number; end: number }[] = [];
  const sections: Section[] = [];

  const est = (n / 80) | 0;
  const ids = new Grow(est), starts = new Grow(est), ends = new Grow(est), types = new Grow(est);
  const refStarts = new Grow(est + 1), refs = new Grow(est * 4);
  const typeMap = new Map<string, number>();
  const typeNames: string[] = [];

  let state: 'start' | 'between' | SectionKind | 'end' = 'start';
  let current: Section | undefined;
  let sawMagic = false;
  const diag = (severity: Diagnostic['severity'], message: string, offset: number) =>
    diagnostics.push({ severity, message, offset });

  /** Skip whitespace and comments. */
  const skip = (i: number): number => {
    while (i < n) {
      const c = bytes[i]!;
      if (WS[c]) { i++; continue; }
      if (c === SLASH && bytes[i + 1] === STAR) {
        const j = findCommentEnd(bytes, i + 2);
        if (j < 0) { diag('error', 'unterminated comment', i); return n; }
        i = j;
        continue;
      }
      break;
    }
    return i;
  };

  /**
   * Scan to the `;` that ends a statement, at parenthesis depth 0 and outside strings and comments. Collects
   * references when `collect` is set. Returns the offset just past the `;`, or n.
   */
  const statementEnd = (i: number, collect: boolean): number => {
    let depth = 0;
    while (i < n) {
      const c = bytes[i]!;
      if (c === QUOTE) {
        const j = stringEnd(bytes, i, n);
        if (j < 0) { diag('error', 'unterminated string', i); return n; }
        i = j;
        continue;
      }
      if (c === HASH && collect) {
        let j = i + 1;
        let v = 0;
        while (j < n) {
          const d = bytes[j]! - 0x30;
          if (d < 0 || d > 9) break;
          v = v * 10 + d;
          j++;
        }
        // Ids are at most 2^32 - 1, so a larger reference can't resolve (and mustn't wrap around in Uint32Array).
        if (j > i + 1 && v <= 0xffffffff) refs.push(v);
        i = j;
        continue;
      }
      if (c === LPAREN) depth++;
      else if (c === RPAREN) depth--;
      else if (c === SEMI && depth <= 0) return i + 1;
      else if (c === SLASH && bytes[i + 1] === STAR) {
        const j = findCommentEnd(bytes, i + 2);
        if (j < 0) { diag('error', 'unterminated comment', i); return n; }
        i = j;
        continue;
      }
      i++;
    }
    diag('error', 'missing ; at end of input', n);
    return n;
  };

  const instance = (start: number): number => {
    let i = start + 1;
    let id = 0;
    const digits = i;
    while (i < n) {
      const d = bytes[i]! - 0x30;
      if (d < 0 || d > 9) break;
      id = id * 10 + d;
      i++;
    }
    if (i === digits || id > 0xffffffff) {
      diag('error', i === digits ? 'expected an instance id after #' : 'instance id too large', start);
      return statementEnd(i, false);
    }
    i = skip(i);
    if (bytes[i] !== EQUALS) {
      diag('error', `expected = after #${id}`, i);
      return statementEnd(i, false);
    }
    i = skip(i + 1);
    let type = -1;
    if (bytes[i] !== LPAREN) {
      const k = i;
      if (bytes[i] === BANG) i++;
      while (i < n && KW[bytes[i]!]) i++;
      if (i === k) {
        diag('error', `expected an entity type in #${id}`, i);
        return statementEnd(i, false);
      }
      let name = '';
      for (let j = k; j < i; j++) name += String.fromCharCode(bytes[j]!);
      let t = typeMap.get(name);
      if (t === undefined) {
        const upper = name.toUpperCase();
        t = typeMap.get(upper);
        if (t === undefined) {
          t = typeNames.length;
          typeNames.push(upper);
          typeMap.set(upper, t);
        }
        typeMap.set(name, t);
      }
      type = t;
    }
    refStarts.push(refs.n);
    const end = statementEnd(i, true);
    ids.push(id);
    starts.push(start);
    ends.push(end);
    types.push(type);
    return end;
  };

  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  scanLoop: while (true) {
    i = skip(i);
    if (i >= n) break;
    const c = bytes[i]!;
    if (c === HASH && state === 'data') {
      i = instance(i);
      continue;
    }
    const skipped = state === 'anchor' || state === 'reference' || state === 'signature';
    if (skipped && !(c === 0x45 || c === 0x65) /* not ENDSEC */) {
      i = statementEnd(i, false);
      continue;
    }
    if (!KW_SECTION[c]) {
      diag('error', `unexpected character '${String.fromCharCode(c)}'`, i);
      i = statementEnd(i, false);
      continue;
    }
    let j = i;
    while (j < n && KW_SECTION[bytes[j]!]) j++;
    let kw = '';
    for (let k = i; k < j; k++) kw += String.fromCharCode(bytes[k]!);
    kw = kw.toUpperCase();
    switch (kw) {
      case 'ISO-10303-21':
        sawMagic = true;
        i = statementEnd(j, false);
        break;
      case 'HEADER':
      case 'DATA':
      case 'ANCHOR':
      case 'REFERENCE':
      case 'SIGNATURE': {
        if (state !== 'start' && state !== 'between') diag('error', `${kw} inside an unterminated section`, i);
        const kind = kw.toLowerCase() as SectionKind;
        current = { kind, start: i, end: n };
        let k = skip(j);
        if (kind === 'data') {
          current.first = ids.n;
          if (bytes[k] === LPAREN) {
            const p = k;
            k = statementEnd(k, false);
            current.params = { start: p, end: k - 1 };
          } else {
            k = statementEnd(k, false);
          }
        } else {
          k = statementEnd(k, false);
        }
        sections.push(current);
        state = kind;
        i = k;
        break;
      }
      case 'ENDSEC':
        i = statementEnd(j, false);
        if (current) {
          current.end = i;
          if (current.kind === 'data') current.last = ids.n;
        } else {
          diag('error', 'ENDSEC outside a section', j);
        }
        current = undefined;
        state = 'between';
        break;
      case 'END-ISO-10303-21':
        state = 'end';
        break scanLoop;
      default: {
        const end = statementEnd(j, false);
        if (state === 'header') header.push({ start: i, end });
        else if (state !== 'anchor' && state !== 'reference' && state !== 'signature') {
          diag('error', `unexpected '${kw}' outside the HEADER section`, i);
        }
        i = end;
      }
    }
  }

  if (!sawMagic) diag('warning', 'missing ISO-10303-21; at start', 0);
  if (current) {
    diag('error', `${current.kind.toUpperCase()} section not closed by ENDSEC`, n);
    if (current.kind === 'data') current.last = ids.n;
  }
  if (state !== 'end') diag('warning', 'missing END-ISO-10303-21;', n);
  if (!sections.some((s) => s.kind === 'data')) diag('error', 'no DATA section', n);
  refStarts.push(refs.n);

  const index = new InstanceIndex(
    ids.n, ids.done(), starts.done(), ends.done(), new Int32Array(types.done().buffer), typeNames,
    refStarts.done(), refs.done(),
  );
  for (const id of index.duplicateIds()) diagnostics.push({ severity: 'error', message: `duplicate instance id #${id}`, id });
  return { index, header, sections, diagnostics };
}

/** Returns the offset after the closing star-slash, or -1. */
function findCommentEnd(bytes: Uint8Array, i: number): number {
  const n = bytes.length;
  for (; i < n - 1; i++) if (bytes[i] === STAR && bytes[i + 1] === SLASH) return i + 2;
  return -1;
}
