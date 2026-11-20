// Several corpus files at once within a check: persistent child processes (runner-child.ts), each loading the check's
// module once and running its per-file function on the files it's given; the results come back to the check's main
// process, which gets them strictly in file order, so its log is the same however many children run. A check module
// exports `check` (a FileCheck) and runs its own main only when run directly (`import.meta.main`).
//
// The largest files are handed out first, so the slowest start early and the rest fill in around them (the log is
// the same: results still go to the check in file order). Within a memory budget (MEM_BUDGET GiB, default 24): a file
// starts only while the files running, each estimated at MEM_FACTOR (default 15) x its size (a gzipped file's
// uncompressed), plus MEM_CHILD_BASE GiB (default 0.5) a child, stay within it, else the largest that fits starts, or
// none until one ends; a file alone always starts. Largest first alone started the six largest files together, two
// copies of one 271 MB model among them: 17-19 GiB in the first minute, though no child passed 6 GiB.
//
// The machine is divided so no thread waits for a core: CHILDREN children, each with MESH_WORKERS meshing workers of
// its own (default: what's left of the threads but one, shared out). CHILDREN defaults to a third of the hardware
// threads (more gain little: the files' main-thread work and the largest parts set the time), and to no more than fit
// in memory at CHILD_MEMORY each. A part can still take longer than with one check alone: an Apple M4's 10 cores
// include 6 efficiency cores, slower than the 4 a lone meshing worker would get (bug24024_slow_import.stp's largest
// part took 29 s in one run, 64 s in another). So timeouts need room: the pool's default 120 s, not less (that part
// timed out at 60 s). CHILDREN=0 runs every file in the main process (for debugging and timing).
//
// Watchdogs: a child can hang in Node's own exit (its main thread blocked in a futex with most of its threads gone,
// after its last result), so one that hasn't exited EXIT_GRACE_MS (default 30 s) after its final stats is killed; and one silent on a
// file for IDLE_MS (default 5 minutes; 0 none) is killed and the file given once more to a new child (a second
// time, the file fails), each kill logged on standard error. A check whose file takes long says it's alive through
// its context's `progress` (each call restarts the idle clock, and a kill names the last thing it said: where it was).
// The messages arrive while the child is busy: a send writes to the channel at once.
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { usableMemory } from '../scripts/host.ts';
import { shortName } from './corpus.ts';

/** A check's per-file part, run in the children. */
export interface FileCheck<J, R> {
  /** Once per process, before its first file: `meshWorkers` the meshing workers it may use. */
  setup?(ctx: { meshWorkers: number; args: string[] }): Promise<void>;
  /**
   * One file: its job (what the main process gives with it) in, plain results out (structured-clone types);
   * `ctx.progress` to say where it is in a long file.
   */
  file(path: string, job: J, ctx: FileContext): Promise<R>;
  /** Once per process, after its last file. */
  teardown?(): void | Promise<void>;
}

/** What a check's file is given: `progress(what)` restarts the child's idle clock, `what` named if it's killed. */
export interface FileContext {
  progress(what: string): void;
}

/**
 * The memory a child is given room for: roundtrip_corpus's children, the heaviest, peak at 2-3 GiB but for its largest
 * file (5.75 GiB), and 9 of them used at most 21 GiB together.
 */
export const CHILD_MEMORY = 4 * 2 ** 30;

/** The memory budget's terms (above), from MEM_BUDGET, MEM_FACTOR and MEM_CHILD_BASE: bytes, and the factor. */
export function memoryBudget(): { budget: number; factor: number; childBase: number } {
  return { budget: Number(process.env.MEM_BUDGET ?? 24) * 2 ** 30, factor: Number(process.env.MEM_FACTOR ?? 15),
    childBase: Number(process.env.MEM_CHILD_BASE ?? 0.5) * 2 ** 30 };
}

/**
 * A file's size for the budget: a gzip file's uncompressed size (its trailer's, which is modulo 2^32: the larger of
 * it and the compressed size), else the file's; a path that isn't a file 0.
 */
