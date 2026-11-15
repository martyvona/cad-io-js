// The column format both cad-brep buffers share (the model's, layout.ts; the analysis's, analysis-layout.ts): the
// magic (4 bytes), the column count (uint32), then per column its byte offset and its element count (uint32 each),
// then the columns in the layout's order, each 8-byte aligned, zeros between them. Little-endian (typed arrays use the
// platform's order, and every platform we run on is little-endian; this module refuses others).

import type { ColumnType } from './layout.ts';

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('cad-brep needs a little-endian platform');

export type TableSpecs = Record<string, readonly (readonly [string, ColumnType, number])[]>;

/** A format: its magic, its tables in buffer order, and the table that must have exactly one row. */
export interface ColumnLayout<T extends TableSpecs = TableSpecs> {
  readonly magic: string;
  readonly tables: T;
  readonly single: keyof T & string;
}

export interface ColumnOf<T extends string> {
  table: T;
  column: string;
  type: ColumnType;
  /** Values per row. */
  width: number;
}

export type ArrayOf<T extends ColumnType> = T extends 'u8' ? Uint8Array : T extends 'i32' ? Int32Array
  : T extends 'u32' ? Uint32Array : Float64Array;
/** A layout's tables as typed views: `d.edge.curve`. */
export type TablesOf<T extends TableSpecs> = { [N in keyof T]: { [C in T[N][number] as C[0]]: ArrayOf<C[1]> } };

export const BYTES: Record<ColumnType, number> = { u8: 1, i32: 4, u32: 4, f64: 8 };

/** Every column of a layout's tables, in buffer order. */
export function columnsOf<T extends TableSpecs>(tables: T): ColumnOf<keyof T & string>[] {
  return Object.entries(tables).flatMap(([table, cols]) =>
    cols.map(([column, type, width]) => ({ table: table as keyof T & string, column, type, width })));
}

export const headerBytes = (columns: number) => 8 + 8 * columns;

/** A buffer that isn't one (a model's or an analysis's): wrong magic, column count or offsets. Thrown: a bug of
 * whoever made it. */
export class BrepFormatError extends Error {}

const makeView = (type: ColumnType, buffer: ArrayBuffer, offset: number, count: number) =>
  type === 'u8' ? new Uint8Array(buffer, offset, count)
    : type === 'i32' ? new Int32Array(buffer, offset, count)
      : type === 'u32' ? new Uint32Array(buffer, offset, count) : new Float64Array(buffer, offset, count);

/**
 * Views of a buffer of `layout`, as `{ table: { column: view } }` with the buffer. Checks the header: the magic, the
 * column count, each column inside the buffer past the header, 8-byte aligned and whole rows, the columns of a table
 * (but `pool`, whose arrays are independent) of equal rows, the single table of one row. Not the content. A
 * Uint8Array that isn't its whole buffer is copied first.
 */
export function openColumns<T extends TableSpecs>(layout: ColumnLayout<T>, input: ArrayBuffer | Uint8Array):
  TablesOf<T> & { readonly buffer: ArrayBuffer } {
  const columns = columnsOf(layout.tables), header = headerBytes(columns.length);
  const buffer = input instanceof ArrayBuffer ? input
    : input.byteLength === input.buffer.byteLength && input.buffer instanceof ArrayBuffer
      ? input.buffer : input.slice().buffer;
  if (buffer.byteLength < header) throw new BrepFormatError(`${buffer.byteLength} bytes: too short`);
  const head = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== layout.magic) throw new BrepFormatError(`magic ${JSON.stringify(magic)}, not ${layout.magic}`);
  const n = head.getUint32(4, true);
  if (n !== columns.length) throw new BrepFormatError(`${n} columns, not ${columns.length}`);
  const d: Record<string, Record<string, ArrayLike<number>>> = {};
  columns.forEach((c, k) => {
    const offset = head.getUint32(8 + 8 * k, true), count = head.getUint32(12 + 8 * k, true);
    if (offset % 8 || offset < header || offset + count * BYTES[c.type] > buffer.byteLength) {
      throw new BrepFormatError(`${c.table}.${c.column}: ${count} values at byte ${offset} don't fit`);
    }
    if (count % c.width) throw new BrepFormatError(`${c.table}.${c.column}: ${count} values, not rows of ${c.width}`);
    (d[c.table] ??= {})[c.column] = makeView(c.type, buffer, offset, count);
  });
  for (const t of Object.keys(layout.tables)) {
    if (t === 'pool') continue;
    const rows = columns.filter((c) => c.table === t).map((c) => d[t]![c.column]!.length / c.width);
    if (rows.some((r) => r !== rows[0])) throw new BrepFormatError(`${t}: columns of ${rows.join(', ')} rows`);
  }
  if (tableRows(layout, d, layout.single) !== 1) throw new BrepFormatError(`not one ${layout.single} row`);
  return Object.assign(d, { buffer }) as unknown as TablesOf<T> & { readonly buffer: ArrayBuffer };
}

/** The number of rows in a table of opened or given columns (for `pool`, the length of its first array). */
export function tableRows(layout: { readonly tables: TableSpecs },
  d: Record<string, Record<string, ArrayLike<number>>>, table: string): number {
  const [name, , width] = layout.tables[table]![0]!;
  return d[table]![name]!.length / width;
}

const LIMITS: Record<ColumnType, [number, number]> = { u8: [0, 255], i32: [-(2 ** 31), 2 ** 31 - 1],
  u32: [0, 2 ** 32 - 1], f64: [-Infinity, Infinity] };
const SAME: Record<ColumnType, abstract new (...a: never[]) => unknown> = { u8: Uint8Array, i32: Int32Array,
  u32: Uint32Array, f64: Float64Array };

/**
 * The buffer of `layout` holding each column's values, `values(column)` (an array of the column's type is copied as
 * it is; any other array's values must be numbers the type holds exactly, else RangeError: a caller's bug). The same
 * values give the same bytes. Opening the result is the caller's (it checks rows).
 */
export function writeColumns<T extends TableSpecs>(layout: ColumnLayout<T>,
  values: (c: ColumnOf<keyof T & string>) => ArrayLike<number>): ArrayBuffer {
  const columns = columnsOf(layout.tables);
  const align = (n: number) => (n + 7) & ~7;
  let size = headerBytes(columns.length);
  const placed = columns.map((c) => {
    const xs = values(c), offset = size;
    if (!(xs instanceof SAME[c.type])) {
      const [lo, hi] = LIMITS[c.type];
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i]!;
        if (typeof x !== 'number' || (c.type !== 'f64' && !(Number.isInteger(x) && x >= lo && x <= hi))) {
          throw new RangeError(`${c.table}.${c.column}[${i}] = ${x}: not a ${c.type}`);
        }
      }
    }
    size = align(size + xs.length * BYTES[c.type]);
    return { c, xs, offset };
  });
  if (size > 2 ** 32 - 1) throw new RangeError(`${size} bytes: more than a uint32 offset reaches`);
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer), head = new DataView(buffer);
  for (let k = 0; k < 4; k++) bytes[k] = layout.magic.charCodeAt(k);
  head.setUint32(4, columns.length, true);
  placed.forEach(({ c, xs, offset }, k) => {
    head.setUint32(8 + 8 * k, offset, true);
    head.setUint32(12 + 8 * k, xs.length, true);
    makeView(c.type, buffer, offset, xs.length).set(xs);
  });
  return buffer;
}
