// A check for runner.test.ts: each file's job says how long it takes, whether it throws, whether its process dies,
// whether it hangs (always, or the first time: once its marker file exists, it doesn't), and a file to note each try
// of it in. FIXTURE_EXIT_HANG=1 blocks
// the process's exit forever (a futex wait, as Node's exit can hang).
import fs from 'node:fs';
import type { FileCheck } from '../corpus_checks/runner.ts';

if (process.env.FIXTURE_EXIT_HANG === '1') {
  process.on('exit', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
}
let setups = 0, seq = 0;
type Job = { ms: number; fail?: 'throw' | 'crash' | 'hang'; hangOnce?: string; tries?: string };
export const check: FileCheck<Job, { path: string; pid: number; setups: number; seq: number }> = {
  async setup() { setups++; },
  async file(path, job) {
    if (job.tries) fs.appendFileSync(job.tries, `${path}\n`);
    await new Promise((r) => setTimeout(r, job.ms));
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
