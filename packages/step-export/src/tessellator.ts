// A tessellator taking B-rep models (`cad-brep` requests) for a backend that reads STEP (OCCT, truck): each model
// written as STEP (stepPartBytes) on the calling side, then passed on. Chained after the cache (CachedTessellator ->
// StepTessellator -> a pool or a backend), so the cache keys on the model and only a miss writes STEP; its version
// names the writer's, so a changed writer misses. A backend that takes models itself (OCCT's native route) gets them
// as they are, and the version is its own. The backend stays free of the writer (tess-occt is LGPL, this AGPL). The
// result is judged against the model for open edges (cad-scene's openEdges: an error), as such a backend can't be,
// and with measures gets the area oracle's (oracleMeasures).

import { openBrep } from 'cad-brep';
import { openEdgesDiagnostic, oracleMeasures, type TessellationRequest, type TessellationResult, type Tessellator,
  type TessellatorInfo } from 'cad-scene';
import { stepPartBytes } from './part.ts';

/** Bumped whenever the writer's output for some model changes: cached meshes of the old output then miss. */
export const STEP_WRITER_VERSION = 2;
/** Bumped whenever this tessellator's results change otherwise, for the same reason. */
export const STEP_ADAPTER = 1;

export class StepTessellator implements Tessellator {
  readonly memoryBytes?: () => number;
  private readonly inner: Tessellator;

  constructor(inner: Tessellator) {
    this.inner = inner;
    if (inner.memoryBytes) this.memoryBytes = () => inner.memoryBytes!();
  }

  get info(): TessellatorInfo {
    const i = this.inner.info;
    return i.formats.includes('cad-brep') ? i
      : { ...i, version: `${i.version}, STEP writer ${STEP_WRITER_VERSION}, adapter ${STEP_ADAPTER}`,
        formats: ['cad-brep', ...i.formats] };
  }

  get timeoutMs(): number | undefined {
    return this.inner.timeoutMs;
  }

  init(opts?: Record<string, unknown>): Promise<void> {
    return this.inner.init(opts);
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    if (req.format !== 'cad-brep' || this.inner.info.formats.includes('cad-brep')) return this.inner.tessellate(req);
    const model = openBrep(req.data);
    const w = stepPartBytes(model);
    // (Edges always, to judge the mesh by; dropped after if not asked for.)
    const r = sourceIdsOf(await this.inner.tessellate({ ...req, format: 'step', data: w.data, rootId: w.rootId,
      edges: true }), (id) => (id === null || id <= w.largest ? id : w.sourceIds.get(id) ?? null));
    const open = openEdgesDiagnostic(model, r);
    if (req.measures) r.oracle = oracleMeasures(model);
    if (!req.edges) { delete r.edges; delete r.edgePositions; }
    const notes = w.diagnostics.map((x) => ({ severity: x.severity, message: `writing STEP: ${x.message}` }));
    return notes.length || open ? { ...r, diagnostics: [...notes, ...r.diagnostics, ...open ? [open] : []] } : r;
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/**
 * A result with the writer's ids read back as the model's (`source`): an entity without a source id reported under
 * none, as a backend reading the model would; measures under none dropped, and a face written twice (used both ways)
 * measured once, as the face it is (sound if both copies are).
 */
function sourceIdsOf(r: TessellationResult, source: (id: number | null) => number | null): TessellationResult {
  const out: TessellationResult = { ...r, faces: r.faces.map((f) => ({ ...f, entityId: source(f.entityId) })) };
  if (r.edges) out.edges = r.edges.map((e) => ({ ...e, entityId: source(e.entityId) }));
  if (r.curves) out.curves = r.curves.map((c) => ({ ...c, entityId: source(c.entityId) }));
  if (r.outlines) out.outlines = r.outlines.map((o) => ({ ...o, entityId: source(o.entityId) }));
  if (r.pointIds) out.pointIds = r.pointIds.map(source);
  if (r.measures) {
    const by = new Map<number, NonNullable<TessellationResult['measures']>[number]>();
    for (const m of r.measures) {
      const id = source(m.entityId);
      if (id === null) continue;
      const had = by.get(id);
      by.set(id, had ? { ...had, valid: had.valid && m.valid } : { ...m, entityId: id });
    }
    out.measures = [...by.values()];
  }
  return out;
}
