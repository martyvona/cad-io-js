// ModelEdit: a copy of a model with some values changed and 2D curve rows appended, written as a new buffer
// (cad-brep's writeBrep). Columns are copied when first changed; rows are only ever appended to the curve table and
// its pools, so every other row keeps its index (the analysis buffer's rows stay the model's).

import { type BrepData, type ColumnSpec, CURVE_KIND, rowCount, writeBrep } from 'cad-brep';

type Table = 'vertex' | 'edge' | 'coedge';

/** A 2D curve in the model's form (layout.ts's CURVE_LAYOUTS): its kind, reals and ints. */
export interface Curve2 {
  kind: number;
  reals: ArrayLike<number>;
  ints: ArrayLike<number>;
}

export class ModelEdit {
  private readonly changed = new Map<string, Float64Array | Int32Array | Uint8Array | Uint32Array>();
  private readonly added: Curve2[] = [];
  private readonly curves: number;
  readonly model: BrepData;

  constructor(model: BrepData) {
    this.model = model;
    this.curves = rowCount(model, 'curve');
  }

  /** Whether anything was changed or added. */
  get edited(): boolean {
    return this.changed.size > 0 || this.added.length > 0;
  }

  private column(table: Table, column: string) {
    const key = `${table}.${column}`;
    let c = this.changed.get(key);
    if (!c) {
      const v = (this.model as unknown as Record<string, Record<string, Float64Array | Int32Array>>)[table]![column]!;
      c = v.slice();
      this.changed.set(key, c);
    }
    return c;
  }

  /** The value as it stands now (changed or the model's). */
  get(table: Table, column: string, i: number): number {
    const c = this.changed.get(`${table}.${column}`);
    return (c ?? (this.model as unknown as Record<string, Record<string, ArrayLike<number>>>)[table]![column]!)[i]!;
  }

  set(table: Table, column: string, i: number, value: number): void {
    this.column(table, column)[i] = value;
  }

  /** Appends a 2D curve row (id 0: none), returning its index. Its references (a trimmed or composite curve's) must
   * be to earlier rows. */
  addCurve2(c: Curve2): number {
    if (!Object.values(CURVE_KIND).includes(c.kind as never)) throw new Error(`cad-heal: no curve kind ${c.kind}`);
    this.added.push(c);
    return this.curves + this.added.length - 1;
  }

  /** The edited model. */
  finish(): BrepData {
    if (!this.edited) return this.model;
    const m = this.model;
    let real = m.pool.curveReal.length, int = m.pool.curveInt.length;
    const kind: number[] = [], dim: number[] = [], realAt: number[] = [], intAt: number[] = [], id: number[] = [];
    const reals: number[] = [], ints: number[] = [];
    for (const c of this.added) {
      kind.push(c.kind), dim.push(2), realAt.push(real), intAt.push(int), id.push(0);
      for (let i = 0; i < c.reals.length; i++) reals.push(c.reals[i]!);
      for (let i = 0; i < c.ints.length; i++) ints.push(c.ints[i]!);
      real += c.reals.length, int += c.ints.length;
    }
    const appended: Record<string, number[]> = { 'curve.kind': kind, 'curve.dim': dim, 'curve.real': realAt,
      'curve.int': intAt, 'curve.id': id, 'pool.curveReal': reals, 'pool.curveInt': ints };
    return writeBrep((c: ColumnSpec) => {
      const key = `${c.table}.${c.column}`;
      const own = this.changed.get(key) ??
        (m as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!;
      const more = appended[key];
      if (!more?.length) return own;
      const out = new Float64Array(own.length + more.length);
      out.set(own as ArrayLike<number>), out.set(more, own.length);
      return out;
    });
  }
}
