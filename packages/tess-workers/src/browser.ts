// Browsers (and other runtimes with Web Workers): the pool over module workers.

import { PoolTessellator, type WorkerTessellatorOptions } from './pool.ts';
import type { WorkerHandle } from './protocol.ts';

export { DEFAULT_TIMEOUT_MS, defaultWorkers, PoolTessellator, type PoolOptions,
  type WorkerTessellatorOptions } from './pool.ts';
export type { BackendSpec, WorkerHandle } from './protocol.ts';

/** A pool's handle on a module Web Worker whose entry serves the protocol (serveWebWorker). */
export function webWorkerHandle(w: Worker): WorkerHandle {
  return {
    post: (msg) => w.postMessage(msg),
    onMessage: (cb) => { w.onmessage = (e: MessageEvent) => cb(e.data); },
    onError: (cb) => {
      w.onerror = (e: ErrorEvent) => { e.preventDefault(); cb(new Error(e.message || 'worker error')); };
      w.onmessageerror = () => cb(new Error('worker message could not be deserialized'));
    },
    terminate: () => w.terminate(),
  };
}

export function spawnWebWorker(): WorkerHandle {
  // In one expression, as bundlers (Vite) recognize a worker entry.
  return webWorkerHandle(new Worker(new URL('./worker.browser.ts', import.meta.url), { type: 'module' }));
}

/** A Tessellator running `opts.backend` in Web Workers. */
export class WorkerTessellator extends PoolTessellator {
  constructor(opts: WorkerTessellatorOptions) {
    super(spawnWebWorker, opts);
  }
}
