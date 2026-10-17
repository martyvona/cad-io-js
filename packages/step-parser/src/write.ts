// The Part 21 writer: the raw instance model → Part 21 text, without using the schema. See docs/architecture.md,
// "Part 21 writer".
//
// Output is pure ASCII: strings escape everything outside printable ASCII. It is produced in chunks by a generator,
// so a caller can pump it into any sink (a WritableStream, a Node stream, a file) with backpressure, and the whole
// file is never one string. Instances may also be given as raw bytes, copied verbatim (the subset fast path).

import { ParseError, type EntityRecord, type Instance, type Value } from './model.ts';
import type { StepFile } from './file.ts';
import { Chunker, concatChunks } from './chunks.ts';

export interface StepDocument {
  /** Header entities, written in order: FILE_DESCRIPTION, FILE_NAME, FILE_SCHEMA and any others. */
  header: readonly EntityRecord[];
  /** The DATA sections. More than one, or a named one, is edition 3. None writes an empty DATA section. */
  data: readonly DocumentSection[];
}

export interface DocumentSection {
  /** Edition 3 `DATA('name', ('SCHEMA'));` parameters. Written only when `name` is set. */
  name?: string;
  schemas?: readonly string[];
  /**
   * Instances in output order. A Uint8Array is the complete text of one instance (`#1=...;`, as from
   * `StepFile.sourceBytesAt`), copied as is.
   */
  instances: Iterable<Instance | Uint8Array>;
}

export interface WriteOptions {
  /** Output chunk size in bytes (default 64 KiB). Larger single instances get a chunk of their own. */
  chunkSize?: number;
}

/** A value the writer can't represent in Part 21: NaN, a non-integer int, a malformed name, and so on. */
export class WriteError extends Error {
  readonly id?: number;
  constructor(message: string, id?: number) {
    super(id === undefined ? message : `#${id}: ${message}`);
    this.name = 'WriteError';
    this.id = id;
  }
}

/** Write a document as a sequence of byte chunks. Instances are pulled from their iterables as output is pulled. */
export function* writeChunks(doc: StepDocument, opts: WriteOptions = {}): Generator<Uint8Array> {
  const out = new Chunker(opts.chunkSize);
  let head = 'ISO-10303-21;\nHEADER;\n';
  for (const r of doc.header) head += formatRecord(r) + ';\n';
  yield* out.text(head + 'ENDSEC;\n');
  const sections = doc.data.length ? doc.data : [{ instances: [] }];
  for (const s of sections) {
    yield* out.text(s.name === undefined ? 'DATA;\n' : `DATA(${formatString(s.name)},(${(s.schemas ?? []).map(formatString).join(',')}));\n`);
    for (const item of s.instances) {
      if (item instanceof Uint8Array) {
        yield* out.bytes(item);
        yield* out.text('\n');
      } else {
        yield* out.text(formatInstance(item) + '\n');
      }
    }
    yield* out.text('ENDSEC;\n');
  }
  yield* out.text('END-ISO-10303-21;\n');
  yield* out.flush();
}

/** Write a document as one byte array. */
export function writeStep(doc: StepDocument, opts?: WriteOptions): Uint8Array {
  return concatChunks(writeChunks(doc, opts));
}

/**
 * A document for re-writing a parsed file: its header and DATA sections, with instances decoded lazily as the
 * writer pulls them. Malformed instances are reported to `onError` and omitted.
 */
export function fileDocument(file: StepFile, onError?: (p: number, e: ParseError) => void): StepDocument {
  return {
    header: file.header,
    data: file.dataSections.map((d) => ({
      name: d.name,
      schemas: d.schemas,
      instances: (function* () {
        for (let p = d.first; p < d.last; p++) {
          try {
            yield file.instanceAt(p);
          } catch (e) {
            if (!onError || !(e instanceof ParseError)) throw e;
            onError(p, e);
          }
        }
      })(),
    })),
  };
}

export interface HeaderFields {
  description?: string[];
  implementationLevel?: string;
  name?: string;
  /** ISO 8601; defaults to now. */
  timeStamp?: string;
  author?: string[];
  organization?: string[];
  preprocessorVersion?: string;
  originatingSystem?: string;
  authorization?: string;
  schemas: string[];
}

/** The three mandatory header entities. Unspecified strings are written empty. */
export function makeHeader(f: HeaderFields): EntityRecord[] {
  const str = (v = ''): Value => ({ k: 'str', v });
  const list = (v: string[] = ['']): Value => ({ k: 'list', v: v.map((s) => str(s)) });
  return [
    { type: 'FILE_DESCRIPTION', attrs: [list(f.description), str(f.implementationLevel ?? '2;1')] },
    {
      type: 'FILE_NAME',
      attrs: [
        str(f.name), str(f.timeStamp ?? new Date().toISOString().slice(0, 19)), list(f.author), list(f.organization),
        str(f.preprocessorVersion), str(f.originatingSystem), str(f.authorization),
      ],
    },
    { type: 'FILE_SCHEMA', attrs: [list(f.schemas)] },
  ];
}

