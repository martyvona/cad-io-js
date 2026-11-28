// cad-heal: the healing pass on a scene's B-rep models (docs/own-tessellator.md, "Phase T3"). Healing makes a healed
// model per part, which replaces the part's model in the scene, so every consumer (the tessellators, the oracle, the
// exporters) sees the same repairs. What it changes is in the healed model's own rows (p-curves it makes or
// reparameterizes, tolerances it grows), and where each value came from, with the source's tolerance, is in the
// healed model's analysis buffer (cad-brep's analysis-layout.ts: pcurveFrom, toleranceFrom, givenTolerance, and
// toleranceError where a growth is past repair, which the mesher judges at the tolerance healing started from), with
// the source's values healing replaced (givenPcurve, givenRange, givenTolerance) and how it healed (the healing row),
// so a healed model heals again with other options from the source's values, as healing the source with them would.
//
// One master switch (`heal`: on wherever healPart or healScene is called, in importers HEAL_BY_DEFAULT) leaves every
// model exactly as imported when off; under it, each fix can be turned off by name. Each p-curve fix reports one
// diagnostic per part it changes (a warning with its count and examples), and one for what it couldn't repair; the
// tolerances grown (edgeTolerance's, vertexTolerance's, pcurveEnds') are said per part, an info for the small
// growths and a warning or an error for the rest by how far they grew (fix/growth.ts). Parts heal one at a time
// here, or in parallel through a PartHealer (a worker pool's, tess-workers). The geometry is cad-geom's (its
// WebAssembly module, `init`).

import { analysisFor, analysisRowCount, type BrepAnalysis, type BrepData, FACING, FACING_FROM, faceOutlines, LOOP_KIND,
  MEASURE_TRUST, modelHash, openBrep, PROVENANCE, rowCount, writeAnalysis } from 'cad-brep';
import { Geometry, type GeomModule, init } from 'cad-geom';
import { type Estimate, FLAGS, type FaceMeasure, init as initOracle, JUDGE_PROJECT, JUDGE_REL_TOL, METHOD, Oracle,
  shellBox, solidShells, STATUS } from 'cad-oracle';
