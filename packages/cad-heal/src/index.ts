// cad-heal: the healing pass on a scene's B-rep models (docs/own-tessellator.md, "Phase T3"). Healing makes a healed
// model per part, which replaces the part's model in the scene, so every consumer (the tessellators, the oracle, the
// exporters) sees the same repairs. What it changes is in the healed model's own rows (p-curves it makes or
// reparameterizes, tolerances it grows), and where each value came from, with the source's tolerance, is in the
// healed model's analysis buffer (cad-brep's analysis-layout.ts: pcurveFrom, toleranceFrom, givenTolerance).
//
// One master switch (`heal`, on by default) leaves every model exactly as imported when off; under it, each fix can
// be turned off by name. Each p-curve fix reports one diagnostic per part it changes (a warning with its count and
// examples), and one for what it couldn't repair; the tolerances grown (edgeTolerance's, vertexTolerance's,
// pcurveEnds') are one diagnostic per part, a warning or an error by how far they grew (fix/growth.ts). The geometry
// is cad-geom's (its WebAssembly module, `init`).

import { type BrepAnalysis, type BrepData, LOOP_KIND, modelHash, PROVENANCE, rowCount, writeAnalysis } from
  'cad-brep';
import { Geometry, type GeomModule, init } from 'cad-geom';
import type { Diagnostic, Scene, SourceId } from 'cad-scene';
import { type CurvesRecord, healCurves } from './curves.ts';
import { ModelEdit } from './edit.ts';
import { tolerances } from './measure.ts';
import { curveTolerances, FAR, SPAN, strayPoles } from './fix/poles.ts';

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

export interface HealOptions {
  /** The master switch. Default true; false leaves every model exactly as imported, with no analysis. */
  heal?: boolean;
  /** Under `heal`, each fix on or off by name (each on by default but FIXES_OFF_BY_DEFAULT's). */
  fixes?: Partial<Record<HealFix, boolean>>;
}

/** The fixes the options turn on, in HEAL_FIXES's order; none where `heal` is false. Throws on an unknown name. */
export function fixesOn(opts: HealOptions = {}): HealFix[] {
  for (const k of Object.keys(opts.fixes ?? {}))
    if (!(HEAL_FIXES as readonly string[]).includes(k)) throw new Error(`cad-heal: no fix named ${k}`);
  if (opts.heal === false) return [];
  return HEAL_FIXES.filter((f) => opts.fixes?.[f] ?? !FIXES_OFF_BY_DEFAULT.includes(f));
}

export interface HealedPart {
  /** The healed model, or the model given where nothing changed. */
  model: BrepData;
  /** Whether any fix changed the model. */
  changed: boolean;
  /** The healed model's analysis (of `model`, by its hash); absent where no fix ran. */
  analysis?: BrepAnalysis;
  diagnostics: Diagnostic[];
}

/**
 * Heals one part's model (structured-clonable in and out, for workers). `module` is cad-geom's (default: init()'s);
 * `source` the part's, given to its diagnostics.
 */
