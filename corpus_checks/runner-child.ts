// A child of runner.ts: loads a check's module (argv[2], its URL), runs its setup with the meshing workers it may use
// (argv[3]) and the check's command line (the rest), then its per-file function on each file the parent gives, sending
// back the result or the error with its peak memory so far; tears down, sends its peak, and exits when told the files
// are done.
import type { FileCheck } from './runner.ts';

const [moduleUrl, meshWorkers, ...args] = process.argv.slice(2);
const { check } = (await import(moduleUrl!)) as { check: FileCheck<unknown, unknown> };
await check.setup?.({ meshWorkers: Number(meshWorkers), args });
// The process's peak resident memory so far in bytes (its meshing workers' included: they're threads).
const maxRss = () => process.resourceUsage().maxRSS * 1024;
const send = (m: unknown) => new Promise<void>((resolve) => process.send!(m, () => resolve()));
process.on('message', async (m: { type: 'file'; path: string; job: unknown } | { type: 'end' }) => {
  if (m.type === 'end') {
    await check.teardown?.();
    await send({ type: 'stats', maxRss: maxRss() });
    process.disconnect();
    process.exit(0);
  }
  try {
    const result = await check.file(m.path, m.job);
    await send({ type: 'result', result, maxRss: maxRss() });
  } catch (e) {
    await send({ type: 'error', error: (e as Error).stack ?? String(e), maxRss: maxRss() });
  }
});
await send({ type: 'ready' });
