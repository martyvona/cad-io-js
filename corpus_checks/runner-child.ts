// A child of runner.ts: loads a check's module (argv[2], its URL), runs its setup with the meshing workers it may use
// (argv[3]) and the check's command line (the rest), then its per-file function on each file the parent gives, sending
// back the result or the error; tears down and exits when told the files are done.
import type { FileCheck } from './runner.ts';

const [moduleUrl, meshWorkers, ...args] = process.argv.slice(2);
const { check } = (await import(moduleUrl!)) as { check: FileCheck<unknown, unknown> };
await check.setup?.({ meshWorkers: Number(meshWorkers), args });
const send = (m: unknown) => new Promise<void>((resolve) => process.send!(m, () => resolve()));
process.on('message', async (m: { type: 'file'; path: string; job: unknown } | { type: 'end' }) => {
  if (m.type === 'end') {
    await check.teardown?.();
    process.disconnect();
    process.exit(0);
  }
  try {
    await send({ type: 'result', result: await check.file(m.path, m.job) });
  } catch (e) {
    await send({ type: 'error', error: (e as Error).stack ?? String(e) });
  }
});
await send({ type: 'ready' });