import { RayShellSide } from 'cad-oracle/shell-side';
import type { Brep, Diagnostic, Scene, SourceId, Vec3 } from 'cad-scene';
import { type CurvesRecord, healCurves } from './curves.ts';
import { compactCurves } from './compact.ts';
import { ModelEdit } from './edit.ts';
import { tolerances } from './measure.ts';
import { isError } from './fix/growth.ts';
import { curveTolerances, FAR, SPAN, strayPoles } from './fix/poles.ts';
import { MIN_FIT, type Tight, tightFaces } from './fix/tight.ts';
import { type CoincidentResult, mergeCoincident } from './fix/coincident.ts';
import { type TrimResult, trimOvershoots } from './fix/overshoot.ts';
import { type SplitResult, splitVertices } from './fix/split.ts';
import { mendTouches, type RowsFrom, rowsFrom, type Touched, type TouchResult } from './fix/touch.ts';
import { faceSenses, flipSenses, loopTurns, loopWinding, type ShellVerdict, shellVerdicts, turnFaces, turnShells } from
  './fix/shells.ts';
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
  const given = before?.source ? before.source
    : before?.restorable ? restored(model, before.analysis, before.sourceCurves) : model;
  // Healing off on a healed model: the source's values back, and an analysis of its healing row alone (no fixes; the
  // poles strayPole moved still counted, so healing again says they're kept).
  if (!fixes.size) {
    const poles = before!.source ? 0 : before!.strayPoles;
    const diagnostics: Diagnostic[] = poles ? [keptPoles(poles, source)] : [];
    const out = writeAnalysis({ analysis: { model: await modelHash(given), uncertainty: [tolerances(given).part],
      measureRelTol: [NaN], measureProject: [0] },
      healing: { fixes: [0], pcurveFitTolerance: [fit], version: [HEAL_VERSION],
        sourceCurves: [rowCount(given, 'curve')], strayPoles: [poles] } });
    const changed = !sameBytes(given, model);
    return { model: changed ? given : model, changed, analysis: out, diagnostics };
  }
  const sourceCurves = before?.source ? rowCount(given, 'curve') : before?.sourceCurves ?? rowCount(model, 'curve');
  const diagnostics: Diagnostic[] = [];
  // The curves' own fixes first, into a model of their own, so the face API measures the curves as fixed.
  const progress = opts.progress ?? (() => {}), pre = new ModelEdit(given);
  progress('strayPole');
  const kept = before?.source ? 0 : before?.strayPoles ?? 0;
  if (kept) diagnostics.push(keptPoles(kept));
  const moved = fixes.has('strayPole') ? movePoles(given, pre, diagnostics) : 0;
  let fixed = pre.finish();
  const geom = module ?? await init();
  // Vertices whose uses meet at points apart split before the curves' fixes: on the source's tolerances, before
  // vertexTolerance grows them to cover the gap (rows change from here; the curves' fixes run on the split rows).
  let split: SplitResult | undefined;
  if (fixes.has('vertexSplit')) {
    progress('vertexSplit');
    split = splitVertices(geom, fixed);
    if (split) splitSaid(split, diagnostics), fixed = split.model;
  }
  const edit = new ModelEdit(fixed);
  const g = new Geometry(geom, new Uint8Array(fixed.buffer));
  let curves: CurvesRecord;
  try {
    // pcurveTight's faces first, on the projections the curves' fixes then reuse.
    let tight: Tight | undefined;
    if (fixes.has('pcurveTight')) {
      progress('pcurveTight');
      tight = tightFaces(g, fixed, fit);
      tightSaid(fixed, tight, fit, diagnostics);
    }
    curves = healCurves(g, fixed, fixes, edit, diagnostics, undefined, progress, fit, tight?.fit);
  } finally {
    g.dispose();
  }
  let healed = compactCurves(edit.finish(), sourceCurves);
  // Edges coincident within their tolerance merged, on the curves as fixed (their ranges as the curves' fixes derived
  // them): rows change from here, so the curves' record is taken onto the merged rows.
  let merge: CoincidentResult | undefined;
  if (fixes.has('coincidentEdges')) {
    progress('coincidentEdges');
    merge = mergeCoincident(geom, healed, curves.ranges);
    if (merge) {
      coincidentSaid(merge, tolerances(healed).part, diagnostics);
      curves = mergedRecord(curves, healed, merge);
      healed = merge.model;
    }
  }
  // Edges overshooting each other's crossing near their vertex trimmed there, on the merged rows (no rows change).
  let trim: TrimResult | undefined;
  if (fixes.has('trimOvershoot')) {
    progress('trimOvershoot');
    trim = trimOvershoots(geom, healed, curves.ranges);
    if (trim?.trimmed.length) {
      overshootSaid(trim, diagnostics);
      curves = trimmedRecord(curves, trim);
      healed = trim.model;
    } else trim = undefined;
  }
  // Loops of one face meeting at a point to rounding made to share a vertex there, on the trimmed rows (rows change).
  let touch: TouchResult | undefined;
  if (fixes.has('vertexOnEdge')) {
    progress('vertexOnEdge');
    touch = mendTouches(geom, healed, curves.ranges);
    if (touch) {
      touchSaid(touch, diagnostics);
      curves = mergedRecord(curves, healed, touch);
      healed = touch.model;
    }
  }
  // Shells facing into their material turned, last: the curves' fixes made on the faces as the source oriented them.
  let shells: { verdicts: ShellVerdict[]; perm?: Int32Array; flipped: number[]; turnedFaces: number[] } | undefined;
  if (fixes.has('orientShells')) {
    progress('orientShells');
    const om = await initOracle();
    // Faces turned whole where a shell uses an edge twice the same way, first: the faces then agree.
    const lt = loopTurns(healed), turnedFaces = [...lt.turn.values()].flat();
    let perm: Int32Array | undefined;
    const sid = (s: number) => healed.shell.id[s] ? `#${healed.shell.id[s]}` : `row ${s}`;
    if (turnedFaces.length) {
      const t = turnFaces(healed, new Set(turnedFaces));
      diagnostics.push({ severity: 'warning', message: `orientShells: ${turnedFaces.length} ${turnedFaces.length === 1
        ? 'face' : 'faces'} of ${lt.turn.size} ${lt.turn.size === 1 ? 'shell' : 'shells'} turned to agree with their `
        + `shells' other faces (an edge used twice the same way): ${[...lt.turn.keys()].slice(0, 10).map(sid)
          .join(', ')}${lt.turn.size > 10 ? ', ...' : ''}` });
      healed = t.model, perm = t.perm;
    }
    for (const x of lt.left) diagnostics.push({ severity: 'info', message: `orientShells: shell ${sid(x.shell)} uses `
      + `an edge twice the same way, left as built: ${x.why}` });
    // Faces whose loops run against their sense, where their neighbours agree with the loops, flipped first: a
    // shell's volume and sides are by its faces' senses.
    progress('orientShells: faces');
    // (Told again at most every PROGRESS_MS as the faces are measured: a large part's take a while, LMP1 #172440's
    // over 10 s, and a viewer and a pool's CPU limit hear from it meanwhile.)
    const nf = rowCount(healed, 'face');
    let sensed = 0;
    const tickFaces = ticker(progress);
    // (At judging's relTol, which the shells step's volumes take: the measures are kept for it, but for the faces
    // flipped here.)
    const measured = new Map<number, FaceMeasure>();
    // (On a free-form face with its flux about its solid shell's centre, which the shells step's volumes take, from
    // the same pass: about half the two's cost. Elsewhere, and for a face's second solid shell, the shells step takes
    // the flux itself where it needs it. The centre is the shell's vertices' box's, which no flip moves.)
    const centre = new Map<number, [number, number, number]>();
    for (const s of solidShells(healed)) {
      const b = shellBox(healed, s);
      for (const f of b.faces) if (!centre.has(f)) centre.set(f, b.c);
    }
    const fluxes = new Map<number, { c: [number, number, number]; flux: [Estimate, Estimate, Estimate] }>();
    const fs = (() => {
      using o = new Oracle(om, healed.buffer, { relTol: JUDGE_REL_TOL });
      using g2 = new Geometry(geom, new Uint8Array(healed.buffer));
      // (Only where the face has area enough for its loops' sign to mean something: more than 4 x its error and
      // than its perimeter times the part's tolerance. A sliver's signed sum is rounding: the bicycle's #2757 has
      // tori of 1e-14 mm^2 flagged, and flipping them turned OCCT's mesh of the whole shell inside out.)
      const tol = tolerances(healed).part;
      return faceSenses(healed, (f) => {
        tickFaces(() => `orientShells: faces, ${sensed} of ${nf} measured`);
        sensed++;
        const c = centre.get(f);
        const both = c ? o.faceAndFlux(f, c) : undefined, m = both ? both.measure : o.face(f);
        measured.set(f, m);
        if (both?.flux) fluxes.set(f, { c: c!, flux: both.flux });
        // (Its only flag, but for a projected boundary: where its loops wind a torus's minor circle (`winds`), or the
        // face has another caveat, the loops' signed sum doesn't say which way they run. LMP1 #172807's three such
        // tori flipped turned every backend's mesh of the shell inside out.)
        return m.flags.includes('orientation') && m.flags.every((x) => x === 'orientation' || x === 'projectedBoundary')
          && m.area.status === 'ok' && m.area.value > 4 * m.area.error && m.area.value > m.perimeter.value * tol;
        // (Confirmed by the loops' 3D winding, independent of the oracle's sum: its flag has been false, on tori whose
        // loops it integrated a period off.)
      }, (f) => {
        const w = loopWinding(g2, healed, f);
        return w === undefined ? undefined : w === -1;
      });
    })();
    const fid = (f: number) => healed.face.id[f] ? `#${healed.face.id[f]}` : `row ${f}`;
    const list = (xs: number[]) => `${xs.slice(0, 10).map(fid).join(', ')}${xs.length > 10 ? ', ...' : ''}`;
    const flipped = [...fs.inClosed, ...fs.inSheets];
    if (flipped.length) {
      diagnostics.push({ severity: 'warning', message: `orientShells: ${flipped.length} ${flipped.length === 1
        ? 'face\'s' : 'faces\''} sense flipped to their loops' (the loops ran against it, the neighbours agreeing with `
        + `the loops; ${fs.inClosed.length} in closed shells, ${fs.inSheets.length} in sheets): ${list(flipped)}` });
      healed = flipSenses(healed, flipped);
      for (const f of flipped) measured.delete(f), fluxes.delete(f);
    }
    if (fs.alone.length) diagnostics.push({ severity: 'info', message: `orientShells: ${fs.alone.length} `
      + `${fs.alone.length === 1 ? 'face' : 'faces'} whose loops run against their sense left as built (no neighbour `
      + `to tell which is right): ${list(fs.alone)}` });
    if (fs.refused.length) diagnostics.push({ severity: 'info', message: `orientShells: ${fs.refused.length} `
      + `${fs.refused.length === 1 ? 'face' : 'faces'} whose loops' signed sum runs against their sense left as built `
      + `(their winding in 3D runs with it): ${list(fs.refused)}` });
    if (fs.unconfirmed.length) diagnostics.push({ severity: 'info', message: `orientShells: ${fs.unconfirmed.length} `
      + `${fs.unconfirmed.length === 1 ? 'face' : 'faces'} whose loops' signed sum runs against their sense left as `
      + `built (their winding in 3D can't confirm it): ${list(fs.unconfirmed)}` });
    if (fs.disputed.length) diagnostics.push({ severity: 'info', message: `orientShells: ${fs.disputed.length} `
      + `${fs.disputed.length === 1 ? 'face' : 'faces'} whose loops run against their sense left as built (a neighbour `
      + `uses a shared edge the same way): ${list(fs.disputed)}` });
    progress('orientShells: shells');
    using sides = new RayShellSide(om, { checkSecondRay: true, relTol: JUDGE_REL_TOL });
    // (Told again at most every PROGRESS_MS, as each face's measure is asked for the shells' volumes.)
    let asked = 0;
    const tickShells = ticker(progress);
    const v = shellVerdicts(healed, om, sides, (f) => {
      tickShells(() => `orientShells: shells, ${asked} faces' measures asked`);
      asked++;
      return measured.get(f);
    }, (f, c) => {
      const x = fluxes.get(f);
      return x && x.c.every((k, i) => k === c[i]) ? x.flux : undefined;
    });
    diagnostics.push(...v.diagnostics);
    const wrong = v.verdicts.filter((x) => x.wrong);
    shells = { verdicts: v.verdicts, flipped, turnedFaces, ...(perm ? { perm } : {}) };
    if (wrong.length) {
      const t = turnShells(healed, wrong.map((x) => x.shell));
      // (Rows: the healed model's row r was the loops step's row t.perm[r], which was the pass's perm of that.)
      healed = t.model, shells.perm = perm ? t.perm.map((r) => perm[r]!) : t.perm;
      const name = (s: number) => healed.shell.id[s] ? `#${healed.shell.id[s]}` : `row ${s}`;
      const by = { both: 'its exact volume and point classification', volume: 'its exact volume',
        side: 'point classification' };
      diagnostics.push({ severity: 'warning', message: `orientShells: ${wrong.length} ${wrong.length === 1 ? 'shell'
        : 'shells'} of solids facing the wrong way turned (${wrong.slice(0, 10).map((x) => `${name(x.shell)}: by `
        + `${by[x.by!]}${x.by !== 'side' ? `, volume ${x.volume.volume.toPrecision(6)}` : ''}`).join('; ')}`
        + `${wrong.length > 10 ? '; ...' : ''})` });
    }
  }
  // The oracle's measure of every face as judging takes it (its relTol and projection, the model alone), kept in the
  // analysis so a judge of the healed model's meshes reads it rather than measuring again.
  progress('judging measures');
  const judged = await judgingMeasures(healed, progress);
  progress('the healed model and its analysis');
  const changed = before ? !sameBytes(healed, model) : pre.edited || edit.edited || !!split || !!merge || !!trim
    || !!touch || !!shells?.perm || !!shells?.flipped.length || !!shells?.turnedFaces.length;
  const out = await analysisOf(healed, givenRows(given, rowsFrom(split, rowsFrom(merge, touch))), curves,
    { fixes: fixesMask(fixes), fit, sourceCurves, strayPoles: kept + moved }, judged, shells, split || merge || trim || touch ? given : undefined);
  if (source) for (const x of diagnostics) x.source = source;
  return { model: changed ? healed : model, changed, analysis: out, diagnostics };
}

