// Node: the pool over worker_threads.

import { Worker } from 'node:worker_threads';
import { PoolTessellator, type WorkerTessellatorOptions } from './pool.ts';
import type { WorkerHandle } from './protocol.ts';

export { defaultWorkers, PoolTessellator, type PoolOptions, type WorkerTessellatorOptions } from './pool.ts';
export type { BackendSpec, WorkerHandle } from './protocol.ts';

const entry = new URL('./worker.node.ts', import.meta.url);

/**
 * A worker on the entry. Workers inherit the process's flags, but --input-type (for `node -e`) makes a file entry
 * fail, so with it the flags are passed explicitly without it; Node then rejects process-wide flags it would
 * otherwise drop (such as --max-old-space-size), and the ones it names are left out too.
 */
function startWorker(): Worker {
  if (!process.execArgv.some((a) => a.startsWith('--input-type'))) return new Worker(entry);
  const execArgv = process.execArgv.filter((a) => !a.startsWith('--input-type'));
  try {
    return new Worker(entry, { execArgv });
  } catch (e) {
    const m = (e as { code?: string; message: string }).code === 'ERR_WORKER_INVALID_EXEC_ARGV' && /flags: (.*)$/.exec((e as Error).message);
    if (!m) throw e;
    const invalid = new Set(m[1]!.split(', '));
    return new Worker(entry, { execArgv: execArgv.filter((a) => !invalid.has(a)) });
  }
}

export function spawnNodeWorker(): WorkerHandle {
  const w = startWorker();
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
