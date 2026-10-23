// Browsers (and other runtimes with Web Workers): the pool over module workers.

import { PoolTessellator, type WorkerTessellatorOptions } from './pool.ts';
import type { WorkerHandle } from './protocol.ts';

export { DEFAULT_TIMEOUT_MS, defaultWorkers, PoolTessellator, type PoolOptions, type WorkerTessellatorOptions } from './pool.ts';
export type { BackendSpec, WorkerHandle } from './protocol.ts';

const entry = new URL('./worker.browser.ts', import.meta.url);

export function spawnWebWorker(): WorkerHandle {
  const w = new Worker(entry, { type: 'module' });
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

/** A Tessellator running `opts.backend` in Web Workers. */
export class WorkerTessellator extends PoolTessellator {
  constructor(opts: WorkerTessellatorOptions) {
    super(spawnWebWorker, opts);
  }
}