/** pcurveTight's faces said: those caught (a warning, the fits they take), those it couldn't keep (an info). */
function tightSaid(d: BrepData, t: Tight, fit: number, diagnostics: Diagnostic[]): void {
  const name = (f: number) => d.face.id[f] ? `#${d.face.id[f]}` : `row ${f}`;
  const list = (fs: number[]) => `${fs.slice(0, 10).map(name).join(', ')}${fs.length > 10 ? ', ...' : ''}`;
  const caught = [...t.fit.keys()];
  if (caught.length) {
    const tightest = Math.min(...t.fit.values());
    diagnostics.push({ severity: 'warning', message: `pcurveTight: ${caught.length} ${caught.length === 1 ? 'face'
      : 'faces'} whose bare uses' projections at the face API's tolerance bound almost nothing in (u, v) where their `
      + `exact feet bound a region given p-curves fitted within ${fit} mm`
      + `${tightest < fit ? `, down to ${tightest.toPrecision(2)} mm where that collapses them too` : ''}: `
      + `${list(caught)}` });
  }
  if (t.left.length) {
    diagnostics.push({ severity: 'info', message: `pcurveTight: ${t.left.length} ${t.left.length === 1 ? 'face'
      : 'faces'} whose bare uses' projections collapse their loop in (u, v) even fitted within ${MIN_FIT} mm left `
      + `as they are: ${list(t.left)}` });
  }
}

