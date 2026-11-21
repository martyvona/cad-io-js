// cad-heal: the healing pass on a scene's B-rep models (docs/own-tessellator.md, "Phase T3"). Healing makes a healed
// model per part, which replaces the part's model in the scene, so every consumer (the tessellators, the oracle, the
// exporters) sees the same repairs. What it changes is in the healed model's own rows (p-curves it makes or
// reparameterizes, tolerances it grows), and where each value came from, with the source's tolerance, is in the
// healed model's analysis buffer (cad-brep's analysis-layout.ts: pcurveFrom, toleranceFrom, givenTolerance, and
// toleranceError where a growth is past repair, which the mesher fails the edge's and vertex's faces for), with the
// source's values healing replaced (givenPcurve, givenRange, givenTolerance) and how it healed (the healing row), so
// a healed model heals again with other options from the source's values, as healing the source with them would.
//
// One master switch (`heal`: on wherever healPart or healScene is called, in importers HEAL_BY_DEFAULT) leaves every
// model exactly as imported when off; under it, each fix can be turned off by name. Each p-curve fix reports one
// diagnostic per part it changes (a warning with its count and examples), and one for what it couldn't repair; the
// tolerances grown (edgeTolerance's, vertexTolerance's, pcurveEnds') are one diagnostic per part, a warning or an
// error by how far they grew (fix/growth.ts). Parts heal one at a time here, or in parallel through a PartHealer (a
// worker pool's, tess-workers). The geometry is cad-geom's (its WebAssembly module, `init`).

import { analysisFor, analysisRowCount, type BrepAnalysis, type BrepData, faceOutlines, LOOP_KIND, modelHash,
  PROVENANCE, rowCount, writeAnalysis } from 'cad-brep';
import { Geometry, type GeomModule, init } from 'cad-geom';
import type { Brep, Diagnostic, Scene, SourceId, Vec3 } from 'cad-scene';
import { type CurvesRecord, healCurves } from './curves.ts';
import { compactCurves } from './compact.ts';
import { ModelEdit } from './edit.ts';
import { tolerances } from './measure.ts';
import { isError } from './fix/growth.ts';
import { curveTolerances, FAR, SPAN, strayPoles } from './fix/poles.ts';
import { fixesMask, fixesOn, HEAL_VERSION, type HealOptions, PCURVE_FIT_TOLERANCE } from './options.ts';

export { FIX_ALIASES, FIXES_OFF_BY_DEFAULT, fixesMask, fixesNamed, fixesOn, HEAL_BY_DEFAULT, HEAL_FIXES, HEAL_VERSION,
  type HealFix, type HealOptions, PCURVE_FIT_TOLERANCE } from './options.ts';
export { compactCurves } from './compact.ts';

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
 * `source` the part's, given to its diagnostics. `analysis` the model's (its hash the model's, else a throw: the
 * caller paired them wrongly): where it says the model is a healed one (its healing row), healing starts from the
 * source's values it keeps (p-curves, ranges, tolerances), so the result is what healing the source with these
 * options gives, but for what healing can't undo: strayPole's moved poles stay moved, said in a warning in its
 * diagnostic's place, whatever these options say of strayPole; healed by these same options and this
 * HEAL_VERSION already, the model and analysis are given back as they are, nothing said. The result's curve rows
 * healing appended and nothing references are dropped (compact.ts).
 */
