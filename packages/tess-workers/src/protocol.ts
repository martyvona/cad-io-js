// Messages between the pool and its workers, and the handle each environment's adapter implements.

import type { TessellationRequest, TessellationResult, TessellatorInfo } from 'cad-scene';

/** The backend a worker loads: a module (an absolute URL, or a specifier the worker can import) and the name of the
 *  Tessellator class it exports, constructed without arguments; `options` go to its `init`. */
export interface BackendSpec {
  module: string;
  export: string;
  options?: Record<string, unknown>;
}

export type ToWorker =
  | { type: 'init'; backend: BackendSpec }
  | { type: 'tessellate'; id: number; req: TessellationRequest };

export type FromWorker =
  | { type: 'ready'; info: TessellatorInfo }
  | { type: 'initError'; message: string }
  | { type: 'result'; id: number; result: TessellationResult; memory?: number }
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
