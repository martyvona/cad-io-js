// A tessellator taking B-rep models (`cad-brep` requests) for a backend that reads STEP (OCCT, truck): each model
// written as STEP (stepPartBytes) on the calling side, then passed on. Chained after the cache (CachedTessellator ->
// StepTessellator -> a pool or a backend), so the cache keys on the model and only a miss writes STEP; its version
// names the writer's, so a changed writer misses. The backend stays free of the writer (tess-occt is LGPL, this AGPL).

import { openBrep } from 'cad-brep';
import type { TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from 'cad-scene';
import { stepPartBytes } from './part.ts';

/** Bumped whenever the writer's output for some model changes: cached meshes of the old output then miss. */
export const STEP_WRITER_VERSION = 1;

export class StepTessellator implements Tessellator {
  readonly memoryBytes?: () => number;
  private readonly inner: Tessellator;

  constructor(inner: Tessellator) {
    this.inner = inner;
    if (inner.memoryBytes) this.memoryBytes = () => inner.memoryBytes!();
  }

  get info(): TessellatorInfo {
    const i = this.inner.info;
    return { ...i, version: `${i.version}, STEP writer ${STEP_WRITER_VERSION}`,
      formats: i.formats.includes('cad-brep') ? i.formats : ['cad-brep', ...i.formats] };
  }

  get timeoutMs(): number | undefined {
    return this.inner.timeoutMs;
  }

  init(opts?: Record<string, unknown>): Promise<void> {
    return this.inner.init(opts);
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    if (req.format !== 'cad-brep' || this.inner.info.formats.includes('cad-brep')) return this.inner.tessellate(req);
    const w = stepPartBytes(openBrep(req.data));
    const r = await this.inner.tessellate({ ...req, format: 'step', data: w.data, rootId: w.rootId });
    return w.diagnostics.length ? { ...r, diagnostics: [...w.diagnostics.map((x) => ({ severity: x.severity,
      message: `writing STEP: ${x.message}` })), ...r.diagnostics] } : r;
  }

  dispose(): void {
    this.inner.dispose();
  }
}
