// A check for runner.test.ts: each file's job says how long it takes, whether it throws, whether its process dies,
// whether it hangs (always, or the first time: once its marker file exists, it doesn't), a file to note each try
// of it in, and one to note its start and end in (`+path`, `-path`); `busy` keeps the process busy without yielding for `ms`, saying where it is every `every` ms through
// its context's progress, then hangs where `hang`. FIXTURE_EXIT_HANG=1 blocks the process's exit forever (a futex
// wait, as Node's exit can hang).
import fs from 'node:fs';
import type { FileCheck } from '../corpus_checks/runner.ts';

if (process.env.FIXTURE_EXIT_HANG === '1') {
  process.on('exit', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
}
let setups = 0, seq = 0;
type Job = { ms: number; fail?: 'throw' | 'crash' | 'hang'; hangOnce?: string; tries?: string; spans?: string;
  busy?: { ms: number; every: number; hang?: boolean } };
export const check: FileCheck<Job, { path: string; pid: number; setups: number; seq: number }> = {
  async setup() { setups++; },
  async file(path, job, ctx) {
    if (job.tries) fs.appendFileSync(job.tries, `${path}\n`);
    if (job.spans) fs.appendFileSync(job.spans, `+${path}\n`);
    if (job.busy) {
      const t0 = Date.now();
      for (let k = 1; Date.now() - t0 < job.busy.ms; k++) {
        while (Date.now() - t0 < Math.min(job.busy.ms, k * job.busy.every)) { /* busy */ }
        ctx.progress(`${path} step ${k}`);
      }
      if (job.busy.hang) await new Promise(() => {});
    }
    await new Promise((r) => setTimeout(r, job.ms));
    if (job.spans) fs.appendFileSync(job.spans, `-${path}\n`);
    if (job.fail === 'throw') throw new Error(`thrown for ${path}`);
    if (job.fail === 'crash') process.exit(3);
    if (job.fail === 'hang') await new Promise(() => {});
    if (job.hangOnce && !fs.existsSync(job.hangOnce)) {
      fs.writeFileSync(job.hangOnce, '');
      await new Promise(() => {});
    }
    return { path, pid: process.pid, setups, seq: seq++ };
  },
};