/** The warning for poles strayPole moved in an earlier healing, which healing again can't put back. */
function keptPoles(n: number, source?: SourceId): Diagnostic {
  return { severity: 'warning', message: `strayPole: ${n} stray poles moved by an earlier healing kept`,
    ...(source ? { source } : {}) };
}

/**
 * What a model's analysis says of how it was healed (its healing row), or nothing where it's not a healed one:
 * `restorable` where it keeps the source's values (its vertex, edge and coedge rows; healing off's analysis has none,
 * its model the source's but for moved poles); `source` the source model itself where healing changed its topology.
 */
async function healedBy(model: BrepData, analysis: BrepAnalysis) {
  const a = await analysisFor(model, analysis);
  if (analysisRowCount(a, 'healing') !== 1) return;
  const restorable = (['vertex', 'edge', 'coedge'] as const)
    .every((t) => analysisRowCount(a, t) === rowCount(model, t));
  // (Where healing changed the topology, the source itself: the given values are of the healed rows.)
  const source = analysisRowCount(a, 'source') ? openBrep(a.source.model.slice()) : undefined;
  return { analysis: a, restorable, source, fixes: a.healing.fixes[0]!, fit: a.healing.pcurveFitTolerance[0]!,
    version: a.healing.version[0]!, sourceCurves: a.healing.sourceCurves[0]!, strayPoles: a.healing.strayPoles[0]! };
}