export async function healPart(model: BrepData, opts: HealOptions = {}, module?: GeomModule, source?: SourceId):
  Promise<HealedPart> {
  const fixes = new Set(fixesOn(opts));
  if (!fixes.size) return { model, changed: false, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  // The curves' own fixes first, into a model of their own, so the face API measures the curves as fixed.
  const pre = new ModelEdit(model);
  if (fixes.has('strayPole')) movePoles(model, pre, diagnostics);
  const fixed = pre.finish(), edit = new ModelEdit(fixed);
  const g = new Geometry(module ?? await init(), new Uint8Array(fixed.buffer));
  let curves;
  try {
    curves = healCurves(g, fixed, fixes, edit, diagnostics);
  } finally {
    g.dispose();
  }
  const healed = edit.finish();
  const analysis = await analysisOf(healed, model, edit, curves);
  if (source) for (const x of diagnostics) x.source = source;
  return { model: healed, changed: pre.edited || edit.edited, analysis, diagnostics };
}

/** strayPole: each stray pole (fix/poles.ts's rule) moved in `edit`, in one diagnostic for the part. */
function movePoles(model: BrepData, edit: ModelEdit, diagnostics: Diagnostic[]) {
  const tol = tolerances(model), byCurve = curveTolerances(model, tol.edge);
  const moves = strayPoles(model, (c) => byCurve.get(c) ?? tol.part, tol.size, tol.lo, tol.hi);
  if (!moves.length) return;
  for (const m of moves) for (let k = 0; k < 3; k++) edit.set('pool', 'curveReal', m.at + k, m.to[k]!);
  const curves = new Set(moves.map((m) => m.curve)).size, far = Math.max(...moves.map((m) => m.out));
  const name = (c: number) => model.curve.id[c] ? `curve #${model.curve.id[c]}` : `curve row ${c}`;
  const ex = moves.slice(0, 5).map((m) => `${name(m.curve)} pole ${m.pole} (${m.out.toPrecision(3)} mm out)`);
  diagnostics.push({ severity: 'warning', message: `strayPole: ${moves.length} poles of ${curves} curves moved onto `
    + `their neighbours' common point (each over ${FAR} x the part's size of ${tol.size.toPrecision(3)} mm outside it, `
    + `acting on under ${SPAN} of its curve's knot range; up to ${far.toPrecision(3)} mm out): ${ex.join(', ')}`
    + `${moves.length > ex.length ? `, ${moves.length - ex.length} more` : ''}` });
}

/** The healed model's analysis: provenance of p-curves and tolerances, the source's tolerances, the deviations
 * measured; the rest not computed (NaN, none). */
async function analysisOf(healed: BrepData, source: BrepData, edit: ModelEdit, curves: CurvesRecord):
  Promise<BrepAnalysis> {
  const nv = rowCount(healed, 'vertex'), ne = rowCount(healed, 'edge'), nc = rowCount(healed, 'coedge');
  const nan = (n: number) => new Float64Array(n).fill(NaN), zero = (n: number) => new Uint8Array(n);
  const from = (table: 'vertex' | 'edge', n: number) => {
    const out = zero(n);
    for (let i = 0; i < n; i++) {
      const given = source[table].tolerance[i]!, now = edit.get(table, 'tolerance', i);
      out[i] = Object.is(given, now) ? Number.isNaN(given) ? PROVENANCE.none : PROVENANCE.given : PROVENANCE.healed;
    }
    return out;
  };
  const face = new Int32Array(nc).fill(-1), loop = new Int32Array(nc).fill(-1);
  for (let f = 0; f < rowCount(healed, 'face'); f++) {
    for (let l = healed.face.firstLoop[f]!; l < healed.face.firstLoop[f]! + healed.face.loopCount[f]!; l++) {
      if (healed.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = healed.loop.first[l]!; c < healed.loop.first[l]! + healed.loop.count[l]!; c++) {
        face[c] = f, loop[c] = l;
      }
    }
  }
  return writeAnalysis({
    analysis: { model: await modelHash(healed), uncertainty: [tolerances(healed).part] },
    vertex: { measured: nan(nv), first: new Int32Array(nv).fill(-1), count: new Int32Array(nv),
      toleranceFrom: from('vertex', nv), givenTolerance: source.vertex.tolerance },
    edge: { range: healed.edge.range, rangeFrom: curves.edgeRangeFrom, measured: nan(ne),
      first: new Int32Array(ne).fill(-1), count: new Int32Array(ne), toleranceFrom: from('edge', ne),
      givenTolerance: source.edge.tolerance },
    coedge: { range: nan(2 * nc), rangeFrom: zero(nc), deviation: curves.deviation, face, loop,
      pcurveFrom: curves.pcurveFrom, traceStatus: curves.traceStatus, traceTol: curves.traceTol,
      offSurface: curves.offSurface, stopAt: curves.stopAt, stopWhy: curves.stopWhy },
  });
}

/** Heals every part's model in the scene in place, its analysis (of the healed model) set beside it and its
 * diagnostics added to the scene's. */
export async function healScene(scene: Scene, opts: HealOptions = {}, module?: GeomModule): Promise<void> {
  if (!fixesOn(opts).length) return;
  for (const part of scene.parts) {
    if (!part.brep) continue;
    const r = await healPart(part.brep.model, opts, module, part.sources[0]);
    if (r.changed) part.brep.model = r.model;
    if (r.analysis) part.brep.analysis = r.analysis;
    scene.diagnostics.push(...r.diagnostics);
  }
}
