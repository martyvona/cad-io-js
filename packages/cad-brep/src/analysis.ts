// BrepAnalysis: an analysis buffer (analysis-layout.ts) and typed views of its columns, in the column format
// columns.ts reads and writes; tied to one model buffer by that buffer's SHA-256.

import { ANALYSIS_MAGIC, ANALYSIS_TABLES, type AnalysisTableName } from './analysis-layout.ts';
import { BrepFormatError, type ColumnLayout, type ColumnOf, columnsOf, headerBytes, openColumns, tableRows,
  type TablesOf, writeColumns } from './columns.ts';
import { type BrepData, rowCount } from './data.ts';
import type { TableName } from './layout.ts';
import { sha256Words } from './sha256.ts';

export type AnalysisTables = TablesOf<typeof ANALYSIS_TABLES>;

/** An analysis: the buffer, and its columns as views of it (`a.edge.range[2 * i]`). Read-only by convention. */
export type BrepAnalysis = AnalysisTables & { readonly buffer: ArrayBuffer };

export type AnalysisColumnSpec = ColumnOf<AnalysisTableName>;

/** The analysis's format. */
export const ANALYSIS_LAYOUT: ColumnLayout<typeof ANALYSIS_TABLES> = { magic: ANALYSIS_MAGIC,
  tables: ANALYSIS_TABLES, single: 'analysis' };

/** Every column of an analysis, in buffer order. */
export const ANALYSIS_COLUMNS: readonly AnalysisColumnSpec[] = columnsOf(ANALYSIS_TABLES);
export const ANALYSIS_HEADER_BYTES = headerBytes(ANALYSIS_COLUMNS.length);

/** The tables with a row per model row of the same name, or none. */
export const PER_ENTITY = ['vertex', 'edge', 'coedge', 'face', 'surface', 'shell'] as const satisfies
  readonly (AnalysisTableName & TableName)[];

/**
 * An analysis's values, table by table and column by column (`width` values per row, as plain arrays or typed
 * arrays). A table left out is empty; a table given needs every column.
 */
export type AnalysisRows = {
  [T in AnalysisTableName]?: { [C in (typeof ANALYSIS_TABLES)[T][number] as C[0]]: ArrayLike<number> };
};

/** The number of rows in an analysis's table (for `pool`, the length of `real`). */
export function analysisRowCount(a: BrepAnalysis, table: AnalysisTableName): number {
  return tableRows(ANALYSIS_LAYOUT, a as unknown as Record<string, Record<string, ArrayLike<number>>>, table);
}

/** Views of an analysis buffer. Checks the header, as openBrep does, not the content; not which model it's of. */
export function openAnalysis(input: ArrayBuffer | Uint8Array): BrepAnalysis {
  return openColumns(ANALYSIS_LAYOUT, input);
}

/**
 * The analysis buffer of these values, opened. Throws on a column missing from a table given, a value its column's
 * type doesn't hold, or tables openAnalysis would refuse (unequal rows, not one `analysis` row): the caller's bugs.
 */
export function writeAnalysis(rows: AnalysisRows): BrepAnalysis {
  const given = rows as Record<string, Record<string, ArrayLike<number>> | undefined>;
  for (const t of Object.keys(given)) {
    if (!(t in ANALYSIS_TABLES)) throw new Error(`${t}: not an analysis table`);
  }
  const buffer = writeColumns(ANALYSIS_LAYOUT, (c) => {
    const table = given[c.table];
    if (!table) return [];
    const xs = table[c.column];
    if (!xs) throw new Error(`${c.table}.${c.column} not given`);
    return xs;
  });
  return openAnalysis(buffer);
}

/** The model buffer's SHA-256 as `analysis.model` holds it: 8 words, big-endian digest order. */
export function modelHash(model: BrepData): Promise<Uint32Array> {
  return sha256Words(new Uint8Array(model.buffer));
}

/**
 * The analysis, opened if it's a buffer, once it's known to be of this model: its `analysis.model` the model buffer's
 * SHA-256, and each per-entity table empty or of the model's rows. Else a BrepFormatError (whoever paired them has a
 * bug: an analysis of another model, or of this one before an edit or healing).
 */
export async function analysisFor(model: BrepData, analysis: BrepAnalysis | ArrayBuffer | Uint8Array):
  Promise<BrepAnalysis> {
  const a = analysis instanceof ArrayBuffer || analysis instanceof Uint8Array ? openAnalysis(analysis) : analysis;
  const hash = await modelHash(model), said = a.analysis.model;
  if (hash.some((w, i) => w !== said[i])) {
    throw new BrepFormatError('an analysis of another model (its hash isn\'t the model buffer\'s SHA-256)');
  }
  for (const t of PER_ENTITY) {
    const n = analysisRowCount(a, t), m = rowCount(model, t);
    if (n !== 0 && n !== m) throw new BrepFormatError(`analysis ${t}: ${n} rows, the model's ${m}`);
  }
  return a;
}
