// A Tessellator that runs another backend in a pool of workers: one request per worker at a time, a per-request
// timeout that terminates a stuck worker, and recycling (a fresh worker and backend instance) after a backend error,
// after a number of parts or when the backend's memory grows too large. The same workers run jobs (`run`, protocol.ts:
// cad-heal's healJob healing parts ahead of their meshing), queued with the requests; a pool without a backend runs
// jobs only. Written against WorkerHandle; node.ts and browser.ts supply the workers.

import { TessellationError, type TessellationProgress, type TessellationRequest, type TessellationResult,
  type Tessellator, type TessellatorInfo } from 'cad-scene';
import type { BackendSpec, FromWorker, JobSpec, ToWorker, WorkerHandle } from './protocol.ts';

export interface PoolOptions {
  /** Number of workers. Default: one less than the hardware concurrency, at least 1. */
  workers?: number;
  /**
   * Per request, in milliseconds; the worker is terminated and the request rejected with a TessellationError. 0: none.
   * Default `DEFAULT_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Recycle a worker after this many parts. 0: never. Default 0. */
  maxPartsPerWorker?: number;
  /**
   * Recycle a worker once its backend reports more memory than this after a part (`Tessellator.memoryBytes`). 0:
   * never. Default 256 MiB, above what all but the heaviest parts need (docs/backends.md).
   */
  maxMemoryBytes?: number;
}

export interface WorkerTessellatorOptions extends PoolOptions {
  /** None: the pool only runs jobs (`run`), and its info is serve.ts's NO_BACKEND. */
  backend?: BackendSpec;
}

/** A job's options: progress, and its own timeout (ms; 0, the default, none: unlike a part's meshing). */
export interface RunOptions {
  onProgress?: (message: string) => void;
  timeoutMs?: number;
}

interface Job {
  id: number;
  /** What the worker is sent: a tessellation request, or a job. */
  msg: Extract<ToWorker, { id: number }>;
  resolve: (r: never) => void;
  reject: (e: Error) => void;
  onProgress?: (p: TessellationProgress) => void;
  onJobProgress?: (message: string) => void;
  /** The last progress (the backend's, or a job's message), for a timeout to say how far it got. */
  last?: string;
  timeoutMs: number;
}

interface Slot {
  h: WorkerHandle;
  state: 'starting' | 'idle' | 'busy' | 'dead';
  parts: number;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 120 s: the corpus's slowest part takes about 61 s with OCCT on an Apple M4 at 0.1 mm with measures
 * (docs/backends.md).
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export function defaultWorkers(): number {
  const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, n - 1);
}

export class PoolTessellator implements Tessellator {
  readonly workers: number;
  private readonly spawnWorker: () => WorkerHandle;
  private readonly backend: BackendSpec | undefined;
  readonly timeoutMs: number;
  private readonly maxParts: number;
  private readonly maxMemory: number;
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private disposed = false;
  private spawnBlocked = false;
  private infoValue?: TessellatorInfo;
  private initWait?: { resolve: () => void; reject: (e: Error) => void };
  private initPromise?: Promise<void>;

  constructor(spawnWorker: () => WorkerHandle, opts: WorkerTessellatorOptions) {
    this.spawnWorker = spawnWorker;
    this.backend = opts.backend;
    this.workers = Math.max(1, Math.floor(opts.workers ?? defaultWorkers()));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxParts = opts.maxPartsPerWorker ?? 0;
    this.maxMemory = opts.maxMemoryBytes ?? 256 * 2 ** 20;
  }

  /** The backend's info, as its first worker reported it. */
  get info(): TessellatorInfo {
    if (!this.infoValue) throw new Error('PoolTessellator: call init() first');
    return this.infoValue;
  }

