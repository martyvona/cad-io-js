// cad-heal's options and fixes by name, without the geometry: what a host's settings (the viewer's page, a CLI's
// flags) need, importable without cad-geom's module.

/**
 * The fixes, in the order the pass runs them. `strayPole` moves a 3D B-spline's pole thrown far out of the part
 * within a negligible span onto its neighbours (fix/poles.ts's narrow rule). Curves on surfaces (T3 lane 1): the
 * pcurveMissing fixes (each off by default, each independent) make a p-curve for every use without one, by the kind
 * of its face's surface: `pcurveMissingOnPlane` on planes, each the exact image of its edge's curve by the plane's
 * (u, v) map (fix/plane.ts); `pcurveMissingOnElementary` on cylinders, cones, spheres and tori and
 * `pcurveMissingOnFreeForm` on the rest (B-splines, swept, offset and trimmed surfaces), each the face API's
 * projection, fitted as traces are (within `pcurveFitTolerance` where that's tighter than the edge's tolerance, else
 * at it), for consumers that want every one (B-rep operations, experiments). Without them, a use stays bare unless
 * healing changes its edge (edgeTolerance's trace, where the curve is past its tolerance or the face API can't project
 * it). `pcurveReparam` gives a source's p-curve the parameter of its edge's curve where its image is right (or its
 * domain the edge's range where rounding leaves them apart); `pcurveReplace` replaces a source's p-curve by the
 * projection where the projection is nearer, measured both ways; `pcurveEnds` bridges p-curve ends to their
 * vertices; `edgeTolerance` and `vertexTolerance` grow tolerances to cover what's measured. `orientShells` turns a
 * solid's closed shell that faces into its material (fix/shells.ts: by its exact signed volume, cad-oracle's, and
 * point classification once built), last, on the healed model. (The order is also the healing row's bit order: a fix
 * added goes last.)
 */
export const HEAL_FIXES = ['strayPole', 'pcurveMissingOnPlane', 'pcurveMissingOnElementary', 'pcurveMissingOnFreeForm',
  'pcurveReparam', 'pcurveReplace', 'pcurveEnds', 'edgeTolerance', 'vertexTolerance', 'orientShells'] as const;
export type HealFix = (typeof HEAL_FIXES)[number];

/**
 * The fixes off unless asked for: the pcurveMissing fixes, since the face API and the tessellator project a missing
 * p-curve on demand, and the healed model stores one only where healing changes its edge.
 */
export const FIXES_OFF_BY_DEFAULT: readonly HealFix[] = ['pcurveMissingOnPlane', 'pcurveMissingOnElementary',
  'pcurveMissingOnFreeForm'];

/**
 * Names a host's settings take for several fixes at once (a viewer's healOn=, stepconv's --heal-on): `pcurveMissing`,
 * the name of the one fix it was before planes, elementary and free-form surfaces each had their own, for the
 * surfaces other than planes. HealOptions' `fixes` takes HEAL_FIXES' names only.
 */
export const FIX_ALIASES: Readonly<Record<string, readonly HealFix[]>> = {
  pcurveMissing: ['pcurveMissingOnElementary', 'pcurveMissingOnFreeForm'],
};

/** The fixes a name a host's settings take means: itself (one of HEAL_FIXES), an alias's, or none (unknown). */
export function fixesNamed(name: string): readonly HealFix[] {
  return (HEAL_FIXES as readonly string[]).includes(name) ? [name as HealFix] : FIX_ALIASES[name] ?? [];
}

/**
 * Whether importers heal unless told (step-import's ImportOptions.heal, stepconv, the viewer's Heal B-reps).
 * healPart and healScene heal whenever called: their callers asked for it.
 */
export const HEAL_BY_DEFAULT: boolean = true;

export interface HealOptions {
  /**
   * The master switch. Default true; false leaves every model as it is, with no analysis, but for a healed one given
   * its analysis (healPart's), put back as its source (but for poles strayPole moved), its analysis its healing row.
   */
  heal?: boolean;
  /** Under `heal`, each fix on or off by name (each on by default but FIXES_OFF_BY_DEFAULT's). */
  fixes?: Partial<Record<HealFix, boolean>>;
  /** Told where healing is (each part, each fix, every few hundred coedges), for a caller watching a long part. */
  progress?: (what: string) => void;
  /**
   * The tolerance (mm) a p-curve healing makes for a bare use (a trace's, a pcurveMissing fix's) is fitted within
   * where the curve allows and that's tighter than its edge's tolerance, else at the edge's. Default
   * PCURVE_FIT_TOLERANCE.
   */
  pcurveFitTolerance?: number;
}

/**
 * pcurveFitTolerance's default: MESH_FIT (curves.ts: tess-cadio's kMeshTolerance mirrored, the fraction of the
 * deflection it projects a bare use within) x the fine profile's linear deflection (cad-scene's MESH_PROFILES), so a
 * stored p-curve is as good as the mesher's own at every profile.
 */
export const PCURVE_FIT_TOLERANCE = 0.0025;

/**
 * The version of what healing makes: bumped when the same model and options heal to other bytes, so a model healed by
 * another version is healed again from its source's values rather than taken as healed (the analysis's healing row).
 */
export const HEAL_VERSION = 2;

/** The fixes as the analysis's healing row holds them: a bit per fix, in HEAL_FIXES order. */
export function fixesMask(fixes: Iterable<HealFix>): number {
  let m = 0;
  for (const f of fixes) m |= 1 << HEAL_FIXES.indexOf(f);
  return m >>> 0;
}

/** The fixes the options turn on, in HEAL_FIXES's order; none where `heal` is false. Throws on an unknown name. */
export function fixesOn(opts: HealOptions = {}): HealFix[] {
  for (const k of Object.keys(opts.fixes ?? {}))
    if (!(HEAL_FIXES as readonly string[]).includes(k)) throw new Error(`cad-heal: no fix named ${k}`);
  if (opts.heal === false) return [];
  return HEAL_FIXES.filter((f) => opts.fixes?.[f] ?? !FIXES_OFF_BY_DEFAULT.includes(f));
}
