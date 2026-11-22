// ShellSide: which side of a closed shell a point just outside one of its faces lies on, the question that orients a
// shell on the model. Two independent ways answer it: rays (RayShellSide, here: the oracle's parity count) and the
// sign of the shell's exact volume (the healing lane's), reconciled where both answer. Rows, not ids, as everywhere
// in the B-rep APIs.

import type { BrepData } from 'cad-brep';
import { type FaceSide, init, Oracle, type OracleModule, type PointClass, type Vec3 } from './index.ts';

/** What a ShellSide answer rests on: for the rays, the point classified and the ray that decided. */
export interface ShellSideEvidence {
  /** The point well inside the face, and the point moved eps off it along its normal. */
  from: Vec3;
  point: Vec3;
  eps: number;
  /** The point's classification (its deciding ray, the rays tried and set aside). */
  classified: PointClass;
}

export interface ShellSideResult {
  /**
   * outside: the face's normal (its sense applied) points out of the shell, so the shell faces out; inside: into it
   * (rightly so for a void's faces); unknown: it couldn't be told.
   */
  side: 'outside' | 'inside' | 'unknown';
  /** Why unknown, where it is. */
  why?: string;
  evidence?: ShellSideEvidence;
}

export interface ShellSide {
  /**
   * For closed shell row `shell` of the model: which side of it a point just outside face row `face` lies on, the
   * point at a point well inside the face moved `eps` (about 10 x the tolerance) along its normal.
   */
  side(model: BrepData, shell: number, face: number, eps: number): ShellSideResult;
}

/** ShellSide by rays (the oracle's shellSide), an Oracle kept per model buffer until dispose. */
export class RayShellSide implements ShellSide {
  private readonly oracles = new Map<ArrayBuffer, Oracle>();
  private readonly module: OracleModule;
  private readonly opts: { checkSecondRay?: boolean };

  constructor(module: OracleModule, opts: { checkSecondRay?: boolean } = {}) {
    this.module = module, this.opts = opts;
  }

  /** A RayShellSide on the default module (init()). */
  static async create(opts: { checkSecondRay?: boolean } = {}): Promise<RayShellSide> {
    return new RayShellSide(await init(), opts);
  }

  side(model: BrepData, shell: number, face: number, eps: number): ShellSideResult {
    let o = this.oracles.get(model.buffer);
    if (!o) this.oracles.set(model.buffer, o = new Oracle(this.module, model.buffer, this.opts));
    const s: FaceSide = o.shellSide(shell, face, eps);
    const evidence = { from: s.from, point: s.point, eps: s.eps, classified: s.classified };
    return s.side === 'unknown' ? { side: 'unknown', why: s.why || s.classified.why, evidence }
      : { side: s.side, evidence };
  }

  dispose(): void {
    for (const o of this.oracles.values()) o.dispose();
    this.oracles.clear();
  }
  [Symbol.dispose](): void { this.dispose(); }
}