/**
 * A healed model with the source's values its analysis keeps put back (coedges' p-curves and ranges, edges' ranges,
 * tolerances), the shells orientShells turned turned back, healing's curve rows then unreferenced dropped: the source
 * but for strayPole's poles.
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
  // (The given values are in the turned model's rows, as the analysis is: put back first, then the shells turned back,
  // which moves them with their rows.)
  let out = edit.finish();
  const turned: number[] = [];
  for (let s = 0; s < analysisRowCount(a, 'shell'); s++) if (a.shell.turned[s]) turned.push(s);
  if (turned.length) out = turnShells(out, turned).model;
  const flipped: number[] = [], whole = new Set<number>();
  for (let f = 0; f < analysisRowCount(a, 'face'); f++) {
    if (a.face.turned[f]! & 1) flipped.push(f);
    if (a.face.turned[f]! & 2) whole.add(f);
  }
  if (flipped.length) out = flipSenses(out, flipped);
  if (whole.size) out = turnFaces(out, whole).model;
  return compactCurves(out, sourceCurves);
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
async function analysisOf(healed: BrepData, source: GivenRows, curves: CurvesRecord,
  how: { fixes: number; fit: number; sourceCurves: number; strayPoles: number }, judged: JudgedRows,
  shells?: { verdicts: ShellVerdict[]; perm?: Int32Array; flipped: number[]; turnedFaces: number[] },
  sourceModel?: BrepData): Promise<BrepAnalysis> {
  const nv = rowCount(healed, 'vertex'), ne = rowCount(healed, 'edge'), nc = rowCount(healed, 'coedge');
  // What's indexed by coedge, in the healed model's rows: turned shells' loops' rows are reversed (perm, new to old,
  // its own inverse).
  const perm = shells?.perm;
  const byRow = <T extends Float64Array | Int32Array | Uint8Array>(x: T, width = 1): T => {
    if (!perm) return x;
    const y = x.slice() as T;
    for (let r = 0; r < nc; r++) for (let w = 0; w < width; w++) y[r * width + w] = x[perm[r]! * width + w]!;
    return y;
  };
  const nan = (n: number) => new Float64Array(n).fill(NaN), zero = (n: number) => new Uint8Array(n);
  const from = (table: 'vertex' | 'edge', n: number) => {
    const out = zero(n);
    for (let i = 0; i < n; i++) {
      const given = source[table].tolerance[i]!, now = healed[table].tolerance[i]!;
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
    analysis: { model: await modelHash(healed), uncertainty: [tolerances(healed).part], measureRelTol: [JUDGE_REL_TOL],
      measureProject: [JUDGE_PROJECT ? 1 : 0] },
    vertex: { measured: nan(nv), first: new Int32Array(nv).fill(-1), count: new Int32Array(nv),
      toleranceFrom: from('vertex', nv), givenTolerance: source.vertex.tolerance,
      toleranceError: past('vertex', nv, start.vertex) },
    edge: { range: healed.edge.range, rangeFrom: curves.edgeRangeFrom, measured: nan(ne),
      first: new Int32Array(ne).fill(-1), count: new Int32Array(ne), toleranceFrom: from('edge', ne),
      givenTolerance: source.edge.tolerance, toleranceError: past('edge', ne, start.edge),
      givenRange: source.edge.range },
    coedge: { range: nan(2 * nc), rangeFrom: zero(nc), deviation: byRow(curves.deviation), face, loop,
      pcurveFrom: byRow(curves.pcurveFrom), givenPcurve: byRow(source.coedge.pcurve),
      givenRange: byRow(source.coedge.range, 2) },
    // (perm is its own inverse: loops reversed in place, a loop reversed twice back as it was.)
    trace: traceRows(perm ? curves.traces.map((t) => ({ ...t, coedge: perm[t.coedge]! })) : curves.traces),
    ...(shells ? { shell: shellRows(healed, shells.verdicts) } : {}),
    face: { ...faceRows(healed, shells?.flipped ?? [], shells?.turnedFaces ?? []), ...judged },
    healing: { fixes: [how.fixes], pcurveFitTolerance: [how.fit], version: [HEAL_VERSION],
      sourceCurves: [how.sourceCurves], strayPoles: [how.strayPoles] },
    ...(sourceModel ? { source: { model: new Uint8Array(sourceModel.buffer) } } : {}),
  });
}

/**
 * What analysisOf takes of the model healing started from, on the healed model's rows: the given model's own where no
 * fix changed the topology, else each row's from the given row it came from (NaN, -1 or the new vertex's point where
 * a fix made it).
 */
type GivenRows = Pick<BrepData, 'part'> & { vertex: Pick<BrepData['vertex'], 'point' | 'tolerance'>;
  edge: Pick<BrepData['edge'], 'tolerance' | 'range'>; coedge: Pick<BrepData['coedge'], 'pcurve' | 'range'> };

function givenRows(given: BrepData, merge: RowsFrom | undefined): GivenRows {
  if (!merge) return given;
  const m = merge.model, pick = <T extends Float64Array | Int32Array>(xs: T, from: Int32Array, width: number,
    none: number, own?: T) => {
    const out = new (xs.constructor as new (n: number) => T)(from.length * width);
    for (let i = 0; i < from.length; i++) {
      for (let k = 0; k < width; k++) {
        out[i * width + k] = from[i]! >= 0 ? xs[from[i]! * width + k]! : own ? own[i * width + k]! : none;
      }
    }
    return out;
  };
  return { part: given.part,
    vertex: { point: pick(given.vertex.point, merge.vertexFrom, 3, NaN, m.vertex.point),
      tolerance: pick(given.vertex.tolerance, merge.vertexFrom, 1, NaN) },
    edge: { tolerance: pick(given.edge.tolerance, merge.edgeFrom, 1, NaN),
      range: pick(given.edge.range, merge.edgeFrom, 2, NaN) },
    coedge: { pcurve: pick(given.coedge.pcurve, merge.coedgeFrom, 1, -1),
      range: pick(given.coedge.range, merge.coedgeFrom, 2, NaN) } };
}

