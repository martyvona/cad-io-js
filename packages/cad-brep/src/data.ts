// BrepData: one part's B-rep as one ArrayBuffer and typed views of its columns (layout.ts). The buffer: MAGIC (4
// bytes), the column count (uint32), then per column its byte offset and its element count (uint32 each), then the
// columns, each 8-byte aligned, in TABLES' order. Little-endian (typed arrays use the platform's order, and every
// platform we run on is little-endian; the builder refuses others).

import { type ColumnType, MAGIC, TABLES, type TableName } from './layout.ts';

type ArrayOf<T extends ColumnType> = T extends 'u8' ? Uint8Array : T extends 'i32' ? Int32Array
  : T extends 'u32' ? Uint32Array : Float64Array;
type Columns<T extends TableName> = { [C in (typeof TABLES)[T][number] as C[0]]: ArrayOf<C[1]> };
export type BrepTables = { [T in TableName]: Columns<T> };

/** A part's B-rep: the buffer, and its columns as views of it (`d.edge.curve[i]`). Read-only by convention. */
export type BrepData = BrepTables & { readonly buffer: ArrayBuffer };

export interface ColumnSpec {
  table: TableName;
  column: string;
  type: ColumnType;
  /** Values per row. */
  width: number;
}

/** Every column, in buffer order. */
export const COLUMNS: readonly ColumnSpec[] = (Object.entries(TABLES) as [TableName, typeof TABLES[TableName]][])
  .flatMap(([table, cols]) => cols.map(([column, type, width]) => ({ table, column, type, width })));

export const BYTES: Record<ColumnType, number> = { u8: 1, i32: 4, u32: 4, f64: 8 };
export const HEADER_BYTES = 8 + 8 * COLUMNS.length;

/** A buffer that isn't one: wrong magic, column count or offsets. A bug of whoever made it, so thrown. */
export class BrepFormatError extends Error {}

/** The number of rows in a table (for `pool`, the length of `curveReal`). */
export function rowCount(d: BrepData, table: TableName): number {
  const [name, , width] = TABLES[table][0]!;
  return (d[table] as Record<string, ArrayLike<number>>)[name]!.length / width;
}

const makeView = (type: ColumnType, buffer: ArrayBuffer, offset: number, count: number) =>
  type === 'u8' ? new Uint8Array(buffer, offset, count)
    : type === 'i32' ? new Int32Array(buffer, offset, count)
      : type === 'u32' ? new Uint32Array(buffer, offset, count) : new Float64Array(buffer, offset, count);

/**
 * Views of a buffer made by BrepBuilder (or a writer following cad_brep.h). Checks the header, not the content
 * (validateBrep). A Uint8Array that isn't its whole buffer is copied first.
 */
export function openBrep(input: ArrayBuffer | Uint8Array): BrepData {
  const buffer = input instanceof ArrayBuffer ? input
    : input.byteLength === input.buffer.byteLength && input.buffer instanceof ArrayBuffer
      ? input.buffer : input.slice().buffer;
  if (buffer.byteLength < HEADER_BYTES) throw new BrepFormatError(`${buffer.byteLength} bytes: too short`);
  const head = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== MAGIC) throw new BrepFormatError(`magic ${JSON.stringify(magic)}, not ${MAGIC}`);
  const n = head.getUint32(4, true);
  if (n !== COLUMNS.length) throw new BrepFormatError(`${n} columns, not ${COLUMNS.length}`);
  const d: Record<string, Record<string, ArrayLike<number>>> = {};
  COLUMNS.forEach((c, k) => {
    const offset = head.getUint32(8 + 8 * k, true), count = head.getUint32(12 + 8 * k, true);
    if (offset % 8 || offset < HEADER_BYTES || offset + count * BYTES[c.type] > buffer.byteLength) {
      throw new BrepFormatError(`${c.table}.${c.column}: ${count} values at byte ${offset} don't fit`);
    }
    if (count % c.width) throw new BrepFormatError(`${c.table}.${c.column}: ${count} values, not rows of ${c.width}`);
    (d[c.table] ??= {})[c.column] = makeView(c.type, buffer, offset, count);
  });
  for (const t of Object.keys(TABLES) as TableName[]) {
    if (t === 'pool') continue;
    const rows = COLUMNS.filter((c) => c.table === t).map((c) => d[t]![c.column]!.length / c.width);
    if (rows.some((r) => r !== rows[0])) throw new BrepFormatError(`${t}: columns of ${rows.join(', ')} rows`);
  }
  if (rowCount(d as unknown as BrepData, 'part') !== 1) throw new BrepFormatError('not one part row');
  return Object.assign(d, { buffer }) as unknown as BrepData;
}
