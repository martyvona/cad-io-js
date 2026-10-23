// Raw JSON: a lossless JSON form of the raw instance model, for testing, debugging and validation. See
// README.md, "`step2json`: STEP to JSON", and CLAUDE.md, "Decisions" (lexical numbers).
//
// It is lexical JSON (package lexical-json): an integer is written without a point (`5`), a real always with one or
// with an exponent (`5.0`, `1e-7`). Standard JSON.parse merges the two, so load it with readJson. Values:
//
//   real 5.0   int 5   string "x"   $ null   list [...]   reals/ints [1.0,2.5] / [1,2]   refs {"refs":[1,2]}
//   ref {"ref":12}   enum {"enum":"T"}   * {"derived":true}   binary {"bin":"0F"}
//   typed parameter {"type":"LENGTH_MEASURE","value":5.0}
//
// The document names its format, so that other source formats (IGES, JT) can get raw JSON of their own:
//
//   {"format":"cad-io-js raw","version":1,"source":"step",
//    "header":[{"type":"FILE_DESCRIPTION","attrs":[...]}, ...],
//    "data":[{"name":"...","schemas":["..."],"instances":[
//      {"id":1,"type":"CARTESIAN_POINT","attrs":["",[0.0,1.0,2.0]]},
//      {"id":2,"parts":[{"type":"LENGTH_UNIT","attrs":[]}, ...]},
//    ...]}]}
//
// One instance per line; jsonLinesChunks writes the NDJSON form, one JSON value per line. Records may carry their attribute names, `"names":[...]` before `"attrs"`, as an annotation
// (see JsonWriteOptions.names). Keys the loader doesn't know, these included, are ignored in the document, sections,
// instances and records; value objects must match exactly.

import { formatInt, formatReal, formatString, JsonParseError, parseJson, type JsonObject, type JsonValue } from 'lexical-json';
import { Chunker, concatChunks } from './chunks.ts';
import { decodeInstance } from './decode.ts';
import { makeList, type EntityRecord, type Instance, type Value } from './model.ts';
import { WriteError, type StepDocument, type WriteOptions } from './write.ts';

export const RAW_JSON_FORMAT = 'cad-io-js raw';
export const RAW_JSON_VERSION = 1;

/** A document read from raw JSON. It is also a StepDocument, so it can be written as Part 21 directly. */
export interface RawJsonDocument {
  header: EntityRecord[];
  data: { name?: string; schemas?: string[]; instances: Instance[] }[];
}

/** A raw JSON document that is valid JSON but not a valid raw model. */
export class RawJsonError extends Error {
  constructor(message: string, where: string) {
    super(`${where}: ${message}`);
    this.name = 'RawJsonError';
  }
}

/**
 * Write a document as raw JSON, in byte chunks (UTF-8). Instances given as source bytes are decoded first; a
 * malformed one throws its ParseError.
 */
export interface JsonWriteOptions extends WriteOptions {
  /**
   * Attribute names to annotate each instance with, one list per record (see StepModel.attributeNames), written as
   * `"names":[...]` before `"attrs"`. The loader ignores them.
   */
  names?: (inst: Instance) => readonly (readonly string[])[] | undefined;
}

export function* jsonChunks(doc: StepDocument, opts: JsonWriteOptions = {}): Generator<Uint8Array> {
  const out = new Chunker(opts.chunkSize);
  let head = `{"format":${formatString(RAW_JSON_FORMAT)},"version":${RAW_JSON_VERSION},"source":"step",\n"header":[`;
  doc.header.forEach((r, i) => { head += (i ? ',\n' : '\n') + recordJson(r); });
  yield* out.text(head + (doc.header.length ? '\n],\n"data":[' : '],\n"data":['));
  let first = true;
  for (const s of doc.data) {
    const fields = sectionFields(s);
    yield* out.text(`${first ? '\n{' : ',\n{'}${fields}${fields ? ',' : ''}"instances":[`);
    let n = 0;
    for (const item of s.instances) {
      const inst = item instanceof Uint8Array ? decodeInstance(item, 0, item.length) : item;
      yield* out.text((n++ ? ',\n' : '\n') + instanceJson(inst, opts.names?.(inst)));
    }
    yield* out.text(n ? '\n]}' : ']}');
    first = false;
  }
  yield* out.text(first ? ']}\n' : '\n]}\n');
  yield* out.flush();
}

