// Errors a tessellator throws for a request.

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
