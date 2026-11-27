// A fallback backend: each part meshed by the primary tessellator, and again by the fallback where the primary's result
// fails (judgeResult), keeping the better result (compareVerdicts). Each side may be cached on its own (tess-cache), so
// a part the primary fails is meshed by the fallback once.

import { type BrepData, openBrep } from 'cad-brep';
import { type FaceArea, oracleAreas } from './area-oracle.ts';
import { chordBulge, newBulgeCache } from './bulge.ts';
import { deviationJudge } from './deviation.ts';
import { failedPart } from './errors.ts';
import { faceFailures } from './mesh.ts';
import { composeResults } from './compose.ts';
import { shareExpected } from './records.ts';
import { fillResult } from './fill.ts';
import { joinEdges, joinResult } from './join.ts';
import { orientResult, shellsOriented } from './orient.ts';
import { edgeUsers, openEdgesCount } from './open-edges.ts';
import { notManifoldMessage, reported, shellDefects, shellsManifold } from './manifold.ts';
import type { Diagnostic } from './scene.ts';
import { faceUses } from './tessellate.ts';
import { addWires, describeWires, missingWires, noneMissing } from './wires.ts';
import type { TessellationProgress, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from
  './tessellator.ts';

/** What judgeResult found wrong with a result. */
export interface Verdict {
  /** Whether nothing is: the part needs no fallback. */
  ok: boolean;
  /** What is, in words (empty when ok). */
  problems: string[];
  /**
   * How bad, to choose between two results (compareVerdicts), kind by kind, the worst kind first: whether the request
   * threw (or timed out), whether the part has no triangles, then the faces without triangles, the faces short of or
   * over their area, the open edges with the mesh edges and vertices that keep a closed shell's mesh from being an
   * oriented manifold (manifold.ts), the faces the backend kept with a defect past its limits (manifold, so after
   * those), the other errors. A face missing outweighs any number of edges open.
   */
  rank: [number, number, number, number, number, number, number];
}

/** Negative where `a` is the better (the lesser rank, kind by kind), positive where `b` is, 0 where they're alike. */
export function compareVerdicts(a: Verdict, b: Verdict): number {
  for (let k = 0; k < a.rank.length; k++) if (a.rank[k] !== b.rank[k]) return a.rank[k]! - b.rank[k]!;
  return 0;
}

/**
 * Whether a backend's result for a part (or the error its request threw) is sound: the request didn't throw, the part
 * has triangles, no error diagnostic (faces that failed to mesh, open edges: every backend gives both), each closed
 * shell's mesh a closed, oriented manifold (shellDefects, judged here on any backend's result), and no face of
 * the model missing or wrong by its area (faceFailures: failed, partly, excess; unverified isn't counted, as nothing
 * tells). A face's area is the oracle's where it has one (`given`, else the result's `oracle`, else made from
 * `model` on this thread: oracleAreas), else the result's own measure: a backend can mesh a face wrongly and measure
 * it just as wrongly (OCCT a sphere face as its complement), which only an independent area shows. `model` the part's
 * B-rep (the request's payload), for its faces; `deflection` the request's linear deflection, which faceFailures
 * judges by.
 */
export function judgeResult(r: TessellationResult | Error, model: BrepData | undefined, deflection: number,
  given?: ReadonlyMap<number, FaceArea>, analysis?: Uint8Array): Verdict {
  if (r instanceof Error) return { ok: false, problems: [`failed: ${r.message}`], rank: [1, 0, 0, 0, 0, 0, 0] };
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (failedPart(r)) return { ok: false, problems: errors.map((d) => d.message), rank: [0, 1, 0, 0, 0, 0, 0] };
  const kinds = { failed: 0, partly: 0, excess: 0 };
  const bad = badFaces(r, model, deflection, given, analysis);
  for (const k of bad.values()) kinds[k]++;
  // (Faces the backend kept with a defect past its own limits: meshed wrongly, a fallback's mesh to be preferred.)
  const past = pastLimits(r).filter((id) => !bad.has(id)).length;
  const open = openEdgesCount(r.diagnostics);
  const shells = model ? reported(shellDefects(model, r), open > 0) : undefined;
  const manifold = !shells || shellsManifold(shells);
  const defects = shells ? shells.open + shells.misoriented + shells.nonManifold + shells.vertices : 0;
  // (Faces that failed and open edges are counted above, whatever their errors say.)
  const others = errors.filter((d) => !/^\d+ faces failed to mesh/.test(d.message) && openEdgesCount([d]) === 0);
  const problems: string[] = [];
  for (const [k, n] of Object.entries(kinds)) if (n) problems.push(`${n} ${n === 1 ? 'face' : 'faces'} ${k === 'failed'
    ? 'without triangles' : k === 'partly' ? 'meshed only in part' : `meshed over ${n === 1 ? 'its' : 'their'} area`}`);
  if (past) problems.push(`${past} ${past === 1 ? 'face' : 'faces'} kept with a defect past the backend's limits`);
  if (open) problems.push(`open along ${open} ${open === 1 ? 'edge' : 'edges'}`);
  if (!manifold) problems.push(notManifoldMessage(shells!));
  for (const d of others) problems.push(d.message);
  return { ok: !problems.length, problems,
    rank: [0, 0, kinds.failed, kinds.partly + kinds.excess, open + defects, past, others.length] };
}

/**
 * The faces of the model a result meshes wrongly, by id: without triangles (any face, however small), meshed only in
 * part or over their area (faceFailures; unverified ones aren't counted, as nothing tells). A face's area is the
 * oracle's where it has one (`given`, else the result's `oracle`, else made from `model` here, which reads the
 * measures its `analysis` holds where they're of it), else the result's own measure. A face over its area is judged
 * against its boundary chords' bulge where `model` lets it be measured and the area is the oracle's (bulge.ts), else
 * against d x P.
 */
export function badFaces(r: TessellationResult, model: BrepData | undefined, deflection: number,
  given?: ReadonlyMap<number, FaceArea>, analysis?: Uint8Array): Map<number, 'failed' | 'partly' | 'excess'> {
  const expected: number[] = [];
  if (model) for (const id of model.face.id) if (id) expected.push(id);
  const uses = model ? faceUses(model) : new Map<number, number>();
  const faces = new Map<number, { area: number; perimeter: number; valid: boolean; uses?: number }>();
  const add = (id: number, m: { area: number; perimeter: number; valid: boolean }) => {
    const n = uses.get(id) ?? 1;
    faces.set(id, { ...m, ...(n > 1 ? { uses: n } : {}) });
  };
  for (const m of r.measures ?? []) add(m.entityId, m);
  const oracle = given ?? (r.oracle ? new Map(r.oracle.map((o) => [o.entityId, o]))
    : model && oracleAreas(model, analysis));
  for (const [id, o] of oracle ?? []) add(id, { area: o.area, perimeter: o.perimeter, valid: true });
  const mesh = { origin: r.origin, positions: r.positions, indices: r.indices,
    faces: r.faces.map((f) => ({ source: f.entityId, start: f.start, count: f.count })) };
  // (The bulge only where the area is the oracle's: a backend's own measure can be short by half on healed faces,
  // trj7_b1's B-splines by OCCT 10-47 % with meshes within 3 % of the oracle's, and a bound that tight makes its
  // error a flag. d x P judges against those, as without a model.)
  const cache = model && newBulgeCache(model);
  const excessSlack = cache ? (id: number) => (oracle?.has(id) ? chordBulge(model!, mesh, id, cache) : undefined)
    : undefined;
  const measures = faces.size ? { measures: { by: '', faces }, deflection, ...(excessSlack ? { excessSlack } : {}) }
    : undefined;
  const out = new Map<number, 'failed' | 'partly' | 'excess'>();
  for (const [id, k] of faceFailures(mesh, { expected, ...(measures ? { measured: measures } : {}) })) {
    if (k !== 'unverified') out.set(id, k);
  }
  // Every face without triangles, however small (faceFailures doesn't judge faces under the deflection squared: a
  // backend that leaves them out, where another meshes them, has still failed them).
  const meshed = new Set(r.faces.filter((f) => f.count > 0).map((f) => f.entityId));
  for (const id of expected) if (!meshed.has(id)) out.set(id, 'failed');
  return out;
}

const described = (i: TessellatorInfo) => `${i.name} ${i.version}`;

/** The faces a result's backend kept with a defect past its own limits (TessellationResult's `defects`), by id. */
export function pastLimits(r: TessellationResult): number[] {
  return (r.defects ?? []).filter((x) => x.pastLimits).map((x) => x.entityId);
}

/**
 * The primary tessellator, and where its result for a part isn't sound (judgeResult), the fallback's for the whole
 * part, whichever is the better (compareVerdicts: kind by kind, a face missing worst; the primary's on a tie), or the
 * primary's with the faces it meshes wrongly the fallback's (the per-face fallback, unless `perFace` is false). The
 * result says which (`backend`), with a warning naming what was wrong with the primary's, or an info diagnostic where
 * the fallback's was no better. Each result is joined (joinResult), its sliver faces filled (fillResult) and its
 * solids' shells facing into the material turned over (orientResult) before it's judged, unless `join`, `fill` or
 * `orient` is false. Both are asked for measures (to judge by) and edges (to join by),
 * which the result keeps only if the request asked. Both start at init (a worker pool starts one worker then, the rest
 * as requests come).
 */
export class FallbackTessellator implements Tessellator {
  readonly primary: Tessellator;
  readonly fallback: Tessellator;

  /** Whether results are joined (joinResult) before they're judged; tessellateScene's `join` should agree. */
  readonly join: boolean;
  /** Whether a part's faces the primary meshes wrongly may be the fallback's alone (composeResults). */
  readonly perFace: boolean;
  /** Whether faces no backend meshed are filled where slivers (fillResult) before results are judged. */
  readonly fill: boolean;
  /** Whether solids' shells facing into the material are turned over (orientResult) before results are judged. */
  readonly orient: boolean;
  /**
   * Whether the fallback's mesh of a face the primary kept past its limits is held to the deflection by the thread's
   * deviation judge (setDeviationJudge) before it's taken; off, the fallback backend's own deflection is trusted (its
   * mesh still judged for manifoldness, its edges once joined and its area).
   */
  readonly judgeDeviation: boolean;

  constructor(primary: Tessellator, fallback: Tessellator,
    opts: { join?: boolean; perFace?: boolean; fill?: boolean; orient?: boolean; judgeDeviation?: boolean } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.join = opts.join ?? true;
    this.perFace = opts.perFace ?? true;
    this.fill = opts.fill ?? true;
    this.orient = opts.orient ?? true;
    this.judgeDeviation = opts.judgeDeviation ?? false;
  }

  get info(): TessellatorInfo {
    const p = this.primary.info, f = this.fallback.info;
    return {
      name: `${p.name}+${f.name}`, version: `${p.version}; fallback ${f.name} ${f.version}`,
      license: p.license === f.license ? p.license : `${p.license}; ${f.license}`,
      formats: p.formats.filter((x) => f.formats.includes(x)),
      supportsFaceIds: p.supportsFaceIds && f.supportsFaceIds, supportsEdges: p.supportsEdges && f.supportsEdges,
      supportsCurves: p.supportsCurves && f.supportsCurves,
    };
  }

  get timeoutMs(): number | undefined {
    return this.primary.timeoutMs;
  }

  /** Starts both: `opts` the primary's (a backend's options are its own; a pool's come with its backend). */
  async init(opts?: Record<string, unknown>): Promise<void> {
    await Promise.all([this.primary.init(opts), this.fallback.init()]);
  }

  /**
   * The faces' result (meshed), then the model's wireframe curves and points the result lacks (missingWires) taken
   * from the fallback's result where it has them (its result already made for the faces, else asked for them), said
   * in a warning; what neither delivers is tessellateScene's to say.
   */
  async tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void):
    Promise<TessellationResult> {
    const held: { fallback?: Promise<TessellationResult | Error> } = {};
    const r = await this.meshed(req, onProgress, held);
    const model = req.format === 'cad-brep' ? openBrep(req.data) : undefined;
    if (!model) return r;
    const missing = missingWires(model, r);
    if (noneMissing(missing)) return r;
    const b = await (held.fallback ?? this.fallback.tessellate(req, onProgress).catch((e: unknown) =>
      e instanceof Error ? e : new Error(String(e))));
    if (b instanceof Error) return r;
    const { result, added } = addWires(r, b, missing);
    if (noneMissing(added)) return r;
    return { ...result, diagnostics: [{ severity: 'warning', message: `${describeWires(added)} meshed by the fallback `
      + `backend (${this.fallback.info.name}), which ${this.primary.info.name}'s result left out` },
    ...result.diagnostics] };
  }

  /** The part's faces: the primary's result, or where it isn't sound the fallback's (`held.fallback`) or both's. */
  private async meshed(req: TessellationRequest, onProgress: ((p: TessellationProgress) => void) | undefined,
    held: { fallback?: Promise<TessellationResult | Error> }): Promise<TessellationResult> {
    // (Edges to join by, and measures to judge by: both kept only if the request asked.)
    const model = req.format === 'cad-brep' ? openBrep(req.data) : undefined;
    const ask = { ...req, measures: true, ...((this.join || this.fill) && model ? { edges: true } : {}) };
    const healed = shellsOriented(req.analysis);
    const tidy = (r: TessellationResult, t: Tessellator | string) => {
      if (!model) return r;
      const j = this.join ? joinResult(model, r, req.linearDeflection) : r;
      const f = this.fill ? fillResult(model, j, req.linearDeflection) : j;
      return this.orient ? orientResult(model, f, req.linearDeflection, healed
        ? { backend: typeof t === 'string' ? t : `${t.info.name} ${t.info.version}` } : undefined) : f;
    };
    const run = (t: Tessellator) => t.tessellate(ask, onProgress).then((r) => tidy(r, t)).catch((e: unknown) =>
      e instanceof Error ? e : new Error(String(e)));
    let a = await run(this.primary);
    // (The oracle's areas from the results, computed beside the meshing: ours are cached with them.)
    const va = judgeResult(a, model, req.linearDeflection, undefined, req.analysis);
    if (va.ok) return this.finish(a as TessellationResult, this.primary, req, []);
    const p = this.primary.info.name, f = this.fallback.info.name;
    let b = await (held.fallback = run(this.fallback));
    // (Triage records: each side's faces' expected counts the other's cap where it has one, tess-cadio's.)
    if (!(a instanceof Error) && !(b instanceof Error) && a.records && b.records) {
      const ra = a.records, rb = b.records;
      a = { ...a, records: shareExpected(ra, rb) };
      b = { ...b, records: shareExpected(rb, ra) };
    }
    const vb0 = judgeResult(b, model, req.linearDeflection, undefined, req.analysis);
    const why = va.problems.join('; ');
    const D = req.linearDeflection;
    // A face the primary kept past its limits: the fallback's mesh of it taken (per face, or with its whole mesh)
    // where, per face, it's matched at every edge of the face once joined (below), and with judgeDeviation within the
    // deflection by the thread's deviation judge (by area alone where none is set); else the primary's stays, its
    // defect said. The fallback's mesh of such a face the judge puts past the deflection counts against its whole
    // mesh too.
    const past = new Set(a instanceof Error ? [] : pastLimits(a));
    const judge = this.judgeDeviation ? deviationJudge() : undefined;
    const judged = new Map<number, boolean>();
    const within = (face: number) => {
      if (!past.has(face) || !judge || !model || b instanceof Error) return true;
      if (!judged.has(face)) {
        const w = judge.worst(model, b, face);
        judged.set(face, w !== undefined && w <= D);
      }
      return judged.get(face)!;
    };
    const pastOff = [...past].filter((x) => !within(x)).length;
    const vb: Verdict = pastOff ? { ...vb0, ok: false, problems: [...vb0.problems, `${pastOff} ${pastOff === 1
      ? 'face' : 'faces'} past the deflection where ${p} kept one past its limits`],
    rank: [vb0.rank[0], vb0.rank[1], vb0.rank[2], vb0.rank[3], vb0.rank[4], vb0.rank[5] + pastOff, vb0.rank[6]] } : vb0;
    // The per-face fallback: the primary's mesh with the faces it meshes wrongly, and those its open edges are left
    // open for, the fallback's where the fallback meshes them right; joined. Kept where better than both (than the
    // fallback's whole mesh, or as good: it keeps the rest of the primary's).
    if (this.perFace && model && !(a instanceof Error) && !(b instanceof Error) && !failedPart(a)) {
      const want = new Set(badFaces(a, model, D, undefined, req.analysis).keys());
      for (const face of joinEdges(model, a, D).culprits.values()) want.add(face);
      for (const face of past) want.add(face);
      const badB = badFaces(b, model, D, undefined, req.analysis);
      const meshedB = new Set(b.faces.filter((x) => x.count > 0).map((x) => x.entityId));
      let swapped = [...want].filter((x) => meshedB.has(x) && !badB.has(x) && within(x)).sort((x, y) => x - y);
      const by = `${this.primary.info.name} with faces from ${this.fallback.info.name}`;
      let c = swapped.length ? tidy(composeResults(model, a, b, new Set(swapped)), by) : undefined;
      // (A past-limit face taken whose edges aren't all closed once joined: put back, the rest composed again.)
      if (c) {
        const users = edgeUsers(model), open = new Set<number>();
        for (const e of joinEdges(model, c, D).open) for (const f of users.get(e) ?? []) open.add(f);
        const unmatched = swapped.filter((x) => past.has(x) && open.has(x));
        if (unmatched.length) {
          swapped = swapped.filter((x) => !unmatched.includes(x));
          c = swapped.length ? tidy(composeResults(model, a, b, new Set(swapped)), by) : undefined;
        }
      }
      if (c) {
        const note = !this.judgeDeviation || judge || !swapped.some((x) => past.has(x)) ? ''
          : ' (their deviation not judged, no deviation judge set: by area alone)';
        const vc = judgeResult(c, model, D, undefined, req.analysis);
        if (compareVerdicts(vc, va) < 0 && compareVerdicts(vc, vb) <= 0) {
          const n = swapped.length, ids = swapped.slice(0, 10).map((x) => `#${x}`).join(', ')
            + (n > 10 ? ', ...' : '');
          return this.finish({ ...c, backend: `${described(this.primary.info)}, with ${n} ${n === 1 ? 'face' : 'faces'}`
            + ` by ${described(this.fallback.info)}` }, this.primary, req, [{ severity: 'warning', message: `${n} `
            + `${n === 1 ? 'face' : 'faces'} meshed by the fallback backend (${f}), since ${p}'s mesh had problems: `
            + `${why}: ${ids}${note}` }]);
        }
      }
    }
    if (compareVerdicts(vb, va) < 0) return this.finish(b as TessellationResult, this.fallback, req,
      [{ severity: 'warning', message: `meshed by the fallback backend (${f}), since ${p}'s mesh had problems: `
        + why }]);
    if (a instanceof Error) throw a;
    return this.finish(a, this.primary, req, [{ severity: 'info', message: `the fallback backend (${f}) did no `
      + `better than ${p} (${vb.problems.join('; ')}), so ${p}'s mesh is kept` }]);
  }

  /** The result as the request asked for it, saying who made it, with `notes` first. */
  private finish(r: TessellationResult, by: Tessellator, req: TessellationRequest, notes: Diagnostic[]):
    TessellationResult {
    const out: TessellationResult = { ...r, backend: r.backend ?? described(by.info),
      diagnostics: [...notes, ...r.diagnostics] };
    if (!req.measures) { delete out.measures; delete out.oracle; }
    if (!req.edges) { delete out.edges; delete out.edgePositions; }
    return out;
  }

  memoryBytes(): number {
    return (this.primary.memoryBytes?.() ?? 0) + (this.fallback.memoryBytes?.() ?? 0);
  }

  dispose(): void {
    this.primary.dispose();
    this.fallback.dispose();
  }
}
