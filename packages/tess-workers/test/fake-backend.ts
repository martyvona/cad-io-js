// A fake backend for the pool tests. The first payload byte picks the behaviour: 0 a one-triangle result, 1 hang,
// 2 throw as a WASM trap does, 3 grow the reported memory by data[1] MiB, 4 wait data[1] × 10 ms, 5 exit the worker.
// Every result names its backend instance, so the tests can tell when a worker was replaced. Init fails with the
// option `fail`, or after the time `failAfter`.

import type { TessellationRequest, TessellationResult, Tessellator } from 'cad-scene';

export class FakeTessellator implements Tessellator {
  readonly info = { name: 'fake', version: '1', license: 'Apache-2.0', formats: ['step' as const], supportsFaceIds: true, supportsEdges: false };
  private readonly instance = Math.random().toString(36).slice(2);
  private memory = 0;

  async init(opts?: Record<string, unknown>): Promise<void> {
    if (opts?.fail || (typeof opts?.failAfter === 'number' && Date.now() > opts.failAfter)) throw new Error('init refused');
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const [mode = 0, arg = 0] = req.data;
    if (mode === 1) for (;;);
    if (mode === 2) throw new WebAssembly.RuntimeError('unreachable');
    if (mode === 3) this.memory += arg * 2 ** 20;
    if (mode === 4) await new Promise((r) => setTimeout(r, arg * 10));
    if (mode === 5) process.exit(3);
    return {
      origin: req.origin ?? [0, 0, 0],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      faces: [{ entityId: req.rootId ?? null, start: 0, count: 3 }],
      diagnostics: [{ severity: 'info', message: this.instance }],
    };
  }

  memoryBytes(): number {
    return this.memory;
  }

  dispose(): void {}
}
