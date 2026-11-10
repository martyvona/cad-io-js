// A check for runner.test.ts: each file's job says how long it takes, whether it throws, whether its process dies.
import type { FileCheck } from '../corpus_checks/runner.ts';

let setups = 0, seq = 0;
type Job = { ms: number; fail?: 'throw' | 'crash' };
export const check: FileCheck<Job, { path: string; pid: number; setups: number; seq: number }> = {
  async setup() { setups++; },
  async file(path, job) {
    await new Promise((r) => setTimeout(r, job.ms));
    if (job.fail === 'throw') throw new Error(`thrown for ${path}`);
    if (job.fail === 'crash') process.exit(3);
    return { path, pid: process.pid, setups, seq: seq++ };
  },
};