/** Write a document as one raw JSON byte array. */
export function writeJson(doc: StepDocument, opts?: JsonWriteOptions): Uint8Array {
  return concatChunks(jsonChunks(doc, opts));
}

/**
 * Write a document as raw NDJSON: one JSON value per line, so that a reader can take a file of any size line by
 * line. The first line is the envelope with the header (`"layout":"ndjson"`); each DATA section starts with a line
 * `{"data":{"name":...,"schemas":[...]}}` (empty for an unnamed section), followed by its instances, one per line.
 * Values and instances are as in raw JSON.
 */
export function* jsonLinesChunks(doc: StepDocument, opts: JsonWriteOptions = {}): Generator<Uint8Array> {
  const out = new Chunker(opts.chunkSize);
  yield* out.text(`{"format":${formatString(RAW_JSON_FORMAT)},"version":${RAW_JSON_VERSION},"source":"step","layout":"ndjson","header":[${doc.header.map((r) => recordJson(r)).join(',')}]}\n`);
  for (const s of doc.data) {
    yield* out.text(`{"data":{${sectionFields(s)}}}\n`);
    for (const item of s.instances) {
      const inst = item instanceof Uint8Array ? decodeInstance(item, 0, item.length) : item;
      yield* out.text(instanceJson(inst, opts.names?.(inst)) + '\n');
    }
  }
  yield* out.flush();
}

/** Write a document as one raw NDJSON byte array. */
export function writeJsonLines(doc: StepDocument, opts?: JsonWriteOptions): Uint8Array {
  return concatChunks(jsonLinesChunks(doc, opts));
}

function sectionFields(s: { name?: string; schemas?: readonly string[] }): string {
  const f: string[] = [];
  if (s.name !== undefined) f.push(`"name":${formatString(s.name)}`);
  if (s.schemas !== undefined) f.push(`"schemas":[${s.schemas.map(formatString).join(',')}]`);
  return f.join(',');
}

/** `{"id":1,"type":"T","attrs":[...]}` or `{"id":1,"parts":[...]}` */
export function instanceJson(inst: Instance, names?: readonly (readonly string[])[]): string {
  if (!Number.isSafeInteger(inst.id) || inst.id < 0) throw new WriteError(`invalid instance id ${inst.id}`);
  try {
    if ('parts' in inst) return `{"id":${inst.id},"parts":[${inst.parts.map((r, i) => recordJson(r, names?.[i])).join(',')}]}`;
    return `{"id":${inst.id},${recordJson(inst, names?.[0]).slice(1)}`;
  } catch (e) {
    throw e instanceof WriteError && e.id === undefined ? new WriteError(e.message, inst.id) : e;
  }
}

/** `{"type":"T","attrs":[...]}`, or with `"names":[...]` before `"attrs"`. */
export function recordJson(r: EntityRecord, names?: readonly string[]): string {
  const n = names ? `"names":[${names.map(formatString).join(',')}],` : '';
  return `{"type":${formatString(r.type)},${n}"attrs":${valuesJson(r.attrs)}}`;
}

function valuesJson(vs: readonly Value[]): string {
  let s = '[';
  for (let i = 0; i < vs.length; i++) s += (i ? ',' : '') + valueJson(vs[i]!);
  return s + ']';
}

