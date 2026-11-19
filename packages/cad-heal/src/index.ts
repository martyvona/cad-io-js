// cad-heal: the healing pass on a scene's B-rep models (docs/own-tessellator.md, "Phase T3"). Healing makes a healed
// model per part, which replaces the part's model in the scene, so every consumer (the tessellators, the oracle, the
// exporters) sees the same repairs. What it changes is in the healed model's own rows (p-curves it makes or
// reparameterizes, tolerances it grows), and where each value came from, with the source's tolerance, is in the
// healed model's analysis buffer (cad-brep's analysis-layout.ts: pcurveFrom, toleranceFrom, givenTolerance).
//
// One master switch (`heal`: on wherever healPart or healScene is called, in importers HEAL_BY_DEFAULT) leaves every
// model exactly as imported when off; under it, each fix can be turned off by name. Each p-curve fix reports one
// diagnostic per part it changes (a warning with its count and examples), and one for what it couldn't repair; the
// tolerances grown (edgeTolerance's, vertexTolerance's, pcurveEnds') are one diagnostic per part, a warning or an
// error by how far they grew (fix/growth.ts). Parts heal one at a time here, or in parallel through a PartHealer (a
// worker pool's, tess-workers). The geometry is cad-geom's (its WebAssembly module, `init`).

import { type BrepAnalysis, type BrepData, faceOutlines, LOOP_KIND, modelHash, PROVENANCE, rowCount,
  writeAnalysis } from 'cad-brep';
import { Geometry, type GeomModule, init } from 'cad-geom';
import type { Brep, Diagnostic, Scene, SourceId, Vec3 } from 'cad-scene';
import { type CurvesRecord, healCurves } from './curves.ts';
import { ModelEdit } from './edit.ts';
import { tolerances } from './measure.ts';
import { curveTolerances, FAR, SPAN, strayPoles } from './fix/poles.ts';
import { fixesOn, type HealOptions } from './options.ts';

export { FIXES_OFF_BY_DEFAULT, fixesOn, HEAL_BY_DEFAULT, HEAL_FIXES, type HealFix, type HealOptions } from
  './options.ts';

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
  const progress = opts.progress ?? (() => {}), pre = new ModelEdit(model);
  progress('strayPole');
  if (fixes.has('strayPole')) movePoles(model, pre, diagnostics);
  const fixed = pre.finish(), edit = new ModelEdit(fixed);
  const g = new Geometry(module ?? await init(), new Uint8Array(fixed.buffer));
  let curves;
  try {
    curves = healCurves(g, fixed, fixes, edit, diagnostics, undefined, progress);
  } finally {
    g.dispose();
  }
  progress('the healed model and its analysis');
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
      pcurveFrom: curves.pcurveFrom },
    trace: traceRows(curves.traces),
  });
}

/** The analysis's trace rows, in coedge order. */
export function traceRows(traces: CurvesRecord['traces']) {
  const t = traces.toSorted((a, b) => a.coedge - b.coedge), col = (k: keyof typeof t[number]) => t.map((x) => x[k]);
  return { coedge: col('coedge'), status: col('status'), tol: col('tol'), offSurface: col('offSurface'),
    stopAt: col('stopAt'), stopWhy: col('stopWhy') };
}

/** One part's healing, structured-clonable (for a worker): healPart's arguments but the module and progress. */
export interface HealRequest {
  model: BrepData;
  options: Omit<HealOptions, 'progress'>;
  source?: SourceId;
}

/** Heals one part wherever it runs (a pool's worker, running healJob), telling `progress` where it is. */
export type PartHealer = (req: HealRequest, progress: (what: string) => void) => Promise<HealedPart>;

/** healPart for a worker: tess-workers' pool runs it as the job `{ module: 'cad-heal', export: 'healJob' }`. */
export function healJob(req: HealRequest, progress: (what: string) => void): Promise<HealedPart> {
  return healPart(req.model, { ...req.options, progress }, undefined, req.source);
}

