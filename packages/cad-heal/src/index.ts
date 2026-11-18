// cad-heal: the healing pass on a scene's B-rep models (docs/own-tessellator.md, "Phase T3"). Healing makes a healed
// model per part, which replaces the part's model in the scene, so every consumer (the tessellators, the oracle, the
// exporters) sees the same repairs. What it changes is in the healed model's own rows (p-curves it makes or
// reparameterizes, tolerances it grows), and where each value came from, with the source's tolerance, is in the
// healed model's analysis buffer (cad-brep's analysis-layout.ts: pcurveFrom, toleranceFrom, givenTolerance).
//
// One master switch (`heal`, on by default) leaves every model exactly as imported when off; under it, each fix can
// be turned off by name. Each fix reports one diagnostic per part it changes (a warning with its count and the
// largest tolerance it grew), and an error for what it couldn't repair.
//
// healPart is a stub so far: it returns the model unchanged.

import type { BrepData } from 'cad-brep';
import type { Diagnostic, Scene } from 'cad-scene';

/**
 * The fixes, in the order the pass runs them. Curves on surfaces (T3 lane 1): `pcurveMissing` makes the p-curves a
 * face needs on surfaces other than planes (planes' are exact for every consumer, so stay absent);
 * `pcurveReparameterize` gives a source's p-curve the parameter of its edge's curve where its image is right;
 * `pcurveReplace` replaces a source's p-curve by the projection where the projection is nearer, measured both ways;
 * `pcurveEnds` bridges p-curve ends to their vertices; `edgeTolerance` and `vertexTolerance` grow tolerances to
 * cover what's measured.
 */
export const HEAL_FIXES = ['pcurveMissing', 'pcurveReparameterize', 'pcurveReplace', 'pcurveEnds', 'edgeTolerance',
  'vertexTolerance'] as const;
export type HealFix = (typeof HEAL_FIXES)[number];

export interface HealOptions {
  /** The master switch. Default true; false leaves every model exactly as imported, with no analysis. */
  heal?: boolean;
  /** Under `heal`, each fix on or off by name (each on by default). */
  fixes?: Partial<Record<HealFix, boolean>>;
}

/** The fixes the options turn on, in HEAL_FIXES's order; none where `heal` is false. Throws on an unknown name. */
export function fixesOn(opts: HealOptions = {}): HealFix[] {
  for (const k of Object.keys(opts.fixes ?? {}))
    if (!(HEAL_FIXES as readonly string[]).includes(k)) throw new Error(`cad-heal: no fix named ${k}`);
  if (opts.heal === false) return [];
  return HEAL_FIXES.filter((f) => opts.fixes?.[f] !== false);
}

export interface HealedPart {
  /** The healed model, or the model given where nothing changed. */
  model: BrepData;
  /** Whether any fix changed the model. */
  changed: boolean;
  diagnostics: Diagnostic[];
}

/** Heals one part's model (structured-clonable in and out, for workers). */
export function healPart(model: BrepData, opts: HealOptions = {}): HealedPart {
  fixesOn(opts);
  return { model, changed: false, diagnostics: [] };
}

/** Heals every part's model in the scene in place, its diagnostics added to the scene's. */
export async function healScene(scene: Scene, opts: HealOptions = {}): Promise<void> {
  if (!fixesOn(opts).length) return;
  for (const part of scene.parts) {
    if (!part.brep) continue;
    const r = healPart(part.brep.model, opts);
    if (r.changed) part.brep.model = r.model;
    scene.diagnostics.push(...r.diagnostics);
  }
}