/** `#id=TYPE(...);` or `#id=(A(...)B(...));` */
export function formatInstance(inst: Instance): string {
  if (!Number.isSafeInteger(inst.id) || inst.id < 0) throw new WriteError(`invalid instance id ${inst.id}`);
  try {
    if ('parts' in inst) {
      if (inst.parts.length === 0) throw new WriteError('complex instance with no partials');
      let s = `#${inst.id}=(`;
      for (const p of inst.parts) s += formatRecord(p);
      return s + ');';
    }
    return `#${inst.id}=${keyword(inst.type)}(${formatValues(inst.attrs)});`;
  } catch (e) {
    throw e instanceof WriteError && e.id === undefined ? new WriteError(e.message, inst.id) : e;
  }
}

/** `TYPE(...)`, without the `;`. */
export function formatRecord(r: EntityRecord): string {
  return `${keyword(r.type)}(${formatValues(r.attrs)})`;
}

function formatValues(vs: readonly Value[]): string {
  let s = '';
  for (let i = 0; i < vs.length; i++) s += (i ? ',' : '') + formatValue(vs[i]!);
  return s;
}

export function formatValue(v: Value): string {
  switch (v.k) {
    case 'ref': return formatRef(v.v);
    case 'real': return formatReal(v.v);
    case 'str': return formatString(v.v);
    case 'enum':
      if (!ENUM.test(v.v)) throw new WriteError(`invalid enumeration .${v.v}.`);
      return `.${v.v}.`;
    case 'list': return `(${formatValues(v.v)})`;
    case 'reals': {
      let s = '(';
      for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + formatReal(v.v[i]!);
      return s + ')';
    }
    case 'ints': {
      let s = '(';
      for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + formatInt(v.v[i]!);
      return s + ')';
    }
    case 'refs': {
      let s = '(';
      for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + formatRef(v.v[i]!);
      return s + ')';
    }
    case 'unset': return '$';
    case 'derived': return '*';
    case 'int': return formatInt(v.v);
    case 'typed': return `${keyword(v.type)}(${formatValue(v.v)})`;
    case 'bin':
      if (!BIN.test(v.v)) throw new WriteError(`invalid binary "${v.v}"`);
      return `"${v.v}"`;
  }
  throw new WriteError(`unknown value kind ${(v as { k: unknown }).k}`);
}

function formatRef(r: number): string {
  if (!Number.isSafeInteger(r) || r < 0) throw new WriteError(`invalid reference #${r}`);
  return `#${r}`;
}

function formatInt(x: number | bigint): string {
  if (typeof x === 'bigint') return x.toString();
  if (!Number.isInteger(x)) throw new WriteError(`integer value ${x} is not an integer`);
  return Number.isSafeInteger(x) ? String(x) : BigInt(x).toString();
}

const ENUM = /^[A-Za-z0-9_]+$/;
const BIN = /^[0-9A-F]+$/;
const KEYWORD = /^!?[A-Za-z_][A-Za-z0-9_]*$/;
const goodKeywords = new Set<string>();

function keyword(k: string): string {
  if (!goodKeywords.has(k)) {
    if (!KEYWORD.test(k)) throw new WriteError(`invalid entity or type name '${k}'`);
    if (goodKeywords.size < 10000) goodKeywords.add(k);
  }
  return k;
}

/**
 * A real with the decimal point Part 21 requires: the shortest text that reads back as the same double, with `.`
 * added to the mantissa and the exponent written `E`. 5 → `5.`, 1e-7 → `1.E-7`, -0 → `-0.`.
 */
export function formatReal(x: number): string {
  if (!Number.isFinite(x)) throw new WriteError(`real value ${x} can't be written in Part 21`);
  if (x === 0) return Object.is(x, -0) ? '-0.' : '0.';
  const s = String(x);
  const e = s.indexOf('e');
  if (e < 0) return s.includes('.') ? s : s + '.';
  const m = s.slice(0, e);
  const exp = s.charCodeAt(e + 1) === 0x2b /* + */ ? s.slice(e + 2) : s.slice(e + 1);
  return (m.includes('.') ? m : m + '.') + 'E' + exp;
}

/**
 * A string literal: `'` and `\` doubled, printable ASCII as is, other BMP characters (including lone surrogates)
 * as `\X2\hhhh…\X0\` runs, and characters beyond the BMP as `\X4\hhhhhhhh…\X0\` runs.
 */
export function formatString(s: string): string {
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 0x27 || c === 0x5c) break;
  }
  if (i === s.length) return `'${s}'`;
  let out = "'" + s.slice(0, i);
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      out += c === 0x27 ? "''" : c === 0x5c ? '\\\\' : s[i];
      i++;
      continue;
    }
    const wide = (s.codePointAt(i) ?? c) > 0xffff;
    out += wide ? '\\X4\\' : '\\X2\\';
    while (i < s.length) {
      const cp = s.codePointAt(i)!;
      if (cp >= 0x20 && cp <= 0x7e) break;
      if (cp > 0xffff !== wide) break;
      out += cp.toString(16).toUpperCase().padStart(wide ? 8 : 4, '0');
      i += wide ? 2 : 1;
    }
    out += '\\X0\\';
  }
  return out + "'";
}
