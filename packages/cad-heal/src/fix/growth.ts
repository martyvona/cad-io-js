// The tolerances a part's healing grew, reported per part (docs/own-tessellator.md, how far healing grows a
// tolerance): a growth to at most SMALL_FLOOR or the part's tolerance (measure.ts's tolerances' `part`), whichever is
// larger, in an info of its own; the rest in one warning or error, each judged by its ratio to the tolerance it
// started from (measure.ts's tolerances, so 1e-5 mm or 1e-9 x the part's size where the part states none) and by the
// grown tolerance against the part's size. An error forces a modal in the viewer and stops other consumers, so the
// rule is in one place, here.

import type { Diagnostic } from 'cad-scene';
import type { HealFix } from '../index.ts';
import { GROWTH } from './tolerance.ts';

/** Past this ratio to the starting tolerance, a growth is an error, unless within SIZE_SHARE of the part's size. */
export const ERROR_RATIO = 5;
/** The share of the part's size (its vertices' box diagonal) a grown tolerance may reach and still be a warning. */
export const SIZE_SHARE = 0.01;

/**
 * A grown tolerance at most this (mm), or the part's tolerance where larger, is an info, unless an error; so is a
 * p-curve kept off its edge's curve by at most as much (curves.ts).
 */
export const SMALL_FLOOR = 1e-3;
/** The limit under which healing's findings are infos, not warnings: max(SMALL_FLOOR, the part's tolerance). */
export const smallLimit = (part: number) => Math.max(SMALL_FLOOR, part);

/** The fixes that grow tolerances, in the order the message lists them. */
const GROWERS = ['edgeTolerance', 'vertexTolerance', 'pcurveEnds'] as const satisfies readonly HealFix[];
type Grower = (typeof GROWERS)[number];

interface Grown { kind: 'edge' | 'vertex'; what: string; start: number; grown: number; fixes: readonly Grower[] }

/** A growth's severity under the rule: an error past ERROR_RATIO times its start and past SIZE_SHARE of `size`. */
export const isError = (start: number, grown: number, size: number) =>
  grown > ERROR_RATIO * start && grown > SIZE_SHARE * size;

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
const mm = (x: number) => `${x >= 1e-3 ? x.toPrecision(3) : x.toExponential(2)} mm`;
const ratio = (x: Grown) => x.grown / x.start;

/** "2 edges and 1 vertex (edgeTolerance 2 edges, vertexTolerance 1 vertex)": the growths counted, by fix. */
function counted(xs: readonly Grown[]): string {
  const counts = (ys: readonly Grown[]) => {
    const e = ys.filter((y) => y.kind === 'edge').length, v = ys.length - e;
    return [e ? n(e, 'edge', 'edges') : '', v ? n(v, 'vertex', 'vertices') : ''].filter(Boolean).join(' and ');
  };
  const fixes = GROWERS.map((f) => [f, xs.filter((x) => x.fixes.includes(f))] as const).filter(([, ys]) => ys.length)
    .map(([f, ys]) => `${f} ${counts(ys)}`).join(', ');
  return `${counts(xs)} (${fixes})`;
}

export class Growth {
  private readonly all: Grown[] = [];
  private readonly size: number;
  private readonly small: number;
  /** `size`: the part's (its vertices' box diagonal); `part`: its tolerance (measure.ts's tolerances' `part`). */
  constructor(size: number, part: number) {
    this.size = size;
    this.small = smallLimit(part);
  }

  /** An edge's or vertex's tolerance grown from `start` (the shared function's) to `grown`, by `fixes`. */
  add(kind: 'edge' | 'vertex', id: number, start: number, grown: number, fixes: readonly Grower[]) {
    this.all.push({ kind, what: `${kind} #${id}`, start, grown, fixes });
  }

  /**
   * The part's diagnostics, none where nothing grew: an info for the growths to at most max(SMALL_FLOOR, the part's
   * tolerance) that aren't errors, and one warning or error for the rest.
   */
  diagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const isSmall = (x: Grown) => x.grown <= this.small && !isError(x.start, x.grown, this.size);
    const small = this.all.filter(isSmall), rest = this.all.filter((x) => !isSmall(x));
    if (small.length) {
      const top = small.reduce((a, b) => b.grown > a.grown ? b : a);
      out.push({ severity: 'info', message: `tolerances grown within ${mm(this.small)}: ${counted(small)}, each to `
        + `${GROWTH} times what's measured; the largest ${mm(top.grown)} (${top.what}, from ${mm(top.start)})` });
    }
    if (!rest.length) return out;
    const errors = rest.filter((x) => isError(x.start, x.grown, this.size));
    // The worst: the error with the largest ratio where there's one, else the largest ratio.
    const worst = (errors.length ? errors : rest).reduce((a, b) => ratio(b) > ratio(a) ? b : a);
    const most = rest.reduce((a, b) => b.grown - b.start > a.grown - a.start ? b : a);
    out.push({ severity: errors.length ? 'error' : 'warning', message: `tolerances grown: ${counted(rest)}, each to `
      + `${GROWTH} times what's measured; ${errors.length ? `${n(errors.length, 'error', 'errors')} (past `
        + `${ERROR_RATIO} x its starting tolerance and ${SIZE_SHARE} x the part's size of ${mm(this.size)}), the worst`
        : 'the largest'} ${ratio(worst).toPrecision(3)} x its starting tolerance (${worst.what}: ${mm(worst.start)} `
      + `to ${mm(worst.grown)}); the largest growth ${mm(most.grown - most.start)} (${most.what})` });
    return out;
  }
}