/** One value as raw JSON. */
export function valueJson(v: Value): string {
  try {
    switch (v.k) {
      case 'real': return formatReal(v.v);
      case 'ref': return `{"ref":${ref(v.v)}}`;
      case 'str': return formatString(v.v);
      case 'list': return valuesJson(v.v);
      case 'reals': {
        let s = '[';
        for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + formatReal(v.v[i]!);
        return s + ']';
      }
      case 'ints': {
        let s = '[';
        for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + formatInt(v.v[i]!);
        return s + ']';
      }
      case 'refs': {
        let s = '{"refs":[';
        for (let i = 0; i < v.v.length; i++) s += (i ? ',' : '') + ref(v.v[i]!);
        return s + ']}';
      }
      case 'int': return formatInt(v.v);
      case 'enum': return `{"enum":${formatString(v.v)}}`;
      case 'unset': return 'null';
      case 'derived': return '{"derived":true}';
      case 'typed': return `{"type":${formatString(v.type)},"value":${valueJson(v.v)}}`;
      case 'bin': return `{"bin":${formatString(v.v)}}`;
    }
  } catch (e) {
    throw e instanceof RangeError ? new WriteError(e.message) : e;
  }
  throw new WriteError(`unknown value kind ${(v as { k: unknown }).k}`);
}

function ref(r: number): string {
  if (!Number.isSafeInteger(r) || r < 0) throw new WriteError(`invalid reference #${r}`);
  return String(r);
}

/**
 * Read a raw JSON document (UTF-8 bytes or a string). Throws JsonParseError for invalid JSON and RawJsonError for
 * JSON that isn't a raw document. Lists come back canonical (see makeList).
 */
export function readJson(input: Uint8Array | string): RawJsonDocument {
  const top = envelope(parseJson(input), 'document');
  if (top.layout !== undefined) throw new RawJsonError(`layout ${JSON.stringify(top.layout)}: read it with readJsonLines`, 'document');
  const header = array(top.header, 'header').map((r, i) => recordFromJson(r, `header[${i}]`));
  const data = array(top.data, 'data').map((s, i) => {
    const where = `data[${i}]`;
    const o = object(s, where);
    const section = sectionFromJson(o, where);
    section.instances = array(o.instances, `${where}.instances`).map((x, k) => instanceFromJson(x, `${where}.instances[${k}]`));
    return section;
  });
  return { header, data };
}

/** Read raw NDJSON (see jsonLinesChunks), from UTF-8 bytes or a string. Errors name the line. */
export function readJsonLines(input: Uint8Array | string): RawJsonDocument {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const doc: RawJsonDocument = { header: [], data: [] };
  let line = 0, seenEnvelope = false;
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    line++;
    const text = bytes.subarray(start, end > start && bytes[end - 1] === 0x0d ? end - 1 : end);
    start = end + 1;
    if (text.every((c) => c === 0x20 || c === 0x09)) continue;
    const where = `line ${line}`;
    let j: JsonValue;
    try {
      j = parseJson(text);
    } catch (e) {
      throw e instanceof JsonParseError ? new RawJsonError(e.message, where) : e;
    }
    if (!seenEnvelope) {
      const top = envelope(j, where);
      if (top.layout !== 'ndjson') throw new RawJsonError('the first line is not an NDJSON envelope ("layout":"ndjson")', where);
      doc.header = array(top.header, `${where}.header`).map((r, i) => recordFromJson(r, `${where}.header[${i}]`));
      seenEnvelope = true;
      continue;
    }
    const o = object(j, where);
    if (o.data !== undefined) {
      doc.data.push(sectionFromJson(object(o.data, `${where}.data`), `${where}.data`));
      continue;
    }
    const section = doc.data.at(-1);
    if (!section) throw new RawJsonError('an instance before any {"data":...} line', where);
    section.instances.push(instanceFromJson(o, where));
  }
  if (!seenEnvelope) throw new RawJsonError('empty input', 'line 1');
  return doc;
}

function envelope(j: JsonValue, where: string): JsonObject {
  const top = object(j, where);
  if (top.format !== RAW_JSON_FORMAT) throw new RawJsonError(`format is not ${JSON.stringify(RAW_JSON_FORMAT)}`, where);
  if (top.version !== BigInt(RAW_JSON_VERSION)) throw new RawJsonError(`unsupported version ${String(top.version)}`, where);
  if (top.source !== 'step') throw new RawJsonError(`source is ${JSON.stringify(top.source)}, not "step"`, where);
  return top;
}

