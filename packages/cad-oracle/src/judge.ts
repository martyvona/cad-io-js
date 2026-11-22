// cad-oracle as the area oracle that judges meshes (cad-scene's AreaOracle, which this matches structurally: cad-oracle
// doesn't depend on cad-scene): per part, the faces it trusts at JUDGE_RELATIVE, by face id, with their errors.
// tess-workers' worker sets it as cad-scene's area oracle, so every backend's adapter gives these in its results.

import { type OracleModule, Oracle, trusted } from './index.ts';

/**
 * The relative error a face's area must be within to judge a mesh by it: faceFailures' tolerances are percents, so
 * 1e-3 judges more faces than the corpus checks' 1e-6 without judging any wrongly.
 */
export const JUDGE_RELATIVE = 1e-3;
/**
 * The quadrature's relative tolerance for judging (OracleOptions.relTol): about a quarter less time than the default
 * 1e-10 over the corpus and the user's models, the areas within 2e-6 of its on every face both trust (2e-4 is the
 * margin judging needs); coarser, no faster.
 */
export const JUDGE_REL_TOL = 1e-6;
/**
 * Whether judging projects coedges without p-curves (OracleOptions.projectMissing): off, as the projections cost about
 * 3.7 x OCCT's meshing on LMP1 (the user's models), so faces with such coedges stay unjudged by area, as with
 * cad-scene's own oracle.
 */
export const JUDGE_PROJECT = false;

/**
 * Names this oracle's judging areas in a backend's version where they're in its results (tess-workers' pools), so a
 * cache keyed on the version misses when they change: bumped (the number) whenever the module's areas or which faces
 * it trusts change for some model.
 */
export const AREA_ORACLE_ID = `cad-oracle 2 (${JUDGE_RELATIVE}, relTol ${JUDGE_REL_TOL}${JUDGE_PROJECT ? ''
  : ', no projections'})`;

/** A face's area and perimeter (the model's units) and the area's error estimate, as cad-scene's FaceArea. */
export interface JudgedArea { area: number; perimeter: number; error: number }

/** What the area oracle reads of a model: its buffer and its faces' ids (cad-brep's BrepData has both). */
export interface ModelLike { buffer: ArrayBuffer; face: { id: ArrayLike<number> } }

/**
 * An area oracle on `module`: `areas(model, analysis?)` measures every face of the model (the analysis, where given,
 * supplying healed p-curves' deviations: OracleOptions.analysis; coedges without p-curves projected where `project`,
 * default JUDGE_PROJECT) and keeps those trusted within `relative` (default JUDGE_RELATIVE), by face id; faces sharing
 * an id are left out.
 */
export function areaOracle(module: OracleModule, opts: { relative?: number; relTol?: number; project?: boolean } = {}):
  {
  readonly name: string;
  areas(model: ModelLike, analysis?: { buffer: ArrayBuffer } | Uint8Array): Map<number, JudgedArea>;
} {
  const relative = opts.relative ?? JUDGE_RELATIVE, relTol = opts.relTol ?? JUDGE_REL_TOL;
  const projectMissing = opts.project ?? JUDGE_PROJECT;
  return {
    name: 'cad-oracle',
    areas(model, analysis) {
      const out = new Map<number, JudgedArea>(), seen = new Set<number>();
      const a = analysis === undefined ? undefined : analysis instanceof Uint8Array ? analysis
        : new Uint8Array(analysis.buffer);
      using o = new Oracle(module, model.buffer, { relTol, projectMissing, ...(a ? { analysis: a } : {}) });
      for (let f = 0; f < model.face.id.length; f++) {
        const id = model.face.id[f]!;
        if (!id) continue;
        if (seen.has(id)) { out.delete(id); continue; }
        seen.add(id);
        const m = o.face(f);
        if (!trusted(m, relative)) continue;
        out.set(id, { area: m.area.value, perimeter: m.perimeter.value, error: m.area.error });
      }
      return out;
    },
  };
}
