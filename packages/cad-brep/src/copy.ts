// Copying a model's rows into a builder, each draw (an item and a similarity) baked as transform.ts says: the builder's
// baking of transformed and instance items, and the scene's of a placement's stretch into a part. Rows a draw reaches
// are copied once per draw (memoized), a 2D curve once per (u, v) map; rows no draw reaches are left out. Ids come from
// the caller (`idOf`): a row's source id, or a fresh one for a copy (BuilderOptions.firstFreshId).

import type { BrepBuilder } from './builder.ts';
import type { BrepData } from './data.ts';
import * as dec from './decode.ts';
import type { Coedge, Curve, Face, Item, Loop, Surface } from './types.ts';
import type { BrepDiagnostic } from './validate.ts';
import { curve2, curve3, NO_MAP, type ParamMap, point, profileOf, type Similarity, surface as surfaceOf } from
  './transform.ts';

/** The tables whose rows a draw copies, as `idOf` names them. */
export type CopiedTable = 'curve' | 'surface' | 'vertex' | 'edge' | 'coedge' | 'loop' | 'face' | 'shell' | 'body';

/** What one draw places: an item's kind and target in the source, at a similarity. */
export interface Draw {
  kind: Item['kind'];
  /** A row of the source's body, curve, surface or face table (by kind). */
  ref?: number;
  /** A point item's point. */
  point?: number[];
  T: Similarity;
  /** The item's id in the copy. */
  id?: number;
}

export type IdOf = (table: CopiedTable, row: number, sourceId: number | undefined) => number | undefined;

/** One draw's copier: rows memoized for the draw, notes appended to `notes`. */
export class Copier {
  private readonly memo = new Map<string, number | null>();
  private readonly surfaces = new Map<number, { row: number; map: ParamMap; sigma: number } | null>();
  /** The source rows this draw reached, `table:row` (a 2D curve once whatever its maps). */
  readonly reached = new Set<string>();
  private readonly src: BrepData;
  private readonly out: BrepBuilder;
  private readonly T: Similarity;
  private readonly idOf: IdOf;
  private readonly notes: BrepDiagnostic[];

  constructor(src: BrepData, out: BrepBuilder, T: Similarity, idOf: IdOf, notes: BrepDiagnostic[]) {
    this.src = src;
    this.out = out;
    this.T = T;
    this.idOf = idOf;
    this.notes = notes;
  }

  private once<R>(key: string, make: () => R | undefined): R | undefined {
    if (this.memo.has(key)) return (this.memo.get(key) ?? undefined) as R | undefined;
    this.memo.set(key, null);
    const r = make();
    this.memo.set(key, (r ?? null) as number | null);
    return r;
  }

  private id(table: CopiedTable, row: number, source: number | undefined) {
    this.reached.add(`${table}:${row}`);
    return this.idOf(table, row, source);
  }

  /** A 3D curve at `T` (a swept surface's profile at its own similarity). */
  curve3(k: number, T = this.T, tag = ''): number | undefined {
    return this.once(`c3${tag}:${k}`, () => {
      const c = dec.curve(this.src, k);
      const refs = this.refs3(c, (j) => this.curve3(j, T, tag));
      if (!refs) return undefined;
      return this.out.addCurve({ ...curve3(T, refs), id: this.id('curve', k, c.id) });
    });
  }

  /** A 2D curve under a (u, v) map; undefined (said) where it has no exact form there. */
  curve2(k: number, map: ParamMap): number | undefined {
    return this.once(`c2:${k}:${map[0]}:${map[1]}`, () => {
      const c = dec.curve(this.src, k);
      const refs = this.refs3(c, (j) => this.curve2(j, map));
      if (!refs) return undefined;
      const m = curve2(map, refs);
      if (typeof m === 'string') {
        this.notes.push({ severity: 'warning', message: `curve${c.id ? ` #${c.id}` : ` ${k}`}: ${m}, left out (its `
          + 'coedges without a p-curve)' });
        return undefined;
      }
      return this.out.addCurve({ ...m, id: this.id('curve', k, c.id) });
    });
  }

  /** A curve with its references copied by `sub`, or undefined if one fails. */
  private refs3(c: Curve, sub: (j: number) => number | undefined): Curve | undefined {
    switch (c.kind) {
      case 'trimmed': case 'offset': {
        const basis = sub(c.basis);
        return basis === undefined ? undefined : { ...c, basis };
      }
      case 'composite': {
        const segments = c.segments.map((s) => ({ ...s, curve: sub(s.curve) }));
        return segments.some((s) => s.curve === undefined) ? undefined
          : { ...c, segments: segments as typeof c.segments };
      }
      default: return c;
    }
  }

  /** A surface, its (u, v) map and sigma; undefined (said) where it can't be baked. */
  surface(k: number): { row: number; map: ParamMap; sigma: number } | undefined {
    if (this.surfaces.has(k)) return this.surfaces.get(k) ?? undefined;
    this.surfaces.set(k, null);
    const x = dec.surface(this.src, k);
    let r: { row: number; map: ParamMap; sigma: number } | undefined;
    const refs = this.surfaceRefs(x);
    if (refs) {
      const baked = surfaceOf(this.T, refs.surface, refs.basis);
      if (!baked) {
        this.notes.push({ severity: 'error', message: `surface${x.id ? ` #${x.id}` : ` ${k}`} (${x.kind}): a swept `
          + 'surface under a mirror (its profile\'s frame changes hands), left out with its faces' });
      } else {
        r = { row: this.out.addSurface({ ...baked.surface, id: this.id('surface', k, x.id) }), map: baked.map,
          sigma: baked.sigma };
      }
    }
    this.surfaces.set(k, r ?? null);
    return r;
  }