export function uncompressedSize(p: string): number {
  let fd: number | undefined;
  try {
    const size = fs.statSync(p).size;
    if (size < 18) return size;
    fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(2), tail = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 2, 0);
    if (head[0] !== 0x1f || head[1] !== 0x8b) return size;
    fs.readSync(fd, tail, 0, 4, size - 4);
    return Math.max(size, tail.readUInt32LE(0));
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The next file to start (its position in `queue`, file indices largest first), or -1 for none: the first whose
 * estimate fits in what the budget leaves after `inFlight` (the running files' estimates, bytes) and the children's
 * base, any file where nothing runs.
 */
export function admit(queue: readonly number[], estimate: (file: number) => number, inFlight: number, running: number,
  children: number, terms: { budget: number; childBase: number }): number {
  if (!queue.length) return -1;
  if (running === 0) return 0;
  const room = terms.budget - children * terms.childBase - inFlight;
  return queue.findIndex((f) => estimate(f) <= room);
}

/** How long (ms) a child that has sent its final stats may take to exit before it's killed (EXIT_GRACE_MS). */
const exitGrace = () => Number(process.env.EXIT_GRACE_MS ?? 30_000);

/** How the machine is divided (above): `threads` and `memory` (bytes) the host's, by default this one's. */
export function division(threads = os.availableParallelism(), memory = usableMemory()):
  { children: number; meshWorkers: number } {
  const fallback = Math.max(1, Math.min(Math.floor(threads / 3), Math.floor(memory / CHILD_MEMORY)));
  const children = Math.max(0, Number(process.env.CHILDREN ?? fallback));
  const meshWorkers = Number(process.env.MESH_WORKERS ?? Math.max(1,
    Math.floor((threads - 1 - Math.max(1, children)) / Math.max(1, children))));
  return { children, meshWorkers };
}

/**
 * Runs `check` (exported by the module at `moduleUrl`, the caller's `import.meta.url`) over the files, each with its
 * job, and gives `merge` each file's result (or the error it threw, or its child's crash) in file order. `args` are
 * given to setup (the check's command line, so children read it as the main process does).
 */
export async function runFiles<J, R>(moduleUrl: string, check: FileCheck<J, R>, files: { path: string; job: J }[],
  args: string[], merge: (path: string, r: { result: R } | { error: string }) => void): Promise<void> {
  const { children, meshWorkers } = division();
  const peak = new Peak();
  if (children === 0) {
    await check.setup?.({ meshWorkers, args });
    for (const f of files) {
      process.stderr.write(`${shortName(f.path)}\n`);
      try {
        merge(f.path, { result: await check.file(f.path, f.job, { progress: () => {} }) });
      } catch (e) {
        merge(f.path, { error: (e as Error).stack ?? String(e) });
      }
    }
    await check.teardown?.();
    peak.note(process.resourceUsage().maxRSS * 1024, files.at(-1)?.path);
    peak.report(children, meshWorkers);
    return;
  }
  const done: ({ result: R } | { error: string } | undefined)[] = new Array(files.length);
  let delivered = 0;
  // The files still to start, largest first (a path that isn't a file counts as empty), and the budget's state: the
  // running files' estimates, children waiting for room, files that waited.
  const sizes = files.map((f) => uncompressedSize(f.path));
  const queue = sizes.map((n, k) => [n, k] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, k]) => k);
  const terms = memoryBudget(), estimate = (k: number) => terms.factor * sizes[k]!;
  let inFlight = 0, runningFiles = 0;
  const waiting: (() => void)[] = [];
  const held = new Set<number>();
  process.stderr.write(`runner: memory budget ${(terms.budget / 2 ** 30).toFixed(1)} GiB, a file estimated at `
    + `${terms.factor} x its uncompressed size, ${(terms.childBase / 2 ** 30).toFixed(2)} GiB a child\n`);
  const idleMs = Number(process.env.IDLE_MS ?? 5 * 60_000), retried = new Set<number>();
  const deliver = () => {
    while (delivered < files.length && done[delivered]) {
      merge(files[delivered]!.path, done[delivered]!);
      done[delivered] = undefined as never;
      delivered++;
    }
  };
  const child = new URL('./runner-child.ts', import.meta.url).pathname;
  // A file's end frees its estimate; the children waiting for room try again (in the order they began waiting).
  const ended = (k: number) => { inFlight -= estimate(k), runningFiles--; };
  const wake = () => { for (const g of waiting.splice(0)) g(); };
  await new Promise<void>((resolve) => {
    let running = 0;
    const start = () => {
      const c: ChildProcess = fork(child, [moduleUrl, String(meshWorkers), ...args],
        { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      running++;
      let current = -1, idle: NodeJS.Timeout | undefined, killedIdle = false, said = '';
      // The idle clock on the current file, restarted by each message.
      const arm = () => {
        clearTimeout(idle);
        if (idleMs <= 0 || current < 0) return;
        const file = current;
        idle = setTimeout(() => {
          process.stderr.write(`runner: killing a child silent for ${idleMs / 1000} s on `
            + `${shortName(files[file]!.path)}${said ? `, last at ${said}` : ''}`
            + `${retried.has(file) ? ' (its second try: it fails)' : ' (retrying it)'}\n`);
          killedIdle = true;
          c.kill('SIGKILL');
        }, idleMs);
      };
      const give = () => {
        if (!queue.length) { c.send({ type: 'end' }); return; }
        const at = admit(queue, estimate, inFlight, runningFiles, children, terms);
        // (A file waited when it was next in line and didn't fit; counted once.)
        if (at !== 0) held.add(queue[0]!);
        if (at < 0) {
          waiting.push(give);
          return;
        }
        current = queue.splice(at, 1)[0]!, said = '';
        inFlight += estimate(current), runningFiles++;
        process.stderr.write(`${shortName(files[current]!.path)}\n`);
        c.send({ type: 'file', path: files[current]!.path, job: files[current]!.job });
        arm();
      };
      c.on('message', (m: { type: 'ready' } | { type: 'stats'; maxRss: number } | { type: 'progress'; what: string }
        | { type: 'result'; result: R; maxRss: number } | { type: 'error'; error: string; maxRss: number }) => {
        if (m.type === 'progress') {
          said = m.what;
          arm();
          return;
        }
        clearTimeout(idle);
        if (m.type === 'stats') {
          peak.note(m.maxRss);
          const grace = exitGrace();
          setTimeout(() => {
            if (c.exitCode !== null || c.signalCode !== null) return;
            process.stderr.write(`runner: killing a child that hadn't exited ${grace / 1000} s after its last file\n`);
            c.kill('SIGKILL');
          }, grace).unref();
          return;
        }
        if (m.type !== 'ready') {
          peak.note(m.maxRss, files[current]!.path);
          done[current] = m.type === 'result' ? { result: m.result } : { error: m.error };
          ended(current);
          current = -1;
          deliver();
        }
        give();
        wake();
      });
      c.on('exit', (code, signal) => {
        running--;
        clearTimeout(idle);
        // A crash: its file failed (or, killed idle the first time, is given again); a new child takes the rest.
        if (current >= 0) {
          ended(current);
          if (killedIdle && !retried.has(current)) {
            retried.add(current);
            queue.unshift(current);
          } else {
            done[current] = { error: killedIdle ? `the child was silent for ${idleMs / 1000} s, twice`
              : `the child process ended (${signal ?? `exit ${code}`})` };
            deliver();
          }
          current = -1;
          if (queue.length) start();
          wake();
        }
        if (running === 0) resolve();
      });
    };
    for (let k = 0; k < Math.min(children, files.length); k++) start();
    if (!files.length) resolve();
  });
  deliver();
  if (held.size) process.stderr.write(`runner: ${held.size} files waited for room in the memory budget\n`);
  peak.report(children, meshWorkers);
}

/** The largest peak resident memory of a process running files, and the file it rose to it on, for sizing CHILDREN. */
class Peak {
  bytes = 0;
  file: string | undefined;
  /** A process's peak so far, after `file` (a rise to a new peak is put down to it). */
  note(bytes: number, file?: string) {
    if (bytes > this.bytes) {
      this.bytes = bytes;
      if (file !== undefined) this.file = file;
    }
  }
  report(children: number, meshWorkers: number) {
    process.stderr.write(`runner: ${children ? `${children} children, ${meshWorkers} meshing workers each; a ` +
      `child's` : `in process, ${meshWorkers} meshing workers; the`} peak memory ` +
      `${(this.bytes / 2 ** 30).toFixed(2)} GiB${this.file ? ` (after ${shortName(this.file)})` : ''}\n`);
  }
}

/**
 * Adds a file's tallies (`delta`) into the totals (`target`, changed in place; returned, for leaves): numbers summed,
 * arrays of numbers of the same length added element by element, other arrays appended (rows, examples), maps by key
 * (added, or taken where new), objects field by field. Anything else (a string, a boolean) isn't a tally and throws:
 * a per-file result of additive tallies only, so files merge in any grouping. A list of numbers to append (times)
 * would be added element by element instead: keep such lists out, or merge them by hand.
 */
export function addInto<T>(target: T, delta: T): T {
  if (typeof target === 'number' && typeof delta === 'number') return (target + delta) as T;
  if (Array.isArray(target) && Array.isArray(delta)) {
    const numbers = (a: unknown[]) => a.length > 0 && a.every((x) => typeof x === 'number');
    if (numbers(target) && numbers(delta) && target.length === delta.length) {
      for (let k = 0; k < target.length; k++) target[k] = target[k] + delta[k];
    } else target.push(...delta);
    return target;
  }
  if (target instanceof Map && delta instanceof Map) {
    for (const [k, v] of delta) target.set(k, target.has(k) ? addInto(target.get(k), v) : v);
    return target;
  }
  if (target && delta && typeof target === 'object' && typeof delta === 'object' && !Array.isArray(target)
    && !Array.isArray(delta) && !(target instanceof Map) && !(delta instanceof Map)) {
    const t = target as Record<string, unknown>, d = delta as Record<string, unknown>;
    for (const k of Object.keys(d)) t[k] = k in t ? addInto(t[k], d[k]) : d[k];
    return target;
  }
  throw new Error(`addInto: ${JSON.stringify(target)} and ${JSON.stringify(delta)} aren't tallies`);
}
