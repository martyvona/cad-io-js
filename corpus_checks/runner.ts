// Several corpus files at once within a check: persistent child processes (runner-child.ts), each loading the check's
// module once and running its per-file function on the files it's given; the results come back to the check's main
// process, which gets them strictly in file order, so its log is the same however many children run. A check module
// exports `check` (a FileCheck) and runs its own main only when run directly (`import.meta.main`).
//
// The largest files are handed out first, so the slowest start early and the rest fill in around them (the log is
// the same: results still go to the check in file order).
//
// The machine is divided so no thread waits for a core: CHILDREN children, each with MESH_WORKERS meshing workers of
// its own (default: what's left of the threads but one, shared out). CHILDREN defaults to a third of the hardware
// threads (more gain little: the files' main-thread work and the largest parts set the time), and to no more than fit
// in memory at CHILD_MEMORY each. A part can still take longer than with one check alone: an Apple M4's 10 cores
// include 6 efficiency cores, slower than the 4 a lone meshing worker would get (bug24024_slow_import.stp's largest
// part took 29 s in one run, 64 s in another). So timeouts need room: the pool's default 120 s, not less (that part
// timed out at 60 s). CHILDREN=0 runs every file in the main process (for debugging and timing).
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { usableMemory } from '../scripts/host.ts';
import { shortName } from './corpus.ts';

/** A check's per-file part, run in the children. */
export interface FileCheck<J, R> {
  /** Once per process, before its first file: `meshWorkers` the meshing workers it may use. */
  setup?(ctx: { meshWorkers: number; args: string[] }): Promise<void>;
  /** One file: its job (what the main process gives with it) in, plain results out (structured-clone types). */
  file(path: string, job: J): Promise<R>;
  /** Once per process, after its last file. */
  teardown?(): void | Promise<void>;
}

/**
 * The memory a child is given room for: roundtrip_corpus's children, the heaviest, peak at 2-3 GiB but for its largest
 * file (5.75 GiB), and 9 of them used at most 21 GiB together.
 */
export const CHILD_MEMORY = 4 * 2 ** 30;

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
        merge(f.path, { result: await check.file(f.path, f.job) });
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
  let next = 0, delivered = 0;
  // The order handed out: largest first (a path that isn't a file counts as empty).
  const size = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const order = files.map((f, k) => [size(f.path), k] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, k]) => k);
  const deliver = () => {
    while (delivered < files.length && done[delivered]) {
      merge(files[delivered]!.path, done[delivered]!);
      done[delivered] = undefined as never;
      delivered++;
    }
  };
  const child = new URL('./runner-child.ts', import.meta.url).pathname;
  await new Promise<void>((resolve) => {
    let running = 0;
    const start = () => {
      const c: ChildProcess = fork(child, [moduleUrl, String(meshWorkers), ...args],
        { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      running++;
      let current = -1;
      const give = () => {
        if (next >= files.length) { c.send({ type: 'end' }); return; }
        current = order[next++]!;
        process.stderr.write(`${shortName(files[current]!.path)}\n`);
        c.send({ type: 'file', path: files[current]!.path, job: files[current]!.job });
      };
      c.on('message', (m: { type: 'ready' } | { type: 'stats'; maxRss: number }
        | { type: 'result'; result: R; maxRss: number } | { type: 'error'; error: string; maxRss: number }) => {
        if (m.type === 'stats') {
          peak.note(m.maxRss);
          return;
        }
        if (m.type !== 'ready') {
          peak.note(m.maxRss, files[current]!.path);
          done[current] = m.type === 'result' ? { result: m.result } : { error: m.error };
          current = -1;
          deliver();
        }
        give();
      });
      c.on('exit', (code, signal) => {
        running--;
        // A crash: its file failed; a new child takes the rest.
        if (current >= 0) {
          done[current] = { error: `the child process ended (${signal ?? `exit ${code}`})` };
          current = -1;
          deliver();
          if (next < files.length) start();
        }
        if (running === 0) resolve();
      });
    };
    for (let k = 0; k < Math.min(children, files.length); k++) start();
    if (!files.length) resolve();
  });
  deliver();
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
