// A fallback backend: each part meshed by the primary tessellator, and again by the fallback where the primary's result
// fails (judgeResult), keeping the better result (compareVerdicts). Each side may be cached on its own (tess-cache), so
// a part the primary fails is meshed by the fallback once.

import { type BrepData, openBrep } from 'cad-brep';
import { type FaceArea, oracleAreas } from './area-oracle.ts';
import { failedPart } from './errors.ts';
import { faceFailures } from './mesh.ts';
import { composeResults } from './compose.ts';
import { fillResult } from './fill.ts';
import { joinEdges, joinResult } from './join.ts';
import { openEdgesCount } from './open-edges.ts';
import type { Diagnostic } from './scene.ts';
import { faceUses } from './tessellate.ts';
import type { TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from './tessellator.ts';

/** What judgeResult found wrong with a result. */
export interface Verdict {
  /** Whether nothing is: the part needs no fallback. */
  ok: boolean;
  /** What is, in words (empty when ok). */
  problems: string[];
  /**
   * How bad, to choose between two results (compareVerdicts), kind by kind, the worst kind first: whether the request
   * threw (or timed out), whether the part has no triangles, then the faces without triangles, the faces short of or
   * over their area, the open edges, the other errors. A face missing outweighs any number of edges open.
   */
  rank: [number, number, number, number, number, number];
}

/** Negative where `a` is the better (the lesser rank, kind by kind), positive where `b` is, 0 where they're alike. */
export function compareVerdicts(a: Verdict, b: Verdict): number {
  for (let k = 0; k < a.rank.length; k++) if (a.rank[k] !== b.rank[k]) return a.rank[k]! - b.rank[k]!;
  return 0;
}

/**
 * Whether a backend's result for a part (or the error its request threw) is sound: the request didn't throw, the part
 * has triangles, no error diagnostic (faces that failed to mesh, open edges: every backend gives both), and no face of
 * the model missing or wrong by its area (faceFailures: failed, partly, excess; unverified isn't counted, as nothing
 * tells). A face's area is the oracle's where it has one (`given`, else the result's `oracle`, else made from
 * `model` on this thread: oracleAreas), else the result's own measure: a backend can mesh a face wrongly and measure
 * it just as wrongly (OCCT a sphere face as its complement), which only an independent area shows. `model` the part's
 * B-rep (the request's payload), for its faces; `deflection` the request's linear deflection, which faceFailures
 * judges by.
 */
export function judgeResult(r: TessellationResult | Error, model: BrepData | undefined, deflection: number,
  given?: ReadonlyMap<number, FaceArea>): Verdict {
  if (r instanceof Error) return { ok: false, problems: [`failed: ${r.message}`], rank: [1, 0, 0, 0, 0, 0] };
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (failedPart(r)) return { ok: false, problems: errors.map((d) => d.message), rank: [0, 1, 0, 0, 0, 0] };
  const kinds = { failed: 0, partly: 0, excess: 0 };
  for (const k of badFaces(r, model, deflection, given).values()) kinds[k]++;
  const open = openEdgesCount(r.diagnostics);
  // (Faces that failed and open edges are counted above, whatever their errors say.)
  const others = errors.filter((d) => !/^\d+ faces failed to mesh/.test(d.message) && openEdgesCount([d]) === 0);
  const problems: string[] = [];
  for (const [k, n] of Object.entries(kinds)) if (n) problems.push(`${n} ${n === 1 ? 'face' : 'faces'} ${k === 'failed'
    ? 'without triangles' : k === 'partly' ? 'meshed only in part' : `meshed over ${n === 1 ? 'its' : 'their'} area`}`);
  if (open) problems.push(`open along ${open} ${open === 1 ? 'edge' : 'edges'}`);
  for (const d of others) problems.push(d.message);
  return { ok: !problems.length, problems,
    rank: [0, 0, kinds.failed, kinds.partly + kinds.excess, open, others.length] };
}

/**
 * The faces of the model a result meshes wrongly, by id: without triangles (any face, however small), meshed only in
 * part or over their area (faceFailures; unverified ones aren't counted, as nothing tells). A face's area is the
 * oracle's where it has one (`given`, else the result's `oracle`, else made from `model` here), else the result's own
 * measure.
 */
export function badFaces(r: TessellationResult, model: BrepData | undefined, deflection: number,
  given?: ReadonlyMap<number, FaceArea>): Map<number, 'failed' | 'partly' | 'excess'> {
  const expected: number[] = [];
  if (model) for (const id of model.face.id) if (id) expected.push(id);
  const uses = model ? faceUses(model) : new Map<number, number>();
  const faces = new Map<number, { area: number; perimeter: number; valid: boolean; uses?: number }>();
  const add = (id: number, m: { area: number; perimeter: number; valid: boolean }) => {
    const n = uses.get(id) ?? 1;
    faces.set(id, { ...m, ...(n > 1 ? { uses: n } : {}) });
  };
  for (const m of r.measures ?? []) add(m.entityId, m);
  const oracle = given ?? (r.oracle ? new Map(r.oracle.map((o) => [o.entityId, o])) : model && oracleAreas(model));
  for (const [id, o] of oracle ?? []) add(id, { area: o.area, perimeter: o.perimeter, valid: true });
  const measures = faces.size ? { measures: { by: '', faces }, deflection } : undefined;
  const mesh = { origin: r.origin, positions: r.positions, indices: r.indices,
    faces: r.faces.map((f) => ({ source: f.entityId, start: f.start, count: f.count })) };
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

/**
 * The primary tessellator, and where its result for a part isn't sound (judgeResult), the fallback's for the whole
 * part, whichever is the better (compareVerdicts: kind by kind, a face missing worst; the primary's on a tie), or the
 * primary's with the faces it meshes wrongly the fallback's (the per-face fallback, unless `perFace` is false). The
 * result says which (`backend`), with a warning naming what was wrong with the primary's, or an info diagnostic where
 * the fallback's was no better. Each result is joined (joinResult) and its sliver faces filled (fillResult) before
 * it's judged, unless `join` or `fill` is false. Both are asked for measures (to judge by) and edges (to join by),
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

  constructor(primary: Tessellator, fallback: Tessellator,
    opts: { join?: boolean; perFace?: boolean; fill?: boolean } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.join = opts.join ?? true;
    this.perFace = opts.perFace ?? true;
    this.fill = opts.fill ?? true;
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

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    // (Edges to join by, and measures to judge by: both kept only if the request asked.)
    const model = req.format === 'cad-brep' ? openBrep(req.data) : undefined;
    const ask = { ...req, measures: true, ...((this.join || this.fill) && model ? { edges: true } : {}) };
    const tidy = (r: TessellationResult) => {
      if (!model) return r;
      const j = this.join ? joinResult(model, r, req.linearDeflection) : r;
      return this.fill ? fillResult(model, j, req.linearDeflection) : j;
    };
    const run = (t: Tessellator) => t.tessellate(ask).then(tidy).catch((e: unknown) => e instanceof Error ? e
      : new Error(String(e)));
    const a = await run(this.primary);
    // (The oracle's areas from the results, computed beside the meshing: ours are cached with them.)
    const va = judgeResult(a, model, req.linearDeflection);
    if (va.ok) return this.finish(a as TessellationResult, this.primary, req, []);
    const p = this.primary.info.name, f = this.fallback.info.name;
    const b = await run(this.fallback);
    const vb = judgeResult(b, model, req.linearDeflection);
    const why = va.problems.join('; ');
    const D = req.linearDeflection;
    // The per-face fallback: the primary's mesh with the faces it meshes wrongly, and those its open edges are left
    // open for, the fallback's where the fallback meshes them right; joined. Kept where better than both (than the
    // fallback's whole mesh, or as good: it keeps the rest of the primary's).
    if (this.perFace && model && !(a instanceof Error) && !(b instanceof Error) && !failedPart(a)) {
      const want = new Set(badFaces(a, model, D).keys());
      for (const face of joinEdges(model, a, D).culprits.values()) want.add(face);
      const badB = badFaces(b, model, D);
      const meshedB = new Set(b.faces.filter((x) => x.count > 0).map((x) => x.entityId));
      const swapped = [...want].filter((x) => meshedB.has(x) && !badB.has(x)).sort((x, y) => x - y);
      if (swapped.length) {
        const composed = composeResults(model, a, b, new Set(swapped));
        const c = tidy(composed);
        const vc = judgeResult(c, model, D);
        if (compareVerdicts(vc, va) < 0 && compareVerdicts(vc, vb) <= 0) {
          const n = swapped.length, ids = swapped.slice(0, 10).map((x) => `#${x}`).join(', ')
            + (n > 10 ? ', ...' : '');
          return this.finish({ ...c, backend: `${described(this.primary.info)}, with ${n} ${n === 1 ? 'face' : 'faces'}`
            + ` by ${described(this.fallback.info)}` }, this.primary, req, [{ severity: 'warning', message: `${n} `
            + `${n === 1 ? 'face' : 'faces'} meshed by the fallback backend (${f}), since ${p}'s mesh had problems: `
            + `${why}: ${ids}` }]);
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