/**
 * The curves' record on the merged rows: each row's from the row it came from, but a use the merge left bare (its
 * p-curve dropped) has none, and a split edge's range is healing's.
 */
function mergedRecord(r: CurvesRecord, before: BrepData, merge: RowsFrom): CurvesRecord {
  const m = merge.model, nc = rowCount(m, 'coedge'), ne = rowCount(m, 'edge');
  // (The maps are to the model the merge was given: the curves' rows.)
  const pcurveFrom = new Uint8Array(nc), deviation = new Float64Array(nc).fill(NaN);
  for (let c = 0; c < nc; c++) {
    const k = merge.coedgeFrom[c]!;
    if (k < 0 || (m.coedge.pcurve[c]! < 0 && before.coedge.pcurve[k]! >= 0)) continue;
    pcurveFrom[c] = r.pcurveFrom[k]!, deviation[c] = r.deviation[k]!;
  }
  const edgeRangeFrom = new Uint8Array(ne), ranges = new Float64Array(2 * ne).fill(NaN);
  for (let e = 0; e < ne; e++) {
    const k = merge.edgeFrom[e]!;
    if (k < 0) continue;
    const same = Object.is(m.edge.range[2 * e], before.edge.range[2 * k])
      && Object.is(m.edge.range[2 * e + 1], before.edge.range[2 * k + 1]);
    edgeRangeFrom[e] = same ? r.edgeRangeFrom[k]! : PROVENANCE.healed;
    if (same) ranges[2 * e] = r.ranges[2 * k]!, ranges[2 * e + 1] = r.ranges[2 * k + 1]!;
  }
  // A trace's row for each use of its coedge that kept its p-curve.
  const byFrom = new Map<number, number[]>();
  for (let c = 0; c < nc; c++) {
    const k = merge.coedgeFrom[c]!;
    if (k >= 0 && m.coedge.pcurve[c]! >= 0) (byFrom.get(k) ?? byFrom.set(k, []).get(k)!).push(c);
  }
  const traces = r.traces.flatMap((t) => (byFrom.get(t.coedge) ?? []).map((c) => ({ ...t, coedge: c })));
  return { pcurveFrom, deviation, edgeRangeFrom, ranges, traces };
}

/** The curves' record once trimOvershoot trimmed edges: their ranges healing's, the uses it left bare without p-curves'
 * records. */
function trimmedRecord(r: CurvesRecord, trim: TrimResult): CurvesRecord {
  const edgeRangeFrom = r.edgeRangeFrom.slice(), ranges = r.ranges.slice();
  for (const e of trim.edges) edgeRangeFrom[e] = PROVENANCE.healed, ranges[2 * e] = ranges[2 * e + 1] = NaN;
  const pcurveFrom = r.pcurveFrom.slice(), deviation = r.deviation.slice(), bare = new Set(trim.dropped);
  for (const c of bare) pcurveFrom[c] = 0, deviation[c] = NaN;
  return { pcurveFrom, deviation, edgeRangeFrom, ranges, traces: r.traces.filter((t) => !bare.has(t.coedge)) };
}

/** trimOvershoot's diagnostic: a warning with the trims' count, the largest move and the tolerances it left. */
function overshootSaid(r: TrimResult, diagnostics: Diagnostic[]): void {
  const n = r.trimmed.length, most = Math.max(...r.trimmed.map((t) => t.moved));
  const ex = r.trimmed.slice(0, 5).map((t) => `face #${t.face}'s #${t.edges[0]} and #${t.edges[1]} at #${t.vertex} `
    + `(moved ${t.moved.toPrecision(3)} mm, tails ${t.tails[0].toPrecision(2)} and ${t.tails[1].toPrecision(2)}, `
    + `tolerance ${t.tolBefore.toPrecision(3)} -> ${t.tolAfter.toPrecision(3)})`);
  const dropped = r.dropped.length ? `; ${r.dropped.length} trimmed uses' p-curves dropped (not at their edge's `
    + 'parameter and not trimmable)' : '';
  diagnostics.push({ severity: 'warning', message: `trimOvershoot: ${n} ${n === 1 ? 'pair' : 'pairs'} of consecutive `
    + `edges crossing near their vertex trimmed at the crossing, the vertex moved there, up to ${most.toPrecision(3)} `
    + `mm (${ex.join('; ')}${n > ex.length ? `; ${n - ex.length} more` : ''})${dropped}` });
}

