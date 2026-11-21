// cad-heal's options and fixes by name, without the geometry: what a host's settings (the viewer's page, a CLI's
// flags) need, importable without cad-geom's module.

/**
 * The fixes, in the order the pass runs them. `strayPole` moves a 3D B-spline's pole thrown far out of the part
 * within a negligible span onto its neighbours (fix/poles.ts's narrow rule). Curves on surfaces (T3 lane 1):
 * `pcurveMissing` (off by default) makes the p-curves a face needs on surfaces other than planes (planes' are exact
 * for every consumer, so stay absent); `pcurveReparam` gives a source's p-curve the parameter of its edge's curve
 * where its image is right (or its domain the edge's range where rounding leaves them apart); `pcurveReplace`
 * replaces a source's p-curve by the projection where the projection is nearer, measured both ways; `pcurveEnds`
 * bridges p-curve ends to their vertices; `edgeTolerance` and `vertexTolerance` grow tolerances to cover what's
 * measured.
 */
export const HEAL_FIXES = ['strayPole', 'pcurveMissing', 'pcurveReparam', 'pcurveReplace', 'pcurveEnds',
  'edgeTolerance', 'vertexTolerance'] as const;
export type HealFix = (typeof HEAL_FIXES)[number];

/**
 * The fixes off unless asked for: pcurveMissing, since the face API and the tessellator project a missing p-curve on
 * demand, and projecting every one at import costs far more than the import (VW's 3 s import, 888 s).
 */
export const FIXES_OFF_BY_DEFAULT: readonly HealFix[] = ['pcurveMissing'];

/**
 * Whether importers heal unless told (step-import's ImportOptions.heal, stepconv, the viewer's Heal B-reps). Off
 * while healing costs far more than the import it follows (the 39 slowest files: 3,320 s of CPU against an import of
 * 37.5 s). healPart and healScene heal whenever called: their callers asked for it.
 */
export const HEAL_BY_DEFAULT: boolean = false;

export interface HealOptions {
  /** The master switch. Default true; false leaves every model exactly as imported, with no analysis. */
  heal?: boolean;
  /** Under `heal`, each fix on or off by name (each on by default but FIXES_OFF_BY_DEFAULT's). */
  fixes?: Partial<Record<HealFix, boolean>>;
  /** Told where healing is (each part, each fix, every few hundred coedges), for a caller watching a long part. */
  progress?: (what: string) => void;
  /**
   * The finest linear deflection (mm) the healed model is to be meshed at: a trace's p-curve, which the model keeps,
   * is fitted within MESH_FIT x it where the curve allows, as tess-cadio projects a use the model gives none, else at
   * its edge's tolerance. Default the fine profile's (cad-scene's MESH_PROFILES), so a stored p-curve is as good as
   * the mesher's own at every profile.
   */
  meshDeflection?: number;
}

/** The fixes the options turn on, in HEAL_FIXES's order; none where `heal` is false. Throws on an unknown name. */
export function fixesOn(opts: HealOptions = {}): HealFix[] {
  for (const k of Object.keys(opts.fixes ?? {}))
    if (!(HEAL_FIXES as readonly string[]).includes(k)) throw new Error(`cad-heal: no fix named ${k}`);
  if (opts.heal === false) return [];
  return HEAL_FIXES.filter((f) => opts.fixes?.[f] ?? !FIXES_OFF_BY_DEFAULT.includes(f));
}
