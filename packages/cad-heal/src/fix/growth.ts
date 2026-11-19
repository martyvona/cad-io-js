// The tolerances a part's healing grew, reported as one diagnostic per part (docs/own-tessellator.md, how far healing
// grows a tolerance): each growth judged by its ratio to the tolerance it started from (measure.ts's tolerances, so
// 1e-5 mm or 1e-9 x the part's size where the part states none) and by the grown tolerance against the part's size.
// An error forces a modal in the viewer and stops other consumers, so the rule is in one place, here.

import type { Diagnostic } from 'cad-scene';
import type { HealFix } from '../index.ts';
import { GROWTH } from './tolerance.ts';

/** Past this ratio to the starting tolerance, a growth is an error, unless within SIZE_SHARE of the part's size. */
export const ERROR_RATIO = 5;
/** The share of the part's size (its vertices' box diagonal) a grown tolerance may reach and still be a warning. */
export const SIZE_SHARE = 0.01;

/** The fixes that grow tolerances, in the order the message lists them. */
const GROWERS = ['edgeTolerance', 'vertexTolerance', 'pcurveEnds'] as const satisfies readonly HealFix[];
type Grower = (typeof GROWERS)[number];

interface Grown { what: string; start: number; grown: number }

/** A growth's severity under the rule: an error past ERROR_RATIO times its start and past SIZE_SHARE of `size`. */
export const isError = (start: number, grown: number, size: number) =>
  grown > ERROR_RATIO * start && grown > SIZE_SHARE * size;

export class Growth {
  private readonly all: Grown[] = [];
  private readonly by = new Map<Grower, { edges: number; vertices: number }>();
  private edges = 0;
  private vertices = 0;
  private readonly size: number;
  /** `size`: the part's (its vertices' box diagonal). */
  constructor(size: number) {
    this.size = size;
  }

  /** An edge's or vertex's tolerance grown from `start` (the shared function's) to `grown`, by `fixes`. */
  add(kind: 'edge' | 'vertex', id: number, start: number, grown: number, fixes: readonly Grower[]) {
    this.all.push({ what: `${kind} #${id}`, start, grown });
    if (kind === 'edge') this.edges++;
    else this.vertices++;
    for (const f of fixes) {
      const t = this.by.get(f) ?? this.by.set(f, { edges: 0, vertices: 0 }).get(f)!;
      if (kind === 'edge') t.edges++;
      else t.vertices++;
    }
  }

  /** The part's one diagnostic, or none where nothing grew. */
  diagnostic(): Diagnostic | undefined {
    if (!this.all.length) return undefined;
    const ratio = (x: Grown) => x.grown / x.start;
    const errors = this.all.filter((x) => isError(x.start, x.grown, this.size));
    // The worst: the error with the largest ratio where there's one, else the largest ratio.
    const worst = (errors.length ? errors : this.all).reduce((a, b) => ratio(b) > ratio(a) ? b : a);
    const most = this.all.reduce((a, b) => b.grown - b.start > a.grown - a.start ? b : a);
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const counts = (t: { edges: number; vertices: number }) => [t.edges ? n(t.edges, 'edge', 'edges') : '',
      t.vertices ? n(t.vertices, 'vertex', 'vertices') : ''].filter(Boolean).join(' and ');
    const fixes = GROWERS.filter((f) => this.by.has(f)).map((f) => `${f} ${counts(this.by.get(f)!)}`).join(', ');
    const mm = (x: number) => `${x >= 1e-3 ? x.toPrecision(3) : x.toExponential(2)} mm`;
    return { severity: errors.length ? 'error' : 'warning', message: `tolerances grown: `
      + `${counts({ edges: this.edges, vertices: this.vertices })} (${fixes}), each to ${GROWTH} times what's `
      + `measured; ${errors.length ? `${n(errors.length, 'error', 'errors')} (past ${ERROR_RATIO} x its starting `
        + `tolerance and ${SIZE_SHARE} x the part's size of ${mm(this.size)}), the worst` : 'the largest'} `
      + `${ratio(worst).toPrecision(3)} x its starting tolerance (${worst.what}: ${mm(worst.start)} to `
      + `${mm(worst.grown)}); the largest growth ${mm(most.grown - most.start)} (${most.what})` };
  }
}