  private surfaceRefs(x: Surface): { surface: Surface; basis?: { map: ParamMap; sigma: number } } | undefined {
    switch (x.kind) {
      case 'extrusion': case 'revolution': {
        const curve = this.curve3(x.curve);
        return curve === undefined ? undefined : { surface: { ...x, curve } };
      }
      case 'offset': case 'rectangularTrimmed': {
        const b = this.surface(x.basis);
        return b === undefined ? undefined : { surface: { ...x, basis: b.row }, basis: b };
      }
      case 'curveSwept': case 'fixedReferenceSwept': {
        if (this.T.det < 0) return { surface: x };
        const curve = this.curve3(x.curve, profileOf(this.T), 'profile');
        let directrix: number | undefined, referenceSurface: number | undefined;
        if (x.kind === 'curveSwept') {
          const ref = this.surface(x.referenceSurface);
          if (!ref) return undefined;
          referenceSurface = ref.row;
          directrix = this.src.curve.dim[x.directrix] === 2 ? this.curve2(x.directrix, ref.map)
            : this.curve3(x.directrix);
        } else directrix = this.curve3(x.directrix);
        if (curve === undefined || directrix === undefined) return undefined;
        return { surface: x.kind === 'curveSwept' ? { ...x, curve, directrix, referenceSurface: referenceSurface! }
          : { ...x, curve, directrix } };
      }
      default: return { surface: x };
    }
  }

  vertex(k: number): number {
    return this.once(`v:${k}`, () => {
      const v = dec.vertex(this.src, k), T = this.T;
      return this.out.addVertex({ point: point(T, v.point),
        ...(v.tolerance === undefined ? {} : { tolerance: v.tolerance * T.s }),
        id: this.id('vertex', k, v.id) });
    })!;
  }

  edge(k: number): number {
    return this.once(`e:${k}`, () => {
      const e = dec.edge(this.src, k);
      const curve = e.curve === undefined ? undefined : this.curve3(e.curve);
      return this.out.addEdge({ ...e, ...(curve === undefined ? { curve: undefined } : { curve }),
        ...(e.start === undefined ? {} : { start: this.vertex(e.start) }),
        ...(e.end === undefined ? {} : { end: this.vertex(e.end) }),
        ...(e.tolerance === undefined ? {} : { tolerance: e.tolerance * this.T.s }), id: this.id('edge', k, e.id) });
    })!;
  }

  /** A face; undefined (said) where its surface can't be baked. */
  face(k: number): number | undefined {
    return this.once(`f:${k}`, () => {
      const f = dec.face(this.src, k), s = this.surface(f.surface);
      if (!s) return undefined;
      const mirror = this.T.det < 0;
      const firstLoop = this.src.face.firstLoop[k]!;
      const loops: Loop[] = f.loops.map((l, j) => {
        const id = this.id('loop', firstLoop + j, l.id);
        // (A mirror turns the face's left to its right: the loop runs the other way.)
        const sense = mirror && l.kind !== 'vertex' ? l.sense === false : l.sense !== false;
        if (l.kind === 'vertex') return { ...l, vertex: this.vertex(l.vertex), sense, id };
        if (l.kind === 'poly') return { ...l, vertices: l.vertices.map((v) => this.vertex(v)), sense, id };
        const first = this.src.loop.first[firstLoop + j]!;
        const coedges: Coedge[] = l.coedges.map((c, i) => {
          const pcurve = c.pcurve === undefined ? undefined : this.curve2(c.pcurve, s.map);
          return { ...c, edge: this.edge(c.edge), pcurve, id: this.id('coedge', first + i, c.id) };
        });
        return { ...l, coedges, sense, id };
      });
      const out: Face = { surface: s.row, sameSense: s.sigma < 0 ? !f.sameSense : f.sameSense, loops,
        ...(f.tolerance === undefined ? {} : { tolerance: f.tolerance * this.T.s }), id: this.id('face', k, f.id) };
      return this.out.addFace(out);
    });
  }

  shell(k: number): number {
    return this.once(`sh:${k}`, () => {
      const sh = dec.shell(this.src, k);
      const faces = sh.faces.flatMap((u) => { const face = this.face(u.face); return face === undefined ? []
        : [{ face, sense: u.sense }]; });
      return this.out.addShell({ ...sh, faces, id: this.id('shell', k, sh.id) });
    })!;
  }

  body(k: number): number {
    return this.once(`b:${k}`, () => {
      const b = dec.body(this.src, k);
      const members = b.members.map((m) => ({ ref: b.kind === 'wire' ? this.edge(m.ref) : this.shell(m.ref),
        sense: m.sense }));
      return this.out.addBody({ ...b, members, id: this.id('body', k, b.id) });
    })!;
  }

  /** The draw's item, its target copied; undefined (said) where the target can't be. */
  item(d: Draw): number | undefined {
    const id = d.id === undefined ? {} : { id: d.id };
    switch (d.kind) {
      case 'point': {
        return this.out.addItem({ kind: 'point', point: point(this.T, d.point!), ...id });
      }
      case 'body': return this.out.addItem({ kind: 'body', ref: this.body(d.ref!), ...id });
      case 'curve': {
        const ref = this.src.curve.dim[d.ref!] === 2 ? this.curve2(d.ref!, NO_MAP) : this.curve3(d.ref!);
        return ref === undefined ? undefined : this.out.addItem({ kind: 'curve', ref, ...id });
      }
      case 'surface': {
        const s = this.surface(d.ref!);
        return s === undefined ? undefined : this.out.addItem({ kind: 'surface', ref: s.row, ...id });
      }
      case 'face': {
        const f = this.face(d.ref!);
        return f === undefined ? undefined : this.out.addItem({ kind: 'face', ref: f, ...id });
      }
      default: throw new RangeError(`a draw of kind ${d.kind}`);
    }
  }
}
