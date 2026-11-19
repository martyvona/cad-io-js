// Messages between the pool and its workers, and the handle each environment's adapter implements. Besides
// tessellation, a worker runs jobs: a module's exported function on structured-clonable input (cad-heal's healJob,
// healing a part ahead of its meshing), named like a backend.

import type { TessellationProgress, TessellationRequest, TessellationResult, TessellatorInfo } from 'cad-scene';

/** The backend a worker loads: a module (an absolute URL, or a specifier the worker can import) and the name of the
 *  Tessellator class it exports, constructed without arguments; `options` go to its `init`. */
export interface BackendSpec {
  module: string;
  export: string;
  options?: Record<string, unknown>;
}

/**
 * A job a worker runs: the function `export` of `module` (a specifier the worker can import, or one its entry passed
 * in `modules`), called as `f(input, progress)` with `progress(message)`, resolving to its output (structured-clonable;
 * its typed arrays' buffers are transferred).
 */
export interface JobSpec {
  module: string;
  export: string;
}

export type ToWorker =
  /** No backend: a pool that only runs jobs. */
  | { type: 'init'; backend?: BackendSpec }
  | { type: 'tessellate'; id: number; req: TessellationRequest }
  | { type: 'run'; id: number; job: JobSpec; input: unknown };

export type FromWorker =
  | { type: 'ready'; info: TessellatorInfo }
  | { type: 'initError'; message: string }
  | { type: 'result'; id: number; result: TessellationResult; memory?: number }
  /** Where the backend is in request `id` (the backend throttles them). */
  | { type: 'progress'; id: number; progress: TessellationProgress }
  /** Job `id`'s output, and where it is meanwhile. */
  | { type: 'output'; id: number; output: unknown }
  | { type: 'jobProgress'; id: number; message: string }
  /** `part`: the part's failure (a TessellationError, with its `timeoutMs`, or a WASM trap), not the worker's. */
  | { type: 'error'; id: number; message: string; part: boolean; timeoutMs?: number };

/** One worker, as the pool sees it. */
export interface WorkerHandle {
  post(msg: ToWorker): void;
  onMessage(cb: (msg: FromWorker) => void): void;
  /** An uncaught error, or the worker exiting on its own. */
  onError(cb: (err: Error) => void): void;
  terminate(): void;
  /** Node only: whether the worker keeps the process alive. The pool releases idle workers. */
  ref?(): void;
  unref?(): void;
}

/** The worker side's end of the channel. */
export interface WorkerPort {
  post(msg: FromWorker, transfer: ArrayBuffer[]): void;
  onMessage(cb: (msg: ToWorker) => void): void;
}
