// A round of corpus checks: several checks run one after another sharing one mesh cache (mesh-cache.ts), which the
// round empties first, so the round starts from fresh meshing: its first check that consumes meshes meshes the
// corpus into the cache, and the rest read it. The checks of meshing itself ignore the cache, so where they come in
// the round doesn't matter. Each check runs as `node --max-old-space-size=12000 <check>.ts <list> <max MB>`, its
// standard output into `<out>/<check>.log` and its standard error to both this process's and `<out>/<check>.err`; a
// failing check doesn't stop the round, but makes it exit 1. Usage:
//   node corpus_checks/round.ts [--list <file>] [--max-mb <n>] [--out <dir>] <check> [<check> ...]
// with the list default test_corpus/files.txt, the size 1000 MB, the output workdir/round-<time>/ (logs to compare
// with the committed ones), the cache workdir/mesh-cache/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultList, repoDir } from './corpus.ts';

/** In the cache directory, saying the round made it: a directory without it is never emptied. */
export const MARKER = '.corpus-mesh-cache';

export interface RoundOptions {
  /** Check names (scripts `<checksDir>/<name>.ts`), run in this order. */
  checks: string[];
  checksDir: string;
  cacheDir: string;
  outDir: string;
  /** What each check is given after its script. */
  args: string[];
  /** Node's options for each check. */
  nodeArgs?: string[];
  /** Where the checks' standard error also goes (default this process's). */
  stderr?: NodeJS.WritableStream;
}

/** Runs a round (above); the checks' exit codes in order. Throws, before emptying anything, on a caller's mistake. */
export async function runRound(o: RoundOptions): Promise<number[]> {
  for (const c of o.checks) {
    if (!/^[\w-]+$/.test(c) || !fs.existsSync(path.join(o.checksDir, `${c}.ts`))) throw new Error(
      `no check ${c} in ${o.checksDir}`);
  }
  emptyCache(o.cacheDir);
  fs.mkdirSync(o.outDir, { recursive: true });
  const err = o.stderr ?? process.stderr, codes: number[] = [];
  for (const c of o.checks) {
    const t = performance.now();
    const log = fs.createWriteStream(path.join(o.outDir, `${c}.log`));
    const errLog = fs.createWriteStream(path.join(o.outDir, `${c}.err`));
    const child = spawn(process.execPath, [...(o.nodeArgs ?? []), path.join(o.checksDir, `${c}.ts`), ...o.args],
      { env: { ...process.env, MESH_CACHE: o.cacheDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.on('data', (b: Buffer) => { errLog.write(b); err.write(b); });
    const code = await new Promise<number>((resolve) => child.on('close', (n) => resolve(n ?? 1)));
    await Promise.all([log, errLog].map((s) => new Promise((resolve) => s.end(resolve))));
    codes.push(code);
    err.write(`round: ${c} exit ${code}, ${((performance.now() - t) / 60_000).toFixed(1)} min\n`);
  }
  return codes;
}

/** Empties the cache directory, made with the marker if missing; refuses one the round didn't make. */
export function emptyCache(dir: string): void {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length && !entries.includes(MARKER)) throw new Error(
      `${dir} isn't a round's mesh cache (no ${MARKER}): not emptying it`);
    for (const e of entries) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), '');
}

/** The bytes under a directory. */
export function dirBytes(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size;
  }
  return n;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { list: { type: 'string' }, 'max-mb': { type: 'string' }, out: { type: 'string' } } });
  if (!positionals.length) {
    console.error('usage: node corpus_checks/round.ts [--list <file>] [--max-mb <n>] [--out <dir>] <check> ...');
    process.exit(2);
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
  const cacheDir = path.join(repoDir, 'workdir/mesh-cache');
  const outDir = path.resolve(values.out ?? path.join(repoDir, `workdir/round-${stamp}`));
  const codes = await runRound({ checks: positionals, checksDir: import.meta.dirname, cacheDir, outDir,
    args: [path.resolve(values.list ?? defaultList), values['max-mb'] ?? '1000'],
    nodeArgs: ['--max-old-space-size=12000'] });
  console.error(`round: logs in ${outDir}; mesh cache ${(dirBytes(cacheDir) / 2 ** 30).toFixed(2)} GiB`);
  process.exit(codes.every((c) => c === 0) ? 0 : 1);
}