export async function healPart(model: BrepData, opts: HealOptions = {}, module?: GeomModule, source?: SourceId,
  analysis?: BrepAnalysis): Promise<HealedPart> {
  const fixes = new Set(fixesOn(opts));
  if (!fixes.size && !analysis) return { model, changed: false, diagnostics: [] };
  const fit = opts.pcurveFitTolerance ?? PCURVE_FIT_TOLERANCE;
  const before = analysis ? await healedBy(model, analysis) : undefined;
  if (!fixes.size && !before?.fixes) {
    return { model, changed: false, ...(before ? { analysis: before.analysis } : {}), diagnostics: [] };
  }
  if (before && before.fixes === fixesMask(fixes) && Object.is(before.fit, fit) && before.version === HEAL_VERSION) {
    return { model, changed: false, analysis: before.analysis, diagnostics: [] };
  }
  const given = before?.restorable ? restored(model, before.analysis, before.sourceCurves) : model;
  // Healing off on a healed model: the source's values back, and an analysis of its healing row alone (no fixes; the
  // poles strayPole moved still counted, so healing again says they're kept).
  if (!fixes.size) {
    const diagnostics: Diagnostic[] = before!.strayPoles ? [keptPoles(before!.strayPoles, source)] : [];
    const out = writeAnalysis({ analysis: { model: await modelHash(given), uncertainty: [tolerances(given).part] },
      healing: { fixes: [0], pcurveFitTolerance: [fit], version: [HEAL_VERSION], sourceCurves: [before!.sourceCurves],
        strayPoles: [before!.strayPoles] } });
    const changed = !sameBytes(given, model);
    return { model: changed ? given : model, changed, analysis: out, diagnostics };
  }
  const sourceCurves = before?.sourceCurves ?? rowCount(model, 'curve');
  const diagnostics: Diagnostic[] = [];
  // The curves' own fixes first, into a model of their own, so the face API measures the curves as fixed.
  const progress = opts.progress ?? (() => {}), pre = new ModelEdit(given);
  progress('strayPole');
  const kept = before?.strayPoles ?? 0;
  if (kept) diagnostics.push(keptPoles(kept));
  const moved = fixes.has('strayPole') ? movePoles(given, pre, diagnostics) : 0;
  const fixed = pre.finish(), edit = new ModelEdit(fixed);
  const g = new Geometry(module ?? await init(), new Uint8Array(fixed.buffer));
  let curves;
  try {
    curves = healCurves(g, fixed, fixes, edit, diagnostics, undefined, progress, fit);
  } finally {
    g.dispose();
  }
  progress('the healed model and its analysis');
  const healed = compactCurves(edit.finish(), sourceCurves);
  const changed = before ? !sameBytes(healed, model) : pre.edited || edit.edited;
  const out = await analysisOf(healed, given, edit, curves, { fixes: fixesMask(fixes), fit, sourceCurves,
    strayPoles: kept + moved });
  if (source) for (const x of diagnostics) x.source = source;
  return { model: changed ? healed : model, changed, analysis: out, diagnostics };
}

/** The warning for poles strayPole moved in an earlier healing, which healing again can't put back. */
function keptPoles(n: number, source?: SourceId): Diagnostic {
  return { severity: 'warning', message: `strayPole: ${n} stray poles moved by an earlier healing kept`,
    ...(source ? { source } : {}) };
}

/**
 * What a model's analysis says of how it was healed (its healing row), or nothing where it's not a healed one:
 * `restorable` where it keeps the source's values (its vertex, edge and coedge rows; healing off's analysis has none,
 * its model the source's but for moved poles).
 */
async function healedBy(model: BrepData, analysis: BrepAnalysis) {
  const a = await analysisFor(model, analysis);
  if (analysisRowCount(a, 'healing') !== 1) return;
  const restorable = (['vertex', 'edge', 'coedge'] as const)
    .every((t) => analysisRowCount(a, t) === rowCount(model, t));
  return { analysis: a, restorable, fixes: a.healing.fixes[0]!, fit: a.healing.pcurveFitTolerance[0]!,
    version: a.healing.version[0]!, sourceCurves: a.healing.sourceCurves[0]!, strayPoles: a.healing.strayPoles[0]! };
}

/**
 * A healed model with the source's values its analysis keeps put back (coedges' p-curves and ranges, edges' ranges,
 * tolerances), healing's curve rows then unreferenced dropped: the source but for strayPole's poles.
 */
