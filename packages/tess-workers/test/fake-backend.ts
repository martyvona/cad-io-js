// A fake backend for the pool tests. The first payload byte picks the behaviour: 0 a one-triangle result, 1 hang,
// 2 throw as a WASM trap does, 3 grow the reported memory by data[1] MiB, 4 wait data[1] x 10 ms, 5 exit the worker,
// 6 throw an ordinary error, 7 throw a TessellationError with a time limit of 50 ms, 8 report data[1] progresses
// (face ids 1, 2, ...) then hang, 9 spin until its thread has used data[1] x 10 ms of CPU, reporting progress every
// 5 ms, 10 wait data[1] x 10 ms with little CPU, reporting progress every 20 ms.
// Every result names its backend instance, so the tests can tell when a worker was replaced. Init fails with the
// option `fail`, or after the time `failAfter`.

import { TessellationError, type TessellationProgress, type TessellationRequest, type TessellationResult,
  type Tessellator } from 'cad-scene';

export class FakeTessellator implements Tessellator {
  readonly info = { name: 'fake', version: '1', license: 'Apache-2.0', formats: ['step' as const],
    supportsFaceIds: true, supportsEdges: false, supportsCurves: false };
  private readonly instance = Math.random().toString(36).slice(2);
  private memory = 0;

  async init(opts?: Record<string, unknown>): Promise<void> {
    if (opts?.fail || (typeof opts?.failAfter === 'number' && Date.now() > opts.failAfter)) throw new Error(
      'init refused');
  }

  async tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void):
    Promise<TessellationResult> {
    const [mode = 0, arg = 0] = req.data;
    if (mode === 1) for (;;);
    if (mode === 8) {
      for (let k = 1; k <= arg; k++) {
        onProgress?.({ message: `face #${k}`, faceId: k, facesDone: k - 1, facesTotal: arg });
      }
      for (;;);
    }
    if (mode === 9) {
      const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
      const t0 = cpu();
      let next = performance.now();
      for (let k = 0; cpu() - t0 < arg * 10;) {
        if (performance.now() >= next) onProgress?.({ message: `spin ${k++}` }), next += 5;
      }
    }
    if (mode === 10) {
      for (let k = 0; k * 20 < arg * 10; k++) {
        onProgress?.({ message: `wait ${k}` });
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (mode === 2) throw new WebAssembly.RuntimeError('unreachable');
    if (mode === 3) this.memory += arg * 2 ** 20;
    if (mode === 4) await new Promise((r) => setTimeout(r, arg * 10));
    if (mode === 5) process.exit(3);
    if (mode === 6) throw new Error('ordinary');
    if (mode === 7) throw new TessellationError('own limit', 50);
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

/**
 * A job for the pool's `run`: `input.mode` 'echo' gives back its input with a Float64Array of its `n`, after
 * `input.progress` progress messages; 'throw' throws; 'hang' never ends (after its progress); 'wait' waits
 * `input.ms`. Every output names the worker's instance of this module.
 */
const jobInstance = Math.random().toString(36).slice(2);
export async function fakeJob(input: { mode: string; n?: number; progress?: number; ms?: number },
  progress: (message: string) => void): Promise<unknown> {
  if (input.mode === 'throw') throw new Error('job refused');
  for (let k = 1; k <= (input.progress ?? 0); k++) progress(`step ${k}`);
  if (input.mode === 'hang') for (;;);
  if (input.mode === 'wait') await new Promise((r) => setTimeout(r, input.ms));
  return { input, values: Float64Array.from({ length: input.n ?? 0 }, (_, i) => i), instance: jobInstance };
}
