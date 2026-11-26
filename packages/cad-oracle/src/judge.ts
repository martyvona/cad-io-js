// cad-oracle as the area oracle that judges meshes (cad-scene's AreaOracle, which this matches structurally: cad-oracle
// doesn't depend on cad-scene): per part, the faces it trusts at JUDGE_RELATIVE, by face id, with their errors.
// tess-workers' worker sets it as cad-scene's area oracle, so every backend's adapter gives these in its results.

import { analysisRowCount, openAnalysis, sha256WordsJs } from 'cad-brep';
import { type FaceMeasure, flagsOf, METHOD, type OracleModule, Oracle, STATUS, trusted } from './index.ts';

/**
 * The relative error (the boundary's bound included) a face's area must be within to judge a mesh by it: a third of
 * faceFailures' smallest tolerance (MISSING_FRACTION, 3 % short), so a mesh judged short is short of every area the
 * bound allows by at least 2 %. Judging's own level, not the oracle's verdicts' (oracle_corpus's 1e-6), nor healing's
 * (shells.ts's FACE_RELATIVE).
 */
export const JUDGE_RELATIVE = 1e-2;
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
export const AREA_ORACLE_ID = `cad-oracle 3 (${JUDGE_RELATIVE}, relTol ${JUDGE_REL_TOL}${JUDGE_PROJECT ? ''
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
      // The analysis's own measures where it holds them, of this model, taken with these options; else measured.
      const stored = a && storedMeasures(model, a, relTol, projectMissing);
      using o = stored ? undefined : new Oracle(module, model.buffer, { relTol, projectMissing,
        ...(a ? { analysis: a } : {}) });
      for (let f = 0; f < model.face.id.length; f++) {
        const id = model.face.id[f]!;
        if (!id) continue;
        if (seen.has(id)) { out.delete(id); continue; }
        seen.add(id);
        const m = stored ? stored(f) : o!.face(f);
        if (!trusted(m, relative)) continue;
        out.set(id, { area: m.area.value, perimeter: m.perimeter.value, error: m.area.error });
      }
      return out;
    },
  };
}

/**
 * The face measures an analysis holds (cad-brep's analysis-layout.ts: the face rows' areaStatus, area, perimeter ...),
 * by face row, where they're of `model` (the analysis row's hash its buffer's) and were taken with these options (its
 * measureRelTol and measureProject), on the model alone as judging takes them (not with the analysis's deviations);
 * else undefined. A row not measured (areaStatus 255) gives an unsupported measure.
 */
export function storedMeasures(model: ModelLike, analysis: Uint8Array, relTol: number, projectMissing: boolean):
  ((face: number) => FaceMeasure) | undefined {
  let a;
  try {
    a = openAnalysis(analysis);
  } catch {
    return undefined;
  }
  const n = model.face.id.length;
  if (analysisRowCount(a, 'face') !== n || a.analysis.measureRelTol[0] !== relTol
    || a.analysis.measureProject[0] !== (projectMissing ? 1 : 0)) return undefined;
  const hash = sha256WordsJs(new Uint8Array(model.buffer));
  if (!hash.every((w, i) => w === a.analysis.model[i])) return undefined;
  const F = a.face, none = { value: NaN, error: Infinity, status: 'unsupported' as const };
  const status = (k: number) => STATUS[k] ?? 'unsupported';
  return (f) => F.areaStatus[f] === 255 ? { area: none, perimeter: none, method: 'none', flags: [], offSurface: NaN,
    boundary: NaN, why: 'not measured' } : {
    area: { value: F.area[2 * f]!, error: F.area[2 * f + 1]!, status: status(F.areaStatus[f]!) },
    perimeter: { value: F.perimeter[2 * f]!, error: F.perimeter[2 * f + 1]!, status: status(F.perimeterStatus[f]!) },
    method: METHOD[F.method[f]!] ?? 'none', flags: flagsOf(F.flags[f]!), offSurface: F.offSurface[f]!,
    boundary: F.boundary[f]!, why: '' };
}