function restored(model: BrepData, a: BrepAnalysis, sourceCurves: number): BrepData {
  const edit = new ModelEdit(model);
  for (let c = 0; c < rowCount(model, 'coedge'); c++) {
    edit.set('coedge', 'pcurve', c, a.coedge.givenPcurve[c]!);
    for (const k of [2 * c, 2 * c + 1]) edit.set('coedge', 'range', k, a.coedge.givenRange[k]!);
  }
  for (let e = 0; e < rowCount(model, 'edge'); e++) {
    edit.set('edge', 'tolerance', e, a.edge.givenTolerance[e]!);
    for (const k of [2 * e, 2 * e + 1]) edit.set('edge', 'range', k, a.edge.givenRange[k]!);
  }
  for (let v = 0; v < rowCount(model, 'vertex'); v++) edit.set('vertex', 'tolerance', v, a.vertex.givenTolerance[v]!);
  return compactCurves(edit.finish(), sourceCurves);
}

/** Whether two models' buffers hold the same bytes. */
function sameBytes(x: BrepData, y: BrepData): boolean {
  const a = new Uint8Array(x.buffer), b = new Uint8Array(y.buffer);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** strayPole: each stray pole (fix/poles.ts's rule) moved in `edit`, in one diagnostic for the part; how many. */
function movePoles(model: BrepData, edit: ModelEdit, diagnostics: Diagnostic[]): number {
  const tol = tolerances(model), byCurve = curveTolerances(model, tol.edge);
  const moves = strayPoles(model, (c) => byCurve.get(c) ?? tol.part, tol.size, tol.lo, tol.hi);
  if (!moves.length) return 0;
  for (const m of moves) for (let k = 0; k < 3; k++) edit.set('pool', 'curveReal', m.at + k, m.to[k]!);
  const curves = new Set(moves.map((m) => m.curve)).size, far = Math.max(...moves.map((m) => m.out));
  const name = (c: number) => model.curve.id[c] ? `curve #${model.curve.id[c]}` : `curve row ${c}`;
  const ex = moves.slice(0, 5).map((m) => `${name(m.curve)} pole ${m.pole} (${m.out.toPrecision(3)} mm out)`);
  diagnostics.push({ severity: 'warning', message: `strayPole: ${moves.length} poles of ${curves} curves moved onto `
    + `their neighbours' common point (each over ${FAR} x the part's size of ${tol.size.toPrecision(3)} mm outside it, `
    + `acting on under ${SPAN} of its curve's knot range; up to ${far.toPrecision(3)} mm out): ${ex.join(', ')}`
    + `${moves.length > ex.length ? `, ${moves.length - ex.length} more` : ''}` });
  return moves.length;
}

/** The healed model's analysis: provenance of p-curves and tolerances, the source's tolerances, the deviations
 * measured; the rest not computed (NaN, none). */
async function analysisOf(healed: BrepData, source: BrepData, edit: ModelEdit, curves: CurvesRecord,
  how: { fixes: number; fit: number; sourceCurves: number; strayPoles: number }): Promise<BrepAnalysis> {
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
  // Growth past its error limit (growth.ts's rule, from the tolerance healing started from): beyond repair.
  const start = tolerances(source);
  const past = (table: 'vertex' | 'edge', n: number, startOf: (i: number) => number) => {
    const out = zero(n);
    for (let i = 0; i < n; i++) {
      const now = healed[table].tolerance[i]!;
      if (!Object.is(source[table].tolerance[i]!, now) && isError(startOf(i), now, start.size)) out[i] = 1;
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
      toleranceFrom: from('vertex', nv), givenTolerance: source.vertex.tolerance,
      toleranceError: past('vertex', nv, start.vertex) },
    edge: { range: healed.edge.range, rangeFrom: curves.edgeRangeFrom, measured: nan(ne),
      first: new Int32Array(ne).fill(-1), count: new Int32Array(ne), toleranceFrom: from('edge', ne),
      givenTolerance: source.edge.tolerance, toleranceError: past('edge', ne, start.edge),
      givenRange: source.edge.range },
    coedge: { range: nan(2 * nc), rangeFrom: zero(nc), deviation: curves.deviation, face, loop,
      pcurveFrom: curves.pcurveFrom, givenPcurve: source.coedge.pcurve, givenRange: source.coedge.range },
    trace: traceRows(curves.traces),
    healing: { fixes: [how.fixes], pcurveFitTolerance: [how.fit], version: [HEAL_VERSION],
      sourceCurves: [how.sourceCurves], strayPoles: [how.strayPoles] },
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
  /** The model's analysis, where it has one (a healed model's: healing again starts from the source's values). */
  analysis?: BrepAnalysis;
}

/** Heals one part wherever it runs (a pool's worker, running healJob), telling `progress` where it is. */
export type PartHealer = (req: HealRequest, progress: (what: string) => void) => Promise<HealedPart>;

/** healPart for a worker: tess-workers' pool runs it as the job `{ module: 'cad-heal', export: 'healJob' }`. */
export function healJob(req: HealRequest, progress: (what: string) => void): Promise<HealedPart> {
  return healPart(req.model, { ...req.options, progress }, undefined, req.source, req.analysis);
}

/**
 * How long one part may heal in a worker before its worker is stopped and the part kept as imported, with a warning
 * naming where healing was, so a hung part can't hang a load: HEAL_CPU_TIMEOUT_MS of the worker thread's CPU time
 * (tess-workers' cpuTimeoutMs: checked at each progress message and on the pool's timer), so a loaded host doesn't
 * change which parts finish; 15 minutes, 1.7 x the slowest part measured (bug29979_firetherm_12 #206858, 538 s).
 * HEAL_TIMEOUT_MS of wall time is the backstop where there's no thread CPU time (browsers). Healing on the caller's
 * own thread has no limit (it can't be stopped).
 */
export const HEAL_CPU_TIMEOUT_MS = 15 * 60_000;
export const HEAL_TIMEOUT_MS = 2 * HEAL_CPU_TIMEOUT_MS;

/** What poolHealer needs of a pool: tess-workers' PoolTessellator.run. */
export interface JobRunner {
  run<T>(job: { module: string; export: string }, input: unknown,
    opts?: { onProgress?: (message: string) => void; timeoutMs?: number; cpuTimeoutMs?: number }): Promise<T>;
}

/**
 * A PartHealer running healJob in `pool`'s workers, each part within HEAL_CPU_TIMEOUT_MS of CPU time and
 * HEAL_TIMEOUT_MS of wall time; `module` the specifier the workers import cad-heal by (a URL, or the key a bundled
 * worker entry gives it).
 */
export function poolHealer(pool: JobRunner, module: string): PartHealer {
  const job = { module, export: 'healJob' };
  return (req, progress) => pool.run<HealedPart>(job, req, { onProgress: progress, timeoutMs: HEAL_TIMEOUT_MS,
    cpuTimeoutMs: HEAL_CPU_TIMEOUT_MS });
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
 * many heal at once. A part healed before (its analysis says so) heals again from its source's values, and with
 * healing off is put back as its source (healPart's rules). `progress` is told each part as it starts, and where
 * healing is in it after the part's name. A part a healer elsewhere fails on (its worker crashed, say) keeps its
 * model as it was, with a warning; healing here throws.
 */
export async function healScene(scene: Scene, opts: HealSceneOptions = {}, module?: GeomModule): Promise<void> {
  // Healing off: only the parts healed before, put back as their sources.
  const off = !fixesOn(opts).length;
  const { progress, healer, concurrency, onPart, ...options } = opts;
  const heal: PartHealer = healer
    ?? ((req, said) => healPart(req.model, { ...req.options, progress: said }, module, req.source, req.analysis));
  const parts = scene.parts.flatMap((p, i) => (p.brep && (!off || p.brep.analysis) ? [i] : []));
  if (!parts.length) return;
  const said: Diagnostic[][] = [];
  let next = 0, done = 0;
  const run = async () => {
    while (next < parts.length) {
      const k = next++, i = parts[k]!, part = scene.parts[i]!, brep = part.brep!, source = part.sources[0];
      const where = `part ${i} of ${scene.parts.length}`;
      progress?.(where);
      let r: HealedPart;
      try {
        r = await heal({ model: brep.model, options, ...(source ? { source } : {}),
          ...(brep.analysis ? { analysis: brep.analysis } : {}) },
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