/** vertexSplit's diagnostic: a warning with the vertices split, each with its new vertices' distance. */
function splitSaid(r: SplitResult, diagnostics: Diagnostic[]): void {
  const id = (x: number) => x ? `#${x}` : 'one without an id', n = r.split.length;
  const ex = r.split.slice(0, 5).map((s) => `${id(s.vertex)} (${s.added === 1 ? 'a vertex' : `${s.added} vertices`} `
    + `${s.distance.toPrecision(3)} mm from it at a tolerance of ${s.tolerance.toPrecision(3)}, for `
    + `${s.edges.map(id).join(', ')})`);
  diagnostics.push({ severity: 'warning', message: `vertexSplit: ${n} ${n === 1 ? 'vertex' : 'vertices'} whose `
    + `uses meet at points apart, each given a vertex of its own: ${ex.join('; ')}${n > 5 ? `; ${n - 5} more` : ''}` });
}

/** vertexOnEdge's diagnostic: a warning with the edges split and the vertices merged, each with its gap. */
function touchSaid(r: TouchResult, diagnostics: Diagnostic[]): void {
  const split = r.touched.filter((t) => t.kind === 'split'), merged = r.touched.filter((t) => t.kind === 'merged');
  const id = (x: number) => x ? `#${x}` : 'one without an id';
  const list = (xs: Touched[], say: (t: Touched) => string) => `${xs.slice(0, 5).map((t) => `face #${t.face}'s `
    + `${say(t)} (${t.gap.toPrecision(2)} mm)`).join('; ')}${xs.length > 5 ? `; ${xs.length - 5} more` : ''}`;
  const parts: string[] = [];
  if (split.length) parts.push(`${split.length} ${split.length === 1 ? 'edge' : 'edges'} split at a vertex of another `
    + `loop of the face lying on it (${list(split, (t) => `${id(t.other)} at ${id(t.vertex)}`)})`);
  if (merged.length) parts.push(`${merged.length} ${merged.length === 1 ? 'pair' : 'pairs'} of vertices of two loops `
    + `of a face at one point merged (${list(merged, (t) => `${id(t.other)} into ${id(t.vertex)}`)})`);
  const dropped = r.pcurvesDropped ? `; ${r.pcurvesDropped} split uses' p-curves dropped (not at their edge's `
    + 'parameter)' : '';
  diagnostics.push({ severity: 'warning', message: `vertexOnEdge: loops of one face meeting at a point to rounding `
    + `made to share a vertex there: ${parts.join('; ')}${dropped}` });
}

/** coincidentEdges' diagnostic: a warning with the merges' count, the longest stretch and largest growth, the faces
 * removed. */
function coincidentSaid(r: CoincidentResult, part: number, diagnostics: Diagnostic[]): void {
  const n = r.merged.length, longest = Math.max(...r.merged.map((m) => m.length));
  const grown = r.merged.filter((m) => Number.isFinite(m.grown)), most = Math.max(0, ...grown.map((m) => m.grown));
  const ex = r.merged.slice(0, 5).map((m) => `face #${m.face}'s #${m.edges[0]} and #${m.edges[1]} `
    + `(${m.length.toPrecision(3)} mm, within ${m.distance.toPrecision(2)} of ${m.tolerance.toPrecision(2)})`);
  const removed = r.removed.length ? `; ${r.removed.length} ${r.removed.length === 1 ? 'face' : 'faces'} left with no `
    + `area removed: ${r.removed.slice(0, 10).map((f) => f ? `#${f}` : 'one without an id').join(', ')}`
    + `${r.removed.length > 10 ? ', ...' : ''}` : '';
  const growth = grown.length ? `; ${grown.length} merged ${grown.length === 1 ? 'edge\'s' : 'edges\''} tolerance `
    + `grown, up to ${most.toPrecision(3)} mm (the part's ${part.toPrecision(3)})` : '';
  const dropped = r.pcurvesDropped ? `; ${r.pcurvesDropped} split uses' p-curves dropped (not at their edge's `
    + 'parameter)' : '';
  const images = r.merged.filter((m) => m.onImages).length;
  const onImages = images ? `; ${images} of them by their images on the face retracing each other (the curves `
    + 'apart)' : '';
  diagnostics.push({ severity: 'warning', message: `coincidentEdges: ${n} ${n === 1 ? 'stretch' : 'stretches'} of `
    + `consecutive edges within their tolerance of each other merged, up to ${longest.toPrecision(3)} mm long `
    + `(${ex.join('; ')}${n > ex.length ? `; ${n - ex.length} more` : ''})${onImages}${growth}${removed}${dropped}` });
}

/**
 * The analysis's shell rows (every model shell): the oracle's signed volume and error, how the shell faced as the
 * source gave it (by the volume's sign or point classification), and whether healing turned it.
 */