function sectionFromJson(o: JsonObject, where: string): RawJsonDocument['data'][number] {
  const section: RawJsonDocument['data'][number] = { instances: [] };
  if (o.name !== undefined) section.name = string(o.name, `${where}.name`);
  if (o.schemas !== undefined) section.schemas = array(o.schemas, `${where}.schemas`).map((x, k) => string(x, `${where}.schemas[${k}]`));
  return section;
}

/** An instance from its raw JSON object. */
export function instanceFromJson(j: JsonValue, where = 'instance'): Instance {
  const o = object(j, where);
  if (typeof o.id !== 'bigint' || o.id < 0n || o.id > BigInt(Number.MAX_SAFE_INTEGER)) throw new RawJsonError('id is not a non-negative integer', where);
  const id = Number(o.id);
  where += ` (#${id})`;
  if (o.parts !== undefined) {
    if (o.type !== undefined || o.attrs !== undefined) throw new RawJsonError('both parts and type/attrs', where);
    const parts = array(o.parts, `${where}.parts`).map((p, i) => recordFromJson(p, `${where}.parts[${i}]`));
    if (parts.length === 0) throw new RawJsonError('complex instance with no parts', where);
    return { id, parts };
  }
  const r = recordFromJson(o, where);
  return { id, type: r.type, attrs: r.attrs };
}

function recordFromJson(j: JsonValue, where: string): EntityRecord {
  const o = object(j, where);
  return {
    type: string(o.type, `${where}.type`),
    attrs: array(o.attrs, `${where}.attrs`).map((v, i) => valueFromJson(v, `${where}.attrs[${i}]`)),
  };
}

/** A value from its raw JSON form. */
export function valueFromJson(j: JsonValue, where = 'value'): Value {
  switch (typeof j) {
    case 'number': return { k: 'real', v: j };
    case 'bigint': return { k: 'int', v: safe(j) ? Number(j) : j };
    case 'string': return { k: 'str', v: j };
    case 'boolean': throw new RawJsonError(`${j} is not a raw value (logicals are {"enum":"T"})`, where);
  }
  if (j === null) return { k: 'unset' };
  if (Array.isArray(j)) return makeList(j.map((x, i) => valueFromJson(x, `${where}[${i}]`)));
  const keys = Object.keys(j);
  const only = (...ks: string[]) => {
    if (keys.length !== ks.length || !ks.every((k) => k in j)) throw new RawJsonError(`not a raw value: ${JSON.stringify(keys)}`, where);
  };
  if ('ref' in j) { only('ref'); return { k: 'ref', v: refFromJson(j.ref!, where) }; }
  if ('refs' in j) {
    only('refs');
    return makeList(array(j.refs, where).map((r, i) => ({ k: 'ref', v: refFromJson(r, `${where}[${i}]`) })));
  }
  if ('enum' in j) { only('enum'); return { k: 'enum', v: string(j.enum, where) }; }
  if ('derived' in j) {
    only('derived');
    if (j.derived !== true) throw new RawJsonError('derived must be true', where);
    return { k: 'derived' };
  }
  if ('bin' in j) { only('bin'); return { k: 'bin', v: string(j.bin, where) }; }
  if ('type' in j) { only('type', 'value'); return { k: 'typed', type: string(j.type, where), v: valueFromJson(j.value!, where) }; }
  throw new RawJsonError(`not a raw value: ${JSON.stringify(keys)}`, where);
}

const safe = (x: bigint) => x >= BigInt(Number.MIN_SAFE_INTEGER) && x <= BigInt(Number.MAX_SAFE_INTEGER);

function refFromJson(j: JsonValue, where: string): number {
  if (typeof j !== 'bigint' || j < 0n || !safe(j)) throw new RawJsonError('reference is not a non-negative integer', where);
  return Number(j);
}

function object(j: JsonValue | undefined, where: string): JsonObject {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new RawJsonError('expected an object', where);
  return j;
}

function array(j: JsonValue | undefined, where: string): JsonValue[] {
  if (!Array.isArray(j)) throw new RawJsonError('expected an array', where);
  return j;
}

function string(j: JsonValue | undefined, where: string): string {
  if (typeof j !== 'string') throw new RawJsonError('expected a string', where);
  return j;
}

