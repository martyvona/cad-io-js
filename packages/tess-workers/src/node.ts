// Node: the pool over worker_threads.

import { Worker } from 'node:worker_threads';
import { PoolTessellator, type WorkerTessellatorOptions } from './pool.ts';
import type { WorkerHandle } from './protocol.ts';

export { defaultWorkers, PoolTessellator, type PoolOptions, type WorkerTessellatorOptions } from './pool.ts';
export type { BackendSpec, WorkerHandle } from './protocol.ts';

const entry = new URL('./worker.node.ts', import.meta.url);

export function spawnNodeWorker(): WorkerHandle {
  // Workers inherit the process's flags; --input-type (for `node -e`) makes a file entry fail.
  const w = new Worker(entry, { execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')) });
  let failed = false;
  const handle: WorkerHandle = {
    post: (msg) => w.postMessage(msg),
    onMessage: (cb) => void w.on('message', cb),
    onError: (cb) => {
      w.on('error', (e) => { failed = true; cb(e); });
      w.on('exit', (code) => { if (!failed) cb(new Error(`worker exited with code ${code}`)); });
    },
    terminate: () => { failed = true; void w.terminate(); },
    ref: () => w.ref(),
    unref: () => w.unref(),
  };
  return handle;
}

/** A Tessellator running `opts.backend` in worker_threads. */
export class WorkerTessellator extends PoolTessellator {
  constructor(opts: WorkerTessellatorOptions) {
    super(spawnNodeWorker, opts);
  }
}
