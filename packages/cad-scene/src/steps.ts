// Long work in steps (the user, 2026-10-31: exports that pause, so a worker can say it's still going): a generator
// yields between steps, and runs either straight through or pausing now and then for whatever else the thread
// has to do (the viewer's import worker sends its heartbeat then).

/** A generator's work done at once: its result. */
export function drain<T>(steps: Generator<unknown, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** A generator's work, pausing (`pause`, awaited) whenever `everyMs` have gone by since the last pause. */
export async function paced<T>(steps: Generator<unknown, T>, pause: () => Promise<void>, everyMs = 50): Promise<T> {
  let last = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - last >= everyMs) {
      await pause();
      last = performance.now();
    }
  }
}