/**
 * How long one part may heal in a worker (wall time, ms) before its worker is stopped and the part kept as imported,
 * with a warning naming where healing was: so a hung part can't hang a load. 15 minutes: 1.7 x the slowest part
 * measured (bug29979_firetherm_12 #206858, 538 s with 6 files healing at once), so a loaded host or a browser doesn't
 * stop a part that would finish. Healing on the caller's own thread has no limit (it can't be stopped).
 */
export const HEAL_TIMEOUT_MS = 15 * 60_000;

/** What poolHealer needs of a pool: tess-workers' PoolTessellator.run. */
export interface JobRunner {
  run<T>(job: { module: string; export: string }, input: unknown,
    opts?: { onProgress?: (message: string) => void; timeoutMs?: number }): Promise<T>;
}

/**
 * A PartHealer running healJob in `pool`'s workers, each part within HEAL_TIMEOUT_MS; `module` the specifier the
 * workers import cad-heal by (a URL, or the key a bundled worker entry gives it).
 */
export function poolHealer(pool: JobRunner, module: string): PartHealer {
  const job = { module, export: 'healJob' };
  return (req, progress) => pool.run<HealedPart>(job, req, { onProgress: progress, timeoutMs: HEAL_TIMEOUT_MS });
}

export interface HealSceneOptions extends HealOptions {
  /** Where each part heals: by default here, healPart with healScene's module. */
  healer?: PartHealer;
  /** How many parts heal at once (with a healer elsewhere: in parallel). Default 1. */
  concurrency?: number;
  /** Told as each part is healed: how many of the parts with models are done. */
  onPart?: (done: number, total: number) => void;
}

/**
 * Heals every part's model in the scene in place, its analysis (of the healed model) set beside it, its outline drawn
 * from the healed model (a moved pole moves it), and its diagnostics added to the scene's in the parts' order however
 * many heal at once. `progress` is told each part as it starts, and where healing is in it after the part's name. A
 * part a healer elsewhere fails on (its worker crashed, say) keeps its model as imported, with a warning; healing
 * here throws.
 */
export async function healScene(scene: Scene, opts: HealSceneOptions = {}, module?: GeomModule): Promise<void> {
  if (!fixesOn(opts).length) return;
  const { progress, healer, concurrency, onPart, ...options } = opts;
  const heal: PartHealer = healer
    ?? ((req, said) => healPart(req.model, { ...req.options, progress: said }, module, req.source));
  const parts = scene.parts.flatMap((p, i) => (p.brep ? [i] : []));
  const said: Diagnostic[][] = [];
  let next = 0, done = 0;
  const run = async () => {
    while (next < parts.length) {
      const k = next++, i = parts[k]!, part = scene.parts[i]!, brep = part.brep!, source = part.sources[0];
      const where = `part ${i} of ${scene.parts.length}`;
      progress?.(where);
      let r: HealedPart;
      try {
        r = await heal({ model: brep.model, options, ...(source ? { source } : {}) },
          (w) => progress?.(`${where}: ${w}`));
      } catch (e) {
        if (!healer) throw e;
        said[k] = [{ severity: 'warning', message: `healing failed (${(e as Error).message ?? e}): the model as `
          + 'imported', ...(source ? { source } : {}) }];
        onPart?.(++done, parts.length);
        continue;
      }
      if (r.changed) {
        brep.model = r.model;
        if (brep.outline) brep.outline = outlineOf(r.model, part.origin);
      }
      if (r.analysis) brep.analysis = r.analysis;
      said[k] = r.diagnostics;
      onPart?.(++done, parts.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(concurrency ?? 1), parts.length)) }, run));
  for (const d of said) scene.diagnostics.push(...d);
}

/**
 * A healed part's outline, in a function of its own: a closure made in healScene would share its scope's context,
 * keeping every part's request and result.
 */
function outlineOf(model: BrepData, origin: Vec3): NonNullable<Brep['outline']> {
  return ({ faces: only, ...o }) => faceOutlines(model, origin, o, only);
}
