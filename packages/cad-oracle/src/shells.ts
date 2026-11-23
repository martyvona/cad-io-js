// A closed shell's signed volume from its faces' exact geometry (the divergence theorem: the sum over its faces of
// (p - c) . n / 3, faceMoments at degree 1 about its box's centre c), with an error estimate, for orienting shells
// (cad-heal's orientShells): positive, the shell faces out of what it encloses; negative, into it. Unknown where it
// can't be sure of the sign. Beside it, a ShellSide's answer (point classification: shell-side.ts's RayShellSide).

import { type Estimate, Oracle, type OracleModule, trusted } from './index.ts';
import { JUDGE_REL_TOL, type ModelLike } from './judge.ts';
// (A type only: shell-side.ts imports this module.)
import type { ShellSide } from './shell-side.ts';

/** cad-brep's layout.ts kinds this reads (cad-oracle doesn't depend on cad-brep at runtime). */
const SOLID = 1, CLOSED = 1, VERTEX_LOOP = 2;
/** A face's area must be within this of its value for the shell's volume to be known (judge.ts's JUDGE_RELATIVE). */
const FACE_RELATIVE = 1e-3;
/** The volume's sign is known where |V| exceeds this many times its error estimate. */
const SIGN_MARGIN = 4;

/** One solid shell's measures for orientation. */
export interface ShellVolume {
  /** The shell's row. */
  shell: number;
  /** Its signed volume (the model's units cubed), its error estimate; NaN where not computed. */
  volume: number;
  error: number;
  /** The volume's sign is sure; else why not. */
  known: boolean;
  why?: string;
  /** ShellSide's answer for one of its faces (the first with loops); 'unknown' with no ShellSide given. */
  side: 'outside' | 'inside' | 'unknown';
  sideWhy?: string;
}

/** The tables shellVolumes reads (cad-brep's BrepData has them). */
export interface ShellModel extends ModelLike {
  vertex: { point: ArrayLike<number> };
  edge: { start: ArrayLike<number>; end: ArrayLike<number> };
  coedge: { edge: ArrayLike<number> };
  loop: { kind: ArrayLike<number>; first: ArrayLike<number>; count: ArrayLike<number> };
  face: { id: ArrayLike<number>; firstLoop: ArrayLike<number>; loopCount: ArrayLike<number>;
    tolerance: ArrayLike<number> };
  shell: { kind: ArrayLike<number>; first: ArrayLike<number>; count: ArrayLike<number> };
  faceUse: { face: ArrayLike<number> };
  body: { kind: ArrayLike<number>; first: ArrayLike<number>; count: ArrayLike<number> };
  member: { ref: ArrayLike<number> };
}

/**
 * Every shell of the model's solids: its signed volume and error, known where its kind is closed, every face's area
 * trusted within 1e-3 (cad-oracle's trusted: no flags but projectedBoundary, its boundary's bound known) and
 * |V| > 4 x its error; and `sides`' answer (none given: 'unknown'). The error is the moments' quadrature errors
 * plus, per face, its boundary's bound (mm^2: FaceMeasure.boundary) times the largest distance from the centre / 3
 * (a boundary moved sweeps at most that area, each point of it at most that far from c). The quadrature's tolerance
 * `relTol`, by default judging's (JUDGE_REL_TOL).
 */
export function shellVolumes(module: OracleModule, model: ShellModel, opts: { sides?: ShellSide; eps?: number;
  relTol?: number } = {}): ShellVolume[] {
  const sides = opts.sides, out: ShellVolume[] = [];
  const shells: number[] = [];
  for (let b = 0; b < model.body.kind.length; b++) {
    if (model.body.kind[b] !== SOLID) continue;
    for (let j = model.body.first[b]!; j < model.body.first[b]! + model.body.count[b]!; j++) {
      shells.push(model.member.ref[j]!);
    }
  }
  if (!shells.length) return out;
  using o = new Oracle(module, model.buffer, { relTol: opts.relTol ?? JUDGE_REL_TOL });
  for (const s of new Set(shells)) {
    const faces: number[] = [];
    for (let j = model.shell.first[s]!; j < model.shell.first[s]! + model.shell.count[s]!; j++) {
      faces.push(model.faceUse.face[j]!);
    }
    // The box of the shell's vertices, its centre c and half-diagonal (the farthest a vertex is from c).
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let firstWithLoops = -1;
    for (const f of faces) {
      if (firstWithLoops < 0 && model.face.loopCount[f]! > 0) firstWithLoops = f;
      for (let l = model.face.firstLoop[f]!; l < model.face.firstLoop[f]! + model.face.loopCount[f]!; l++) {
        for (let k = model.loop.first[l]!; k < model.loop.first[l]! + model.loop.count[l]!; k++) {
          const vs = model.loop.kind[l] === VERTEX_LOOP ? [k] : [model.edge.start[model.coedge.edge[k]!]!,
            model.edge.end[model.coedge.edge[k]!]!];
          for (const v of vs) {
            if (v < 0) continue;
            for (let c = 0; c < 3; c++) {
              const x = model.vertex.point[3 * v + c]!;
              lo[c] = Math.min(lo[c]!, x), hi[c] = Math.max(hi[c]!, x);
            }
          }
        }
      }
    }
    const boxed = lo.every(Number.isFinite);
    const c: [number, number, number] = boxed ? [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2) as [number, number,
      number] : [0, 0, 0];
    const reach = boxed ? Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 : NaN;
    let volume = 0, error = 0, why: string | undefined;
    if (model.shell.kind[s] !== CLOSED) why = 'the shell isn\'t closed';
    for (const f of faces) {
      if (why) break;
      const m = o.face(f);
      if (!trusted(m, FACE_RELATIVE)) { why = `face row ${f}'s area isn't trusted`; break; }
      const deg1 = o.faceMoments(f, { center: c, degree: 1 }).slice(1);
      const ok = (e: Estimate) => e.status === 'ok' && Number.isFinite(e.value) && Number.isFinite(e.error);
      // (Degree 1: x, y, z by exponent, descending; each against its own component of n.)
      const parts = [deg1[0]!.n[0], deg1[1]!.n[1], deg1[2]!.n[2]];
      if (!parts.every(ok)) { why = `face row ${f}'s moments failed`; break; }
      volume += parts.reduce((a, e) => a + e.value, 0) / 3;
      error += parts.reduce((a, e) => a + e.error, 0) / 3 + (m.boundary > 0 ? m.boundary * reach / 3 : 0);
    }
    // (A volume summed over every face, its sign unsure, is still reported.)
    const summed = !why;
    if (!why && !(Math.abs(volume) > SIGN_MARGIN * error)) why = `|V| within ${SIGN_MARGIN} x its error`;
    const eps = opts.eps ?? 10 * (firstWithLoops >= 0 && Number.isFinite(model.face.tolerance[firstWithLoops]!)
      ? model.face.tolerance[firstWithLoops]! : 1e-3);
    const a = !sides ? { side: 'unknown' as const, why: 'no point classification' } : firstWithLoops >= 0
      ? sides.side(model as never, s, firstWithLoops, eps) : { side: 'unknown' as const, why: 'no face with loops' };
    out.push({ shell: s, volume: summed ? volume : NaN, error: summed ? error : NaN, known: !why,
      ...(why ? { why } : {}), side: a.side, ...(a.why ? { sideWhy: a.why } : {}) });
  }
  return out;
}