  /** Start the first worker and load the backend in it; the others start as requests arrive. */
  init(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('PoolTessellator: disposed'));
    this.initPromise ??= new Promise<void>((resolve, reject) => {
      this.initWait = { resolve, reject };
      this.spawn();
    });
    return this.initPromise;
  }

  tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void): Promise<TessellationResult> {
    if (this.disposed) return Promise.reject(new Error('PoolTessellator: disposed'));
    if (!this.infoValue) return Promise.reject(new Error('PoolTessellator: call init() first'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, msg: { type: 'tessellate', id, req }, resolve: resolve as (r: never) => void, reject,
        onProgress, timeoutMs: this.timeoutMs });
      this.pump();
    });
  }

  /**
   * Runs `job` on `input` in a worker (protocol.ts's JobSpec), queued with the tessellation requests. A job that
   * throws rejects with its message; the worker is then replaced, as after a backend's error.
   */
  run<T>(job: JobSpec, input: unknown, opts: RunOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('PoolTessellator: disposed'));
    if (!this.infoValue) return Promise.reject(new Error('PoolTessellator: call init() first'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, msg: { type: 'run', id, job, input }, resolve: resolve as (r: never) => void, reject,
        ...(opts.onProgress ? { onJobProgress: opts.onProgress } : {}), timeoutMs: opts.timeoutMs ?? 0 });
      this.pump();
    });
  }

  /** Terminate every worker; pending requests are rejected. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const err = new Error('PoolTessellator: disposed');
    for (const s of [...this.slots]) this.kill(s, err);
    for (const j of this.queue.splice(0)) j.reject(err);
    this.initWait?.reject(err);
    this.initWait = undefined;
  }

  private spawn(): void {
    const s: Slot = { h: this.spawnWorker(), state: 'starting', parts: 0 };
    this.slots.push(s);
    s.h.onMessage((msg) => this.onMessage(s, msg));
    s.h.onError((err) => {
      if (s.state === 'dead') return;
      const starting = s.state === 'starting';
      this.kill(s, new Error(`worker failed: ${err.message}`));
      if (starting) this.afterStartFailure(new Error(`worker failed to start: ${err.message}`));
      this.pump();
    });
    s.h.post(this.backend ? { type: 'init', backend: this.backend } : { type: 'init' });
  }

  private onMessage(s: Slot, msg: FromWorker): void {
    if (s.state === 'dead') return;
    switch (msg.type) {
      case 'ready':
        this.infoValue ??= msg.info;
        this.spawnBlocked = false;
        this.initWait?.resolve();
        this.initWait = undefined;
        this.idle(s);
        break;
      case 'initError': {
        this.kill(s);
        this.afterStartFailure(new Error(`backend init failed: ${msg.message}`));
        break;
      }
      case 'output': {
        this.finish(s)?.resolve(msg.output as never);
        this.idle(s);
        break;
      }
      case 'jobProgress': {
        if (s.job && s.job.id === msg.id) {
          s.job.last = msg.message;
          s.job.onJobProgress?.(msg.message);
        }
        return;
      }
      case 'result': {
        const job = this.finish(s);
        job?.resolve(msg.result as never);
        s.parts++;
        if ((this.maxParts > 0 && s.parts >= this.maxParts) || (
          this.maxMemory > 0 && (msg.memory ?? 0) > this.maxMemory)) this.kill(s);
        else this.idle(s);
        break;
      }
      case 'progress': {
        if (s.job && s.job.id === msg.id) {
          s.job.last = msg.progress.message;
          s.job.onProgress?.(msg.progress);
        }
        return;
      }
      case 'error': {
        // The backend instance may be left broken (a WASM trap), so the worker is replaced.
        const job = this.finish(s);
        this.kill(s);
        job?.reject(msg.part ? new TessellationError(msg.message, msg.timeoutMs) : new Error(msg.message));
        break;
      }
    }
    this.pump();
  }

  /**
   * A worker died before it was ready: fail init, or, with no other worker alive, every queued request. No more
   * workers start until one is ready, except when none is alive, so a backend that can't load doesn't respawn forever.
   */
  private afterStartFailure(err: Error): void {
    this.spawnBlocked = true;
    if (this.initWait) {
      this.initWait.reject(err);
      this.initWait = undefined;
      this.initPromise = undefined;
      return;
    }
    if (!this.slots.length) for (const j of this.queue.splice(0)) j.reject(err);
  }

  private idle(s: Slot): void {
    s.state = 'idle';
    s.h.unref?.();
  }

  private finish(s: Slot): Job | undefined {
    clearTimeout(s.timer);
    const job = s.job;
    s.job = undefined;
    return job;
  }

  /** Terminate a worker, rejecting its request with `err` if it has one. */
  private kill(s: Slot, err?: Error): void {
    const job = this.finish(s);
    s.state = 'dead';
    this.slots = this.slots.filter((x) => x !== s);
    s.h.terminate();
    if (job) job.reject(err ?? new Error('worker terminated'));
  }

  private pump(): void {
    if (this.disposed || !this.infoValue) return;
    for (const s of this.slots) {
      if (!this.queue.length) break;
      if (s.state !== 'idle') continue;
      const job = this.queue.shift()!;
      s.state = 'busy';
      s.job = job;
      s.h.ref?.();
      s.h.post(job.msg);
      if (job.timeoutMs > 0) {
        const what = job.msg.type === 'run' ? `job ${job.msg.job.export}` : 'tessellation';
        s.timer = setTimeout(() => {
          const last = s.job?.last;
          const m = `${what} timed out after ${job.timeoutMs} ms${last ? ` (last: ${last})` : ''}`;
          this.kill(s, job.msg.type === 'run' ? new Error(m) : new TessellationError(m, job.timeoutMs));
          this.pump();
        }, job.timeoutMs);
      }
    }
    const starting = this.slots.filter((s) => s.state === 'starting').length;
    const more = this.spawnBlocked
      ? (this.slots.length === 0 && this.queue.length ? 1 : 0)
      : Math.min(this.workers - this.slots.length, this.queue.length - starting);
    for (let i = 0; i < more; i++) this.spawn();
  }
}
