// Errors a tessellator throws for a request, and how a result tells of a part that failed.

import type { TessellationResult } from './tessellator.ts';

/**
 * A request that failed because of its part, not the host: a backend trap, or a time limit reached (`timeoutMs`, the
 * limit). The same request to the same backend would fail the same way, so a cache may keep it; a timeout, only for a
 * limit no longer than this one.
 */
export class TessellationError extends Error {
  readonly timeoutMs?: number;

  constructor(message: string, timeoutMs?: number) {
    super(message);
    this.name = 'TessellationError';
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
  }
}

/**
 * Whether a result is of a part that failed (its backend couldn't build or mesh it): an error and no triangles. Faces
 * that failed to mesh are errors too, in a result that still has the rest of the part's triangles.
 */
export const failedPart = (r: Pick<TessellationResult, 'indices' | 'diagnostics'>) =>
  r.indices.length === 0 && r.diagnostics.some((d) => d.severity === 'error');