function shellRows(model: BrepData, verdicts: ShellVerdict[]) {
  const n = rowCount(model, 'shell'), volume = new Float64Array(2 * n).fill(NaN);
  const facing = new Uint8Array(n), facingFrom = new Uint8Array(n), turned = new Uint8Array(n);
  for (const v of verdicts) {
    const x = v.volume, s = v.shell;
    volume[2 * s] = x.volume, volume[2 * s + 1] = x.error;
    const byVolume = x.known ? (x.volume > 0 ? FACING.out : FACING.in) : FACING.unknown;
    const bySide = x.side === 'outside' ? FACING.out : x.side === 'inside' ? FACING.in : FACING.unknown;
    facing[s] = byVolume && bySide && byVolume !== bySide ? FACING.unknown : byVolume || bySide;
    facingFrom[s] = byVolume && bySide ? FACING_FROM.both : byVolume ? FACING_FROM.volume
      : bySide ? FACING_FROM.classification : FACING_FROM.none;
    if (v.wrong) turned[s] = 1;
  }
  return { volume, facing, facingFrom, turned };
}

/** The analysis's face rows (every model face): nothing measured, how orientShells turned each face. */
/** The face rows' measure columns (analysis-layout.ts), as judgingMeasures fills them. */
type JudgedRows = Awaited<ReturnType<typeof judgingMeasures>>;

/**
 * Every face's measure as judging takes it (cad-oracle's JUDGE_REL_TOL and JUDGE_PROJECT, on the model alone), with
 * its flux about its first solid shell's vertices' box centre where it has one (the shells step's terms), as the
 * analysis's face columns.
 */
async function judgingMeasures(model: BrepData, progress: (what: string) => void) {
  const n = rowCount(model, 'face'), om = await initOracle();
  const area = new Float64Array(2 * n).fill(NaN), perimeter = new Float64Array(2 * n).fill(NaN);
  const areaStatus = new Uint8Array(n).fill(255), perimeterStatus = new Uint8Array(n).fill(255);
  const method = new Uint8Array(n), flags = new Uint32Array(n), offSurface = new Float64Array(n).fill(NaN);
  const boundary = new Float64Array(n).fill(NaN), fluxCentre = new Float64Array(3 * n).fill(NaN);
  const flux = new Float64Array(6 * n).fill(NaN), fluxStatus = new Uint8Array(3 * n).fill(255);
  const areaFrom = new Uint8Array(n);
  const centre = new Map<number, [number, number, number]>();
  for (const s of solidShells(model)) {
    const b = shellBox(model, s);
    for (const f of b.faces) if (!centre.has(f)) centre.set(f, b.c);
  }
  const tick = ticker(progress);
  using o = new Oracle(om, model.buffer, { relTol: JUDGE_REL_TOL, projectMissing: JUDGE_PROJECT });
  for (let f = 0; f < n; f++) {
    tick(() => `judging measures: ${f} of ${n} faces`);
    const c = centre.get(f), both = c ? o.faceAndFlux(f, c) : undefined, m = both ? both.measure : o.face(f);
    area[2 * f] = m.area.value, area[2 * f + 1] = m.area.error, areaStatus[f] = STATUS.indexOf(m.area.status);
    perimeter[2 * f] = m.perimeter.value, perimeter[2 * f + 1] = m.perimeter.error;
    perimeterStatus[f] = STATUS.indexOf(m.perimeter.status), method[f] = METHOD.indexOf(m.method);
    flags[f] = m.flags.reduce((b, x) => b | FLAGS[x], 0), offSurface[f] = m.offSurface, boundary[f] = m.boundary;
    areaFrom[f] = m.area.status === 'ok' ? m.method === 'closedForm' ? MEASURE_TRUST.exact : MEASURE_TRUST.estimate
      : MEASURE_TRUST.none;
    if (!c) continue;
    // (The flux about c: with the area's pass on a free-form face, else on its own.)
    const fx = both?.flux ?? o.faceFlux(f, c);
    fluxCentre.set(c, 3 * f);
    for (let k = 0; k < 3; k++) {
      flux[6 * f + 2 * k] = fx[k]!.value, flux[6 * f + 2 * k + 1] = fx[k]!.error;
      fluxStatus[3 * f + k] = STATUS.indexOf(fx[k]!.status);
    }
  }
  return { area, areaFrom, areaStatus, perimeter, perimeterStatus, method, flags, offSurface, boundary, fluxCentre,
    flux, fluxStatus };
}

function faceRows(model: BrepData, flipped: number[], turnedFaces: number[]) {
  const n = rowCount(model, 'face'), turned = new Uint8Array(n);
  for (const f of flipped) turned[f]! |= 1;
  for (const f of turnedFaces) turned[f]! |= 2;
  return { outerLoop: new Int32Array(n).fill(-1), outerFrom: new Uint8Array(n),
    uv: new Float64Array(4 * n).fill(NaN), area: new Float64Array(2 * n).fill(NaN), areaFrom: new Uint8Array(n),
    turned };
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

/** The least time between the progress messages a step sends from within (the faces and shells steps'). */
export const PROGRESS_MS = 1000;

/**
 * A step's progress from within: told `what()` at most every PROGRESS_MS (the first one PROGRESS_MS after the step
 * began, so a quick step adds nothing).
 */
function ticker(progress: (what: string) => void): (what: () => string) => void {
  let last = performance.now();
  return (what) => {
    const now = performance.now();
    if (now - last >= PROGRESS_MS) last = now, progress(what());
  };
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
