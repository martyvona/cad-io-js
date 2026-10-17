// The parsed file: the pass-1 index plus lazy, on-demand decoding of instances and the header.

import { decodeInstance, decodeList, decodeRecord } from './decode.ts';
import { ParseError, type Diagnostic, type EntityRecord, type Instance, type Value } from './model.ts';
import { scan, type InstanceIndex, type Section } from './scan.ts';
import { latin1 } from './strings.ts';

export interface DataSection {
  /** Edition 3 `DATA('name', ('SCHEMA'));` parameters, when present. */
  name?: string;
  schemas?: string[];
  /** Instance positions [first, last) in the index. */
  first: number;
  last: number;
}

export class StepFile {
  readonly bytes: Uint8Array;
  readonly index: InstanceIndex;
  readonly sections: readonly Section[];
  /** Diagnostics from pass 1 and from header decoding. Instance decoding errors are thrown, not recorded. */
  readonly diagnostics: Diagnostic[];
  /** Header entities in file order: FILE_DESCRIPTION, FILE_NAME, FILE_SCHEMA and any others. */
  readonly header: readonly EntityRecord[];
  readonly dataSections: readonly DataSection[];

  constructor(bytes: Uint8Array) {
    const r = scan(bytes);
    this.bytes = bytes;
    this.index = r.index;
    this.sections = r.sections;
    this.diagnostics = r.diagnostics;
    const header: EntityRecord[] = [];
    for (const h of r.header) {
      try {
        header.push(decodeRecord(bytes, h.start, h.end, this.diagnostics));
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.diagnostics.push({ severity: 'error', message: `header entity: ${e.message}`, offset: e.offset });
      }
    }
    this.header = header;
    const data: DataSection[] = [];
    for (const s of r.sections) {
      if (s.kind !== 'data') continue;
      const d: DataSection = { first: s.first!, last: s.last! };
      if (s.params) {
        try {
          const [name, schemas] = decodeList(bytes, s.params.start, s.params.end);
          if (name?.k === 'str') d.name = name.v;
          if (schemas?.k === 'list') d.schemas = schemas.v.flatMap((v) => (v.k === 'str' ? [v.v] : []));
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.diagnostics.push({ severity: 'warning', message: `DATA section parameters: ${e.message}`, offset: e.offset });
        }
      }
      data.push(d);
    }
    this.dataSections = data;
    if (data.length > 1) this.diagnostics.push({ severity: 'info', message: `${data.length} DATA sections (edition 3)` });
    for (const s of r.sections) {
      if (s.kind === 'anchor' || s.kind === 'reference' || s.kind === 'signature') {
        this.diagnostics.push({ severity: 'warning', message: `${s.kind.toUpperCase()} section ignored`, offset: s.start });
      }
    }
  }

  /** A header entity by type, e.g. 'FILE_SCHEMA'. */
  headerEntity(type: string): EntityRecord | undefined {
    return this.header.find((h) => h.type === type);
  }

  /** The schema names listed in FILE_SCHEMA, e.g. ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']. */
  get schemaNames(): string[] {
    const list = this.headerEntity('FILE_SCHEMA')?.attrs[0];
    return list?.k === 'list' ? list.v.flatMap((v: Value) => (v.k === 'str' ? [v.v] : [])) : [];
  }

  get count(): number {
    return this.index.count;
  }

  /**
   * Decode the instance with this id. Undefined if there is none; throws ParseError if it is malformed.
   * Recoverable problems are appended to `warnings`.
   */
  instance(id: number, warnings?: Diagnostic[]): Instance | undefined {
    const p = this.index.position(id);
    return p < 0 ? undefined : this.instanceAt(p, warnings);
  }

  /** Decode the instance at index position p. Throws ParseError if it is malformed. */
  instanceAt(p: number, warnings?: Diagnostic[]): Instance {
    return decodeInstance(this.bytes, this.index.starts[p]!, this.index.ends[p]!, warnings);
  }

  /** The source text of the instance at position p, as written. */
  sourceAt(p: number): string {
    return latin1(this.bytes, this.index.starts[p]!, this.index.ends[p]!);
  }

  /**
   * Decode every instance in file order. Malformed instances are reported to `onError` and omitted. Recoverable
   * problems are appended to `warnings`.
   */
  *instances(onError?: (p: number, e: ParseError) => void, warnings?: Diagnostic[]): Generator<Instance> {
    for (let p = 0; p < this.index.count; p++) {
      let inst: Instance;
      try {
        inst = this.instanceAt(p, warnings);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        onError?.(p, e);
        continue;
      }
      yield inst;
    }
  }
}

/** Parse a Part 21 file from bytes. Only pass 1 runs here; instances decode on demand. */
export function parseStep(bytes: Uint8Array): StepFile {
  return new StepFile(bytes);
}
