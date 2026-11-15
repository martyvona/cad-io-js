// BrepData: one part's B-rep as one ArrayBuffer and typed views of its columns (layout.ts), in the column format
// columns.ts reads and writes.

import { BrepFormatError, BYTES, type ColumnLayout, type ColumnOf, columnsOf, headerBytes, openColumns, tableRows,
  type TablesOf } from './columns.ts';
import { MAGIC, TABLES, type TableName } from './layout.ts';

export type BrepTables = TablesOf<typeof TABLES>;

/** A part's B-rep: the buffer, and its columns as views of it (`d.edge.curve[i]`). Read-only by convention. */
export type BrepData = BrepTables & { readonly buffer: ArrayBuffer };

export type ColumnSpec = ColumnOf<TableName>;

/** The model's format. */
export const MODEL_LAYOUT: ColumnLayout<typeof TABLES> = { magic: MAGIC, tables: TABLES, single: 'part' };

/** Every column, in buffer order. */
export const COLUMNS: readonly ColumnSpec[] = columnsOf(TABLES);

export { BrepFormatError, BYTES };
export const HEADER_BYTES = headerBytes(COLUMNS.length);

/** The number of rows in a table (for `pool`, the length of `curveReal`). */
export function rowCount(d: BrepData, table: TableName): number {
  return tableRows(MODEL_LAYOUT, d as unknown as Record<string, Record<string, ArrayLike<number>>>, table);
}

/**
 * Views of a buffer made by BrepBuilder (or a writer following cad_brep.h). Checks the header, not the content
 * (validateBrep). A Uint8Array that isn't its whole buffer is copied first.
 */
export function openBrep(input: ArrayBuffer | Uint8Array): BrepData {
  return openColumns(MODEL_LAYOUT, input);
}
